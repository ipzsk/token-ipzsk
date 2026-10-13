import test from 'node:test';
import assert from 'node:assert/strict';
import { publicUsageRow } from '../src/gateway.mjs';

const base = { id: 'r1', model: 'gpt-image-2', status: 'succeeded', billing_state: 'settled', charged_cny: '1.20000000',
  key_name: 'lanehub-key', upstream_id: 'up-1', cost_cny: '0.40000000', cost_reference: 'lanehub:1', cost_recorded_at: 'now',
  estimated_cost_cny: '0.5', pricing_details: { group_ratio: 2 }, skill_calls: [], skill_attribution_state: 'none' };

test('用户消费明细：插件、原扣款、退款、净消费、计价版本与归因状态', () => {
  const row = publicUsageRow(base, { plugin_name: 'IPZSK 生图', refunded_cny: '0.20000000', pricing_version: 'lanehub',
    plugin_attribution_state: 'credential_unverified' });
  assert.equal(row.plugin_name, 'IPZSK 生图');
  assert.equal(row.charged_cny, '1.20000000');
  assert.equal(row.refunded_cny, '0.20000000');
  assert.equal(row.net_charged_cny, '1.00000000');
  assert.equal(row.pricing_version, 'lanehub');
  assert.equal(row.attribution_state, 'credential_unverified');
  assert.equal(row.billing_state, 'settled');
});

test('不暴露上游渠道、成本与计价内部参数', () => {
  const row = publicUsageRow(base, {});
  for (const key of ['key_name', 'upstream_id', 'cost_cny', 'cost_reference', 'cost_recorded_at', 'estimated_cost_cny', 'pricing_details', 'skill_calls', 'skill_attribution_state'])
    assert.equal(Object.hasOwn(row, key), false, key);
  assert.doesNotMatch(JSON.stringify(row), /lanehub-key|up-1|group_ratio/);
});

test('未知扣款保持 null，不当成 0；无退款时净消费等于原扣款', () => {
  const pending = publicUsageRow({ ...base, charged_cny: null, billing_state: 'reserved' }, { refunded_cny: '0' });
  assert.equal(pending.refunded_cny, null);
  assert.equal(pending.net_charged_cny, null);
  assert.equal(pending.attribution_state, 'none');
  const settled = publicUsageRow(base, { refunded_cny: '0.00000000' });
  assert.equal(settled.net_charged_cny, '1.20000000');
});
