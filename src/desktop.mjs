import { randomUUID } from 'node:crypto';
import { hash, token, httpError, RateLimiter } from './security.mjs';

import { desktopCatalog } from './model-catalog.mjs';
import { lanehubMode, provisionCustomer } from './lanehub.mjs';

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

export function desktopRoutes(app,{db,upstream,lanehub=null,lanehubAccountId=null,lanehubSignupCny=0,lanehubUsdCny=0,lanehubQuotaPerUnit=500000}) {
  const limiter=new RateLimiter();
  app.post('/api/me/desktop/bootstrap',async req=>{
    if(!req.apiUser.session_id)throw httpError(403,'customer_login_required');
    limiter.take('desktop:'+req.apiUser.id,20,600000);
    // 登录后就把 lanehub 的账号与密钥备好：一个客户一个密钥（映射表主键是 user_id），
    // 首次建号时发新人额度。放在这里而不是注册事务里——那是个 db.tx，把一次跨网络调用
    // 塞进去会把事务拖长，失败还会把注册一起回滚掉。
    // 这里失败也不该挡住 bootstrap：密钥在第一次发请求时还会再备一次（网关那条路）。
    if(lanehub&&await lanehubMode(db)){
      await provisionCustomer(db,lanehub,upstream,{
        userId:req.apiUser.id,name:req.apiUser.name,accountId:lanehubAccountId,
        signupCny:lanehubSignupCny,usdCnyRate:lanehubUsdCny,quotaPerUnit:lanehubQuotaPerUnit,
      }).catch(()=>{});
    }
    const rows=(await db.query(`SELECT DISTINCT unnest(k.models) AS model FROM upstream_keys k
      JOIN upstream_accounts a ON a.id=k.account_id WHERE k.enabled AND a.enabled`)).rows;
    const available=new Set(rows.map(row=>row.model));
    const {models,image_models,video_models,canonical_params,default_model}=desktopCatalog(available);
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
      const plugins=(await c.query(`SELECT * FROM plugins WHERE enabled AND runtime_id IS NOT NULL AND allowed_models && $1::text[] ORDER BY slug`,[[...available]])).rows;
      const plugin_configs=[];
      for(const plugin of plugins){
        const credential=token('ipz_');
        const issued=await c.query(`INSERT INTO access_tokens(id,user_id,token_hash,prefix,name,expires_at,auth_session_id,plugin_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(auth_session_id,plugin_id) WHERE plugin_id IS NOT NULL
          DO UPDATE SET token_hash=EXCLUDED.token_hash,prefix=EXCLUDED.prefix,expires_at=EXCLUDED.expires_at
          WHERE access_tokens.revoked_at IS NULL RETURNING id`,
          [randomUUID(),req.apiUser.id,hash(credential),credential.slice(0,12),'插件：'+plugin.name,session.expiresAt,req.apiUser.session_id,plugin.id]);
        if(!issued.rowCount)continue;
        plugin_configs.push({package:plugin.package_name,id:plugin.runtime_id,plugin_id:plugin.id,
          config:plugin.runtime_config,credential_paths:plugin.credential_paths,credential});
      }
      return {token:value,expires_at:session.expiresAt,default_model,models,image_models,video_models,canonical_params,plugin_configs};
    });
  });
}
