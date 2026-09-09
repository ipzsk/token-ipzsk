import { settleMediaRequest } from './billing.mjs';

// This account's APIMart credits are CNY, as confirmed by the account owner.
// `cost` is a different unit; never substitute it for `credits_cost`.
export async function recordTaskCharge(db, task, data) {
  if (data?.id !== task.upstream_task_id || !['completed','failed','cancelled'].includes(data.status) ||
      typeof data.credits_cost !== 'number' || !Number.isFinite(data.credits_cost) ||
      data.credits_cost < 0 || data.credits_cost > Number.MAX_SAFE_INTEGER) return false;
  const amount = String(data.credits_cost);
  const reference = `apimart:task:${task.upstream_task_id}:credits_cost`;
  return db.tx(async (c) => {
    const saved = await c.query(`UPDATE requests SET cost_cny=$2,cost_reference=$3,cost_recorded_at=now()
      WHERE id=$1 AND cost_cny IS NULL RETURNING id`, [task.id,amount,reference]);
    if (!saved.rowCount) return false;
    await c.query('INSERT INTO audit_events(action,target_id,details) VALUES($1,$2,$3)',
      ['request.cost.sync',task.id,JSON.stringify({cost_cny:amount,source:reference})]);
    // The user-side charge settles in the same transaction as the upstream cost; the two amounts stay separate.
    await settleMediaRequest(c,task.id,data.status);
    return true;
  });
}
