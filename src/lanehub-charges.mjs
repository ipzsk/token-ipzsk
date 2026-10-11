import { units, decimal } from './billing.mjs';
import { accrueEarning } from './earnings.mjs';

// lanehub 模式下这一侧**不预扣也不扣钱**——钱是 lanehub 从客户自己的额度里扣的。
// 但「这单收了多少」仍然必须回到这一侧：插件作者的分成口径
// （developers.mjs / plugins.mjs）读的是 request_billing.charged_cny，
// 没有这张表的行，作者收益永远是 0，而那正是我们要卖的东西。
//
// 数据来源是 lanehub 的消费日志，按 request_id 反查——这一侧早就把 lanehub 回的
// `X-Oneapi-Request-Id` 存进了 requests.upstream_id，两边对得上，不用改 lanehub。
// 日志里的 quota 是 lanehub 的内部单位（1 美元 = QuotaPerUnit），折算成人民币入库，
// 同时把 quota 原值留在 price_snapshot 里：以后汇率口径改了还能按原值重算。

const LOG_TYPE_CONSUME = 2;

/** quota → 人民币（8 位小数，四舍五入）。折算参数一并留痕，不留就没法复核。 */
export function quotaToCny(quota, usdCnyRate, quotaPerUnit) {
  if (!Number.isSafeInteger(quota) || quota < 0 || !Number.isSafeInteger(quotaPerUnit) || quotaPerUnit <= 0 ||
      !/^(0|[1-9]\d*)(\.\d{1,8})?$/.test(String(usdCnyRate)) || units(String(usdCnyRate)) <= 0n)
    throw new Error('invalid_lanehub_money');
  const denominator = BigInt(quotaPerUnit);
  const scaled = BigInt(quota) * units(String(usdCnyRate));
  return decimal((scaled + denominator / 2n) / denominator);
}

/**
 * 把一条已完成的请求的扣费补记成 request_billing 行。**幂等**：主键是 request_id，
 * 冲突就跳过（这一侧的预扣路径写过行的，也不会被覆盖）。
 *
 * 已确认失败的媒体任务记 released；仅仅查不到日志则保留待核对。
 */
// 账单行落定后同步到生成记录（点 = 元 × 100，numeric 精确运算）。没有记录的请求是 no-op。
export async function syncChargedPoints(db, requestId) {
  await db.query(`UPDATE generation_records g SET charged_points=b.charged_cny*100,updated_at=now() FROM request_billing b
    WHERE b.request_id=$1 AND g.request_id=$1 AND g.charged_points IS DISTINCT FROM b.charged_cny*100 AND b.charged_cny IS NOT NULL`, [requestId]);
}

export async function recordLanehubCharge(db, lanehub, row, options) {
  const outcome = await recordLanehubBilling(db, lanehub, row, options);
  if (outcome !== 'pending') await syncChargedPoints(db, row.id);
  return outcome;
}

async function recordLanehubBilling(db, lanehub, row, { usdCnyRate, quotaPerUnit }) {
  // 任务失败/取消时 lanehub 已经把钱退给用户了，但它退款写的是一条**系统日志**，
  // 原来那条消费日志还在、quota 还是全额。照着日志记账会把一笔已退款的失败任务
  // 算成正常收入，还据此给插件作者计提分成——用户的钱退了，账面却还在。
  // 所以失败的任务根本不去查日志，直接落 released。
  if (['failed', 'cancelled'].includes(row.task_status)) {
    await db.query(`INSERT INTO request_billing (request_id,user_id,state,reserved_cny,charged_cny,price_snapshot,reason,resolved_at)
      VALUES ($1,$2,'released',0,0,$3,'lanehub_task_refunded',now()) ON CONFLICT (request_id) DO NOTHING`,
    [row.id, row.user_id, JSON.stringify({ source: 'lanehub', request_id: row.upstream_id, task_status: row.task_status })]);
    return 'released';
  }
  const page = await lanehub.call('/api/log/?request_id=' + encodeURIComponent(row.upstream_id) + '&size=20');
  const entries = Array.isArray(page) ? page : page?.data;
  const total = page?.total_count ?? entries?.length;
  if (!Array.isArray(entries) || !Number.isSafeInteger(total) || total !== entries.length ||
      (entries.length >= 20 && page?.total_count === undefined))
    throw new Error('lanehub_log_page_incomplete');
  const logs = entries.filter((log) => log.type === LOG_TYPE_CONSUME);
  // Log absence is not a receipt for zero cost or zero charge, even after a long delay.
  if (!logs.length) return 'pending';
  if (logs.some(log => (log.request_id !== undefined && log.request_id !== row.upstream_id) ||
      !Number.isSafeInteger(log.quota) || log.quota < 0)) throw new Error('invalid_lanehub_receipt');
  const ids = logs.filter(log => log.id !== undefined).map(log => log.id);
  if (new Set(ids).size !== ids.length) throw new Error('duplicate_lanehub_receipt');
  // 一个 request_id 理论上只有一条消费日志；真出现多条（重试写了两次）就按总和算，
  // 取第一条会少收。
  const quota = logs.reduce((sum, log) => sum + Number(log.quota ?? 0), 0);
  // 汇率以对面为准（它就是按这个数把 quota 算出来的），配的那个只兜底——
  // 实测两边差过 4%（配 7 / 对面 6.7078），而作者的分成正是按这个金额分的。
  const rate = await lanehub.usdRate().catch(() => usdCnyRate);
  if (!Number.isSafeInteger(quota)) throw new Error('invalid_lanehub_money');
  // 账单和作者计提写在同一个事务里：分开写就会出现「扣了钱但没计提」的窗口，
  // 而那个窗口里出的结算单会漏掉这笔。
  await db.tx(async (c) => {
    await c.query('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE', [row.user_id]);
    const previous = (await c.query('SELECT * FROM request_billing WHERE request_id=$1 FOR UPDATE', [row.id])).rows[0];
    const account = (await c.query('SELECT lanehub_user_id FROM lanehub_accounts WHERE user_id=$1', [row.user_id])).rows[0];
    if (account && logs.some(log => log.user_id !== undefined && log.user_id !== account.lanehub_user_id))
      throw new Error('lanehub_receipt_user_mismatch');
    const snapshot = previous?.state === 'settled' ? previous.price_snapshot : null;
    if (snapshot && (snapshot.source !== 'lanehub' || snapshot.quota !== quota)) {
      await c.query("UPDATE request_billing SET reason='lanehub_receipt_changed' WHERE request_id=$1", [row.id]);
      return;
    }
    const receiptRate = snapshot?.usd_cny ?? rate, receiptUnit = snapshot?.quota_per_unit ?? quotaPerUnit;
    const amount = quotaToCny(quota, receiptRate, receiptUnit);
    const real = account && logs.every(log => log.user_id === account.lanehub_user_id && log.cost_source === 'real' && log.request_id === row.upstream_id &&
      Number.isSafeInteger(log.id) && log.id > 0 && Number.isSafeInteger(log.cost_quota) && log.cost_quota >= 0);
    if (real) {
      const cost = quotaToCny(logs.reduce((sum, log) => sum + log.cost_quota, 0), receiptRate, receiptUnit);
      const reference = `lanehub:${row.upstream_id}:logs:${ids.join(',')}`;
      const saved = await c.query(`UPDATE requests SET cost_cny=$2,cost_reference=$3,cost_recorded_at=now()
        WHERE id=$1 AND cost_cny IS NULL AND EXISTS(SELECT 1 FROM upstream_keys k JOIN upstream_accounts a ON a.id=k.account_id
          WHERE k.id=requests.key_id AND a.provider_type='lanehub') RETURNING id`, [row.id, cost, reference]);
      if (saved.rowCount) await c.query('INSERT INTO audit_events(action,target_id,details) VALUES($1,$2,$3)',
        ['request.cost.sync', row.id, JSON.stringify({ source: reference, cost_cny: cost, usd_cny: String(receiptRate), quota_per_unit: receiptUnit,
          receipts: logs.map(log => ({ id: log.id, cost_quota: log.cost_quota, cost_source: log.cost_source })) })]);
    }
    if (previous?.reason === 'lanehub_no_charge' && previous.state === 'released')
      await c.query(`UPDATE commission_requests SET charged_cny=NULL,paid_cny=NULL,state='pending_billing'
        WHERE request_id=$1 AND charged_cny=0 AND NOT EXISTS(SELECT 1 FROM commission_allocations WHERE request_id=$1)
          AND NOT EXISTS(SELECT 1 FROM commission_ledger WHERE request_id=$1) AND state<>'historical_sources_review'`, [row.id]);
    await c.query(`INSERT INTO request_billing (request_id,user_id,state,reserved_cny,charged_cny,price_snapshot,reason,resolved_at)
      VALUES ($1,$2,'settled',$3,$3,$4,'lanehub',now()) ON CONFLICT (request_id) DO UPDATE
        SET state='settled',reserved_cny=EXCLUDED.reserved_cny,charged_cny=EXCLUDED.charged_cny,
          price_snapshot=EXCLUDED.price_snapshot,reason='lanehub',resolved_at=now()
        WHERE request_billing.state='released' AND request_billing.reason='lanehub_no_charge'
          AND request_billing.charged_cny=0 AND request_billing.refunded_cny=0`,
    [row.id, row.user_id, amount, JSON.stringify({ source: 'lanehub', request_id: row.upstream_id,
      quota, usd_cny: String(receiptRate), quota_per_unit: receiptUnit, model: row.model })]);
    await accrueEarning(c, row.id);
  });
  return 'settled';
}

/**
 * 补记扣费并重查实际成本尚未到达的账单，和余额刷新挂在同一个定时器上。
 *
 * 媒体任务要等它走到终态才查：lanehub 那边任务失败会退费，中途查到的数字会被退掉。
 *
 * 一轮按 (completed_at,id) 游标往后翻，把能处理的都处理掉，不再每轮只取 20 条：
 * 按上次核对时间轮转，未知成本不会长期占据队首、阻挡新账单。
 */
export async function reconcileLanehubCharges(db, lanehub, options, { batchSize = 100, maxRows = 1000 } = {}) {
  let settled = 0, released = 0, failed = 0, scanned = 0;
  let cursorAt = null, cursorId = null;
  const scanUntil = (await db.query('SELECT clock_timestamp() AS scan_until')).rows[0].scan_until;
  while (scanned < maxRows) {
    const rows = (await db.query(`SELECT r.id,r.user_id,r.model,r.upstream_id,r.completed_at,t.status AS task_status,
      coalesce(r.lanehub_reconciled_at,r.completed_at) AS checked_at FROM requests r
      JOIN upstream_keys k ON k.id=r.key_id JOIN upstream_accounts a ON a.id=k.account_id
      LEFT JOIN media_tasks t ON t.id=r.id LEFT JOIN request_billing b ON b.request_id=r.id
      WHERE a.provider_type='lanehub' AND (b.request_id IS NULL OR (b.state='settled' AND r.cost_cny IS NULL)
          OR (b.state='released' AND b.reason='lanehub_no_charge')) AND r.upstream_id IS NOT NULL
        AND r.completed_at IS NOT NULL AND r.completed_at < now()-interval '30 seconds'
        AND (t.id IS NULL OR t.status IN ('completed','failed','cancelled'))
        AND coalesce(r.lanehub_reconciled_at,r.completed_at)<$4::timestamptz
        AND ($1::timestamptz IS NULL OR (coalesce(r.lanehub_reconciled_at,r.completed_at),r.id) > ($1::timestamptz,$2::uuid))
      ORDER BY coalesce(r.lanehub_reconciled_at,r.completed_at),r.id LIMIT $3`, [cursorAt, cursorId, Math.min(batchSize,maxRows-scanned), scanUntil])).rows;
    if (!rows.length) break;
    scanned += rows.length;
    for (const row of rows) {
      cursorAt = row.checked_at; cursorId = row.id;
      try {
        const outcome = await recordLanehubCharge(db, lanehub, row, options);
        if (outcome === 'settled') settled++; else if (outcome === 'released') released++;
      } catch { failed++; }
      await db.query('UPDATE requests SET lanehub_reconciled_at=clock_timestamp() WHERE id=$1', [row.id]);
    }
    if (rows.length < batchSize) break;
  }
  return { scanned, settled, released, failed };
}

/** 客户在 lanehub 的余额，折成人民币。lanehub 模式下这才是他真正能花的钱。 */
export async function lanehubBalance(lanehub, account, { usdCnyRate, quotaPerUnit }) {
  const quota = Number((await lanehub.balance(account.lanehub_user_id))?.quota ?? 0);
  const rate = await lanehub.usdRate().catch(() => usdCnyRate);
  const amount = quotaToCny(Math.max(0, Math.trunc(quota)), rate, quotaPerUnit);
  // lanehub 不冻结额度（这一侧也不再预扣），所以可用 = 余额。
  return { balance_cny: amount, frozen_cny: '0.00000000', available_cny: amount };
}
