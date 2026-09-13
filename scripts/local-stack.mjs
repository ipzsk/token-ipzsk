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
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { database } from '../src/database.mjs';
import { createApp } from '../src/app.mjs';
import { Upstream } from '../src/upstream.mjs';
import { Scheduler } from '../src/scheduler.mjs';
import { Lanehub } from '../src/lanehub.mjs';
import { createCustomerAuth } from '../src/customer-auth.mjs';
import { passwordHash, hash } from '../src/security.mjs';
import { randomUUID as uuid } from 'node:crypto';

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

// 连**真的** lanehub：这套栈是用来验计费的，假上游验不出钱对不对。
// 没给 LANEHUB_ADMIN_TOKEN 就退回一个只够页面渲染的假上游，那时别指望账是真的。
const LANEHUB_URL = process.env.LANEHUB_BASE_URL ?? 'http://127.0.0.1:3000';
const fakeLanehub = async (url) => {
  const path = String(url).replace(LANEHUB_URL, '');
  if (path.startsWith('/api/option/')) return Response.json({ success: true, data: [{ key: 'PaymentUSDRate', value: String(USD_CNY) }] });
  if (path.startsWith('/api/user/?keyword=')) return Response.json({ success: true, data: { data: [{ id: 42, username: 'ipzlocal' }] } });
  if (path.startsWith('/api/user/')) return Response.json({ success: true, data: { id: 42, quota: 357142 } });
  return Response.json({ success: true, data: {} });
};
const real = Boolean(process.env.LANEHUB_ADMIN_TOKEN);
const dir = process.env.UPSTREAM_SECRET_DIR ?? await mkdtemp(join(tmpdir(), 'ipzsk-local-'));
await mkdir(dir, { recursive: true, mode: 0o700 });
const upstream = new Upstream(db, dir, real ? fetch : fakeLanehub);
const lanehub = new Lanehub({ baseUrl: LANEHUB_URL, adminToken: process.env.LANEHUB_ADMIN_TOKEN ?? 'sk-local',
  ...(real ? {} : { fetcher: fakeLanehub }) });

// ── 样例数据。全部 ON CONFLICT，重复跑不会翻倍。 ───────────────────────────
const PLUGIN = '7d8b7d87-b85f-49f1-bde7-a0b1a2f33401';          // schema.sql 里种下的「IPZSK 生图」
const DOC_PLUGIN = '7d8b7d87-b85f-49f1-bde7-a0b1a2f33402';      // 「文档转 Excel」——走 Host llm 服务的那类
const TEXT_MODEL = process.env.LOCAL_STACK_MODEL ?? 'deepseek-v4-flash';
const OWNER = '00000000-0000-4000-8000-0000000000a1';
const CUSTOMER = '00000000-0000-4000-8000-0000000000a2';
await db.query('INSERT INTO administrators(id,password_hash) VALUES (1,$1) ON CONFLICT (id) DO UPDATE SET password_hash=EXCLUDED.password_hash',
  [await passwordHash(PASSWORD)]);
await db.query(`INSERT INTO users (id,name,rpm) VALUES ($1,'punk（作者）',60),($2,'demo 客户',60) ON CONFLICT (id) DO NOTHING`, [OWNER, CUSTOMER]);
await db.query(`INSERT INTO developer_profiles (user_id,display_name,state) VALUES ($1,'Punk','approved')
  ON CONFLICT (user_id) DO UPDATE SET state='approved'`, [OWNER]);
await db.query(`UPDATE plugins SET owner_user_id=$1,revenue_share_bps=3000 WHERE id=$2`, [OWNER, PLUGIN]);
// 文档转 Excel 也归到同一个作者名下，并让它认这个便宜的文本模型——桌面端要用它实测计费。
await db.query(`UPDATE plugins SET owner_user_id=$1,revenue_share_bps=3000,allowed_models=$3 WHERE id=$2`,
  [OWNER, DOC_PLUGIN, [TEXT_MODEL, 'gpt-5.6-sol']]);

// ── lanehub 那条线：上游账户 + 开关 + 一把「目录用」的密钥 ──────────────────
// bootstrap 的模型列表来自 upstream_keys.models；lanehub 模式下客户自己那把密钥
// 的 models 是空的（故意的，免得被普通选路选中），所以要另有一把列出可用模型。
const LANEHUB_ACCOUNT = (await db.query(
  `INSERT INTO upstream_accounts (id,name,concurrency,base_url,provider_type)
   VALUES ($1,'lanehub',20,$2,'lanehub') ON CONFLICT (name) DO UPDATE SET base_url=EXCLUDED.base_url RETURNING id`,
  [uuid(), LANEHUB_URL])).rows[0].id;
await db.query(`INSERT INTO upstream_keys (id,account_id,name,fingerprint,suffix,secret_ref,models,concurrency)
  VALUES ($1,$2,'目录用（不参与选路）','local-stack-catalog','cat','local-stack-catalog.key',$3,1)
  ON CONFLICT (fingerprint) DO UPDATE SET models=EXCLUDED.models`,
[uuid(), LANEHUB_ACCOUNT, [TEXT_MODEL, 'gpt-5.6-sol', 'gpt-image-2']]);
await db.query(`INSERT INTO app_settings (key,value) VALUES ('lanehub_mode','on')
  ON CONFLICT (key) DO UPDATE SET value='on'`);

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

// ── 客户登录：桌面端要走 /api/auth/sign-in/email 才拿得到 bootstrap ──────────
// 邮件与验证码都用不了（本机没有 SES 凭据），所以：注册走不通，但**密码登录走得通**
// （登录只在连续失败三次之后才要验证码）。下面直接把一个已验证邮箱的账号种进去。
const ORIGIN = `http://127.0.0.1:${process.env.PORT ?? 3100}`;
const DEMO_EMAIL = 'demo@ipzsk.local', DEMO_PASSWORD = 'local-demo-password-123';
// 登录连续失败三次之后，网关会开始要图形验证码——而桌面端的登录页没有验证码输入框，
// 于是本机联调会卡死在 503 captcha_unavailable（用错账号试几次就会撞上）。
// 本地栈给一个恒通过的验证码实现，**只在这个脚本里**；生产的 server.mjs 用的是真的。
const alwaysPassCaptcha = {
  ready: true, provider: 'local-stack',
  issue: async () => ({ id: 'local', image: '', expires_in: 120, length: 5 }),
  solve: async () => ({ token: 'local' }),
  verify: async () => undefined,
};
const customerAuth = createCustomerAuth({ db, origin: ORIGIN, secret: 'local-stack-customer-secret-0000000000',
  captcha: alwaysPassCaptcha,
  mailer: { ready: false, provider: 'local', send: async () => { throw new Error('local stack has no mailer'); } } });
await customerAuth.migrate();
// 上一轮试错攒下的失败计数会让下一次登录直接要验证码，每次起栈先清掉。
await db.query('DELETE FROM auth_abuse_limits').catch(() => {});

// 用 better-auth 自己的注册接口建号，而不是手写 SQL：口令哈希、账号表的列名与
// 唯一键都是它的实现细节，手写一次就得跟着它的版本变一次。
// 注册路由在 HTTP 层要验证码和邮件，这里直接调库，绕开那两样。
const existing = (await db.query('SELECT id FROM auth_users WHERE email=$1', [DEMO_EMAIL])).rows[0];
if (!existing) {
  await customerAuth.auth.api.signUpEmail({ body: { email: DEMO_EMAIL, password: DEMO_PASSWORD, name: '本地演示账号' } })
    .catch((error) => { console.error('建演示账号失败：', error?.message ?? error); throw error; });
}
const authUser = (await db.query('SELECT id FROM auth_users WHERE email=$1', [DEMO_EMAIL])).rows[0].id;
// 本机没有邮件服务，直接把邮箱标成已验证——登录要求 requireEmailVerification。
await db.query('UPDATE auth_users SET "emailVerified"=true WHERE id=$1', [authUser]);
await db.query(`UPDATE users SET auth_user_id=$2,email=$3,email_verified=true WHERE id=$1`, [CUSTOMER, authUser, DEMO_EMAIL]);

const app = await createApp({ db, upstream, scheduler: new Scheduler({ waitMs: 10 }), customerAuth,
  origin: ORIGIN, secureCookies: false,
  lanehub, lanehubAccountId: LANEHUB_ACCOUNT, lanehubSignupCny: 5, lanehubUsdCny: USD_CNY, lanehubQuotaPerUnit: QUOTA_PER_UNIT });
await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT ?? 3100) });
console.log('本地网关已启动：http://127.0.0.1:' + (process.env.PORT ?? 3100) + '/admin');
console.log('管理员密码：' + PASSWORD);
console.log(`lanehub：${real ? '真的（' + LANEHUB_URL + '，会花钱）' : '假的（只够页面渲染，账不是真的）'}`);
console.log('样例：Punk 名下两笔计提待出单（分成 30%）。Ctrl+C 退出。');
console.log('');
console.log('桌面端联调：');
console.log(`  IPZSK_DEV_BACKEND=1 IPZSK_ORIGIN_OVERRIDE=${ORIGIN} open -a "IPZSK Desktop"`);
console.log(`  登录邮箱 ${DEMO_EMAIL}   密码 ${DEMO_PASSWORD}`);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await app.close(); await db.close(); await setup.close(); process.exit(0); });
