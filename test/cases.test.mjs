import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validCanvasDocument, canvasAssetIds } from '../src/library.mjs';
import { caseListQuery, rankSimilar, validCaseTemplate, withTemplateKeys, encodeCaseCursor, caseFromManifest } from '../src/cases.mjs';
import { backfillAssetId } from '../src/image-archive.mjs';
import { videoUrls } from '../src/image-results.mjs';

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const doc = (over = {}) => ({ version: 1, nodes: [], edges: [], groups: [], viewport: { x: 0, y: 0, zoom: 1 }, ...over });
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };

test('canvas document validation', () => {
  assert.equal(code(() => validCanvasDocument(doc())), null);
  for (const bad of [null, [], doc({ version: 0 }), doc({ nodes: {} }), doc({ edges: [1] }), doc({ viewport: { x: 0, y: 0 } }),
    doc({ viewport: { x: 0, y: 0, zoom: 0 } }), doc({ nodes: [{ data: {} }] }), doc({ nodes: [{ id: 'n', data: [] }] })]) {
    assert.equal(code(() => validCanvasDocument(bad)), 'invalid_canvas_document', JSON.stringify(bad));
  }
  const nodes = Array.from({ length: 1001 }, (_, i) => ({ id: 'n' + i }));
  assert.equal(code(() => validCanvasDocument(doc({ nodes, groups: nodes }))), 'too_many_canvas_nodes');
  assert.equal(code(() => validCanvasDocument(doc({ nodes: [{ id: 'n', data: { text: 'x'.repeat(2_000_001) } }] }))), 'canvas_too_large');
});

test('canvas asset ids: asset, asset_id, results, reference_asset_ids; deduped; non-uuid rejected', () => {
  const d = doc({ nodes: [
    { id: 'a', data: { asset: { id: A, urls: {} } } },
    { id: 'b', data: { results: [{ id: B }, A], reference_asset_ids: [B] } },
    { id: 'c', data: { asset_id: A.toUpperCase(), text: A } },
    { id: 'd' },
  ] });
  assert.deepEqual(canvasAssetIds(d).sort(), [A, B]);
  assert.equal(code(() => canvasAssetIds(doc({ nodes: [{ id: 'x', data: { asset: { id: 'mock-1' } } }] }))), 'invalid_canvas_document');
  assert.equal(code(() => canvasAssetIds(doc({ nodes: [{ id: 'x', data: { results: 'nope' } }] }))), 'invalid_canvas_document');
});

test('case list query: category, escaped search, cursor, limit', () => {
  let q = caseListQuery({});
  assert.equal(q.limit, 60); assert.deepEqual(q.args, [61]); assert.match(q.sql, /status='published'/); assert.match(q.sql, /ORDER BY c.position,c.id/);
  q = caseListQuery({ cat: 'posters', q: ' 50%_off ', cursor: encodeCaseCursor(3.5, '543'), limit: '10' });
  assert.deepEqual(q.args, ['posters', '%50\\%\\_off%', 3.5, '543', 11]);
  assert.match(q.sql, /c.category=\$1/); assert.match(q.sql, /c.title ILIKE \$2 OR c.prompt ILIKE \$2 OR array_to_string\(c.tags,' '\) ILIKE \$2/);
  assert.match(q.sql, /\(c.position,c.id\)>\(\$3::double precision,\$4\)/);
  for (const bad of [{ cursor: 'zzz' }, { limit: '0' }, { limit: '61' }, { q: 'x'.repeat(101) }, { cursor: encodeCaseCursor(1, '../x') }]) {
    assert.equal(code(() => caseListQuery(bad)) !== null, true, JSON.stringify(bad));
  }
});

test('similar ranking: same category first, then tag overlap, then feed order; excludes self; max 12', () => {
  const base = { id: '1', category: 'poster', tags: ['a', 'b'], position: 0 };
  const c = (id, category, tags, position) => ({ id, category, tags, position });
  const out = rankSimilar(base, [base, c('2', 'poster', [], 5), c('3', 'poster', ['a', 'b'], 9), c('4', 'other', ['a'], 1), c('5', 'other', [], 0), c('6', 'poster', ['a'], 7)]);
  assert.deepEqual(out.map((x) => x.id), ['3', '6', '2', '4']);
  assert.equal(rankSimilar(base, Array.from({ length: 20 }, (_, i) => c('x' + i, 'poster', [], i))).length, 12);
});

test('case template validation and manifest mapping', () => {
  const t = { items: [{ key: 'main', label: '主图', count: 1, references: [{ slot: '商品图' }] }, { key: 's', label: '卖点', count: 2 }] };
  assert.equal(validCaseTemplate(t), t); assert.equal(validCaseTemplate(undefined), null);
  for (const bad of [{ items: [] }, { items: Array.from({ length: 13 }, () => ({ label: 'x' })) }, { items: [{ label: 'x', references: [{ asset_id: 'a' }] }] },
    { items: [{ label: 'x', count: 0 }] }, { items: [{ label: 'x', ratio: '1:1' }] }, { items: [{ label: 'x', params: { n: '2' } }] },
    { items: [{ label: 'x', params: { aspect_ratio: 'x'.repeat(21) } }] }, { items: [{ key: 'a', label: 'x' }, { key: 'a', label: 'y' }] }, { items: [{ label: 'x', anchor: 1 }] }]) {
    assert.equal(code(() => validCaseTemplate(bad)), 'invalid_template', JSON.stringify(bad));
  }
  assert.equal(code(() => validCaseTemplate({ items: [{ label: 'x', count: 13 }] })), 'template_too_many_outputs');
  assert.equal(code(() => validCaseTemplate({ items: [{ label: 'x', count: 7 }, { label: 'y', count: 6 }] })), 'template_too_many_outputs');
  assert.equal(code(() => validCaseTemplate({ items: [{ label: 'x', anchor: true }, { label: 'y', anchor: true }] })), 'template_multiple_anchors');
  const full = { items: [{ key: 'main', label: '主图', description: 'd', count: 1, params: { aspect_ratio: '1:1', resolution: '2K' }, anchor: true, references: [{ slot: '商品图' }] }, { label: '卖点', anchor: false }, { key: 'item-2', label: 'z' }] };
  assert.equal(validCaseTemplate(full), full);
  assert.deepEqual(withTemplateKeys(full).items.map((i) => i.key), ['main', 'item-3', 'item-2']);
  const manifest = JSON.parse(readFileSync(new URL('./fixtures/cases.manifest.json', import.meta.url)));
  const mapped = caseFromManifest(manifest[0], 0);
  assert.equal(mapped.category_zh, manifest[0].categoryZh); assert.equal(mapped.source, manifest[0].image.orig);
});

test('backfill asset id is a stable uuid; video urls parsed like image urls', () => {
  assert.equal(backfillAssetId(A, 0), backfillAssetId(A, 0)); assert.notEqual(backfillAssetId(A, 0), backfillAssetId(A, 1));
  assert.match(backfillAssetId(A, 0), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(videoUrls({ result: { videos: [{ url: ['https://v.test/a.mp4'] }, { url: 'https://v.test/b.mp4' }, {}] } }), ['https://v.test/a.mp4', 'https://v.test/b.mp4']);
});
