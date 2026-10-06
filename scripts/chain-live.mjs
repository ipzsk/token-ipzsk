#!/usr/bin/env node
/**
 * 计价链路自检（**走网关 HTTP 入口**，不是直接打 lanehub）。
 *
 * 与 scripts/lanehub-e2e.mjs 的分工：那个验的是「lanehub 本身通不通」，绕过网关；
 * 这个验的是**用户在网站上真实走的那条路**——登录 → 会话密钥 → 生成 → 轮询 →
 * 余额与流水，以及服务端的钱包/账单/生成记录是否与 lanehub 的实扣对得上。
 *
 * 两种用法：
 *
 *   1) 真跑一笔（会花真钱）：
 *      secretctl run -k ipzsk-site/lengkuxiaomao -- node scripts/chain-live.mjs
 *      环境变量：IPZSK_LOGIN_EMAIL / IPZSK_LOGIN_PASSWORD（脚本不落任何凭据）
 *
 *   2) 只查一笔已发生的请求（不花钱，需要服务端环境）：
 *      在服务器上：
 *      sudo docker compose exec -T gateway node scripts/chain-live.mjs inspect <request_id>
 *      本地有库时也认 DATABASE_URL + LANEHUB_BASE_URL + LANEHUB_ADMIN_TOKEN：
 *      DATABASE_URL=... LANEHUB_BASE_URL=... LANEHUB_ADMIN_TOKEN=... node scripts/chain-live.mjs inspect <request_id>
 *
 * 可调项：GATEWAY_BASE（默认 https://api.ipzsk.com）、CHAIN_MODEL、CHAIN_PARAMS（JSON）、
 * CHAIN_PROMPT、CHAIN_KIND=image|video、CHAIN_POLL_SECONDS、CHAIN_ORIGIN。
 *
 * 深度核对只有配了库与 lanehub 管理令牌才会做；没配就只跑客户端可见的那一段。
 */
import { randomUUID } from 'node:crypto';
import { databaseFromEnv } from '../src/database.mjs';
import { Lanehub, adminTokenFromEnv } from '../src/lanehub.mjs';
import { quotaToCny } from '../src/lanehub-charges.mjs';

const BASE = (process.env.GATEWAY_BASE ?? 'https://api.ipzsk.com').replace(/\/+$/, '');
const ORIGIN = process.env.CHAIN_ORIGIN ?? 'https://www.ipzsk.com';
const MODEL = process.env.CHAIN_MODEL ?? 'gpt-image-2.5-flare';
const KIND = process.env.CHAIN_KIND ?? 'image';
const PROMPT = process.env.CHAIN_PROMPT ?? '一只戴墨镜的橘猫，赛博朋克霓虹背景，居中构图';
const PARAMS = JSON.parse(process.env.CHAIN_PARAMS ?? '{"aspect_ratio":"1:1","resolution":"1k","quality":"low"}');
const POLL_SECONDS = Number(process.env.CHAIN_POLL_SECONDS ?? 240);
const EMAIL = process.env.IPZSK_LOGIN_EMAIL ?? process.env.CHAIN_EMAIL;
const PASSWORD = process.env.IPZSK_LOGIN_PASSWORD ?? process.env.CHAIN_PASSWORD;

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? '  ' + detail : ''}`);
};
const money = (value) => (value === null || value === undefined ? '—' : '¥' + Number(value).toFixed(8));
const num = (v) => (v === null || v === undefined ? 0 : Number(v));
const terminal = (status) => ['completed', 'failed', 'cancelled'].includes(status);

// ── HTTP 客户端：保留登录 cookie，所有请求带 Origin（网关按来源校验写操作） ──
function httpClient() {
  let cookie = '';
  return async function call(path, { method = 'GET', body, bearer, headers = {} } = {}) {
    const response = await fetch(BASE + path, {
      method,
      headers: {
        Origin: ORIGIN,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const setCookies = response.headers.getSetCookie?.() ?? [];
    if (setCookies.length) cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: response.status, headers: response.headers, json, text };
  };
}

async function login(call) {
  const result = await call('/api/auth/sign-in/email', { method: 'POST', body: { email: EMAIL, password: PASSWORD } });
  if (result.status !== 200) throw new Error(`login_failed_${result.status}: ${result.text.slice(0, 200)}`);
  const key = await call('/api/me/web/session-key', { method: 'POST', body: {} });
  if (key.status !== 200 || typeof key.json?.token !== 'string') throw new Error(`session_key_failed_${key.status}: ${key.text.slice(0, 200)}`);
  return key.json.token;
}

async function wallet(call) {
  const result = await call('/api/me/wallet');
  if (result.status !== 200) throw new Error(`wallet_failed_${result.status}`);
  return result.json;
}

async function runLive() {
  if (!EMAIL || !PASSWORD) {
    console.error('缺少 IPZSK_LOGIN_EMAIL / IPZSK_LOGIN_PASSWORD（可用 secretctl run -k ipzsk-site/lengkuxiaomao 注入）。');
    process.exit(2);
  }
  const call = httpClient();
  const token = await login(call);
  check('登录 + 会话密钥', true, EMAIL);

  const before = await wallet(call);
  const beforePoints = before.available_points;
  check('钱包可读（lanehub 权威余额）', before.source === 'lanehub' && typeof beforePoints === 'string',
    `${beforePoints} 点 / ${money(before.available_cny)}`);

  const path = `/api/me/${KIND === 'video' ? 'videos' : 'images'}/generations`;
  const submit = await call(path, {
    method: 'POST', body: { model: MODEL, prompt: PROMPT, ...PARAMS, reference_asset_ids: [] },
    headers: { 'Idempotency-Key': 'q:' + randomUUID() },
  });
  const requestId = submit.headers.get('x-request-id') ?? submit.json?.data?.[0]?.task_id;
  check('提交生成请求（网站接口）', submit.status === 200 && Boolean(requestId), `${path} → ${requestId ?? submit.text.slice(0, 160)}`);
  if (!requestId) return;

  let task = null;
  const deadline = Date.now() + POLL_SECONDS * 1000;
  while (Date.now() < deadline) {
    const poll = await call('/api/me/tasks/' + encodeURIComponent(requestId));
    task = poll.json;
    const status = task?.data?.status;
    if (terminal(status)) break;
    await new Promise((done) => setTimeout(done, 5000));
  }
  check('任务走到终态', terminal(task?.data?.status), task?.data?.status ?? '超时');

  // 到账/扣费由 120s 的补记定时器写回，轮询它直到账单落定（最多等 3 分钟）。
  let bill = null;
  for (let i = 0; i < 36; i++) {
    const poll = await call('/api/me/tasks/' + encodeURIComponent(requestId));
    bill = poll.json?.billing ?? null;
    if (bill && bill.billing_state && bill.billing_state !== 'reserved' && bill.billing_state !== 'pending') break;
    await new Promise((done) => setTimeout(done, 5000));
  }
  check('账单落定', ['settled', 'released'].includes(bill?.billing_state), `state=${bill?.billing_state} charged=${bill?.charged_points} 点`);
  const chargedPoints = num(bill?.charged_points);

  const after = await wallet(call);
  // available_points 是 2 位小数的展示值，用它算差额会差在四舍五入上；用 8 位小数的 available_cny。
  const deltaCny = num(before.available_cny) - num(after.available_cny);
  const deltaPoints = num(before.available_points) - num(after.available_points);
  const chargedCny = chargedPoints / 100;
  check('余额下降 = 本次扣点', Math.abs(deltaCny - chargedCny) < 1e-6,
    `${before.available_points} → ${after.available_points}（-${deltaPoints.toFixed(2)} 点 / -${deltaCny.toFixed(8)} 元）`);

  const gens = await call('/api/me/generations');
  const record = (gens.json?.items ?? []).find((g) => g.task_id === requestId);
  check('生成记录带扣点', record?.charged_points !== null && record?.charged_points !== undefined,
    `${record?.status} charged_points=${record?.charged_points}`);

  const entries = after.entries ?? [];
  const consumption = entries.find((e) => e.kind === 'consumption' && Math.abs(num(e.amount_cny) + num(chargedPoints) / 100) < 1e-6);
  check('用户流水出现消费行（lanehub 模式修复）', Boolean(consumption),
    consumption ? `${consumption.created_at} ${consumption.amount_cny} 元` : '未在最近 30 条里找到');

  console.log(`\nrequest_id = ${requestId}`);
  const deep = await deepVerify(requestId).catch((error) => { console.log('深度核对跳过：' + error.message); return null; });
  if (deep) printChain(deep);
}

// ── 服务端深度核对：请求 → lanehub 消费日志 → 账单 → 生成记录 → 分组倍率 ──
async function deepVerify(requestId) {
  const db = await databaseFromEnv();
  try {
    const request = (await db.query(`SELECT r.id,r.user_id,r.status,r.model,r.upstream_id,r.key_id,r.plugin_id,
        r.input_tokens,r.output_tokens,r.total_tokens,r.completed_at,a.provider_type
      FROM requests r LEFT JOIN upstream_keys k ON k.id=r.key_id LEFT JOIN upstream_accounts a ON a.id=k.account_id
      WHERE r.id=$1`, [requestId])).rows[0];
    if (!request) throw new Error('requests 里没有这条 request_id');
    const billing = (await db.query('SELECT * FROM request_billing WHERE request_id=$1', [requestId])).rows[0] ?? null;
    const record = (await db.query('SELECT id,status,charged_points FROM generation_records WHERE request_id=$1', [requestId])).rows[0] ?? null;
    const account = (await db.query('SELECT lanehub_user_id,lane FROM lanehub_accounts WHERE user_id=$1', [request.user_id])).rows[0] ?? null;

    let logs = [], lanehubUser = null, groupRatio = null, usdRate = null;
    const lanehubBase = process.env.LANEHUB_BASE_URL;
    const token = await adminTokenFromEnv().catch(() => undefined);
    if (lanehubBase && token && request.upstream_id) {
      const lanehub = new Lanehub({ baseUrl: lanehubBase, adminToken: token });
      const page = await lanehub.call('/api/log/?request_id=' + encodeURIComponent(request.upstream_id) + '&size=20');
      logs = (Array.isArray(page) ? page : page?.data ?? []).filter((l) => Number(l.type) === 2);
      usdRate = await lanehub.usdRate().catch(() => null);
      if (account) lanehubUser = await lanehub.call('/api/user/' + account.lanehub_user_id).catch(() => null);
      if (account) {
        const groups = await lanehub.call('/api/group/').catch(() => []);
        groupRatio = (Array.isArray(groups) ? groups : []).find((g) => g.symbol === account.lane)?.ratio ?? null;
      }
    }
    return { request, billing, record, account, logs, lanehubUser, groupRatio, usdRate };
  } finally { await db.close(); }
}

function printChain(d) {
  const { request, billing, record, logs, lanehubUser, groupRatio, usdRate } = d;
  const qpu = Number(process.env.LANEHUB_QUOTA_PER_UNIT ?? 500000);
  const quota = logs.reduce((sum, l) => sum + num(l.quota), 0);
  const costQuota = logs.reduce((sum, l) => sum + num(l.cost_quota), 0);
  const meta = logs[0]?.metadata ?? {};
  const charge = usdRate ? quotaToCny(quota, usdRate, qpu) : null;
  const cost = usdRate ? quotaToCny(costQuota, usdRate, qpu) : null;

  console.log('\n──── 服务端链路 ────');
  console.log(`受理        provider=${request.provider_type} status=${request.status} upstream_id=${request.upstream_id ?? '—'}`);
  console.log(`lanehub 实扣 quota=${quota}  cost_quota=${costQuota}  group=${meta.group_name ?? '—'} group_ratio=${meta.group_ratio ?? '—'} price_type=${meta.price_type ?? '—'}`);
  console.log(`账单        state=${billing?.state ?? '—'} charged_cny=${money(billing?.charged_cny)} refunded=${money(billing?.refunded_cny)} snapshot=${billing ? JSON.stringify(billing.price_snapshot) : '—'}`);
  console.log(`生成记录    status=${record?.status ?? '—'} charged_points=${record?.charged_points ?? '—'}`);
  console.log(`配置        汇率=${usdRate ?? '—'} 每单位quota=${qpu} 分组倍率(${d.account?.lane})=${groupRatio ?? '—'}`);
  if (charge !== null) console.log(`折算        实扣=${money(charge)}  上游成本=${money(cost)}  实际加价=${cost > 0 ? (charge / cost).toFixed(2) + '×' : '—'}`);
  if (lanehubUser) console.log(`lanehub 余额 quota=${lanehubUser.quota}`);

  if (logs.length) check('lanehub 消费日志存在', true, `quota=${quota}`);
  else check('lanehub 消费日志存在', false, '查不到 type=2 日志');
  if (billing) check('账单金额 = lanehub 实扣折算', charge === null || billing.charged_cny === charge, `${billing.charged_cny} vs ${charge}`);
  if (record) check('生成记录扣点 = 账单 × 100', billing?.charged_cny == null || record.charged_points == null ||
    Math.abs(Number(record.charged_points) - Number(billing.charged_cny) * 100) < 1e-6, `${record.charged_points}`);
  if (groupRatio !== null && meta.group_ratio !== undefined) check('分组倍率应用正确', num(meta.group_ratio) === num(groupRatio), `日志 ${meta.group_ratio} / 配置 ${groupRatio}`);
  if (meta.input_ratio !== undefined) {
    const implied = num(meta.input_ratio) * num(meta.group_ratio) * 1000;
    check('quota = input_ratio × group_ratio × 1000', implied === quota, `${meta.input_ratio} × ${meta.group_ratio} × 1000 = ${implied}（实 ${quota}）`);
  }
}

const inspectId = process.argv[2] === 'inspect' ? process.argv[3] : null;
if (inspectId) {
  const deep = await deepVerify(inspectId);
  printChain(deep);
} else {
  await runLive();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`);
process.exitCode = failed.length ? 1 : 0;
