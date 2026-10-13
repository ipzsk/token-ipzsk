import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { claimWalletGrant, grantKey, reservedIdempotencyKey } from '../src/grant-idempotency.mjs';

// admin_idempotency 的内存替身：主键 (user_id,key)，只认补发会用到的两条语句。
function fakeDb() {
  const rows = new Map();
  return {
    rows,
    async query(sql, args) {
      const id = args[0] + '|' + args[1];
      if (/^INSERT INTO admin_idempotency/.test(sql.trim())) {
        if (!rows.has(id)) rows.set(id, { fingerprint: args[2], case_id: args[3], created_at: Date.now() });
        return { rowCount: 1, rows: [] };
      }
      const row = rows.get(id);
      return { rowCount: row ? 1 : 0, rows: row ? [{ ...row }] : [] };
    },
  };
}

test('补发幂等键永久有效：同参数永远复用原 grantId，超过 24 小时也一样', async () => {
  const db = fakeDb();
  const first = await claimWalletGrant(db, 'admin-1', 'g1', 'fp-50');
  for (const row of db.rows.values()) row.created_at = Date.now() - 30 * 86_400_000; // 人工核对拖了 30 天
  assert.equal(await claimWalletGrant(db, 'admin-1', 'g1', 'fp-50'), first);
  assert.equal(db.rows.size, 1, '不会生成第二笔补发');
  assert.ok(db.rows.has('admin-1|' + grantKey('g1')), '存放在独立命名空间');
});

test('同一 key 参数不同永远冲突', async () => {
  const db = fakeDb();
  await claimWalletGrant(db, 'admin-1', 'g1', 'fp-50');
  for (const row of db.rows.values()) row.created_at = Date.now() - 30 * 86_400_000;
  await assert.rejects(() => claimWalletGrant(db, 'admin-1', 'g1', 'fp-60'), { statusCode: 409, code: 'idempotency_conflict' });
});

test('不同管理员、同名 key 互不影响；案例创建的同名 key 不占用补发命名空间', async () => {
  const db = fakeDb();
  db.rows.set('admin-1|g1', { fingerprint: 'case-fp', case_id: 'c_1', created_at: Date.now() }); // 案例创建写的行
  const mine = await claimWalletGrant(db, 'admin-1', 'g1', 'fp-50');
  const other = await claimWalletGrant(db, 'admin-2', 'g1', 'fp-50');
  assert.notEqual(mine, 'c_1');
  assert.notEqual(mine, other);
});

test('案例创建的 24 小时滚动跳过补发命名空间；迁移把旧补发键搬进命名空间', async () => {
  const studio = await readFile(new URL('../src/admin-studio.mjs', import.meta.url), 'utf8');
  assert.match(studio, /created_at<=now\(\)-interval '24 hours' AND admin_idempotency\.key NOT LIKE 'wallet-grant:%'/);
  assert.doesNotMatch(studio.slice(studio.indexOf("'/api/admin/users/:id/wallet-grants'")), /24 hours/, '补发路由不再有任何时间窗');
  const sql = await readFile(new URL('../src/commissions.sql', import.meta.url), 'utf8');
  assert.match(sql, /SELECT i\.user_id,'wallet-grant:'\|\|i\.key/);
});

test('wallet-grant: 是保留前缀：非补发路径必须拒绝，否则会抢占真实补发的键', async () => {
  assert.equal(reservedIdempotencyKey('wallet-grant:g1'), true);
  assert.equal(reservedIdempotencyKey('g1'), false);
  assert.equal(reservedIdempotencyKey('Wallet-Grant:g1'), false, '前缀区分大小写，与存储键一致');
  // 若案例创建接受了 wallet-grant:g1，它写下的行与补发 key g1 的行完全同一个主键——这正是要挡住的碰撞。
  const db = fakeDb();
  db.rows.set('admin-1|wallet-grant:g1', { fingerprint: 'case-fp', case_id: 'c_1', created_at: Date.now() });
  await assert.rejects(() => claimWalletGrant(db, 'admin-1', 'g1', 'fp-50'), { code: 'idempotency_conflict' });
  // 案例创建路由在写 admin_idempotency 之前就用同一个判定拒绝。
  const studio = await readFile(new URL('../src/admin-studio.mjs', import.meta.url), 'utf8');
  const route = studio.slice(studio.indexOf("app.post('/api/admin/cases'"), studio.indexOf('INSERT INTO admin_idempotency'));
  assert.match(route, /reservedIdempotencyKey\(key\)\)\) throw fail\(400, 'invalid_idempotency_key'\)/);
});
