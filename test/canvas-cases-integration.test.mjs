import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, copyFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { database } from '../src/database.mjs';
import { createApp } from '../src/app.mjs';
import { createR2Storage } from '../src/r2-storage.mjs';
import { importCases } from '../src/cases.mjs';
import { syncImageArchives, backfillArchivedImages } from '../src/image-archive.mjs';
import { cleanupMedia } from '../src/uploads.mjs';
import { httpError } from '../src/security.mjs';

const fixture = (name) => readFileSync(new URL('./fixtures/' + name, import.meta.url));
const manifest = JSON.parse(fixture('cases.manifest.json'));

function fakeR2() {
  const objects = new Map(), calls = [];
  const fetcher = async (url, init) => {
    const key = decodeURIComponent(new URL(url).pathname.split('/').slice(2).join('/'));
    calls.push([init.method, key]);
    const obj = objects.get(key);
    if (init.method === 'PUT' && init.headers['x-amz-copy-source']) {
      const src = objects.get(decodeURIComponent(init.headers['x-amz-copy-source']).split('/').slice(2).join('/'));
      if (!src) return new Response(null, { status: 404 });
      objects.set(key, { body: src.body, type: init.headers['content-type'] ?? src.type, cache: init.headers['cache-control'] });
      return new Response('<CopyObjectResult/>', { status: 200 });
    }
    if (init.method === 'PUT') { objects.set(key, { body: Buffer.from(init.body ?? ''), type: init.headers['content-type'], cache: init.headers['cache-control'] }); return new Response(null, { status: 200 }); }
    if (init.method === 'DELETE') { objects.delete(key); return new Response(null, { status: 204 }); }
    if (init.method === 'GET') {
      if (!obj) return new Response(null, { status: 404 });
      const [, s, e] = init.headers.range.match(/bytes=(\d+)-(\d+)/);
      return new Response(obj.body.subarray(Number(s), Number(e) + 1), { status: 206 });
    }
    return new Response(null, { status: 400 });
  };
  const storage = createR2Storage({ accountId: 'a'.repeat(32), bucket: 'ipzsk-media', accessKeyId: 'AKIDTEST', secretAccessKey: 'secret-test', archiveFrom: '2026-01-01T00:00:00Z' }, fetcher);
  return { storage, objects, calls };
}

test('B4: canvas, folders, case import, public cases, favorites, backfill, video archive, cleanup', async (t) => {
  assert.ok(process.env.TEST_DB_HOST, 'Set TEST_DB_HOST explicitly; tests only use gateway_test database.');
  const schema = 'b4_' + randomUUID().replaceAll('-', '');
  const config = { host: process.env.TEST_DB_HOST, port: Number(process.env.TEST_DB_PORT ?? 5432), database: 'gateway_test', user: process.env.TEST_DB_USER ?? 'gateway', password: process.env.TEST_DB_PASSWORD };
  const setup = database(config);
  assert.equal((await setup.query('SELECT current_database() AS name')).rows[0].name, 'gateway_test');
  await setup.query(`CREATE SCHEMA ${schema}`);
  const db = database({ ...config, options: `-c search_path=${schema}` });
  const site = await mkdtemp(join(tmpdir(), 'ipzsk-cases-'));
  const r2 = fakeR2();
  const alice = randomUUID(), bob = randomUUID();
  let app;
  try {
    await db.migrate(); await db.migrate();
    assert.ok((await db.query('SELECT 1 FROM schema_version WHERE version=21')).rowCount);
    for (const id of [alice, bob]) await db.query('INSERT INTO users(id,name,email,email_verified,auth_user_id) VALUES($1,$2,$3,true,$4)', [id, 'fixture', id + '@example.com', 'auth-' + id]);
    const customerAuth = { async identify(headers) {
      const user = headers.cookie?.replace('fixture=', '');
      if (![alice, bob].includes(user)) throw httpError(401, 'customer_login_required');
      return { id: user, session_id: 'session-' + user, session_created_at: new Date().toISOString() };
    } };
    app = await createApp({ db, customerAuth, imageStorage: r2.storage, upstream: {}, scheduler: { keys: new Map(), accounts: new Map() }, origin: 'https://api.ipzsk.com' });
    const call = (user, method, url, payload) => app.inject({ url, method, payload, headers: { cookie: 'fixture=' + user, origin: 'https://www.ipzsk.com' } });
    const pub = (url, headers = {}) => app.inject({ url, method: 'GET', headers, remoteAddress: '203.0.113.9' });
    const asset = async (user, { kind = 'image', status = 'ready', source = 'upload' } = {}) => (await db.query(`INSERT INTO media_assets(user_id,kind,source,status,object_key,content_type,bytes,width,height)
      VALUES($1::uuid,$2,$3,$4,coalesce($1::text,'cases')||'/'||gen_random_uuid()||'/orig.png',$5,10,1,1) RETURNING id`,
    [user, kind, source, status, kind === 'image' ? 'image/png' : 'video/mp4'])).rows[0].id;

    // ── canvas ──
    const mine = await asset(alice), theirs = await asset(bob);
    const doc = (ids = []) => ({ version: 1, nodes: ids.map((id, i) => ({ id: 'n' + i, type: 'image', position: { x: i, y: 0 }, data: { asset: { id } } })),
      edges: [], groups: [], viewport: { x: 0, y: 0, zoom: 1 } });
    let project;
    await t.test('canvas CRUD, list without document, 409 conflict with latest, ownership 422/404', async () => {
      const created = await call(alice, 'POST', '/api/me/canvas', { title: '第一张', document: doc([mine]) });
      assert.equal(created.statusCode, 200, created.body);
      project = created.json();
      assert.equal(project.revision, 1); assert.deepEqual(project.document.nodes[0].data.asset.id, mine);
      const clientId = randomUUID();
      assert.equal((await call(alice, 'POST', '/api/me/canvas', { id: clientId, document: doc() })).json().title, '未命名画布');
      const list = (await call(alice, 'GET', '/api/me/canvas')).json();
      assert.equal(list.items.length, 2); assert.equal(list.items[0].document, undefined); assert.equal(list.next_cursor, null);

      const saved = await call(alice, 'PUT', `/api/me/canvas/${project.id}`, { document: doc([mine, mine]), revision: 1 });
      assert.equal(saved.statusCode, 200, saved.body); assert.equal(saved.json().revision, 2); assert.equal(saved.json().title, '第一张');
      const conflict = await call(alice, 'PUT', `/api/me/canvas/${project.id}`, { title: 'stale', document: doc(), revision: 1 });
      assert.equal(conflict.statusCode, 409);
      assert.equal(conflict.json().error.code, 'canvas_conflict');
      assert.equal(conflict.json().project.revision, 2); assert.equal(conflict.json().project.document.nodes.length, 2);

      const forbidden = await call(alice, 'PUT', `/api/me/canvas/${project.id}`, { document: doc([theirs]), revision: 2 });
      assert.equal(forbidden.statusCode, 422); assert.equal(forbidden.json().error.code, 'canvas_asset_forbidden');
      assert.equal((await call(alice, 'POST', '/api/me/canvas', { document: doc([randomUUID()]) })).statusCode, 422);
      assert.equal((await call(alice, 'POST', '/api/me/canvas', { document: { version: 1 } })).json().error.code, 'invalid_canvas_document');
      for (const [method, url, payload] of [['GET', `/api/me/canvas/${project.id}`], ['PUT', `/api/me/canvas/${project.id}`, { document: doc(), revision: 2 }],
        ['DELETE', `/api/me/canvas/${project.id}`], ['POST', `/api/me/canvas/${project.id}/thumb`, { asset_id: theirs }]]) {
        assert.equal((await call(bob, method, url, payload)).statusCode, 404, method + url);
      }
      assert.equal((await call(alice, 'POST', `/api/me/canvas/${project.id}/thumb`, { asset_id: theirs })).statusCode, 422);
      const thumbed = (await call(alice, 'POST', `/api/me/canvas/${project.id}/thumb`, { asset_id: mine })).json();
      assert.equal(thumbed.thumb_id, mine); assert.match(thumbed.thumb.urls.orig, /X-Amz-Signature=/);
      assert.equal((await call(alice, 'DELETE', `/api/me/canvas/${clientId}`)).statusCode, 204);
      assert.equal((await call(alice, 'GET', `/api/me/canvas/${clientId}`)).statusCode, 404);
      // Large body above the 1MB global limit is accepted for canvas.
      const big = doc(); big.nodes = [{ id: 't', type: 'text', data: { text: 'x'.repeat(1_500_000) } }];
      assert.equal((await call(alice, 'PUT', `/api/me/canvas/${project.id}`, { document: big, revision: 2 })).statusCode, 200);
    });

    // ── folders ──
    await t.test('folders: CRUD, append-only idempotent items, 422 for others, assets?folder=', async () => {
      const a2 = await asset(alice);
      const f = (await call(alice, 'POST', '/api/me/folders', { name: '参考' })).json();
      assert.deepEqual([f.name, f.count], ['参考', 0]);
      const dup = await call(alice, 'POST', '/api/me/folders', { name: '参考' });
      assert.equal(dup.statusCode, 409); assert.equal(dup.json().error.code, 'folder_name_taken');
      assert.equal((await call(bob, 'POST', '/api/me/folders', { name: '参考' })).statusCode, 200);
      assert.equal((await call(alice, 'POST', '/api/me/folders', { name: '' })).statusCode, 400);
      assert.deepEqual((await call(alice, 'PUT', `/api/me/folders/${f.id}/items`, { asset_ids: [mine] })).json(), { count: 1 });
      assert.deepEqual((await call(alice, 'PUT', `/api/me/folders/${f.id}/items`, { asset_ids: [mine, a2] })).json(), { count: 2 });
      const forbidden = await call(alice, 'PUT', `/api/me/folders/${f.id}/items`, { asset_ids: [a2, theirs] });
      assert.equal(forbidden.statusCode, 422); assert.equal(forbidden.json().error.code, 'asset_not_owned');
      assert.equal((await call(bob, 'PUT', `/api/me/folders/${f.id}/items`, { asset_ids: [theirs] })).statusCode, 404);
      assert.equal((await call(alice, 'PATCH', `/api/me/folders/${f.id}`, { name: '参考图', position: 0.5 })).json().position, 0.5);
      assert.equal((await call(bob, 'PATCH', `/api/me/folders/${f.id}`, { name: 'x' })).statusCode, 404);
      const inFolder = (await call(alice, 'GET', `/api/me/assets?folder=${f.id}`)).json().items.map((x) => x.id).sort();
      assert.deepEqual(inFolder, [mine, a2].sort());
      assert.equal((await call(bob, 'GET', `/api/me/assets?folder=${f.id}`)).statusCode, 404);
      assert.equal((await call(alice, 'DELETE', `/api/me/folders/${f.id}/items/${a2}`)).statusCode, 204);
      await db.query("UPDATE media_assets SET status='deleted' WHERE id=$1", [mine]);
      assert.equal((await call(alice, 'GET', '/api/me/folders')).json().items[0].count, 0, 'deleted assets not counted');
      await db.query("UPDATE media_assets SET status='ready' WHERE id=$1", [mine]);
      assert.equal((await call(bob, 'DELETE', `/api/me/folders/${f.id}`)).statusCode, 404);
      assert.equal((await call(alice, 'DELETE', `/api/me/folders/${f.id}`)).statusCode, 204);
      assert.equal((await db.query('SELECT status FROM media_assets WHERE id=$1', [a2])).rows[0].status, 'ready');
      assert.equal((await call(alice, 'GET', '/api/me/folders')).json().items.length, 0);
    });

    // ── import ──
    await mkdir(join(site, 'image-studio/assets'), { recursive: true });
    await copyFile(new URL('./fixtures/pixel.png', import.meta.url), join(site, 'image-studio/assets/fixture-a.png'));
    await copyFile(new URL('./fixtures/pixel.webp', import.meta.url), join(site, 'image-studio/assets/fixture-c.webp'));
    let remoteFetches = 0;
    const fetcher = async (url) => {
      remoteFetches++;
      assert.equal(String(url), 'https://img.cases.test/b.jpg');
      return remoteFetches === 1 ? new Response(null, { status: 503 }) : new Response(fixture('small.jpg'));
    };
    const quiet = () => {};
    await t.test('import: dry-run writes nothing; import with retry; dims + thumbs; second run no-ops', async () => {
      const lines = [];
      await importCases({ db, storage: r2.storage, manifest, imagesDir: site, dryRun: true, fetcher, log: (l) => lines.push(l) });
      assert.equal(lines.length, 3); assert.match(lines[0], /^create\t20000\t/);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM inspiration_cases')).rows[0].n, 0);
      const stats = await importCases({ db, storage: r2.storage, manifest, imagesDir: site, fetcher, log: quiet });
      assert.deepEqual(stats, { created: 3, updated: 0, unchanged: 0, image_uploaded: 3, video_uploaded: 0, failed: 0 });
      assert.equal(remoteFetches, 2, 'one retry after 503');
      const rows = (await db.query(`SELECT a.*,c.id,c.cover_id,c.status,c.position,c.template FROM inspiration_cases c JOIN media_assets a ON a.id=c.cover_id ORDER BY c.position`)).rows;
      assert.deepEqual(rows.map((r) => r.id), manifest.map((m) => m.id));
      for (const r of rows) {
        assert.equal(r.status, 'published'); assert.equal(r.user_id, null); assert.equal(r.source, 'case'); assert.equal(r.thumb_state, 'queued');
        assert.ok(r.width > 0 && r.height > 0); assert.match(r.object_key, new RegExp(`^cases/${r.cover_id}/orig\\.(png|jpg|webp)$`));
        assert.equal(r2.objects.get(r.object_key).cache, 'private, max-age=21600');
      }
      assert.equal(rows[1].template.items.length, manifest[1].template.items.length);
      const again = await importCases({ db, storage: r2.storage, manifest, imagesDir: site, fetcher, log: quiet });
      assert.deepEqual(again, { created: 0, updated: 0, unchanged: 3, image_uploaded: 0, video_uploaded: 0, failed: 0 });
      assert.equal(remoteFetches, 2, 'unchanged source → no fetch');
      // Metadata change only → update without re-upload; a hidden case stays hidden.
      await db.query("UPDATE inspiration_cases SET status='hidden' WHERE id=$1", [manifest[2].id]);
      const edited = manifest.map((m, i) => i === 2 ? { ...m, title: m.title + '（改）' } : m);
      assert.deepEqual(await importCases({ db, storage: r2.storage, manifest: edited, imagesDir: site, fetcher, log: quiet }),
        { created: 0, updated: 1, unchanged: 2, image_uploaded: 0, video_uploaded: 0, failed: 0 });
      assert.equal((await db.query('SELECT status FROM inspiration_cases WHERE id=$1', [manifest[2].id])).rows[0].status, 'hidden');
      await db.query("UPDATE inspiration_cases SET status='published' WHERE id=$1", [manifest[2].id]);
    });

    // ── public ──
    await t.test('public cases: list/filter/search/cursor/detail/categories, cache header, only published, CORS', async () => {
      const r = await pub('/api/public/cases');
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.headers['cache-control'], 'private, max-age=300');
      const items = r.json().items;
      assert.deepEqual(items.map((x) => x.id), manifest.map((m) => m.id));
      const first = items[0];
      assert.deepEqual(Object.keys(first).sort(), ['author', 'author_url', 'category', 'category_zh', 'id', 'image', 'kind', 'license_note', 'license_tier', 'model',
        'params', 'prompt', 'source_repo', 'source_url', 'tags', 'template', 'title', 'video'].sort());
      assert.equal(first.kind, 'image'); assert.equal(first.video, null); assert.equal(first.license_tier, null);
      assert.ok(first.image.width > 0); assert.match(first.image.urls.orig, /X-Amz-Signature=/); assert.equal(first.image.urls.w480, null);
      const paged = (await pub('/api/public/cases?limit=2')).json();
      assert.equal(paged.items.length, 2);
      assert.deepEqual((await pub('/api/public/cases?limit=2&cursor=' + paged.next_cursor)).json(), { items: [items[2]], next_cursor: null });
      assert.deepEqual((await pub('/api/public/cases?cat=posters')).json().items.map((x) => x.id), ['20000', '30002']);
      const word = manifest[1].title.slice(0, 2);
      assert.ok((await pub('/api/public/cases?q=' + encodeURIComponent(word))).json().items.some((x) => x.id === '543'));
      assert.deepEqual((await pub('/api/public/cases?q=' + encodeURIComponent(manifest[0].tags[0]))).json().items.map((x) => x.id).includes('20000'), true);
      assert.equal((await pub('/api/public/cases?q=%25%25nomatch')).json().items.length, 0);
      assert.equal((await pub('/api/public/cases?cursor=bad')).statusCode, 400);
      // multi-category: OR within cat, AND with q; cursor keeps the filter.
      assert.deepEqual((await pub('/api/public/cases?cat=posters,ecommerce')).json().items.map((x) => x.id), items.map((x) => x.id));
      assert.deepEqual((await pub('/api/public/cases?cat=posters&cat=ecommerce')).json().items.map((x) => x.id), items.map((x) => x.id));
      const mc = (await pub('/api/public/cases?cat=ecommerce,posters&limit=2')).json();
      assert.deepEqual(mc.items.map((x) => x.id), items.slice(0, 2).map((x) => x.id));
      assert.deepEqual((await pub('/api/public/cases?cat=ecommerce,posters&limit=2&cursor=' + mc.next_cursor)).json().items.map((x) => x.id), [items[2].id]);
      assert.deepEqual((await pub('/api/public/cases?cat=posters,nope&limit=1&cursor=' + encodeURIComponent((await pub('/api/public/cases?cat=posters,nope&limit=1')).json().next_cursor))).json().items.map((x) => x.id), ['30002']);
      assert.equal((await pub('/api/public/cases?cat=posters,ecommerce&q=%25%25nomatch')).json().items.length, 0);
      assert.deepEqual((await pub('/api/public/cases?cat=ecommerce&q=' + encodeURIComponent(manifest[1].title.slice(0, 2)))).json().items.map((x) => x.id), ['543']);
      const detail = (await pub('/api/public/cases/20000')).json();
      assert.equal(detail.id, '20000'); assert.deepEqual(detail.similar.map((x) => x.id)[0], '30002'); assert.deepEqual(detail.references, []);
      assert.deepEqual((await pub('/api/public/case-categories')).json().items, [
        { category: 'posters', category_zh: manifest[0].categoryZh, count: 2 }, { category: 'ecommerce', category_zh: manifest[1].categoryZh, count: 1 }]);
      await db.query("UPDATE inspiration_cases SET status='draft' WHERE id='30002'");
      assert.equal((await pub('/api/public/cases/30002')).statusCode, 404);
      assert.equal((await pub('/api/public/cases')).json().items.length, 2);
      assert.equal((await pub('/api/public/case-categories')).json().items[0].count, 1);
      const preflight = await app.inject({ method: 'OPTIONS', url: '/api/public/cases', headers: { origin: 'https://www.ipzsk.com', 'access-control-request-method': 'GET' } });
      assert.equal(preflight.statusCode, 204); assert.equal(preflight.headers['access-control-allow-origin'], 'https://www.ipzsk.com');
      assert.equal((await pub('/api/public/cases', { origin: 'https://www.ipzsk.com' })).headers['access-control-allow-origin'], 'https://www.ipzsk.com');
      // 120/min per IP.
      let last;
      for (let i = 0; i < 120; i++) last = await app.inject({ url: '/api/public/case-categories', remoteAddress: '198.51.100.7' });
      assert.equal(last.statusCode, 200);
      assert.equal((await app.inject({ url: '/api/public/case-categories', remoteAddress: '198.51.100.7' })).statusCode, 429);
    });

    await t.test('video / avatar cases: mp4 import (no cover → poster), draft status, kind filter, per-kind categories, similar within kind', async () => {
      let fetches = 0;
      const vfetch = async (url) => {
        fetches++;
        if (String(url) === 'https://v.cases.test/webm') return new Response(fixture('pixel.png')); // not an mp4
        assert.equal(String(url), 'https://v.cases.test/a.mp4');
        return new Response(fixture('faststart.mp4'));
      };
      const tag = manifest[0].tags[0]; // shared with an image case: similar must still stay within the kind
      const vm = [
        { id: 'v-1', kind: 'video', license_tier: 'B', title: '视频', prompt: 'p', category: 'film', tags: [tag], video: { url: 'https://v.cases.test/a.mp4' } },
        { id: 'v-2', kind: 'avatar', license_tier: 'A', title: '口播', prompt: 'p', category: 'ugc', video_url: 'https://v.cases.test/a.mp4',
          image: { url: '/image-studio/assets/fixture-a.png' } },
        { id: 'v-bad', kind: 'video', title: 'x', prompt: 'p', category: 'film', video_url: 'https://v.cases.test/webm' },
      ];
      const logs = [];
      const stats = await importCases({ db, storage: r2.storage, manifest: vm, imagesDir: site, fetcher: vfetch, log: (l) => logs.push(l), status: 'draft' });
      assert.deepEqual(stats, { created: 2, updated: 0, unchanged: 0, image_uploaded: 1, video_uploaded: 2, failed: 1 });
      assert.match(logs.join('\n'), /failed\tv-bad\tunsupported_video_type/);
      const rows = (await db.query(`SELECT c.*,v.kind AS vk,v.content_type AS vt,v.thumb_state AS vts,v.object_key AS vkey FROM inspiration_cases c
        JOIN media_assets v ON v.id=c.video_id WHERE c.id=ANY('{v-1,v-2}') ORDER BY c.id`)).rows;
      assert.deepEqual(rows.map((r) => [r.id, r.kind, r.status, r.license_tier, r.vk, r.vt, r.vts]),
        [['v-1', 'video', 'draft', 'B', 'video', 'video/mp4', 'queued'], ['v-2', 'avatar', 'draft', 'A', 'video', 'video/mp4', 'queued']]);
      assert.equal(rows[0].cover_id, rows[0].video_id, 'no own cover: the video is the cover');
      assert.notEqual(rows[1].cover_id, rows[1].video_id);
      assert.match(rows[0].vkey, /^cases\/[0-9a-f-]+\/orig\.mp4$/);
      const before = fetches;
      assert.deepEqual(await importCases({ db, storage: r2.storage, manifest: vm.slice(0, 2), imagesDir: site, fetcher: vfetch, log: quiet, status: 'draft' }),
        { created: 0, updated: 0, unchanged: 2, image_uploaded: 0, video_uploaded: 0, failed: 0 });
      assert.equal(fetches, before, 'unchanged video source → no fetch');

      assert.equal((await pub('/api/public/cases?kind=video')).json().items.length, 0, 'drafts are not public');
      await db.query(`UPDATE media_assets SET variants=$2 WHERE id=$1`, [rows[0].video_id, { poster: rows[0].vkey.replace('orig.mp4', 'poster.jpg') }]);
      await db.query("UPDATE inspiration_cases SET status='published' WHERE id=ANY('{v-1,v-2}')");
      assert.ok((await pub('/api/public/cases')).json().items.every((x) => x.kind === 'image'), 'default feed stays image-only');
      const [v1] = (await pub('/api/public/cases?kind=video')).json().items;
      assert.equal(v1.id, 'v-1'); assert.equal(v1.license_tier, 'B');
      assert.match(v1.video.urls.orig, /orig\.mp4.*X-Amz-Signature=/); assert.match(v1.video.urls.poster, /poster\.jpg/);
      assert.match(v1.image.urls.orig, /poster\.jpg/, 'poster stands in for the cover');
      assert.deepEqual((await pub('/api/public/cases?kind=avatar')).json().items.map((x) => x.id), ['v-2']);
      assert.equal((await pub('/api/public/cases?kind=gif')).statusCode, 400);
      assert.deepEqual((await pub('/api/public/case-categories?kind=video')).json().items, [{ category: 'film', category_zh: null, count: 1 }]);
      assert.ok(!(await pub('/api/public/case-categories')).json().items.some((c) => c.category === 'film'));
      assert.deepEqual((await pub('/api/public/cases/v-1')).json().similar, [], 'image cases sharing the tag are not similar to a video');
      await db.query("DELETE FROM inspiration_cases WHERE id=ANY('{v-1,v-2}')");
    });

    await t.test('public desktop-release: signed installer URLs from R2, CORS, 503 when the bucket has nothing', async () => {
      assert.equal((await pub('/api/public/desktop-release')).statusCode, 503, 'empty bucket');
      const release = { version: '2.0.7', released_at: '2026-09-01T00:00:00.000Z',
        files: [{ platform: 'mac', name: 'IPZSK.Desktop-2.0.7-arm64.dmg', bytes: 187_000_000, sha256: 'b'.repeat(64) }] };
      await r2.storage.put('desktop/2.0.7/manifest.json', Buffer.from(JSON.stringify(release)), 'application/json');
      await r2.storage.put('desktop/latest.json', Buffer.from(JSON.stringify(release)), 'application/json');
      const r = await pub('/api/public/desktop-release', { origin: 'https://www.ipzsk.com' });
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.headers['cache-control'], 'private, max-age=300');
      assert.equal(r.headers['access-control-allow-origin'], 'https://www.ipzsk.com');
      const [file] = r.json().files;
      assert.deepEqual({ ...r.json(), files: [{ ...file, url: undefined }] }, { ...release, files: [{ ...release.files[0], url: undefined }] });
      assert.match(file.url, /^https:\/\/\w+\.r2\.cloudflarestorage\.com\/ipzsk-media\/desktop\/2\.0\.7\/IPZSK\.Desktop-2\.0\.7-arm64\.dmg\?.*X-Amz-Signature=/);
      assert.equal((await pub('/api/public/desktop-release?version=2.0.7')).json().version, '2.0.7');
      assert.equal((await pub('/api/public/desktop-release?version=9.9.9')).statusCode, 503);
      assert.equal((await pub('/api/public/desktop-release?version=latest')).statusCode, 400);
    });

    await t.test('favorites: case must exist and be published', async () => {
      assert.equal((await call(alice, 'PUT', '/api/me/favorites/case/20000')).statusCode, 204);
      assert.equal((await call(alice, 'PUT', '/api/me/favorites/case/30002')).statusCode, 404, 'draft');
      assert.equal((await call(alice, 'PUT', '/api/me/favorites/case/nope')).statusCode, 404);
      assert.deepEqual((await call(alice, 'GET', '/api/me/favorites?type=case')).json().items.map(({ target_type, target_id }) => [target_type, target_id]), [['case', '20000']]);
    });

    // ── backfill ──
    const task = async (user, kind, result = null) => {
      const id = randomUUID();
      await db.query(`INSERT INTO requests(id,user_id,model,fingerprint,stream,status) VALUES($1,$2,'m','f',false,'succeeded')`, [id, user]);
      await db.query(`INSERT INTO media_tasks(id,upstream_task_id,kind,status,result) VALUES($1,$2,$3,'completed',$4)`, [id, 'up-' + id, kind, result && JSON.stringify(result)]);
      return id;
    };
    await t.test('backfill: copies with cache header + dims, links by task, resumable, old objects kept', async () => {
      const png = fixture('pixel.png'), jpg = fixture('small.jpg');
      const t1 = await task(alice, 'image'), t2 = await task(bob, 'image');
      const record = (await db.query(`INSERT INTO generation_records(user_id,kind,model,prompt,status,task_id) VALUES($1,'image','m','p','succeeded',$2) RETURNING id`, [alice, t1])).rows[0].id;
      const old = [[t1, 0, png, 'image/png', 'png'], [t1, 1, jpg, 'image/jpeg', 'jpg'], [t2, 0, png, 'image/png', 'png']];
      for (const [id] of [[t1], [t2]]) await db.query(`INSERT INTO image_archives(task_id,state) VALUES($1,'completed')`, [id]);
      for (const [id, index, body, type, ext] of old) {
        const key = `users/${id === t1 ? alice : bob}/imagegen/${id}/${index}-abc.${ext}`;
        r2.objects.set(key, { body, type });
        await db.query(`INSERT INTO archived_images(task_id,image_index,object_key,content_type,bytes,sha256) VALUES($1,$2,$3,$4,$5,$6)`, [id, index, key, type, body.length, 'a'.repeat(64)]);
      }
      const lines = [];
      assert.deepEqual(await backfillArchivedImages({ db, storage: r2.storage, dryRun: true, log: (l) => lines.push(l) }), { copied: 0, failed: 0, planned: 3 });
      assert.equal(lines.length, 3);
      assert.deepEqual(await backfillArchivedImages({ db, storage: r2.storage, limit: 1, log: quiet }), { copied: 1, failed: 0, planned: 0 });
      assert.deepEqual(await backfillArchivedImages({ db, storage: r2.storage, log: quiet }), { copied: 2, failed: 0, planned: 0 });
      assert.deepEqual(await backfillArchivedImages({ db, storage: r2.storage, log: quiet }), { copied: 0, failed: 0, planned: 0 });
      const assets = (await db.query(`SELECT * FROM media_assets WHERE task_id=ANY($1::uuid[]) ORDER BY task_id=$2 DESC,result_index`, [[t1, t2], t1])).rows;
      assert.equal(assets.length, 3);
      for (const a of assets) {
        assert.match(a.object_key, new RegExp(`^u/${a.user_id}/${a.id}/orig\\.(png|jpg)$`));
        assert.equal(a.source, 'generation'); assert.equal(a.thumb_state, 'queued'); assert.ok(a.width > 0 && a.height > 0);
        assert.equal(r2.objects.get(a.object_key).cache, 'private, max-age=21600');
      }
      for (const [id, index, , , ext] of old) assert.ok(r2.objects.has(`users/${id === t1 ? alice : bob}/imagegen/${id}/${index}-abc.${ext}`), 'old object kept');
      assert.deepEqual((await call(alice, 'GET', '/api/me/generations/' + record)).json().results.map((x) => x.id), assets.filter((a) => a.task_id === t1).map((a) => a.id));
    });

    await t.test('video archive: completed video task → video asset linked to record, poster job queued; not re-downloaded', async () => {
      const mp4 = fixture('faststart.mp4');
      const id = await task(alice, 'video', { id: 'x', status: 'completed', result: { videos: [{ url: ['https://video.test/a.mp4'] }] } });
      const record = (await db.query(`INSERT INTO generation_records(user_id,kind,model,prompt,status,task_id) VALUES($1,'video','seedance','p','succeeded',$2) RETURNING id`, [alice, id])).rows[0].id;
      let downloads = 0;
      const video = async (url) => { downloads++; assert.equal(url, 'https://video.test/a.mp4'); return { type: 'video/mp4', body: Readable.from([mp4]) }; };
      const noImage = async () => { throw new Error('unexpected image download'); };
      await syncImageArchives(db, r2.storage, noImage, video);
      const a = (await db.query('SELECT * FROM media_assets WHERE task_id=$1', [id])).rows[0];
      assert.deepEqual([a.kind, a.content_type, a.result_index, a.width, a.height, a.duration_ms, a.thumb_state], ['video', 'video/mp4', 0, 32, 18, 500, 'queued']);
      assert.equal(a.object_key, `u/${alice}/${a.id}/orig.mp4`); assert.equal(r2.objects.get(a.object_key).cache, 'private, max-age=21600');
      assert.equal((await db.query('SELECT state FROM image_archives WHERE task_id=$1', [id])).rows[0].state, 'completed');
      await syncImageArchives(db, r2.storage, noImage, video);
      assert.equal(downloads, 1);
      assert.equal((await call(alice, 'GET', '/api/me/generations/' + record)).json().results[0].id, a.id);
      // A non-mp4 payload fails and is retried later, no asset.
      const bad = await task(alice, 'video', { result: { videos: [{ url: 'https://video.test/b.mp4' }] } });
      await syncImageArchives(db, r2.storage, noImage, async () => ({ type: 'application/octet-stream', body: Readable.from([fixture('pixel.png')]) }));
      assert.equal((await db.query('SELECT attempts,state FROM image_archives WHERE task_id=$1', [bad])).rows[0].attempts, 1);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM media_assets WHERE task_id=$1', [bad])).rows[0].n, 0);
    });

    await t.test('cleanup keeps deleted assets referenced by cases, case references and canvas thumbs', async () => {
      const cover = (await db.query("SELECT cover_id FROM inspiration_cases WHERE id='20000'")).rows[0].cover_id;
      const ref = await asset(null, { source: 'case' }), plain = await asset(alice);
      await db.query("INSERT INTO inspiration_case_references(case_id,asset_id,position) VALUES('20000',$1,0)", [ref]);
      const thumb = (await db.query('SELECT thumb_id FROM canvas_projects WHERE id=$1', [project.id])).rows[0].thumb_id;
      const ids = [cover, ref, thumb, plain];
      await db.query("UPDATE media_assets SET status='deleted',deleted_at=now()-interval '40 days' WHERE id=ANY($1::uuid[])", [ids]);
      await cleanupMedia(db, r2.storage);
      assert.deepEqual((await db.query('SELECT id FROM media_assets WHERE id=ANY($1::uuid[])', [ids])).rows.map((r) => r.id).sort(), [cover, ref, thumb].sort());
    });
  } finally {
    await app?.close(); await db.close(); await setup.query(`DROP SCHEMA ${schema} CASCADE`); await setup.close();
    await rm(site, { recursive: true, force: true });
  }
});
