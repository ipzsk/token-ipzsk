import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {database} from '../src/database.mjs';
import {createApp} from '../src/app.mjs';
import {hash,token,passwordHash} from '../src/security.mjs';
import {importGithubRelease} from '../src/plugins.mjs';
import {recordTaskCharge} from '../src/task-charges.mjs';

async function artifact(){
 const dir=await mkdtemp(join(tmpdir(),'ipzsk-release-'));
 try {await mkdir(join(dir,'package'));await writeFile(join(dir,'package/package.json'),JSON.stringify({name:'fixture-plugin',version:'1.0.0'}));return execFileSync('tar',['-czf','-','-C',dir,'package']);}
 finally{await rm(dir,{recursive:true,force:true});}
}
function github(archive){return async url=>{
 if(url.startsWith('https://api.github.com/repos/Fixture/plugin/releases/tags/'))return Response.json({id:10,draft:false,body:'Fixture release <script>test</script>',assets:[{id:20,name:'plugin.tgz',state:'uploaded',size:archive.length,digest:'sha256:'+createHash('sha256').update(archive).digest('hex'),browser_download_url:'https://github.com/Fixture/plugin/releases/download/v1.0.0/plugin.tgz'}]});
 assert.equal(url,'https://github.com/Fixture/plugin/releases/download/v1.0.0/plugin.tgz');return new Response(archive);
};}
test('GitHub import pins and checks the actual npm package, rejects unrelated URLs and package identity',async()=>{
 const archive=await artifact(),fetcher=github(archive),p={repository:'Fixture/plugin',package_name:'fixture-plugin'},body={release_url:'https://github.com/Fixture/plugin/releases/tag/v1.0.0'};
 const r=await importGithubRelease(p,body,fetcher);assert.equal(r.version,'1.0.0');assert.equal(r.sha256,createHash('sha256').update(archive).digest('hex'));
 await assert.rejects(importGithubRelease(p,{release_url:'http://127.0.0.1/private'},fetcher),{code:'invalid_release_url'});
 await assert.rejects(importGithubRelease({...p,package_name:'wrong'},body,fetcher),{code:'package_identity_mismatch'});
 await assert.rejects(importGithubRelease(p,body,async(url,opts)=>url.startsWith('https://api.github.com')?fetcher(url,opts):new Response(null,{status:302,headers:{location:'http://127.0.0.1/'}})),{code:'invalid_asset_redirect'});
});

test('plugin admin lifecycle and attributed accounting use an isolated PostgreSQL schema',async t=>{
 assert.ok(process.env.TEST_DB_HOST);const schema='plugin_test_'+randomUUID().replaceAll('-','');
 const config={host:process.env.TEST_DB_HOST,database:'gateway_test',user:'gateway',password:process.env.TEST_DB_PASSWORD};
 const setup=database(config);await setup.query(`CREATE SCHEMA ${schema}`);const db=database({...config,options:`-c search_path=${schema}`});let app;
 try{
  await db.migrate();const user=randomUUID(),plain=token('ipz_'),pluginToken=token('ipz_'),pluginId='7d8b7d87-b85f-49f1-bde7-a0b1a2f33401',key=randomUUID(),account=randomUUID();
  await db.query('INSERT INTO users(id,name) VALUES($1,$2)',[user,'Fixture user']);
  for(const [secret,pid] of [[plain,null],[pluginToken,pluginId]])await db.query('INSERT INTO access_tokens(id,user_id,token_hash,prefix,plugin_id) VALUES($1,$2,$3,$4,$5)',[randomUUID(),user,hash(secret),secret.slice(0,12),pid]);
  await db.query("INSERT INTO developer_profiles(user_id,display_name,state) VALUES($1,'Fixture owner','approved')",[user]);
  await db.query('UPDATE plugins SET owner_user_id=$2,revenue_share_bps=2500 WHERE id=$1',[pluginId,user]);
  await db.migrate();assert.equal((await db.query('SELECT count(*) FROM access_tokens')).rows[0].count,'2');
  await db.query('INSERT INTO administrators(id,password_hash) VALUES(1,$1)',[await passwordHash('fixture-admin-password')]);
  await db.query("INSERT INTO administrators(id,username,password_hash,role) VALUES(2,'viewer',$1,'viewer')",[await passwordHash('fixture-viewer-password')]);
  await db.query('INSERT INTO upstream_accounts(id,name) VALUES($1,$2)',[account,'Fixture']);
  await db.query("INSERT INTO upstream_keys(id,account_id,name,fingerprint,suffix,secret_ref,models) VALUES($1,$2,'fixture','fixture','test','fixture',ARRAY['gpt-image-2'])",[key,account]);
  const scheduler={keys:new Map(),accounts:new Map(),async acquire(){return {row:{id:key,secret_ref:'fixture'},release(){}};}};
  const upstream={candidates(){return [];},refreshSoon(){},async request(_ref,path){if(path.includes('/tasks/'))return Response.json({data:{id:'image-fixture',status:'completed',credits_cost:0.5,result:{images:[]}}});return Response.json({code:200,data:[{status:'submitted',task_id:'image-fixture'}]});}};
  app=await createApp({db,scheduler,upstream,origin:'https://api.ipzsk.com',secureCookies:true,githubFetch:github(await artifact())});
  const login=async(username,password)=>{const r=await app.inject({url:'/admin/api/login',method:'POST',payload:{username,password},headers:{origin:'https://api.ipzsk.com'}});assert.equal(r.statusCode,200,r.body);return [].concat(r.headers['set-cookie']).map(c=>c.split(';')[0]).join('; ');};
  const cookie=await login('admin','fixture-admin-password'),viewer=await login('viewer','fixture-viewer-password');
  const admin=(path,payload,c=cookie)=>app.inject({url:'/admin/api'+path,method:payload?'POST':'GET',payload,headers:{cookie:c,origin:'https://api.ipzsk.com'}});
  const call=(path,secret=plain,payload,extra={})=>app.inject({url:path,method:payload?'POST':'GET',payload,headers:{authorization:'Bearer '+secret,...extra}});
  let id,release;
  await t.test('pending stays hidden until admin publishes; withdrawal and disabling hide catalog entries',async()=>{
   const b={slug:'fixture',name:'Fixture',repository:'Fixture/plugin',package_name:'fixture-plugin',publisher_ref:'author-001',allowed_models:['gpt-image-2']};
   assert.equal((await admin('/plugins',b,viewer)).statusCode,403);
   assert.equal((await app.inject({url:'/admin/api/plugins'})).statusCode,401);
   const created=await admin('/plugins',b);assert.equal(created.statusCode,200,created.body);id=created.json().id;
   const imported=await admin('/plugins/'+id+'/releases/import',{release_url:'https://github.com/Fixture/plugin/releases/tag/v1.0.0'});assert.equal(imported.statusCode,200,imported.body);release=imported.json().id;
   assert.equal((await admin('/plugins/review-queue',undefined,viewer)).statusCode,403);
   assert.equal((await app.inject({url:'/admin/api/plugins/review-queue'})).statusCode,401);
   const queue=(await admin('/plugins/review-queue')).json().releases;assert.equal(queue.length,1);assert.equal(queue[0].id,release);assert.equal(queue[0].plugin_name,'Fixture');
   assert.equal((await call('/api/me/plugin-market')).json().plugins.length,0);
   assert.equal((await admin('/plugins/'+id+'/releases/'+release+'/state',{state:'published'},viewer)).statusCode,403);
   assert.equal((await admin('/plugins/'+id+'/releases/'+release+'/state',{state:'published'})).statusCode,200);
   assert.equal((await admin('/plugins/review-queue')).json().releases.length,0);
   const market=(await call('/api/me/plugin-market')).json();assert.equal(market.plugins[0].id,id);assert.match(market.plugins[0].sha256,/^[a-f0-9]{64}$/);
   assert.equal((await admin('/plugins/'+id+'/releases/import',{release_url:'https://github.com/Fixture/plugin/releases/tag/v1.0.0'})).statusCode,409);
   await admin('/plugins/'+id+'/settings',{...b,enabled:false});assert.equal((await call('/api/me/plugin-market')).json().plugins.length,0);
   await admin('/plugins/'+id+'/settings',{...b,enabled:true});
   await admin('/plugins/'+id+'/releases/'+release+'/state',{state:'withdrawn'});assert.equal((await call('/api/me/plugin-market')).json().plugins.length,0);
  });
  let requestId;
  await t.test('server-bound credential attribution cannot be overwritten by headers; idempotency prevents duplicate charges',async()=>{
   assert.equal((await call('/api/me/tokens',pluginToken)).statusCode,403);
   assert.equal((await call('/v1/chat/completions',pluginToken,{model:'gpt-5.6-sol',messages:[{role:'user',content:'test'}]})).statusCode,403);
   const body={model:'gpt-image-2',prompt:'fixture'};
   const r=await call('/v1/images/generations',pluginToken,body,{'idempotency-key':'image-one','x-plugin-id':id});assert.equal(r.statusCode,200,r.body);requestId=r.headers['x-request-id'];
   const row=(await db.query('SELECT * FROM requests WHERE id=$1',[requestId])).rows[0];assert.equal(row.plugin_id,pluginId);assert.equal(row.plugin_publisher_ref,'JayceHuang');assert.equal(row.plugin_owner_user_id,user);assert.equal(row.plugin_share_bps,2500);assert.equal(row.total_tokens,null);
   assert.equal((await call('/v1/images/generations',pluginToken,body,{'idempotency-key':'image-one'})).statusCode,409);
   const unbound=await call('/v1/images/generations',plain,body,{'x-plugin-id':pluginId});assert.equal(unbound.statusCode,200,unbound.body);
   assert.equal((await db.query('SELECT plugin_id FROM requests WHERE id=$1',[unbound.headers['x-request-id']])).rows[0].plugin_id,null);
   assert.equal((await call('/v1/tasks/'+unbound.headers['x-request-id'],pluginToken)).statusCode,404);
   assert.equal((await call('/v1/tasks/'+requestId,pluginToken)).statusCode,200);
   await recordTaskCharge(db,{id:requestId,upstream_task_id:'image-fixture'},{id:'image-fixture',status:'completed',credits_cost:0.5});
  });
  await t.test('report distinguishes unknown tokens, confirmed costs and revenue; ownership is snapshotted',async()=>{
   await db.query("UPDATE plugins SET publisher_ref='new-owner' WHERE id=$1",[pluginId]);
   const r=await admin('/plugin-usage?plugin_id='+pluginId);assert.equal(r.statusCode,200,r.body);const row=r.json().rows[0];
   assert.equal(row.requests,'1');assert.equal(row.total_tokens,null);assert.equal(row.unknown_token_requests,'1');assert.equal(Number(row.confirmed_cost_cny),0.5);assert.equal(row.charged_cny,null);assert.equal(row.completed_media_tasks,'1');assert.equal(row.plugin_publisher_ref,'JayceHuang');
   const detail=await admin('/requests?plugin_id='+pluginId);assert.equal(detail.json().rows.length,1);assert.equal(detail.json().rows[0].plugin_id,pluginId);
   assert.equal((await admin('/plugin-usage?from=2026-02-31')).statusCode,400);
   await db.query('UPDATE plugins SET enabled=false WHERE id=$1',[pluginId]);assert.equal((await call('/v1/models',pluginToken)).statusCode,403);
  });
 }finally{await app?.close();await db.close();await setup.query(`DROP SCHEMA ${schema} CASCADE`);await setup.close();}
});
