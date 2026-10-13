import test from 'node:test';
import assert from 'node:assert/strict';
import { taskOutcome } from '../src/media-task-sync.mjs';
import { settleStatus } from '../src/image-results.mjs';

// Same shape refreshMediaTask passes: the stored task with the upstream result under `result`.
const images = { result: { images: [{ url: ['https://cdn.test/a.png'] }] } };

test('completed 只有带回对应结果才算成功', () => {
  assert.deepEqual(taskOutcome('image', 'completed', images), { status: 'succeeded', failureCode: null, settle: 'completed', settleReason: undefined });
  assert.deepEqual(taskOutcome('image', 'completed', { result: { images: [] } }), { status: 'failed', failureCode: 'image_result_missing', settle: 'failed', settleReason: 'image_result_missing' });
  assert.deepEqual(taskOutcome('image', 'completed', null), { status: 'failed', failureCode: 'image_result_missing', settle: 'failed', settleReason: 'image_result_missing' });
  // 视频：缩略图不算结果；以前这种情况记录标失败、账单却按 completed 扣费。
  assert.deepEqual(taskOutcome('video', 'completed', { result: { videos: [{ url: ['https://cdn.test/poster.jpg'] }] } }).settle, 'failed');
  assert.equal(taskOutcome('video', 'completed', { result: { videos: [{ url: ['https://cdn.test/v.mp4'] }] } }).status, 'succeeded');
});

test('非终态与失败照旧', () => {
  assert.equal(taskOutcome('image', 'processing', null).status, 'running');
  assert.deepEqual(taskOutcome('image', 'failed', null), { status: 'failed', failureCode: 'media_task_failed', settle: 'failed', settleReason: undefined });
  assert.equal(settleStatus('image', 'cancelled', null), 'cancelled');
});
