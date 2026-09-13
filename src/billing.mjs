import { randomUUID } from 'node:crypto';
import { httpError } from './security.mjs';
import { prices, estimateTextCost } from './text-pricing.mjs';

export const units=value=>{const [a,b='']=String(value).split('.');return BigInt(a)*100000000n+BigInt(b.padEnd(8,'0').slice(0,8));};
export const decimal=value=>`${value/100000000n}.${String(value%100000000n).padStart(8,'0')}`;
export const multiply=(amount,multiplier)=>decimal((units(amount)*units(multiplier)+50000000n)/100000000n);
export const POINTS_PER_CNY = 100;
export const BILLING_MULTIPLIER = '2.5';
export function points(value) {
  if(value===null||value===undefined)return null;
  const raw=String(value),negative=raw.startsWith('-');
  const scaled=units(negative?raw.slice(1):raw)*100n;
  return (negative?'-':'')+decimal(scaled);
}
export function pointBalances(value){return {...value,balance_points:points(value.balance_cny),available_points:points(value.available_cny),frozen_points:points(value.frozen_cny),points_per_cny:POINTS_PER_CNY};}
export async function requestCharge(db,id,userId){
  const row=(await db.query(`SELECT r.id AS request_id,r.model,r.input_tokens,r.output_tokens,r.total_tokens,r.status,
    b.state AS billing_state,b.charged_cny,b.reserved_cny FROM requests r LEFT JOIN request_billing b ON b.request_id=r.id
    WHERE r.id=$1 AND r.user_id=$2`,[id,userId])).rows[0];
  if(!row)throw httpError(404,'request_not_found');
  return {...row,charged_points:points(row.charged_cny),reserved_points:points(row.reserved_cny)};
}
export async function wallet(c,userId){
  return (await c.query(`SELECT credit-debit AS balance_cny,held AS frozen_cny,credit-debit-held AS available_cny FROM
    (SELECT coalesce((SELECT sum(amount_cny) FROM wallet_entries WHERE user_id=$1),0) AS credit,
    coalesce((SELECT sum(amount_cny) FROM wallet_debits WHERE user_id=$1),0) AS debit,
    coalesce((SELECT sum(reserved_cny) FROM request_billing WHERE user_id=$1 AND state IN ('reserved','pending')),0) AS held) x`,[userId])).rows[0];
}
export function quoteTextHold(body,policy){
  const model=prices.models[body.model],output=body.max_completion_tokens??body.max_output_tokens??body.max_tokens;
  const input=Buffer.byteLength(JSON.stringify(body),'utf8')*2+4096;
  const maxRate=field=>model.tiers.reduce((max,t)=>{const n=units(t[field]??t.input);return n>max?n:max;},0n);
  const inputRate=[maxRate('input'),maxRate('cached_input'),maxRate('cache_write')].reduce((a,b)=>a>b?a:b);
  const base=decimal((BigInt(input)*inputRate+BigInt(output)*maxRate('output')+999999n)/1000000n);
  return multiply(base,policy.multiplier);
}
export async function reserveRequest(db,id,userId,body,path,budget){
  return db.tx(async c=>{
    await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[userId]);
    const policy=(await c.query('SELECT * FROM billing_policy WHERE id=1')).rows[0];
    if(budget&&budget.version!==policy.version)throw httpError(409,'workspace_quote_expired');
    if(!policy.enabled)throw httpError(503,'billing_unavailable');
    const balance=await wallet(c,userId);
    if(units(balance.available_cny)<=0n)throw httpError(402,'insufficient_balance');
    const model=prices.models[body.model];
    const mediaPrice=path==='/v1/images/generations'&&['gpt-image-2','gpt-image-2.5-flare','gemini-3.1-flash-image-preview'].includes(body.model)?imagePrice(body):null;
    const output=body.max_completion_tokens??body.max_output_tokens??body.max_tokens;
    if(mediaPrice===null&&(!['/v1/chat/completions','/v1/responses','/v1/messages'].includes(path)||!model||!Number.isSafeInteger(output)||output<1||output>1000000||
      (body.service_tier&&!['default','auto'].includes(body.service_tier))||body.tools?.some(t=>t.type!=='function')||body.model.includes('search')))throw httpError(400,'billing_requires_priced_text_and_output_limit');
    const amount=mediaPrice===null?quoteTextHold(body,policy):multiply(mediaPrice,policy.multiplier);
    if(budget&&(budget.amount===null||units(amount)>units(budget.amount)))throw httpError(409,'workspace_quote_expired');
    if(units(balance.available_cny)<units(amount))throw httpError(402,'insufficient_balance');
    await c.query(`INSERT INTO request_billing(request_id,user_id,state,reserved_cny,price_snapshot) VALUES($1,$2,'reserved',$3,$4)`,
      [id,userId,amount,JSON.stringify({policy_version:policy.version,multiplier:policy.multiplier,...(mediaPrice===null?{catalog:{...prices,models:{[body.model]:model}}}:{kind:'image',source:'https://apimart.ai/zh/pricing',version:'2026-09-10',base_cny:mediaPrice}),model:body.model})]);
  });
}
export async function settleRequest(c,id,{status,submitted,usage,serviceTier,billableTools}){
  const found=(await c.query('SELECT user_id FROM request_billing WHERE request_id=$1',[id])).rows[0];if(!found)return;
  await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[found.user_id]);
  const bill=(await c.query('SELECT * FROM request_billing WHERE request_id=$1 FOR UPDATE',[id])).rows[0];
  if(['settled','released'].includes(bill.state))return;
  if(!submitted){await c.query("UPDATE request_billing SET state='released',reason='not_executed',resolved_at=now() WHERE request_id=$1",[id]);return;}
  const snapshot=bill.price_snapshot;
  if(snapshot.kind==='image'){
    await c.query("UPDATE request_billing SET state='pending',reason='awaiting_media_result' WHERE request_id=$1",[id]);return;
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
async function debit(c,bill,amount,source){
  const balance=await wallet(c,bill.user_id);
  if(units(amount)>units(balance.available_cny)+units(bill.reserved_cny))throw httpError(409,'insufficient_balance');
  const after=decimal(units(balance.balance_cny)-units(amount));
  await c.query('INSERT INTO wallet_debits(id,request_id,user_id,amount_cny,balance_after_cny) VALUES($1,$2,$3,$4,$5)',[randomUUID(),bill.request_id,bill.user_id,amount,after]);
  await c.query("UPDATE request_billing SET state='settled',charged_cny=$2,resolved_at=now(),reason=$3 WHERE request_id=$1",[bill.request_id,amount,source]);
}
export function billingRoutes(app,{db}){
  app.get('/admin/api/billing',async()=>({policy:(await db.query('SELECT * FROM billing_policy')).rows[0],pending:(await db.query(`SELECT b.*,u.name AS user_name FROM request_billing b JOIN users u ON u.id=b.user_id WHERE state IN ('pending','reserved') ORDER BY review_at LIMIT 200`)).rows}));
  app.post('/admin/api/billing/policy',async req=>{
    const {enabled,multiplier}=req.body??{};
    if(enabled!==true||String(multiplier)!==BILLING_MULTIPLIER)throw httpError(400,'fixed_points_policy');
    if(typeof enabled!=='boolean'||typeof multiplier!=='string'||!/^\d{1,3}(\.\d{1,4})?$/.test(multiplier)||Number(multiplier)<=0||Number(multiplier)>100)throw httpError(400,'invalid_billing_policy');
    await db.query('UPDATE billing_policy SET enabled=$1,multiplier=$2,version=version+1,updated_at=now() WHERE id=1',[enabled,multiplier]);return {ok:true};
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

// APIMart's published gpt-image-2 per-image rates; text token rates do not apply to images.
export function imagePrice(body){
  if(body.model==='gemini-3.1-flash-image-preview'){
    // APIMart Nano Banana 2 Ext alias, published per-image Credits (2026-09-10).
    const rate={'1K':'0.15','2K':'0.2','4K':'0.25'}[body.resolution];
    if(!rate||body.n!==1||body.official_fallback||body.google_search||body.google_image_search)throw httpError(400,'unpriced_image_options');
    return rate;
  }

  if(body.model==='gpt-image-2.5-flare'){
    // Reservation estimate only. Final debit uses upstream credits_cost.
    // Medium output estimates vary by ratio; allow 2x the largest estimate per resolution.
    const output={'1k':878,'2k':1784,'4k':2966}[body.resolution??'1k'];
    if(!output||body.n!==1||body.quality!=='medium')throw httpError(400,'unpriced_image_options');
    const input=Buffer.byteLength(body.prompt??'','utf8')+256;
    const refs=(body.image_urls??[]).length;
    // Published undiscounted Credits rates avoid depending on temporary discounts.
    return decimal((BigInt(input)*50n+BigInt(refs)*8192n*80n+BigInt(output)*300n)*100n);
  }

  const rate={'1k':'0.085','2k':'0.14','4k':'0.21'}[body.resolution??'1k'];
  if(!rate||body.n!==1)throw httpError(400,'unpriced_image_options');
  return rate;
}
export async function settleMediaRequest(c,id,data){
  const found=(await c.query('SELECT user_id FROM request_billing WHERE request_id=$1',[id])).rows[0];if(!found)return;
  await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[found.user_id]);
  const bill=(await c.query('SELECT * FROM request_billing WHERE request_id=$1 FOR UPDATE',[id])).rows[0];
  if(['settled','released'].includes(bill.state)||bill.price_snapshot.kind!=='image')return;
  if(!['completed','failed','cancelled'].includes(data.status))return;
  const usage=data.usage;
  if(usage && [usage.input_tokens,usage.output_tokens,usage.total_tokens].every(n=>Number.isSafeInteger(n)&&n>=0) && usage.total_tokens===usage.input_tokens+usage.output_tokens){
    await c.query("UPDATE requests SET usage_state='reported',input_tokens=$2,output_tokens=$3,total_tokens=$4 WHERE id=$1",[id,usage.input_tokens,usage.output_tokens,usage.total_tokens]);
  }
  const cost=data.credits_cost;
  if(typeof cost!=='number'||!Number.isFinite(cost)||cost<0||cost>1000000){
    await c.query("UPDATE request_billing SET state='pending',reason='media_cost_unverified' WHERE request_id=$1",[id]);return;
  }
  const amount=multiply(cost.toFixed(8),bill.price_snapshot.multiplier);
  if(units(amount)>units(bill.reserved_cny)){
    await c.query("UPDATE request_billing SET state='pending',reason='charge_exceeds_hold' WHERE request_id=$1",[id]);return;
  }
  if(units(amount)===0n){await c.query("UPDATE request_billing SET state='released',charged_cny=0,reason='media_no_charge',resolved_at=now() WHERE request_id=$1",[id]);return;}
  await debit(c,bill,amount,'media_credits_cost');
}
