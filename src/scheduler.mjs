import { setTimeout as delay } from 'node:timers/promises';
import { httpError } from './security.mjs';

export class Scheduler {
  accounts = new Map();
  keys = new Map();
  waiting = 0;
  constructor({ queueLimit = 30, waitMs = 15_000 } = {}) {
    this.queueLimit = queueLimit;
    this.waitMs = waitMs;
  }
  async acquire(candidates, signal) {
    if (this.waiting >= this.queueLimit) throw httpError(429, 'queue_full');
    this.waiting++;
    const deadline = Date.now() + this.waitMs;
    try {
      do {
        signal?.throwIfAborted();
        const rows = await candidates();
        if (!rows.length) throw httpError(503, 'no_available_channel');
        rows.sort((a, b) => (this.keys.get(a.id) ?? 0) - (this.keys.get(b.id) ?? 0));
        for (const row of rows) {
          const account = this.accounts.get(row.account_id) ?? 0;
          const key = this.keys.get(row.id) ?? 0;
          if (account >= row.account_concurrency || key >= row.concurrency) continue;
          this.accounts.set(row.account_id, account + 1);
          this.keys.set(row.id, key + 1);
          let released = false;
          return { row, release: () => {
            if (released) return;
            released = true;
            const a = this.accounts.get(row.account_id) - 1;
            const k = this.keys.get(row.id) - 1;
            if (a) this.accounts.set(row.account_id, a); else this.accounts.delete(row.account_id);
            if (k) this.keys.set(row.id, k); else this.keys.delete(row.id);
          } };
        }
        await delay(150, undefined, { signal });
      } while (Date.now() < deadline);
      throw httpError(429, 'queue_timeout');
    } finally { this.waiting--; }
  }
}
