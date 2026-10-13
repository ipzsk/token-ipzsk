import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fakeDb } from './fixtures/fake-lanehub-db.mjs';
import { Lanehub, ensureAccount, creditAccount, provisionCustomer, startAdjustment, applyAdjustment, sweepAdjustments, randomPassword } from '../src/lanehub.mjs';

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

// createUser 建完会再查一次拿 id：第一次查（建号前）返回空，之后返回那个用户。
function listAfterCreate(id, username) {
  let created = false;
  return () => (created ? [{ id, username }] : (created = true, []));
}

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
  assert.equal(lanehub.seen.filter((c) => c.path.startsWith('/api/user/quota')).length, 1, '对面只能被加一次');
});

// 对面没有幂等键：请求发出后结果未知（超时、断连、5xx、业务错误），对面可能已经加上了。
// 此时绝不能删除占位或自动重试——旧实现删占位，重试就把同一笔钱加两次。
test('响应丢失进入 review，同一 reference 重试不再调用对面', async () => {
  const db = fakeDb();
  let applied = 0;
  // 对面实际已经加上额度，只是响应在回来的路上丢了。
  const lost = fakeLanehub({ '/api/user/quota/7': () => { applied++; throw new Error('socket hang up'); } });
  const args = { userId: 'u1', lanehubUserId: 7, amountCny: '10', usdCnyRate: 7, quotaPerUnit: 500000, reference: 'pay:order-2' };

  const first = await creditAccount(db, lost, args);
  assert.deepEqual([first.applied, first.state], [false, 'review']);
  assert.equal(db.credits.get('pay:order-2').state, 'review', '占位必须保留并标记待核对');
  assert.equal(db.credits.get('pay:order-2').review_reason, 'socket hang up');

  const ok = fakeLanehub();
  const retry = await creditAccount(db, ok, args);
  assert.deepEqual([retry.applied, retry.state], [false, 'review']);
  assert.equal(ok.seen.length, 0, '重试一条都不能发到对面');
  assert.equal(applied, 1, '对面总共只被加过一次');
});

test('业务错误（success:false）同样进入 review，不自动重试', async () => {
  const db = fakeDb();
  const failing = new Lanehub({ baseUrl: 'https://lane.example', adminToken: 'sk-admin',
    fetcher: async () => Response.json({ success: false, message: 'db busy' }) });
  const result = await creditAccount(db, failing, { userId: 'u1', lanehubUserId: 7, amountCny: '1', usdCnyRate: 7, quotaPerUnit: 500000, reference: 'r-biz' });
  assert.equal(result.state, 'review');
  assert.equal(db.credits.get('r-biz').review_reason, 'db busy');
});

// pending = 远程调用还没开始（占位后进程退出），这是唯一可以安全接手重试的状态。
test('停在 pending 的占位可被同一 reference 接手，且只调用一次对面', async () => {
  const db = fakeDb(), lanehub = fakeLanehub();
  await startAdjustment(db, { reference: 'grant:1', userId: 'u1', lanehubUserId: 7, amountCny: '2', quota: 100, remark: 'grant' });
  const [a, b] = await Promise.all([applyAdjustment(db, lanehub, 'grant:1'), applyAdjustment(db, lanehub, 'grant:1')]);
  assert.equal([a, b].filter((r) => r.applied).length, 1, '并发接手只能有一个真正调用');
  assert.equal(lanehub.seen.length, 1);
  assert.equal(db.credits.get('grant:1').state, 'applied');
});

test('applying 超时由清扫转 review，清扫不调用对面', async () => {
  const db = fakeDb(), lanehub = fakeLanehub();
  await startAdjustment(db, { reference: 'x:1', userId: 'u1', lanehubUserId: 7, amountCny: '2', quota: 100 });
  Object.assign(db.credits.get('x:1'), { state: 'applying', updated_at: Date.now() - 600_000 });
  await sweepAdjustments(db);
  assert.equal(db.credits.get('x:1').state, 'review');
  assert.equal((await applyAdjustment(db, lanehub, 'x:1')).state, 'review');
  assert.equal(lanehub.seen.length, 0);
});

test('扣额度发送负 delta；需要本地落账的调整生效后保持未落账', async () => {
  const db = fakeDb(), lanehub = fakeLanehub();
  await startAdjustment(db, { reference: 'payment_refund:r1', userId: 'u1', lanehubUserId: 9, kind: 'debit', amountCny: '3', quota: 1234,
    payload: { booking: 'payment_refund' } });
  const result = await applyAdjustment(db, lanehub, 'payment_refund:r1');
  assert.equal(result.applied, true);
  assert.equal(lanehub.seen[0].path, '/api/user/quota/9');
  assert.equal(lanehub.seen[0].body.quota, -1234);
  assert.equal(db.credits.get('payment_refund:r1').booked_at, null, '由落账函数凭 booked_at 幂等落账');
});

test('同一 reference 换用户、方向或金额一律冲突', async () => {
  const db = fakeDb();
  const base = { reference: 'c:1', userId: 'u1', lanehubUserId: 7, amountCny: '2', quota: 100 };
  await startAdjustment(db, base);
  await assert.rejects(() => startAdjustment(db, { ...base, amountCny: '3' }), { code: 'adjustment_reference_conflict' });
  await assert.rejects(() => startAdjustment(db, { ...base, userId: 'u2' }), { code: 'adjustment_reference_conflict' });
  await assert.rejects(() => startAdjustment(db, { ...base, kind: 'debit' }), { code: 'adjustment_reference_conflict' });
});

test('建号密码来自 CSPRNG，长度与字符集符合 lanehub 限制', async () => {
  const source = await (await import('node:fs/promises')).readFile(new URL('../src/lanehub.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /Math\.random/);
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const value = randomPassword();
    assert.match(value, /^ipz[a-z0-9]{16}$/);
    assert.ok(value.length <= 20);
    seen.add(value);
  }
  assert.equal(seen.size, 200);
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
    '/api/user/?keyword=ipz2unib86zn&size=20': listAfterCreate(42, 'ipz2unib86zn'),
    '/api/user/': { },
    '/api/token/for_user': { key: 'sk-' + 'a'.repeat(40) },
  });
  const first = await ensureAccount(db, lanehub, fakeUpstream(), { userId: 'u1', name: 'A', accountId: 'acc' });
  const second = await ensureAccount(db, lanehub, fakeUpstream(), { userId: 'u1', name: 'A', accountId: 'acc' });

  assert.equal(first.lanehub_user_id, 42);
  assert.equal(second.key_id, first.key_id);
  assert.equal(lanehub.seen.filter((c) => c.path === '/api/user/').length, 1, '只能建一次用户');
  assert.equal(lanehub.seen.filter((c) => c.path === '/api/token/for_user').length, 1, '只能签一次令牌');
});

// 上一次建到一半（用户建了、令牌没签）时，重来要把已建的用户捡回来。
test('建号中途失败重来：捡回已建的用户，不建第二个同名用户', async () => {
  const db = fakeDb();
  const lanehub = fakeLanehub({
    '/api/user/?keyword=ipz1ngzvddhp&size=20': [{ id: 99, username: 'ipz1ngzvddhp' }],
    '/api/token/for_user': { key: 'sk-' + 'b'.repeat(40) },
    '/api/user/': new Error('不该再建用户'),
  });
  const account = await ensureAccount(db, lanehub, fakeUpstream(), { userId: 'u2', name: 'B', accountId: 'acc' });
  assert.equal(account.lanehub_user_id, 99);
});

// 登录后自动备好密钥 + 首次发新人额度。一个客户一个密钥，重复登录不会重复发钱。
test('首次建号发新人额度，重复登录不再发', async () => {
  const db = fakeDb();
  const lanehub = fakeLanehub({
    '/api/user/?keyword=ipzm1a3osgli&size=20': listAfterCreate(3, 'ipzm1a3osgli'),
    '/api/user/': { },
    '/api/token/for_user': { key: 'sk-' + 'c'.repeat(40) },
  });
  const args = { userId: 'u3', name: 'C', accountId: 'acc', signupCny: 5, usdCnyRate: 7, quotaPerUnit: 500000 };

  const first = await provisionCustomer(db, lanehub, fakeUpstream(), args);
  const second = await provisionCustomer(db, lanehub, fakeUpstream(), args);

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.key_id, first.key_id, '一个客户只有一个密钥');
  const grants = lanehub.seen.filter((c) => c.path.startsWith('/api/user/quota'));
  assert.equal(grants.length, 1, '新人额度只发一次');
  assert.equal(db.credits.get('signup:u3').quota, Math.round((5 / 7) * 500000));
});

// 余额迁移脚本先建过映射的老客户，不能被当成新人再送一笔。
test('迁移过的老客户不发新人额度', async () => {
  const db = fakeDb();
  db.accounts.set('u4', { user_id: 'u4', lanehub_user_id: 4, key_id: 'k4', lane: 'official', secret_ref: 'k4.key' });
  const lanehub = fakeLanehub({ '/api/user/': new Error('不该建号') });

  const account = await provisionCustomer(db, lanehub, fakeUpstream(),
    { userId: 'u4', accountId: 'acc', signupCny: 5, usdCnyRate: 7, quotaPerUnit: 500000 });

  assert.equal(account.created, false);
  assert.equal(lanehub.seen.length, 0, '既不建号也不发钱');
});

// 发钱失败不能挡住登录：额度事后能补，登录不能卡。
test('新人额度发放失败不影响建号', async () => {
  const db = fakeDb();
  const lanehub = fakeLanehub({
    '/api/user/?keyword=ipz1cck5isv0&size=20': listAfterCreate(5, 'ipz1cck5isv0'),
    '/api/user/': { },
    '/api/token/for_user': { key: 'sk-' + 'd'.repeat(40) },
    '/api/user/quota/5': new Error('lanehub down'),
  });
  const account = await provisionCustomer(db, lanehub, fakeUpstream(),
    { userId: 'u5', accountId: 'acc', signupCny: 5, usdCnyRate: 7, quotaPerUnit: 500000 });
  assert.equal(account.created, true, '密钥仍要建出来');
  assert.equal(db.credits.get('signup:u5').state, 'review', '结果未知，留待人工核对后补发或确认');
});
