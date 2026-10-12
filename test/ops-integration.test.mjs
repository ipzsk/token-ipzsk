// Operational hardening against gateway_test: thumbnail priority/drain, archive give-up, legacy /api/me/images URLs,
// /healthz/details, Bearer /v1/quote passthrough, avatar list warm-up. Fakes only (R2, lanehub, ffmpeg).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { database } from '../src/database.mjs';
import { createApp } from '../src/app.mjs';
import { Upstream } from '../src/upstream.mjs';
import { Scheduler } from '../src/scheduler.mjs';
import { Lanehub } from '../src/lanehub.mjs';
import { LanehubCatalog } from '../src/lanehub-catalog.mjs';
import { createR2Storage } from '../src/r2-storage.mjs';
import { runThumbJobs, drainThumbJobs } from '../src/media-thumbs.mjs';
import { syncImageArchives } from '../src/image-archive.mjs';
import { warmAvatarLists } from '../src/studio.mjs';
import { hash, httpError, token as newToken } from '../src/security.mjs';

const LANE = 'https://lane.test';
const webp = (w, h) => { const b = Buffer.alloc(30); b.write('RIFF', 0); b.write('WEBP', 8); b.write('VP8X', 12); b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3); return b; };
const fakeSpawn = (bin, argv, { stdio }) => {
  const child = new EventEmitter();
  child.stdio = stdio.map(m => m === 'pipe' ? new PassThrough() : null); child.stderr = child.stdio[2]; child.kill = () => {};
  setImmediate(() => {
    if (argv.includes('-show_streams')) child.stdio[1].end(JSON.stringify({ streams: [{ codec_type: 'video', width: 2000, height: 1000 }], format: {} }));
    else { child.stdio[1].end(webp(480, 240)); child.stdio[3].end(webp(960, 480)); }
    setImmediate(() => child.emit('close', 0, null));
  });
  return child;
};

test('ops hardening against gateway_test', async (t) => {
  assert.ok(process.env.TEST_DB_HOST, 'Set TEST_DB_HOST explicitly; tests only use gateway_test database.');
  const schema = 'ops_' + randomUUID().replaceAll('-', '');
  const config = { host: process.env.TEST_DB_HOST, port: Number(process.env.TEST_DB_PORT ?? 5432), database: 'gateway_test', user: process.env.TEST_DB_USER ?? 'gateway', password: process.env.TEST_DB_PASSWORD };
  const setup = database(config);
  assert.equal((await setup.query('SELECT current_database() AS name')).rows[0].name, 'gateway_test');
  await setup.query(`CREATE SCHEMA ${schema}`);
  const db = database({ ...config, options: `-c search_path=${schema}` });
  const dir = await mkdtemp(join(tmpdir(), 'ipzsk-ops-'));

  const r2objects = new Map();
  const storage = createR2Storage({ accountId: 'a'.repeat(32), bucket: 'ipzsk-media', accessKeyId: 'AKIDTEST', secretAccessKey: 'secret-test', archiveFrom: '2026-01-01T00:00:00Z' },
    async (url, init) => { if (init.method === 'PUT') r2objects.set(new URL(url).pathname, init.body); return new Response(null, { status: 200 }); });

  let catalog = { models: [
    { id: 'heygen-avatar', name: 'Avatar IV', kind: 'video', mode: 'avatar', inputs: { required: ['avatar_id'], one_of: ['script', 'audio_url'] }, billing: { unit: 'per_minute_output' },
      params: { registered: true, passthrough: ['avatar_id', 'script'], fields: [{ field: 'voice_id' }] } },
  ] };
  const lanehubCalls = [], users = new Map();
  let nextUser = 10, quoteReply = null;
  const lanehubFetch = async (url, options = {}) => {
    const path = url.slice(LANE.length), body = options.body ? JSON.parse(options.body) : null;
    lanehubCalls.push({ path, body, auth: options.headers?.Authorization });
    if (path.startsWith('/api/user/?keyword=')) {
      const name = new URL(url).searchParams.get('keyword');
      return Response.json({ success: true, data: { data: users.has(name) ? [{ id: users.get(name), username: name }] : [] } });
    }
    if (path === '/api/user/') { users.set(body.username, ++nextUser); return Response.json({ success: true }); }
    if (path === '/api/token/for_user') return Response.json({ success: true, data: { key: 'sk-customer-' + randomUUID() } });
    if (path === '/api/catalog') return Response.json({ success: true, data: catalog });
    if (path === '/v1/quote') return quoteReply ?? Response.json({ quote_id: 'q1', amount_cny: '1.23000000', amount_kind: 'estimate', expires_at: 1900000000, estimated_seconds: 60 });
    if (path === '/v1/heygen/avatars') return Response.json({ items: [{ id: 'Iv_Only', name: 'IV only', engines: ['avatar_iv'] }] });
    throw new Error('unexpected_lanehub_call ' + path);
  };
  const upstream = new Upstream(db, dir, lanehubFetch);
  const lanehub = new Lanehub({ baseUrl: LANE, adminToken: 'sk-admin', fetcher: lanehubFetch });
  const lanehubCatalog = new LanehubCatalog(lanehub, { log: () => {} });
  const alice = randomUUID(), bob = randomUUID();
  let app;
  try {
    await db.migrate(); await db.migrate();
    assert.equal((await db.query('SELECT max(version) AS v FROM schema_version')).rows[0].v, 31);
    const accountId = randomUUID();
    await db.query(`INSERT INTO upstream_accounts (id,name,concurrency,base_url,provider_type) VALUES ($1,'lanehub',50,$2,'lanehub')`, [accountId, LANE]);
    for (const id of [alice, bob]) await db.query('INSERT INTO users(id,name,email,email_verified,auth_user_id) VALUES($1,$2,$3,true,$4)', [id, 'fixture', id + '@example.com', 'auth-' + id]);
    const customerAuth = { async identify(headers) {
      const user = headers.cookie?.replace('fixture=', '');
      if (![alice, bob].includes(user)) throw httpError(401, 'customer_login_required');
      return { id: user, name: 'fixture', session_id: 'session-' + user, token_id: null, session_created_at: new Date().toISOString() };
    } };
    const options = { db, upstream, customerAuth, imageStorage: storage, scheduler: new Scheduler({ waitMs: 10 }), origin: 'https://api.ipzsk.com',
      lanehub, lanehubCatalog, lanehubAccountId: accountId, lanehubSignupCny: 0, lanehubUsdCny: 7, lanehubQuotaPerUnit: 500000, healthToken: 'h'.repeat(40) };
    app = await createApp(options);
    await lanehubCatalog.refresh();
    const call = (user, method, url, payload) => app.inject({ url, method, payload, headers: { cookie: 'fixture=' + user, origin: 'https://www.ipzsk.com' } });
    const insertAsset = async (source, nextAt, key = randomUUID()) => (await db.query(`INSERT INTO media_assets(user_id,kind,source,status,object_key,content_type,bytes,thumb_state,thumb_next_at)
      VALUES($1,'image',$2,'ready',$3,'image/png',10,'queued',$4) RETURNING id`, [alice, source, `u/${alice}/${key}/orig.png`, nextAt])).rows[0].id;
    const request = async (user, createdAt) => {
      const id = randomUUID();
      await db.query(`INSERT INTO requests(id,user_id,model,fingerprint,stream,created_at) VALUES($1,$2,'gpt-image-2','f',false,$3)`, [id, user, createdAt]);
      await db.query(`INSERT INTO media_tasks(id,upstream_task_id,kind,status,result) VALUES($1::uuid,$3,'image','completed',$2)`,
        [id, { id, status: 'completed', result: { images: [{ url: ['https://expired.example/x.png'] }] } }, 'up-' + id]);
      return id;
    };

    await t.test('thumbnails: user jobs before case backfill (THUMB_PRIORITY), FIFO when off, drain empties the queue', async () => {
      const old = new Date(Date.now() - 3600_000).toISOString(), recent = new Date(Date.now() - 1000).toISOString();
      const caseA = await insertAsset('case', old), upload = await insertAsset('upload', recent), generation = await insertAsset('generation', recent);
      const thumbs = (over) => runThumbJobs({ db, r2: storage, spawn: fakeSpawn, format: 'webp', nice: null, ...over });
      assert.equal(await thumbs(), upload, 'older case job waits behind a newer upload');
      assert.equal(await thumbs(), generation);
      const caseB = await insertAsset('case', old), user2 = await insertAsset('upload', recent);
      assert.equal(await thumbs({ priority: false }), caseA, 'THUMB_PRIORITY=0: oldest due first');
      assert.equal(await drainThumbJobs({ db, r2: storage, spawn: fakeSpawn, format: 'webp', nice: null }), 2);
      const states = (await db.query('SELECT id,thumb_state FROM media_assets WHERE id=ANY($1::uuid[])', [[caseB, user2]])).rows;
      assert.deepEqual(states.map(r => r.thumb_state), ['done', 'done']);
      const health = (await app.inject({ url: '/healthz/details' })).json();
      assert.deepEqual(health.thumb_queue, { queued: 0, running: 0, failed: 0 });
    });

    await t.test('archive: expired or exhausted tasks give up once with a reason; fresh ones keep retrying; billing untouched', async () => {
      const download = async () => { throw new Error('http_403'); };
      const expired = await request(alice, new Date(Date.now() - 8 * 86400_000).toISOString());
      const exhausted = await request(alice, new Date().toISOString());
      const fresh = await request(alice, new Date().toISOString());
      await db.query('INSERT INTO image_archives(task_id,attempts) VALUES($1,0),($2,7),($3,0)', [expired, exhausted, fresh]);
      const billingBefore = (await db.query('SELECT count(*)::int AS n FROM request_billing')).rows[0].n;
      const { failed } = await syncImageArchives(db, storage, download);
      assert.deepEqual(failed.map(f => [f.task_id, f.reason]).sort(), [[expired, 'upstream_expired'], [exhausted, 'attempts_exhausted']].sort());
      const rows = Object.fromEntries((await db.query('SELECT task_id,state,attempts,last_error FROM image_archives WHERE task_id=ANY($1::uuid[])', [[expired, exhausted, fresh]])).rows
        .map(r => [r.task_id, [r.state, r.attempts, r.last_error]]));
      assert.deepEqual(rows[expired], ['failed', 1, 'upstream_expired']);
      assert.deepEqual(rows[exhausted], ['failed', 8, 'attempts_exhausted']);
      assert.deepEqual(rows[fresh], ['pending', 1, 'image_archive_failed']);
      await db.query('UPDATE image_archives SET next_attempt_at=now() WHERE task_id=$1', [fresh]);
      assert.deepEqual((await syncImageArchives(db, storage, download)).failed, [], 'given-up tasks are not picked again (logged once)');
      assert.equal((await db.query('SELECT count(*)::int AS n FROM request_billing')).rows[0].n, billingBefore);
      assert.deepEqual((await app.inject({ url: '/healthz/details' })).json().archive_queue, { pending: 1, failed: 2 });
    });

    await t.test('legacy /api/me/images: backfilled images get the asset\'s sliced orig/w480/w960 URLs; others keep the old signed key', async () => {
      const task = await request(alice, new Date().toISOString());
      await db.query("INSERT INTO image_archives(task_id,state) VALUES($1,'completed')", [task]);
      const oldKey = (i) => `users/${alice}/imagegen/${task}-${i}.png`;
      for (const i of [0, 1]) await db.query(`INSERT INTO archived_images(task_id,image_index,object_key,content_type,bytes,sha256) VALUES($1,$2,$3,'image/png',10,$4)`, [task, i, oldKey(i), 'a'.repeat(64)]);
      const assetId = randomUUID(), prefix = `u/${alice}/${assetId}/`;
      await db.query(`INSERT INTO media_assets(id,user_id,kind,source,status,object_key,content_type,bytes,task_id,result_index,variants)
        VALUES($1,$2,'image','generation','ready',$3,'image/png',10,$4,0,$5)`, [assetId, alice, prefix + 'orig.png', task, { w480: prefix + 'w480.webp', w960: prefix + 'w960.webp' }]);
      const r = await call(alice, 'GET', '/api/me/images');
      assert.equal(r.statusCode, 200, r.body);
      const body = r.json(), [first, second] = body.rows.filter(x => x.task_id === task);
      assert.deepEqual(Object.keys(body).sort(), ['next_offset', 'rows', 'url_expires_in']);
      assert.deepEqual([first.image_index, first.content_type, first.bytes, first.model], [0, 'image/png', 10, 'gpt-image-2'], 'legacy fields kept');
      assert.ok(first.url.includes(prefix + 'orig.png') && first.url === first.urls.orig);
      assert.match(first.urls.w480, /w480\.webp\?/); assert.match(first.urls.w960, /w960\.webp\?/);
      assert.ok(Number(new URL(first.url).searchParams.get('X-Amz-Expires')) >= 6 * 3600, 'time-sliced, not the 300s legacy signature');
      assert.ok(second.url.includes(oldKey(1)) && !second.urls, 'no asset row → old key');
      assert.equal(new URL(second.url).searchParams.get('X-Amz-Expires'), '300');
      assert.deepEqual((await call(bob, 'GET', '/api/me/images')).json().rows, [], 'owner only');
    });

    const aliceToken = newToken('ipz_');
    await db.query(`INSERT INTO access_tokens (id,user_id,token_hash,prefix,name) VALUES ($1,$2,$3,$4,'api')`, [randomUUID(), alice, hash(aliceToken), aliceToken.slice(0, 12)]);
    const bearer = (payload, auth = 'Bearer ' + aliceToken) => app.inject({ url: '/v1/quote', method: 'POST', payload, headers: auth ? { authorization: auth } : {} });

    await t.test('POST /v1/quote: bearer auth, lanehub mode, customer key, body and response passed through', async () => {
      const body = { model: 'heygen-avatar', avatar_id: 'Abigail_2024', script: '你好', voice_id: 'zh_v1' };
      assert.equal((await bearer(body, null)).statusCode, 401);
      const off = await bearer(body);
      assert.deepEqual([off.statusCode, off.json().error.code], [409, 'quote_requires_lanehub']);
      await db.query(`INSERT INTO app_settings (key,value) VALUES ('lanehub_mode','on')`);
      assert.equal((await bearer({ script: 'no model' })).json().error.code, 'invalid_request');
      const ok = await bearer(body);
      assert.equal(ok.statusCode, 200, ok.body);
      assert.deepEqual(ok.json(), { quote_id: 'q1', amount_cny: '1.23000000', amount_kind: 'estimate', expires_at: 1900000000, estimated_seconds: 60 });
      const sent = lanehubCalls.filter(c => c.path === '/v1/quote').at(-1);
      assert.deepEqual(sent.body, body);
      assert.match(sent.auth, /^Bearer sk-customer-/, "the customer's own lanehub key, never the admin token");
      quoteReply = Response.json({ error: { code: 'constraint_violation', message: 'script / audio_url' } }, { status: 400 });
      const bad = await bearer(body);
      assert.deepEqual([bad.statusCode, bad.json().error.code], [400, 'constraint_violation'], 'upstream 4xx passed through');
      quoteReply = Response.json({ error: { message: 'invalid token' } }, { status: 401 });
      assert.deepEqual([(await bearer(body)).statusCode, (await bearer(body)).json().error.code], [502, 'quote_upstream_error']);
      quoteReply = new Response('<html>', { status: 200 });
      assert.equal((await bearer(body)).json().error.code, 'quote_upstream_error');
      quoteReply = null;
    });

    await t.test('avatar list warm-up: per lane via an existing customer key; skipped without HeyGen models or lanehub mode', async () => {
      assert.equal((await app.inject({ url: '/healthz/details' })).json().avatar_list_cache_age_seconds, null, 'cold');
      const lists = () => lanehubCalls.filter(c => c.path === '/v1/heygen/avatars').length;
      assert.deepEqual(await warmAvatarLists(options), ['official']);
      assert.equal(lists(), 1);
      assert.equal((await call(alice, 'GET', '/api/me/avatars')).statusCode, 200);
      assert.equal(lists(), 1, 'the user request is served from the warmed cache');
      const health = (await app.inject({ url: '/healthz/details' })).json();
      assert.ok(health.avatar_list_cache_age_seconds >= 0 && health.avatar_list_cache_age_seconds < 5);
      await db.query("UPDATE app_settings SET value='off' WHERE key='lanehub_mode'");
      assert.deepEqual(await warmAvatarLists(options), []);
      await db.query("UPDATE app_settings SET value='on' WHERE key='lanehub_mode'");
      catalog = { models: [{ id: 'gpt-image-2', kind: 'image', params: { registered: true, fields: [] } }] };
      const noHeygen = new LanehubCatalog(lanehub, { log: () => {} }); await noHeygen.refresh();
      assert.deepEqual(await warmAvatarLists({ ...options, lanehubCatalog: noHeygen }), []);
      assert.equal(lists(), 1);
    });

    await t.test('/healthz/details: localhost or token only, no secrets', async () => {
      const local = await app.inject({ url: '/healthz/details' });
      assert.equal(local.statusCode, 200);
      const body = local.json();
      assert.deepEqual(Object.keys(body).sort(), ['archive_queue', 'avatar_list_cache_age_seconds', 'lanehub_catalog', 'r2_configured', 'status', 'thumb_queue']);
      assert.equal(body.r2_configured, true);
      assert.ok(body.lanehub_catalog.age_seconds >= 0 && body.lanehub_catalog.last_refresh_failed === false);
      assert.ok(!/secret|sk-|AKID/.test(local.body));
      const remote = { remoteAddress: '203.0.113.9' };
      assert.equal((await app.inject({ url: '/healthz/details', ...remote })).statusCode, 404);
      assert.equal((await app.inject({ url: '/healthz/details', ...remote, headers: { authorization: 'Bearer wrong' } })).statusCode, 404);
      assert.equal((await app.inject({ url: '/healthz/details', ...remote, headers: { authorization: 'Bearer ' + 'h'.repeat(40) } })).statusCode, 200);
      assert.equal((await app.inject({ url: '/healthz/details', ...remote, headers: { 'x-forwarded-for': '127.0.0.1' } })).statusCode, 404, 'untrusted proxy header ignored');
    });
  } finally {
    await app?.close();
    await db.close();
    await setup.query(`DROP SCHEMA ${schema} CASCADE`);
    await setup.close();
    await rm(dir, { recursive: true, force: true });
  }
});
