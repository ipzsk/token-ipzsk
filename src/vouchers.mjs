import { wallet } from './billing.mjs';
import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { hash, httpError, RateLimiter } from './security.mjs';
import * as v from './validation.mjs';
import { provisionIfEnabled } from './lanehub.mjs';
import { lanehubBalance, creditVoucher } from './lanehub-charges.mjs';

// 官网和客户端对用户只说「点」，从不显示人民币：1 点 = 0.01 元（充值文案写死的
// 「10 元 = 1,000 点」）。换算只在这一个地方做——散到各页面里，任何一处写错都是
// 用户看到的余额和实际能花的钱对不上。
const POINTS_PER_CNY = 100;
const points = (cny) => (Number(cny ?? 0) * POINTS_PER_CNY).toFixed(2);

export function voucherVault(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('invalid_voucher_encryption_key');
  return {
    seal(code,id) {
      const nonce=randomBytes(12), cipher=createCipheriv('aes-256-gcm',key,nonce);
      cipher.setAAD(Buffer.from(id));
      const encrypted=Buffer.concat([cipher.update(code,'utf8'),cipher.final()]);
      return ['v1',nonce.toString('base64'),encrypted.toString('base64'),cipher.getAuthTag().toString('base64')].join('.');
    },
    open(value,id) {
      const [version,nonce,encrypted,tag]=value.split('.');
      if(version!=='v1')throw new Error('invalid_voucher_ciphertext');
      const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(nonce,'base64'));
      decipher.setAAD(Buffer.from(id));decipher.setAuthTag(Buffer.from(tag,'base64'));
      return Buffer.concat([decipher.update(Buffer.from(encrypted,'base64')),decipher.final()]).toString('utf8');
    },
  };
}
export function normalizeVoucher(value) {
  if(typeof value!=='string'||value.length>100)throw httpError(400,'invalid_voucher');
  const code=value.replace(/[\s-]/g,'').toUpperCase();
  if(!/^IPZ[0-9A-F]{32}$/.test(code))throw httpError(400,'invalid_voucher');
  return code;
}
const displayCode=(code)=>'IPZ-'+code.slice(3).match(/.{8}/g).join('-');
const required=(result)=>{if(!result.rowCount)throw httpError(404,'not_found');return result.rows[0];};
const audit=(c,action,id,details)=>c.query('INSERT INTO audit_events(action,target_id,details) VALUES($1,$2,$3)',
  [action,id,JSON.stringify(details)]);
const pageOf=(query)=>v.integer(Number(query.page??1),1,100000);

export function voucherRoutes(app,options) {
  const {db,voucherKey,lanehub=null,lanehubUsdCny=0,lanehubQuotaPerUnit=500000}=options;
  const provision=(user)=>provisionIfEnabled(db,options,user);
  const vault=voucherKey?voucherVault(voucherKey):null;
  const limiter=new RateLimiter();
  const ready=()=>{if(!vault)throw httpError(503,'voucher_service_unavailable');};
  app.get('/admin/api/vouchers/summary',async()=>({rows:(await db.query(`SELECT b.amount_cny,
    count(*) AS total,
    count(*) FILTER(WHERE c.state='redeemed') AS redeemed,
    count(*) FILTER(WHERE c.state='revoked') AS revoked,
    count(*) FILTER(WHERE c.state='unused' AND b.expires_at<=now()) AS expired,
    count(*) FILTER(WHERE c.state='unused' AND (b.expires_at IS NULL OR b.expires_at>now()) AND b.assigned_at IS NULL) AS unassigned,
    count(*) FILTER(WHERE c.state='unused' AND (b.expires_at IS NULL OR b.expires_at>now()) AND b.assigned_at IS NOT NULL) AS assigned
    FROM voucher_codes c JOIN voucher_batches b ON b.id=c.batch_id GROUP BY b.amount_cny ORDER BY b.amount_cny`)).rows}));
  app.get('/admin/api/vouchers/batches',async(req)=>{
    const page=pageOf(req.query);
    const rows=(await db.query(`SELECT b.*,
      (SELECT count(*) FROM voucher_codes c WHERE c.batch_id=b.id AND c.state='redeemed') AS redeemed,
      (SELECT count(*) FROM voucher_codes c WHERE c.batch_id=b.id AND c.state='revoked') AS revoked,
      (SELECT count(*) FROM voucher_codes c WHERE c.batch_id=b.id AND c.state='unused' AND (b.expires_at IS NULL OR b.expires_at>now())) AS available
      FROM voucher_batches b ORDER BY b.created_at DESC,b.id LIMIT 30 OFFSET $1`,[(page-1)*30])).rows;
    return {rows,page,count:Number((await db.query('SELECT count(*) FROM voucher_batches')).rows[0].count),page_size:30};
  });
  app.post('/admin/api/vouchers/batches',async(req)=>{
    ready();limiter.take('generate',10);
    const b=req.body??{},id=v.uuid(b.id),name=v.text(b.name),amount=v.integer(b.amount_cny,10,100),quantity=v.integer(b.quantity,1,1000);
    if(![10,50,100].includes(amount))throw httpError(400,'invalid_denomination');
    let expires=null;
    if(b.expires_at){
      if(typeof b.expires_at!=='string'||!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(b.expires_at)||!Number.isFinite(Date.parse(b.expires_at)))throw httpError(400,'invalid_expiry');
      expires=new Date(b.expires_at).toISOString();
    }
    return db.tx(async(c)=>{
      const inserted=await c.query(`INSERT INTO voucher_batches(id,name,amount_cny,quantity,expires_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING RETURNING id`,[id,name,amount,quantity,expires]);
      if(!inserted.rowCount){
        const old=required(await c.query('SELECT * FROM voucher_batches WHERE id=$1',[id]));
        if(old.name!==name||Number(old.amount_cny)!==amount||old.quantity!==quantity||(old.expires_at?.toISOString()??null)!==expires)throw httpError(409,'batch_conflict');
        return {id,replayed:true};
      }
      if(expires&&Date.parse(expires)<=Date.now())throw httpError(400,'invalid_expiry');
      for(let i=0;i<quantity;i++){
        const code='IPZ'+randomBytes(16).toString('hex').toUpperCase(),codeId=randomUUID();
        await c.query('INSERT INTO voucher_codes(id,batch_id,code_hash,code_suffix,ciphertext) VALUES($1,$2,$3,$4,$5)',
          [codeId,id,hash(code),code.slice(-6),vault.seal(code,codeId)]);
      }
      await audit(c,'voucher.batch.create',id,{amount_cny:amount,quantity});return {id};
    });
  });
  app.post('/admin/api/vouchers/batches/:id/export',async(req,reply)=>{
    ready();limiter.take('export',20);
    const id=v.uuid(req.params.id),format=req.body?.format??'txt';
    if(!['txt','csv'].includes(format))throw httpError(400,'invalid_export_format');
    const content=await db.tx(async(c)=>{
      const b=required(await c.query('SELECT * FROM voucher_batches WHERE id=$1 FOR UPDATE',[id]));
      if(b.expires_at&&b.expires_at<=new Date())throw httpError(409,'batch_expired');
      const rows=(await c.query("SELECT id,ciphertext FROM voucher_codes WHERE batch_id=$1 AND state='unused' ORDER BY id",[id])).rows;
      if(!rows.length)throw httpError(409,'no_available_vouchers');
      const codes=rows.map((row)=>displayCode(vault.open(row.ciphertext,row.id)));
      await c.query('UPDATE voucher_batches SET exported_at=now(),export_count=export_count+1 WHERE id=$1',[id]);
      await audit(c,'voucher.batch.export',id,{format,count:codes.length,channel:b.channel});
      return format==='txt'?codes.join('\r\n')+'\r\n':'\uFEFFcode,amount_cny,batch_id\r\n'+codes.map((code)=>`${code},${b.amount_cny},${id}`).join('\r\n')+'\r\n';
    });
    reply.header('Content-Disposition',`attachment; filename="ipzsk-vouchers-${id}.${format}"`).type(format==='txt'?'text/plain; charset=utf-8':'text/csv; charset=utf-8');
    return content;
  });
  app.post('/admin/api/vouchers/batches/:id/assign',async(req)=>{
    const id=v.uuid(req.params.id),channel=v.text(req.body?.channel);
    return db.tx(async(c)=>{
      const b=required(await c.query('SELECT * FROM voucher_batches WHERE id=$1 FOR UPDATE',[id]));
      if(b.assigned_at){if(b.channel!==channel)throw httpError(409,'batch_already_assigned');return {ok:true};}
      if(!b.exported_at)throw httpError(409,'export_required');
      if(b.expires_at&&b.expires_at<=new Date())throw httpError(409,'batch_expired');
      if(!(await c.query("SELECT id FROM voucher_codes WHERE batch_id=$1 AND state='unused' LIMIT 1",[id])).rowCount)throw httpError(409,'no_available_vouchers');
      await c.query('UPDATE voucher_batches SET channel=$2,assigned_at=now() WHERE id=$1',[id,channel]);
      await audit(c,'voucher.batch.assign',id,{channel});return {ok:true};
    });
  });
  app.get('/admin/api/vouchers/codes',async(req)=>{
    const args=[],where=[];const page=pageOf(req.query);
    if(req.query.batch_id){args.push(v.uuid(req.query.batch_id));where.push(`c.batch_id=$${args.length}`);}
    if(req.query.state){if(!['unused','redeemed','revoked'].includes(req.query.state))throw httpError(400,'invalid_voucher_state');args.push(req.query.state);where.push(`c.state=$${args.length}`);}
    const filter=where.length?'WHERE '+where.join(' AND '):'';
    const count=Number((await db.query(`SELECT count(*) FROM voucher_codes c ${filter}`,args)).rows[0].count);
    args.push((page-1)*30);
    const rows=(await db.query(`SELECT c.id,c.batch_id,c.code_suffix,c.state,c.redeemed_by,c.redeemed_at,c.revoked_at,c.revoke_reason,
      b.name AS batch_name,b.amount_cny,b.channel,b.expires_at,b.assigned_at,u.name AS user_name,
      l.id AS ledger_id FROM voucher_codes c JOIN voucher_batches b ON b.id=c.batch_id
      LEFT JOIN users u ON u.id=c.redeemed_by LEFT JOIN wallet_entries l ON l.voucher_id=c.id
      ${filter} ORDER BY b.created_at DESC,c.id LIMIT 30 OFFSET $${args.length}`,args)).rows;
    return {rows,count,page,page_size:30};
  });
  app.post('/admin/api/vouchers/batches/:id/revoke',async(req)=>{
    const id=v.uuid(req.params.id),reason=v.text(req.body?.reason,300);
    return db.tx(async(c)=>{
      required(await c.query('SELECT id FROM voucher_batches WHERE id=$1 FOR UPDATE',[id]));
      const r=await c.query("UPDATE voucher_codes SET state='revoked',revoked_at=now(),revoke_reason=$2 WHERE batch_id=$1 AND state='unused'",[id,reason]);
      await audit(c,'voucher.batch.revoke',id,{reason,count:r.rowCount});return {ok:true,count:r.rowCount};
    });
  });
  app.post('/admin/api/vouchers/codes/:id/revoke',async(req)=>{
    const id=v.uuid(req.params.id),reason=v.text(req.body?.reason,300);
    return db.tx(async(c)=>{
      const code=required(await c.query('SELECT batch_id FROM voucher_codes WHERE id=$1',[id]));
      await c.query('SELECT id FROM voucher_batches WHERE id=$1 FOR UPDATE',[code.batch_id]);
      const r=await c.query("UPDATE voucher_codes SET state='revoked',revoked_at=now(),revoke_reason=$2 WHERE id=$1 AND state='unused' RETURNING id",[id,reason]);
      if(!r.rowCount)throw httpError(409,'voucher_not_unused');
      await audit(c,'voucher.code.revoke',id,{reason});return {ok:true};
    });
  });
  app.get('/admin/api/wallet/entries',async(req)=>{
    const page=pageOf(req.query),userId=req.query.user_id?v.uuid(req.query.user_id):null;
    const rows=(await db.query(`SELECT l.*,u.name AS user_name,c.code_suffix,b.name AS batch_name FROM wallet_entries l
      JOIN users u ON u.id=l.user_id LEFT JOIN voucher_codes c ON c.id=l.voucher_id LEFT JOIN voucher_batches b ON b.id=c.batch_id
      WHERE ($1::uuid IS NULL OR l.user_id=$1) ORDER BY l.created_at DESC,l.id LIMIT 30 OFFSET $2`,[userId,(page-1)*30])).rows;
    const count=Number((await db.query('SELECT count(*) FROM wallet_entries WHERE ($1::uuid IS NULL OR user_id=$1)',[userId])).rows[0].count);
    return {rows,page,count,page_size:30};
  });
  app.get('/api/me/wallet',async(req)=>{
    // lanehub 模式下额度真源在对面：这边的 wallet 表只剩充值流水，余额读它就是读旧数——
    // 用户充完看不到、花完也不减。
    const account=lanehub?await provision({userId:req.apiUser.id,name:req.apiUser.name}).catch(()=>null):null;
    const balances=account
      ?await lanehubBalance(lanehub,account,{usdCnyRate:lanehubUsdCny,quotaPerUnit:lanehubQuotaPerUnit})
      :await wallet(db,req.apiUser.id);
    const rows=(await db.query(`SELECT id,amount_cny,balance_after_cny,created_at,'recharge' AS kind FROM wallet_entries WHERE user_id=$1 UNION ALL SELECT id,-amount_cny,balance_after_cny,created_at,'consumption' AS kind FROM wallet_debits WHERE user_id=$1 ORDER BY created_at DESC,id LIMIT 30`,[req.apiUser.id])).rows;
    return {user:{id:req.apiUser.id,name:req.apiUser.name},...balances,
      balance_points:points(balances.balance_cny),frozen_points:points(balances.frozen_cny),available_points:points(balances.available_cny),
      currency:'CNY',source:account?'lanehub':'local',entries:rows};
  });
  app.post('/api/me/vouchers/redeem',async(req)=>{
    limiter.take('redeem-ip:'+req.ip,30);limiter.take('redeem-user:'+req.apiUser.id,10);
    const codeHash=hash(normalizeVoucher(req.body?.code));
    return db.tx(async(c)=>{
      const found=(await c.query('SELECT id,batch_id FROM voucher_codes WHERE code_hash=$1',[codeHash])).rows[0];
      if(!found)throw httpError(400,'voucher_unavailable');
      const batch=required(await c.query('SELECT * FROM voucher_batches WHERE id=$1 FOR UPDATE',[found.batch_id]));
      const code=required(await c.query('SELECT * FROM voucher_codes WHERE id=$1 FOR UPDATE',[found.id]));
      // Serialize wallet credits and recheck revoked/disabled user access inside the transaction.
      const user=required(await c.query('SELECT enabled FROM users WHERE id=$1 FOR UPDATE',[req.apiUser.id]));
      const credential=req.apiUser.token_id
        ? await c.query('SELECT id FROM access_tokens WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL',[req.apiUser.token_id,req.apiUser.id])
        : await c.query('SELECT id FROM auth_sessions WHERE id=$1 AND "userId"=$2 AND "expiresAt">now()',[req.apiUser.session_id,req.apiUser.auth_user_id]);
      if(!user.enabled||!credential.rowCount)throw httpError(401,'invalid_api_token');
      if(code.state==='redeemed'&&code.redeemed_by===req.apiUser.id){
        const prior=required(await c.query('SELECT id,amount_cny,balance_after_cny FROM wallet_entries WHERE voucher_id=$1',[code.id]));
        return {ok:true,replayed:true,ledger_id:prior.id,amount_cny:prior.amount_cny,amount_points:points(prior.amount_cny),
          balance_after_cny:prior.balance_after_cny,balance_after_points:points(prior.balance_after_cny),voucher_id:code.id};
      }
      if(code.state!=='unused'||!batch.assigned_at||(batch.expires_at&&batch.expires_at<=new Date()))throw httpError(400,'voucher_unavailable');
      const balance=(await c.query('SELECT coalesce(sum(amount_cny),0)+$2::numeric-coalesce((SELECT sum(amount_cny) FROM wallet_debits WHERE user_id=$1),0) AS amount FROM wallet_entries WHERE user_id=$1',[req.apiUser.id,batch.amount_cny])).rows[0].amount;
      const ledgerId=randomUUID();
      await c.query('INSERT INTO wallet_entries(id,user_id,voucher_id,amount_cny,balance_after_cny) VALUES($1,$2,$3,$4,$5)',[ledgerId,req.apiUser.id,code.id,batch.amount_cny,balance]);
      await c.query("UPDATE voucher_codes SET state='redeemed',redeemed_by=$2,redeemed_at=now() WHERE id=$1",[code.id,req.apiUser.id]);
      await c.query('INSERT INTO audit_events(action,target_id,details) VALUES($1,$2,$3)',
        ['voucher.redeem',code.id,JSON.stringify({user_id:req.apiUser.id,amount_cny:batch.amount_cny,ledger_id:ledgerId})]);
      return {ok:true,replayed:false,ledger_id:ledgerId,amount_cny:batch.amount_cny,amount_points:points(batch.amount_cny),
        balance_after_cny:balance,balance_after_points:points(balance),voucher_id:code.id};
    }).then(async(result)=>{
      // 事务外再把钱搬到 lanehub：跨网络调用塞进事务会把它拖长，失败还会连兑换一起回滚。
      // 幂等键是 voucher:<id>，所以这里失败也不丢——lanehub-charges 的扫描会补上。
      if(lanehub)await creditVoucher(db,lanehub,options,{userId:req.apiUser.id,name:req.apiUser.name,
        voucherId:result.voucher_id,amountCny:result.amount_cny}).catch(()=>{});
      return result;
    });
  });
}
