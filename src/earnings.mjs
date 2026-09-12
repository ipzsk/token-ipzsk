import { randomUUID } from 'node:crypto';
import { httpError } from './security.mjs';
import { uuid } from './validation.mjs';
import { units, decimal } from './billing.mjs';
import { creditAccount, provisionIfEnabled, lanehubMode } from './lanehub.mjs';

// 插件作者的分成：计提、退款冲销、结算单。
//
// `plugin_earnings` 是**作者应得的唯一真源**：计提一行，退款再记一行负数。
// 报表和结算单都从它汇总，不各自按 charged_cny 再算一遍——两份口径只要差一点，
// 打出去的钱就是错的。
//
// 比例和归属取 `requests` 上的**发生时快照**（plugin_share_bps / plugin_owner_user_id），
// 不读 plugins 表的当前值：事后改分成比例不能改写历史账。

/** 一笔请求结算之后计提作者分成。同一笔只会有一行（唯一索引兜底）。 */
export async function accrueEarning(c, requestId) {
  await c.query(`INSERT INTO plugin_earnings (id,request_id,owner_user_id,plugin_id,kind,amount_cny)
    SELECT $2,r.id,r.plugin_owner_user_id,r.plugin_id,'accrual',
      round((b.charged_cny-b.refunded_cny)*r.plugin_share_bps/10000,8)
    FROM requests r JOIN request_billing b ON b.request_id=r.id
    WHERE r.id=$1 AND r.plugin_owner_user_id IS NOT NULL AND coalesce(r.plugin_share_bps,0)>0
      AND b.state='settled' AND (b.charged_cny-b.refunded_cny)>0
    ON CONFLICT DO NOTHING`, [requestId, randomUUID()]);
}

const amount=(value)=>{
  if(typeof value!=='string'||!/^(0|[1-9]\d{0,8})(\.\d{1,8})?$/.test(value)||units(value)<=0n)throw httpError(400,'invalid_amount');
  return value;
};
const reason=(value)=>{
  if(typeof value!=='string'||value.trim().length<5||value.length>500)throw httpError(400,'invalid_reason');
  return value.trim();
};
const day=(value,fallback)=>{
  const v=value??fallback;
  if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)||new Date(v).toISOString().slice(0,10)!==v)throw httpError(400,'invalid_date');
  return v;
};

export function earningsRoutes(app,options){
  const {db,lanehub=null}=options;

  /**
   * 人工退款：把已结算的一笔退给用户，并**同额冲掉作者的计提**。
   *
   * 三件事必须一起发生，否则账就是错的：
   *   1. request_billing.refunded_cny 累加（charged_cny 不动——它是当时收了多少的事实）
   *   2. plugin_earnings 记一条负数（已冻结的结算单不回溯，负数落到下一张单里）
   *   3. 钱真的回到用户手里
   *
   * 第 3 步在 lanehub 模式下是加回对面的额度，幂等键 `refund:<请求 id>:<序号>`；
   * 本地模式下写一条 wallet_entries。**先在事务里记账，再去对面加钱**：
   * 反过来的话中途挂掉会重复退。加钱失败时整个事务回滚，重试即可。
   */
  app.post('/admin/api/billing/:id/refund',async(req)=>{
    const id=uuid(req.params.id),value=amount(req.body?.amount_cny),why=reason(req.body?.reason);
    const plan=await db.tx(async(c)=>{
      const found=(await c.query('SELECT user_id FROM request_billing WHERE request_id=$1',[id])).rows[0];
      if(!found)throw httpError(404,'not_found');
      await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[found.user_id]);
      const bill=(await c.query('SELECT * FROM request_billing WHERE request_id=$1 FOR UPDATE',[id])).rows[0];
      if(bill.state!=='settled')throw httpError(409,'billing_not_settled');
      const remaining=units(bill.charged_cny)-units(bill.refunded_cny);
      if(units(value)>remaining)throw httpError(409,'refund_exceeds_charge');

      await c.query('UPDATE request_billing SET refunded_cny=refunded_cny+$2 WHERE request_id=$1',[id,value]);
      // 作者那边按同样的比例冲回去。没有归属或没配比例的请求本来就没计提，这里也不记。
      const request=(await c.query('SELECT plugin_owner_user_id,plugin_id,plugin_share_bps FROM requests WHERE id=$1',[id])).rows[0];
      let clawback='0';
      if(request?.plugin_owner_user_id&&Number(request.plugin_share_bps)>0){
        clawback=decimal((units(value)*BigInt(request.plugin_share_bps)+5000n)/10000n);
        if(units(clawback)>0n)await c.query(`INSERT INTO plugin_earnings (id,request_id,owner_user_id,plugin_id,kind,amount_cny)
          VALUES ($1,$2,$3,$4,'refund',$5)`,[randomUUID(),id,request.plugin_owner_user_id,request.plugin_id,'-'+clawback]);
      }
      const seq=(await c.query(`SELECT count(*)::int AS n FROM plugin_earnings WHERE request_id=$1 AND kind='refund'`,[id])).rows[0].n;
      await c.query('INSERT INTO audit_events(action,target_id,administrator_id,details) VALUES($1,$2,$3,$4)',
        ['billing.refund',id,req.administrator.id,JSON.stringify({amount_cny:value,reason:why,clawback_cny:clawback})]);
      return {userId:found.user_id,seq,clawback};
    });

    // 钱回到用户手里。失败会抛出去，管理员看得到，重试落在同一个 reference 上。
    if(lanehub&&await lanehubMode(db)){
      const account=await provisionIfEnabled(db,options,{userId:plan.userId});
      await creditAccount(db,lanehub,{userId:plan.userId,lanehubUserId:account.lanehub_user_id,amountCny:value,
        usdCnyRate:await lanehub.usdRate().catch(()=>options.lanehubUsdCny),quotaPerUnit:options.lanehubQuotaPerUnit,
        reference:`refund:${id}:${plan.seq}`,remark:'人工退款：'+why});
    }else{
      await db.tx(async(c)=>{
        const balance=(await c.query(`SELECT coalesce(sum(amount_cny),0)+$2::numeric-coalesce((SELECT sum(amount_cny) FROM wallet_debits WHERE user_id=$1),0) AS amount FROM wallet_entries WHERE user_id=$1`,[plan.userId,value])).rows[0].amount;
        await c.query('INSERT INTO wallet_entries(id,user_id,amount_cny,balance_after_cny) VALUES($1,$2,$3,$4)',[randomUUID(),plan.userId,value,balance]);
      });
    }
    return {ok:true,refunded_cny:value,clawback_cny:plan.clawback};
  });

  // ── 结算单 ───────────────────────────────────────────────────────────────
  // 打款是人工的，这里只做**凭据**：把一段时间内还没归属的计提圈成一张单，
  // 冻结锁金额，打完款登记。作废会把计提释放回去，可以重新出单。

  app.get('/admin/api/settlements',async(req)=>{
    const owner=req.query.owner_user_id?uuid(req.query.owner_user_id):null;
    const rows=(await db.query(`SELECT s.*,d.display_name AS owner_name FROM settlements s
      JOIN developer_profiles d ON d.user_id=s.owner_user_id
      WHERE ($1::uuid IS NULL OR s.owner_user_id=$1) ORDER BY s.created_at DESC LIMIT 100`,[owner])).rows;
    // 还没出单的计提：运营要先看见这个数，才知道该给谁出单。
    const pending=(await db.query(`SELECT e.owner_user_id,d.display_name AS owner_name,
      sum(e.amount_cny) AS amount_cny,count(*)::int AS item_count,min(e.created_at) AS since
      FROM plugin_earnings e JOIN developer_profiles d ON d.user_id=e.owner_user_id
      WHERE e.settlement_id IS NULL AND ($1::uuid IS NULL OR e.owner_user_id=$1)
      GROUP BY e.owner_user_id,d.display_name ORDER BY sum(e.amount_cny) DESC`,[owner])).rows;
    return {rows,pending};
  });

  app.get('/admin/api/settlements/:id',async(req)=>{
    const id=uuid(req.params.id);
    const row=(await db.query('SELECT * FROM settlements WHERE id=$1',[id])).rows[0];
    if(!row)throw httpError(404,'not_found');
    const items=(await db.query(`SELECT e.kind,e.amount_cny,e.created_at,e.request_id,p.name AS plugin_name,r.model
      FROM plugin_earnings e LEFT JOIN plugins p ON p.id=e.plugin_id LEFT JOIN requests r ON r.id=e.request_id
      WHERE e.settlement_id=$1 ORDER BY e.created_at DESC LIMIT 500`,[id])).rows;
    return {settlement:row,items};
  });

  app.post('/admin/api/settlements',async(req)=>{
    const owner=uuid(req.body?.owner_user_id);
    const to=day(req.body?.to,new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'}));
    const from=day(req.body?.from,to.slice(0,8)+'01');
    if(from>to)throw httpError(400,'invalid_date_range');
    return db.tx(async(c)=>{
      const profile=(await c.query('SELECT state FROM developer_profiles WHERE user_id=$1 FOR UPDATE',[owner])).rows[0];
      if(!profile)throw httpError(404,'developer_not_found');
      const id=randomUUID();
      await c.query(`INSERT INTO settlements (id,owner_user_id,period_from,period_to,created_by,note)
        VALUES ($1,$2,$3,$4,$5,$6)`,[id,owner,from,to,req.administrator.id,String(req.body?.note??'').slice(0,500)]);
      // 只圈**还没归属任何单**的计提：同一条明细不可能进两张单。
      const claimed=await c.query(`UPDATE plugin_earnings SET settlement_id=$1
        WHERE settlement_id IS NULL AND owner_user_id=$2
          AND created_at>=($3::date::timestamp AT TIME ZONE 'Asia/Shanghai')
          AND created_at<(($4::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')`,[id,owner,from,to]);
      const total=(await c.query(`SELECT coalesce(sum(amount_cny),0) AS amount FROM plugin_earnings WHERE settlement_id=$1`,[id])).rows[0].amount;
      await c.query('UPDATE settlements SET amount_cny=$2,item_count=$3 WHERE id=$1',[id,total,claimed.rowCount]);
      return {id,owner_user_id:owner,period_from:from,period_to:to,state:'draft',amount_cny:total,item_count:claimed.rowCount};
    });
  });

  app.post('/admin/api/settlements/:id/freeze',async(req)=>{
    const id=uuid(req.params.id);
    return db.tx(async(c)=>{
      const row=(await c.query('SELECT * FROM settlements WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!row)throw httpError(404,'not_found');
      if(row.state!=='draft')throw httpError(409,'settlement_not_draft');
      // 冻结时重算一次再锁：起草到冻结之间可能又有退款冲销进来。
      const total=(await c.query(`SELECT coalesce(sum(amount_cny),0) AS amount,count(*)::int AS n FROM plugin_earnings WHERE settlement_id=$1`,[id])).rows[0];
      await c.query(`UPDATE settlements SET state='frozen',amount_cny=$2,item_count=$3,frozen_at=now() WHERE id=$1`,[id,total.amount,total.n]);
      return {ok:true,amount_cny:total.amount,item_count:total.n};
    });
  });

  app.post('/admin/api/settlements/:id/pay',async(req)=>{
    const id=uuid(req.params.id),note=reason(req.body?.paid_note);   // 打款凭据必须写清楚：转账单号 / 渠道 / 日期
    return db.tx(async(c)=>{
      const row=(await c.query('SELECT state FROM settlements WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!row)throw httpError(404,'not_found');
      if(row.state!=='frozen')throw httpError(409,'settlement_not_frozen');
      await c.query(`UPDATE settlements SET state='paid',paid_note=$2,paid_at=now() WHERE id=$1`,[id,note]);
      return {ok:true};
    });
  });

  app.post('/admin/api/settlements/:id/void',async(req)=>{
    const id=uuid(req.params.id),why=reason(req.body?.reason);
    return db.tx(async(c)=>{
      const row=(await c.query('SELECT state,note FROM settlements WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!row)throw httpError(404,'not_found');
      // 已打款的不能作废：钱出去了，作废只会让账和银行流水对不上。要冲就再出一张负数单。
      if(row.state==='paid')throw httpError(409,'settlement_already_paid');
      if(row.state==='void')return {ok:true};
      await c.query(`UPDATE plugin_earnings SET settlement_id=NULL WHERE settlement_id=$1`,[id]);
      await c.query(`UPDATE settlements SET state='void',amount_cny=0,item_count=0,note=$2 WHERE id=$1`,
        [id,(row.note?row.note+' / ':'')+'作废：'+why]);
      return {ok:true};
    });
  });

  // 作者自己看：只读，且只看得到自己的单。
  app.get('/api/me/developer/settlements',async(req)=>({
    rows:(await db.query(`SELECT id,period_from,period_to,state,amount_cny,item_count,paid_at,frozen_at,created_at
      FROM settlements WHERE owner_user_id=$1 AND state<>'void' ORDER BY created_at DESC LIMIT 50`,[req.apiUser.id])).rows,
    pending:(await db.query(`SELECT coalesce(sum(amount_cny),0) AS amount_cny,count(*)::int AS item_count
      FROM plugin_earnings WHERE owner_user_id=$1 AND settlement_id IS NULL`,[req.apiUser.id])).rows[0],
  }));
}
