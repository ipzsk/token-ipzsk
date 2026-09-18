import test from 'node:test';
import assert from 'node:assert/strict';
import { LanehubCatalog, mediaModelsFromCatalog } from '../src/lanehub-catalog.mjs';
import { referencesFor } from '../src/media-references.mjs';
import { QuoteCache, validMentions, validPromptDoc, recordStatus, pageLimit, paged } from '../src/studio.mjs';

const catalog = { models: [
  { id: 'deepseek', kind: 'chat', billing: { unit: 'per_1m_tokens' } },
  { id: 'gpt-image-2.5-flare', name: 'GPT Image 2.5 Flare', kind: 'image', billing: { type: 'times', unit: 'per_call', usd: 0.02, tiers: { '1K': 0.02, '4K': 0.08 } },
    params: { registered: true, fields: [
      { field: 'aspect_ratio', values: ['auto', '16:9', '1:1'] }, { field: 'image_urls' }, { field: 'n', values: ['1', '2'] },
      { field: 'prompt' }, { field: 'resolution', values: ['1K', '2K', '4K'] }, { field: 'duration', unsupported: '图片没有时长' } ] } },
  { id: 'gpt-image-2', kind: 'image', billing: { unit: 'per_call' }, params: { registered: false, fields: [] } },
  { id: 'z-image-turbo', kind: 'image', billing: { unit: 'per_call' }, params: { registered: true, fields: [{ field: 'resolution', values: ['1k'] }] } },
  { id: 'seedance-2.0-mini', kind: 'video', billing: { unit: 'per_second' },
    params: { registered: true, fields: [{ field: 'duration', values: ['5', '10'] }, { field: 'image_urls', unsupported: '暂不开放图生视频' }, { field: 'first_frame_image' }] } },
] };

test('catalog → ModelSpec: kinds, case-preserved values, defaults, unsupported, references table', () => {
  const models = mediaModelsFromCatalog(catalog);
  assert.deepEqual(models.map((m) => m.id), ['gpt-image-2.5-flare', 'gpt-image-2', 'z-image-turbo', 'seedance-2.0-mini']);
  const flare = models[0];
  assert.deepEqual(flare, { id: 'gpt-image-2.5-flare', name: 'GPT Image 2.5 Flare', kind: 'image', billing: { unit: 'per_call', tiers: ['1K', '4K'] },
    params: [
      { field: 'aspect_ratio', type: 'enum', values: ['auto', '16:9', '1:1'], default: '1:1' },
      { field: 'n', type: 'enum', values: ['1', '2'], default: '1' },
      { field: 'resolution', type: 'enum', values: ['1K', '2K', '4K'], default: '1K' },
    ],
    references: { maxImages: 15 }, unsupported: { duration: '图片没有时长' } });
  assert.equal(models[1].references.maxImages, 15, 'unregistered schema keeps the table value');
  assert.equal(models[2].references.maxImages, 0, 'unknown model defaults to 0');
  assert.deepEqual(models[3].references, { maxImages: 0, firstFrame: true });
  assert.deepEqual(models[3].params, [{ field: 'duration', type: 'enum', values: ['5', '10'], default: '5', unit: 's' }]);
  // lanehub 的 default 就是它计价用的兜底值：网关必须原样用，猜出来的默认值会让报价和实扣不是同一档。
  const withDefaults = mediaModelsFromCatalog({ models: [{ id: 'z-image-turbo', kind: 'image', billing: { unit: 'per_call' },
    params: { registered: true, fields: [
      { field: 'enhance_prompt', values: ['true', 'false'] },
      { field: 'resolution', values: ['1K', '2K'], default: '1K' },
      { field: 'aspect_ratio', values: ['16:9', '1:1'] },
    ] } }] })[0];
  assert.deepEqual(withDefaults.params.find((p) => p.field === 'resolution').default, '1K', 'lanehub 给的默认值优先');
  assert.deepEqual(withDefaults.params.find((p) => p.field === 'enhance_prompt').default, 'false', '开关没给默认值时默认关闭，不替用户选加价项');
  // lanehub 的 image_urls.counts 是上游实际接受的张数，比这边的手抄表新。
  const byCounts = mediaModelsFromCatalog({ models: [{ id: 'seedance-2.0-mini', kind: 'video', billing: { unit: 'per_second' },
    params: { registered: true, fields: [{ field: 'image_urls', counts: [1, 2, 3, 9] }, { field: 'prompt' }] } }] })[0];
  assert.equal(byCounts.references.maxImages, 9, 'counts 覆盖手抄表');
  assert.equal(referencesFor('gpt-image-2.5-sunburst').maxImages, 15);
  assert.equal(referencesFor('gpt-image-20').maxImages, 0);
});

// lanehub 只给入参契约登记过的 HeyGen 型号 mode；没 mode 的那几条（heygen-video-agent /
// heygen-video-translate）在 lanehub 里没有提交路径，工作台点了必失败，不进目录。
test('目录过滤：没有 mode 的 heygen 型号不下发', () => {
  const ids = (models) => mediaModelsFromCatalog({ models }).map((m) => m.id);
  assert.deepEqual(ids([
    { id: 'heygen-video-agent', kind: 'video', billing: { unit: 'per_minute_output' } },
    { id: 'heygen-video-translate', kind: 'video', billing: { unit: 'per_minute_output' } },
    { id: 'heygen-avatar', kind: 'video', mode: 'avatar', inputs: { required: ['avatar_id'] }, billing: { unit: 'per_minute_output' } },
    { id: 'heygen-avatar-iii', kind: 'video', mode: 'avatar', inputs: { required: ['avatar_id'] }, billing: { unit: 'per_minute_output' } },
    { id: 'heygen-image', kind: 'video', billing: { unit: 'per_minute_output' }, params: { registered: true, passthrough: ['script'], fields: [{ field: 'image_urls' }] } },
    { id: 'seedance-2.0-mini', kind: 'video', billing: { unit: 'per_second' } },
  ]), ['heygen-avatar', 'heygen-avatar-iii', 'heygen-image', 'seedance-2.0-mini']);
  // mode 是 HeyGen 专有的：别的厂商没有 mode 也照常下发。
  assert.deepEqual(ids([{ id: 'sora-2', kind: 'video', billing: { unit: 'per_second' } }]), ['sora-2']);
  assert.equal(mediaModelsFromCatalog({ models: [{ id: 'heygen-avatar', kind: 'video', mode: 'avatar', inputs: { required: ['avatar_id'] }, billing: {} }] })[0].avatar.engine, 'iv');
});

test('media() caches per refresh and 503s before the first load', async () => {
  let data = catalog;
  const cat = new LanehubCatalog({ call: async () => data }, { log: () => {} });
  assert.throws(() => cat.media(), (e) => e.code === 'catalog_unavailable' && e.statusCode === 503);
  await cat.refresh();
  const first = cat.media();
  assert.equal(cat.media(), first, 'same object until refresh');
  data = { models: [...catalog.models] };
  await cat.refresh();
  assert.notEqual(cat.media(), first);
});

test('quote cache: key = user + canonical body, TTL capped by expires_at, LRU eviction', () => {
  let now = 1_000_000;
  const cache = new QuoteCache({ max: 2, now: () => now });
  const a = QuoteCache.key('u1', { model: 'm', params: { b: 1, a: 2 } });
  assert.equal(a, QuoteCache.key('u1', { params: { a: 2, b: 1 }, model: 'm' }), 'key order does not matter');
  assert.notEqual(a, QuoteCache.key('u2', { model: 'm', params: { b: 1, a: 2 } }), 'per user');
  cache.set(a, 'A', now + 60_000);
  now += 59_999; assert.equal(cache.get(a), 'A');
  now += 1; assert.equal(cache.get(a), undefined, 'expires with lanehub quote');
  cache.set('b', 'B'); now += 600_000; assert.equal(cache.get('b'), undefined, '10 minute ceiling');
  cache.set('x', 1); cache.set('y', 2); cache.get('x'); cache.set('z', 3);
  assert.equal(cache.get('y'), undefined, 'least recently used evicted');
  assert.equal(cache.get('x'), 1);
  cache.set('past', 1, now - 1); assert.equal(cache.get('past'), undefined);
});

test('mentions and prompt_doc validation', () => {
  const id = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
  assert.deepEqual(validMentions(undefined), []);
  assert.deepEqual(validMentions([{ type: 'subject', id, name: '橘猫' }]), [{ type: 'subject', id, name: '橘猫' }]);
  for (const bad of [{}, [{ type: 'user', id, name: 'x' }], [{ type: 'subject', id: '1', name: 'x' }], [{ type: 'reference', id, name: '' }],
    [{ type: 'subject', id, name: 'x', extra: 1 }], Array(21).fill({ type: 'subject', id, name: 'x' })]) {
    assert.throws(() => validMentions(bad), { code: 'invalid_mentions' });
  }
  assert.equal(validPromptDoc(null), null);
  assert.deepEqual(validPromptDoc({ type: 'doc' }), { type: 'doc' });
  assert.throws(() => validPromptDoc([1]), { code: 'invalid_prompt_doc' });
  assert.throws(() => validPromptDoc({ t: 'x'.repeat(50_000) }), { code: 'invalid_prompt_doc' });
  assert.deepEqual(['submitted', 'pending', 'processing', 'completed', 'failed', 'cancelled'].map(recordStatus),
    ['queued', 'queued', 'running', 'succeeded', 'failed', 'cancelled']);
});

test('pageLimit: default 50, 1..50 integers only; paged honours size', () => {
  assert.equal(pageLimit(undefined), 50);
  assert.equal(pageLimit('7'), 7);
  for (const bad of ['0', '51', '1.5', 'x', '']) assert.throws(() => pageLimit(bad), (e) => e.code === 'invalid_limit' || e.message === 'invalid_limit');
  const rows = [1, 2, 3].map((n) => ({ id: String(n), cursor_at: 't' + n }));
  const page = paged(rows, (r) => r.id, 2);
  assert.deepEqual(page.items, ['1', '2']);
  assert.deepEqual(JSON.parse(Buffer.from(page.next_cursor, 'base64url')), ['t2', '2']);
  assert.equal(paged(rows, (r) => r.id, 3).next_cursor, null);
});
