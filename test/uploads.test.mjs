import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { database } from '../src/database.mjs';
import { createApp } from '../src/app.mjs';
import { createR2Storage } from '../src/r2-storage.mjs';
import { cleanupMedia } from '../src/uploads.mjs';
import { enqueueThumb, runThumbJobs } from '../src/media-thumbs.mjs';
import { grantRole, revokeRole, requireRole } from '../src/roles.mjs';
import { httpError } from '../src/security.mjs';

const fixture = name => readFileSync(new URL('./fixtures/' + name, import.meta.url));

// In-memory S3: honours the header-signed methods the client uses. No Cloudflare calls.
function fakeR2() {
  const objects = new Map(), calls = [];
  const fetcher = async (url, init) => {
    const key = decodeURIComponent(new URL(url).pathname.split('/').slice(2).join('/'));
    calls.push([init.method, key]);
    assert.match(init.headers.authorization, /^AWS4-HMAC-SHA256 Credential=/);
    const obj = objects.get(key);
    if (init.method === 'HEAD') return obj ? new Response(null, { headers: { 'content-length': String(obj.body.length), 'content-type': obj.type } }) : new Response(null, { status: 404 });
    if (init.method === 'DELETE') { objects.delete(key); return new Response(null, { status: 204 }); }
    if (init.method === 'GET') {
      if (!obj) return new Response(null, { status: 404 });
      const [, s, e] = init.headers.range.match(/bytes=(\d+)-(\d+)/);
      return new Response(obj.body.subarray(Number(s), Number(e) + 1), { status: 206 });
    }
    if (init.method === 'PUT') { objects.set(key, { body: Buffer.from(init.body ?? ''), type: init.headers['content-type'] }); return new Response(null, { status: 200 }); }
    return new Response(null, { status: 400 });
  };
  const storage = createR2Storage({ accountId: 'a'.repeat(32), bucket: 'ipzsk-media', accessKeyId: 'AKIDTEST', secretAccessKey: 'secret-test', archiveFrom: '2026-01-01T00:00:00Z' }, fetcher);
  // What a browser does with put_url: store the bytes under the presigned path.
  const browserPut = (putUrl, body, type) => objects.set(decodeURIComponent(new URL(putUrl).pathname.split('/').slice(2).join('/')), { body, type });
  return { storage, objects, calls, browserPut };
}

const webp = (w, h) => { const b = Buffer.alloc(30); b.write('RIFF', 0); b.write('WEBP', 8); b.write('VP8X', 12); b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3); return b; };
// ffprobe reports 2000x1000; ffmpeg returns WebP headers on fd 1 and 3. `fail` exits 1 with stderr instead.
const fakeSpawn = fail => (bin, argv, { stdio }) => {
  const child = new EventEmitter();
  child.stdio = stdio.map(m => m === 'pipe' ? new PassThrough() : null); child.stderr = child.stdio[2]; child.kill = () => {};
  setImmediate(() => {
    if (fail) child.stderr.write('boom');
    else if (argv.includes('-show_streams')) child.stdio[1].end(JSON.stringify({ streams: [{ codec_type: 'video', width: 2000, height: 1000 }], format: {} }));
    else { child.stdio[1].end(webp(480, 240)); child.stdio[3].end(webp(960, 480)); }
    setImmediate(() => child.emit('close', fail ? 1 : 0, null));
  });
  return child;
};

test('uploads, assets, roles and media cleanup against gateway_test', async t => {
  assert.ok(process.env.TEST_DB_HOST, 'Set TEST_DB_HOST explicitly; tests only use gateway_test database.');
  const schema = 'uploads_test_' + randomUUID().replaceAll('-', '');
  const config = { host: process.env.TEST_DB_HOST, port: Number(process.env.TEST_DB_PORT ?? 5432), database: 'gateway_test', user: process.env.TEST_DB_USER ?? 'gateway', password: process.env.TEST_DB_PASSWORD };
  const setup = database(config);
  assert.equal((await setup.query('SELECT current_database() AS name')).rows[0].name, 'gateway_test');
  await setup.query(`CREATE SCHEMA ${schema}`);
  const db = database({ ...config, options: `-c search_path=${schema}` });
  const alice = randomUUID(), bob = randomUUID(), sessions = new Map();
  const r2 = fakeR2();
  let app;
  try {
    await db.migrate(); await db.migrate(); // idempotent re-run
    assert.deepEqual((await db.query('SELECT version FROM schema_version WHERE version>=18 ORDER BY version')).rows.map(r => r.version), [18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28]);
    for (const id of [alice, bob]) {
      await db.query('INSERT INTO users(id,name,email,email_verified) VALUES($1,$2,$3,true)', [id, 'Fixture', id + '@example.com']);
      sessions.set(id, new Date().toISOString());
    }
    const customerAuth = { async identify(headers) {
      const user = headers.cookie?.replace('fixture=', '');
      if (!sessions.has(user)) throw httpError(401, 'customer_login_required');
      return { id: user, session_id: 'fixture-session', auth_user_id: user, session_created_at: sessions.get(user) };
    } };
    const thumbs = (over = {}) => runThumbJobs({ db, r2: r2.storage, spawn: fakeSpawn(false), format: 'webp', nice: null, ...over });
    app = await createApp({ db, customerAuth, imageStorage: r2.storage, upstream: {}, scheduler: { keys: new Map(), accounts: new Map() }, origin: 'https://api.ipzsk.com' });
    app.get('/api/me/test-admin-only', async req => ({ roles: await requireRole(req, 'admin', 'operator') }));
    const call = (user, method, url, payload) => app.inject({ url, method, payload, headers: { cookie: 'fixture=' + user, origin: 'https://www.ipzsk.com' } });
    const create = (user, body) => call(user, 'POST', '/api/me/uploads', body);
    const complete = (user, id) => call(user, 'POST', `/api/me/uploads/${id}/complete`, {});

    let pngAsset;
    await t.test('create → PUT → complete produces a ready asset with dimensions and thumbnails', async () => {
      const png = fixture('pixel.png');
      const r = await create(alice, { kind: 'image', content_type: 'image/png', bytes: png.length });
      assert.equal(r.statusCode, 200, r.body);
      const body = r.json(); pngAsset = body.asset_id;
      assert.deepEqual(body.headers, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=21600' });
      const put = new URL(body.put_url);
      assert.equal(put.pathname, `/ipzsk-media/u/${alice}/${body.asset_id}/orig.png`);
      assert.equal(put.searchParams.get('X-Amz-SignedHeaders'), 'cache-control;content-length;content-type;host');
      assert.ok(Date.parse(body.expires_at) - Date.now() > 590_000);
      assert.equal((await complete(alice, body.asset_id)).statusCode, 409, 'not uploaded yet stays pending');
      r2.browserPut(body.put_url, png, 'image/png');
      const done = await complete(alice, body.asset_id);
      assert.equal(done.statusCode, 200, done.body);
      assert.deepEqual({ ...done.json(), urls: undefined, created_at: undefined },
        { id: body.asset_id, kind: 'image', source: 'upload', status: 'ready', width: 1, height: 1, duration_ms: null, thumb_state: 'queued', urls: undefined, created_at: undefined });
      assert.match(done.json().urls.orig, /X-Amz-Expires=/);
      assert.equal((await complete(alice, body.asset_id)).json().status, 'ready', 'complete is idempotent');
      assert.equal(await thumbs(), pngAsset);
      const row = (await db.query('SELECT variants,thumb_state,thumb_attempts FROM media_assets WHERE id=$1', [pngAsset])).rows[0];
      assert.deepEqual(row, { variants: { w480: `u/${alice}/${pngAsset}/w480.webp`, w960: `u/${alice}/${pngAsset}/w960.webp` }, thumb_state: 'done', thumb_attempts: 1 });
      assert.equal(r2.objects.get(`u/${alice}/${pngAsset}/w480.webp`).type, 'image/webp');
      const listed = (await complete(alice, pngAsset)).json();
      assert.equal(listed.thumb_state, 'done'); assert.match(listed.urls.w960, /w960\.webp\?/);
      assert.equal(await thumbs(), null, 'queue empty');
    });

    await t.test('video completes with duration via Range reads; mismatched bytes are rejected and deleted', async () => {
      const mp4 = fixture('tail-moov.mp4');
      const v = (await create(alice, { kind: 'video', content_type: 'video/mp4', bytes: mp4.length })).json();
      r2.browserPut(v.put_url, mp4, 'video/mp4');
      const done = (await complete(alice, v.asset_id)).json();
      assert.equal(done.duration_ms, 500); assert.equal(done.width, 32); assert.equal(done.thumb_state, 'queued', 'videos get a poster job too');

      const jpg = fixture('small.jpg');
      const fake = (await create(alice, { kind: 'image', content_type: 'image/png', bytes: jpg.length })).json();
      r2.browserPut(fake.put_url, jpg, 'image/png');
      const r = await complete(alice, fake.asset_id);
      assert.equal(r.statusCode, 422); assert.equal(r.json().error.code, 'upload_type_mismatch');
      assert.equal((await db.query('SELECT status FROM media_assets WHERE id=$1', [fake.asset_id])).rows[0].status, 'failed');
      assert.ok(![...r2.objects.keys()].some(k => k.includes(fake.asset_id)), 'object deleted');

      const html = Buffer.from('<html>definitely not a video</html>');
      const bad = (await create(alice, { kind: 'video', content_type: 'video/mp4', bytes: html.length })).json();
      r2.browserPut(bad.put_url, html, 'video/mp4');
      assert.equal((await complete(alice, bad.asset_id)).json().error.code, 'upload_type_mismatch');
    });

    await t.test('thumbnail queue: SKIP LOCKED, backoff 1m/5m/30m/2h, permanent failure, lease reclaim, skip', async () => {
      await db.query("UPDATE media_assets SET thumb_state='none',thumb_next_at=NULL WHERE thumb_state<>'done'");
      const insert = async (key, bytes = 10) => (await db.query(`INSERT INTO media_assets(user_id,kind,source,status,object_key,content_type,bytes)
        VALUES($1,'image','upload','ready',$2,'image/png',$3) RETURNING id`, [alice, `u/${alice}/${key}/orig.png`, bytes])).rows[0].id;
      const read = async id => (await db.query('SELECT thumb_state,thumb_attempts,thumb_next_at,thumb_error,variants FROM media_assets WHERE id=$1', [id])).rows[0];
      const id = await insert('q1');
      await enqueueThumb(db, id);
      let at = new Date(Date.now() + 3600_000);
      const logs = [], log = { warn: (o, m) => logs.push([m, o]) };
      const failing = () => thumbs({ spawn: fakeSpawn(true), now: () => at, log });
      await db.tx(async c => {
        await c.query('SELECT id FROM media_assets WHERE id=$1 FOR UPDATE', [id]);
        assert.equal(await failing(), null, 'locked row is skipped, not waited on');
      });
      for (const [i, wait] of [60_000, 300_000, 1_800_000, 7_200_000].entries()) {
        assert.equal(await failing(), id);
        const row = await read(id);
        assert.equal(row.thumb_state, 'failed'); assert.equal(row.thumb_attempts, i + 1);
        assert.equal(row.thumb_next_at.getTime(), at.getTime() + wait);
        at = new Date(at.getTime() + wait - 1000); assert.equal(await failing(), null, 'not due yet');
        at = new Date(at.getTime() + 1000);
      }
      assert.equal(await failing(), id);
      const dead = await read(id);
      assert.equal(dead.thumb_state, 'failed'); assert.equal(dead.thumb_attempts, 5); assert.equal(dead.thumb_next_at, null);
      assert.match(dead.thumb_error, /^exit_1: boom$/);
      assert.equal(await failing(), null, 'permanent failure is not retried');
      assert.deepEqual(logs.map(([m, o]) => [m, o.asset_id, o.attempt, o.stderr]), [1, 2, 3, 4, 5].map(n => ['thumbnail_failed', id, n, 'boom']));

      // A run lost to a crash stays 'running' until its lease passes, then is reclaimed.
      const lost = await insert('q2');
      await db.query("UPDATE media_assets SET thumb_state='running',thumb_attempts=1,thumb_next_at=$2 WHERE id=$1", [lost, new Date(at.getTime() + 1000)]);
      assert.equal(await thumbs({ now: () => at }), null, 'lease still held');
      at = new Date(at.getTime() + 2000);
      assert.equal(await thumbs({ now: () => at }), lost);
      assert.equal((await read(lost)).thumb_state, 'done'); assert.equal((await read(lost)).thumb_attempts, 2);

      const huge = await insert('q3', 60 * 1024 * 1024 + 1);
      await enqueueThumb(db, huge);
      assert.equal(await thumbs({ now: () => at }), huge);
      assert.deepEqual({ ...(await read(huge)), thumb_attempts: undefined }, { thumb_state: 'skipped', thumb_next_at: null, thumb_error: 'image_too_large', variants: null, thumb_attempts: undefined });
      await db.query('DELETE FROM media_assets WHERE id = ANY($1)', [[id, lost, huge]]);
    });

    await t.test('validation, ownership and quota', async () => {
      assert.equal((await create(alice, { kind: 'image', content_type: 'image/gif', bytes: 10 })).statusCode, 400);
      assert.equal((await create(alice, { kind: 'image', content_type: 'video/mp4', bytes: 10 })).statusCode, 400);
      assert.equal((await create(alice, { kind: 'image', content_type: 'image/png', bytes: 20 * 1024 * 1024 + 1 })).statusCode, 413);
      assert.equal((await create(alice, { kind: 'video', content_type: 'video/mp4', bytes: '10' })).statusCode, 400);
      assert.equal((await complete(bob, pngAsset)).statusCode, 404, "others' ids look missing");
      assert.equal((await call(bob, 'DELETE', '/api/me/assets/' + pngAsset)).statusCode, 404);
      // Pending uploads count toward quota.
      await db.query(`INSERT INTO media_assets(user_id,kind,source,object_key,content_type,bytes) SELECT $1,'video','upload','q/'||g,'video/mp4',209715200 FROM generate_series(1,11) g`, [bob]);
      const r = await create(bob, { kind: 'image', content_type: 'image/png', bytes: 1024 });
      assert.equal(r.statusCode, 403); assert.equal(r.json().error.code, 'storage_quota_exceeded');
      await db.query("UPDATE media_assets SET status='deleted',deleted_at=now() WHERE user_id=$1", [bob]);
      assert.equal((await create(bob, { kind: 'image', content_type: 'image/png', bytes: 1024 })).statusCode, 200, 'deleted assets free quota');
      await db.query(`INSERT INTO media_assets(user_id,kind,source,status,object_key,content_type,bytes) SELECT $1,'image','upload','ready','c/'||g,'image/png',1 FROM generate_series(1,1999) g`, [bob]);
      assert.equal((await create(bob, { kind: 'image', content_type: 'image/png', bytes: 1 })).json().error.code, 'storage_quota_exceeded');
    });

    await t.test('asset list paginates with stable sliced URLs, filters and soft delete', async () => {
      const first = await call(bob, 'GET', '/api/me/assets?kind=image&source=upload');
      assert.equal(first.statusCode, 200); assert.equal(first.headers['cache-control'], 'private, max-age=60');
      const again = await call(bob, 'GET', '/api/me/assets?kind=image&source=upload');
      assert.deepEqual(again.json(), first.json(), 'same slice ⇒ identical URLs');
      const seen = new Set(); let cursor = null, pages = 0;
      do {
        const page = (await call(bob, 'GET', '/api/me/assets' + (cursor ? '?cursor=' + cursor : ''))).json();
        for (const item of page.items) { assert.ok(!seen.has(item.id)); seen.add(item.id); }
        cursor = page.next_cursor; pages++;
      } while (cursor);
      assert.equal(seen.size, 1999); assert.equal(pages, 40);
      assert.equal((await call(bob, 'GET', '/api/me/assets?cursor=bad')).statusCode, 400);
      const aliceItems = (await call(alice, 'GET', '/api/me/assets')).json().items;
      assert.deepEqual(aliceItems.map(i => i.kind).sort(), ['image', 'video']);
      assert.ok(aliceItems.find(i => i.id === pngAsset).urls.w480);
      assert.equal((await call(alice, 'GET', '/api/me/assets?kind=video')).json().items.length, 1);
      assert.equal((await call(alice, 'DELETE', '/api/me/assets/' + pngAsset)).statusCode, 204);
      assert.equal((await call(alice, 'GET', '/api/me/assets?kind=image')).json().items.length, 0);
      assert.equal((await complete(alice, pngAsset)).statusCode, 404);
    });

    await t.test('roles: 403 without a role, allowed with one, 12h admin session limit, cache invalidated on grant/revoke', async () => {
      assert.deepEqual((await call(alice, 'GET', '/api/me/roles')).json(), { roles: [] });
      const r = await call(alice, 'GET', '/api/me/test-admin-only');
      assert.equal(r.statusCode, 403); assert.equal(r.json().error.code, 'forbidden_role');
      await grantRole(db, alice, 'operator', bob);
      assert.deepEqual((await call(alice, 'GET', '/api/me/roles')).json(), { roles: ['operator'] });
      assert.equal((await call(alice, 'GET', '/api/me/test-admin-only')).statusCode, 200);
      assert.equal((await db.query("SELECT actor_user_id FROM audit_events WHERE action='role.grant'")).rows[0].actor_user_id, bob);
      sessions.set(alice, new Date(Date.now() - 13 * 3600_000).toISOString());
      assert.equal((await call(alice, 'GET', '/api/me/test-admin-only')).statusCode, 200, '老会话不再被管理接口拒绝');
      sessions.set(alice, new Date().toISOString());
      await grantRole(db, bob, 'viewer');
      assert.equal((await call(bob, 'GET', '/api/me/test-admin-only')).statusCode, 403, 'viewer is not operator');
      await revokeRole(db, alice, 'operator');
      assert.equal((await call(alice, 'GET', '/api/me/test-admin-only')).statusCode, 403);
      await assert.rejects(() => grantRole(db, alice, 'root'), { code: 'invalid_role' });
    });

    await t.test('cleanup removes stale pending, old failed and 30-day deleted assets with their objects', async () => {
      const png = fixture('pixel.png');
      const stale = (await create(alice, { kind: 'image', content_type: 'image/png', bytes: png.length })).json();
      r2.browserPut(stale.put_url, png, 'image/png');
      const fresh = (await create(alice, { kind: 'image', content_type: 'image/png', bytes: png.length })).json();
      await db.query("UPDATE media_assets SET created_at=now()-interval '25 hours' WHERE id=$1", [stale.asset_id]);
      await db.query("UPDATE media_assets SET deleted_at=now()-interval '31 days' WHERE id=$1", [pngAsset]);
      r2.objects.set(`u/${alice}/${pngAsset}/w480.webp`, { body: Buffer.from('x'), type: 'image/webp' });
      const before = (await db.query('SELECT count(*)::int FROM media_assets')).rows[0].count;
      const result = await cleanupMedia(db, r2.storage);
      assert.equal(result.failed, 0);
      const ids = new Set((await db.query('SELECT id FROM media_assets')).rows.map(r => r.id));
      assert.ok(!ids.has(stale.asset_id) && !ids.has(pngAsset) && ids.has(fresh.asset_id));
      assert.ok(![...r2.objects.keys()].some(k => k.includes(stale.asset_id) || k.includes(pngAsset)));
      assert.equal(before - (await db.query('SELECT count(*)::int FROM media_assets')).rows[0].count, result.removed);
    });
  } finally {
    await app?.close(); await db.close(); await setup.query(`DROP SCHEMA ${schema} CASCADE`); await setup.close();
  }
});
