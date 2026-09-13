#!/usr/bin/env node
/**
 * **提示词型 skill 插件的全链路自检**：装成插件的 skill 调一次真模型，
 * 钱要扣对、token 要记下、归属要落到插件、作者的分成要算得出来。
 *
 * 和 lanehub-e2e.mjs 的分工：那个验的是「网关 ↔ lanehub」这一段（建号、额度、
 * 报价、媒体任务）；这个验的是**变现那条链**，而且请求是从网关的 HTTP 入口进去的，
 * 走完整的鉴权、归属、计费、补记、计提。打的是真 lanehub 和真上游，会花钱
 * （deepseek 这类文本模型一次几厘）。
 *
 * 提示词型 skill 的难点在归属：它的提示词是插件给的，模型请求却由 agent 主循环
 * 用**主令牌**发出，requests.plugin_id 天然是空的。解法是请求带
 * X-IPZSK-Plugin-Token 出示那个插件的凭据来声明归属——这条脚本验的就是它。
 *
 * **可以反复跑**：测试客户 / 作者 / 插件都是固定 id，建号与新人额度幂等；
 * 每跑一次只多花一次模型调用的钱（那步无法幂等，上游不认我方的幂等键）。
 *
 *   export DATABASE_URL=postgres://user:pass@127.0.0.1:5433/ipzsk_e2e
 *   export LANEHUB_BASE_URL=http://localhost:3000
 *   export LANEHUB_ADMIN_TOKEN=...
 *   node scripts/skill-chain-e2e.mjs
 */
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { database } from '../src/database.mjs';
import { createApp } from '../src/app.mjs';
import { Upstream } from '../src/upstream.mjs';
import { Scheduler } from '../src/scheduler.mjs';
import { Lanehub } from '../src/lanehub.mjs';
import { reconcileLanehubCharges } from '../src/lanehub-charges.mjs';
import { hash, token, passwordHash } from '../src/security.mjs';

const env = (name, fallback) => process.env[name] ?? fallback;
const missing = ['DATABASE_URL', 'LANEHUB_BASE_URL', 'LANEHUB_ADMIN_TOKEN'].filter((n) => !process.env[n]);
if (missing.length) { console.error('缺少环境变量：' + missing.join(' ')); process.exit(2); }

const MODEL = env('SKILL_E2E_MODEL', 'deepseek-v4-flash');
const USD_CNY = Number(env('LANEHUB_USD_CNY', '6.7078'));
const QUOTA_PER_UNIT = Number(env('LANEHUB_QUOTA_PER_UNIT', '500000'));
const SHARE_BPS = 3000;                       // 作者分成 30%
// 固定身份：跑第二次要落在同一批行上，否则每跑一次就多一个客户、多一个插件。
const CUSTOMER = env('SKILL_E2E_USER_ID', '00000000-0000-4000-8000-00000000c001');
const AUTHOR = '00000000-0000-4000-8000-00000000c002';
const PLUGIN = '00000000-0000-4000-8000-00000000c003';

const checks = [];
const check = (name, ok, detail = '') => { checks.push({ ok }); console.log(`${ok ? '✔' : '✘'} ${name}${detail ? '  ' + detail : ''}`); };

const db = database({ connectionString: process.env.DATABASE_URL });
const secretDir = env('UPSTREAM_SECRET_DIR', join(tmpdir(), 'ipzsk-e2e-secrets'));
await mkdir(secretDir, { recursive: true, mode: 0o700 });
const upstream = new Upstream(db, secretDir);
const lanehub = new Lanehub({ baseUrl: process.env.LANEHUB_BASE_URL, adminToken: process.env.LANEHUB_ADMIN_TOKEN });
let app;

try {
  await db.migrate();
  await db.query('INSERT INTO administrators(id,password_hash) VALUES (1,$1) ON CONFLICT (id) DO NOTHING', [await passwordHash('skill-e2e-admin-password')]);

  // ── 前置：lanehub 上游账户 + 开关 + 客户 + 作者 + 一个「提示词型 skill」插件 ──
  const accountId = (await db.query(
    `INSERT INTO upstream_accounts (id,name,concurrency,base_url,provider_type)
     VALUES ($1,'lanehub-e2e',5,$2,'lanehub') ON CONFLICT (name) DO UPDATE SET base_url=EXCLUDED.base_url RETURNING id`,
    [randomUUID(), process.env.LANEHUB_BASE_URL])).rows[0].id;
  await db.query(`INSERT INTO app_settings (key,value) VALUES ('lanehub_mode','on')
    ON CONFLICT (key) DO UPDATE SET value='on'`);
  await db.query(`INSERT INTO users (id,name,rpm) VALUES ($1,'skill-e2e 客户',60),($2,'skill 作者',60) ON CONFLICT (id) DO NOTHING`, [CUSTOMER, AUTHOR]);
  await db.query(`INSERT INTO developer_profiles (user_id,display_name,state) VALUES ($1,'Skill 作者','approved')
    ON CONFLICT (user_id) DO UPDATE SET state='approved'`, [AUTHOR]);
  // 提示词型 skill：runtime_id 留空——它不是自己发请求的运行时插件，只提供提示词。
  await db.query(`INSERT INTO plugins (id,slug,name,repository,package_name,publisher_ref,allowed_models,owner_user_id,revenue_share_bps)
    VALUES ($1,'skill-e2e-prompt','提示词型 skill（自检用）','example/skill-e2e','@example/skill-e2e','example',$2,$3,$4)
    ON CONFLICT (id) DO UPDATE SET allowed_models=EXCLUDED.allowed_models,owner_user_id=EXCLUDED.owner_user_id,
      revenue_share_bps=EXCLUDED.revenue_share_bps,enabled=true`, [PLUGIN, [MODEL], AUTHOR, SHARE_BPS]);

  app = await createApp({ db, upstream, scheduler: new Scheduler({ waitMs: 10 }),
    origin: 'http://127.0.0.1:3100', secureCookies: false,
    lanehub, lanehubAccountId: accountId, lanehubSignupCny: 5, lanehubUsdCny: USD_CNY, lanehubQuotaPerUnit: QUOTA_PER_UNIT });

  // 主令牌（agent 主循环用的那把）与插件凭据（声明归属用的那把）。
  const issue = async (name, pluginId) => {
    const value = token('ipz_');
    await db.query(`INSERT INTO access_tokens (id,user_id,token_hash,prefix,name,plugin_id) VALUES ($1,$2,$3,$4,$5,$6)`,
      [randomUUID(), CUSTOMER, hash(value), value.slice(0, 12), name, pluginId]);
    return value;
  };
  const main = await issue('skill-e2e 主令牌', null);
  const credential = await issue('skill-e2e 插件凭据', PLUGIN);

  // ── 1. 发一次真请求：主令牌 + 插件凭据声明归属 ──────────────────────
  const ask = (extra = {}) => app.inject({ url: '/v1/chat/completions', method: 'POST',
    headers: { authorization: 'Bearer ' + main, ...extra },
    payload: { model: MODEL, messages: [{ role: 'user', content: '用一句话说明什么是计费链路' }], max_tokens: 60 } });

  const answered = await ask({ 'x-ipzsk-plugin-token': credential });
  check('调用：真模型返回了结果', answered.statusCode === 200,
    answered.statusCode === 200 ? String(answered.json().choices?.[0]?.message?.content ?? '').slice(0, 40) : answered.body.slice(0, 160));
  if (answered.statusCode !== 200) throw new Error('模型调用失败，后面的账无从谈起');

  const row = (await db.query(`SELECT * FROM requests WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, [CUSTOMER])).rows[0];
  check('归属：这一单记在插件头上', row.plugin_id === PLUGIN, row.plugin_id ?? '空');
  check('归属：作者与分成比例按发生时快照落库', row.plugin_owner_user_id === AUTHOR && row.plugin_share_bps === SHARE_BPS,
    `作者 ${row.plugin_owner_user_id === AUTHOR ? '对' : '错'} / ${row.plugin_share_bps} bps`);
  check('用量：token 消耗记下来了', Number(row.total_tokens) > 0 && row.usage_state === 'reported',
    `入 ${row.input_tokens} / 出 ${row.output_tokens} / 共 ${row.total_tokens}`);
  check('对账钥匙：upstream_id 是 lanehub 的 request id，没有被响应体的 id 覆盖',
    typeof row.upstream_id === 'string' && !row.upstream_id.startsWith('chatcmpl'), row.upstream_id ?? '空');

  // 不带头就是普通调用，不该归属任何插件。
  const plain = await ask();
  check('对照：不带插件凭据的同一个调用不归属任何插件', plain.statusCode === 200 &&
    (await db.query(`SELECT plugin_id FROM requests WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, [CUSTOMER])).rows[0].plugin_id === null);

  // ── 1b. 另一条归属路径：插件**自己的凭据**直接作 Authorization ────────
  // 走 Host llm 服务的插件（文档转 Excel 那类）就是这么调的：桌面端给它单独注册
  // 一条 provider，apiKey 就是这把凭据。这条路不需要额外的头，归属天然成立。
  const asPlugin = await app.inject({ url: '/v1/chat/completions', method: 'POST',
    headers: { authorization: 'Bearer ' + credential },
    payload: { model: MODEL, messages: [{ role: 'user', content: '用一句话说明什么是分成' }], max_tokens: 40 } });
  const pluginRow = (await db.query(`SELECT * FROM requests WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, [CUSTOMER])).rows[0];
  check('归属（插件凭据直连）：同样记在插件头上', asPlugin.statusCode === 200 && pluginRow.plugin_id === PLUGIN,
    `HTTP ${asPlugin.statusCode} / 插件 ${pluginRow.plugin_id ?? '空'} / ${pluginRow.total_tokens} tokens`);

  // ── 2. 扣费补记：钱是 lanehub 扣的，账要回到这一侧 ────────────────────
  // 补记刻意跳过刚完成 30 秒内的请求（对面的消费日志可能还没落库），把时间往前挪。
  await db.query(`UPDATE requests SET completed_at=now()-interval '2 minutes' WHERE user_id=$1`, [CUSTOMER]);
  const first = await reconcileLanehubCharges(db, lanehub, { usdCnyRate: USD_CNY, quotaPerUnit: QUOTA_PER_UNIT });
  const bill = (await db.query(`SELECT * FROM request_billing WHERE request_id=$1`, [row.id])).rows[0];
  const pluginBill = (await db.query(`SELECT * FROM request_billing WHERE request_id=$1`, [pluginRow.id])).rows[0];
  check('扣费（插件凭据直连）：这一单同样结算了', pluginBill?.state === 'settled', `¥${pluginBill?.charged_cny ?? '-'}`);
  check('扣费：从 lanehub 的消费日志补回来了', bill?.state === 'settled',
    `${bill?.state ?? '无账单'} ¥${bill?.charged_cny ?? '-'}（本轮补记 ${first.settled} 条）`);
  check('扣费：金额取自对面的 quota，不是这边估的', Number(bill?.price_snapshot?.quota) > 0,
    `quota=${bill?.price_snapshot?.quota ?? '-'} × ${bill?.price_snapshot?.usd_cny ?? '-'} / ${QUOTA_PER_UNIT}`);

  // ── 3. 分成：这条链的终点 ───────────────────────────────────────────
  const earning = (await db.query(`SELECT * FROM plugin_earnings WHERE request_id=$1 AND kind='accrual'`, [row.id])).rows[0];
  const expected = (Number(bill?.charged_cny ?? 0) * SHARE_BPS / 10000).toFixed(8);
  check('分成：作者的计提 = 实扣 × 比例', earning && Number(earning.amount_cny).toFixed(8) === expected,
    `计提 ${earning?.amount_cny ?? '-'} / 应得 ${expected}`);
  check('分成：计提挂在作者名下', earning?.owner_user_id === AUTHOR);

  const before = (await db.query(`SELECT count(*)::int AS n FROM plugin_earnings WHERE request_id=$1`, [row.id])).rows[0].n;
  await reconcileLanehubCharges(db, lanehub, { usdCnyRate: USD_CNY, quotaPerUnit: QUOTA_PER_UNIT });
  const after = (await db.query(`SELECT count(*)::int AS n FROM plugin_earnings WHERE request_id=$1`, [row.id])).rows[0].n;
  check('幂等：重复补记不会把分成算两遍', before === after, `${before} → ${after}`);

  // ── 4. 出一张结算单，确认这笔钱进得了人工打款的流程 ──────────────────
  const login = await app.inject({ url: '/admin/api/login', method: 'POST', payload: { password: 'skill-e2e-admin-password' },
    headers: { origin: 'http://127.0.0.1:3100' } });
  const cookie = login.headers['set-cookie'].split(';')[0];
  const admin = (url, method = 'GET', payload) => app.inject({ url: '/admin/api' + url, method, payload, headers: { cookie, origin: 'http://127.0.0.1:3100' } });
  const pending = (await admin('/settlements')).json().pending.find((p) => p.owner_user_id === AUTHOR);
  check('结算：作者出现在待出单列表里', Number(pending?.amount_cny) > 0, `待结算 ¥${pending?.amount_cny ?? 0}（${pending?.item_count ?? 0} 条明细）`);
  const draft = (await admin('/settlements', 'POST', { owner_user_id: AUTHOR, from: '2000-01-01', to: '2099-12-31' })).json();
  const frozen = (await admin('/settlements/' + draft.id + '/freeze', 'POST', {})).json();
  check('结算：出单并冻结，金额锁定', Number(frozen.amount_cny) === Number(draft.amount_cny), `¥${frozen.amount_cny} / ${frozen.item_count} 条`);
} finally {
  await app?.close();
  await db.close();
}

const failed = checks.filter((c) => !c.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} 通过`);
process.exitCode = failed ? 1 : 0;
