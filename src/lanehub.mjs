import { readFile } from 'node:fs/promises';
import { randomInt } from 'node:crypto';
import { hash, httpError } from './security.mjs';

// lanehub 接入：**额度真源在 lanehub**，这一侧只负责账号映射、充值入账和转发。
//
// 为什么把额度搬过去：lanehub（done-hub 底子）本来就是一套计费平台——用户额度、
// 令牌额度、分组倍率、消费日志、分析页都是现成的，而这一侧的 request_billing
// 状态机是在它之外又写了一遍同样的事。同一套逻辑维护两份，意味着对面修过的
// 那几个退款重复 / 预扣不释放的 bug，在这边还在。
//
// 三条边界：
//   · 一个客户 = lanehub 的**一个用户 + 一个令牌**。共用令牌的话 lanehub 只看得见
//     「一个用户花了多少」，按人算额度就没了，而那正是要归一的东西。
//   · 令牌按客户的**档位**（官方线 / 便宜线）签发，分组倍率直接决定他的售价。
//   · 充值入账必须**按支付单号幂等**：回调重放就是白送钱。

const LANE_DEFAULT = 'official';

/**
 * 管理令牌优先从文件读：这台机器上别的密钥（数据库口令、管理员口令）都走 *_FILE，
 * 权限 600、不进 compose.yaml，这一个不该例外。服务端和运维脚本共用这一份解析——
 * 各写各的会让脚本在「compose 里明明配好了」的情况下报缺配置。
 */
export async function adminTokenFromEnv(env = process.env) {
  if (env.LANEHUB_ADMIN_TOKEN) return env.LANEHUB_ADMIN_TOKEN;
  if (env.LANEHUB_ADMIN_TOKEN_FILE) return (await readFile(env.LANEHUB_ADMIN_TOKEN_FILE, 'utf8')).trim();
  return undefined;
}

/** lanehub 的管理 API 客户端。只用它建号、加额度、读额度——转发走既有的 upstream.request。 */
export class Lanehub {
  constructor({ baseUrl, adminToken, fetcher = fetch }) {
    if (!/^https?:\/\//.test(baseUrl ?? '')) throw new Error('lanehub_base_url_required');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.adminToken = adminToken;
    this.fetcher = fetcher;
  }

  async call(path, { method = 'GET', body } = {}) {
    const response = await this.fetcher(this.baseUrl + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        // done-hub 的管理接口认这个头；令牌来自部署时注入的 root 访问令牌。
        Authorization: 'Bearer ' + this.adminToken,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    let payload;
    try { payload = await response.json(); } catch { payload = null; }
    if (!response.ok || payload?.success === false) {
      // done-hub 用 HTTP 200 + success:false 报业务错，原文只在 message 里。丢掉它的话，
      // 排查时只剩一个 lanehub_api_failed，既不知道是哪条校验也不知道该改什么。
      const detail = payload?.message || ('http_' + response.status);
      throw Object.assign(httpError(502, 'lanehub_api_failed'), { detail, path, message: 'lanehub_api_failed: ' + detail });
    }
    return payload?.data ?? payload;
  }

  /** 建一个 lanehub 用户。用户名就是客户 id，重名时由调用方按映射表判重。 */
  async createUser(username, displayName) {
    // done-hub 的显示名上限 20 个字符，而这里传进来的是客户邮箱——超过 20 的邮箱很常见，
    // 不截就是一半客户建不出号。截断只影响后台列表里的展示，username 才是身份。
    const display = String(displayName ?? username).slice(0, 20);
    await this.call('/api/user/', { method: 'POST', body: { username, display_name: display, password: randomPassword() } });
    // 建号接口只回 success，不回用户对象——再查一次拿 id。
    return this.findUser(username);
  }

  /** 按用户名找已有用户：建号中途失败重来时，避免第二次建出重名用户。 */
  async findUser(username) {
    const page = await this.call('/api/user/?keyword=' + encodeURIComponent(username) + '&size=20');
    // 分页接口回的是 {data:[…], page, size, total_count}，而 call() 已经剥过一层 data。
    const list = Array.isArray(page) ? page : page?.data ?? [];
    return list.find((u) => u.username === username) ?? null;
  }

  /**
   * 给这个用户签一个令牌，分组 = 他的档位。
   *
   * 走 /api/token/for_user 而不是 /api/token/：后者只会给**当前登录的人**签，
   * 用管理员令牌调它，签出来的是管理员自己的密钥——客户拿着它花的是我们的钱。
   *
   * unlimited_quota=true 是刻意的：额度管在**用户**身上，不是令牌上，
   * 这样「这个客户还剩多少」只有一个数。
   */
  createToken(userId, name, lane = LANE_DEFAULT) {
    return this.call('/api/token/for_user', {
      method: 'POST',
      body: { user_id: userId, token: { name, expired_time: -1, unlimited_quota: true, group: lane } },
    });
  }

  /** 加额度。quota 是 lanehub 的内部单位（1 美元 = QuotaPerUnit）。 */
  addQuota(userId, quota, remark) {
    return this.call('/api/user/quota/' + userId, { method: 'POST', body: { quota, remark } });
  }

  balance(userId) {
    return this.call('/api/user/' + userId);
  }

  /**
   * lanehub 现行的美元汇率（PaymentUSDRate）。折算扣费必须用**对面的**汇率：
   * 消费日志里的 quota 是它按这个汇率算出来的，这边拿另一个数去折，账面就差几个点
   * （实测配的 7 和对面的 6.7078 差 4%），而插件作者的分成正是按这个数分的。
   * 缓存 10 分钟：它是管理项，不会一分钟一变，但也不该每笔账单都去问一次。
   */
  async usdRate() {
    if (this.rateCachedAt > Date.now() - 600_000) return this.rateCache;
    const options = await this.call('/api/option/');
    const rate = Number((Array.isArray(options) ? options : []).find((o) => o.key === 'PaymentUSDRate')?.value);
    if (!(rate > 0)) throw httpError(502, 'lanehub_usd_rate_unavailable');
    this.rateCache = rate; this.rateCachedAt = Date.now();
    return rate;
  }
}

// lanehub 的密码上限是 20 个字符（实测报错才发现）。这个密码没人会用——
// 客户走的是 IPZSK 自己的登录，这里只是建号必填项——但仍然要随机，
// 固定值等于给每个客户开了同一把后门。
// 用户名 = ipz + 客户 id 哈希的前 9 位（36 进制），恰好 12 个字符，且对同一个客户恒定：
// 建号中途失败重来时要能按同一个名字把人找回来。
function lanehubUsername(userId) {
  const digest = hash(String(userId));
  const short = BigInt('0x' + digest.slice(0, 16)).toString(36).slice(0, 9).padStart(9, '0');
  return 'ipz' + short;
}

const PASSWORD_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
// 建号密码不给人用，但必须不可预测：用 CSPRNG（node:crypto），字符集与长度沿用 lanehub 已接受的格式。
export function randomPassword() {
  let value = 'ipz';
  for (let i = 0; i < 16; i++) value += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
  return value;
}

/**
 * 保证这个客户在 lanehub 有账号和令牌，并把令牌存成一条 upstream_keys 行。
 *
 * 为什么要落成 upstream_keys 行而不是单独一张表：转发、并发闸、请求归属（requests.key_id
 * 是外键）、尝试记录全都吃这张表。另起一套等于把那四处各改一遍。
 *
 * 这条 key 的 models 故意留空：普通选路按 `$1=ANY(k.models)` 匹配，空数组保证它
 * **不会被legacy 池选中**——它只在 lanehub 模式下按客户直取。
 *
 * 幂等：以 lanehub_accounts.user_id 为准。中途失败（建了用户没建令牌）重来时，
 * findUser 会把已建的用户捡回来，不会留下两个同名用户。
 */
export async function ensureAccount(db, lanehub, upstream, { userId, name, lane = LANE_DEFAULT, accountId }) {
  const existing = (await db.query(
    `SELECT a.*, k.secret_ref, k.id AS key_id FROM lanehub_accounts a JOIN upstream_keys k ON k.id=a.key_id WHERE a.user_id=$1`,
    [userId])).rows[0];
  // created 标记给发放新人额度用：只有**这一次真的建了映射**才发，
  // 已有映射（包括余额迁移脚本先建的那批）一律不发。
  if (existing) return { ...existing, created: false };

  // lanehub 的用户名上限 12 个字符（实测报错才发现），装不下 uuid，只能压成哈希。
  const username = lanehubUsername(userId);
  const found = await lanehub.findUser(username);
  const lanehubUserId = found?.id ?? (await lanehub.createUser(username, name ?? username))?.id;
  if (!Number.isInteger(lanehubUserId)) throw httpError(502, 'lanehub_user_create_failed');

  // 压成 9 位哈希就有撞名的可能，而撞名的后果是**两个客户共用一个钱包**——
  // 一个人充的钱另一个人花得掉。这里宁可当场失败也不能悄悄合并。
  const taken = (await db.query('SELECT user_id FROM lanehub_accounts WHERE lanehub_user_id=$1', [lanehubUserId])).rows[0];
  if (taken && String(taken.user_id) !== String(userId)) throw httpError(500, 'lanehub_username_collision');

  const token = await lanehub.createToken(lanehubUserId, username, lane);
  if (typeof token?.key !== 'string') throw httpError(502, 'lanehub_token_create_failed');

  const keyId = await upstream.addKey({ account_id: accountId, name: username, key: token.key, concurrency: 3, models: [] });
  await db.query(
    `INSERT INTO lanehub_accounts (user_id,lanehub_user_id,key_id,lane) VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id) DO NOTHING`, [userId, lanehubUserId, keyId, lane]);

  const row = (await db.query(
    `SELECT a.*, k.secret_ref, k.id AS key_id FROM lanehub_accounts a JOIN upstream_keys k ON k.id=a.key_id WHERE a.user_id=$1`,
    [userId])).rows[0];
  return { ...row, created: true };
}

/**
 * 登录后给这个客户备好 lanehub 的账号与密钥，并在**首次**建号时发放新人额度。
 *
 * 一个客户一个密钥（映射表主键就是 user_id），所以这个函数在哪调都安全——
 * 登录、桌面端 bootstrap、第一次发请求，三处都调，重复调不会多建也不会多发钱。
 *
 * 新人额度的幂等键是 `signup:<客户 id>`：
 *   · 重复登录不会重复发
 *   · 余额迁移脚本先建过映射的老客户**不会**被当成新人（created 为 false）
 *   · 发放失败不影响登录——额度可以补，登录不能卡
 */
export async function provisionCustomer(db, lanehub, upstream, {
  userId, name, lane = LANE_DEFAULT, accountId, signupCny = 0, usdCnyRate, quotaPerUnit,
}) {
  const account = await ensureAccount(db, lanehub, upstream, { userId, name, lane, accountId });
  if (!account.created || !(Number(signupCny) > 0)) return account;

  try {
    await creditAccount(db, lanehub, {
      userId, lanehubUserId: account.lanehub_user_id, amountCny: signupCny,
      usdCnyRate, quotaPerUnit, reference: `signup:${userId}`, remark: '新用户注册赠送',
    });
  } catch {
    // 发不出去就算了：额度事后能补，登录不能卡在这一步。
  }
  return account;
}

/**
 * lanehub 额度调整（加额度 / 扣额度）的状态机，一行 lanehub_credits 对应一次调整：
 *
 *   pending → applying → applied
 *                     ↘ review → applied | pending（人工确认未生效后重试）| cancelled
 *
 * lanehub 的 /api/user/quota/:id 是增量接口（quota = quota + delta），没有幂等键。
 * 所以 applying 一旦提交到库，远程调用的任何未知结果（超时、断连、非 2xx、业务错误）
 * 都只能进 review，由人工到 lanehub 核对后再处理；绝不删除占位、绝不自动重试。
 * 只有 pending（远程调用尚未开始）可以被重试接手。占位行必须在调用前**独立提交**，
 * 因此本函数不能在调用方事务里执行（db 必须是连接池）。
 */
export const lanehubQuota = (amountCny, usdCnyRate, quotaPerUnit) =>
  Math.round((Number(amountCny) / Number(usdCnyRate)) * Number(quotaPerUnit));

/** 落一行 pending 占位；同一 reference 已存在时返回原行（用户、方向、金额不同则冲突）。 */
export async function startAdjustment(db, { reference, userId, lanehubUserId, kind = 'credit', amountCny, quota, remark, payload = {} }) {
  if (!reference) throw httpError(400, 'credit_reference_required');
  if (!(Number(amountCny) > 0) || !Number.isSafeInteger(quota) || quota <= 0) throw httpError(400, 'invalid_credit_amount');
  if (!Number.isInteger(Number(lanehubUserId))) throw httpError(400, 'lanehub_user_required');
  await db.query(`INSERT INTO lanehub_credits (reference,user_id,amount_cny,quota,kind,lanehub_user_id,remark,payload,state)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending') ON CONFLICT (reference) DO NOTHING`,
  [reference, userId, String(amountCny), quota, kind, Number(lanehubUserId), remark ?? reference, JSON.stringify(payload)]);
  const row = (await db.query('SELECT * FROM lanehub_credits WHERE reference=$1', [reference])).rows[0];
  if (String(row.user_id) !== String(userId) || row.kind !== kind || Number(row.amount_cny) !== Number(amountCny))
    throw httpError(409, 'adjustment_reference_conflict');
  return row;
}

/**
 * 接手一行 pending 并调用 lanehub。返回 { applied: 本次是否生效, state, quota }。
 * 远程失败不抛错：行已进 review，调用方按 state 决定怎么回应。
 */
export async function applyAdjustment(db, lanehub, reference) {
  const row = (await db.query(`UPDATE lanehub_credits SET state='applying',updated_at=now()
    WHERE reference=$1 AND state='pending' RETURNING *`, [reference])).rows[0];
  if (!row) {
    const current = (await db.query('SELECT state FROM lanehub_credits WHERE reference=$1', [reference])).rows[0];
    return { applied: false, state: current?.state ?? 'missing', quota: 0 };
  }
  const quota = Number(row.quota);
  try {
    await lanehub.addQuota(row.lanehub_user_id, row.kind === 'debit' ? -quota : quota, row.remark ?? reference);
  } catch (error) {
    // 请求已发出，对面是否已改额度未知：只能人工核对。
    await db.query(`UPDATE lanehub_credits SET state='review',review_reason=$2,updated_at=now() WHERE reference=$1 AND state='applying'`,
      [reference, String(error?.detail ?? error?.code ?? error?.message ?? 'unknown').slice(0, 200)]);
    return { applied: false, state: 'review', quota: 0 };
  }
  // 这一步失败时行停在 applying，由 sweepAdjustments 超时转 review，同样不会重放。
  const done = await db.query(`UPDATE lanehub_credits SET state='applied',applied_at=now(),updated_at=now(),
    booked_at=CASE WHEN payload ? 'booking' THEN NULL ELSE now() END WHERE reference=$1 AND state='applying'`, [reference]);
  // 行已被超时清扫转成 review（理论上不会发生：调用 15 秒超时）时以库中状态为准，交人工核对。
  if (!done.rowCount) return { applied: false, state: 'review', quota: 0 };
  return { applied: true, state: 'applied', quota };
}

/** 进程在 applying 期间退出的行：结果未知，转人工核对。 */
export function sweepAdjustments(db) {
  return db.query(`UPDATE lanehub_credits SET state='review',review_reason='adjustment_interrupted',updated_at=now()
    WHERE state='applying' AND updated_at<now()-interval '5 minutes'`);
}

/**
 * 充值入账：把人民币加到这个客户在 lanehub 的额度上。
 *
 * **幂等键是 reference**（注册赠送 / 迁移批次+客户 / 补发）。重试必须落到同一个 reference 上。
 * 已存在的 reference：pending 会被接手执行；applying / applied / review / cancelled 一律不再调用对面。
 */
export async function creditAccount(db, lanehub, { userId, lanehubUserId, amountCny, usdCnyRate, quotaPerUnit, reference, remark }) {
  if (!(amountCny > 0)) throw httpError(400, 'invalid_credit_amount');
  if (!reference) throw httpError(400, 'credit_reference_required');
  const quota = lanehubQuota(amountCny, usdCnyRate, quotaPerUnit);
  if (!Number.isSafeInteger(quota) || quota <= 0) throw httpError(400, 'invalid_credit_amount');
  await startAdjustment(db, { reference, userId, lanehubUserId, amountCny, quota, remark });
  return applyAdjustment(db, lanehub, reference);
}

/**
 * 生成与报价共用的备号入口：保证用户有自己的 lanehub 令牌（报价按令牌档位算，必须先有）。
 * 参数与生成入口原先内联的 provisionCustomer 调用逐字一致，汇率用配置值。
 */
export function ensureLanehubKey(db, options, user) {
  const { lanehub, upstream, lanehubAccountId = null, lanehubSignupCny = 0, lanehubUsdCny = 0, lanehubQuotaPerUnit = 500_000 } = options;
  return provisionCustomer(db, lanehub, upstream, { userId: user.id, name: user.name,
    accountId: lanehubAccountId, signupCny: lanehubSignupCny, usdCnyRate: lanehubUsdCny, quotaPerUnit: lanehubQuotaPerUnit });
}

/** lanehub 模式开关。存在 settings 表里，切换脚本改它，网关每次请求读一次（带缓存）。 */
export async function lanehubMode(db) {
  const row = (await db.query("SELECT value FROM app_settings WHERE key='lanehub_mode'")).rows[0];
  return row?.value === 'on';
}

/**
 * 三处（注册/登录后、桌面端 bootstrap、第一次发请求）都要备号，参数一模一样。
 * 写三遍的结果是某处漏一个字段——比如漏掉 signupCny，那条路进来的新用户就不发钱。
 */
export async function provisionIfEnabled(db, options, { userId, name }) {
  const { lanehub, upstream, lanehubAccountId, lanehubSignupCny = 0, lanehubUsdCny, lanehubQuotaPerUnit } = options;
  if (!lanehub || !(await lanehubMode(db))) return null;
  return provisionCustomer(db, lanehub, upstream, {
    userId, name, accountId: lanehubAccountId, signupCny: lanehubSignupCny,
    // 折算汇率以对面为准，配的那个只兜底：进的钱和出的账用同一个汇率，
    // 「送了 5 块」在用户那边看回来才还是 5 块。历史余额迁移不走这条路——
    // 那个脚本要求显式给汇率，一批客户必须按同一个数折算。
    usdCnyRate: await lanehub.usdRate().catch(() => lanehubUsdCny), quotaPerUnit: lanehubQuotaPerUnit,
  });
}
