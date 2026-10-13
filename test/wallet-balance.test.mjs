import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { walletRoutes } from '../src/wallet.mjs';
import { lanehubBalance } from '../src/lanehub-charges.mjs';

// LaneHub 模式下余额的真源在 LaneHub；本地账本不含 LaneHub 侧消费，绝不能拿来顶替。
function lanehubModeDb({ mapped }) {
  return {
    async query(sql) {
      if (/key='lanehub_mode'/.test(sql)) return { rowCount: 1, rows: [{ value: 'on' }] };
      if (/FROM lanehub_accounts a JOIN upstream_keys/.test(sql))
        return mapped ? { rowCount: 1, rows: [{ user_id: 'u1', lanehub_user_id: 42, key_id: 'k1' }] } : { rowCount: 0, rows: [] };
      if (/FROM wallet_entries|wallet_debits|request_billing/.test(sql)) throw new Error('local_ledger_must_not_be_read_for_balance:' + sql.slice(0, 40));
      return { rowCount: 0, rows: [] };
    },
  };
}
const options = { lanehubUsdCny: 7, lanehubQuotaPerUnit: 500000 };
async function getWallet(db, lanehub) {
  const app = Fastify();
  app.addHook('onRequest', async req => { req.apiUser = { id: 'u1', name: 'alice' }; });
  walletRoutes(app, { db, lanehub, ...options });
  const response = await app.inject({ url: '/api/me/wallet' });
  await app.close();
  return response;
}

test('LaneHub 建号/取号失败时返回 503，不回退到本地账本', async () => {
  const lanehub = { call: async () => { throw new Error('lanehub down'); }, usdRate: async () => 7 };
  const response = await getWallet(lanehubModeDb({ mapped: false }), lanehub);
  assert.equal(response.statusCode, 503, response.body);
  assert.equal(response.json().error?.code ?? response.json().code, 'billing_unavailable');
});

test('LaneHub 未返回额度时不当成 0', async () => {
  const lanehub = { balance: async () => ({ id: 42 }), usdRate: async () => 7 };
  await assert.rejects(() => lanehubBalance(lanehub, { lanehub_user_id: 42 }, { usdCnyRate: 7, quotaPerUnit: 500000 }), { code: 'billing_unavailable' });
});

test('LaneHub 负余额（退款扣回后）如实显示为负数', async () => {
  const lanehub = { balance: async () => ({ quota: -500000 }), usdRate: async () => 7 };
  const balance = await lanehubBalance(lanehub, { lanehub_user_id: 42 }, { usdCnyRate: 7, quotaPerUnit: 500000 });
  assert.deepEqual(balance, { balance_cny: '-7.00000000', frozen_cny: '0.00000000', available_cny: '-7.00000000' });
});
