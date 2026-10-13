import { httpError } from './security.mjs';
import { applyAdjustment, sweepAdjustments } from './lanehub.mjs';
import { admin, audit, note, bookPaymentRefundAdjustment, releasePaymentRefundAdjustment } from './commissions.mjs';
import { bookServiceRefund } from './earnings.mjs';

// lanehub 额度调整的人工核对与补账。状态机本体见 lanehub.mjs。
//
// review 的行只有超级管理员能处理，并且必须先到 lanehub 后台核对该用户的额度日志：
//   applied   对面已生效：标记生效，随后落本地账（退款类）
//   retry     对面确认未生效：放回 pending 并立即重试一次；结果再未知则重新进入 review
//   cancel    对面确认未生效且不再执行：终止；充值退款预留的本金退回
// pending（远程调用尚未开始）不需要人工：后台 finalizeAdjustments 会接手执行；管理员也可直接终止。
// 未核对就选 retry 等于重复加/扣额度，界面与审计都要求填写核对依据。

const bookers = { service_refund: bookServiceRefund, payment_refund: bookPaymentRefundAdjustment };

async function book(db, reference, books = bookers) {
  const row = (await db.query('SELECT payload FROM lanehub_credits WHERE reference=$1', [reference])).rows[0];
  const booker = books[row?.payload?.booking];
  if (booker) await db.tx(c => booker(c, reference));
}

/**
 * 后台循环，三件事，都不会重放已发出的远程调用：
 *   1. applying 超时转 review（结果未知，只能人工核对）
 *   2. pending 超过宽限期（本地占位已提交、进程在调用对面之前退出）由 applyAdjustment 以 CAS
 *      （pending → applying）接手：远程调用尚未开始，执行一次是安全的；并发的另一处接手会 CAS 失败。
 *      宽限期让正常路径（接口自己提交后立即调用）先执行。没有 lanehub 客户端时不执行。
 *   3. 已生效未落账的退款补落账（booked_at 幂等）
 */
export async function finalizeAdjustments(db, lanehub, { books = bookers, graceSeconds = 60 } = {}) {
  await sweepAdjustments(db);
  if (lanehub) {
    const pending = (await db.query(`SELECT reference FROM lanehub_credits WHERE state='pending' AND lanehub_user_id IS NOT NULL
      AND updated_at<now()-make_interval(secs=>$1) ORDER BY updated_at LIMIT 20`, [graceSeconds])).rows;
    for (const { reference } of pending) await applyAdjustment(db, lanehub, reference).catch(() => {});
  }
  const rows = (await db.query(`SELECT reference FROM lanehub_credits WHERE state='applied' AND booked_at IS NULL
    AND payload ? 'booking' ORDER BY updated_at LIMIT 20`)).rows;
  for (const { reference } of rows) await book(db, reference, books).catch(() => {});
}

export function lanehubAdjustmentRoutes(app, { db, lanehub }) {
  app.get('/admin/api/lanehub-adjustments', async req => {
    admin(req);
    return { rows: (await db.query(`SELECT reference,kind,user_id,lanehub_user_id,amount_cny,quota,state,review_reason,payload,
      created_at,updated_at,applied_at,booked_at FROM lanehub_credits
      WHERE state IN ('pending','applying','review') OR (state='applied' AND booked_at IS NULL)
      ORDER BY created_at LIMIT 200`)).rows };
  });
  app.post('/admin/api/lanehub-adjustments/resolve', async req => {
    admin(req);
    const reference = req.body?.reference, result = req.body?.result, why = note(req.body?.reason);
    if (typeof reference !== 'string' || !reference || reference.length > 600) throw httpError(400, 'invalid_reference');
    if (!['applied', 'retry', 'cancel'].includes(result)) throw httpError(400, 'invalid_adjustment_resolution');
    if (result === 'retry' && !lanehub) throw httpError(503, 'lanehub_unavailable');
    await db.tx(async c => {
      const found = (await c.query('SELECT user_id,payload FROM lanehub_credits WHERE reference=$1', [reference])).rows[0];
      if (!found) throw httpError(404, 'not_found');
      // 与退款接口同一加锁顺序。
      if (found.payload?.booking === 'payment_refund')
        await c.query('SELECT id FROM payment_orders WHERE id=$1 FOR UPDATE', [found.payload.payment_order_id]);
      await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [found.user_id]);
      const row = (await c.query('SELECT * FROM lanehub_credits WHERE reference=$1 FOR UPDATE', [reference])).rows[0];
      // pending 只允许终止（重试与确认生效没有意义：远程尚未开始，后台会自行执行）。
      if (row.state !== 'review' && !(row.state === 'pending' && result === 'cancel')) throw httpError(409, 'adjustment_not_in_review');
      // 迁移前遗留的行没有记录 lanehub 用户，无法安全重试，只能确认生效或终止。
      if (result === 'retry' && !row.lanehub_user_id) throw httpError(409, 'adjustment_target_unknown');
      if (result === 'applied') await c.query(`UPDATE lanehub_credits SET state='applied',applied_at=now(),updated_at=now(),
        booked_at=CASE WHEN payload ? 'booking' THEN NULL ELSE now() END WHERE reference=$1`, [reference]);
      else if (result === 'retry') await c.query("UPDATE lanehub_credits SET state='pending',updated_at=now() WHERE reference=$1", [reference]);
      else {
        await c.query("UPDATE lanehub_credits SET state='cancelled',updated_at=now() WHERE reference=$1", [reference]);
        if (row.payload?.booking === 'payment_refund') await releasePaymentRefundAdjustment(c, row);
      }
      await audit(c, req, 'lanehub.adjustment.resolve', reference, { result, reason: why, kind: row.kind,
        amount_cny: row.amount_cny, quota: row.quota, previous_review_reason: row.review_reason });
    });
    if (result === 'retry') await applyAdjustment(db, lanehub, reference);
    await book(db, reference);
    return (await db.query('SELECT reference,state,review_reason,applied_at,booked_at FROM lanehub_credits WHERE reference=$1', [reference])).rows[0];
  });
}
