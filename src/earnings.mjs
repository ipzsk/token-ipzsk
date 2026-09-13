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

/**
 * 同一个人、同一个 skill 的计提去重窗口（分钟）。
 *
 * 网关看到的是一串独立的 HTTP 请求，看不到「一轮对话」的边界；而 agent 一轮会调
 * 五六次模型，skill 内容从加载那一刻起就留在后续每一次的上下文里。不去重的话，
 * 用户说一句话会被计成五六次——实测一轮 6 步计了 5 次，金额翻了五倍。
 *
 * 十分钟是个判断：同一个人在十分钟内反复用同一个 skill，从计费直觉上就是「用了一次」。
 * 长了会把连续两次真实调用吞掉一次（作者少拿），短了会把一轮拆成多次（作者多拿）。
 */
const SKILL_WINDOW_MINUTES = Number(process.env.SKILL_INVOCATION_WINDOW_MINUTES ?? 10);

/**
 * 从请求体里认出这一轮加载了哪些 skill。
 *
 * 依据是 `@deepseek-ai/dsh-skill` 的 renderSkillContent：每个被加载的 skill 都渲染成
 * `<skill_content name="...">`，**模型自主加载和用户显式调用共用同一个渲染**，
 * 所以两条路都认得出来。
 *
 * 为什么扫请求体而不是让客户端报请求头：**这是可证实的事实，不是客户端的声称**。
 * skill 内容确确实实在上下文里，用户为它付了 token；而请求头可以随便填。
 * 附带的好处是客户端一行都不用改，harness 也不用打补丁。
 *
 * 代价写在这儿：这依赖 harness 的渲染格式。哪天它改了标签名，我方会**漏记**
 * （不会错记）——漏记的后果是作者少拿，能从「某个 skill 的调用数突然归零」看出来。
 * 请求头那条路仍然保留，别的客户端可以显式上报。
 */
// 必须一路匹配到**结束引号**：只锚开头的话，name="../../etc/passwd" 会被截成 ".."，
// 凭空造出一个不存在的 skill 名。查登记表查不到所以无害，但账上多一条噪声。
const SKILL_CONTENT = /<skill_content\s+name=\\?"([A-Za-z0-9._-]{1,200})\\?"/g;
export function skillsInRequest(body) {
  const found = new Set();
  const scan = (value) => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(SKILL_CONTENT)) found.add(match[1]);
      return;
    }
    if (Array.isArray(value)) { for (const item of value) scan(item); return; }
    if (value && typeof value === 'object') { for (const item of Object.values(value)) scan(item); }
  };
  scan(body?.system);
  scan(body?.messages);
  return [...found].slice(0, 8);
}

/**
 * 记下这一次请求用到的 skill，并按**调用次数**给它们的作者计提。
 *
 * 和 accrueEarning 的分工：那个按 token 实扣的比例算（给自己发请求的插件），
 * 这个按次数算（给提示词型 skill）。两边的计量单位故意不同——用户为算力付费，
 * 作者为「他的方法论被用了一次」收费，理由见 schema.sql 里那段。
 *
 * 三条纪律：
 *   · **只认登记过的 skill**：plugin_skills 里没有就当没报过，不报错也不计提。
 *     skills 是本地文件，谁都能往目录里扔一个，不设这道闸就是开着门送钱。
 *   · 单价取自 plugins.price_per_call_cny，**默认 0**：管道先跑起来，
 *     等真实调用分布看清楚了再定价，那时定价有依据。单价为 0 时仍然记一行
 *     （金额 0），因为「这次用了哪个 skill」本身就是要统计的事实。
 *   · 一次请求可以用多个 skill，各记各的一行；重复上报由唯一索引挡掉。
 */
export async function recordSkillInvocations(c, requestId, skillRefs, windowMinutes = SKILL_WINDOW_MINUTES) {
  const refs = [...new Set((skillRefs ?? []).filter((ref) => typeof ref === 'string' && ref.length > 0 && ref.length <= 200))];
  if (!refs.length) return 0;
  const inserted = await c.query(`INSERT INTO plugin_earnings (id,request_id,owner_user_id,plugin_id,kind,amount_cny,skill_ref)
    SELECT gen_random_uuid(),r.id,p.owner_user_id,p.id,'invocation',p.price_per_call_cny,s.skill_ref
    FROM requests r JOIN plugin_skills s ON s.skill_ref = ANY($2::text[])
      JOIN plugins p ON p.id=s.plugin_id
    WHERE r.id=$1 AND p.enabled AND p.owner_user_id IS NOT NULL
      -- 同一个人、同一个 skill，窗口内只算一次。agent 跑一轮会发好几次请求，
      -- 而 skill 内容一旦加载就留在后续每一次的上下文里——不去重的话，用户说
      -- 一句话会被计成五六次（实测一轮 6 步计了 5 次）。
      AND NOT EXISTS (
        SELECT 1 FROM plugin_earnings prior JOIN requests pr ON pr.id=prior.request_id
        WHERE prior.kind='invocation' AND prior.skill_ref=s.skill_ref AND pr.user_id=r.user_id
          AND prior.created_at > now() - ($3 || ' minutes')::interval)
    ON CONFLICT DO NOTHING`, [requestId, refs, String(windowMinutes)]);

  // 没登记的照样记一笔观测：不计钱，但要看得见。有人在大量用一个还没上架的 skill，
  // 那正是该去谈合作的线索——静默丢掉就等于这条线索从来没出现过。
  await c.query(`INSERT INTO skill_sightings (skill_ref,sightings) 
    SELECT ref,1 FROM unnest($1::text[]) AS ref
    WHERE NOT EXISTS (SELECT 1 FROM plugin_skills s WHERE s.skill_ref=ref)
    ON CONFLICT (skill_ref) DO UPDATE SET sightings=skill_sightings.sightings+1,last_seen=now()`, [refs]);
  return inserted.rowCount;
}

/**
 * 一笔请求结算之后计提作者分成。同一笔只会有一行（唯一索引兜底）。
 *
 * 两种计价，**由插件自己配的单价决定走哪条**：
 *
 *   price_per_call_cny > 0  → 按次：一次调用一个固定价，和这一单收了多少钱无关。
 *                              适合「一次调用就是一件完整的活」——生图、生视频。
 *   price_per_call_cny = 0  → 按比例：实扣 × 分成比例。用户付得多作者分得多，
 *                              4K 图比 1K 图贵，作者跟着多拿。
 *
 * 两种都留着是因为它们各有道理，而哪种合适是**商业判断不是技术判断**：
 * 按次让作者收入可预测，按比例让作者跟着用户的消费走。配哪个由运营定，
 * 代码不替他们选。
 *
 * 比例那条要求 `charged-refunded > 0`：没收到钱就没有可分的。按次那条不看金额，
 * 但仍然要求这一单**结算过**——没跑成的调用不该给作者记一笔。
 */
export async function accrueEarning(c, requestId) {
  await c.query(`INSERT INTO plugin_earnings (id,request_id,owner_user_id,plugin_id,kind,amount_cny)
    SELECT $2,r.id,r.plugin_owner_user_id,r.plugin_id,'accrual',
      CASE WHEN p.price_per_call_cny > 0 THEN p.price_per_call_cny
           ELSE round((b.charged_cny-b.refunded_cny)*r.plugin_share_bps/10000,8) END
    FROM requests r JOIN request_billing b ON b.request_id=r.id JOIN plugins p ON p.id=r.plugin_id
    WHERE r.id=$1 AND r.plugin_owner_user_id IS NOT NULL AND b.state='settled'
      AND (p.price_per_call_cny > 0
           OR (coalesce(r.plugin_share_bps,0)>0 AND (b.charged_cny-b.refunded_cny)>0))
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

  // ── skill 登记与单价 ─────────────────────────────────────────────────────
  // 分成的前提是登记过：本地随手放的 skill 照常能用，只是不产生任何计提。

  // 被用过但还没登记的 skill：招募作者的线索表。
  app.get('/admin/api/skill-sightings',async()=>({
    rows:(await db.query(`SELECT * FROM skill_sightings ORDER BY sightings DESC, last_seen DESC LIMIT 100`)).rows,
  }));

  app.get('/admin/api/plugin-skills',async()=>({
    rows:(await db.query(`SELECT s.skill_ref,s.display_name,s.created_at,p.id AS plugin_id,p.name AS plugin_name,
      p.price_per_call_cny,d.display_name AS owner_name,
      (SELECT count(*)::int FROM plugin_earnings e WHERE e.skill_ref=s.skill_ref AND e.kind='invocation') AS invocations,
      (SELECT coalesce(sum(e.amount_cny),0) FROM plugin_earnings e WHERE e.skill_ref=s.skill_ref AND e.kind='invocation') AS accrued_cny
      FROM plugin_skills s JOIN plugins p ON p.id=s.plugin_id
      LEFT JOIN developer_profiles d ON d.user_id=p.owner_user_id ORDER BY s.skill_ref`)).rows,
  }));

  app.post('/admin/api/plugin-skills',async(req)=>{
    const ref=req.body?.skill_ref;
    if(typeof ref!=='string'||!/^[A-Za-z0-9._-]{1,200}$/.test(ref))throw httpError(400,'invalid_skill_ref');
    const pluginId=uuid(req.body?.plugin_id);
    const name=String(req.body?.display_name??'').slice(0,200);
    return db.tx(async(c)=>{
      const plugin=(await c.query('SELECT id,owner_user_id FROM plugins WHERE id=$1',[pluginId])).rows[0];
      if(!plugin)throw httpError(404,'plugin_not_found');
      // 首次登记确权，之后只能改显示名——归属不能被后来的请求或改名悄悄挪走。
      await c.query(`INSERT INTO plugin_skills (skill_ref,plugin_id,display_name) VALUES ($1,$2,$3)
        ON CONFLICT (skill_ref) DO UPDATE SET display_name=EXCLUDED.display_name`,[ref,pluginId,name]);
      const row=(await c.query('SELECT * FROM plugin_skills WHERE skill_ref=$1',[ref])).rows[0];
      if(row.plugin_id!==pluginId)throw httpError(409,'skill_already_owned');
      await c.query('INSERT INTO audit_events(action,target_id,administrator_id,details) VALUES($1,$2,$3,$4)',
        ['plugin_skill.register',pluginId,req.administrator.id,JSON.stringify({skill_ref:ref})]);
      return row;
    });
  });

  app.post('/admin/api/plugins/:id/call-price',async(req)=>{
    const id=uuid(req.params.id),price=req.body?.price_per_call_cny;
    if(typeof price!=='string'||!/^(0|[1-9]\d{0,4})(\.\d{1,8})?$/.test(price))throw httpError(400,'invalid_price');
    return db.tx(async(c)=>{
      // 改价**只影响之后的调用**：已经记下的计提是当时那个价，不回溯。
      const r=await c.query('UPDATE plugins SET price_per_call_cny=$2 WHERE id=$1 RETURNING price_per_call_cny',[id,price]);
      if(!r.rowCount)throw httpError(404,'plugin_not_found');
      await c.query('INSERT INTO audit_events(action,target_id,administrator_id,details) VALUES($1,$2,$3,$4)',
        ['plugin.call_price',id,req.administrator.id,JSON.stringify({price_per_call_cny:price})]);
      return r.rows[0];
    });
  });

  // ── 结算单 ───────────────────────────────────────────────────────────────
  // 打款是人工的，这里只做**凭据**：把一段时间内还没归属的计提圈成一张单，
  // 冻结锁金额，打完款登记。作废会把计提释放回去，可以重新出单。

  app.get('/admin/api/settlements',async(req)=>{
    const owner=req.query.owner_user_id?uuid(req.query.owner_user_id):null;
    const rows=(await db.query(`SELECT s.*,s.period_from::text AS period_from,s.period_to::text AS period_to,
      d.display_name AS owner_name FROM settlements s
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
    const row=(await db.query(`SELECT s.*,s.period_from::text AS period_from,s.period_to::text AS period_to
      FROM settlements s WHERE id=$1`,[id])).rows[0];
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
    rows:(await db.query(`SELECT id,period_from::text AS period_from,period_to::text AS period_to,state,amount_cny,item_count,paid_at,frozen_at,created_at
      FROM settlements WHERE owner_user_id=$1 AND state<>'void' ORDER BY created_at DESC LIMIT 50`,[req.apiUser.id])).rows,
    pending:(await db.query(`SELECT coalesce(sum(amount_cny),0) AS amount_cny,count(*)::int AS item_count
      FROM plugin_earnings WHERE owner_user_id=$1 AND settlement_id IS NULL`,[req.apiUser.id])).rows[0],
  }));
}
