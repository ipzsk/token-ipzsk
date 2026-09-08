import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {database} from '../src/database.mjs';
import {createApp} from '../src/app.mjs';
import {passwordHash} from '../src/security.mjs';
import {reserveRequest,settleRequest,wallet} from '../src/billing.mjs';
import {issueKey} from '../src/account-keys.mjs';

test('account-owned keys, roles and atomic wallet charging',async t=>{
  assert.ok(process.env.TEST_DB_HOST);const schema='billing_test_'+randomUUID().replaceAll('-','');
  const config={host:process.env.TEST_DB_HOST,database:'gateway_test',user:'gateway',password:process.env.TEST_DB_PASSWORD};
  const setup=database(config);await setup.query(`CREATE SCHEMA ${schema}`);
  const db=database({...config,options:`-c search_path=${schema}`});let app;const upstream={},scheduler={keys:new Map(),accounts:new Map()};
  try{
    await db.migrate();await db.migrate();
    await db.query('INSERT INTO administrators(id,password_hash) VALUES(1,$1)',[await passwordHash('test-only-administrator')]);
    app=await createApp({db,upstream,scheduler,voucherKey:randomBytes(32),origin:'https://api.ipzsk.com',secureCookies:true});
    const call=(path,body,cookie,method=body?'POST':'GET')=>app.inject({url:'/admin/api'+path,method,payload:body,headers:{origin:'https://api.ipzsk.com',cookie:cookie??''}});
    const cookie=r=>[].concat(r.headers['set-cookie']??[]).map(s=>s.split(';')[0]).join('; ');
    const root=cookie(await call('/login',{password:'test-only-administrator'}));
    const user=randomUUID(),other=randomUUID();await db.query('INSERT INTO users(id,name) VALUES($1,$2),($3,$4)',[user,'Alice',other,'Bob']);
    let k1,k2;
    await t.test('multiple keys coexist, revocation is isolated and expired keys fail',async()=>{
      k1=await db.tx(c=>issueKey(c,user,{name:'Desktop'}));k2=await db.tx(c=>issueKey(c,user,{name:'Laptop',rpm:1}));
      const get=key=>app.inject({url:'/api/me/profile',headers:{authorization:'Bearer '+key.token}});
      assert.equal((await get(k1)).statusCode,200);assert.equal((await get(k2)).statusCode,200);
      assert.equal((await call('/users/'+other+'/tokens/'+k1.id+'/revoke',{},root)).statusCode,404);
      assert.equal((await call('/users/'+user+'/tokens/'+k1.id+'/revoke',{},root)).statusCode,200);
      assert.equal((await get(k1)).statusCode,401);assert.equal((await get(k2)).statusCode,200);
      await db.query("UPDATE access_tokens SET expires_at=now()-interval '1 second' WHERE id=$1",[k2.id]);assert.equal((await get(k2)).statusCode,401);
    });
    await t.test('independent administrators obey role restrictions',async()=>{
      for(const role of ['operator','viewer']){
        assert.equal((await call('/administrators',{username:role,password:'test-only-role-password',role},root)).statusCode,200);
        const c=cookie(await call('/login',{username:role,password:'test-only-role-password'}));
        assert.equal((await call('/users',undefined,c)).statusCode,200);
        assert.equal((await call('/billing/policy',{enabled:true,multiplier:'1'},c)).statusCode,403);
        assert.equal((await call('/administrators',undefined,c)).statusCode,403);
        assert.equal((await call('/users',{name:'Role user'},c)).statusCode,role==='viewer'?403:200);
      }
    });
    // Credit via the production voucher flow, preserving ledger constraints.
    const batch=randomUUID();await call('/vouchers/batches',{id:batch,name:'Billing tests',amount_cny:10,quantity:1},root);
    const exported=await call('/vouchers/batches/'+batch+'/export',{format:'txt'},root);await call('/vouchers/batches/'+batch+'/assign',{channel:'test'},root);
    const active=await db.tx(c=>issueKey(c,user));
    const redeemed=await app.inject({url:'/api/me/vouchers/redeem',method:'POST',payload:{code:exported.body.trim()},headers:{authorization:'Bearer '+active.token}});assert.equal(redeemed.statusCode,200);
    const body={model:'gpt-5.6-sol',messages:[{role:'user',content:'hello'}],max_tokens:10};
    const request=async()=>{const id=randomUUID();await db.query('INSERT INTO requests(id,user_id,model,fingerprint,stream,access_token_id) VALUES($1,$2,$3,$4,false,$5)',[id,user,body.model,id,active.id]);return id;};
    const settle=(id,data)=>db.tx(c=>settleRequest(c,id,data));
    await t.test('disabled charging records no reservation or debit',async()=>{const id=await request();await reserveRequest(db,id,user,body,'/v1/chat/completions');assert.equal((await db.query('SELECT * FROM request_billing WHERE request_id=$1',[id])).rowCount,0);});
    await db.query('UPDATE billing_policy SET enabled=true');
    await t.test('settlement is idempotent, releases unused budget and preserves price snapshots',async()=>{
      const id=await request();await reserveRequest(db,id,user,body,'/v1/chat/completions');
      assert.ok(Number((await wallet(db,user)).frozen_cny)>0);
      await db.query('UPDATE billing_policy SET multiplier=2,version=2');
      await Promise.all([settle(id,{status:'succeeded',submitted:true,usage:{input:9,output:4,cached_input:0,cache_write:0}}),settle(id,{status:'succeeded',submitted:true,usage:{input:9,output:4,cached_input:0,cache_write:0}})]);
      const d=(await db.query('SELECT * FROM wallet_debits WHERE request_id=$1',[id])).rows;assert.equal(d.length,1);assert.equal(d[0].amount_cny,'0.00092800');assert.equal(Number((await wallet(db,user)).frozen_cny),0);
    });
    await t.test('uncertain usage stays held; confirmed non-execution releases; manual resolution is one-time',async()=>{
      const id=await request();await reserveRequest(db,id,user,body,'/v1/chat/completions');await settle(id,{status:'uncertain',submitted:true});
      assert.equal((await db.query('SELECT state FROM request_billing WHERE request_id=$1',[id])).rows[0].state,'pending');
      assert.equal((await call('/billing/'+id+'/resolve',{amount_cny:'0',reason:'Verified request did not execute'},root)).statusCode,200);
      assert.equal((await call('/billing/'+id+'/resolve',{amount_cny:'0',reason:'Repeated request'},root)).statusCode,409);
      const released=await request();await reserveRequest(db,released,user,body,'/v1/chat/completions');await settle(released,{status:'failed',submitted:false});assert.equal(Number((await wallet(db,user)).frozen_cny),0);
    });
    await t.test('parallel holds cannot overdraw wallet and unsupported media never reserves',async()=>{
      const ids=await Promise.all(Array.from({length:15},request));
      const results=await Promise.allSettled(ids.map(id=>reserveRequest(db,id,user,{...body,max_tokens:10000},'/v1/chat/completions')));
      assert.ok(results.some(r=>r.status==='rejected'&&r.reason.statusCode===402));assert.ok(results.some(r=>r.status==='fulfilled'));assert.ok(Number((await wallet(db,user)).available_cny)>=0);
      await assert.rejects(reserveRequest(db,await request(),user,body,'/v1/images/generations'),e=>e.statusCode===400);
      const otherBalance=await wallet(db,other);assert.equal(Number(otherBalance.balance_cny),0);
    });
    await t.test('public gateway attributes a key, charges once and rejects unfunded calls before upstream',async()=>{
      await db.query("UPDATE request_billing SET state='released' WHERE state='reserved'");
      const account=randomUUID(),key=randomUUID();
      await db.query('INSERT INTO upstream_accounts(id,name) VALUES($1,$2)',[account,'Mock']);
      await db.query('INSERT INTO upstream_keys(id,account_id,name,fingerprint,suffix,secret_ref) VALUES($1,$2,$3,$4,$5,$6)',[key,account,'Mock','mock','fixture','fixture']);
      let calls=0;
      scheduler.acquire=async()=>({row:{id:key,secret_ref:'fixture'},release(){}});
      Object.assign(upstream,{candidates(){return[];},refreshSoon(){},async request(){calls++;return Response.json({id:'mock',choices:[{message:{role:'assistant',content:'OK'}}],usage:{prompt_tokens:9,completion_tokens:4,total_tokens:13,prompt_tokens_details:{cached_tokens:0,cache_write_tokens:0}}});}});
      const ask=(credential,idempotency)=>app.inject({url:'/v1/chat/completions',method:'POST',payload:body,headers:{authorization:'Bearer '+credential.token,'idempotency-key':idempotency}});
      const r=await ask(active,'one-charge');assert.equal(r.statusCode,200,r.body);
      const id=r.headers['x-request-id'];assert.equal((await db.query('SELECT access_token_id FROM requests WHERE id=$1',[id])).rows[0].access_token_id,active.id);
      assert.equal((await db.query('SELECT amount_cny FROM wallet_debits WHERE request_id=$1',[id])).rows[0].amount_cny,'0.00185600');
      assert.equal((await ask(active,'one-charge')).statusCode,409);assert.equal(calls,1);
      const unfunded=await db.tx(c=>issueKey(c,other));assert.equal((await ask(unfunded,'empty-wallet')).statusCode,402);assert.equal(calls,1);
    });
    await t.test('daily reporting and ledger expose customer fees separately',async()=>{
      const result=await call('/users/daily',undefined,root);assert.equal(result.statusCode,200,result.body);
      assert.equal((await call('/ledger',undefined,root)).json().rows.some(r=>r.kind==='consumption'),true);
    });
  }finally{await app?.close();await db.close();await setup.query(`DROP SCHEMA ${schema} CASCADE`);await setup.close();}
});
