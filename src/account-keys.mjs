import { randomUUID } from 'node:crypto';
import { hash, token, httpError } from './security.mjs';
import * as v from './validation.mjs';

const columns='id,user_id,name,prefix,rpm,expires_at,revoked_at,created_at,last_used_at';
export async function issueKey(c,userId,body={}) {
  const user=(await c.query('SELECT enabled FROM users WHERE id=$1 FOR UPDATE',[userId])).rows[0];
  if(!user)throw httpError(404,'not_found');
  if(!user.enabled)throw httpError(403,'account_disabled');
  const count=(await c.query('SELECT count(*) FROM access_tokens WHERE user_id=$1 AND auth_session_id IS NULL AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())',[userId])).rows[0].count;
  if(Number(count)>=20)throw httpError(409,'key_limit_reached');
  const name=v.text(body.name??'默认凭证',100),rpm=body.rpm==null?null:v.integer(body.rpm,1,600);
  let expires=null;
  if(body.expires_at!=null){
    if(typeof body.expires_at!=='string'||!Number.isFinite(Date.parse(body.expires_at))||Date.parse(body.expires_at)<=Date.now())throw httpError(400,'invalid_expiry');
    expires=new Date(body.expires_at).toISOString();
  }
  const value=token('ipz_'),id=randomUUID();
  await c.query('INSERT INTO access_tokens(id,user_id,token_hash,prefix,name,rpm,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,userId,hash(value),value.slice(0,12),name,rpm,expires]);
  await c.query('INSERT INTO audit_events(action,target_id,details) VALUES($1,$2,$3)',['access_token.create',id,JSON.stringify({user_id:userId,name})]);
  return {id,token:value};
}
export function accountKeyRoutes(app,{db}){
  for(const admin of [false,true]){
    const base=admin?'/admin/api/users/:userId/tokens':'/api/me/tokens';
    const owner=req=>admin?v.uuid(req.params.userId):req.apiUser.id;
    const guard=req=>{if(!admin&&!req.apiUser.session_id)throw httpError(403,'email_login_required');};
    // 用户自己管理的只有长期手工 Key：登录会话签发的网页/桌面/插件凭证随会话轮换与注销，不进列表也不能在这里撤销——
    // 混在一起既会把手工 Key 挤出 200 行，又会让用户撤掉当前网页会话的 /v1 凭证（之后该会话永久 403）。
    const manual=admin?'':' AND auth_session_id IS NULL AND plugin_id IS NULL';
    app.get(base,async req=>{guard(req);return {rows:(await db.query(`SELECT ${columns} FROM access_tokens WHERE user_id=$1${manual} ORDER BY created_at DESC LIMIT 200`,[owner(req)])).rows};});
    app.post(base,async req=>{guard(req);return db.tx(c=>issueKey(c,owner(req),req.body));});
    app.post(base+'/:id/revoke',async req=>{
      guard(req);const userId=owner(req),id=v.uuid(req.params.id);
      return db.tx(async c=>{
        await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[userId]);
        const found=(await c.query(`SELECT revoked_at FROM access_tokens WHERE id=$1 AND user_id=$2${manual} FOR UPDATE`,[id,userId])).rows[0];
        if(!found)throw httpError(404,'not_found');
        // 重复撤销是幂等的：不改时间、不再写审计。
        if(found.revoked_at)return {ok:true};
        await c.query('UPDATE access_tokens SET revoked_at=now() WHERE id=$1',[id]);
        await c.query('INSERT INTO audit_events(action,target_id,details) VALUES($1,$2,$3)',['access_token.revoke',id,JSON.stringify({user_id:userId})]);return {ok:true};
      });
    });
  }
}
