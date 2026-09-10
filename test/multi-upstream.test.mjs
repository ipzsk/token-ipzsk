import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Upstream, providerPaths, providerTypes, providerOptions } from '../src/upstream.mjs';
import { Scheduler } from '../src/scheduler.mjs';
import { gatewayRoutes } from '../src/gateway.mjs';
import { recordTaskCharge } from '../src/task-charges.mjs';

const TOKEN = 'ipz_' + 'a'.repeat(43);

test('provider registry serves apimart paths and refuses unknown types', () => {
  assert.deepEqual(providerTypes, ['apimart', 'openai_relay']);
  assert.equal(providerPaths('apimart').keyBalance, '/v1/balance');
  assert.equal(providerPaths('apimart').accountBalance, '/v1/user/balance');
  assert.equal(providerPaths('apimart').task('a b'), '/v1/tasks/a%20b');
  for (const type of ['openrouter', '', undefined, null, 'APIMART']) {
    assert.throws(() => providerPaths(type), /unknown_provider_type/);
  }
});

test('没有的能力用显式 null 登记，不是省略；后台下拉带中文名', () => {
  const relay = providerPaths('openai_relay');
  for (const capability of ['keyBalance', 'accountBalance', 'task', 'validBalance']) {
    assert.ok(capability in relay, capability);
    assert.equal(relay[capability], null);
  }
  assert.deepEqual(providerOptions, [{ type:'apimart', label:'APIMart' }, { type:'openai_relay', label:'通用 OpenAI 中转' }]);
});

test('没有余额接口的渠道不查余额，也不因此被停用', async () => {
  const account = randomUUID();
  const rows = [{ id: randomUUID(), account_id: account, secret_ref: 'fixture.key', base_url: 'https://relay.example', provider_type: 'openai_relay' }];
  const { upstream, urls, calls } = await upstreamFixture(rows);
  upstream.db.tx = async (fn) => fn(upstream.db);
  assert.deepEqual(await upstream.sync(), { refreshed_keys: 1, refreshed_accounts: 1 });
  assert.deepEqual(urls, []);
  assert.equal(calls.filter((c) => /balance_error|balance_at|balance_snapshots/.test(c.sql)).length, 0);
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
  assert.deepEqual(calls[0].args, ['gpt-4o-mini', skip, ['apimart'], false, ['apimart']]);
});

test('可用性按能力分支：余额规则只压在有余额接口的渠道上，enabled/blocked/cooldown 对所有渠道都在', async () => {
  const { upstream, calls } = await upstreamFixture();
  await upstream.candidates('gpt-4o-mini');
  const sql = calls[0].sql.replace(/\s+/g, ' ');
  // 余额新鲜度 + 余额>0 整体挂在「这家有余额接口」的条件下，openai_relay 直接跳过这一段。
  assert.match(sql, /AND \(NOT a\.provider_type=ANY\(\$3::text\[\]\) OR \(a\.remain_credits>0 AND a\.balance_at>now\(\)-interval '10 minutes' AND k\.balance_at>now\(\)-interval '10 minutes' AND \(k\.unlimited OR k\.remain_credits>0\)\)\)/);
  assert.match(sql, /k\.enabled AND a\.enabled AND NOT a\.blocked AND \(k\.cooldown_until IS NULL OR k\.cooldown_until<=now\(\)\)/);
  assert.equal(/a\.remain_credits>0/.test(sql.split('AND (NOT a.provider_type=ANY($3::text[])')[0]), false);
});

test('媒体模型只走有异步任务接口的渠道，文本模型不受这条限制', async () => {
  const { upstream, calls } = await upstreamFixture();
  await upstream.candidates('gpt-image-2');
  assert.match(calls[0].sql.replace(/\s+/g, ' '), /AND \(NOT \$4::boolean OR a\.provider_type=ANY\(\$5::text\[\]\)\)/);
  // $4=true 时只留下注册了 task 的 provider；openai_relay 没有 /v1/tasks/{id}，永远不在这份名单里。
  assert.deepEqual(calls[0].args.slice(3), [true, ['apimart']]);
  assert.equal(calls[0].args[4].includes('openai_relay'), false);
  assert.equal(providerPaths('openai_relay').task, null);
  const chat = await upstreamFixture();
  await chat.upstream.candidates('gpt-5.6-sol');
  assert.equal(chat.calls[0].args[3], false);
});

test('credits_cost 只在 apimart 渠道记成本，别的 provider 宁可不记', async () => {
  const sqls = [];
  const db = { tx: (fn) => fn({ query: async (sql) => { sqls.push(sql); return { rowCount: 0, rows: [] }; } }) };
  const task = { id: randomUUID(), upstream_task_id: 'up-1' };
  const data = { id: 'up-1', status: 'completed', credits_cost: 0.5 };
  assert.equal(await recordTaskCharge(db, task, data), false);
  // 金额写入自带 provider 判定；渠道不是 apimart 时这条 UPDATE 命中 0 行，后面的审计与结算都不会发生。
  assert.match(sqls[0].replace(/\s+/g, ' '), /UPDATE requests SET cost_cny.+EXISTS \(SELECT 1 FROM upstream_keys k JOIN upstream_accounts a ON a\.id=k\.account_id WHERE k\.id=requests\.key_id AND a\.provider_type='apimart'\)/s);
  assert.equal(sqls.length, 1);
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
