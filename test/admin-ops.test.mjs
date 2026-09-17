import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { Lanehub } from '../src/lanehub.mjs';
import { adminOpsRoutes } from '../src/admin-ops.mjs';
import { validate, schemas } from '../src/contracts-schema.mjs';

const SECRET_KEYS = ['key', 'proxy', 'header_override', 'model_headers', 'custom_parameter', 'plugin', 'other', 'base_url', 'metadata', 'source_ip'];
const leaks = (v) => JSON.stringify(v).match(new RegExp(`"(${SECRET_KEYS.join('|')})"\\s*:`, 'g')) ?? [];

// lanehub 渠道原对象（带一堆不该出网关的字段）。
const secrets = { key: 'sk-secret', proxy: 'socks5://x', header_override: '{"a":1}', model_headers: 'h', custom_parameter: '{}', plugin: {}, other: 'o',
  base_url: 'https://up.example', metadata: { m: 1 }, source_ip: '1.2.3.4' };
const ch = (id, extra = {}) => ({ id, name: 'ch' + id, priority: 10, weight: 1, status: 1, type: 63, lanes: ['official'], vendor: 'APIMart',
  vendor_icon: 'data:image/png;base64,AAA', tested_at: 0, latency_ms: 0, disabled: false, balance: 2, balance_updated_time: 1700000000, balance_supported: true,
  price: { type: 'times', source: 'row', usd: 0.03, cny: 0.2, unit: 'per_call', tier: '', tiers: [] }, ...secrets, ...extra });
const MATRIX = {
  lanes: [{ symbol: 'cheap', name: '低价', ratio: 0.8 }, { symbol: 'official', name: '官方', ratio: 1 }], auto_chain: ['official', 'cheap'],
  scenario: { resolution: '1080p', duration: 5 }, usd_rate: 7,
  rows: [
    { model: 'seedream', vendors: ['APIMart'], vendor_icons: { APIMart: 'data:image/png;base64,AAA', Fal: 'data:fal' }, modalities: ['image'],
      channels: [ch(1), ch(2, { type: 99, vendor: 'Fal', balance_supported: false, lanes: ['cheap'], price: null })],
      cells: { official: { channels: [ch(1)] }, cheap: { channels: [ch(2, { type: 99, vendor: 'Fal', balance_supported: false, lanes: ['cheap'] })] } } },
    { model: 'kling', vendors: ['APIMart'], modalities: ['video'], channels: [ch(1, { price: { source: 'borrowed', cny: 1.5, unit: 'per_second' } })],
      cells: { official: { channels: [ch(1)] } } },
  ],
};

let userSeq = 0; // roles.mjs caches roles per user id for 30s, so each setup gets its own user.
function setup({ lanehub = true, role = 'admin', handlers = {} } = {}) {
  const calls = [], audits = [], userId = 'u' + ++userSeq;
  const routes = {
    'GET /api/option/': () => ({ success: true, data: [{ key: 'PaymentUSDRate', value: '7' }] }),
    'GET /api/lane_matrix': () => ({ success: true, data: MATRIX }),
    ...handlers,
  };
  const fetcher = async (url, init) => {
    const u = new URL(url), key = `${init.method} ${u.pathname}`;
    calls.push({ key, query: Object.fromEntries(u.searchParams), body: init.body && JSON.parse(init.body) });
    const h = routes[key];
    const payload = h ? h(u, init) : { success: false, message: 'no route ' + key };
    return new Response(JSON.stringify(payload), { status: 200 });
  };
  const app = Fastify();
  app.decorate('roleDb', { query: async () => ({ rows: role ? [{ role }] : [] }) });
  app.addHook('onRequest', async (req) => {
    req.apiUser = { id: userId, session_id: 's1', session_created_at: new Date().toISOString() };
  });
  app.setErrorHandler((error, _req, reply) => {
    reply.code(error.statusCode ?? 500).send({ error: { code: error.code, message: error.code, ...(error.fields ?? {}) } });
  });
  adminOpsRoutes(app, {
    db: { query: async (sql, args) => { audits.push({ action: args[0], target: args[1], details: JSON.parse(args[2]), actor: args[3] }); return { rows: [] }; } },
    lanehub: lanehub ? new Lanehub({ baseUrl: 'http://lanehub.test', adminToken: 't', fetcher }) : null,
    lanehubUsdCny: 7, lanehubQuotaPerUnit: 500000,
  });
  app.decorate('userId', userId);
  return { app, calls, audits };
}
const shape = (name, body) => assert.deepEqual(validate(schemas[name], body), [], name);

test('lane matrix: channels deduped, cells keep order, prices per row, icons top level, balance in CNY', async () => {
  const { app, calls } = setup();
  const res = await app.inject({ url: '/api/admin/ops/lane-matrix?resolution=1080p&duration=5' });
  assert.equal(res.statusCode, 200);
  const m = res.json();
  shape('LaneMatrix', m);
  assert.deepEqual(calls.find((c) => c.key === 'GET /api/lane_matrix').query, { resolution: '1080p', duration: '5' });
  assert.deepEqual(m.lanes.map((l) => l.symbol), ['official', 'cheap'], 'auto chain order');
  assert.deepEqual(Object.keys(m.channels), ['1', '2']);
  assert.deepEqual(m.rows[0].cells, { official: { channel_ids: [1] }, cheap: { channel_ids: [2] } });
  assert.deepEqual(m.rows[0].channel_ids, [1, 2]);
  assert.deepEqual(m.rows[0].prices, { 1: { unit: 'per_call', cny: 0.2, source: 'row' }, 2: null });
  assert.deepEqual(m.rows[1].prices, { 1: { unit: 'per_second', cny: 1.5, source: 'borrowed' } });
  assert.deepEqual(m.vendor_icons, { APIMart: 'data:image/png;base64,AAA', Fal: 'data:fal' });
  assert.equal(m.channels[1].balance_cny, 14);
  assert.equal(m.channels[1].balance_checked_at, 1700000000);
  assert.equal(m.channels[2].balance_cny, null);
  assert.equal(m.channels[2].balance_supported, false);
  assert.deepEqual(leaks(m), []);
});

test('channels: explicit allowlist, lanes/vendor/balance_supported from matrix cache', async () => {
  const raw = { id: 2, type: 99, status: 1, name: 'fal-1', weight: 3, priority: 5, created_time: 1690000000, test_time: 1, response_time: 100, balance: 0,
    balance_updated_time: 0, models: 'a,b,c', group: 'default,cheap', tag: 't', used_quota: 1000000, model_mapping: '{}', only_chat: false, ...secrets };
  const { app, calls } = setup({ handlers: { 'GET /api/channel/': () => ({ success: true, data: { data: [raw, { ...raw, id: 3, type: 1234 }], page: 1, size: 20, total_count: 2 } }) } });
  const res = await app.inject({ url: '/api/admin/ops/channels?keyword=fal&status=1&size=20' });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  shape('OpsChannelPage', body);
  assert.deepEqual(calls.find((c) => c.key === 'GET /api/channel/').query, { page: '1', size: '20', status: '1', name: 'fal' });
  assert.deepEqual(leaks(body), []);
  assert.deepEqual(body.items[0], { id: 2, name: 'fal-1', type: 99, status: 1, priority: 5, weight: 3, lanes: ['cheap'], vendor: 'Fal', balance_cny: null,
    balance_checked_at: null, balance_supported: false, group: 'default,cheap', tag: 't', models_count: 3, used_cny: 14, created_at: 1690000000 });
  assert.equal(body.items[1].balance_supported, true, 'unknown type → true');
  assert.equal(body.total, 2);
});

test('channels list fetches the matrix once, then uses the cache', async () => {
  const { app, calls } = setup({ handlers: { 'GET /api/channel/': () => ({ success: true, data: { data: [], page: 1, size: 20, total_count: 0 } }) } });
  await app.inject({ url: '/api/admin/ops/channels' });
  await app.inject({ url: '/api/admin/ops/channels' });
  assert.equal(calls.filter((c) => c.key === 'GET /api/lane_matrix').length, 1);
});

test('probe: ok / unsupported / failed mapping, audited', async () => {
  const replies = {
    1: { success: true, message: '', balance: 3, balance_state: 'available' },
    2: { success: false, message: '该上游没有余额接口（已显式声明）', balance_state: 'unsupported' },
    3: { success: false, message: '该渠道未实现余额查询', balance_state: 'unimplemented' },
    4: { success: false, message: 'invalid api key', balance_state: 'available' },
  };
  const { app, audits } = setup({ handlers: { 'GET /api/channel/update_balance/1': () => replies[1], 'GET /api/channel/update_balance/2': () => replies[2],
    'GET /api/channel/update_balance/3': () => replies[3], 'GET /api/channel/update_balance/4': () => replies[4] } });
  const probe = async (id) => { const r = await app.inject({ method: 'POST', url: `/api/admin/ops/channels/${id}/probe` }); assert.equal(r.statusCode, 200, r.body); shape('Probe', r.json()); return r.json(); };
  const ok = await probe(1);
  assert.equal(ok.state, 'ok'); assert.equal(ok.balance_cny, 21); assert.equal(ok.message, ''); assert.ok(ok.latency_ms >= 0);
  assert.equal((await probe(2)).state, 'unsupported');
  assert.equal((await probe(3)).state, 'unsupported');
  const bad = await probe(4);
  assert.deepEqual([bad.state, bad.balance_cny, bad.message], ['failed', null, 'invalid api key']);
  assert.deepEqual(audits.map((a) => [a.action, a.target, a.details.state]), [['ops.channel.probe', '1', 'ok'], ['ops.channel.probe', '2', 'unsupported'],
    ['ops.channel.probe', '3', 'unsupported'], ['ops.channel.probe', '4', 'failed']]);
});

test('lane matrix save: validates, forwards, audits success and failure', async () => {
  let fail = false;
  const { app, calls, audits } = setup({ handlers: { 'PUT /api/lane_matrix/batch': () => (fail ? { success: false, message: '渠道 #9：record not found' }
    : { success: true, data: [{ channel_id: 1, name: 'ch1', before: { group: 'official', priority: 10, status: 1 }, after: { group: 'official,cheap', priority: 20, status: 1 }, key: 'sk' }] }) } });
  const put = (body) => app.inject({ method: 'PUT', url: '/api/admin/ops/lane-matrix', payload: body });

  for (const body of [{}, { changes: [] }, { changes: [{ channel_id: 1, status: 3 }] }, { changes: [{ channel_id: 1.5 }] },
    { changes: [{ channel_id: 1, lanes: [1] }] }, { changes: [{ channel_id: 1, extra: 1 }] }, { changes: Array.from({ length: 201 }, (_, i) => ({ channel_id: i + 1 })) }]) {
    const r = await put(body);
    assert.equal(r.statusCode, 400, JSON.stringify(body));
    assert.equal(r.json().error.code, 'invalid_lane_changes');
  }
  assert.equal(calls.filter((c) => c.key.startsWith('PUT')).length, 0);

  const changes = [{ channel_id: 1, priority: 20, lanes: ['official', 'cheap'] }];
  const ok = await put({ changes });
  assert.equal(ok.statusCode, 200, ok.body);
  shape('LaneMatrixSaveResult', ok.json());
  assert.deepEqual(ok.json().results[0].after, { group: 'official,cheap', priority: 20, status: 1 });
  assert.deepEqual(calls.find((c) => c.key === 'PUT /api/lane_matrix/batch').body, { changes });
  assert.deepEqual(audits.at(-1), { action: 'ops.lane_matrix.save', target: null, actor: app.userId, details: { changes, results: ok.json().results } });

  fail = true;
  const bad = await put({ changes: [{ channel_id: 9, status: 2 }] });
  assert.equal(bad.statusCode, 502);
  assert.deepEqual(bad.json().error, { code: 'lanehub_api_failed', message: 'lanehub_api_failed', detail: '渠道 #9：record not found' });
  assert.deepEqual(audits.at(-1).details, { changes: [{ channel_id: 9, status: 2 }], error: 'lanehub_api_failed', detail: '渠道 #9：record not found' });
  assert.equal(audits.length, 2);
});

test('dashboard: realtime CNY, period Go keys → snake_case', async () => {
  const { app, calls } = setup({ handlers: {
    'GET /api/analytics/rpm': () => ({ success: true, data: { rpm: 12, tpm: 3400, cpm: 0.5, ppm: 0.1 } }),
    'GET /api/analytics/period': () => ({ success: true, data: { user_statistics: [{ secret: 1 }], channel_statistics: [
      { Date: '2026-09-16', RequestCount: 4, Quota: 1000000, CostQuota: 500000, PromptTokens: 10, CompletionTokens: 20, RequestTime: 1000, Channel: 'apimart-1' },
      { Date: '2026-09-17', RequestCount: 0, Quota: 0, CostQuota: 0, PromptTokens: 0, CompletionTokens: 0, RequestTime: 0, Channel: 'x' }] } }),
  } });
  const rt = (await app.inject({ url: '/api/admin/ops/dashboard/realtime' })).json();
  shape('OpsRealtime', rt);
  assert.deepEqual(rt, { rpm: 12, tpm: 3400, cost_per_min_cny: 3.5 });
  const res = await app.inject({ url: '/api/admin/ops/dashboard/period?start=1757980800&end=1758067200&group_by=channel&channel_id=3' });
  assert.equal(res.statusCode, 200, res.body);
  shape('OpsPeriod', res.json());
  assert.deepEqual(calls.find((c) => c.key === 'GET /api/analytics/period').query,
    { start_timestamp: '1757980800', end_timestamp: '1758067200', group_type: 'channel', channel_id: '3' });
  assert.deepEqual(res.json().rows, [
    { date: '2026-09-16', key: 'apimart-1', requests: 4, amount_cny: 14, cost_cny: 7, prompt_tokens: 10, completion_tokens: 20, avg_latency_ms: 250 },
    { date: '2026-09-17', key: 'x', requests: 0, amount_cny: 0, cost_cny: 0, prompt_tokens: 0, completion_tokens: 0, avg_latency_ms: 0 }]);
  assert.equal((await app.inject({ url: '/api/admin/ops/dashboard/period?start=10' })).statusCode, 400);
  assert.equal((await app.inject({ url: '/api/admin/ops/dashboard/period?start=1&end=2&group_by=user' })).statusCode, 400);
});

test('logs: filters mapped, entries allowlisted, stat in CNY', async () => {
  const log = { id: 7, user_id: 3, created_at: 1758000000, type: 2, content: 'ok', username: 'u', token_name: 'tk', model_name: 'seedream', quota: 500000,
    cost_quota: 250000, cost_source: 'real', prompt_tokens: 1, completion_tokens: 2, channel_id: 1, request_time: 380, is_stream: false, source_ip: '9.9.9.9',
    request_id: 'r1', upstream_request_id: 'up1', metadata: { key: 'x' }, channel: { id: 1, name: 'ch1', key: 'sk-leak' } };
  const { app, calls } = setup({ handlers: {
    'GET /api/log/': () => ({ success: true, data: { data: [log, { ...log, id: 8, channel: { id: 0, name: '' }, cost_source: null }], page: 2, size: 50, total_count: 51 } }),
    'GET /api/log/stat': () => ({ success: true, data: { quota: 1000000 } }),
  } });
  const res = await app.inject({ url: '/api/admin/ops/logs?page=2&size=50&start=1&end=2&model=seedream&channel_id=1&request_id=r1&type=2' });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  shape('OpsLogPage', body);
  assert.deepEqual(calls.find((c) => c.key === 'GET /api/log/').query,
    { page: '2', size: '50', start_timestamp: '1', end_timestamp: '2', model_name: 'seedream', channel_id: '1', request_id: 'r1', log_type: '2' });
  assert.deepEqual(leaks(body), []);
  assert.deepEqual(body.items[0], { id: 7, created_at: 1758000000, type: 2, username: 'u', token_name: 'tk', model: 'seedream', channel: { id: 1, name: 'ch1' },
    amount_cny: 7, cost_cny: 3.5, cost_source: 'real', prompt_tokens: 1, completion_tokens: 2, latency_ms: 380, is_stream: false, request_id: 'r1',
    upstream_request_id: 'up1', content: 'ok' });
  assert.deepEqual([body.items[1].channel, body.items[1].cost_source], [null, '']);
  assert.equal((await app.inject({ url: '/api/admin/ops/logs?size=101' })).statusCode, 400);
  const stat = await app.inject({ url: '/api/admin/ops/logs/stat?username=u' });
  assert.deepEqual(stat.json(), { amount_cny: 14 });
  assert.deepEqual(calls.find((c) => c.key === 'GET /api/log/stat').query, { username: 'u' });
});

test('role gates and lanehub_unavailable', async () => {
  const viewer = setup({ role: 'viewer', handlers: { 'GET /api/analytics/rpm': () => ({ success: true, data: { rpm: 0, tpm: 0, cpm: 0 } }) } });
  assert.equal((await viewer.app.inject({ url: '/api/admin/ops/dashboard/realtime' })).statusCode, 200);
  for (const [method, url] of [['PUT', '/api/admin/ops/lane-matrix'], ['POST', '/api/admin/ops/channels/1/probe']]) {
    const r = await viewer.app.inject({ method, url, payload: { changes: [{ channel_id: 1 }] } });
    assert.equal(r.statusCode, 403); assert.equal(r.json().error.code, 'forbidden_role');
  }
  assert.equal(viewer.calls.filter((c) => !c.key.startsWith('GET')).length, 0);
  const nobody = setup({ role: null });
  assert.equal((await nobody.app.inject({ url: '/api/admin/ops/logs' })).statusCode, 403);
  const operator = setup({ role: 'operator', handlers: { 'GET /api/channel/update_balance/1': () => ({ success: true, balance: 1 }) } });
  assert.equal((await operator.app.inject({ method: 'POST', url: '/api/admin/ops/channels/1/probe' })).statusCode, 200);
  const off = setup({ lanehub: false });
  const r = await off.app.inject({ url: '/api/admin/ops/lane-matrix' });
  assert.equal(r.statusCode, 503); assert.equal(r.json().error.code, 'lanehub_unavailable');
});
