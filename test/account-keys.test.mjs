import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { accountKeyRoutes } from '../src/account-keys.mjs';

// access_tokens 的内存替身：按 SQL 里是否带「只看手工 Key」条件过滤，用来证明路由真的带了这个条件。
function fakeDb(rows) {
  const audits = [];
  const manualOnly = sql => /auth_session_id IS NULL AND plugin_id IS NULL/.test(sql);
  const visible = (sql, userId) => rows.filter(r => r.user_id === userId && (!manualOnly(sql) || (!r.auth_session_id && !r.plugin_id)));
  const db = {
    audits,
    async query(sql, args) {
      if (/^SELECT .* FROM access_tokens WHERE user_id=\$1/s.test(sql)) return { rows: visible(sql, args[0]) };
      if (/^SELECT revoked_at FROM access_tokens/.test(sql)) { const r = visible(sql, args[1]).find(x => x.id === args[0]); return { rowCount: r ? 1 : 0, rows: r ? [r] : [] }; }
      if (/^UPDATE access_tokens SET revoked_at=now\(\) WHERE id=\$1/.test(sql)) { rows.find(x => x.id === args[0]).revoked_at = new Date(); return { rowCount: 1, rows: [] }; }
      if (/INSERT INTO audit_events/.test(sql)) { audits.push(args); return { rowCount: 1, rows: [] }; }
      return { rowCount: 1, rows: [] };
    },
  };
  db.tx = work => work(db);
  return db;
}
const USER = '11111111-1111-4111-8111-111111111111';
const ids = { manual: '22222222-2222-4222-8222-222222222222', web: '33333333-3333-4333-8333-333333333333', plugin: '44444444-4444-4444-8444-444444444444' };
async function app(rows) {
  const db = fakeDb(rows), server = Fastify();
  server.addHook('onRequest', async req => { req.apiUser = { id: USER, session_id: 'session-1' }; });
  accountKeyRoutes(server, { db });
  return { db, server };
}
const tokens = () => [
  { id: ids.manual, user_id: USER, name: '我的 Key', auth_session_id: null, plugin_id: null, revoked_at: null },
  { id: ids.web, user_id: USER, name: 'IPZSK 网页', auth_session_id: 'session-1', plugin_id: null, revoked_at: null },
  { id: ids.plugin, user_id: USER, name: '插件：IPZSK 生图', auth_session_id: 'session-1', plugin_id: 'p1', revoked_at: null },
];

test('用户凭证列表只含长期手工 Key，不含会话签发的网页/桌面/插件凭证', async () => {
  const { server } = await app(tokens());
  const rows = (await server.inject({ url: '/api/me/tokens' })).json().rows;
  assert.deepEqual(rows.map(r => r.id), [ids.manual]);
  await server.close();
});

test('不能在用户凭证页撤销当前会话的网页或插件凭证', async () => {
  const rows = tokens(), { server } = await app(rows);
  for (const id of [ids.web, ids.plugin]) {
    const response = await server.inject({ method: 'POST', url: `/api/me/tokens/${id}/revoke` });
    assert.equal(response.statusCode, 404, id);
  }
  assert.ok(rows.every(r => r.id === ids.manual || r.revoked_at === null));
  await server.close();
});

test('撤销手工 Key 幂等：重复撤销不改时间、不重复写审计', async () => {
  const rows = tokens(), { db, server } = await app(rows);
  assert.equal((await server.inject({ method: 'POST', url: `/api/me/tokens/${ids.manual}/revoke` })).statusCode, 200);
  const revokedAt = rows[0].revoked_at;
  assert.ok(revokedAt);
  assert.equal((await server.inject({ method: 'POST', url: `/api/me/tokens/${ids.manual}/revoke` })).statusCode, 200);
  assert.equal(rows[0].revoked_at, revokedAt);
  assert.equal(db.audits.length, 1);
  await server.close();
});
