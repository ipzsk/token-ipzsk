import { chat } from './validation.mjs';
import { adaptModelRequest } from './model-catalog.mjs';
import { httpError } from './security.mjs';
import { prices } from './text-pricing.mjs';
import { quoteTextHold,points,wallet } from './billing.mjs';
import { lanehubMode, provisionIfEnabled } from './lanehub.mjs';
import { lanehubBalance } from './lanehub-charges.mjs';
const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
const string=(s,max)=>typeof s==='string'&&s.length<=max;
export function validateWorkspace(s){
  if(!object(s)||!Array.isArray(s.spaces)||s.spaces.length<1||s.spaces.length>30||!Array.isArray(s.projects)||s.projects.length>500)throw httpError(400,'invalid_workspace');
  const ids=new Set();
  for(const x of s.spaces){if(!object(x)||!string(x.id,100)||ids.has(x.id)||!string(x.name,40)||!x.name.trim()||!['focus','reader','voice','sources'].every(k=>string(x[k],6000)))throw httpError(400,'invalid_workspace');ids.add(x.id);}
  const pids=new Set();
  for(const p of s.projects){if(!object(p)||!string(p.id,100)||pids.has(p.id)||!ids.has(p.space)||!string(p.title,120)||!string(p.body,100000)||!string(p.outline,12000)||!string(p.tags,300)||!Number.isFinite(p.updated))throw httpError(400,'invalid_workspace');pids.add(p.id);
    if(p.versions!==undefined&&(!Array.isArray(p.versions)||p.versions.length>20||!p.versions.every(v=>object(v)&&string(v.body,100000)&&string(v.title,120)&&string(v.outline,12000))))throw httpError(400,'invalid_workspace');
  }
  if(Buffer.byteLength(JSON.stringify(s))>2_000_000)throw httpError(413,'workspace_full');
  return s;
}
export function workspaceChat(body){
  if(!object(body)||!prices.models[body.model]||body.model.includes('search')||!Array.isArray(body.messages)||body.messages.length<1||body.messages.length>8||!body.messages.every(m=>object(m)&&['system','user','assistant'].includes(m.role)&&string(m.content,40000))||JSON.stringify(body.messages).length>60000)throw httpError(400,'invalid_workspace_prompt');
  return adaptModelRequest('/v1/chat/completions',chat({model:body.model,messages:body.messages.map(m=>({role:m.role,content:m.content})),max_completion_tokens:4096,stream:false}));
}
export function workspaceRoutes(app,options){
  const {db}=options;
  const user=req=>{if(!req.apiUser?.session_id)throw httpError(403,'email_login_required');return req.apiUser.id;};
  app.get('/api/me/workspace',async req=>{const id=user(req);const r=(await db.query('SELECT revision,payload FROM content_workspaces WHERE user_id=$1',[id])).rows[0];return r??{revision:0,payload:null};});
  app.post('/api/me/workspace',{bodyLimit:2_100_000},async req=>{
    const id=user(req),{revision,payload}=req.body??{};if(!Number.isSafeInteger(revision)||revision<0)throw httpError(400,'invalid_revision');validateWorkspace(payload);
    return db.tx(async c=>{
      await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[id]);
      const old=(await c.query('SELECT revision FROM content_workspaces WHERE user_id=$1',[id])).rows[0];
      if((old?.revision??0)!==revision)throw httpError(409,'workspace_conflict');
      const r=await c.query(`INSERT INTO content_workspaces(user_id,revision,payload) VALUES($1,1,$2) ON CONFLICT(user_id) DO UPDATE SET revision=content_workspaces.revision+1,payload=EXCLUDED.payload,updated_at=now() RETURNING revision`,[id,JSON.stringify(payload)]);
      return {revision:r.rows[0].revision};
    });
  });
  app.get('/api/me/workspace/models',async req=>{user(req);const rows=(await db.query('SELECT DISTINCT unnest(k.models) AS model FROM upstream_keys k JOIN upstream_accounts a ON a.id=k.account_id WHERE k.enabled AND a.enabled ORDER BY model')).rows;return {models:rows.map(x=>x.model).filter(m=>prices.models[m]&&!m.includes('search'))};});
  app.post('/api/me/workspace/quote',async req=>{
    user(req);const body=workspaceChat(req.body);
    const policy=(await db.query('SELECT * FROM billing_policy WHERE id=1')).rows[0];
    // lanehub 模式：额度真源在对面，这里只报一个保守上界让页面显示，不预扣（对面扣）。
    const viaLanehub=Boolean(options.lanehub)&&await lanehubMode(db);
    if(!viaLanehub&&!policy.enabled)throw httpError(503,'billing_unavailable');
    const hold=quoteTextHold(body,policy);
    let available;
    if(viaLanehub){
      const account=await provisionIfEnabled(db,options,{userId:req.apiUser.id,name:req.apiUser.name}).catch(()=>null);
      available=account?await lanehubBalance(options.lanehub,account,{usdCnyRate:options.lanehubUsdCny,quotaPerUnit:options.lanehubQuotaPerUnit}):await wallet(db,req.apiUser.id);
    }else available=await wallet(db,req.apiUser.id);
    return {reserved_points:points(hold),available_points:points(available.available_cny),can_afford:Number(available.available_cny)>=Number(hold),reserved_cny:hold,billing_enabled:viaLanehub||policy.enabled,policy_version:policy.version,output_limit:4096};
  });
}
