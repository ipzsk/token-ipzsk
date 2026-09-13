#!/usr/bin/env node
/**
 * 把现有客户的余额迁到 lanehub 的额度上。
 *
 * **这个脚本必须能重跑而不重复加钱。** 幂等键是 `migrate:<批次>:<客户 id>`：
 * 同一个批次跑第二遍时，`lanehub_credits` 的主键冲突会让那一条直接跳过。
 * 换一个批次号就是真的再加一次——所以批次号要写进运行记录，不要随手改。
 *
 * 顺序是刻意的：先建号（幂等），再入账（幂等）。反过来的话，入账时还没有 lanehub
 * 用户，只能一边建一边加，中途失败会留下「建了号没入账」且看不出来的状态。
 *
 *   node scripts/lanehub-migrate.mjs --batch 2026-09-11 [--apply] [--only <user_id>]
 *
 * 不加 --apply 只打印会发生什么。**默认不写任何东西。**
 */
import { databaseFromEnv } from '../src/database.mjs';
import { wallet } from '../src/billing.mjs';
import { Upstream } from '../src/upstream.mjs';
import { Lanehub, ensureAccount, creditAccount, adminTokenFromEnv } from '../src/lanehub.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf('--' + name);
  return at < 0 ? fallback : args[at + 1];
};
const apply = args.includes('--apply');
const batch = flag('batch');
const only = flag('only');

if (!batch) {
  console.error('必须指定 --batch（幂等键的一部分）。同一个批次重跑不会重复加钱，换批次会。');
  process.exit(2);
}

const env = (name, fallback) => process.env[name] ?? fallback;
const baseUrl = env('LANEHUB_BASE_URL');
const adminToken = await adminTokenFromEnv();
const accountId = env('LANEHUB_ACCOUNT_ID');
const usdCny = Number(env('LANEHUB_USD_CNY', '0'));
const quotaPerUnit = Number(env('LANEHUB_QUOTA_PER_UNIT', '500000'));

if (!baseUrl || !adminToken || !accountId) {
  console.error('需要 LANEHUB_BASE_URL / LANEHUB_ADMIN_TOKEN / LANEHUB_ACCOUNT_ID');
  process.exit(2);
}
// 汇率必须显式给：用请求时抓到的汇率迁移历史余额，会让同一批客户按不同汇率折算。
if (!(usdCny > 0)) {
  console.error('需要 LANEHUB_USD_CNY（迁移用的折算汇率，显式指定，不从对面实时取）');
  process.exit(2);
}

const db = await databaseFromEnv();
const upstream = new Upstream(db, env('SECRET_DIR', './secrets'));
const lanehub = new Lanehub({ baseUrl, adminToken });

// 余额口径复用 billing.wallet()：它算的是 credit - debit - held。
// 自己再写一遍 SQL 就是第二份口径，而这两份只要差一点，迁过去的钱就对不上。
const users = (await db.query(`SELECT id,name FROM users WHERE enabled ${only ? 'AND id=$1' : ''} ORDER BY created_at`,
  only ? [only] : [])).rows;
const rows = [];
for (const user of users) {
  const balance = await wallet(db, user.id);
  rows.push({ ...user, available_cny: balance.available_cny });
}

let planned = 0, applied = 0, skipped = 0;
for (const row of rows) {
  const amount = Number(row.available_cny);
  if (!(amount > 0)) { skipped += 1; continue; }
  const reference = `migrate:${batch}:${row.id}`;
  planned += 1;
  if (!apply) {
    console.log(`  ${row.name ?? row.id}  ¥${amount}  → ${reference}`);
    continue;
  }
  const account = await ensureAccount(db, lanehub, upstream, { userId: row.id, name: row.name, accountId });
  const result = await creditAccount(db, lanehub, {
    userId: row.id, lanehubUserId: account.lanehub_user_id, amountCny: amount,
    usdCnyRate: usdCny, quotaPerUnit, reference, remark: `IPZSK 余额迁移 ${batch}`,
  });
  if (result.applied) applied += 1; else skipped += 1;
  console.log(`  ${row.name ?? row.id}  ¥${amount}  ${result.applied ? '已入账 ' + result.quota + ' quota' : '已入过账，跳过'}`);
}

console.log('');
console.log(`客户 ${rows.length} 个，待迁 ${planned}，本次入账 ${applied}，跳过 ${skipped}`);
if (!apply) console.log('（dry-run，什么都没写。核对无误后加 --apply）');
await db.close();
