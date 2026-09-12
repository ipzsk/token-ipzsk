import { units, decimal } from './billing.mjs';
import { creditAccount, provisionIfEnabled } from './lanehub.mjs';

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
  const denominator = BigInt(quotaPerUnit);
  const scaled = BigInt(quota) * units(String(usdCnyRate));
  return decimal((scaled + denominator / 2n) / denominator);
}

/**
 * 把一条已完成的请求的扣费补记成 request_billing 行。**幂等**：主键是 request_id，
 * 冲突就跳过（这一侧的预扣路径写过行的，也不会被覆盖）。
 *
 * 查不到日志有两种情况，必须分开：请求失败根本没扣过钱（写 released，终止重试），
 * 和日志还没落库（什么都不做，下一轮再来）。不分开的话，前者会被永远重查。
 */
export async function recordLanehubCharge(db, lanehub, row, { usdCnyRate, quotaPerUnit, staleAfterMs = 600_000 }) {
  const page = await lanehub.call('/api/log/?request_id=' + encodeURIComponent(row.upstream_id) + '&size=20');
  const logs = (Array.isArray(page) ? page : page?.data ?? []).filter((log) => log.type === LOG_TYPE_CONSUME);
  if (!logs.length) {
    const stale = Date.now() - new Date(row.completed_at).getTime() > staleAfterMs;
    if (!stale) return 'pending';
    await db.query(`INSERT INTO request_billing (request_id,user_id,state,reserved_cny,charged_cny,price_snapshot,reason,resolved_at)
      VALUES ($1,$2,'released',0,0,$3,'lanehub_no_charge',now()) ON CONFLICT (request_id) DO NOTHING`,
    [row.id, row.user_id, JSON.stringify({ source: 'lanehub', request_id: row.upstream_id })]);
    return 'released';
  }
  // 一个 request_id 理论上只有一条消费日志；真出现多条（重试写了两次）就按总和算，
  // 取第一条会少收。
  const quota = logs.reduce((sum, log) => sum + Number(log.quota ?? 0), 0);
  // 汇率以对面为准（它就是按这个数把 quota 算出来的），配的那个只兜底——
  // 实测两边差过 4%（配 7 / 对面 6.7078），而作者的分成正是按这个金额分的。
  const rate = await lanehub.usdRate().catch(() => usdCnyRate);
  const amount = quotaToCny(quota, rate, quotaPerUnit);
  await db.query(`INSERT INTO request_billing (request_id,user_id,state,reserved_cny,charged_cny,price_snapshot,reason,resolved_at)
    VALUES ($1,$2,'settled',$3,$3,$4,'lanehub',now()) ON CONFLICT (request_id) DO NOTHING`,
  [row.id, row.user_id, amount, JSON.stringify({ source: 'lanehub', request_id: row.upstream_id,
    quota, usd_cny: String(rate), quota_per_unit: quotaPerUnit, model: row.model })]);
  return 'settled';
}

/**
 * 扫一批还没有账单行的 lanehub 请求，补记扣费。和余额刷新挂在同一个定时器上。
 *
 * 媒体任务要等它走到终态才查：lanehub 那边任务失败会退费，中途查到的数字会被退掉。
 */
export async function reconcileLanehubCharges(db, lanehub, options) {
  const { rows } = await db.query(`SELECT r.id,r.user_id,r.model,r.upstream_id,r.completed_at FROM requests r
    JOIN upstream_keys k ON k.id=r.key_id JOIN upstream_accounts a ON a.id=k.account_id
    LEFT JOIN media_tasks t ON t.id=r.id LEFT JOIN request_billing b ON b.request_id=r.id
    WHERE a.provider_type='lanehub' AND b.request_id IS NULL AND r.upstream_id IS NOT NULL
      AND r.completed_at IS NOT NULL AND r.completed_at < now()-interval '30 seconds'
      AND (t.id IS NULL OR t.status IN ('completed','failed','cancelled'))
    ORDER BY r.completed_at LIMIT 20`);
  let settled = 0, released = 0, failed = 0;
  for (const row of rows) {
    try {
      const outcome = await recordLanehubCharge(db, lanehub, row, options);
      if (outcome === 'settled') settled++; else if (outcome === 'released') released++;
    } catch { failed++; }
  }
  return { scanned: rows.length, settled, released, failed };
}

/**
 * 充值补账：兑换码的钱写在这一侧的 wallet_entries 上，而 lanehub 模式下客户花的是
 * lanehub 的额度——不搬过去，那笔钱就躺在一个花不掉的钱包里。
 *
 * 幂等键是 `voucher:<兑换码 id>`，所以兑换当场调一次、这里再扫一次，都只会入账一次。
 * 兑换成功后的那次调用失败（lanehub 抖一下）时，这个扫描就是唯一的补救。
 */
export async function reconcileLanehubTopups(db, lanehub, options, provision) {
  const { rows } = await db.query(`SELECT e.id,e.user_id,e.voucher_id,e.amount_cny,u.name FROM wallet_entries e
    JOIN users u ON u.id=e.user_id
    LEFT JOIN lanehub_credits c ON c.reference='voucher:'||e.voucher_id
    WHERE e.voucher_id IS NOT NULL AND c.reference IS NULL ORDER BY e.created_at LIMIT 20`);
  let applied = 0, failed = 0;
  for (const row of rows) {
    try {
      const account = await provision({ userId: row.user_id, name: row.name });
      if (!account) break;               // 开关关着，这整件事就不该发生
      const result = await creditAccount(db, lanehub, {
        userId: row.user_id, lanehubUserId: account.lanehub_user_id, amountCny: row.amount_cny,
        usdCnyRate: await lanehub.usdRate().catch(() => options.usdCnyRate), quotaPerUnit: options.quotaPerUnit,
        reference: 'voucher:' + row.voucher_id, remark: '兑换码充值',
      });
      if (result.applied) applied++;
    } catch { failed++; }
  }
  return { scanned: rows.length, applied, failed };
}

/** 客户在 lanehub 的余额，折成人民币。lanehub 模式下这才是他真正能花的钱。 */
export async function lanehubBalance(lanehub, account, { usdCnyRate, quotaPerUnit }) {
  const quota = Number((await lanehub.balance(account.lanehub_user_id))?.quota ?? 0);
  const rate = await lanehub.usdRate().catch(() => usdCnyRate);
  const amount = quotaToCny(Math.max(0, Math.trunc(quota)), rate, quotaPerUnit);
  // lanehub 不冻结额度（这一侧也不再预扣），所以可用 = 余额。
  return { balance_cny: amount, frozen_cny: '0.00000000', available_cny: amount };
}

/** 兑换成功后立刻把钱搬到 lanehub。失败不抛——扫描会补，兑换本身已经成立。 */
export async function creditVoucher(db, lanehub, options, { userId, name, voucherId, amountCny }) {
  const account = await provisionIfEnabled(db, options, { userId, name });
  if (!account) return { applied: false, quota: 0 };
  return creditAccount(db, lanehub, {
    userId, lanehubUserId: account.lanehub_user_id, amountCny,
    usdCnyRate: await lanehub.usdRate().catch(() => options.lanehubUsdCny), quotaPerUnit: options.lanehubQuotaPerUnit,
    reference: 'voucher:' + voucherId, remark: '兑换码充值',
  });
}
