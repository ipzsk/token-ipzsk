#!/usr/bin/env node
/**
 * lanehub 接入的端到端自检：**建号 → 送新人额度 → 报价 → 提交 → 轮询 → 余额下降**。
 *
 * 它打的是真的 lanehub 和真的库，不是 mock——单元测试能证明幂等逻辑对，证明不了
 * 「对面的接口真是这个形状」。这两类错各出过一次（管理接口的字段名、任务响应的形状），
 * 都是只有真打一次才看得见。
 *
 * **可以反复跑**。所有写操作的幂等键都是固定的（测试客户 id 固定、reference 固定），
 * 第二次跑时建号跳过、新人额度跳过，只有生成请求会真的再花一次钱——那是唯一无法
 * 幂等的一步（上游不认我们的幂等键），所以它默认关着，要花钱才加 --spend。
 *
 *   export DATABASE_URL=postgres://user:pass@127.0.0.1:5433/ipzsk_e2e
 *   export LANEHUB_BASE_URL=http://localhost:3000
 *   export LANEHUB_ADMIN_TOKEN=sk-...          # lanehub 的管理令牌
 *   node scripts/lanehub-e2e.mjs               # 不花钱：只验建号、额度、报价
 *   node scripts/lanehub-e2e.mjs --spend       # 连真实生成一起验（会扣真钱）
 */
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { database } from '../src/database.mjs';
import { Upstream } from '../src/upstream.mjs';
import { Lanehub, provisionCustomer } from '../src/lanehub.mjs';
import { reconcileLanehubCharges } from '../src/lanehub-charges.mjs';

const spend = process.argv.includes('--spend');
const env = (name, fallback) => process.env[name] ?? fallback;

const required = ['DATABASE_URL', 'LANEHUB_BASE_URL', 'LANEHUB_ADMIN_TOKEN'];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  console.error('缺少环境变量：' + missing.join(' '));
  process.exit(2);
}

// 固定的测试身份：跑第二次要落在同一个客户上，否则每跑一次就多一个 lanehub 用户。
const TEST_USER_ID = env('LANEHUB_E2E_USER_ID', '00000000-0000-4000-8000-00000000e2e1');
const SIGNUP_CNY = 5;
const USD_CNY = Number(env('LANEHUB_USD_CNY', '7'));
const QUOTA_PER_UNIT = Number(env('LANEHUB_QUOTA_PER_UNIT', '500000'));
const MODEL = env('LANEHUB_E2E_MODEL', 'gpt-image-2');

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? '  ' + detail : ''}`);
};

const db = database({ connectionString: process.env.DATABASE_URL });
// 密钥目录必须**跨次稳定**：库里存的是 secret_ref（文件名），每次跑换一个临时目录
// 的话，第二次跑就读不到上次建的那把密钥——而「能重复跑」正是这个脚本的意义。
const secretDir = env('UPSTREAM_SECRET_DIR', join(tmpdir(), 'ipzsk-e2e-secrets'));
await mkdir(secretDir, { recursive: true, mode: 0o700 });
const upstream = new Upstream(db, secretDir);
const lanehub = new Lanehub({ baseUrl: process.env.LANEHUB_BASE_URL, adminToken: process.env.LANEHUB_ADMIN_TOKEN });

try {
  await db.migrate();

  // ── 前置：一个 lanehub 类型的上游账户 + 一个测试客户。两者都按固定 id 幂等。 ──
  const accountId = (await db.query(
    `INSERT INTO upstream_accounts (id,name,concurrency,base_url,provider_type)
     VALUES ($1,'lanehub-e2e',5,$2,'lanehub')
     ON CONFLICT (name) DO UPDATE SET base_url=EXCLUDED.base_url RETURNING id`,
    [randomUUID(), process.env.LANEHUB_BASE_URL])).rows[0].id;
  await db.query(`INSERT INTO users (id,name,rpm) VALUES ($1,'e2e-customer',60) ON CONFLICT (id) DO NOTHING`, [TEST_USER_ID]);

  // ── 1. 建号 + 新人额度 ──────────────────────────────────────────────
  const before = (await db.query('SELECT count(*)::int AS n FROM lanehub_accounts WHERE user_id=$1', [TEST_USER_ID])).rows[0].n;
  const first = await provisionCustomer(db, lanehub, upstream, {
    userId: TEST_USER_ID, name: 'e2e-customer', accountId,
    signupCny: SIGNUP_CNY, usdCnyRate: USD_CNY, quotaPerUnit: QUOTA_PER_UNIT,
  });
  check('建号：拿到 lanehub 用户与密钥', Number.isInteger(first.lanehub_user_id) && Boolean(first.secret_ref),
    `lanehub_user=${first.lanehub_user_id}`);

  // 再跑一次：一个客户只能有一个密钥，新人额度只能发一次。
  const second = await provisionCustomer(db, lanehub, upstream, {
    userId: TEST_USER_ID, name: 'e2e-customer', accountId,
    signupCny: SIGNUP_CNY, usdCnyRate: USD_CNY, quotaPerUnit: QUOTA_PER_UNIT,
  });
  check('幂等：重复调用不再建号', second.key_id === first.key_id && second.created === false);

  const grants = (await db.query(`SELECT count(*)::int AS n FROM lanehub_credits WHERE reference=$1`, ['signup:' + TEST_USER_ID])).rows[0].n;
  check('幂等：新人额度只有一条入账记录', grants === 1, `signup 记录 ${grants} 条`);
  if (before > 0) console.log('  （这个测试客户之前就建过号，新人额度理应早已发过——上面两条仍然成立）');

  const account = await lanehub.balance(first.lanehub_user_id);
  const quotaBefore = Number(account?.quota ?? 0);
  check('额度：lanehub 侧读得到余额', Number.isFinite(quotaBefore), `quota=${quotaBefore}`);

  // ── 2. 报价（不花钱） ──────────────────────────────────────────────
  const token = await upstream.secret(first.secret_ref);
  const callAsCustomer = (path, init = {}) => fetch(process.env.LANEHUB_BASE_URL + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...init.headers },
    signal: AbortSignal.timeout(60_000),
  });

  const quote = await (await callAsCustomer('/v1/quote', {
    method: 'POST', body: JSON.stringify({ model: MODEL, prompt: 'e2e', aspect_ratio: '1:1' }),
  })).json();
  check('报价：拿到金额与报价 id', typeof quote.amount_cny === 'string' && typeof quote.quote_id === 'string',
    `${quote.amount_cny} CNY，档位 ${quote.tier}，线路 ${quote.lane}`);

  // 报价指纹必须认参数：改掉影响价钱的键之后提交，应当被拒。
  const mismatched = await callAsCustomer('/v1/images/generations', {
    method: 'POST', headers: { 'X-Quote-Id': quote.quote_id },
    body: JSON.stringify({ model: MODEL, prompt: 'e2e', aspect_ratio: '1:1', resolution: '4k' }),
  });
  const mismatchBody = await mismatched.json();
  check('报价校验：改了影响价钱的参数会被拒', mismatchBody?.code === 'quote_mismatch', mismatchBody?.code ?? '');

  // ── 3. 真实生成（花钱，默认关） ─────────────────────────────────────
  if (!spend) {
    console.log('\n（没加 --spend，跳过真实生成与扣费验证）');
  } else {
    const submitted = await callAsCustomer('/v1/images/generations', {
      method: 'POST', headers: { 'X-Quote-Id': quote.quote_id },
      body: JSON.stringify({ model: MODEL, prompt: 'e2e lemon', aspect_ratio: '1:1' }),
    });
    // lanehub 把它的 request id 放在响应头里；网关就是靠它把扣费查回来的。
    const lanehubRequestId = submitted.headers.get('x-oneapi-request-id');
    const submit = await submitted.json();
    const taskId = submit?.data?.[0]?.task_id;
    check('提交：报价一致的请求被放行', Boolean(taskId), taskId ?? JSON.stringify(submit).slice(0, 120));

    let task = null;
    for (let i = 0; i < 24 && taskId; i++) {
      task = await (await callAsCustomer('/v1/tasks/' + encodeURIComponent(taskId))).json();
      if (['completed', 'failed'].includes(task?.data?.status)) break;
      await new Promise((done) => setTimeout(done, 5000));
    }
    const data = task?.data ?? {};
    check('任务：走到终态', ['completed', 'failed'].includes(data.status), data.status ?? '无状态');
    check('任务形状：data.id / status / progress 都在', Boolean(data.id) && typeof data.status === 'string' && typeof data.progress === 'number');
    check('任务形状：结果是 images/videos[].url', Array.isArray(data.result?.images ?? data.result?.videos),
      JSON.stringify(data.result ?? null).slice(0, 80));
    check('终态带 charge_cny', typeof data.charge_cny === 'string', data.charge_cny ?? '');
    check('报价与实扣一致', data.charge_cny === quote.amount_cny, `报 ${quote.amount_cny} / 扣 ${data.charge_cny}`);

    const after = Number((await lanehub.balance(first.lanehub_user_id))?.quota ?? 0);
    check('余额下降', after < quotaBefore, `${quotaBefore} → ${after}`);

    // ── 4. 扣费回到这一侧：插件作者的分成读的就是 request_billing.charged_cny ──
    // 这一步是变现模型的落点。没有它，作者后台的收益永远是 0。
    // 这个脚本直接打 lanehub，不经过网关，所以库里没有 requests 行——补一条形状一样的，
    // 字段取自真实响应（key_id 指向这个客户的 lanehub 密钥，upstream_id 就是上面那个头）。
    // 补记扫描刻意跳过刚完成 30 秒内的请求（那时对面的消费日志可能还没落库），
    // 这里把 completed_at 往前挪，免得脚本干等。
    check('提交响应带 lanehub 的 request id', Boolean(lanehubRequestId), lanehubRequestId ?? '缺');
    const requestId = randomUUID();
    await db.query(`INSERT INTO requests (id,user_id,key_id,model,fingerprint,status,stream,upstream_id,completed_at)
      VALUES ($1,$2,$3,$4,'e2e','succeeded',false,$5,now()-interval '2 minutes')`,
    [requestId, TEST_USER_ID, first.key_id, MODEL, lanehubRequestId]);
    const rates = { usdCnyRate: USD_CNY, quotaPerUnit: QUOTA_PER_UNIT };
    const firstPass = await reconcileLanehubCharges(db, lanehub, rates);
    const bill = (await db.query(
      `SELECT b.state,b.charged_cny,b.price_snapshot FROM request_billing b JOIN requests r ON r.id=b.request_id
       WHERE r.user_id=$1 ORDER BY b.created_at DESC LIMIT 1`, [TEST_USER_ID])).rows[0];
    check('扣费回写：这一侧补出了一条已结算账单', bill?.state === 'settled',
      `${bill?.state ?? '无账单'} ¥${bill?.charged_cny ?? '-'}（补记 ${firstPass.settled} 条）`);
    check('扣费回写：金额取自 lanehub 的消费日志', Number(bill?.price_snapshot?.quota) > 0,
      `quota=${bill?.price_snapshot?.quota ?? '-'}`);
    // 这条是分成的地基：作者分的是「客户实际付了多少」，差一分都是分错。
    check('扣费回写：补记金额 = 客户实扣', bill?.charged_cny === data.charge_cny,
      `补记 ${bill?.charged_cny ?? '-'} / 实扣 ${data.charge_cny}`);

    // 幂等：再扫一遍不能多出第二条账单（多一条就是把作者的分成算两遍）。
    const billsBefore = (await db.query('SELECT count(*)::int AS n FROM request_billing b JOIN requests r ON r.id=b.request_id WHERE r.user_id=$1', [TEST_USER_ID])).rows[0].n;
    await reconcileLanehubCharges(db, lanehub, rates);
    const billsAfter = (await db.query('SELECT count(*)::int AS n FROM request_billing b JOIN requests r ON r.id=b.request_id WHERE r.user_id=$1', [TEST_USER_ID])).rows[0].n;
    check('幂等：重复补记不会多出账单行', billsBefore === billsAfter, `${billsBefore} → ${billsAfter}`);
  }

} finally {
  await db.close();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`);
process.exitCode = failed.length ? 1 : 0;
