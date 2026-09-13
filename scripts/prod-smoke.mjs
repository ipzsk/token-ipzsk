#!/usr/bin/env node
/**
 * 生产上验一笔**真实**计费（≈¥0.00003）：给自检账号补到 ¥2、签一个临时令牌、打一笔最便宜的
 * 文本调用、等 lanehub 回写、核对，末尾撤销令牌。在网关容器里跑（要内网地址和库凭据）：
 *
 *   ssh 生产; cd /home/ubuntu/api-gateway
 *   sudo docker compose exec -T gateway node scripts/prod-smoke.mjs [自检账号邮箱]
 *
 * 幂等：充值用固定 reference（smoke:<日期>），同一天重跑不重复加钱；令牌每次新签、用完即撤。
 */
import { databaseFromEnv } from '../src/database.mjs';
import { Lanehub, ensureAccount, creditAccount, adminTokenFromEnv } from '../src/lanehub.mjs';
import { Upstream } from '../src/upstream.mjs';
import { token, hash } from '../src/security.mjs';
import { randomUUID } from 'node:crypto';

const email = process.argv[2] ?? 'lengkuxiaomao@gmail.com';
const model = process.env.SMOKE_MODEL ?? 'deepseek-v4-flash';
const origin = process.env.PUBLIC_ORIGIN ?? 'https://api.ipzsk.com';
const db = await databaseFromEnv();
const lanehub = new Lanehub({ baseUrl: process.env.LANEHUB_BASE_URL, adminToken: await adminTokenFromEnv() });
const upstream = new Upstream(db, process.env.UPSTREAM_SECRET_DIR ?? '/run/upstream');
const fail = (m) => { console.error('✖', m); process.exitCode = 1; };

try {
  const user = (await db.query('SELECT id,name FROM users WHERE name=$1', [email])).rows[0];
  if (!user) throw new Error('自检账号不存在: ' + email);
  const acc = await ensureAccount(db, lanehub, upstream, { userId: user.id, name: user.name, accountId: process.env.LANEHUB_ACCOUNT_ID });
  const day = new Date().toISOString().slice(0, 10);
  const credit = await creditAccount(db, lanehub, { userId: user.id, lanehubUserId: acc.lanehub_user_id, amountCny: '2',
    usdCnyRate: Number(process.env.LANEHUB_USD_CNY), quotaPerUnit: 500000, reference: 'smoke:' + day, remark: '上线自检充值' });
  console.log('lanehub 用户', acc.lanehub_user_id, '充值', credit.applied ? '已入账' : '今天已入过');

  const value = token('ipz_'), tokenId = randomUUID();
  await db.query('INSERT INTO access_tokens(id,user_id,token_hash,prefix,name) VALUES($1,$2,$3,$4,$5)',
    [tokenId, user.id, hash(value), value.slice(0, 12), '上线自检（用完即撤）']);
  const before = Number((await lanehub.balance(acc.lanehub_user_id))?.quota ?? 0);
  try {
    const r = await fetch(origin + '/v1/chat/completions', { method: 'POST',
      headers: { authorization: 'Bearer ' + value, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: '只回两个字：上线' }], max_tokens: 20 }) });
    const body = await r.json();
    if (!r.ok) throw new Error('调用失败 ' + r.status + ' ' + JSON.stringify(body).slice(0, 200));
    console.log('调用 OK：', body.choices?.[0]?.message?.content, body.usage);
  } finally {
    await db.query('UPDATE access_tokens SET revoked_at=now() WHERE id=$1', [tokenId]);
  }
  const after = Number((await lanehub.balance(acc.lanehub_user_id))?.quota ?? 0);
  if (!(after < before)) fail(`lanehub 没扣费：${before} → ${after}`); else console.log('lanehub 扣费', before - after, 'quota');

  // 回写由 120 秒一轮的 reconcile 完成；这里等最多 3 分钟
  const deadline = Date.now() + 180_000; let row;
  while (Date.now() < deadline) {
    row = (await db.query(`SELECT r.upstream_id,b.state,b.charged_cny,b.reason FROM requests r LEFT JOIN request_billing b ON b.request_id=r.id
      WHERE r.user_id=$1 AND r.model=$2 ORDER BY r.created_at DESC LIMIT 1`, [user.id, model])).rows[0];
    if (row?.state === 'settled') break;
    await new Promise((res) => setTimeout(res, 10_000));
  }
  if (!row?.upstream_id) fail('requests.upstream_id 没记 lanehub 的 request_id');
  if (row?.state !== 'settled' || row?.reason !== 'lanehub') fail('计费回写未到：' + JSON.stringify(row));
  else console.log('回写 OK：charged_cny =', row.charged_cny);
} finally {
  await db.close();
}
console.log(process.exitCode ? '自检失败' : '自检通过');
