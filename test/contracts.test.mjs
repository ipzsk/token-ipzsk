import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from '../src/app.mjs';
import { mediaModelsFromCatalog } from '../src/lanehub-catalog.mjs';
import { validate, parseShape, schemas } from '../src/contracts-schema.mjs';
import { buildContracts, ROUTE_META } from '../scripts/export-contracts.mjs';

test('contracts/ artifacts are up to date (run npm run contracts)', async () => {
  const { json, dts } = await buildContracts();
  assert.equal(await readFile(new URL('../contracts/endpoints.json', import.meta.url), 'utf8'), json);
  assert.equal(await readFile(new URL('../contracts/ipzsk-api.d.ts', import.meta.url), 'utf8'), dts);
  assert.deepEqual(await buildContracts(), { json, dts }, 'exporter is deterministic');
});

test('every route in studio/uploads/library/cases/roles/admin-studio/admin-ops has a routeMeta entry', async () => {
  for (const file of ['studio', 'uploads', 'library', 'cases', 'roles', 'admin-studio', 'admin-ops']) {
    const text = await readFile(new URL(`../src/${file}.mjs`, import.meta.url), 'utf8');
    for (const m of text.matchAll(/\bapp\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)) {
      assert.ok(ROUTE_META[`${m[1].toUpperCase()} ${m[2]}`], `${file}.mjs: ${m[1].toUpperCase()} ${m[2]} missing from routeMeta`);
    }
  }
});

test('validator catches drift', () => {
  assert.deepEqual(validate(schemas.Thread, { id: '00000000-0000-4000-8000-000000000001', title: '', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }), []);
  assert.match(validate(schemas.Thread, { id: 'x', title: 1, created_at: 'no', extra: 1 }).join('\n'), /uuid[\s\S]*string[\s\S]*datetime[\s\S]*missing updated_at[\s\S]*unexpected key extra/);
  assert.equal(validate(schemas.GenerationBody, { model: 'm', batch_position: 12 }).length, 1, 'batch_position is 0..11');
});

test('earnings contracts require a customer session for every own-account route', async () => {
  const routes = JSON.parse((await buildContracts()).json).endpoints.filter(route => route.path.startsWith('/api/me/commissions'));
  assert.equal(routes.length, 3);
  for (const route of routes) assert.equal(route.auth, 'cookie');
});

// ── 真实 handler（假 db / 假存储 / 假会话）的响应对上 schema ──
const USER = '10000000-0000-4000-8000-000000000001';
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const A1 = id(1), A2 = id(2), R1 = id(3), T1 = id(4), TH = id(5), S1 = id(6), P1 = id(7), F1 = id(8), TP = id(9), B1 = id(10);
const now = new Date('2026-09-17T00:00:00Z'), cursor_at = '2026-09-17 00:00:00.123456+00';
const asset = { id: A1, user_id: USER, kind: 'image', source: 'upload', status: 'ready', object_key: `u/${USER}/${A1}/orig.png`, content_type: 'image/png', bytes: '10',
  width: 1, height: 1, duration_ms: null, variants: { w480: `u/${USER}/${A1}/w480.webp` }, created_at: now, thumb_state: 'done', task_id: T1, result_index: 0, cursor_at };
const item = { item_id: id(11), kind: 'image', model: 'gpt-image-2.5-flare', prompt: 'p', params: { resolution: '1K' }, reference_asset_ids: [A1, A2], mentions: [{ type: 'subject', id: S1, name: '小猫' }] };
const caseRow = { id: 'case-1', title: 't', prompt: 'p', category: 'poster', category_zh: '海报', tags: ['a'], model: null, params: {}, template: { items: [{ label: 'x', count: 2, references: [{ slot: 'face' }] }] },
  author: null, author_url: null, source_url: null, source_repo: null, license_note: null, position: 1, cover_id: A1, object_key: 'cases/x/orig.png', variants: {}, width: 10, height: 10,
  kind: 'image', license_tier: null, video_id: null };
// Video case whose cover is the video itself (poster as image), exercising CaseVideo.
const videoCaseRow = { ...caseRow, id: 'case-v', kind: 'video', license_tier: 'B', cover_kind: 'video', object_key: 'cases/v/orig.mp4',
  variants: { poster: 'cases/v/poster.jpg', w480: 'cases/v/w480.jpg' }, video_id: A2, video_key: 'cases/v/orig.mp4',
  video_variants: { poster: 'cases/v/poster.jpg' }, video_width: 720, video_height: 1280, video_duration_ms: 5000 };
const ROWS = [
  [/FROM generation_references gr/, () => [{ ...asset, record_id: R1 }, { ...asset, id: A2, status: 'deleted', record_id: R1 }]],
  [/FROM media_assets WHERE task_id=ANY/, () => [asset]],
  [/FROM generation_records g/, () => [{ id: R1, kind: 'image', model: 'm', prompt: 'p', params: { n: 1 }, status: 'succeeded', failure_code: null, points: '13.50000000', thread_id: TH,
    batch_id: B1, batch_position: 0, anchor_record_id: null, parent_record_id: null, source: 'studio', mentions: [], prompt_doc: null, request_id: id(12), task_id: T1,
    idempotency_key: 'q:' + id(11), created_at: now, updated_at: now, cursor_at }]],
  [/generation_threads/, () => [{ id: TH, title: '会话', created_at: now, updated_at: now, cursor_at }]],
  [/FROM composer_queues/, () => [{ items: [item], revision: 3 }]],
  [/SELECT id FROM media_assets WHERE id=ANY/, (args) => args[0].filter((x) => x === A1).map((x) => ({ id: x }))],
  [/FROM user_templates/, () => [{ id: TP, name: 'n', cover_id: A2, items: [{ ...item, reference_asset_ids: undefined, references: [{ slot: 0 }, { asset_id: A1 }] }],
    variables: [{ name: 'who', label: '谁', required: true }], created_at: now, updated_at: now, cursor_at }]],
  [/FROM subject_assets sa/, () => [{ ...asset, subject_id: S1 }]],
  [/FROM subjects/, () => [{ id: S1, name: '小猫', kind: 'person', note: null, cover_id: A1, created_at: now, updated_at: now, cursor_at }]],
  [/FROM favorites/, () => [{ target_type: 'asset', target_id: A1, created_at: now, cursor_at }]],
  [/FROM canvas_projects p/, () => [{ id: P1, title: '画布', revision: 2, thumb_id: A1, created_at: now, updated_at: now, cursor_at, document: { version: 1, nodes: [], edges: [], groups: [], viewport: { x: 0, y: 0, zoom: 1 } },
    thumb_key: asset.object_key, thumb_variants: asset.variants, thumb_width: 1, thumb_height: 1, thumb_source: 'upload', thumb_state: 'done', thumb_duration_ms: null, thumb_created_at: now }]],
  [/FROM asset_folders f/, () => [{ id: F1, name: '收藏', position: 1, count: 2, created_at: now }]],
  [/FROM inspiration_case_references/, () => [{ cover_id: A2, object_key: 'cases/y/orig.png', variants: { w480: 'cases/y/w480.webp' }, width: 5, height: 5 }]],
  [/GROUP BY category/, () => [{ category: 'poster', category_zh: '海报', count: 3 }]],
  [/FROM inspiration_cases c/, () => [caseRow, videoCaseRow]],
  [/count\(\*\)::int AS count/, () => [{ count: 0, bytes: '0' }]],
  [/FROM media_assets WHERE id=\$1 AND user_id=\$2 AND source=\$3/, () => [asset]],
  [/UPDATE media_assets SET status='deleted'/, () => [{ id: A1 }]],
  [/FROM media_assets/, () => [asset]],
  [/FROM user_roles/, () => [{ role: 'admin' }]],
  [/app_settings/, () => [{ value: 'on' }]],
  [/FROM lanehub_accounts/, () => [{ user_id: USER, secret_ref: 'x', key_id: 1 }]],
];
const db = {
  async query(sql, args = []) {
    const rows = ROWS.find(([re]) => re.test(sql))?.[1](args) ?? [];
    return { rows, rowCount: rows.length };
  },
  async tx(fn) { return fn(db); },
};
const desktopLatest = { version: '2.0.7', released_at: '2026-09-01T00:00:00.000Z',
  files: [{ platform: 'mac', name: 'IPZSK.Desktop-2.0.7-arm64.dmg', bytes: 187_000_000, sha256: 'b'.repeat(64) }] };
const storage = { presignGetSliced: (k) => 'https://r2.test/' + k, presignPut: () => 'https://r2.test/put', getUrl: (k) => 'https://r2.test/' + k,
  getRange: async () => Buffer.from(JSON.stringify(desktopLatest)) };
const catalog = { models: [{ id: 'gpt-image-2.5-flare', name: 'Flare', kind: 'image', billing: { unit: 'per_call', tiers: { '1K': 1 } },
  params: { registered: true, fields: [{ field: 'resolution', values: ['1K', '2K'] }, { field: 'image_urls' }, { field: 'duration', unsupported: '图片没有时长' }] } },
  { id: 'heygen-avatar-iii', name: 'Avatar III', kind: 'video', mode: 'avatar', inputs: { required: ['avatar_id'], one_of: ['script', 'audio_url'], max_length: { script: 5000 } },
    billing: { unit: 'per_minute_output' },
    params: { registered: true, passthrough: ['avatar_id', 'script'], fields: [{ field: 'aspect_ratio', values: ['16:9', '9:16'] }, { field: 'audio_url' },
      { field: 'background_color' }, { field: 'background_image_url' }, { field: 'captions' }, { field: 'resolution', values: ['720p', '1080p'] }, { field: 'voice_id' }] } }] };

const covered = new Set();
async function checker(app) {
  return async (route, url, { body, status = 200, shape } = {}) => {
    const method = route.split(' ')[0];
    const res = await app.inject({ method, url, payload: body, headers: { origin: 'https://api.ipzsk.com' } });
    assert.equal(res.statusCode, status, `${route} → ${res.body}`);
    const expected = shape ?? ROUTE_META[route].response;
    const errors = validate(parseShape(expected), res.body ? res.json() : undefined);
    assert.deepEqual(errors, [], `${route} does not match ${expected}`);
    covered.add(route);
    return res;
  };
}

test('real handler responses match contracts-schema', async () => {
  const upstream = { request: async (_channel, path, init) => path.startsWith('/v1/heygen/avatars')
    ? Response.json({ items: [{ id: 'Abigail_expressive_2024112501', name: 'Abigail', type: 'avatar', avatar_type: 'studio_avatar', gender: 'female', preview_image_url: 'https://h.test/a.jpg', engines: ['avatar_iv', 'avatar_iii'] }] })
    : path.startsWith('/v1/heygen/voices') ? Response.json({ items: [{ id: 'v1', name: '晓晓', language: 'Chinese', gender: 'female', preview_audio_url: 'https://h.test/v.mp3', support_pause: true, type: 'public' }] })
    : JSON.parse(init.body).model === 'bad'
    ? Response.json({ code: 'no_available_channel', message: '无线路' }, { status: 503 })
    : Response.json({ quote_id: 'q1', amount_cny: '0.13500000', expires_at: Math.floor(Date.now() / 1000) + 600 }) };
  const app = await createApp({ db, upstream, imageStorage: storage, scheduler: { keys: new Map(), accounts: new Map() }, origin: 'https://api.ipzsk.com',
    lanehub: { baseUrl: 'https://lane.test' }, lanehubCatalog: { data: catalog, media: () => mediaModelsFromCatalog(catalog) },
    customerAuth: { identify: async () => ({ id: USER, name: 'u', token_id: null, session_id: 's1', session_created_at: new Date().toISOString() }) } });
  const check = await checker(app);
  try {
    const models = (await check('GET /api/me/media/models', '/api/me/media/models')).json().models;
    assert.equal(models.find((m) => m.id === 'heygen-avatar-iii').avatar.engine, 'iii', 'avatar capability block exercised');
    await check('GET /api/me/avatars', '/api/me/avatars');
    assert.equal((await check('GET /api/me/voices', '/api/me/voices?language=Chinese&type=public')).json().items[0].preview_audio_url, 'https://h.test/v.mp3');
    const quote = await check('POST /api/me/media/quote', '/api/me/media/quote', { body: { items: [{ model: 'gpt-image-2.5-flare', prompt: 'p' }, { model: 'bad' }] } });
    assert.ok(quote.json().items[1].error, 'per-item quote error variant exercised');
    const gens = await check('GET /api/me/generations', '/api/me/generations');
    assert.ok(gens.json().items[0].references.some((a) => a.missing), 'MissingAsset variant exercised');
    await check('GET /api/me/generations/:id', `/api/me/generations/${R1}`);
    await check('GET /api/me/threads', '/api/me/threads');
    await check('POST /api/me/threads', '/api/me/threads', { body: { title: '会话' } });
    const queue = await check('GET /api/me/queue', '/api/me/queue');
    assert.equal(queue.json().items[0].missing, true);
    await check('PUT /api/me/queue', '/api/me/queue', { body: { items: [], revision: 1 }, status: 409, shape: 'QueueConflict' });
    const tpl = (await check('GET /api/me/templates', '/api/me/templates?limit=10')).json().items[0];
    assert.deepEqual(tpl.cover, { id: A2, status: 'deleted', missing: true }, 'template cover MissingAsset exercised');
    assert.equal(tpl.reference_assets[A1].urls.orig, `https://r2.test/u/${USER}/${A1}/orig.png`, 'template reference MediaAsset exercised');
    await check('GET /api/public/desktop-release', '/api/public/desktop-release');
    await check('GET /api/me/subjects', '/api/me/subjects');
    await check('GET /api/me/favorites', '/api/me/favorites');
    await check('PUT /api/me/favorites/:type/:id', `/api/me/favorites/asset/${A1}`, { status: 204 });
    await check('GET /api/me/assets', '/api/me/assets');
    await check('DELETE /api/me/assets/:id', `/api/me/assets/${A1}`, { status: 204 });
    await check('POST /api/me/uploads', '/api/me/uploads', { body: { kind: 'image', content_type: 'image/png', bytes: 10 } });
    await check('POST /api/me/uploads/:id/complete', `/api/me/uploads/${A1}/complete`, { body: {} });
    await check('GET /api/me/canvas', '/api/me/canvas');
    await check('GET /api/me/canvas/:id', `/api/me/canvas/${P1}`);
    await check('GET /api/me/folders', '/api/me/folders');
    await check('GET /api/public/cases', '/api/public/cases');
    await check('GET /api/public/cases/:id', '/api/public/cases/case-1');
    await check('GET /api/public/case-categories', '/api/public/case-categories');
    await check('GET /api/me/roles', '/api/me/roles');
    await check('GET /api/me/generations/:id', '/api/me/generations/not-a-uuid', { status: 404, shape: 'ApiErrorBody' });
  } finally { await app.close(); }
});

// ── 管理中台（假 db：第一条匹配的正则给出行） ──
const staffRow = { id: USER, email: 'a@x.com', name: '小猫' };
const adminCase = { ...caseRow, status: 'published', template: { items: [{ key: 'main', label: '主图', count: 1, params: { aspect_ratio: '1:1' }, anchor: true }] },
  source_repo: 'repo', license_note: 'MIT', created_at: now, updated_at: now };
const genRow = { id: R1, user_id: USER, user_email: 'a@x.com', kind: 'image', model: 'm', prompt: 'p'.repeat(300), params: { n: 1 }, status: 'failed', failure_code: 'media_task_failed',
  points: null, charged_points: null, source: 'studio', batch_id: null, batch_position: null, created_at: now, updated_at: now, cursor_at, request_id: id(12), task_id: T1,
  idempotency_key: 'q:1', upstream_id: 'lh-1', cost_text: null, error_code: null, cancel_age_ok: true, billing_state: 'released', upstream_task_id: 'task_1',
  task_status: 'failed', task_synced_at: now, task_error: 'boom https://r2.test/signed?x=1', provider_type: 'lanehub', thread_id: null, anchor_record_id: null,
  parent_record_id: null, source_case_id: 'case-1', deleted_at: now };
const ADMIN_ROWS = [
  [/SELECT role FROM user_roles WHERE user_id=\$1/, () => [{ role: 'admin' }]],
  [/AS rank/, () => [{ ...staffRow, email_verified: true, created_at: now, cursor_at, rank: 1, roles: ['admin'] }]],
  [/count\(\*\)::int AS n FROM inspiration_cases/, () => [{ n: 2 }]],
  [/FROM inspiration_case_references r JOIN/, () => [{ ...asset, id: A2, source: 'case', case_id: 'case-1' }]],
  [/GROUP BY category/, () => [{ category: 'poster', category_zh: '海报', count: 3 }]],
  [/FROM inspiration_cases/, () => [adminCase, { ...adminCase, id: 'case-2', status: 'draft', template: null }]],
  [/SELECT \* FROM media_assets WHERE id=ANY/, () => [{ ...asset, source: 'case' }]],
  [/FROM generation_references gr/, () => [asset, { ...asset, id: A2, status: 'deleted' }]],
  [/FROM media_assets WHERE task_id=\$1/, () => [{ ...asset, source: 'generation' }]],
  [/FROM generation_records g JOIN users u/, () => [genRow]],
  [/FROM users WHERE id=\$1/, () => [{ ...staffRow, email_verified: true, created_at: now, auth_user_id: 'auth-1' }]],
  [/auth_sessions/, () => [{ at: now }]],
  [/developer_profiles/, () => [{ state: 'approved' }]],
  [/credit-debit/, () => [{ balance_cny: '1.50000000', frozen_cny: '0.00000000', available_cny: '1.50000000' }]],
  [/FROM generation_records WHERE user_id=\$1/, () => [{ generations: 3, succeeded: 1, failed: 1, cancelled: 1, charged_points: '6.00000000', total: 9 }]],
  [/FROM media_assets\s+WHERE user_id=\$1/, () => [{ assets: 2, bytes: '1024' }]],
  [/SELECT DISTINCT u\.id/, () => [staffRow]],
  [/FROM user_roles r\s+LEFT JOIN users g/, () => [{ user_id: USER, role: 'admin', granted_at: now, by_id: null, by_email: null }, { user_id: USER, role: 'viewer', granted_at: now, by_id: USER, by_email: 'a@x.com' }]],
  [/FROM audit_events e/, () => [{ id: '7', action: 'case.status', actor_user_id: USER, actor_email: 'a@x.com', administrator_id: null, target_id: 'case-1', details: { from: 'draft', to: 'published' }, created_at: now },
    { id: '6', action: 'voucher.code.revoke', actor_user_id: null, actor_email: null, administrator_id: 1, target_id: null, details: null, created_at: now }]],
];
const adminDb = {
  async query(sql, args = []) {
    const rows = ADMIN_ROWS.find(([re]) => re.test(sql))?.[1](args) ?? [];
    return { rows, rowCount: rows.length };
  },
  async tx(fn) { return fn(adminDb); },
};

test('admin (B5) GET responses match contracts-schema', async () => {
  const app = await createApp({ db: adminDb, upstream: {}, imageStorage: storage, scheduler: { keys: new Map(), accounts: new Map() }, origin: 'https://api.ipzsk.com',
    customerAuth: { identify: async () => ({ id: USER, name: '小猫', email: 'a@x.com', token_id: null, session_id: 's1', session_created_at: new Date().toISOString() }) } });
  const check = await checker(app);
  try {
    await check('GET /api/admin/me', '/api/admin/me');
    const list = (await check('GET /api/admin/cases', '/api/admin/cases?status=published&limit=1')).json();
    assert.ok(list.next_cursor && list.items[0].references.length === 0);
    await check('GET /api/admin/case-categories', '/api/admin/case-categories');
    assert.equal((await check('GET /api/admin/cases/:id', '/api/admin/cases/case-1')).json().references.length, 1);
    await check('GET /api/admin/users', '/api/admin/users?q=a%40x.com');
    await check('GET /api/admin/users/:id', `/api/admin/users/${USER}`);
    await check('GET /api/admin/roles', '/api/admin/roles');
    assert.equal((await check('GET /api/admin/generations', '/api/admin/generations?status=failed,queued&from=2026-09-01&to=2026-09-17')).json().items[0].prompt.length, 200);
    const detail = (await check('GET /api/admin/generations/:id', `/api/admin/generations/${R1}`)).json();
    assert.doesNotMatch(detail.failure_message, /r2\.test/);
    await check('GET /api/admin/audit', '/api/admin/audit?action=case.*');
    await check('GET /api/admin/cases', '/api/admin/cases?limit=101', { status: 400, shape: 'ApiErrorBody' });
  } finally { await app.close(); }
});

test('ops (lanehub proxy) GET responses match contracts-schema', async () => {
  const ch = { id: 1, name: 'c', priority: 1, weight: 1, status: 1, type: 63, lanes: ['official'], vendor: 'V', vendor_icon: 'data:x', balance: 1, balance_updated_time: 1, balance_supported: true, balance_unit: 'USD',
    price: { source: 'row', cny: 0.2, unit: 'per_call' }, key: 'sk' };
  const replies = {
    '/api/lane_matrix': { lanes: [{ symbol: 'official', name: '官方', ratio: 1 }], auto_chain: ['official'], scenario: { resolution: '1080p', duration: 5 },
      rows: [{ model: 'm', vendors: ['V'], modalities: ['image'], channels: [ch], cells: { official: { channels: [ch] } } }] },
    '/api/channel/': { data: [{ ...ch, group: 'official', tag: '', models: 'm', used_quota: 1, created_time: 1 }], page: 1, size: 20, total_count: 1 },
    '/api/analytics/rpm': { rpm: 1, tpm: 2, cpm: 0.1, ppm: 0 },
    '/api/analytics/period': { channel_statistics: [{ Date: '2026-09-17', RequestCount: 1, Quota: 1, CostQuota: 1, PromptTokens: 1, CompletionTokens: 1, RequestTime: 5, Channel: 'm' }] },
    '/api/log/': { data: [{ id: 1, created_at: 1, type: 2, model_name: 'm', quota: 1, request_time: 1, channel: { id: 1, name: 'c' } }], page: 1, size: 20, total_count: 1 },
    '/api/log/stat': { quota: 1 },
  };
  const lanehub = { usdRate: async () => 7, call: async (path) => {
    const hit = replies[path.split('?')[0]];
    if (!hit) throw Object.assign(new Error('lanehub_api_failed'), { statusCode: 502, code: 'lanehub_api_failed', detail: 'boom' });
    return hit;
  } };
  const app = await createApp({ db: adminDb, upstream: {}, lanehub, lanehubUsdCny: 7, lanehubQuotaPerUnit: 500000, scheduler: { keys: new Map(), accounts: new Map() }, origin: 'https://api.ipzsk.com',
    customerAuth: { identify: async () => ({ id: USER, name: '小猫', email: 'a@x.com', token_id: null, session_id: 's1', session_created_at: new Date().toISOString() }) } });
  const check = await checker(app);
  try {
    await check('GET /api/admin/ops/lane-matrix', '/api/admin/ops/lane-matrix');
    await check('GET /api/admin/ops/channels', '/api/admin/ops/channels');
    await check('GET /api/admin/ops/dashboard/realtime', '/api/admin/ops/dashboard/realtime');
    await check('GET /api/admin/ops/dashboard/period', '/api/admin/ops/dashboard/period?start=1&end=2');
    await check('GET /api/admin/ops/logs', '/api/admin/ops/logs');
    await check('GET /api/admin/ops/logs/stat', '/api/admin/ops/logs/stat');
    const failed = await check('PUT /api/admin/ops/lane-matrix', '/api/admin/ops/lane-matrix', { body: { changes: [{ channel_id: 1, status: 2 }] }, status: 502, shape: 'ApiErrorBody' });
    assert.equal(failed.json().error.detail, 'boom');
  } finally { await app.close(); }
});

test('every GET in routeMeta is validated against a real handler response', () => {
  const uncoveredGets = Object.keys(ROUTE_META).filter((k) => k.startsWith('GET ') && !covered.has(k));
  assert.deepEqual(uncoveredGets, []);
});
