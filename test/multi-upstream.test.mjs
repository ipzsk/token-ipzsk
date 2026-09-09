import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Upstream, providerPaths, providerTypes } from '../src/upstream.mjs';
import { Scheduler } from '../src/scheduler.mjs';
import { gatewayRoutes } from '../src/gateway.mjs';

const TOKEN = 'ipz_' + 'a'.repeat(43);

test('provider registry serves apimart paths and refuses unknown types', () => {
  assert.deepEqual(providerTypes, ['apimart']);
  assert.equal(providerPaths('apimart').keyBalance, '/v1/balance');
  assert.equal(providerPaths('apimart').accountBalance, '/v1/user/balance');
  assert.equal(providerPaths('apimart').task('a b'), '/v1/tasks/a%20b');
  for (const type of ['openrouter', '', undefined, null, 'APIMART']) {
    assert.throws(() => providerPaths(type), /unknown_provider_type/);
  }
});

async function upstreamFixture(rows = []) {
  const dir = await mkdtemp(join(tmpdir(), 'ipzsk-'));
  await writeFile(join(dir, 'fixture.key'), 'sk-' + 'a'.repeat(20) + '\n');
  const calls = [];
  const db = { query: async (sql, args) => { calls.push({ sql, args }); return { rows, rowCount: rows.length }; } };
  const urls = [];
  const upstream = new Upstream(db, dir, async (url) => { urls.push(url); return Response.json({ ok: true }); });
  return { upstream, urls, calls };
}

test('每个渠道用自己的 base_url，不再写死 apimart', async () => {
  const { upstream, urls } = await upstreamFixture();
  await upstream.request({ secret_ref: 'fixture.key', base_url: 'https://mirror.example' }, '/v1/chat/completions');
  await upstream.request({ secret_ref: 'fixture.key', base_url: 'https://mirror.example/proxy/' }, '/v1/balance');
  assert.deepEqual(urls, ['https://mirror.example/v1/chat/completions', 'https://mirror.example/proxy/v1/balance']);
});

test('按 secret_ref 调用时 base_url 从该渠道所属账户查出来，不回落默认值', async () => {
  const { upstream, urls } = await upstreamFixture([{ secret_ref: 'fixture.key', base_url: 'https://second.example', provider_type: 'apimart' }]);
  await upstream.request('fixture.key', '/v1/tasks/1');
  assert.deepEqual(urls, ['https://second.example/v1/tasks/1']);
  const empty = await upstreamFixture([]);
  await assert.rejects(empty.upstream.request('fixture.key', '/v1/tasks/1'), /unknown_channel/);
});

test('candidates 带出渠道行并支持跳过已失败的 key', async () => {
  const { upstream, calls } = await upstreamFixture();
  const skip = [randomUUID()];
  await upstream.candidates('gpt-4o-mini', skip);
  assert.match(calls[0].sql, /a\.base_url,a\.provider_type/);
  assert.match(calls[0].sql, /NOT \(k\.id=ANY\(\$2::uuid\[\]\)\)/);
  assert.deepEqual(calls[0].args, ['gpt-4o-mini', skip]);
});

// —— 换渠道重试 ——
function harness({ responses, channels: count = 4 }) {
  const userId = randomUUID(), tokenId = randomUUID();
  const attempts = [], requests = [];
  const identity = { rows: [{ id: userId, name: 'u', rpm: 600, token_rpm: null, token_id: tokenId, auth_session_id: null, plugin_id: null }], rowCount: 1 };
  const db = {
    async query(sql, args) {
      if (sql.includes('FROM access_tokens t')) return identity;
      if (sql.startsWith('INSERT INTO requests')) return { rows: [{ id: args[0] }], rowCount: 1 };
      if (sql.startsWith('INSERT INTO request_attempts')) { attempts.push({ id: args[0], key_id: args[2] }); return { rowCount: 1 }; }
      if (sql.startsWith('UPDATE request_attempts')) {
        Object.assign(attempts.find(a => a.id === args[0]), { http_status: args[2], error_code: args[3] });
        return { rowCount: 1 };
      }
      if (sql.startsWith('UPDATE requests SET status=$2')) { requests.push({ status: args[1], usage_state: args[2], error_code: args[8] }); return { rowCount: 1 }; }
      if (sql.includes('FROM billing_policy')) return { rows: [{ enabled: false }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    tx(work) { return work(db); },
  };
  const channels = [
    { id: randomUUID(), account_id: randomUUID(), secret_ref: 'a.key', base_url: 'https://a.example', provider_type: 'apimart', concurrency: 5, account_concurrency: 5 },
    { id: randomUUID(), account_id: randomUUID(), secret_ref: 'b.key', base_url: 'https://b.example', provider_type: 'apimart', concurrency: 5, account_concurrency: 5 },
    { id: randomUUID(), account_id: randomUUID(), secret_ref: 'c.key', base_url: 'https://c.example', provider_type: 'apimart', concurrency: 5, account_concurrency: 5 },
    { id: randomUUID(), account_id: randomUUID(), secret_ref: 'd.key', base_url: 'https://d.example', provider_type: 'apimart', concurrency: 5, account_concurrency: 5 },
  ].slice(0, count);
  const sent = [], failures = [];
  const upstream = {
    async candidates(_model, skip = []) { return channels.filter(c => !skip.includes(c.id)); },
    async request(channel) { sent.push(channel.base_url); const next = responses.shift(); if (next instanceof Error) throw next; return next(); },
    async markFailure(channel, status) { failures.push([channel.base_url, status]); },
    refreshSoon() {},
  };
  const app = Fastify();
  app.setErrorHandler((error, _req, reply) => reply.code(error.statusCode ?? 500).send({ error: { code: error.code } }));
  gatewayRoutes(app, { db, upstream, scheduler: new Scheduler({ waitMs: 200 }), origin: 'https://api.ipzsk.com' });
  const call = () => app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: 'Bearer ' + TOKEN },
    payload: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] } });
  return { call, sent, attempts, requests, failures };
}
const ok = () => Response.json({ id: 'up-1', choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
const status = (code) => () => new Response('', { status: code });

test('未提交（429 / 5xx / 渠道级故障）换渠道重试，每次尝试各留一行记录', async () => {
  for (const code of [429, 401, 402, 403]) {
    const h = harness({ responses: [status(code), ok] });
    const reply = await h.call();
    assert.equal(reply.statusCode, 200, String(code));
    assert.deepEqual(h.sent, ['https://a.example', 'https://b.example']);
    assert.equal(h.attempts.length, 2);
    assert.deepEqual([h.attempts[0].http_status, h.attempts[0].error_code], [code, `upstream_http_${code}`]);
    assert.deepEqual(h.failures, [['https://a.example', code]]);
    assert.deepEqual(h.requests, [{ status: 'succeeded', usage_state: 'reported', error_code: null }]);
  }
});

test('最多两次重试，共三次尝试后返回上游状态', async () => {
  const h = harness({ responses: [status(429), status(429), status(429), ok] });
  const reply = await h.call();
  assert.equal(reply.statusCode, 429);
  assert.equal(h.sent.length, 3);
  assert.equal(h.attempts.length, 3);
  assert.deepEqual(h.requests, [{ status: 'failed', usage_state: 'unknown', error_code: 'upstream_http_429' }]);
});

test('没有别的渠道可换时，保持现有行为返回上游状态', async () => {
  const h = harness({ responses: [status(429), ok], channels: 1 });
  assert.equal((await h.call()).statusCode, 429);
  assert.equal(h.sent.length, 1);
  assert.equal(h.attempts.length, 1);
});

test('已提交的请求绝不重放：非重试状态、连接中断和取消都只尝试一次', async () => {
  const midStream = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
  const aborted = Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
  // 5xx 也算已提交：上游可能已经建了媒体任务，只是回包失败。
  for (const [failure, expectStatus] of [[status(400), 502], [status(500), 502], [status(503), 502], [midStream, 502], [aborted, 502]]) {
    const h = harness({ responses: [failure, ok] });
    const reply = await h.call();
    assert.equal(reply.statusCode, expectStatus);
    assert.deepEqual(h.sent, ['https://a.example']);
    assert.equal(h.attempts.length, 1);
    assert.equal(h.requests[0].usage_state, 'unknown');
  }
});

test('连接根本没建立时视为未执行，可以换渠道，且失败到底只记 not_executed', async () => {
  const refused = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  const retried = harness({ responses: [refused(), ok] });
  assert.equal((await retried.call()).statusCode, 200);
  assert.deepEqual(retried.sent, ['https://a.example', 'https://b.example']);

  const exhausted = harness({ responses: [refused(), refused(), refused()] });
  const reply = await exhausted.call();
  assert.equal(reply.statusCode, 502);
  assert.equal(reply.json().error.code, 'upstream_connect_failed');
  assert.deepEqual(exhausted.requests, [{ status: 'failed', usage_state: 'not_executed', error_code: 'upstream_connect_failed' }]);
});
