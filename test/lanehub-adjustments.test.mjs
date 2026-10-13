import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './fixtures/fake-lanehub-db.mjs';
import { startAdjustment } from '../src/lanehub.mjs';
import { finalizeAdjustments } from '../src/lanehub-adjustments.mjs';

// 记录调用次数的 lanehub 替身；addQuota 是增量接口，被调用两次就是加了两次钱。
function countingLanehub() {
  const calls = [];
  return { calls, addQuota: async (userId, quota, remark) => { calls.push({ userId, quota, remark }); } };
}

// 落账替身：与真实 booker 同样以 booked_at 为幂等闸。
function countingBooker(db) {
  const booked = [];
  const booker = async (_c, reference) => {
    const row = db.credits.get(reference);
    if (row.state !== 'applied' || row.booked_at !== null) return null;
    row.booked_at = new Date();
    booked.push(reference);
    return { clawback: '0' };
  };
  return { booked, books: { service_refund: booker, payment_refund: booker } };
}

const refund = { reference: 'refund:req-1:1', userId: 'u1', lanehubUserId: 7, amountCny: '0.4', quota: 29817,
  remark: '人工退款', payload: { booking: 'service_refund', request_id: 'req-1' } };
const crashAfterCommit = (db, ref) => { db.credits.get(ref).updated_at = Date.now() - 120_000; };

test('本地占位提交后进程退出留下 pending：后台只调用一次对面并落账一次', async () => {
  const db = fakeDb(), lanehub = countingLanehub(), { booked, books } = countingBooker(db);
  await startAdjustment(db, refund);
  crashAfterCommit(db, refund.reference); // 接口在 applyAdjustment 之前退出

  // 两个后台循环并发，再跑一轮：CAS 只放行一个远程调用，booked_at 只放行一次落账。
  await Promise.all([finalizeAdjustments(db, lanehub, { books }), finalizeAdjustments(db, lanehub, { books })]);
  await finalizeAdjustments(db, lanehub, { books });

  assert.equal(lanehub.calls.length, 1, '对面只能被调用一次');
  assert.deepEqual(lanehub.calls[0], { userId: 7, quota: 29817, remark: '人工退款' });
  assert.deepEqual(booked, [refund.reference], '本地只落账一次');
  assert.equal(db.credits.get(refund.reference).state, 'applied');
});

test('扣额度的 pending 同样由后台接手，发送负 delta', async () => {
  const db = fakeDb(), lanehub = countingLanehub(), { booked, books } = countingBooker(db);
  await startAdjustment(db, { reference: 'payment_refund:R-1', userId: 'u1', lanehubUserId: 9, kind: 'debit', amountCny: '4', quota: 298160,
    payload: { booking: 'payment_refund', payment_order_id: 'o1' } });
  crashAfterCommit(db, 'payment_refund:R-1');
  await finalizeAdjustments(db, lanehub, { books });
  assert.deepEqual(lanehub.calls.map((c) => c.quota), [-298160]);
  assert.deepEqual(booked, ['payment_refund:R-1']);
});

test('applying 与 review 绝不自动重放；超时的 applying 只转 review', async () => {
  const db = fakeDb(), lanehub = countingLanehub(), { booked, books } = countingBooker(db);
  for (const reference of ['a:fresh', 'a:stale', 'r:1']) await startAdjustment(db, { ...refund, reference });
  Object.assign(db.credits.get('a:fresh'), { state: 'applying', updated_at: Date.now() });
  Object.assign(db.credits.get('a:stale'), { state: 'applying', updated_at: Date.now() - 600_000 });
  Object.assign(db.credits.get('r:1'), { state: 'review', updated_at: Date.now() - 600_000 });
  await finalizeAdjustments(db, lanehub, { books });
  await finalizeAdjustments(db, lanehub, { books });
  assert.equal(lanehub.calls.length, 0);
  assert.deepEqual(booked, []);
  assert.deepEqual(['a:fresh', 'a:stale', 'r:1'].map((r) => db.credits.get(r).state), ['applying', 'review', 'review']);
});

test('宽限期内的 pending 留给接口自己执行；未配置 lanehub 时不执行', async () => {
  const db = fakeDb(), lanehub = countingLanehub(), { books } = countingBooker(db);
  await startAdjustment(db, refund);
  await finalizeAdjustments(db, lanehub, { books });
  assert.equal(lanehub.calls.length, 0, '刚提交的占位属于正在执行的接口');
  crashAfterCommit(db, refund.reference);
  await finalizeAdjustments(db, null, { books });
  assert.equal(db.credits.get(refund.reference).state, 'pending', '没有 lanehub 客户端时保持 pending');
});

test('已生效未落账（落账前退出）由后台补落账，不再调用对面', async () => {
  const db = fakeDb(), lanehub = countingLanehub(), { booked, books } = countingBooker(db);
  await startAdjustment(db, refund);
  Object.assign(db.credits.get(refund.reference), { state: 'applied', applied_at: new Date(), booked_at: null });
  await finalizeAdjustments(db, lanehub, { books });
  assert.equal(lanehub.calls.length, 0);
  assert.deepEqual(booked, [refund.reference]);
});
