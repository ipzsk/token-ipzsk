import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, httpError } from './security.mjs';
import { recordTaskCharge } from './task-charges.mjs';
import { mediaPricing } from './model-catalog.mjs';

// 每个 provider_type 登记自己的余额与任务查询路径，以及余额响应的形状校验。未知类型直接 throw：
// 静默回落到 apimart 会用错扣费口径，且不会有任何报错。
// 没有的能力写显式 null（不是省略）：漏登记一项会当场 TypeError，不会被当成「这家没有」。
const providers = {
  apimart: { label:'APIMart', keyBalance:'/v1/balance', accountBalance:'/v1/user/balance', task:(id) => '/v1/tasks/'+encodeURIComponent(id),
    validBalance:(d) => d.success === true && ['remain_balance','used_balance','remain_credits','used_credits'].every((f) => Number.isFinite(d[f])) },
  // 通用 OpenAI 兼容中转（one-api / new-api 系，如书虫 / BBshare）：只转发对话与媒体同步接口。
  openai_relay: { label:'通用 OpenAI 中转', keyBalance:null, accountBalance:null, task:null, validBalance:null },
  // lanehub：线路矩阵网关。它有异步任务接口，且**任务响应已经是规范化形状**
  // （data.id / data.status 小写词表 / data.result / data.charge_cny），
  // 所以 media-task-sync 那套解析可以原样用在它身上。
  // 余额不在这一侧看：额度真源在 lanehub，它自己的用户页就是账本。
  lanehub: { label:'lanehub 线路矩阵', keyBalance:null, accountBalance:null,
    task:(id) => '/v1/tasks/'+encodeURIComponent(id), validBalance:null },
};
export const providerTypes = Object.keys(providers);
export const providerOptions = Object.entries(providers).map(([type, p]) => ({ type, label:p.label }));
// candidates 的可用性按能力分支，名单从注册表算出来，数据库里不另存一份会漂移的枚举。
const balanceProviders = providerTypes.filter((t) => providers[t].accountBalance);
const taskProviders = providerTypes.filter((t) => providers[t].task);
export function providerPaths(type) {
  const paths = providers[type];
  if (!paths) throw new Error('unknown_provider_type');
  return paths;
}

export class Upstream {
  pending = null;
  timer = null;
  taskChargesPending = null;
  constructor(db, secretDir, fetcher = fetch) {
    this.db = db;
    this.secretDir = secretDir;
    this.fetcher = fetcher;
  }
  async secret(ref) {
    if (!/^[a-zA-Z0-9-]+\.key$/.test(ref)) throw new Error('invalid_secret_ref');
    return (await readFile(join(this.secretDir, ref), 'utf8')).trim();
  }
  async addKey({ account_id, name, key, concurrency = 3, models = [] }, existingRef) {
    // `sk-` 前缀是 APIMart 那家的写法，不是通用的：lanehub 的令牌就没有前缀
    // （实测 addKey 把它判成 invalid_upstream_key 才发现）。前缀改成可选，
    // 字符集与长度仍然要卡——那两条挡的是「把整段 JSON 粘进输入框」这类错。
    if (!/^(sk-)?[A-Za-z0-9_-]{16,240}$/.test(key)) throw httpError(400, 'invalid_upstream_key');
    const fingerprint = hash(key);
    const existing = await this.db.query('SELECT id FROM upstream_keys WHERE fingerprint=$1', [fingerprint]);
    if (existing.rowCount) throw httpError(409, 'key_already_exists');
    const id = randomUUID();
    const ref = existingRef ?? `${id}.key`;
    if (!existingRef) {
      await mkdir(this.secretDir, { recursive: true, mode: 0o700 });
      await writeFile(join(this.secretDir, ref), key + '\n', { mode: 0o600, flag: 'wx' });
    }
    // Orphan secret files after a failed insert are never served and may be removed manually.
    await this.db.query(`INSERT INTO upstream_keys
      (id, account_id, name, fingerprint, suffix, secret_ref, concurrency, models)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [id, account_id, name, fingerprint, key.slice(-4), ref, concurrency, models]);
    return id;
  }
  // channel 是渠道行（带 secret_ref/base_url）；仅 media-task-sync 仍按 secret_ref 字符串调用。
  async request(channel, path, options = {}) {
    const c = typeof channel === 'string' ? await this.channelByRef(channel) : channel;
    const key = await this.secret(c.secret_ref);
    return this.fetcher(c.base_url.replace(/\/+$/,'') + path, {
      ...options, redirect: 'error',
      headers: { ...(options.body instanceof FormData?{}:{'Content-Type': 'application/json'}), ...options.headers, Authorization: `Bearer ${key}` },
    });
  }
  async channelByRef(ref) {
    const row = (await this.db.query(`SELECT k.secret_ref,a.base_url,a.provider_type FROM upstream_keys k
      JOIN upstream_accounts a ON a.id=k.account_id WHERE k.secret_ref=$1`, [ref])).rows[0];
    if (!row) throw new Error('unknown_channel');
    return row;
  }
  async balance(channel, path) {
    const response = await this.request(channel, path, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`upstream_http_${response.status}`); }
    const data = await response.json();
    if (!providerPaths(channel.provider_type).validBalance(data)) throw new Error('invalid_balance_response');
    return data;
  }
  refreshSoon() {
    if (this.timer || this.pending) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.refresh().catch(() => {});
    }, 5000);
    this.timer.unref();
  }
  refresh() {
    if (this.pending) return this.pending;
    this.pending = this.sync().finally(() => { this.pending = null; });
    return this.pending;
  }
  async sync() {
    const { rows } = await this.db.query(`SELECT k.*,a.base_url,a.provider_type FROM upstream_keys k
      JOIN upstream_accounts a ON a.id=k.account_id WHERE k.enabled AND a.enabled ORDER BY k.created_at`);
    const accounts = new Map();
    for (const key of rows) {
      if (!accounts.has(key.account_id)) accounts.set(key.account_id, []);
      accounts.get(key.account_id).push(key);
      try {
        const paths = providerPaths(key.provider_type);
        // 没有余额接口的渠道不查余额；candidates 对这类渠道也不看余额新鲜度，跳过不等于停用。
        if (!paths.keyBalance) continue;
        const b = await this.balance(key, paths.keyBalance);
        await this.db.tx(async (c) => {
          await c.query(`UPDATE upstream_keys SET balance=$2,used_balance=$3,unlimited=$4,
            remain_credits=$5,used_credits=$6,balance_at=now(),balance_error=NULL,last_error=NULL WHERE id=$1`,
          [key.id, String(b.remain_balance), String(b.used_balance), b.unlimited_quota === true, String(b.remain_credits), String(b.used_credits)]);
          await c.query(`INSERT INTO balance_snapshots (account_id,key_id,balance,used_balance,unlimited,remain_credits,used_credits)
            VALUES ($1,$2,$3,$4,$5,$6,$7)`, [key.account_id, key.id, String(b.remain_balance), String(b.used_balance), b.unlimited_quota === true, String(b.remain_credits), String(b.used_credits)]);
        });
      } catch (error) {
        await this.db.query('UPDATE upstream_keys SET balance_error=$2 WHERE id=$1',
          [key.id, safeBalanceError(error)]);
      }
    }
    // Refresh each account once; another key may authenticate if the first is invalid.
    for (const [id, keys] of accounts) {
      let lastError;
      for (const key of keys) {
        try {
          const paths = providerPaths(key.provider_type);
          if (!paths.accountBalance) break;
          const b = await this.balance(key, paths.accountBalance);
          await this.db.tx(async (c) => {
            await c.query(`UPDATE upstream_accounts SET balance=$2,used_balance=$3,balance_at=now(),
              remain_credits=$4,used_credits=$5,balance_error=NULL,blocked=($4::numeric<=0) WHERE id=$1`, [id, String(b.remain_balance), String(b.used_balance), String(b.remain_credits), String(b.used_credits)]);
            await c.query('INSERT INTO balance_snapshots (account_id,balance,used_balance,remain_credits,used_credits) VALUES ($1,$2,$3,$4,$5)',
              [id, String(b.remain_balance), String(b.used_balance), String(b.remain_credits), String(b.used_credits)]);
          });
          lastError = null;
          break;
        } catch (error) { lastError = safeBalanceError(error); }
      }
      if (lastError) await this.db.query('UPDATE upstream_accounts SET balance_error=$2 WHERE id=$1', [id, lastError]);
    }
    return { refreshed_keys: rows.length, refreshed_accounts: accounts.size };
  }
  async candidates(model, skip = []) {
    // 媒体模型必须落在有异步任务接口的渠道上：提交成功但取不回结果，钱已经冻结了。
    let media = false; try { mediaPricing(model); media = true; } catch { /* chat 或未知模型按非媒体处理 */ }
    return (await this.db.query(`SELECT k.id,k.account_id,k.secret_ref,k.concurrency,a.concurrency AS account_concurrency,a.base_url,a.provider_type
      FROM upstream_keys k JOIN upstream_accounts a ON a.id=k.account_id
      WHERE k.enabled AND a.enabled AND NOT a.blocked AND (k.cooldown_until IS NULL OR k.cooldown_until<=now())
      AND (NOT a.provider_type=ANY($3::text[]) OR (a.remain_credits>0
        AND a.balance_at>now()-interval '10 minutes' AND k.balance_at>now()-interval '10 minutes'
        AND (k.unlimited OR k.remain_credits>0)))
      AND (NOT $4::boolean OR a.provider_type=ANY($5::text[]))
      AND $1=ANY(k.models) AND NOT (k.id=ANY($2::uuid[])) ORDER BY k.created_at`,
    [model, skip, balanceProviders, media, taskProviders])).rows;
  }
  syncTaskCharges() {
    if (this.taskChargesPending) return this.taskChargesPending;
    this.taskChargesPending = this.reconcileTaskCharges().finally(() => { this.taskChargesPending = null; });
    return this.taskChargesPending;
  }
  async reconcileTaskCharges() {
    const tasks = (await this.db.query(`SELECT t.id,t.upstream_task_id,k.secret_ref,a.base_url,a.provider_type FROM media_tasks t
      JOIN requests r ON r.id=t.id JOIN upstream_keys k ON k.id=r.key_id JOIN upstream_accounts a ON a.id=k.account_id
      -- lanehub 的任务永远不会有 cost_cny（recordTaskCharge 只认 apimart 的 credits_cost 口径），
      -- 不排掉的话这 20 个名额会被它们永久占满，真正等着记成本的 apimart 任务再也轮不上。
      -- lanehub 那条线的金额走 lanehub-charges.mjs，从对面的消费日志取。
      WHERE r.cost_cny IS NULL AND a.provider_type<>'lanehub' ORDER BY t.updated_at LIMIT 20`)).rows;
    let recorded = 0, failed = 0;
    for (const task of tasks) {
      try {
        const response = await this.request(task,providerPaths(task.provider_type).task(task.upstream_task_id),
          {signal:AbortSignal.timeout(15000)});
        if (!response.ok) { await response.body?.cancel(); throw new Error('task_charge_query_failed'); }
        const raw = await response.json();
        if (raw.code !== 200) throw new Error('invalid_task_response');
        if (await recordTaskCharge(this.db,task,raw.data)) recorded++;
      } catch { failed++; }
      // Rotate unresolved tasks so one missing bill cannot starve later tasks.
      await this.db.query('UPDATE media_tasks SET updated_at=now() WHERE id=$1',[task.id]);
    }
    return {checked:tasks.length,recorded,failed};
  }
  async markFailure(key, status, retryAfter) {
    if (status === 401 || status === 403) {
      await this.db.query('UPDATE upstream_keys SET enabled=false,last_error=$2 WHERE id=$1', [key.id, `upstream_http_${status}`]);
    } else if (status === 402) {
      await this.db.query('UPDATE upstream_accounts SET blocked=true WHERE id=$1', [key.account_id]);
    } else if (status === 429) {
      const seconds = Number(retryAfter);
      const duration = Number.isFinite(seconds) && seconds > 0 ? seconds : (Date.parse(retryAfter) - Date.now()) / 1000;
      const until = new Date(Date.now() + Math.min(3600, Math.max(5, duration || 30)) * 1000);
      // Unknown account-level rate limit: cool down every key in this account.
      await this.db.query('UPDATE upstream_keys SET cooldown_until=$2,last_error=$3 WHERE account_id=$1',
        [key.account_id, until, 'upstream_http_429']);
    }
  }
  close() { clearTimeout(this.timer); }
}
function safeBalanceError(error) {
  return /^(?:upstream_http_\d{3}|unknown_provider_type)$/.test(error.message) ? error.message : 'balance_sync_failed';
}
