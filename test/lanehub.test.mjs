import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Lanehub, ensureAccount, creditAccount } from '../src/lanehub.mjs';

// 一个够用的内存库：只认这三张表上会发生的那几条语句。
function fakeDb() {
  const credits = new Map(), accounts = new Map();
  const db = {
    credits, accounts, calls: [],
    async query(sql, args = []) {
      db.calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), args });
      if (/INSERT INTO lanehub_credits/.test(sql)) {
        const [reference, userId, amount, quota] = args;
        if (credits.has(reference)) return { rowCount: 0, rows: [] };
        credits.set(reference, { userId, amount, quota, applied_at: null });
        return { rowCount: 1, rows: [{ reference }] };
      }
      if (/DELETE FROM lanehub_credits/.test(sql)) { credits.delete(args[0]); return { rowCount: 1, rows: [] }; }
      if (/UPDATE lanehub_credits/.test(sql)) {
        const row = credits.get(args[0]); if (row) row.applied_at = new Date();
        return { rowCount: 1, rows: [] };
      }
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
  return db;
}

function fakeLanehub(script = {}) {
  const seen = [];
  const lanehub = new Lanehub({ baseUrl: 'https://lane.example', adminToken: 'sk-admin' });
  lanehub.call = async (path, options = {}) => {
    seen.push({ path, ...options });
    if (script[path] instanceof Error) throw script[path];
    if (typeof script[path] === 'function') return script[path](options);
    return script[path] ?? {};
  };
  lanehub.seen = seen;
  return lanehub;
}

const fakeUpstream = () => ({ addKey: async () => randomUUID() });

// 充值入账的幂等键是 reference：支付回调重放、迁移脚本重跑，都必须落在同一行上。
// 这条不成立的话，每重放一次就是白送一次钱。
test('同一个 reference 只入账一次', async () => {
  const db = fakeDb(), lanehub = fakeLanehub();
  const args = { userId: 'u1', lanehubUserId: 7, amountCny: '10', usdCnyRate: 7, quotaPerUnit: 500000, reference: 'pay:order-1' };

  const first = await creditAccount(db, lanehub, args);
  const second = await creditAccount(db, lanehub, args);

  assert.equal(first.applied, true);
  assert.equal(first.quota, Math.round((10 / 7) * 500000));
  assert.equal(second.applied, false, '第二次必须什么都不做');
  assert.equal(lanehub.seen.filter((c) => c.path === '/api/user/quota').length, 1, '对面只能被加一次');
});

// 对面加额度失败时，占位必须撤掉——否则这笔钱永远加不上去了（reference 已被占用）。
test('对面失败时撤掉占位，重试还能入账', async () => {
  const db = fakeDb();
  const boom = fakeLanehub({ '/api/user/quota': new Error('lanehub down') });
  const args = { userId: 'u1', lanehubUserId: 7, amountCny: '10', usdCnyRate: 7, quotaPerUnit: 500000, reference: 'pay:order-2' };

  await assert.rejects(() => creditAccount(db, boom, args));
  assert.equal(db.credits.size, 0, '失败后不能留下占位');

  const ok = fakeLanehub();
  const retry = await creditAccount(db, ok, args);
  assert.equal(retry.applied, true, '重试必须能入账');
});

test('金额非正或缺 reference 一律拒绝', async () => {
  const db = fakeDb(), lanehub = fakeLanehub();
  const base = { userId: 'u1', lanehubUserId: 7, usdCnyRate: 7, quotaPerUnit: 500000 };
  await assert.rejects(() => creditAccount(db, lanehub, { ...base, amountCny: '0', reference: 'r' }));
  await assert.rejects(() => creditAccount(db, lanehub, { ...base, amountCny: '-1', reference: 'r' }));
  await assert.rejects(() => creditAccount(db, lanehub, { ...base, amountCny: '1', reference: '' }));
  assert.equal(lanehub.seen.length, 0, '一条都不该发到对面');
});

// 建号也要幂等：中途失败（建了用户没建令牌）重来时，不能留下两个同名用户。
test('建号幂等：已有映射直接返回，不再建号', async () => {
  const db = fakeDb();
  const lanehub = fakeLanehub({
    '/api/user/search?keyword=ipz_u1': [],
    '/api/user/': { id: 42 },
    '/api/token/': { key: 'sk-' + 'a'.repeat(40) },
  });
  const first = await ensureAccount(db, lanehub, fakeUpstream(), { userId: 'u1', name: 'A', accountId: 'acc' });
  const second = await ensureAccount(db, lanehub, fakeUpstream(), { userId: 'u1', name: 'A', accountId: 'acc' });

  assert.equal(first.lanehub_user_id, 42);
  assert.equal(second.key_id, first.key_id);
  assert.equal(lanehub.seen.filter((c) => c.path === '/api/user/').length, 1, '只能建一次用户');
  assert.equal(lanehub.seen.filter((c) => c.path === '/api/token/').length, 1, '只能签一次令牌');
});

// 上一次建到一半（用户建了、令牌没签）时，重来要把已建的用户捡回来。
test('建号中途失败重来：捡回已建的用户，不建第二个同名用户', async () => {
  const db = fakeDb();
  const lanehub = fakeLanehub({
    '/api/user/search?keyword=ipz_u2': [{ id: 99, username: 'ipz_u2' }],
    '/api/token/': { key: 'sk-' + 'b'.repeat(40) },
    '/api/user/': new Error('不该再建用户'),
  });
  const account = await ensureAccount(db, lanehub, fakeUpstream(), { userId: 'u2', name: 'B', accountId: 'acc' });
  assert.equal(account.lanehub_user_id, 99);
});
