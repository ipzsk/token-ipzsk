import { randomUUID } from 'node:crypto';
import { hash, token, httpError, RateLimiter } from './security.mjs';

import { desktopCatalog } from './model-catalog.mjs';
import { provisionIfEnabled, lanehubMode } from './lanehub.mjs';

export async function checkDesktopSession(db,credential) {
  if(credential?.plugin_id){
    const plugin=(await db.query('SELECT enabled FROM plugins WHERE id=$1',[credential.plugin_id])).rows[0];
    if(!plugin?.enabled)throw httpError(403,'plugin_disabled');
  }
  if(!credential?.auth_session_id)return;
  const session=await db.query(`SELECT s.id FROM auth_sessions s JOIN users u ON u.auth_user_id=s."userId"
    WHERE s.id=$1 AND u.id=$2 AND u.enabled AND s."expiresAt">now()`,[credential.auth_session_id,credential.user_id??credential.id]);
  if(!session.rowCount)throw httpError(401,'invalid_api_token');
}

export function desktopRoutes(app,options) {
  const {db}=options;
  const limiter=new RateLimiter();
  app.post('/admin/api/plugins/:id/skill-versions',async req=>{
    if(req.administrator?.role!=='superadmin')throw httpError(403,'admin_permission_denied');
    const {skill_ref,content_sha256,enabled,reason}=req.body??{};
    if(typeof skill_ref!=='string'||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill_ref)||skill_ref.length>128
      ||typeof content_sha256!=='string'||!/^[a-f0-9]{64}$/.test(content_sha256)||typeof enabled!=='boolean'
      ||typeof reason!=='string'||reason.trim().length<5||reason.length>500)throw httpError(400,'invalid_skill_version');
    return db.tx(async c=>{
      const plugin=(await c.query('SELECT id FROM plugins WHERE id::text=$1 FOR UPDATE',[req.params.id])).rows[0];
      if(!plugin)throw httpError(404,'plugin_not_found');
      await c.query('INSERT INTO plugin_skills(skill_ref,plugin_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[skill_ref,plugin.id]);
      const owner=(await c.query('SELECT plugin_id FROM plugin_skills WHERE skill_ref=$1 FOR UPDATE',[skill_ref])).rows[0];
      if(owner.plugin_id!==plugin.id)throw httpError(409,'skill_owner_conflict');
      await c.query(`INSERT INTO commission_skill_versions(skill_ref,content_sha256,enabled) VALUES($1,$2,$3)
        ON CONFLICT(skill_ref,content_sha256) DO UPDATE SET enabled=EXCLUDED.enabled`,[skill_ref,content_sha256,enabled]);
      await c.query('INSERT INTO audit_events(action,target_id,administrator_id,details) VALUES($1,$2,$3,$4)',
        ['commission.skill_version',plugin.id,req.administrator.id,JSON.stringify({skill_ref,content_sha256,enabled,reason:reason.trim()})]);
      return {skill_ref,content_sha256,enabled};
    });
  });
  app.post('/api/me/desktop/bootstrap',async req=>{
    if(!req.apiUser.session_id)throw httpError(403,'customer_login_required');
    limiter.take('desktop:'+req.apiUser.id,20,600000);
    // 登录后就把 lanehub 的账号与密钥备好：一个客户一个密钥（映射表主键是 user_id），
    // 首次建号时发新人额度。放在这里而不是注册事务里——那是个 db.tx，把一次跨网络调用
    // 塞进去会把事务拖长，失败还会把注册一起回滚掉。
    // 这里失败也不该挡住 bootstrap：密钥在第一次发请求时还会再备一次（网关那条路）。
    await provisionIfEnabled(db,options,{userId:req.apiUser.id,name:req.apiUser.name}).catch(()=>{});
    const viaLanehub=Boolean(options.lanehubCatalog)&&await lanehubMode(db);
    // 旧模式读本地号池的型号；lanehub 模式不查（密钥行的 models 永远是空的）。
    const legacyAvailable=viaLanehub?null:new Set((await db.query(`SELECT DISTINCT unnest(k.models) AS model FROM upstream_keys k
        JOIN upstream_accounts a ON a.id=k.account_id WHERE k.enabled AND a.enabled`)).rows.map((row)=>row.model));
    // lanehub 模式下目录从 lanehub 派生（真源在那边）；旧模式仍读本地快照。
    const catalog=viaLanehub?options.lanehubCatalog.desktop():desktopCatalog(legacyAvailable);
    // 插件白名单也要用**能卖的型号**来判：lanehub 客户密钥行的 models 是空的
    //（lanehub.mjs ensureAccount 故意留空，避免被 legacy 池选中）。继续用 upstream_keys.models
    // 过滤插件，会把插件全过滤掉、桌面端拿不到插件凭据，归属与分成整条断在这里。
    // 用整个 lanehub 目录（含纯文本型号），不能只用 media()——那只含图片/视频。
    const available=viaLanehub?new Set(options.lanehubCatalog.data.models.map((m)=>m.id)):legacyAvailable;
    const {models,image_models,video_models,canonical_params,default_model}=catalog;
    if(!models.length)throw httpError(503,'desktop_models_unavailable');
    return db.tx(async c=>{
      const user=(await c.query('SELECT enabled FROM users WHERE id=$1 FOR UPDATE',[req.apiUser.id])).rows[0];
      if(!user?.enabled)throw httpError(403,'account_disabled');
      const session=(await c.query('SELECT "expiresAt" FROM auth_sessions WHERE id=$1 AND "userId"=$2 AND "expiresAt">now()',
        [req.apiUser.session_id,req.apiUser.auth_user_id])).rows[0];
      if(!session)throw httpError(401,'customer_login_required');
      // One row per login session: restarting rotates its secret without
      // accumulating permanent Keys or touching another device's credentials.
      const value=token('ipz_');
      const result=await c.query(`INSERT INTO access_tokens(id,user_id,token_hash,prefix,name,expires_at,auth_session_id)
        VALUES($1,$2,$3,$4,'IPZSK Desktop',$5,$6)
        ON CONFLICT(auth_session_id) WHERE plugin_id IS NULL DO UPDATE SET token_hash=EXCLUDED.token_hash,prefix=EXCLUDED.prefix,
        expires_at=EXCLUDED.expires_at WHERE access_tokens.revoked_at IS NULL RETURNING id`,
        [randomUUID(),req.apiUser.id,hash(value),value.slice(0,12),session.expiresAt,req.apiUser.session_id]);
      if(!result.rowCount)throw httpError(403,'desktop_access_revoked');
      await c.query('INSERT INTO audit_events(action,target_id) VALUES($1,$2)',['desktop.bootstrap',result.rows[0].id]);
      const plugins=(await c.query(`SELECT p.* FROM plugins p WHERE enabled AND allowed_models && $1::text[] AND runtime_id IS NOT NULL ORDER BY slug`,[[...available]])).rows;
      const plugin_configs=[];
      for(const plugin of plugins){
        const credential=token('ipz_');
        const issued=await c.query(`INSERT INTO access_tokens(id,user_id,token_hash,prefix,name,expires_at,auth_session_id,plugin_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(auth_session_id,plugin_id) WHERE plugin_id IS NOT NULL
          DO UPDATE SET token_hash=EXCLUDED.token_hash,prefix=EXCLUDED.prefix,expires_at=EXCLUDED.expires_at
          WHERE access_tokens.revoked_at IS NULL RETURNING id`,
          [randomUUID(),req.apiUser.id,hash(credential),credential.slice(0,12),'插件：'+plugin.name,session.expiresAt,req.apiUser.session_id,plugin.id]);
        if(!issued.rowCount)continue;
        if(plugin.runtime_id)plugin_configs.push({package:plugin.package_name,id:plugin.runtime_id,plugin_id:plugin.id,
          config:plugin.runtime_config,credential_paths:plugin.credential_paths,credential});
      }
      return {token:value,expires_at:session.expiresAt,default_model,models,image_models,video_models,canonical_params,plugin_configs};
    });
  });
}
