import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, httpError } from './security.mjs';
import { recordTaskCharge } from './task-charges.mjs';

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
    if (!/^sk-[A-Za-z0-9_-]{16,240}$/.test(key)) throw httpError(400, 'invalid_upstream_key');
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
  async request(ref, path, options = {}) {
    const key = await this.secret(ref);
    return this.fetcher(`https://api.apimart.ai${path}`, {
      ...options, redirect: 'error',
      headers: { ...(options.body instanceof FormData?{}:{'Content-Type': 'application/json'}), ...options.headers, Authorization: `Bearer ${key}` },
    });
  }
  async balance(ref, path) {
    const response = await this.request(ref, path, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`upstream_http_${response.status}`); }
    const data = await response.json();
    if (data.success !== true || !Number.isFinite(data.remain_balance) || !Number.isFinite(data.used_balance) ||
      !Number.isFinite(data.remain_credits) || !Number.isFinite(data.used_credits)) {
      throw new Error('invalid_balance_response');
    }
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
    const { rows } = await this.db.query(`SELECT k.* FROM upstream_keys k
      JOIN upstream_accounts a ON a.id=k.account_id WHERE k.enabled AND a.enabled ORDER BY k.created_at`);
    const accounts = new Map();
    for (const key of rows) {
      if (!accounts.has(key.account_id)) accounts.set(key.account_id, []);
      accounts.get(key.account_id).push(key);
      try {
        const b = await this.balance(key.secret_ref, '/v1/balance');
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
          const b = await this.balance(key.secret_ref, '/v1/user/balance');
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
  async candidates(model) {
    return (await this.db.query(`SELECT k.id,k.account_id,k.secret_ref,k.concurrency,a.concurrency AS account_concurrency
      FROM upstream_keys k JOIN upstream_accounts a ON a.id=k.account_id
      WHERE k.enabled AND a.enabled AND NOT a.blocked AND a.remain_credits>0
      AND a.balance_at>now()-interval '10 minutes' AND k.balance_at>now()-interval '10 minutes'
      AND (k.unlimited OR k.remain_credits>0) AND (k.cooldown_until IS NULL OR k.cooldown_until<=now())
      AND $1=ANY(k.models) ORDER BY k.created_at`, [model])).rows;
  }
  syncTaskCharges() {
    if (this.taskChargesPending) return this.taskChargesPending;
    this.taskChargesPending = this.reconcileTaskCharges().finally(() => { this.taskChargesPending = null; });
    return this.taskChargesPending;
  }
  async reconcileTaskCharges() {
    const tasks = (await this.db.query(`SELECT t.id,t.upstream_task_id,k.secret_ref FROM media_tasks t
      JOIN requests r ON r.id=t.id JOIN upstream_keys k ON k.id=r.key_id
      WHERE r.cost_cny IS NULL ORDER BY t.updated_at LIMIT 20`)).rows;
    let recorded = 0, failed = 0;
    for (const task of tasks) {
      try {
        const response = await this.request(task.secret_ref,'/v1/tasks/'+encodeURIComponent(task.upstream_task_id),
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
  return /^upstream_http_\d{3}$/.test(error.message) ? error.message : 'balance_sync_failed';
}
