import {randomUUID} from 'node:crypto';
import {httpError,RateLimiter} from './security.mjs';
import {uuid} from './validation.mjs';
import {text,repository,packageName,period,importGithubRelease} from './plugins.mjs';

export function developerRoutes(app,{db,githubFetch}){
 const limiter=new RateLimiter();
 app.addHook('onRequest',async req=>{
  if(!req.url.startsWith('/api/me/developer'))return;
  if(!req.apiUser?.session_id)throw httpError(403,'customer_login_required');
  if(!['GET','HEAD'].includes(req.method))limiter.take('developer:'+req.apiUser.id,20,600000);
  const profile=(await db.query('SELECT * FROM developer_profiles WHERE user_id=$1',[req.apiUser.id])).rows[0];
  req.developer=profile??null;
  if(!['/api/me/developer','/api/me/developer/apply'].includes(req.routeOptions.url)&&profile?.state!=='approved')throw httpError(403,'developer_approval_required');
 });
 async function owned(c,id,userId,lock=false){
  const row=(await c.query('SELECT * FROM plugins WHERE id=$1 AND owner_user_id=$2'+(lock?' FOR UPDATE':''),[uuid(id),userId])).rows[0];
  if(!row)throw httpError(404,'plugin_not_found');return row;
 }
 const audit=(c,req,action,id)=>c.query('INSERT INTO audit_events(action,target_id,details) VALUES($1,$2,$3)',[action,id,JSON.stringify({actor_user_id:req.apiUser.id})]);
 app.get('/api/me/developer',async req=>({profile:req.developer}));
 app.post('/api/me/developer/apply',async req=>{
  const name=text(req.body?.display_name);
  const row=await db.query(`INSERT INTO developer_profiles(user_id,display_name) VALUES($1,$2)
   ON CONFLICT(user_id) DO UPDATE SET display_name=$2,state='pending',review_note='',reviewed_at=NULL,reviewed_by=NULL
   WHERE developer_profiles.state='rejected' RETURNING state`,[req.apiUser.id,name]);
  if(!row.rowCount)throw httpError(409,'developer_application_exists');return {state:'pending'};
 });
 app.get('/admin/api/developers',async()=>({rows:(await db.query(`SELECT d.*,u.name,u.email FROM developer_profiles d JOIN users u ON u.id=d.user_id ORDER BY d.created_at DESC`)).rows}));
 app.post('/admin/api/developers/:id/review',async req=>{
  const state=req.body?.state;
  if(!['approved','rejected','disabled'].includes(state))throw httpError(400,'invalid_review_state');
  const row=await db.query('UPDATE developer_profiles SET state=$2,review_note=$3,reviewed_by=$4,reviewed_at=now() WHERE user_id=$1 RETURNING user_id',
   [uuid(req.params.id),state,String(req.body.review_note??'').slice(0,500),req.administrator.id]);
  if(!row.rowCount)throw httpError(404,'developer_not_found');return {ok:true};
 });
 app.post('/admin/api/plugins/:id/owner',async req=>{
  const id=uuid(req.params.id),owner=uuid(req.body?.owner_user_id),bps=req.body?.revenue_share_bps??null;
  if(bps!==null&&(!Number.isInteger(bps)||bps<0||bps>10000))throw httpError(400,'invalid_revenue_share');
  await db.tx(async c=>{
   const developer=(await c.query("SELECT user_id FROM developer_profiles WHERE user_id=$1 AND state='approved' FOR UPDATE",[owner])).rows[0];
   if(!developer)throw httpError(400,'developer_approval_required');
   const old=(await c.query('SELECT owner_user_id,revenue_share_bps FROM plugins WHERE id=$1 FOR UPDATE',[id])).rows[0];
   if(!old)throw httpError(404,'plugin_not_found');
   await c.query('UPDATE plugins SET owner_user_id=$2,revenue_share_bps=$3 WHERE id=$1',[id,owner,bps]);
   await c.query('INSERT INTO audit_events(action,target_id,administrator_id,details) VALUES($1,$2,$3,$4)',
    ['plugin.ownership',id,req.administrator.id,JSON.stringify({previous:old,next:{owner_user_id:owner,revenue_share_bps:bps}})]);
  });return {ok:true};
 });
 app.get('/api/me/developer/plugins',async req=>({plugins:(await db.query(`SELECT p.id,p.slug,p.name,p.repository,p.package_name,p.enabled,p.revenue_share_bps,
   (SELECT count(DISTINCT q.user_id) FROM requests q LEFT JOIN media_tasks mt ON mt.id=q.id WHERE q.plugin_id=p.id AND q.plugin_owner_user_id=$1 AND ((mt.id IS NULL AND q.status='succeeded') OR mt.status='completed')) AS active_users,
   count(r.id) AS versions,count(r.id) FILTER(WHERE r.state='published') AS published_versions,
   count(r.id) FILTER(WHERE r.state='pending') AS pending_versions,count(r.id) FILTER(WHERE r.state='withdrawn') AS withdrawn_versions
   FROM plugins p LEFT JOIN plugin_releases r ON r.plugin_id=p.id WHERE p.owner_user_id=$1 GROUP BY p.id ORDER BY p.created_at DESC`,[req.apiUser.id])).rows}));
 app.post('/api/me/developer/plugins',async req=>{
  const b=req.body??{},slug=text(b.slug,80);
  if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))throw httpError(400,'invalid_plugin_slug');
  const id=randomUUID();
  await db.tx(async c=>{
   await c.query('INSERT INTO plugins(id,slug,name,repository,package_name,publisher_ref,owner_user_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [id,slug,text(b.name),repository(b.repository),packageName(b.package_name),req.developer.display_name,req.apiUser.id]);
   await audit(c,req,'developer.plugin.create',id);
  });return {id};
 });
 app.post('/api/me/developer/plugins/:id/settings',async req=>db.tx(async c=>{
  const p=await owned(c,req.params.id,req.apiUser.id,true);
  if((await c.query("SELECT id FROM plugin_releases WHERE plugin_id=$1 AND state='published' LIMIT 1",[p.id])).rowCount)throw httpError(409,'published_metadata_locked');
  await c.query('UPDATE plugins SET name=$2 WHERE id=$1',[p.id,text(req.body?.name)]);
  await audit(c,req,'developer.plugin.edit',p.id);return {ok:true};
 }));
 app.get('/api/me/developer/plugins/:id/releases',async req=>{
  await owned(db,req.params.id,req.apiUser.id);
  return {releases:(await db.query('SELECT id,version,state,notes,review_note,withdrawal_requested,created_at,published_at,sha256,release_url FROM plugin_releases WHERE plugin_id=$1 ORDER BY created_at DESC',[req.params.id])).rows};
 });
 app.post('/api/me/developer/plugins/:id/releases',async req=>{
  limiter.take('developer-release:'+req.apiUser.id,5,600000);
  const p=await owned(db,req.params.id,req.apiUser.id),r=await importGithubRelease(p,req.body??{},githubFetch),id=randomUUID();
  await db.tx(async c=>{
   await owned(c,p.id,req.apiUser.id,true);
   if(!(await c.query("SELECT user_id FROM developer_profiles WHERE user_id=$1 AND state='approved'",[req.apiUser.id])).rowCount)throw httpError(403,'developer_approval_required');
   await c.query(`INSERT INTO plugin_releases(id,plugin_id,version,github_release_id,github_asset_id,release_url,artifact_url,sha256,size_bytes,notes,submitted_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[id,p.id,r.version,r.github_release_id,r.github_asset_id,r.release_url,r.artifact_url,r.sha256,r.size_bytes,r.notes,req.apiUser.id]);
   await audit(c,req,'developer.release.submit',id);
  });return {id,state:'pending'};
 });
 app.post('/api/me/developer/plugins/:id/releases/:releaseId/withdraw',async req=>db.tx(async c=>{
  await owned(c,req.params.id,req.apiUser.id,true);
  const r=await c.query(`UPDATE plugin_releases SET state=CASE WHEN state='pending' THEN 'withdrawn' ELSE state END,
   withdrawal_requested=(state='published') WHERE id=$1 AND plugin_id=$2 AND state IN ('pending','published') RETURNING state,withdrawal_requested`,[uuid(req.params.releaseId),req.params.id]);
  if(!r.rowCount)throw httpError(409,'release_not_withdrawable');await audit(c,req,'developer.release.withdraw',req.params.releaseId);return r.rows[0];
 }));
 app.get('/api/me/developer/usage',async req=>{
  const {from,to}=period(req.query),id=req.query.plugin_id?uuid(req.query.plugin_id):null;
  // Historical ownership and rate snapshots govern earnings, not the current editable owner.
  const rows=(await db.query(`SELECT r.plugin_id,p.name AS plugin_name,r.model,
   count(DISTINCT r.user_id) FILTER(WHERE (t.id IS NULL AND r.status='succeeded') OR t.status='completed') AS active_users,
   count(*) AS requests,count(*) FILTER(WHERE r.status='failed' OR t.status='failed') AS failed_requests,
   sum(r.input_tokens) AS input_tokens,sum(r.output_tokens) AS output_tokens,sum(r.total_tokens) AS total_tokens,
   count(*) FILTER(WHERE r.total_tokens IS NULL) AS unknown_token_requests,
   sum(b.charged_cny-b.refunded_cny) FILTER(WHERE b.state='settled') AS billed_revenue_cny,
   -- 同上：分成只有 plugin_earnings 一个口径，退款在那里是一条负数明细。
   sum((SELECT coalesce(sum(pe.amount_cny),0) FROM plugin_earnings pe WHERE pe.request_id=r.id)) AS accrued_earnings_cny,
   count(*) FILTER(WHERE b.state='settled' AND r.plugin_share_bps IS NULL) AS unconfigured_share_requests,
   count(t.id) AS media_tasks,count(*) FILTER(WHERE t.status='completed') AS completed_media_tasks
   FROM requests r JOIN plugins p ON p.id=r.plugin_id LEFT JOIN request_billing b ON b.request_id=r.id LEFT JOIN media_tasks t ON t.id=r.id
   WHERE r.plugin_owner_user_id=$1 AND r.created_at>=($2::date::timestamp AT TIME ZONE 'Asia/Shanghai')
   AND r.created_at<(($3::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai') AND ($4::uuid IS NULL OR r.plugin_id=$4)
   GROUP BY r.plugin_id,p.name,r.model ORDER BY p.name,r.model`,[req.apiUser.id,from,to,id])).rows;
  return {from,to,timezone:'Asia/Shanghai',rows,settlement_enabled:false};
 });
}
