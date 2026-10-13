// lanehub_credits / lanehub_accounts 的内存替身，供 lanehub 状态机相关单元测试共用。
// 一个够用的内存库：只认 lanehub_credits / lanehub_accounts 上会发生的那几条语句。
// lanehub_credits 按状态机建模：pending → applying → applied | review。
export function fakeDb() {
  const credits = new Map(), accounts = new Map();
  const db = {
    credits, accounts, calls: [],
    async query(sql, args = []) {
      db.calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), args });
      const one = (row) => ({ rowCount: row ? 1 : 0, rows: row ? [row] : [] });
      if (/INSERT INTO lanehub_credits/.test(sql)) {
        const [reference, user_id, amount_cny, quota, kind, lanehub_user_id, remark, payload] = args;
        if (credits.has(reference)) return one(null);
        credits.set(reference, { reference, user_id, amount_cny, quota, kind, lanehub_user_id, remark, payload: JSON.parse(payload),
          state: 'pending', applied_at: null, booked_at: null, review_reason: null, updated_at: Date.now() });
        return one({ reference });
      }
      if (/SET state='applying'/.test(sql)) {
        const row = credits.get(args[0]);
        if (row?.state !== 'pending') return one(null);
        row.state = 'applying'; row.updated_at = Date.now();
        return one({ ...row });
      }
      if (/SET state='review',review_reason=\$2/.test(sql)) {
        const row = credits.get(args[0]);
        if (row?.state === 'applying') Object.assign(row, { state: 'review', review_reason: args[1] });
        return one(row);
      }
      if (/SET state='applied'/.test(sql)) {
        const row = credits.get(args[0]);
        if (row?.state !== 'applying') return one(null);
        Object.assign(row, { state: 'applied', applied_at: new Date(), booked_at: 'booking' in row.payload ? null : new Date() });
        return one(row);
      }
      if (/SET state='review',review_reason='adjustment_interrupted'/.test(sql)) {
        let n = 0;
        for (const row of credits.values()) if (row.state === 'applying' && row.updated_at < Date.now() - 300_000) { row.state = 'review'; n++; }
        return { rowCount: n, rows: [] };
      }
      if (/WHERE state='pending' AND lanehub_user_id IS NOT NULL/.test(sql)) {
        const rows = [...credits.values()].filter((r) => r.state === 'pending' && r.lanehub_user_id != null && r.updated_at < Date.now() - args[0] * 1000);
        return { rowCount: rows.length, rows: rows.map((r) => ({ reference: r.reference })) };
      }
      if (/WHERE state='applied' AND booked_at IS NULL/.test(sql)) {
        const rows = [...credits.values()].filter((r) => r.state === 'applied' && r.booked_at === null && 'booking' in r.payload);
        return { rowCount: rows.length, rows: rows.map((r) => ({ reference: r.reference })) };
      }
      if (/FROM lanehub_credits WHERE reference=\$1/.test(sql)) return one(credits.get(args[0]) && { ...credits.get(args[0]) });
      if (/FROM lanehub_accounts a JOIN upstream_keys/.test(sql)) {
        const row = accounts.get(args[0]);
        return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
      }
      if (/INSERT INTO lanehub_accounts/.test(sql)) {
        const [userId, lanehubUserId, keyId, lane] = args;
        if (!accounts.has(userId)) accounts.set(userId, { user_id: userId, lanehub_user_id: lanehubUserId, key_id: keyId, lane, secret_ref: keyId + '.key' });
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
  };
  // 单连接内存库：事务就是直接执行。
  db.tx = (work) => work(db);
  return db;
}

