import { syncMediaTasks } from '../src/media-task-sync.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { database } from '../src/database.mjs';
import { createApp } from '../src/app.mjs';
import { Upstream } from '../src/upstream.mjs';
import { Scheduler } from '../src/scheduler.mjs';
import { passwordHash } from '../src/security.mjs';
import { recordTaskCharge } from '../src/task-charges.mjs';

test('gateway integration against an isolated PostgreSQL test schema', async (t) => {
  assert.ok(process.env.TEST_DB_HOST,'Set TEST_DB_HOST explicitly; tests only use gateway_test database.');
  const schema='test_'+randomUUID().replaceAll('-','');
  const config={host:process.env.TEST_DB_HOST,port:Number(process.env.TEST_DB_PORT??5432),
    database:'gateway_test',user:process.env.TEST_DB_USER??'gateway',password:process.env.TEST_DB_PASSWORD};
  const setup=database(config);
  assert.equal((await setup.query('SELECT current_database() AS name')).rows[0].name,'gateway_test');
  await setup.query(`CREATE SCHEMA ${schema}`);
  const db=database({...config,options:`-c search_path=${schema}`});
  const dir=await mkdtemp(join(tmpdir(),'ipzsk-test-'));
  let calls=0,accountBalanceCalls=0,mode='normal',lastMedia;
  const usage={prompt_tokens:12,completion_tokens:8,total_tokens:20};
  const mock=async(url,options)=>{
    if(url.endsWith('/v1/user/balance')){accountBalanceCalls++;return Response.json({success:true,remain_balance:9,used_balance:1,remain_credits:90.60152,used_credits:9.39848});}
    if(url.endsWith('/v1/balance'))return Response.json({success:true,remain_balance:-1,used_balance:1,remain_credits:-1,used_credits:9.39848,unlimited_quota:true});
    if(url.endsWith('/v1/audio/transcriptions')){
      calls++;
      const form=await new Request(url,{method:'POST',headers:options.headers,body:options.body}).formData();
      assert.equal(await form.get('file').text(),'synthetic-audio');
      assert.equal(form.get('model'),'test-model');
      return form.get('response_format')==='srt'?new Response('1\n00:00:00,000 --> 00:00:01,000\nHello\n'):Response.json({text:'Hello'});
    }
    if(url.endsWith('/v1/images/generations')||url.endsWith('/v1/videos/generations')) {
      calls++;
      assert.equal(JSON.parse(options.body).stream,undefined);lastMedia={body:JSON.parse(options.body),type:options.headers['Content-Type']};
      return Response.json({code:200,data:[{status:'submitted',task_id:'task_upstream_fixture'}]});
    }
    if(url.endsWith('/v1/tasks/task_upstream_fixture'))return Response.json({code:200,data:{id:'task_upstream_fixture',status:'completed',progress:100,credits_cost:0.5,result:{images:[{url:['https://cdn.example/image.png']}]}}});
    if(url.endsWith('/v1/responses')||url.endsWith('/v1/messages')) {
      calls++;
      const payload=JSON.parse(options.body);
      const anthropic=url.endsWith('/v1/messages');
      assert.equal(payload.stream_options,undefined);
      if(anthropic)assert.equal(options.headers['anthropic-version'],'2023-06-01');
      const response=anthropic ? {id:'msg_native',type:'message',role:'assistant',content:[{type:'tool_use',id:'tool_native',name:'read_file',input:{path:'note.md'}}],stop_reason:'tool_use',usage:{input_tokens:12,output_tokens:8}} :
        {id:'resp_native',object:'response',status:'completed',output:[{type:'function_call',call_id:'call_native',name:'read_file',arguments:'{"path":"note.md"}'}],usage:{input_tokens:12,output_tokens:8,total_tokens:20}};
      if(!payload.stream)return Response.json(response);
      const events=anthropic ? [{type:'message_start',message:{...response,usage:{input_tokens:12,output_tokens:0}}},{type:'message_delta',usage:{output_tokens:8}},{type:'message_stop'}] : [{type:'response.completed',response}];
      return new Response(events.map(value=>'data: '+JSON.stringify(value)+'\n\n').join(''),{headers:{'Content-Type':'text/event-stream'}});
    }
    assert.equal(url,'https://api.apimart.ai/v1/chat/completions');
    calls++;
    if(mode==='429')return Response.json({error:'limited'},{status:429,headers:{'Retry-After':'10'}});
    if(mode==='402')return Response.json({error:'insufficient'},{status:402});
    if(mode==='401')return Response.json({error:'bad key'},{status:401});
    if(mode==='timeout')throw new Error('network_failed');
    if(mode==='slow_stream')return new Response(new ReadableStream({start(c){
      c.enqueue(Buffer.from('data: {"choices":[{"delta":{"content":"first"}}]}\n\n'));
      options.signal.addEventListener('abort',()=>c.error(new Error('aborted')),{once:true});
    }}),{headers:{'Content-Type':'text/event-stream'}});
    const payload=JSON.parse(options.body);
    const responseUsage=mode==='priced'?{prompt_tokens:10000,completion_tokens:2000,total_tokens:12000,prompt_tokens_details:{cached_tokens:6000,cache_write_tokens:1000}}:usage;
    if(payload.stream){
      assert.equal(payload.stream_options.include_usage,true);
      const data='data: '+JSON.stringify({id:'stream-1',choices:[{delta:{content:'你好'}}]})+'\n\n'+
        (mode==='missing_usage'?'':'data: '+JSON.stringify({usage:responseUsage})+'\n\ndata: '+JSON.stringify({usage:responseUsage})+'\n\n')+
        (mode==='truncated'?'':'data: [DONE]\n\n');
      const bytes=Buffer.from(data);let i=0;
      return new Response(new ReadableStream({pull(c){if(i>=bytes.length)c.close();else c.enqueue(bytes.subarray(i,i+=3));}}),{headers:{'Content-Type':'text/event-stream'}});
    }
    return Response.json({id:'completion-1',object:'chat.completion',choices:[{message:{role:'assistant',content:'ok'}}],usage:responseUsage});
  };
  const upstream=new Upstream(db,dir,mock);
  let app;
  const scheduler=new Scheduler({waitMs:10});
  try{
    await db.migrate();
    await db.query('INSERT INTO administrators(id,password_hash) VALUES (1,$1)',[await passwordHash('test-administrator-password')]);
    app=await createApp({db,upstream,scheduler,origin:'https://api.ipzsk.com',secureCookies:true});
    let cookie='',account,keyId,alice,bob;
    const admin=(path,method='GET',payload)=>app.inject({url:'/admin/api'+path,method,payload,headers:{cookie,origin:'https://api.ipzsk.com'}});
    const ask=(who,body={},extra={})=>app.inject({url:'/v1/chat/completions',method:'POST',payload:{model:'test-model',messages:[{role:'user',content:'hello'}],...body},headers:{authorization:'Bearer '+who.token,...extra}});
    // 官网靠这些路由活着。2026-09-13 一次覆盖部署把它们整批弄丢（那份代码从没进过 git），
    // 症状只有页面上一句「云端暂时未连接」。钉住路由表：少一条就红，不用等用户报。
    await t.test('web (official site) routes stay registered',async()=>{
      for(const [method,url] of [['GET','/api/me/workspace'],['POST','/api/me/workspace'],['GET','/api/me/workspace/models'],['POST','/api/me/workspace/quote'],
        ['POST','/api/me/workspace/chat'],['POST','/api/me/chat/completions'],['POST','/api/me/image-prompt'],['POST','/api/me/images/generations'],
        ['GET','/api/me/tasks/:id'],['GET','/api/me/tasks/:id/image/:index'],['GET','/api/me/images'],['POST','/api/me/message-billing'],['GET','/api/me/requests/:id'],['GET','/api/me/wallet']]){
        assert.ok(app.hasRoute({method,url}),`官网路由不见了: ${method} ${url}`);
      }
    });
    await t.test('admin requires authentication and same-origin mutations',async()=>{
      assert.equal((await app.inject('/admin/api/keys')).statusCode,401);
      assert.equal((await app.inject({url:'/admin/api/login',method:'POST',payload:{password:'test-administrator-password'}})).statusCode,403);
      const login=await admin('/login','POST',{password:'test-administrator-password'});
      assert.equal(login.statusCode,200,login.body);
      cookie=login.headers['set-cookie'].split(';')[0];
      assert.match(login.headers['set-cookie'],/HttpOnly/);
      assert.equal((await admin('/session')).statusCode,200);
    });
    await t.test('pool stores secrets outside returned metadata and groups balances',async()=>{
      const a=await admin('/accounts','POST',{name:'Test account',concurrency:1});assert.equal(a.statusCode,200,a.body);account=a.json().id;
      for(const n of ['one','two']){
        const k=await admin('/keys','POST',{account_id:account,name:n,key:'sk-test-only-not-real-credential-'+n,models:['test-model','gpt-image-2','seedance-2.0-mini'],concurrency:1});
        assert.equal(k.statusCode,200,k.body);keyId=k.json().id;
      }
      upstream.close();await upstream.refresh();
      assert.equal(accountBalanceCalls,1);
      const rows=(await admin('/keys')).json().rows;assert.equal(rows.length,2);
      assert.ok(!JSON.stringify(rows).includes('sk-test'));assert.ok(!JSON.stringify(rows).includes('secret_ref'));
      assert.equal((await stat(join(dir,keyId+'.key'))).mode&0o777,0o600);
      assert.equal((await admin('/overview')).json().accounts.balance,'9');
      assert.equal((await admin('/overview')).json().accounts.remain_credits,'90.60152');
      assert.equal(rows[0].remain_credits,'-1');
      assert.equal(rows[0].used_credits,'9.39848');
      const snapshot=(await db.query('SELECT balance,remain_credits,used_credits FROM balance_snapshots WHERE key_id IS NULL')).rows[0];
      assert.deepEqual(snapshot,{balance:'9',remain_credits:'90.60152',used_credits:'9.39848'});
      await db.migrate();
      assert.equal((await admin('/overview')).json().accounts.remain_credits,'90.60152');
      const duplicate=await admin('/keys','POST',{account_id:account,name:'dup',key:'sk-test-only-not-real-credential-two',models:['test-model']});
      assert.equal(duplicate.statusCode,409);
    });
    await t.test('user attribution uses authenticated token and isolates records',async()=>{
      alice=(await admin('/users','POST',{name:'Alice',rpm:50})).json();
      bob=(await admin('/users','POST',{name:'Bob',rpm:50})).json();
      const r=await ask(alice,{user:bob.id});assert.equal(r.statusCode,200,r.body);
      const data=(await admin('/requests')).json().rows[0];assert.equal(data.user_id,alice.id);assert.equal(data.total_tokens,'20');
      const own=await app.inject({url:'/api/me/usage?user_id='+alice.id,headers:{authorization:'Bearer '+bob.token}});
      assert.equal(own.json().count,0);
      assert.equal((await app.inject({url:'/v1/models'})).statusCode,401);
    });
    await t.test('confirmed charges preserve precision, reject invalid input and audit corrections',async()=>{
      const row=(await admin('/requests')).json().rows[0];assert.equal(row.cost_cny,null);
      const url='/requests/'+row.id+'/charge';
      assert.equal((await app.inject({url:'/admin/api'+url,method:'PATCH',payload:{cost_cny:'0.1',cost_reference:'bill'}})).statusCode,403);
      assert.equal((await admin(url,'PATCH',{cost_cny:'-1',cost_reference:'bill'})).statusCode,400);
      assert.equal((await admin(url,'PATCH',{cost_cny:'0.00004'})).statusCode,400);
      assert.equal((await admin(url,'PATCH',{cost_cny:'0.000000001',cost_reference:'bill'})).statusCode,400);
      assert.equal((await admin(url,'PATCH',{cost_cny:'0.00004',cost_reference:'APIMart test bill 1'})).statusCode,200);
      let saved=(await admin('/requests/'+row.id)).json().request;
      assert.equal(saved.cost_cny,'0.00004');assert.ok(saved.cost_recorded_at);
      assert.equal((await admin(url,'PATCH',{cost_cny:'0.00003',cost_reference:'APIMart corrected bill 1'})).statusCode,200);
      const events=(await db.query('SELECT details FROM audit_events WHERE target_id=$1 AND action=$2 ORDER BY id',[row.id,'request.charge.confirm'])).rows;
      assert.equal(events.length,2);assert.equal(events[1].details.previous.cost_cny,'0.00004');assert.equal(events[1].details.next.cost_cny,'0.00003');
      const csv=await admin('/requests/export');assert.match(csv.body,/cost_cny/);assert.match(csv.body,/0\.00003/);
      const rejected=await ask(alice,{model:'not-enabled'});
      assert.equal((await admin('/requests/'+rejected.headers['x-request-id']+'/charge','PATCH',{cost_cny:'1',cost_reference:'bill'})).statusCode,409);
    });
    await t.test('idempotency prevents duplicate upstream calls and detects changed payloads',async()=>{
      const before=calls;
      assert.equal((await ask(alice,{}, {'idempotency-key':'once'})).statusCode,200);
      assert.equal((await ask(alice,{}, {'idempotency-key':'once'})).statusCode,409);
      const r=await ask(alice,{temperature:0.2},{'idempotency-key':'once'});assert.equal(r.json().error.code,'idempotency_conflict');
      assert.equal(calls,before+1);
    });
    await t.test('native agent protocols preserve tools, streams, authentication and accounting',async()=>{
      for(const path of ['/v1/responses','/v1/messages'])for(const stream of [false,true]) {
        const anthropic=path.endsWith('messages');
        const payload=anthropic?{model:'test-model',max_tokens:8192,messages:[{role:'user',content:'Read note.md'}],stream}:
          {model:'test-model',input:'Read note.md',store:false,stream};
        const headers=anthropic?{'x-api-key':alice.token,'anthropic-version':'2023-06-01'}:{authorization:'Bearer '+alice.token};
        const r=await app.inject({url:path,method:'POST',payload,headers});
        assert.equal(r.statusCode,200,r.body);
        assert.match(r.body,anthropic?/msg_native/:/resp_native/);
        const saved=(await db.query('SELECT user_id,total_tokens,status FROM requests WHERE id=$1',[r.headers['x-request-id']])).rows[0];
        assert.deepEqual(saved,{user_id:alice.id,total_tokens:'20',status:'succeeded'});
      }
      assert.equal((await app.inject({url:'/v1/messages',method:'POST',payload:{},headers:{'x-api-key':'sk-not-platform'}})).statusCode,401);
      assert.equal((await app.inject({url:'/v1/responses',method:'POST',headers:{authorization:'Bearer '+alice.token},payload:{model:'test-model',input:'hello',previous_response_id:'other-user'}})).statusCode,400);
    });
    await t.test('audio accepts authenticated multipart uploads and preserves JSON and subtitle formats',async()=>{
      for(const format of ['json','srt']){
        const form=new FormData();form.set('model','test-model');form.set('response_format',format);
        form.set('file',new Blob(['synthetic-audio'],{type:'audio/wav'}),'test.wav');
        const request=new Request('https://fixture.invalid',{method:'POST',body:form});
        const headers={'content-type':request.headers.get('content-type'),authorization:'Bearer '+alice.token};
        const payload=Buffer.from(await request.arrayBuffer());
        const response=await app.inject({method:'POST',url:'/v1/audio/transcriptions',headers,payload});
        assert.equal(response.statusCode,200,response.body);
        if(format==='json')assert.equal(response.json().text,'Hello');else assert.match(response.body,/00:00:00,000/);
        const row=(await db.query('SELECT status,usage_state FROM requests WHERE id=$1',[response.headers['x-request-id']])).rows[0];
        assert.deepEqual(row,{status:'succeeded',usage_state:'unknown'});
        assert.equal((await app.inject({method:'POST',url:'/v1/audio/transcriptions',headers:{'content-type':headers['content-type']},payload})).statusCode,401);
      }
    });
    await t.test('image edit uploads reach upstream as JSON references and retain task isolation',async()=>{
      const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE9sAAAAASUVORK5CYII=','base64');
      for(const path of ['/v1/images/edits','/v1/images/generations']){
        const form=new FormData();form.set('model','gpt-image-2');form.set('prompt','Product selling points');
        form.append('image[]',new Blob([png],{type:'image/png'}),'product.png');form.append('image[]',new Blob([png],{type:'image/png'}),'detail.png');
        const wire=new Request('https://test.invalid',{method:'POST',body:form}),payload=Buffer.from(await wire.arrayBuffer());
        const headers={authorization:'Bearer '+alice.token,'content-type':wire.headers.get('content-type')};
        const result=await app.inject({method:'POST',url:path,headers,payload});assert.equal(result.statusCode,200,result.body);
        assert.equal(lastMedia.type,'application/json');assert.equal(lastMedia.body.image_urls.length,2);assert.equal(lastMedia.body.image_urls[0],'data:image/png;base64,'+png.toString('base64'));
        const id=result.json().data[0].task_id;assert.notEqual(id,'task_upstream_fixture');
        assert.equal((await app.inject({url:'/v1/tasks/'+id,headers:{authorization:'Bearer '+bob.token}})).statusCode,404);
        assert.equal((await db.query('SELECT user_id FROM requests WHERE id=$1',[id])).rows[0].user_id,alice.id);
        const completed=await app.inject({url:'/v1/tasks/'+id,headers:{authorization:'Bearer '+alice.token}});assert.equal(completed.statusCode,200);assert.equal(completed.json().data.status,'completed');
        assert.equal((await app.inject({method:'POST',url:path,headers:{'content-type':headers['content-type']},payload})).statusCode,401);
      }
    });
    await t.test('background worker finishes tasks without a client and stops polling completed tasks',async()=>{
      const headers={authorization:'Bearer '+alice.token};
      const submitted=await app.inject({url:'/v1/images/generations',method:'POST',headers,payload:{model:'gpt-image-2',prompt:'worker fixture'}});
      const id=submitted.json().data[0].task_id;
      await db.query("UPDATE media_tasks SET updated_at=now()-interval '1 minute' WHERE id=$1",[id]);
      await syncMediaTasks(db,upstream);
      const saved=(await db.query('SELECT status,result,updated_at FROM media_tasks WHERE id=$1',[id])).rows[0];
      assert.equal(saved.status,'completed');assert.ok(saved.result.result.images.length);
      await syncMediaTasks(db,upstream);
      assert.equal((await db.query('SELECT updated_at FROM media_tasks WHERE id=$1',[id])).rows[0].updated_at.toISOString(),saved.updated_at.toISOString());
    });
    await t.test('media task IDs are platform-owned and cannot be polled by another user',async()=>{
      const headers={authorization:'Bearer '+alice.token};
      const submitted=await app.inject({url:'/v1/images/generations',method:'POST',headers,payload:{model:'gpt-image-2',prompt:'A mountain',image_urls:['data:image/png;base64,fixture']}});
      assert.equal(submitted.statusCode,200,submitted.body);
      const id=submitted.json().data[0].task_id;
      assert.notEqual(id,'task_upstream_fixture');
      assert.equal((await app.inject({url:'/v1/tasks/'+id,headers:{authorization:'Bearer '+bob.token}})).statusCode,404);
      assert.equal((await app.inject({url:'/v1/tasks/'+id})).statusCode,401);
      const result=await app.inject({url:'/v1/tasks/'+id,headers});
      assert.equal(result.statusCode,200,result.body);
      assert.equal(result.json().data.id,id);
      assert.equal(result.json().data.status,'completed');
      assert.equal(result.json().data.credits_cost,undefined);
      assert.ok(result.json().data.result.images[0].url[0].endsWith(`/v1/tasks/${id}/image/0`));
      assert.equal((await app.inject({url:'/v1/tasks/'+id,headers})).json().data.status,'completed');
      const charge=(await db.query('SELECT cost_cny,cost_reference FROM requests WHERE id=$1',[id])).rows[0];
      assert.equal(charge.cost_cny,'0.5');
      assert.equal(charge.cost_reference,'apimart:task:task_upstream_fixture:credits_cost');
      assert.equal((await db.query("SELECT count(*) FROM audit_events WHERE action='request.cost.sync' AND target_id=$1",[id])).rows[0].count,'1');
    });
    await t.test('background task billing records without user polling, validates final charges and preserves manual amounts',async()=>{
      const headers={authorization:'Bearer '+alice.token};
      const submitted=await app.inject({url:'/v1/videos/generations',method:'POST',headers,payload:{model:'seedance-2.0-mini',prompt:'A mountain',resolution:'480p',duration:5}});
      const id=submitted.json().data[0].task_id;
      const task={id,upstream_task_id:'task_upstream_fixture'};
      for(const data of [
        {id:task.upstream_task_id,status:'processing',credits_cost:0.8},
        {id:'different_task',status:'completed',credits_cost:0.8},
        {id:task.upstream_task_id,status:'completed',cost:0.8},
        ...[-1,NaN,Infinity,null,'0.8'].map(credits_cost=>({id:task.upstream_task_id,status:'completed',credits_cost})),
      ]) assert.equal(await recordTaskCharge(db,task,data),false);
      assert.equal((await db.query('SELECT cost_cny FROM requests WHERE id=$1',[id])).rows[0].cost_cny,null);
      assert.equal((await upstream.syncTaskCharges()).recorded,1);
      assert.equal((await db.query('SELECT cost_cny FROM requests WHERE id=$1',[id])).rows[0].cost_cny,'0.5');
      assert.equal((await upstream.syncTaskCharges()).recorded,0);
      await db.query('UPDATE requests SET cost_cny=NULL WHERE id=$1',[id]);
      const results=await Promise.all([recordTaskCharge(db,task,{id:task.upstream_task_id,status:'completed',credits_cost:0}),recordTaskCharge(db,task,{id:task.upstream_task_id,status:'completed',credits_cost:0})]);
      assert.equal(results.filter(Boolean).length,1);
      assert.equal((await db.query('SELECT cost_cny FROM requests WHERE id=$1',[id])).rows[0].cost_cny,'0');
      await db.query("UPDATE requests SET cost_cny=1.25,cost_reference='manual' WHERE id=$1",[id]);
      assert.equal(await recordTaskCharge(db,task,{id:task.upstream_task_id,status:'completed',credits_cost:0.5}),false);
      assert.equal((await db.query('SELECT cost_cny FROM requests WHERE id=$1',[id])).rows[0].cost_cny,'1.25');
    });
    await t.test('JSON and SSE automatically persist reproducible price estimates separately from actual charges',async()=>{
      await db.query("UPDATE upstream_keys SET models=array_append(models,'gpt-5.6-sol')");
      mode='priced';
      for(const stream of [false,true]) {
        const r=await ask(alice,{model:'gpt-5.6-sol',stream});assert.equal(r.statusCode,200,r.body);
        const id=r.headers['x-request-id'];
        const row=(await db.query('SELECT cost_cny,estimated_cost_cny,pricing_details FROM requests WHERE id=$1',[id])).rows[0];
        assert.equal(row.cost_cny,null);assert.equal(row.estimated_cost_cny,'0.47520000');
        assert.equal(row.pricing_details.counts.input,3000);
        assert.equal(row.pricing_details.rates.cached_input,'3.2');
        const detail=await admin('/requests/'+id);assert.equal(detail.json().request.estimated_cost_cny,'0.47520000');
        await admin('/requests/'+id+'/charge','PATCH',{cost_cny:'0.40',cost_reference:'actual test bill'});
        const updated=(await db.query('SELECT cost_cny,estimated_cost_cny FROM requests WHERE id=$1',[id])).rows[0];
        assert.equal(updated.cost_cny,'0.40');assert.equal(updated.estimated_cost_cny,'0.47520000');
      }
      mode='normal';
      const exported=await admin('/requests/export');assert.match(exported.body,/estimated_cost_cny/);assert.match(exported.body,/apimart-gpt-2026-09-06-v1/);
    });
    await t.test('stream records cumulative usage once and preserves unknown usage',async()=>{
      const r=await ask(alice,{stream:true});assert.equal(r.statusCode,200,r.body);assert.ok(r.body.includes('[DONE]'));
      let record=(await db.query('SELECT * FROM requests WHERE id=$1',[r.headers['x-request-id']])).rows[0];assert.equal(record.total_tokens,'20');assert.equal(record.status,'succeeded');
      mode='missing_usage';const missing=await ask(alice,{stream:true});
      record=(await db.query('SELECT * FROM requests WHERE id=$1',[missing.headers['x-request-id']])).rows[0];assert.equal(record.total_tokens,null);assert.equal(record.usage_state,'unknown');
      mode='truncated';const truncated=await ask(alice,{stream:true});
      record=(await db.query('SELECT * FROM requests WHERE id=$1',[truncated.headers['x-request-id']])).rows[0];assert.equal(record.status,'uncertain');
      mode='normal';
    });
    await t.test('invalid models and queue rejections never call the upstream',async()=>{
      const before=calls;const r=await ask(alice,{model:'not-enabled'});assert.equal(r.statusCode,503,r.body);assert.equal(calls,before);
      assert.equal((await db.query('SELECT usage_state FROM requests WHERE id=$1',[r.headers['x-request-id']])).rows[0].usage_state,'not_executed');
    });
    await t.test('429 cools the entire account, and 402 blocks until successful sync',async()=>{
      mode='429';assert.equal((await ask(alice)).statusCode,429);
      assert.equal((await db.query('SELECT count(*) FROM upstream_keys WHERE cooldown_until>now()')).rows[0].count,'2');
      await db.query('UPDATE upstream_keys SET cooldown_until=NULL');
      mode='402';assert.equal((await ask(alice)).statusCode,502);
      assert.equal((await db.query('SELECT blocked FROM upstream_accounts WHERE id=$1',[account])).rows[0].blocked,true);
      mode='normal';await upstream.refresh();assert.equal((await db.query('SELECT blocked FROM upstream_accounts WHERE id=$1',[account])).rows[0].blocked,false);
    });
    await t.test('ambiguous failures are recorded and never retried automatically',async()=>{
      mode='timeout';const before=calls;const r=await ask(alice);assert.equal(r.statusCode,502,r.body);assert.equal(calls,before+1);
      assert.equal((await db.query('SELECT status FROM requests WHERE id=$1',[r.headers['x-request-id']])).rows[0].status,'uncertain');mode='normal';
    });
    await t.test('issuing an additional user token preserves previous access',async()=>{
      const r=await admin('/users/'+bob.id+'/token','POST',{});assert.equal(r.statusCode,200,r.body);
      assert.equal((await ask(bob)).statusCode,200);bob.token=r.json().token;assert.equal((await ask(bob)).statusCode,200);
    });
    await t.test('client disconnect releases the channel and records uncertain usage',async()=>{
      mode='slow_stream';
      const address=await app.listen({host:'127.0.0.1',port:0});
      const controller=new AbortController();
      const response=await fetch(address+'/v1/chat/completions',{method:'POST',signal:controller.signal,
        headers:{authorization:'Bearer '+alice.token,'content-type':'application/json'},
        body:JSON.stringify({model:'test-model',messages:[{role:'user',content:'hello'}],stream:true})});
      assert.equal(response.status,200);
      const reader=response.body.getReader();await reader.read();controller.abort();
      const id=response.headers.get('x-request-id');
      let record;
      for(let i=0;i<40;i++){
        record=(await db.query('SELECT * FROM requests WHERE id=$1',[id])).rows[0];
        if(record.completed_at)break;
        await new Promise((resolve)=>setTimeout(resolve,50));
      }
      assert.equal(record.status,'uncertain');assert.equal(record.total_tokens,null);
      assert.equal(scheduler.accounts.size,0);mode='normal';
    });
    await t.test('process recovery preserves uncertain work instead of replaying it',async()=>{
      await db.query(`INSERT INTO requests(id,user_id,model,fingerprint,stream,status) VALUES ($1,$2,'test-model','x',false,'running')`,[randomUUID(),alice.id]);
      const before=calls;await db.recover();assert.equal(calls,before);
      assert.equal((await db.query("SELECT count(*) FROM requests WHERE status='running'")).rows[0].count,'0');
      assert.ok((await db.query("SELECT id FROM requests WHERE error_code='process_restarted'")).rowCount);
    });
  }finally{
    upstream.close();await app?.close();await upstream.pending?.catch(()=>{});await db.close();
    await setup.query(`DROP SCHEMA ${schema} CASCADE`);await setup.close();await rm(dir,{recursive:true,force:true});
  }
});
