import { httpError } from './security.mjs';

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
      throw httpError(502, 'lanehub_api_failed', payload?.message ?? ('http_' + response.status));
    }
    return payload?.data ?? payload;
  }

  /** 建一个 lanehub 用户。用户名就是客户 id，重名时由调用方按映射表判重。 */
  createUser(username, displayName) {
    return this.call('/api/user/', { method: 'POST', body: { username, display_name: displayName, password: randomPassword() } });
  }

  /** 按用户名找已有用户：建号中途失败重来时，避免第二次建出重名用户。 */
  async findUser(username) {
    const rows = await this.call('/api/user/search?keyword=' + encodeURIComponent(username));
    const list = Array.isArray(rows) ? rows : rows?.data ?? [];
    return list.find((u) => u.username === username) ?? null;
  }

  /** 给这个用户签一个令牌，分组 = 他的档位。额度不限——额度管在用户身上，不是令牌上。 */
  createToken(userId, name, lane = LANE_DEFAULT) {
    return this.call('/api/token/', {
      method: 'POST',
      body: { name, expired_time: -1, unlimited_quota: true, group: lane, user_id: userId },
    });
  }

  /** 加额度。quota 是 lanehub 的内部单位（1 美元 = QuotaPerUnit）。 */
  addQuota(userId, quota, remark) {
    return this.call('/api/user/quota', { method: 'PUT', body: { user_id: userId, quota, remark } });
  }

  balance(userId) {
    return this.call('/api/user/' + userId);
  }
}

function randomPassword() {
  return 'ipz-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
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
  if (existing) return existing;

  const username = 'ipz_' + String(userId).replace(/-/g, '').slice(0, 24);
  const found = await lanehub.findUser(username);
  const lanehubUserId = found?.id ?? (await lanehub.createUser(username, name ?? username))?.id;
  if (!Number.isInteger(lanehubUserId)) throw httpError(502, 'lanehub_user_create_failed');

  const token = await lanehub.createToken(lanehubUserId, username, lane);
  if (typeof token?.key !== 'string') throw httpError(502, 'lanehub_token_create_failed');

  const keyId = await upstream.addKey({ account_id: accountId, name: username, key: token.key, concurrency: 3, models: [] });
  await db.query(
    `INSERT INTO lanehub_accounts (user_id,lanehub_user_id,key_id,lane) VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id) DO NOTHING`, [userId, lanehubUserId, keyId, lane]);

  return (await db.query(
    `SELECT a.*, k.secret_ref, k.id AS key_id FROM lanehub_accounts a JOIN upstream_keys k ON k.id=a.key_id WHERE a.user_id=$1`,
    [userId])).rows[0];
}

/**
 * 充值入账：把人民币加到这个客户在 lanehub 的额度上。
 *
 * **幂等键是 reference**（支付单号 / 兑换码 id / 迁移批次+客户）。支付回调重放、
 * 迁移脚本重跑都必须落到同一个 reference 上——否则每重放一次就是白送一次钱。
 *
 * 先占位再调对面：反过来的话（先加额度再写库）进程在两步之间挂掉，重跑会加两次。
 * 占位失败 = 已经入过账，直接返回。
 */
export async function creditAccount(db, lanehub, { userId, lanehubUserId, amountCny, usdCnyRate, quotaPerUnit, reference, remark }) {
  if (!(amountCny > 0)) throw httpError(400, 'invalid_credit_amount');
  if (!reference) throw httpError(400, 'credit_reference_required');
  const quota = Math.round((Number(amountCny) / Number(usdCnyRate)) * Number(quotaPerUnit));
  if (!Number.isSafeInteger(quota) || quota <= 0) throw httpError(400, 'invalid_credit_amount');

  const claimed = await db.query(
    `INSERT INTO lanehub_credits (reference,user_id,amount_cny,quota) VALUES ($1,$2,$3,$4)
     ON CONFLICT (reference) DO NOTHING RETURNING reference`, [reference, userId, String(amountCny), quota]);
  if (!claimed.rowCount) return { applied: false, quota: 0 };

  try {
    await lanehub.addQuota(lanehubUserId, quota, remark ?? reference);
  } catch (error) {
    // 对面没加成就把占位撤掉，否则这笔钱永远加不上去了（reference 已被占用）。
    await db.query('DELETE FROM lanehub_credits WHERE reference=$1', [reference]);
    throw error;
  }
  await db.query('UPDATE lanehub_credits SET applied_at=now() WHERE reference=$1', [reference]);
  return { applied: true, quota };
}

/** lanehub 模式开关。存在 settings 表里，切换脚本改它，网关每次请求读一次（带缓存）。 */
export async function lanehubMode(db) {
  const row = (await db.query("SELECT value FROM app_settings WHERE key='lanehub_mode'")).rows[0];
  return row?.value === 'on';
}
