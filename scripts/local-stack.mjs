#!/usr/bin/env node
/**
 * 本地起一套完整的网关 + 一份可看的样例数据，用来**肉眼验前端**（后台页面、结算单）。
 *
 * 生产的 server.mjs 依赖 /run/secrets 下的几个文件，本机起不来；这个脚本走
 * createApp，和集成测试同一条路，但把服务真的 listen 出来。
 *
 * **可以反复跑**：所有数据都落在一个固定的 schema 里，重复执行只会把它重建一遍
 * （--fresh）或直接复用（默认）。lanehub 是假的，不打真钱。
 *
 *   export TEST_DB_HOST=127.0.0.1 TEST_DB_PORT=5433 TEST_DB_PASSWORD=gateway
 *   node scripts/local-stack.mjs           # 复用已有数据
 *   node scripts/local-stack.mjs --fresh   # 重建
 *
 * 起来之后：http://127.0.0.1:3100/admin  密码 local-admin-password-000
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { database } from '../src/database.mjs';
import { createApp } from '../src/app.mjs';
import { Upstream } from '../src/upstream.mjs';
import { Scheduler } from '../src/scheduler.mjs';
import { Lanehub } from '../src/lanehub.mjs';
import { passwordHash } from '../src/security.mjs';

const SCHEMA = 'local_stack';
const PASSWORD = 'local-admin-password-000';
const USD_CNY = 6.7078, QUOTA_PER_UNIT = 500000;
const fresh = process.argv.includes('--fresh');

const config = { host: process.env.TEST_DB_HOST ?? '127.0.0.1', port: Number(process.env.TEST_DB_PORT ?? 5432),
  database: 'gateway_test', user: process.env.TEST_DB_USER ?? 'gateway', password: process.env.TEST_DB_PASSWORD };
const setup = database(config);
if (fresh) await setup.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
await setup.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
const db = database({ ...config, options: `-c search_path=${SCHEMA}` });
await db.migrate();

// 假 lanehub：够这套页面把数走通就行，不打真的。
const lanehubFetch = async (url) => {
  const path = String(url).replace('https://lane.local', '');
  if (path.startsWith('/api/option/')) return Response.json({ success: true, data: [{ key: 'PaymentUSDRate', value: String(USD_CNY) }] });
  if (path.startsWith('/api/user/?keyword=')) return Response.json({ success: true, data: { data: [{ id: 42, username: 'ipzlocal' }] } });
  if (path.startsWith('/api/user/')) return Response.json({ success: true, data: { id: 42, quota: 357142 } });
  return Response.json({ success: true, data: {} });
};
const dir = await mkdtemp(join(tmpdir(), 'ipzsk-local-'));
const upstream = new Upstream(db, dir, lanehubFetch);
const lanehub = new Lanehub({ baseUrl: 'https://lane.local', adminToken: 'sk-local', fetcher: lanehubFetch });

// ── 样例数据。全部 ON CONFLICT，重复跑不会翻倍。 ───────────────────────────
const PLUGIN = '7d8b7d87-b85f-49f1-bde7-a0b1a2f33401';          // schema.sql 里种下的「IPZSK 生图」
const OWNER = '00000000-0000-4000-8000-0000000000a1';
const CUSTOMER = '00000000-0000-4000-8000-0000000000a2';
await db.query('INSERT INTO administrators(id,password_hash) VALUES (1,$1) ON CONFLICT (id) DO UPDATE SET password_hash=EXCLUDED.password_hash',
  [await passwordHash(PASSWORD)]);
await db.query(`INSERT INTO users (id,name,rpm) VALUES ($1,'punk（作者）',60),($2,'demo 客户',60) ON CONFLICT (id) DO NOTHING`, [OWNER, CUSTOMER]);
await db.query(`INSERT INTO developer_profiles (user_id,display_name,state) VALUES ($1,'Punk','approved')
  ON CONFLICT (user_id) DO UPDATE SET state='approved'`, [OWNER]);
await db.query(`UPDATE plugins SET owner_user_id=$1,revenue_share_bps=3000 WHERE id=$2`, [OWNER, PLUGIN]);

// 三笔已结算的调用：一笔完整、一笔部分退款过、一笔没有插件归属（对照组）。
const charges = [
  { charged: '0.05701630', plugin: PLUGIN, owner: OWNER, share: 3000 },
  { charged: '0.12000000', plugin: PLUGIN, owner: OWNER, share: 3000 },
  { charged: '0.03000000', plugin: null, owner: null, share: null },
];
for (const [index, item] of charges.entries()) {
  const id = `00000000-0000-4000-8000-00000000b${index}00`.slice(0, 36);
  await db.query(`INSERT INTO requests (id,user_id,model,fingerprint,status,usage_state,stream,input_tokens,output_tokens,total_tokens,
    cost_cny,plugin_id,plugin_owner_user_id,plugin_share_bps,completed_at)
    VALUES ($1,$2,'gpt-image-2','local','succeeded','reported',false,1200,340,1540,0.02,$3,$4,$5,now()-interval '1 day')
    ON CONFLICT (id) DO NOTHING`, [id, CUSTOMER, item.plugin, item.owner, item.share]);
  await db.query(`INSERT INTO request_billing (request_id,user_id,state,reserved_cny,charged_cny,price_snapshot,reason,resolved_at)
    VALUES ($1,$2,'settled',$3,$3,'{"source":"local-stack"}','local',now()) ON CONFLICT (request_id) DO NOTHING`,
  [id, CUSTOMER, item.charged]);
  await db.query(`INSERT INTO plugin_earnings (id,request_id,owner_user_id,plugin_id,kind,amount_cny)
    SELECT gen_random_uuid(),r.id,r.plugin_owner_user_id,r.plugin_id,'accrual',
      round((b.charged_cny-b.refunded_cny)*r.plugin_share_bps/10000,8)
    FROM requests r JOIN request_billing b ON b.request_id=r.id
    WHERE r.id=$1 AND r.plugin_owner_user_id IS NOT NULL AND coalesce(r.plugin_share_bps,0)>0
    ON CONFLICT DO NOTHING`, [id]);
}

const app = await createApp({ db, upstream, scheduler: new Scheduler({ waitMs: 10 }),
  origin: 'http://127.0.0.1:3100', secureCookies: false,
  lanehub, lanehubAccountId: null, lanehubSignupCny: 5, lanehubUsdCny: USD_CNY, lanehubQuotaPerUnit: QUOTA_PER_UNIT });
await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT ?? 3100) });
console.log('本地网关已启动：http://127.0.0.1:' + (process.env.PORT ?? 3100) + '/admin');
console.log('管理员密码：' + PASSWORD);
console.log('样例：Punk 名下两笔计提待出单（分成 30%）。Ctrl+C 退出。');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await app.close(); await db.close(); await setup.close(); process.exit(0); });
