import test from 'node:test';
import assert from 'node:assert/strict';
import { UsageReader, extractUsage } from '../src/usage.mjs';
import { Scheduler } from '../src/scheduler.mjs';
import { passwordHash, verifyPassword, sessionCookie, readSession } from '../src/security.mjs';

test('SSE usage survives every byte boundary and repeated cumulative reports', () => {
  const body = 'data: {"choices":[{"delta":{"content":"你好"}}]}\r\n\r\n' +
    'data: {"usage":{"prompt_tokens":12,"completion_tokens":8,"total_tokens":20}}\n\n' +
    'data: {"id":"upstream-1","usage":{"prompt_tokens":12,"completion_tokens":8,"total_tokens":20}}\n\n' +
    'data: [DONE]\n\n';
  const reader = new UsageReader();
  for (const byte of Buffer.from(body)) reader.push(Buffer.from([byte]));
  reader.finish();
  assert.deepEqual(reader.usage, { input: 12, output: 8, total: 20 });
  assert.equal(reader.done, true);
  assert.equal(reader.failed, false);
  assert.equal(reader.upstreamId, 'upstream-1');
});
test('missing / invalid usage remains unknown, including truncated streams', () => {
  assert.equal(extractUsage({}), null);
  assert.equal(extractUsage({ usage: { prompt_tokens: -1, completion_tokens: 0 } }), null);
  assert.equal(extractUsage({ usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 2 } }), null);
  const reader = new UsageReader();
  reader.push(Buffer.from('data: {"choices":[]}\n\ndata: {"usa'));
  reader.finish();
  assert.equal(reader.done, false);
  assert.equal(reader.usage, null);
});
test('SSE application errors are detected even with HTTP 200', () => {
  const reader = new UsageReader();
  reader.push(Buffer.from('data: {"error":{"message":"failure"}}\n\ndata: [DONE]\n\n'));
  assert.equal(reader.failed, true);
});
test('two keys in one account cannot exceed account concurrency', async () => {
  const scheduler = new Scheduler({ waitMs: 10 });
  const rows = async () => [
    { id: 'k1', account_id: 'a', concurrency: 3, account_concurrency: 1 },
    { id: 'k2', account_id: 'a', concurrency: 3, account_concurrency: 1 },
  ];
  const lease = await scheduler.acquire(rows);
  await assert.rejects(scheduler.acquire(rows), { code: 'queue_timeout' });
  assert.equal(scheduler.waiting, 0);
  lease.release(); lease.release();
  assert.equal(scheduler.accounts.size, 0);
  const second = await scheduler.acquire(rows);
  second.release();
});
test('cancelled queued requests do not reserve channel capacity', async () => {
  const scheduler = new Scheduler();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(scheduler.acquire(async () => [], controller.signal));
  assert.equal(scheduler.waiting, 0);
  assert.equal(scheduler.keys.size, 0);
});
test('password verification and cookie parsing', async () => {
  const stored = await passwordHash('test-password-only');
  assert.equal(await verifyPassword('test-password-only', stored), true);
  assert.equal(await verifyPassword('wrong', stored), false);
  const cookie = sessionCookie('abc', 100);
  assert.equal(readSession(cookie), 'abc');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
});
