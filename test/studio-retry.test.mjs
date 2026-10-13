import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { rerunnableAttempt } from '../src/gateway.mjs';

test('确定没在上游执行的失败可以用同一幂等键重新执行', () => {
  // 余额不足 / 参数校验 / 连接未建立：根本没发出去。
  assert.equal(rerunnableAttempt({ status: 'failed', usage_state: 'not_executed', error_code: 'insufficient_balance', billing_state: 'released' }), true);
  assert.equal(rerunnableAttempt({ status: 'failed', usage_state: 'not_executed', error_code: 'insufficient_balance', billing_state: null }), true);
  // 上游 4xx 明确拒绝，冻结已退。
  assert.equal(rerunnableAttempt({ status: 'failed', usage_state: 'unknown', error_code: 'upstream_http_400', billing_state: 'released' }), true);
});

test('结果不确定或冻结未退的旧请求绝不重放', () => {
  for (const prior of [
    { status: 'uncertain', usage_state: 'unknown', error_code: 'upstream_result_uncertain', billing_state: 'pending' },
    { status: 'failed', usage_state: 'unknown', error_code: 'upstream_http_502', billing_state: 'pending' },
    { status: 'failed', usage_state: 'unknown', error_code: 'upstream_http_500', billing_state: null },
    // 4xx 但冻结还在（不该出现，出现了就交人工）
    { status: 'failed', usage_state: 'unknown', error_code: 'upstream_http_400', billing_state: 'pending' },
    { status: 'succeeded', usage_state: 'reported', error_code: null, billing_state: 'settled' },
    { status: 'running', usage_state: 'pending', error_code: null, billing_state: 'reserved' },
    { status: 'queued', usage_state: 'pending', error_code: null, billing_state: null },
  ]) assert.equal(rerunnableAttempt(prior), false, JSON.stringify(prior));
});

test('重放只在网页生图路径生效，并且先把旧行的键改名留档', async () => {
  const source = await readFile(new URL('../src/gateway.mjs', import.meta.url), 'utf8');
  assert.match(source, /if \(!inserted\.rowCount && studio\) \{/);
  assert.match(source, /SET idempotency_key=idempotency_key\|\|':retired:'\|\|id WHERE id=\$1 AND idempotency_key=\$2 AND status='failed'/);
});
