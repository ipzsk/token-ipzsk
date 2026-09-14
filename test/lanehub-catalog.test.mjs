import test from 'node:test';
import assert from 'node:assert/strict';
import { LanehubCatalog, desktopFromCatalog } from '../src/lanehub-catalog.mjs';

const fixture = {
  usd_cny: 6.7, models: [
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', kind: 'chat', modalities: ['text'], context_length: 128000, max_tokens: 8192,
      billing: { type: 'tokens', unit: 'per_1m_tokens', input_usd: 0.34, output_usd: 1.03 } },
    { id: 'gpt-image-2', kind: 'image', modalities: ['image'], billing: { type: 'times', unit: 'per_call', usd: 0.0085 },
      params: { registered: true, fields: [
        { field: 'aspect_ratio', values: ['1:1', '16:9'] }, { field: 'resolution', values: ['1k', '2k'] },
        { field: 'duration', unsupported: '图片没有时长' }, { field: 'size', values: ['1024x1024'] } ] } },
    { id: 'z-image-turbo', kind: 'image', modalities: ['image'], billing: { type: 'times', unit: 'per_call', usd: 0.003 }, params: { registered: true, fields: [{ field: 'resolution', values: ['1k'] }] } },
    { id: 'seedance-2.0', kind: 'video', modalities: ['video'], billing: { type: 'times', unit: 'per_second', usd: 0.02, tiers: { '480p': 0.02, '720p': 0.04 } },
      params: { registered: true, fields: [{ field: 'resolution', values: ['480p', '720p'] }] } },
    { id: 'not-on-our-keys', kind: 'chat', modalities: ['text'], billing: { type: 'tokens', unit: 'per_1m_tokens', input_usd: 1, output_usd: 1 } },
    { id: 'claude-opus-5', kind: 'chat', modalities: ['text'], billing: { type: 'tokens', unit: 'per_1m_tokens', input_usd: 2, output_usd: 10 } },
  ],
};

// 桌面端只拿这边密钥挂着的型号；分桶按 kind；图片型号带上旧客户端校验的 sizes。
test('目录 → 桌面端形状', () => {
  const out = desktopFromCatalog(fixture, new Set(['deepseek-v4-flash', 'gpt-image-2', 'seedance-2.0', 'claude-opus-5', 'z-image-turbo']));
  assert.equal(out.default_model, 'deepseek-v4-flash');
  assert.deepEqual(out.models.map((m) => m.id), ['deepseek-v4-flash', 'claude-opus-5']);
  assert.equal(out.models[0].contextWindow, 128000);
  // 目录没给上下文长度时必须给保守默认值：客户端把它当硬校验，缺了整个登录失败（2026-09-14 实录）。
  assert.equal(out.models[1].contextWindow, 32768);
  assert.equal(out.models[1].maxTokens, 4096);
  assert.ok(out.models.every((m) => Number.isSafeInteger(m.contextWindow) && m.contextWindow >= 1 && Number.isSafeInteger(m.maxTokens) && m.maxTokens >= 1));
  assert.deepEqual(out.image_models.map((m) => m.id), ['gpt-image-2', 'z-image-turbo']);
  // 没有比例枚举的图片模型也必须带 sizes / default_size：已发布客户端把它当硬校验。
  assert.ok(out.image_models[1].sizes.length > 5 && out.image_models[1].default_size === '1:1');
  assert.deepEqual(out.video_models.map((m) => m.id), ['seedance-2.0']);
  const img = out.image_models[0];
  assert.deepEqual(img.sizes, ['1:1', '16:9'], '图片 sizes 从 aspect_ratio 派生');
  assert.equal(img.default_size, '1:1');
  assert.deepEqual(img.unsupported, { duration: '图片没有时长' });
  assert.deepEqual(img.params.map((p) => p.field), ['prompt', 'aspect_ratio', 'resolution'], '非 canonical 的 size 与 unsupported 的字段不进 params');
  const vid = out.video_models[0];
  assert.deepEqual(vid.tiers, ['480p', '720p']);
  assert.equal(vid.billing_unit, 'per_second');
  assert.ok(!out.models.some((m) => m.id === 'not-on-our-keys'), '这边没挂密钥的型号不下发');
});

// 从没拉到过 → 503，不回落到任何快照；拉到过一次之后拉失败 → 保留上一份。
test('失败语义：无目录 503，失败保留旧值', async () => {
  let fail = false;
  const lanehub = { call: async () => { if (fail) throw new Error('down'); return fixture; } };
  const cat = new LanehubCatalog(lanehub, { log: () => {} });
  assert.throws(() => cat.desktop(new Set()), (e) => e.code === 'catalog_unavailable' && e.statusCode === 503);
  await cat.refresh();
  assert.equal(cat.data.models.length, 6);
  fail = true;
  await cat.refresh();
  assert.equal(cat.data.models.length, 6, "拉失败要保留上一份");
  assert.ok(cat.lastError, '失败要记下来，不能和刚刷新过长得一样');
});
