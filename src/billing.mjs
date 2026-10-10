import { randomUUID } from 'node:crypto';
import { httpError } from './security.mjs';
import { prices, estimateTextCost } from './text-pricing.mjs';
import { mediaPricing, resolveTier } from './model-catalog.mjs';
import { accrueEarning } from './earnings.mjs';

export const units=value=>{const raw=String(value),negative=raw.startsWith('-');const [a,b='']=(negative?raw.slice(1):raw).split('.');return (negative?-1n:1n)*(BigInt(a)*100000000n+BigInt(b.padEnd(8,'0').slice(0,8)));};
export const decimal=value=>{const negative=value<0n,absolute=negative?-value:value;return `${negative?'-':''}${absolute/100000000n}.${String(absolute%100000000n).padStart(8,'0')}`;};
const multiply=(amount,multiplier)=>decimal((units(amount)*units(multiplier)+50000000n)/100000000n);
const mediaPaths=['/v1/images/generations','/v1/images/edits','/v1/videos/generations'];
// The snapshot alone determines the charge: a later catalog, rate or multiplier change cannot reprice a held request.
export const mediaAmount=s=>{
  let usd=multiply(s.base_usd,s.tier_rate);
  if(s.billing_unit==='per_second')usd=multiply(usd,s.duration_sec);
  return multiply(multiply(usd,s.usd_cny),s.multiplier);
};
export const POINTS_PER_CNY = 100;
// 点数 = 元 × 100，8 位小数串（与 charged_cny 同精度）。网页/桌面端只认「点」。
export function points(value) {
  if(value===null||value===undefined)return null;
  const raw=String(value),negative=raw.startsWith('-');
  const scaled=units(negative?raw.slice(1):raw)*100n;
  return (negative?'-':'')+decimal(scaled);
}
export function pointBalances(value){return {...value,balance_points:points(value.balance_cny),available_points:points(value.available_cny),frozen_points:points(value.frozen_cny),points_per_cny:POINTS_PER_CNY};}
// 一笔请求收了多少：网页在每条回复旁标点数用。
export async function requestCharge(db,id,userId){
  const row=(await db.query(`SELECT r.id AS request_id,r.model,r.input_tokens,r.output_tokens,r.total_tokens,r.status,
    b.state AS billing_state,b.charged_cny,b.reserved_cny FROM requests r LEFT JOIN request_billing b ON b.request_id=r.id
    WHERE r.id=$1 AND r.user_id=$2`,[id,userId])).rows[0];
  if(!row)throw httpError(404,'request_not_found');
  return {...row,charged_points:points(row.charged_cny),reserved_points:points(row.reserved_cny)};
}
// 工作台报价：一次文本调用最多预扣多少。保守上界，不是 tokenizer。
export function quoteTextHold(body,policy){
  const model=prices.models[body.model],output=body.max_completion_tokens??body.max_output_tokens??body.max_tokens;
  const input=Buffer.byteLength(JSON.stringify(body),'utf8')*2+4096;
  const maxRate=field=>model.tiers.reduce((max,t)=>{const n=units(t[field]??t.input);return n>max?n:max;},0n);
  const inputRate=[maxRate('input'),maxRate('cached_input'),maxRate('cache_write')].reduce((a,b)=>a>b?a:b);
  const base=decimal((BigInt(input)*inputRate+BigInt(output)*maxRate('output')+999999n)/1000000n);
  return multiply(base,policy.multiplier);
}
export async function wallet(c,userId){
  return (await c.query(`SELECT credit-debit AS balance_cny,held AS frozen_cny,credit-debit-held AS available_cny FROM
    (SELECT coalesce((SELECT sum(amount_cny) FROM wallet_entries WHERE user_id=$1),0) AS credit,
    coalesce((SELECT sum(amount_cny) FROM wallet_debits WHERE user_id=$1),0)
      +coalesce((SELECT sum(f.balance_deduction_cny) FROM commission_payment_refunds f JOIN payment_orders p ON p.id=f.payment_order_id WHERE p.user_id=$1 AND p.target='local'),0) AS debit,
    coalesce((SELECT sum(reserved_cny) FROM request_billing WHERE user_id=$1 AND state IN ('reserved','pending')),0) AS held) x`,[userId])).rows[0];
}
export async function reserveRequest(db,id,userId,body,path,requested=body){
  return db.tx(async c=>{
    await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[userId]);
    const policy=(await c.query('SELECT * FROM billing_policy WHERE id=1')).rows[0];
    if(!policy.enabled)return;
    let amount,snapshot;
    if(mediaPaths.includes(path)){
      // Media is priced in USD upstream; the wallet is CNY. The rate is an administered ledger parameter, never fetched at request time.
      const pricing=mediaPricing(body.model),{tier,durationSec}=resolveTier(body.model,requested);
      if(pricing.billing_unit==='per_second'&&!(durationSec>0))throw httpError(400,'billing_requires_priced_media');
      snapshot={media:true,policy_version:policy.version,multiplier:policy.multiplier,usd_cny:policy.usd_cny,model:body.model,
        kind:pricing.kind,billing_unit:pricing.billing_unit,base_usd:pricing.base_usd,tier,tier_rate:pricing.tiers[tier],duration_sec:durationSec};
      amount=mediaAmount(snapshot);
    }else{
      const model=prices.models[body.model];
      const output=body.max_completion_tokens??body.max_output_tokens??body.max_tokens;
      if(!['/v1/chat/completions','/v1/responses','/v1/messages'].includes(path)||!model||!Number.isSafeInteger(output)||output<1||output>1000000||
        (body.service_tier&&!['default','auto'].includes(body.service_tier))||body.tools?.some(t=>t.type!=='function')||body.model.includes('search'))throw httpError(400,'billing_requires_priced_text_and_output_limit');
      // A conservative hold, not a tokenizer or a claimed final price. Excess charges require reconciliation.
      const input=Buffer.byteLength(JSON.stringify(body),'utf8')*2+4096;
      const maxRate=field=>model.tiers.reduce((max,t)=>{const n=units(t[field]??t.input);return n>max?n:max;},0n);
      const inputRate=[maxRate('input'),maxRate('cached_input'),maxRate('cache_write')].reduce((a,b)=>a>b?a:b);
      const base=decimal((BigInt(input)*inputRate+BigInt(output)*maxRate('output')+999999n)/1000000n);
      amount=multiply(base,policy.multiplier);
      snapshot={policy_version:policy.version,multiplier:policy.multiplier,catalog:{...prices,models:{[body.model]:model}},model:body.model};
    }
    const balance=await wallet(c,userId);
    if(units(balance.available_cny)<units(amount))throw httpError(402,'insufficient_balance');
    await c.query(`INSERT INTO request_billing(request_id,user_id,state,reserved_cny,price_snapshot) VALUES($1,$2,'reserved',$3,$4)`,
      [id,userId,amount,JSON.stringify(snapshot)]);
  });
}
export async function settleRequest(c,id,{status,submitted,errorCode,usage,serviceTier,billableTools}){
  const found=(await c.query('SELECT user_id FROM request_billing WHERE request_id=$1',[id])).rows[0];if(!found)return;
  await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[found.user_id]);
  const bill=(await c.query('SELECT * FROM request_billing WHERE request_id=$1 FOR UPDATE',[id])).rows[0];
  if(['settled','released'].includes(bill.state))return;
  if(!submitted){await c.query("UPDATE request_billing SET state='released',reason='not_executed',resolved_at=now() WHERE request_id=$1",[id]);return;}
  const snapshot=bill.price_snapshot;
  // Media settles only when the async task reaches a terminal state; an unverified submission stays held for review.
  if(snapshot.media){
    if(status==='succeeded')return;
    // 上游 4xx（含重试打光的 429/401/402/403）是明确拒绝，任务不可能被创建，冻结必须自动退；
    // 5xx 和结果不确定的提交才留给人工核销 —— 那种情况上游可能已经建了任务。
    const refused=/^upstream_http_4\d\d$/.test(errorCode??'');
    if(refused)await c.query("UPDATE request_billing SET state='released',charged_cny=0,resolved_at=now(),reason=$2 WHERE request_id=$1",[id,errorCode]);
    else await c.query("UPDATE request_billing SET state='pending',reason='media_submit_unverified' WHERE request_id=$1",[id]);
    return;
  }
  // The catalog is versioned per request. A changed running process cannot silently reprice a request.
  const price=estimateTextCost(snapshot.model,usage,{status,serviceTier,billableTools,catalog:snapshot.catalog});
  if(status!=='succeeded'||price.amount===null){
    await c.query("UPDATE request_billing SET state='pending',reason=$2 WHERE request_id=$1",[id,status==='succeeded'?'price_or_usage_unverified':'upstream_result_unverified']);return;
  }
  const amount=multiply(price.amount,snapshot.multiplier);
  if(units(amount)>units(bill.reserved_cny)){
    await c.query("UPDATE request_billing SET state='pending',reason='charge_exceeds_hold' WHERE request_id=$1",[id]);return;
  }
  await debit(c,bill,amount,'automatic');
}
// Called from the task-charge transaction: the upstream task is the only proof of what the user owes.
export async function settleMediaRequest(c,id,status){
  const found=(await c.query('SELECT user_id FROM request_billing WHERE request_id=$1',[id])).rows[0];if(!found)return;
  await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[found.user_id]);
  const bill=(await c.query('SELECT * FROM request_billing WHERE request_id=$1 FOR UPDATE',[id])).rows[0];
  if(bill.state!=='reserved'||!bill.price_snapshot.media)return;
  if(status!=='completed'){await c.query("UPDATE request_billing SET state='released',charged_cny=0,resolved_at=now(),reason=$2 WHERE request_id=$1",[id,'media_task_'+status]);return;}
  const amount=mediaAmount(bill.price_snapshot);
  if(units(amount)>units(bill.reserved_cny)){await c.query("UPDATE request_billing SET state='pending',reason='charge_exceeds_hold' WHERE request_id=$1",[id]);return;}
  await debit(c,bill,amount,'automatic');
}
async function debit(c,bill,amount,source){
  const balance=await wallet(c,bill.user_id);
  if(units(amount)>units(balance.available_cny)+units(bill.reserved_cny))throw httpError(409,'insufficient_balance');
  const after=decimal(units(balance.balance_cny)-units(amount));
  await c.query('INSERT INTO wallet_debits(id,request_id,user_id,amount_cny,balance_after_cny) VALUES($1,$2,$3,$4,$5)',[randomUUID(),bill.request_id,bill.user_id,amount,after]);
  await c.query("UPDATE request_billing SET state='settled',charged_cny=$2,resolved_at=now(),reason=$3 WHERE request_id=$1",[bill.request_id,amount,source]);
  // 结算的同一个事务里计提作者分成：分开写就会出现「扣了钱但没计提」的窗口。
  await accrueEarning(c,bill.request_id);
}
export function billingRoutes(app,{db}){
  app.get('/admin/api/billing',async()=>({policy:(await db.query('SELECT * FROM billing_policy')).rows[0],pending:(await db.query(`SELECT b.*,u.name AS user_name FROM request_billing b JOIN users u ON u.id=b.user_id WHERE state IN ('pending','reserved') ORDER BY review_at LIMIT 200`)).rows}));
  app.post('/admin/api/billing/policy',async req=>{
    const {enabled,multiplier,usd_cny=null}=req.body??{};
    if(typeof enabled!=='boolean'||typeof multiplier!=='string'||!/^\d{1,3}(\.\d{1,4})?$/.test(multiplier)||Number(multiplier)<=0||Number(multiplier)>100||
      (usd_cny!==null&&(typeof usd_cny!=='string'||!/^\d{1,3}(\.\d{1,4})?$/.test(usd_cny)||Number(usd_cny)<=0)))throw httpError(400,'invalid_billing_policy');
    await db.query('UPDATE billing_policy SET enabled=$1,multiplier=$2,usd_cny=coalesce($3,usd_cny),version=version+1,updated_at=now() WHERE id=1',[enabled,multiplier,usd_cny]);return {ok:true};
  });
  app.post('/admin/api/billing/:id/resolve',async req=>{
    const {amount_cny,reason}=req.body??{};
    if(typeof reason!=='string'||reason.trim().length<5||reason.length>500||typeof amount_cny!=='string'||!/^(0|[1-9]\d{0,8})(\.\d{1,8})?$/.test(amount_cny))throw httpError(400,'invalid_resolution');
    return db.tx(async c=>{
      const found=(await c.query('SELECT user_id FROM request_billing WHERE request_id=$1',[req.params.id])).rows[0];if(!found)throw httpError(404,'not_found');
      await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[found.user_id]);
      const bill=(await c.query('SELECT * FROM request_billing WHERE request_id=$1 FOR UPDATE',[req.params.id])).rows[0];
      if(bill.state!=='pending')throw httpError(409,'billing_not_pending');
      if(units(amount_cny)>units(bill.reserved_cny))throw httpError(409,'charge_exceeds_hold');
      if(units(amount_cny)===0n)await c.query("UPDATE request_billing SET state='released',charged_cny=0,resolved_at=now(),reason=$2 WHERE request_id=$1",[bill.request_id,reason]);
      else await debit(c,bill,amount_cny,reason);
      return {ok:true};
    });
  });
  app.get('/admin/api/users/daily',async req=>{
    const day=req.query.day??new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});
    if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day)))throw httpError(400,'invalid_date');
    return {day,rows:(await db.query(`SELECT u.id,u.name,u.email,count(r.id) AS requests,coalesce(sum(r.input_tokens),0) AS input_tokens,
      coalesce(sum(r.output_tokens),0) AS output_tokens,coalesce(sum(r.total_tokens),0) AS total_tokens,
      coalesce(sum(b.charged_cny) FILTER(WHERE b.state='settled'),0) AS charged_cny,
      sum(r.cost_cny) AS upstream_cost_cny,sum(r.estimated_cost_cny) AS upstream_estimated_cny,
      count(b.request_id) FILTER(WHERE b.state='pending') AS pending
      FROM users u LEFT JOIN requests r ON r.user_id=u.id AND r.created_at>=($1::date::timestamp AT TIME ZONE 'Asia/Shanghai') AND r.created_at<(($1::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')
      LEFT JOIN request_billing b ON b.request_id=r.id GROUP BY u.id ORDER BY total_tokens DESC`,[day])).rows};
  });
}
