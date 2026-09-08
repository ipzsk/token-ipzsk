import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {database} from '../src/database.mjs';
import {createApp} from '../src/app.mjs';
import {passwordHash,hash,token,httpError} from '../src/security.mjs';

test('three roles isolate administration, plugin ownership, usage and customer records',async t=>{
 assert.ok(process.env.TEST_DB_HOST);const schema='developer_test_'+randomUUID().replaceAll('-','');
 const config={host:process.env.TEST_DB_HOST,database:'gateway_test',user:'gateway',password:process.env.TEST_DB_PASSWORD};
 const setup=database(config);await setup.query(`CREATE SCHEMA ${schema}`);const db=database({...config,options:`-c search_path=${schema}`});let app;
 const alice=randomUUID(),bob=randomUUID(),customer=randomUUID();
 try{
  await db.migrate();await db.migrate();
  for(const id of [alice,bob,customer])await db.query('INSERT INTO users(id,name,email,email_verified) VALUES($1,$2,$3,true)',[id,'Fixture '+id,id+'@example.com']);
  for(const [id,role] of [[1,'superadmin'],[2,'operator'],[3,'viewer']])await db.query('INSERT INTO administrators(id,username,role,password_hash) VALUES($1,$2,$3,$4)',[id,role,role,await passwordHash('fixture-role-password')]);
  const customerAuth={async identify(headers){const user=headers.cookie?.replace('fixture=','');if(![alice,bob,customer].includes(user))throw httpError(401,'customer_login_required');return {id:user,session_id:'fixture-session',auth_user_id:user};}};
  app=await createApp({db,customerAuth,upstream:{},scheduler:{keys:new Map(),accounts:new Map()},origin:'https://api.ipzsk.com',secureCookies:true});
  const call=(user,path,payload,extra={})=>app.inject({url:path,method:payload?'POST':'GET',payload,headers:{cookie:'fixture='+user,origin:'https://www.ipzsk.com',...extra}});
  const cookies={};for(const role of ['superadmin','operator','viewer']){const r=await app.inject({url:'/admin/api/login',method:'POST',payload:{username:role,password:'fixture-role-password'},headers:{origin:'https://api.ipzsk.com'}});assert.equal(r.statusCode,200,r.body);cookies[role]=[].concat(r.headers['set-cookie']).map(v=>v.split(';')[0]).join('; ');}
  const admin=(path,payload,role='superadmin')=>app.inject({url:'/admin/api'+path,method:payload?'POST':'GET',payload,headers:{cookie:cookies[role],origin:'https://api.ipzsk.com'}});
  const path='/api/me/developer';let aPlugin,bPlugin;
  await t.test('normal users may apply, cannot self-approve or use API tokens as developer sessions',async()=>{
   assert.equal((await call(customer,path+'/plugins')).statusCode,403);
   for(const user of [alice,bob])assert.equal((await call(user,path+'/apply',{display_name:'Developer '+user,state:'approved'})).json().state,'pending');
   assert.equal((await call(alice,path+'/plugins',{slug:'bad'})).statusCode,403);
   assert.equal((await call(alice,'/admin/api/developers/'+alice+'/review',{state:'approved'},{origin:'https://api.ipzsk.com'})).statusCode,401);
   const secret=token('ipz_');await db.query('INSERT INTO access_tokens(id,user_id,token_hash,prefix) VALUES($1,$2,$3,$4)',[randomUUID(),alice,hash(secret),secret.slice(0,12)]);
   assert.equal((await call(alice,path,undefined,{authorization:'Bearer '+secret})).statusCode,403);
   assert.equal((await call(alice,path+'/apply',{display_name:'Again'},{origin:'https://evil.example'})).statusCode,403);
  });
  await t.test('only superadmin can review developers, publish plugins, inspect profit or manage vouchers',async()=>{
   for(const role of ['operator','viewer'])for(const route of ['/developers','/plugins','/plugin-usage','/vouchers/summary','/ledger','/overview','/requests'])assert.equal((await admin(route,undefined,role)).statusCode,403,role+route);
   assert.equal((await admin('/developers/'+alice+'/review',{state:'approved'},'operator')).statusCode,403);
   for(const user of [alice,bob])assert.equal((await admin('/developers/'+user+'/review',{state:'approved'})).statusCode,200);
   assert.equal((await call(alice,path)).json().profile.state,'approved');
  });
  await t.test('ownership is assigned from the session; developers cannot edit runtime, owner or share rate',async()=>{
   const body={slug:'alice-plugin',name:'Alice plugin',repository:'Fixture/plugin',package_name:'fixture-plugin',owner_user_id:bob,revenue_share_bps:10000,allowed_models:['gpt-image-2'],runtime_config:{secret:'no'}};
   const a=await call(alice,path+'/plugins',body);assert.equal(a.statusCode,200,a.body);aPlugin=a.json().id;
   const b=await call(bob,path+'/plugins',{...body,slug:'bob-plugin',package_name:'bob-plugin'});assert.equal(b.statusCode,200,b.body);bPlugin=b.json().id;
   const stored=(await db.query('SELECT * FROM plugins WHERE id=$1',[aPlugin])).rows[0];assert.equal(stored.owner_user_id,alice);assert.equal(stored.revenue_share_bps,null);assert.deepEqual(stored.allowed_models,[]);assert.deepEqual(stored.runtime_config,{});
   assert.deepEqual((await call(alice,path+'/plugins')).json().plugins.map(p=>p.id),[aPlugin]);
   assert.equal((await call(bob,path+'/plugins/'+aPlugin+'/settings',{name:'stolen'})).statusCode,404);
   assert.equal((await call(bob,path+'/plugins/'+aPlugin+'/releases')).statusCode,404);
   assert.equal((await call(bob,path+'/plugins/'+aPlugin+'/releases',{release_url:'https://evil.example'})).statusCode,404);
   await call(alice,path+'/plugins/'+aPlugin+'/settings',{name:'Renamed',revenue_share_bps:10000,owner_user_id:bob});
   assert.equal((await db.query('SELECT owner_user_id FROM plugins WHERE id=$1',[aPlugin])).rows[0].owner_user_id,alice);
  });
  let release;
  await t.test('release review and withdrawal are distinct and scoped to the owning plugin',async()=>{
   release=randomUUID();await db.query(`INSERT INTO plugin_releases(id,plugin_id,version,github_release_id,github_asset_id,release_url,artifact_url,sha256,size_bytes,submitted_by) VALUES($1,$2,'1.0.0',1,2,'https://github.com/Fixture/plugin/releases/tag/v1.0.0','https://github.com/Fixture/plugin/releases/download/v1.0.0/a.tgz',$3,100,$4)`,[release,aPlugin,'a'.repeat(64),alice]);
   assert.equal((await call(alice,path+'/plugins/'+aPlugin+'/releases/'+release+'/state',{state:'published'})).statusCode,404);
   assert.equal((await call(bob,path+'/plugins/'+bPlugin+'/releases/'+release+'/withdraw',{})).statusCode,409);
   assert.equal((await admin('/plugins/'+aPlugin+'/releases/'+release+'/state',{state:'published',review_note:'Approved fixture'})).statusCode,200);
   assert.equal((await call(alice,path+'/plugins/'+aPlugin+'/settings',{name:'Change after review'})).statusCode,409);
   const requested=await call(alice,path+'/plugins/'+aPlugin+'/releases/'+release+'/withdraw',{});assert.equal(requested.json().state,'published');assert.equal(requested.json().withdrawal_requested,true);
   await admin('/plugins/'+aPlugin+'/releases/'+release+'/state',{state:'withdrawn',review_note:'Withdraw approved'});
   const r=(await call(alice,path+'/plugins/'+aPlugin+'/releases')).json().releases[0];assert.equal(r.state,'withdrawn');assert.equal(r.review_note,'Withdraw approved');
  });
  await t.test('only the owning developer sees aggregate usage and revenue, never customer details or upstream cost',async()=>{
   const requestId=randomUUID();await db.query(`INSERT INTO requests(id,user_id,model,fingerprint,stream,status,usage_state,input_tokens,output_tokens,total_tokens,cost_cny,plugin_id,plugin_owner_user_id,plugin_share_bps) VALUES($1,$2,'fixture-model','fixture',false,'succeeded','reported',12,8,20,3,$3,$4,2500)`,[requestId,customer,aPlugin,alice]);
   await db.query(`INSERT INTO request_billing(request_id,user_id,state,reserved_cny,charged_cny,price_snapshot) VALUES($1,$2,'settled',10,10,'{}')`,[requestId,customer]);
   const a=(await call(alice,path+'/usage')).json();assert.equal(a.rows[0].active_users,'1');assert.equal(a.rows[0].total_tokens,'20');assert.equal(Number(a.rows[0].billed_revenue_cny),10);assert.equal(Number(a.rows[0].accrued_earnings_cny),2.5);assert.equal(a.settlement_enabled,false);
   for(const key of ['user_id','email','cost_cny','confirmed_cost_cny','access_token_id'])assert.equal(a.rows[0][key],undefined);
   assert.equal((await call(bob,path+'/usage?plugin_id='+aPlugin)).json().rows.length,0);
   assert.equal((await call(customer,path+'/usage')).statusCode,403);
   assert.equal((await call(alice,'/api/me/usage?user_id='+customer)).json().rows.length,0);
   const report=(await admin('/plugin-usage?plugin_id='+aPlugin)).json().rows[0];assert.equal(Number(report.confirmed_margin_cny),7);
   assert.equal((await admin('/plugins/'+aPlugin+'/owner',{owner_user_id:bob,revenue_share_bps:5000})).statusCode,200);
   assert.equal(Number((await call(alice,path+'/usage')).json().rows[0].accrued_earnings_cny),2.5);
   assert.equal((await call(bob,path+'/usage')).json().rows.length,0);
   assert.equal((await call(alice,path+'/plugins/'+aPlugin+'/releases')).statusCode,404);
  });
  await t.test('disabled developer loses portal access immediately but retains ordinary account access',async()=>{
   await admin('/developers/'+bob+'/review',{state:'disabled'});
   assert.equal((await call(bob,path+'/plugins')).statusCode,403);
   assert.equal((await call(bob,'/api/me/profile')).statusCode,200);
   assert.equal((await call(bob,path+'/apply',{display_name:'Bypass'})).statusCode,409);
  });
 }finally{await app?.close();await db.close();await setup.query(`DROP SCHEMA ${schema} CASCADE`);await setup.close();}
});
