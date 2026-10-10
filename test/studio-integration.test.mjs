import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { database } from '../src/database.mjs';
import { createApp } from '../src/app.mjs';
import { Upstream } from '../src/upstream.mjs';
import { Scheduler } from '../src/scheduler.mjs';
import { Lanehub } from '../src/lanehub.mjs';
import { LanehubCatalog } from '../src/lanehub-catalog.mjs';
import { createR2Storage } from '../src/r2-storage.mjs';
import { refreshMediaTask } from '../src/media-task-sync.mjs';
import { syncImageArchives } from '../src/image-archive.mjs';
import { recordLanehubCharge } from '../src/lanehub-charges.mjs';
import { httpError } from '../src/security.mjs';

const LANE = 'https://lane.test';
const png = readFileSync(new URL('./fixtures/pixel.png', import.meta.url));
const catalog = { usd_cny: 6.7, models: [
  { id: 'gpt-image-2.5-flare', name: 'Flare', kind: 'image', billing: { type: 'times', unit: 'per_call', usd: 0.02 },
    params: { registered: true, fields: [{ field: 'aspect_ratio', values: ['1:1', '16:9'] }, { field: 'resolution', values: ['1K', '2K', '4K'] },
      { field: 'image_urls' }, { field: 'prompt' }, { field: 'duration', unsupported: '图片没有时长' }] } },
  { id: 'z-image-turbo', kind: 'image', billing: { unit: 'per_call' }, params: { registered: true, fields: [{ field: 'prompt' }, { field: 'resolution', values: ['1k'] }] } },
] };

function fakeR2() {
  const objects = new Map();
  const fetcher = async (url, init) => {
    const key = decodeURIComponent(new URL(url).pathname.split('/').slice(2).join('/'));
    if (init.method === 'PUT') { objects.set(key, { body: Buffer.from(init.body ?? ''), type: init.headers['content-type'] }); return new Response(null, { status: 200 }); }
    if (init.method === 'DELETE') { objects.delete(key); return new Response(null, { status: 204 }); }
    return new Response(null, { status: 404 });
  };
  // Clock ticks 1 s per signature so presigned URLs differ between requests, as in production.
  let ticks = 0;
  return { objects, storage: createR2Storage({ accountId: 'a'.repeat(32), bucket: 'ipzsk-media', accessKeyId: 'AKIDTEST', secretAccessKey: 'secret-test', archiveFrom: '2026-01-01T00:00:00Z' },
    fetcher, () => new Date(Date.now() + ticks++ * 1000)) };
}

test('studio: generation records, quote, threads, queue, templates, subjects, favorites', async (t) => {
  assert.ok(process.env.TEST_DB_HOST, 'Set TEST_DB_HOST explicitly; tests only use gateway_test database.');
  const schema = 'studio_' + randomUUID().replaceAll('-', '');
  const config = { host: process.env.TEST_DB_HOST, port: Number(process.env.TEST_DB_PORT ?? 5432), database: 'gateway_test', user: process.env.TEST_DB_USER ?? 'gateway', password: process.env.TEST_DB_PASSWORD };
  const setup = database(config);
  assert.equal((await setup.query('SELECT current_database() AS name')).rows[0].name, 'gateway_test');
  await setup.query(`CREATE SCHEMA ${schema}`);
  const db = database({ ...config, options: `-c search_path=${schema}` });
  const dir = await mkdtemp(join(tmpdir(), 'ipzsk-studio-'));

  // Fake lanehub: admin API, catalog, quote, relay and task polling. Records which token each relay call used.
  const users = new Map(), keys = new Map(), quotes = [], generations = [];
  let nextUser = 40, taskStatus = 'processing';
  const lanehubFetch = async (url, options = {}) => {
    const path = url.slice(LANE.length), body = options.body ? JSON.parse(options.body) : null;
    const token = options.headers?.Authorization?.slice(7);
    if (path.startsWith('/api/user/?keyword=')) {
      const name = new URL(url).searchParams.get('keyword');
      return Response.json({ success: true, data: { data: users.has(name) ? [{ id: users.get(name), username: name }] : [] } });
    }
    if (path === '/api/user/') { users.set(body.username, ++nextUser); return Response.json({ success: true }); }
    if (path === '/api/token/for_user') { const key = 'k' + randomUUID().replaceAll('-', ''); keys.set(key, body.user_id); return Response.json({ success: true, data: { key } }); }
    if (path.startsWith('/api/user/quota/')) return Response.json({ success: true });
    if (path === '/api/option/') return Response.json({ success: true, data: [{ key: 'PaymentUSDRate', value: '7' }] });
    if (path === '/api/catalog') return Response.json({ success: true, data: catalog });
    if (path.startsWith('/api/log/')) return Response.json({ success: true, data: { data: [{ type: 2, quota: 5000 }] } });
    if (path === '/v1/quote') {
      quotes.push({ token, body });
      if (body.model === 'z-image-turbo') return Response.json({ code: 'no_available_channel', message: '这一档下没有可用线路' }, { status: 503 });
      return Response.json({ quote_id: 'q_' + quotes.length, amount_cny: body.resolution === '4K' ? '0.54000000' : '0.13500000', amount_kind: 'exact',
        expires_at: Math.floor(Date.now() / 1000) + 600 });
    }
    if (path === '/v1/images/generations') {
      generations.push({ token, body });
      return Response.json({ code: 200, data: [{ status: 'submitted', task_id: 'up-' + generations.length }] }, { headers: { 'X-Oneapi-Request-Id': 'lane-' + generations.length } });
    }
    if (path.startsWith('/v1/tasks/')) {
      const id = decodeURIComponent(path.slice('/v1/tasks/'.length));
      return Response.json({ code: 200, data: { id, status: taskStatus, progress: 50, result: taskStatus === 'completed' ? { images: [{ url: ['https://img.test/' + id + '.png'] }] } : null } });
    }
    throw new Error('unexpected_lanehub_call ' + path);
  };
  const upstream = new Upstream(db, dir, lanehubFetch);
  const lanehub = new Lanehub({ baseUrl: LANE, adminToken: 'sk-admin', fetcher: lanehubFetch });
  const lanehubCatalog = new LanehubCatalog(lanehub, { log: () => {} });
  const r2 = fakeR2();
  const alice = randomUUID(), bob = randomUUID();
  let app;
  try {
    await db.migrate(); await db.migrate();
    assert.deepEqual((await db.query('SELECT version FROM schema_version WHERE version>=18 ORDER BY version')).rows.map((r) => r.version), [18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
    const accountId = randomUUID();
    await db.query(`INSERT INTO upstream_accounts (id,name,concurrency,base_url,provider_type) VALUES ($1,'lanehub',50,$2,'lanehub')`, [accountId, LANE]);
    await db.query(`INSERT INTO app_settings (key,value) VALUES ('lanehub_mode','on')`);
    for (const id of [alice, bob]) await db.query('INSERT INTO users(id,name,email,email_verified,auth_user_id) VALUES($1,$2,$3,true,$4)', [id, 'fixture', id + '@example.com', 'auth-' + id]);
    const customerAuth = { async identify(headers) {
      const user = headers.cookie?.replace('fixture=', '');
      if (![alice, bob].includes(user)) throw httpError(401, 'customer_login_required');
      return { id: user, name: 'fixture', session_id: 'session-' + user, token_id: null, session_created_at: new Date().toISOString() };
    } };
    app = await createApp({ db, upstream, customerAuth, imageStorage: r2.storage, scheduler: new Scheduler({ waitMs: 10 }), origin: 'https://api.ipzsk.com',
      lanehub, lanehubCatalog, lanehubAccountId: accountId, lanehubSignupCny: 0, lanehubUsdCny: 7, lanehubQuotaPerUnit: 500000 });
    const call = (user, method, url, payload, headers = {}) => app.inject({ url, method, payload, headers: { cookie: 'fixture=' + user, origin: 'https://www.ipzsk.com', ...headers } });
    const readyAsset = async (user, kind = 'image', status = 'ready') => (await db.query(`INSERT INTO media_assets(user_id,kind,source,status,object_key,content_type,bytes,width,height)
      VALUES($1::uuid,$2,'upload',$3,'u/'||$1::text||'/'||gen_random_uuid()||'/orig.png',$4,10,1,1) RETURNING id`, [user, kind, status, kind === 'image' ? 'image/png' : 'video/mp4'])).rows[0].id;
    const tokenOf = async (user) => (await upstream.secret((await db.query('SELECT k.secret_ref FROM lanehub_accounts a JOIN upstream_keys k ON k.id=a.key_id WHERE a.user_id=$1', [user])).rows[0].secret_ref));
    const count = async (sql, args) => (await db.query(sql, args)).rows[0].n;

    await t.test('models: 503 before catalog, then ModelSpec with case preserved', async () => {
      assert.equal((await call(alice, 'GET', '/api/me/media/models')).json().error.code, 'catalog_unavailable');
      await lanehubCatalog.refresh();
      const models = (await call(alice, 'GET', '/api/me/media/models')).json().models;
      const flare = models.find((m) => m.id === 'gpt-image-2.5-flare');
      assert.deepEqual(flare.params.find((p) => p.field === 'resolution').values, ['1K', '2K', '4K']);
      assert.equal(flare.references.maxImages, 15);
      assert.equal(models.find((m) => m.id === 'z-image-turbo').references.maxImages, 0);
    });

    const aliceRefs = [await readyAsset(alice), await readyAsset(alice)];
    await t.test('quote: provisions the user key first, uses it, caches, per-item errors, 60/min', async () => {
      const r = await call(alice, 'POST', '/api/me/media/quote', { items: [
        { model: 'gpt-image-2.5-flare', prompt: 'cat', resolution: '4K', reference_asset_ids: [aliceRefs[0]], batch_id: randomUUID() },
        { model: 'z-image-turbo', prompt: 'cat' },
        { model: 'gpt-image-2.5-flare', prompt: 'cat', reference_asset_ids: [randomUUID()] },
      ] });
      assert.equal(r.statusCode, 200, r.body);
      const [ok, noChannel, badRef] = r.json().items;
      assert.equal(ok.amount_cny, '0.54000000'); assert.equal(ok.points, '54.00000000'); assert.match(ok.quote_id, /^q_\d+$/);
      assert.ok(Date.parse(ok.expires_at) > Date.now());
      assert.deepEqual(noChannel.error, { code: 'no_available_channel', message: '这一档下没有可用线路' });
      assert.equal(badRef.error.code, 'reference_asset_not_found');
      const key = await tokenOf(alice);
      assert.ok(quotes.every((q) => q.token === key), 'quoted with the user\'s own lanehub key');
      const flareQuote = quotes.find((q) => q.body.resolution === '4K');
      assert.equal(flareQuote.body.batch_id, undefined, 'studio fields are not sent');
      assert.match(flareQuote.body.image_urls[0], /X-Amz-Expires=3600/);
      const before = quotes.length;
      const again = (await call(alice, 'POST', '/api/me/media/quote', { items: [{ model: 'gpt-image-2.5-flare', prompt: 'cat', resolution: '4K', reference_asset_ids: [aliceRefs[0]], batch_id: randomUUID() }] })).json();
      assert.equal(quotes.length - before, 1, 'batch_id differs → different fingerprint');
      await call(alice, 'POST', '/api/me/media/quote', { items: [{ model: 'gpt-image-2.5-flare', prompt: 'dog' }] });
      const n = quotes.length;
      assert.equal((await call(alice, 'POST', '/api/me/media/quote', { items: [{ prompt: 'dog', model: 'gpt-image-2.5-flare' }] })).json().items[0].points, '13.50000000');
      assert.equal(quotes.length, n, 'cache hit, no lanehub call');
      assert.ok(again.items[0].points);
      assert.equal((await call(bob, 'POST', '/api/me/media/quote', { items: [] })).statusCode, 400);
      for (let i = 0; i < 59; i++) await call(bob, 'POST', '/api/me/media/quote', { items: [{ prompt: 'dog', model: 'gpt-image-2.5-flare' }] });
      const limited = await call(bob, 'POST', '/api/me/media/quote', { items: [{ prompt: 'dog', model: 'gpt-image-2.5-flare' }] });
      assert.equal(limited.statusCode, 429); assert.equal(limited.json().error.code, 'rate_limited');
      await db.query("UPDATE app_settings SET value='off' WHERE key='lanehub_mode'");
      assert.equal((await call(alice, 'POST', '/api/me/media/quote', { items: [{ model: 'x' }] })).json().error.code, 'quote_requires_lanehub');
      await db.query("UPDATE app_settings SET value='on' WHERE key='lanehub_mode'");
    });

    const thread = (await call(alice, 'POST', '/api/me/threads', { title: '2026-09-17' })).json();
    const batch = randomUUID();
    let record;
    await t.test('generation with references: presigned URLs upstream, record + references in the request tx', async () => {
      const r = await call(alice, 'POST', '/api/me/images/generations', { model: 'gpt-image-2.5-flare', prompt: '@橘猫 宇航员', resolution: '2K',
        reference_asset_ids: aliceRefs, batch_id: batch, batch_position: 0, thread_id: thread.id,
        mentions: [{ type: 'reference', id: aliceRefs[0], name: '图1' }], prompt_doc: { type: 'doc', content: [] } }, { 'idempotency-key': 'q:' + randomUUID() });
      assert.equal(r.statusCode, 200, r.body);
      const sent = generations.at(-1);
      assert.equal(sent.token, await tokenOf(alice));
      assert.deepEqual(Object.keys(sent.body).sort(), ['image_urls', 'model', 'prompt', 'resolution']);
      assert.equal(sent.body.image_urls.length, 2);
      for (const url of sent.body.image_urls) {
        const u = new URL(url);
        assert.equal(u.searchParams.get('X-Amz-Expires'), '3600'); assert.ok(u.searchParams.get('X-Amz-Signature'));
        assert.match(u.pathname, new RegExp(`^/ipzsk-media/u/${alice}/`));
      }
      const taskId = r.json().data[0].task_id;
      record = (await db.query('SELECT * FROM generation_records WHERE request_id=$1', [taskId])).rows[0];
      assert.equal(record.task_id, taskId); assert.equal(record.status, 'queued'); assert.equal(record.thread_id, thread.id);
      assert.deepEqual(record.params, { resolution: '2K' });
      assert.deepEqual((await db.query('SELECT asset_id FROM generation_references WHERE record_id=$1 ORDER BY position', [record.id])).rows.map((x) => x.asset_id), aliceRefs);
      const list = (await call(alice, 'GET', `/api/me/generations?thread=${thread.id}`)).json();
      assert.equal(list.items.length, 1); assert.equal(list.next_cursor, null);
      const item = list.items[0];
      assert.equal(item.charged_points, null); assert.equal(item.batch_position, 0);
      assert.deepEqual(item.references.map((a) => a.id), aliceRefs); assert.match(item.references[0].urls.orig, /X-Amz-Expires=/);
      assert.deepEqual(item.results, []);
      assert.equal((await call(alice, 'GET', '/api/me/generations?idempotency_key=' + encodeURIComponent(item.idempotency_key))).json().items[0].id, item.id);
      assert.equal((await call(alice, 'GET', '/api/me/generations?status=active')).json().items.length, 1);
    });

    await t.test('rejected generations create no request and no record', async () => {
      const before = await count('SELECT count(*)::int AS n FROM requests');
      const records = await count('SELECT count(*)::int AS n FROM generation_records');
      const bobAsset = await readyAsset(bob), videoAsset = await readyAsset(alice, 'video'), pending = await readyAsset(alice, 'image', 'pending');
      const cases = [
        [{ reference_asset_ids: [bobAsset] }, 400, 'reference_asset_not_found'],
        [{ reference_asset_ids: [videoAsset] }, 400, 'reference_asset_not_found'],
        [{ reference_asset_ids: [pending] }, 400, 'reference_asset_not_found'],
        [{ reference_asset_ids: Array.from({ length: 16 }, randomUUID) }, 400, 'too_many_references'],
        [{ model: 'z-image-turbo', reference_asset_ids: [aliceRefs[0]] }, 400, 'too_many_references'],
        [{ thread_id: (await call(bob, 'POST', '/api/me/threads', {})).json().id }, 404, 'thread_not_found'],
        [{ batch_position: 12, batch_id: batch }, 400, 'invalid_batch_position'],
        [{ mentions: [{ type: 'x' }] }, 400, 'invalid_mentions'],
        [{ prompt_doc: { t: 'x'.repeat(50_001) } }, 400, 'invalid_prompt_doc'],
        [{ anchor_record_id: record.id }, 409, 'anchor_not_succeeded'],
        [{ anchor_record_id: randomUUID() }, 404, 'record_not_found'],
      ];
      for (const [extra, status, code] of cases) {
        const r = await call(alice, 'POST', '/api/me/images/generations', { model: 'gpt-image-2.5-flare', prompt: 'x', ...extra });
        assert.equal(r.statusCode, status, JSON.stringify(extra).slice(0, 80) + r.body); assert.equal(r.json().error.code, code);
      }
      assert.equal(await count('SELECT count(*)::int AS n FROM requests'), before);
      assert.equal(await count('SELECT count(*)::int AS n FROM generation_records'), records);
    });

    await t.test('sync updates status; archive links results and queues thumbnails; charge sets charged_points', async () => {
      await refreshMediaTask(db, upstream, record.task_id);
      assert.equal((await db.query('SELECT status FROM generation_records WHERE id=$1', [record.id])).rows[0].status, 'running');
      taskStatus = 'completed';
      await db.query("UPDATE media_tasks SET updated_at=now()-interval '1 minute' WHERE id=$1", [record.task_id]);
      await refreshMediaTask(db, upstream, record.task_id);
      assert.equal((await db.query('SELECT status FROM generation_records WHERE id=$1', [record.id])).rows[0].status, 'succeeded');
      await syncImageArchives(db, r2.storage, async () => ({ type: 'image/png', body: Readable.from([png]) }));
      const assets = (await db.query('SELECT * FROM media_assets WHERE task_id=$1', [record.task_id])).rows;
      assert.equal(assets.length, 1);
      assert.deepEqual([assets[0].source, assets[0].status, assets[0].result_index, assets[0].width, assets[0].thumb_state], ['generation', 'ready', 0, 1, 'queued']);
      assert.equal(assets[0].object_key, `u/${alice}/${assets[0].id}/orig.png`); assert.ok(r2.objects.has(assets[0].object_key));
      const item = (await call(alice, 'GET', '/api/me/generations/' + record.id)).json();
      assert.deepEqual(item.results.map((a) => [a.id, a.thumb_state]), [[assets[0].id, 'queued']]);
      const row = (await db.query(`SELECT r.id,r.user_id,r.model,r.upstream_id,r.completed_at,t.status AS task_status FROM requests r JOIN media_tasks t ON t.id=r.id WHERE r.id=$1`, [record.task_id])).rows[0];
      assert.equal(await recordLanehubCharge(db, lanehub, row, { usdCnyRate: 7, quotaPerUnit: 500000 }), 'settled');
      assert.equal((await db.query('SELECT charged_points FROM generation_records WHERE id=$1', [record.id])).rows[0].charged_points, '7.00000000', '5000/500000 × 7 元 × 100');
      assert.equal((await call(alice, 'GET', '/api/me/generations/' + record.id)).json().charged_points, '7.00000000');
    });

    await t.test('anchor succeeded → accepted; replay is 409 without a second record; bob sees 404', async () => {
      const key = 'q:' + randomUUID(), payload = { model: 'gpt-image-2.5-flare', prompt: 'detail', anchor_record_id: record.id, batch_id: batch, batch_position: 1 };
      assert.equal((await call(alice, 'POST', '/api/me/images/generations', payload, { 'idempotency-key': key })).statusCode, 200);
      const replay = await call(alice, 'POST', '/api/me/images/generations', payload, { 'idempotency-key': key });
      assert.equal(replay.statusCode, 409); assert.equal(replay.json().error.code, 'request_already_received');
      assert.equal(await count('SELECT count(*)::int AS n FROM generation_records WHERE batch_id=$1', [batch]), 2);
      // reference_asset_ids resolve to fresh presigned URLs each time; the fingerprint uses the client body, so replay still matches.
      const refKey = 'q:' + randomUUID(), refPayload = { model: 'gpt-image-2.5-flare', prompt: 'refs', reference_asset_ids: [aliceRefs[0], aliceRefs[1]] };
      assert.equal((await call(alice, 'POST', '/api/me/images/generations', refPayload, { 'idempotency-key': refKey })).statusCode, 200);
      const sent = generations.length;
      assert.equal((await call(alice, 'POST', '/api/me/images/generations', refPayload, { 'idempotency-key': refKey })).json().error.code, 'request_already_received');
      assert.equal((await call(alice, 'POST', '/api/me/images/generations', { ...refPayload, reference_asset_ids: [aliceRefs[1], aliceRefs[0]] }, { 'idempotency-key': refKey })).json().error.code, 'idempotency_conflict');
      assert.equal(generations.length, sent);
      assert.equal((await call(bob, 'GET', '/api/me/generations/' + record.id)).statusCode, 404);
      assert.equal((await call(bob, 'PATCH', '/api/me/generations/' + record.id, { thread_id: null })).statusCode, 404);
      assert.equal((await call(bob, 'DELETE', '/api/me/generations/' + record.id)).statusCode, 404);
      assert.equal((await call(bob, 'POST', '/api/me/images/generations', { ...payload, batch_id: undefined, batch_position: undefined })).json().error.code, 'record_not_found');
    });

    await t.test('too_many_active: the 25th active record is refused with no request row', async () => {
      await db.query(`INSERT INTO generation_records(user_id,kind,model,prompt,status) SELECT $1,'image','m','p','running' FROM generate_series(1,23)`, [bob]);
      assert.equal((await call(bob, 'POST', '/api/me/images/generations', { model: 'gpt-image-2.5-flare', prompt: 'ok' })).statusCode, 200);
      const before = await count('SELECT count(*)::int AS n FROM requests WHERE user_id=$1', [bob]);
      const r = await call(bob, 'POST', '/api/me/images/generations', { model: 'gpt-image-2.5-flare', prompt: 'too many' });
      assert.equal(r.statusCode, 429); assert.equal(r.json().error.code, 'too_many_active');
      assert.equal(await count('SELECT count(*)::int AS n FROM requests WHERE user_id=$1', [bob]), before);
      await db.query("UPDATE generation_records SET status='failed' WHERE user_id=$1", [bob]);
    });

    await t.test('generations: move thread, soft delete one and a batch', async () => {
      const other = (await call(alice, 'POST', '/api/me/threads', { title: 'other' })).json();
      assert.equal((await call(alice, 'PATCH', '/api/me/generations/' + record.id, { thread_id: other.id })).json().thread_id, other.id);
      assert.equal((await call(alice, 'PATCH', '/api/me/generations/' + record.id, { thread_id: randomUUID() })).statusCode, 404);
      assert.equal((await call(alice, 'DELETE', '/api/me/generations/' + record.id)).statusCode, 204);
      assert.equal((await call(alice, 'GET', '/api/me/generations/' + record.id)).statusCode, 404);
      assert.deepEqual((await call(alice, 'DELETE', '/api/me/generations?batch_id=' + batch)).json(), { deleted: 1 });
      assert.equal((await call(alice, 'GET', '/api/me/generations?batch_id=' + batch)).json().items.length, 0);
    });

    await t.test('threads CRUD with ownership', async () => {
      const id = randomUUID();
      assert.equal((await call(alice, 'POST', '/api/me/threads', { id, title: 'a' })).json().id, id);
      assert.equal((await call(alice, 'PATCH', `/api/me/threads/${id}`, { title: 'renamed' })).json().title, 'renamed');
      assert.equal((await call(bob, 'PATCH', `/api/me/threads/${id}`, { title: 'x' })).statusCode, 404);
      assert.equal((await call(bob, 'DELETE', `/api/me/threads/${id}`)).statusCode, 404);
      assert.equal((await call(alice, 'POST', '/api/me/threads', { title: 'x'.repeat(81) })).statusCode, 400);
      assert.ok((await call(alice, 'GET', '/api/me/threads')).json().items.some((x) => x.title === 'renamed'));
      assert.equal((await call(alice, 'DELETE', `/api/me/threads/${id}`)).statusCode, 204);
      assert.ok(!(await call(alice, 'GET', '/api/me/threads')).json().items.some((x) => x.id === id));
      assert.equal((await call(bob, 'GET', '/api/me/threads')).json().items.length, 1);
    });

    await t.test('queue: validation, revision conflict returns server copy, missing assets flagged', async () => {
      const a = randomUUID(), b = randomUUID();
      const items = [{ item_id: a, kind: 'image', model: 'gpt-image-2.5-flare', prompt: '主图', params: { aspect_ratio: '1:1', resolution: '2K' }, reference_asset_ids: [aliceRefs[1]] },
        { item_id: b, kind: 'image', model: 'gpt-image-2.5-flare', prompt: '详情', params: { aspect_ratio: '16:9' }, reference_asset_ids: [], anchor_of: a }];
      assert.deepEqual((await call(alice, 'GET', '/api/me/queue')).json(), { items: [], revision: 0 });
      const saved = await call(alice, 'PUT', '/api/me/queue', { items, revision: 0 });
      assert.equal(saved.statusCode, 200, saved.body); assert.equal(saved.json().revision, 1);
      const conflict = await call(alice, 'PUT', '/api/me/queue', { items: [], revision: 0 });
      assert.equal(conflict.statusCode, 409);
      assert.equal(conflict.json().error.code, 'queue_conflict'); assert.equal(conflict.json().queue.revision, 1); assert.equal(conflict.json().queue.items.length, 2);
      const bad = async (patch, code) => {
        const r = await call(alice, 'PUT', '/api/me/queue', { items: [{ ...items[0], ...patch }], revision: 1 });
        assert.equal(r.statusCode, 400, r.body); assert.equal(r.json().error.code, code); return r.json().error;
      };
      assert.deepEqual(await bad({ params: { resolution: '2k' } }, 'invalid_param_value'), { code: 'invalid_param_value', message: 'invalid_param_value', index: 0, field: 'resolution' });
      await bad({ params: { duration: 5 } }, 'unsupported_parameter_for_model');
      await bad({ model: 'nope' }, 'unknown_model');
      await bad({ kind: 'video' }, 'invalid_kind');
      await bad({ reference_asset_ids: [await readyAsset(bob)] }, 'reference_asset_not_found');
      await bad({ model: 'z-image-turbo', params: {} }, 'too_many_references');
      await bad({ anchor_of: randomUUID() }, 'invalid_anchor');
      assert.equal((await call(alice, 'PUT', '/api/me/queue', { items: Array.from({ length: 13 }, () => ({ ...items[0], item_id: randomUUID() })), revision: 1 })).json().error.code, 'invalid_items');
      await db.query("UPDATE media_assets SET status='deleted',deleted_at=now() WHERE id=$1", [aliceRefs[1]]);
      const got = (await call(alice, 'GET', '/api/me/queue')).json();
      assert.equal(got.items[0].missing, true); assert.equal(got.items[1].missing, undefined);
      assert.equal((await call(bob, 'GET', '/api/me/queue')).json().revision, 0, 'per user');
      assert.equal((await call(alice, 'PUT', '/api/me/queue', { items: [items[1]].map(({ anchor_of, ...x }) => x), revision: 1 })).json().revision, 2);
    });

    await t.test('templates CRUD: variables, slot/asset references, cover ownership', async () => {
      const item = { item_id: randomUUID(), kind: 'image', model: 'gpt-image-2.5-flare', prompt: '{{主体:商品}} 主图', params: { aspect_ratio: '1:1' },
        references: [{ slot: 0 }, { asset_id: aliceRefs[0] }] };
      const body = { name: '电商套图', items: [item], variables: [{ name: '商品', label: '商品', required: true }], cover_id: aliceRefs[0] };
      const created = await call(alice, 'POST', '/api/me/templates', body);
      assert.equal(created.statusCode, 200, created.body);
      const id = created.json().id;
      assert.equal((await call(alice, 'POST', '/api/me/templates', { ...body, items: [] })).json().error.code, 'invalid_items');
      assert.equal((await call(alice, 'POST', '/api/me/templates', { ...body, cover_id: await readyAsset(bob) })).json().error.code, 'invalid_cover');
      assert.equal((await call(alice, 'POST', '/api/me/templates', { ...body, variables: [{ name: 'a b', label: 'x', required: true }] })).json().error.code, 'invalid_variables');
      assert.equal((await call(alice, 'POST', '/api/me/templates', { ...body, items: [{ ...item, references: [{ slot: 15 }] }] })).json().error.code, 'invalid_reference');
      assert.equal((await call(alice, 'PATCH', `/api/me/templates/${id}`, { name: '改名' })).json().name, '改名');
      assert.equal((await call(bob, 'PATCH', `/api/me/templates/${id}`, { name: 'x' })).statusCode, 404);
      assert.equal((await call(bob, 'DELETE', `/api/me/templates/${id}`)).statusCode, 404);
      assert.equal((await call(bob, 'GET', '/api/me/templates')).json().items.length, 0);
      assert.equal((await call(alice, 'GET', '/api/me/templates')).json().items[0].items[0].references[0].slot, 0);
      assert.equal((await call(alice, 'DELETE', `/api/me/templates/${id}`)).statusCode, 204);
      assert.equal((await call(alice, 'GET', '/api/me/templates')).json().items.length, 0);
    });

    await t.test('templates: cover / reference_assets resolved per owner, cursor pagination', async () => {
      const [ref, gone, cov] = [await readyAsset(alice), await readyAsset(alice), await readyAsset(alice)];
      const item = (refs) => ({ item_id: randomUUID(), kind: 'image', model: 'gpt-image-2.5-flare', prompt: 'p', references: refs });
      const created = (await call(alice, 'POST', '/api/me/templates', { name: '封面', cover_id: cov, items: [item([{ slot: 0 }, { asset_id: ref }, { asset_id: gone }])] })).json();
      assert.equal(created.cover.id, cov); assert.match(created.cover.urls.orig, /^https:\/\//);
      assert.deepEqual(Object.keys(created.reference_assets).sort(), [ref, gone].sort());
      assert.ok(created.reference_assets[ref].urls.orig);
      assert.equal((await call(alice, 'PATCH', `/api/me/templates/${created.id}`, { cover_id: null })).json().cover, null);
      await call(alice, 'PATCH', `/api/me/templates/${created.id}`, { cover_id: cov });
      await db.query("UPDATE media_assets SET status='deleted',deleted_at=now() WHERE id=ANY($1::uuid[])", [[cov, gone]]);
      const listed = (await call(alice, 'GET', '/api/me/templates')).json().items.find((x) => x.id === created.id);
      assert.deepEqual(listed.cover, { id: cov, status: 'deleted', missing: true });
      assert.deepEqual(listed.reference_assets[gone], { id: gone, status: 'deleted', missing: true });
      assert.equal(listed.reference_assets[ref].status, 'ready');
      // Another user's asset smuggled into stored items (bypassing validation) is never resolved.
      const bobAsset = await readyAsset(bob);
      await db.query('UPDATE user_templates SET cover_id=$2,items=$3 WHERE id=$1', [created.id, bobAsset, JSON.stringify([item([{ asset_id: bobAsset }])])]);
      const leaked = (await call(alice, 'GET', '/api/me/templates')).json().items.find((x) => x.id === created.id);
      assert.deepEqual(leaked.cover, { id: bobAsset, status: 'deleted', missing: true });
      assert.deepEqual(leaked.reference_assets[bobAsset], { id: bobAsset, status: 'deleted', missing: true });
      // Pagination: updated_at desc, limit ≤ 50.
      for (let i = 0; i < 4; i++) await call(alice, 'POST', '/api/me/templates', { name: 'p' + i, items: [item([])] });
      const seen = [];
      let cursor, pages = 0;
      do {
        const page = (await call(alice, 'GET', '/api/me/templates?limit=2' + (cursor ? '&cursor=' + cursor : ''))).json();
        assert.ok(page.items.length <= 2); seen.push(...page.items); cursor = page.next_cursor; pages++;
      } while (cursor);
      assert.equal(seen.length, 5); assert.equal(pages, 3);
      assert.deepEqual(seen.map((x) => x.updated_at), seen.map((x) => x.updated_at).sort().reverse());
      assert.equal(seen[0].name, 'p3');
      assert.equal((await call(alice, 'GET', '/api/me/templates?limit=51')).json().error.code, 'invalid_limit');
      assert.equal((await call(alice, 'GET', '/api/me/templates')).json().items.length, 5);
    });

    await t.test('subjects: assets 1–8 ordered, cover rules, case-insensitive unique name, ownership', async () => {
      const imgs = [await readyAsset(alice), await readyAsset(alice), await readyAsset(alice)];
      const created = await call(alice, 'POST', '/api/me/subjects', { name: 'Orange', kind: 'character', asset_ids: imgs.slice(0, 2) });
      assert.equal(created.statusCode, 200, created.body);
      const s = created.json();
      assert.equal(s.cover_id, imgs[0]); assert.deepEqual(s.assets.map((a) => a.id), imgs.slice(0, 2)); assert.match(s.cover.urls.orig, /X-Amz-Expires=/);
      const dup = await call(alice, 'POST', '/api/me/subjects', { name: 'orange' });
      assert.equal(dup.statusCode, 409); assert.equal(dup.json().error.code, 'subject_name_taken');
      assert.equal((await call(bob, 'POST', '/api/me/subjects', { name: 'orange' })).statusCode, 200, 'unique per user only');
      const put = (payload) => call(alice, 'PUT', `/api/me/subjects/${s.id}/assets`, payload);
      let r = await put({ asset_ids: [imgs[2], imgs[1]], cover_id: imgs[1] });
      assert.deepEqual([r.json().assets.map((a) => a.id), r.json().cover_id], [[imgs[2], imgs[1]], imgs[1]]);
      r = await put({ asset_ids: [imgs[0], imgs[2]] });
      assert.equal(r.json().cover_id, imgs[0], 'old cover gone → first');
      r = await put({ asset_ids: [imgs[2], imgs[0]] });
      assert.equal(r.json().cover_id, imgs[0], 'cover still present → kept');
      assert.equal((await put({ asset_ids: [imgs[2]], cover_id: imgs[1] })).json().error.code, 'invalid_cover');
      assert.equal((await put({ asset_ids: [] })).json().error.code, 'invalid_asset_ids');
      assert.equal((await put({ asset_ids: Array.from({ length: 9 }, randomUUID) })).json().error.code, 'invalid_asset_ids');
      assert.equal((await put({ asset_ids: [await readyAsset(bob)] })).json().error.code, 'reference_asset_not_found');
      assert.equal((await put({ asset_ids: [await readyAsset(alice, 'video')] })).json().error.code, 'reference_asset_not_found');
      assert.equal((await call(bob, 'PUT', `/api/me/subjects/${s.id}/assets`, { asset_ids: [imgs[0]] })).statusCode, 404);
      assert.equal((await call(alice, 'PATCH', `/api/me/subjects/${s.id}`, { note: '备注', cover_id: imgs[2] })).json().cover_id, imgs[2]);
      assert.equal((await call(alice, 'PATCH', `/api/me/subjects/${s.id}`, { cover_id: imgs[1] })).json().error.code, 'invalid_cover');
      assert.equal((await call(alice, 'GET', '/api/me/subjects')).json().items[0].assets.length, 2);
      assert.equal((await call(bob, 'DELETE', `/api/me/subjects/${s.id}`)).statusCode, 404);
      assert.equal((await call(alice, 'DELETE', `/api/me/subjects/${s.id}`)).statusCode, 204);
      assert.equal((await call(alice, 'POST', '/api/me/subjects', { name: 'ORANGE' })).statusCode, 200, 'name reusable after delete');
    });

    await t.test('favorites: idempotent PUT/DELETE, ownership, type filter', async () => {
      const mine = aliceRefs[0];
      const cover = (await db.query(`INSERT INTO media_assets(kind,source,status,object_key,content_type,bytes) VALUES('image','case','ready','cases/'||gen_random_uuid()||'/orig.png','image/png',10) RETURNING id`)).rows[0].id;
      await db.query(`INSERT INTO inspiration_cases(id,title,prompt,category,cover_id,status) VALUES('case_001','t','p','posters',$1,'published')`, [cover]);
      assert.equal((await call(alice, 'PUT', `/api/me/favorites/asset/${mine}`)).statusCode, 204);
      assert.equal((await call(alice, 'PUT', `/api/me/favorites/asset/${mine}`)).statusCode, 204);
      assert.equal((await call(alice, 'PUT', '/api/me/favorites/case/case_001')).statusCode, 204);
      assert.equal((await call(bob, 'PUT', `/api/me/favorites/asset/${mine}`)).statusCode, 404);
      assert.equal((await call(alice, 'PUT', `/api/me/favorites/user/${mine}`)).statusCode, 400);
      assert.equal((await call(alice, 'GET', '/api/me/favorites')).json().items.length, 2);
      assert.deepEqual((await call(alice, 'GET', '/api/me/favorites?type=case')).json().items.map((x) => x.target_id), ['case_001']);
      assert.equal((await call(alice, 'DELETE', '/api/me/favorites/case/case_001')).statusCode, 204);
      assert.equal((await call(alice, 'DELETE', '/api/me/favorites/case/case_001')).statusCode, 204);
      assert.equal((await call(bob, 'GET', '/api/me/favorites')).json().items.length, 0);
    });

    await t.test('studio APIs require a cookie session', async () => {
      const r = await app.inject({ url: '/api/me/threads', method: 'GET', headers: {} });
      assert.equal(r.statusCode, 401);
    });
  } finally {
    await app?.close(); await db.close(); await setup.query(`DROP SCHEMA ${schema} CASCADE`); await setup.close();
    await rm(dir, { recursive: true, force: true });
  }
});
