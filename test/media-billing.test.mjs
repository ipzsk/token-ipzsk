import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {reserveRequest,settleRequest,settleMediaRequest,units} from '../src/billing.mjs';
import {recordTaskCharge} from '../src/task-charges.mjs';

// A minimal in-memory stand-in for the queries these two modules issue; the ledger rules under test are the code's, not the database's.
function fake(credit){
  const state={policy:{enabled:true,multiplier:'1.0000',usd_cny:'7.3000',version:1},billing:new Map(),debits:[],costs:new Map(),credit};
  const held=()=>[...state.billing.values()].filter(b=>['reserved','pending'].includes(b.state)).reduce((n,b)=>n+units(b.reserved_cny),0n);
  const spent=()=>state.debits.reduce((n,d)=>n+units(d.amount_cny),0n);
  const c={query:async(sql,params=[])=>{
    if(sql.includes('FROM billing_policy'))return {rows:[state.policy]};
    if(sql.includes('AS balance_cny')){const b=units(state.credit)-spent();
      return {rows:[{balance_cny:`${b/100000000n}.${String(b%100000000n).padStart(8,'0')}`,available_cny:`${(b-held())/100000000n}.${String((b-held())%100000000n).padStart(8,'0')}`}]};}
    if(sql.includes('FROM users'))return {rows:[{id:params[0]}]};
    if(sql.startsWith('INSERT INTO request_billing')){state.billing.set(params[0],{request_id:params[0],user_id:params[1],state:'reserved',reserved_cny:params[2],price_snapshot:JSON.parse(params[3])});return {rowCount:1};}
    if(sql.includes('FROM request_billing')){const row=state.billing.get(params[0]);return {rows:row?[row]:[],rowCount:row?1:0};}
    if(sql.startsWith('UPDATE request_billing')){
      const row=state.billing.get(params[0]);row.state=/state='(\w+)'/.exec(sql)[1];
      const ref=/reason=\$(\d)/.exec(sql);row.reason=ref?params[ref[1]-1]:/reason='([^']+)'/.exec(sql)?.[1];
      if(sql.includes('charged_cny=$2'))row.charged_cny=params[1];if(sql.includes('charged_cny=0'))row.charged_cny='0';
      return {rowCount:1};}
    if(sql.startsWith('INSERT INTO wallet_debits')){
      if(state.debits.some(d=>d.request_id===params[1]))throw new Error('duplicate key value violates unique constraint "wallet_debits_request_id_key"');
      state.debits.push({request_id:params[1],user_id:params[2],amount_cny:params[3]});return {rowCount:1};}
    if(sql.startsWith('UPDATE requests SET cost_cny')){if(state.costs.has(params[0]))return {rowCount:0};state.costs.set(params[0],params[1]);return {rowCount:1};}
    if(sql.startsWith('INSERT INTO audit_events'))return {rowCount:1};
    // 计提跟着结算走（同一个事务）。这些用例里的请求没有插件归属，
    // 真 SQL 的 WHERE 也会把它们滤掉，所以这里等价地当成空写。
    if(sql.startsWith('INSERT INTO plugin_earnings'))return {rowCount:0};
    throw new Error('unexpected query: '+sql);
  }};
  return {state,db:{tx:fn=>fn(c),query:c.query},c};
}
const reserve=async(f,body,path='/v1/images/generations')=>{const id=randomUUID();await reserveRequest(f.db,id,'user-1',body,path);return id;};

test('per-call and per-second holds follow the frozen snapshot',async()=>{
  const f=fake('100');
  const image=await reserve(f,{model:'gpt-image-2',prompt:'cat',quality:'high'});
  assert.equal(f.state.billing.get(image).reserved_cny,'0.15330000');
  const video=await reserve(f,{model:'seedance-2.0-mini',prompt:'cat',resolution:'720p',duration:8},'/v1/videos/generations');
  const snapshot=f.state.billing.get(video).price_snapshot;
  assert.equal(f.state.billing.get(video).reserved_cny,'1.33619200');
  assert.deepEqual(snapshot,{media:true,policy_version:1,multiplier:'1.0000',usd_cny:'7.3000',model:'seedance-2.0-mini',
    kind:'video',billing_unit:'per_second',base_usd:0.0064,tier:'720p',tier_rate:3.575,duration_sec:8});
  // Editing an image reuses the image price; a later policy change cannot reprice what is already held.
  f.state.policy={...f.state.policy,multiplier:'2.0000',version:2};
  const edit=await reserve(f,{model:'gpt-image-2',prompt:'cat'},'/v1/images/edits');
  assert.equal(f.state.billing.get(edit).reserved_cny,'0.12410000');
});

test('an unaffordable media request is refused before submission',async()=>{
  const f=fake('0.10');
  await assert.rejects(()=>reserve(f,{model:'gpt-image-2',prompt:'cat',quality:'high'}),e=>e.statusCode===402&&e.code==='insufficient_balance');
  assert.equal(f.state.billing.size,0);
});

test('a completed task debits once, however often it is synced',async()=>{
  const f=fake('100');
  const id=await reserve(f,{model:'gpt-image-2',prompt:'cat',quality:'high'});
  const task={id,upstream_task_id:'up-1'},data={id:'up-1',status:'completed',credits_cost:0.4};
  assert.equal(await recordTaskCharge(f.db,task,data),true);
  assert.equal(await recordTaskCharge(f.db,task,data),false);
  await settleMediaRequest(f.c,id,'completed');
  assert.deepEqual(f.state.debits.map(d=>d.amount_cny),['0.15330000']);
  const bill=f.state.billing.get(id);
  assert.equal(bill.state,'settled');assert.equal(bill.charged_cny,'0.15330000');
  assert.equal(f.state.costs.get(id),'0.4');
});

test('a charge above the hold waits for review instead of overcharging',async()=>{
  const f=fake('100');
  const id=await reserve(f,{model:'gpt-image-2',prompt:'cat',quality:'high'});
  f.state.billing.get(id).reserved_cny='0.01000000';
  await settleMediaRequest(f.c,id,'completed');
  assert.equal(f.state.billing.get(id).state,'pending');
  assert.equal(f.state.billing.get(id).reason,'charge_exceeds_hold');
  assert.deepEqual(f.state.debits,[]);
});

test('a failed task releases the hold even without an upstream cost',async()=>{
  const f=fake('100');
  const id=await reserve(f,{model:'seedance-2.0-mini',prompt:'cat',resolution:'480p',duration:5},'/v1/videos/generations');
  assert.equal(await recordTaskCharge(f.db,{id,upstream_task_id:'up-2'},{id:'up-2',status:'failed'}),false);
  await settleMediaRequest(f.c,id,'failed');
  const bill=f.state.billing.get(id);
  assert.equal(bill.state,'released');assert.equal(bill.reason,'media_task_failed');assert.equal(bill.charged_cny,'0');
  await settleMediaRequest(f.c,id,'completed');
  assert.equal(f.state.billing.get(id).state,'released');
  assert.deepEqual(f.state.debits,[]);
});

// --- 三个审查缺陷的回归测试 ---

test('the billed tier comes from the pre-adaptation body, never the renamed upstream one',async()=>{
  const f=fake('100');
  const id=randomUUID();
  // body 是已按上游参数名改写过的：这里模拟上游把 resolution 改叫别的名字，所以它压根没有 resolution。
  // requested 是归一后的内部 body，档位只能从它解析，否则会静默回落到最便宜的 1k。
  await reserveRequest(f.db,id,'user-1',{model:'gpt-image-2',prompt:'cat',size:'16:9',n:1},'/v1/images/generations',
    {model:'gpt-image-2',prompt:'cat',aspect_ratio:'16:9',resolution:'4k'});
  const bill=f.state.billing.get(id);
  assert.equal(bill.price_snapshot.tier,'4k');
  assert.equal(bill.reserved_cny,'0.15330000');
  assert.notEqual(bill.reserved_cny,'0.06205000','静默按 1k 收费就是按错的价扣钱');
});

test('an upstream 4xx releases the hold instead of queueing a human',async()=>{
  const f=fake('100');
  const id=await reserve(f,{model:'gpt-image-2',prompt:'cat',quality:'high'});
  // 内容策略拒绝这类 4xx：上游明确没执行，任务不存在，钱必须自动退。
  await settleRequest(f.c,id,{status:'failed',submitted:true,errorCode:'upstream_http_400'});
  const bill=f.state.billing.get(id);
  assert.equal(bill.state,'released');
  assert.equal(bill.charged_cny,'0');
  assert.equal(f.state.debits.length,0);
});

test('retries exhausted on 429 also release, but a 5xx stays for review',async()=>{
  const f=fake('100');
  const rejected=await reserve(f,{model:'gpt-image-2',prompt:'cat'});
  await settleRequest(f.c,rejected,{status:'failed',submitted:true,errorCode:'upstream_http_429'});
  assert.equal(f.state.billing.get(rejected).state,'released');

  // 5xx 说明请求到过上游，可能已经建了任务：不能自动退，也不能自动扣。
  const unclear=await reserve(f,{model:'gpt-image-2',prompt:'cat'});
  await settleRequest(f.c,unclear,{status:'failed',submitted:true,errorCode:'upstream_http_502'});
  assert.equal(f.state.billing.get(unclear).state,'pending');
  assert.equal(f.state.billing.get(unclear).reason,'media_submit_unverified');

  // 结果不确定（连接中断在提交之后）同样留给人工。
  const uncertain=await reserve(f,{model:'gpt-image-2',prompt:'cat'});
  await settleRequest(f.c,uncertain,{status:'uncertain',submitted:true,errorCode:'upstream_result_uncertain'});
  assert.equal(f.state.billing.get(uncertain).state,'pending');
});

// 上游报 completed 但没有任何图片：不能标成功，更不能扣费。
test('a completed image task without images is released, never charged',async()=>{
  const f=fake('100');
  const id=await reserve(f,{model:'gpt-image-2',prompt:'cat',quality:'high'});
  const task={id,upstream_task_id:'up-empty',kind:'image'},data={id:'up-empty',status:'completed',credits_cost:0.4,result:{images:[]}};
  assert.equal(await recordTaskCharge(f.db,task,data),true);
  assert.deepEqual(f.state.debits,[]);
  const bill=f.state.billing.get(id);
  assert.equal(bill.state,'released');assert.equal(bill.charged_cny,'0');assert.equal(bill.reason,'image_result_missing');
  assert.equal(f.state.costs.get(id),'0.4','the upstream cost is still recorded separately');
});
