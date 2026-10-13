import { randomUUID } from 'node:crypto';
import { httpError } from './security.mjs';

// 补发余额的幂等键是**永久**的：同一管理员、同一 key、同一参数永远落到同一笔 grant；参数不同永远冲突。
// 不能像案例创建那样 24 小时后滚动成新记录——LaneHub 结果未知的补发要等人工核对，核对完用原 key 重提
// 补本地流水；key 若已滚动成新 grant，就会再加一次额度。
// 键存成 `wallet-grant:<key>`，与案例创建的 key 分开；案例的 24 小时滚动显式跳过这个前缀。
const GRANT_PREFIX = 'wallet-grant:';
export const grantKey = key => GRANT_PREFIX + key;
// 非补发路径（案例创建）共用 admin_idempotency 时必须拒绝这个保留前缀：否则先用 `wallet-grant:g1` 建案例，
// 就会占住补发 key `g1` 的那一行，让真实补发永远冲突。
export const reservedIdempotencyKey = key => typeof key === 'string' && key.startsWith(GRANT_PREFIX);

export async function claimWalletGrant(db, actor, key, fingerprint) {
  await db.query(`INSERT INTO admin_idempotency(user_id,key,fingerprint,case_id) VALUES($1,$2,$3,$4)
    ON CONFLICT (user_id,key) DO NOTHING`, [actor, grantKey(key), fingerprint, randomUUID()]);
  const claim = (await db.query('SELECT fingerprint,case_id FROM admin_idempotency WHERE user_id=$1 AND key=$2', [actor, grantKey(key)])).rows[0];
  if (claim.fingerprint !== fingerprint) throw httpError(409, 'idempotency_conflict');
  return claim.case_id;
}
