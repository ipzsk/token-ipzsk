import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
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
import { hash, httpError } from '../src/security.mjs';

const LANE = 'https://lane.test';
const fixture = (name) => readFileSync(new URL('./fixtures/' + name, import.meta.url));
const avatarFields = ['aspect_ratio', 'audio_url', 'background_color', 'background_image_url', 'captions', 'resolution', 'voice_id'];
// /api/catalog as lanehub serves it (docs/downstream-api-contract.md): mode + inputs + params. heygen-avatar-iii has no hints (older-lanehub fallback).
const avatarInputs = { required: ['avatar_id'], one_of: ['script', 'audio_url'], max_length: { script: 5000 } };
const catalog = { models: [
  { id: 'heygen-avatar', name: 'Avatar IV', kind: 'video', mode: 'avatar', inputs: avatarInputs, billing: { type: 'times', unit: 'per_minute_output', usd: 4.83 },
    params: { registered: true, passthrough: ['avatar_id', 'script'], fields: avatarFields.map((field) => ({ field, ...(field === 'aspect_ratio' ? { values: ['16:9', '9:16'] } : {}) })) } },
  { id: 'heygen-avatar-iii', name: 'Avatar III', kind: 'video', billing: { unit: 'per_minute_output' },
    params: { registered: true, passthrough: ['avatar_id', 'script'], fields: avatarFields.map((field) => ({ field })) } },
  { id: 'heygen-image', name: 'Photo', kind: 'video', mode: 'talking_photo', billing: { unit: 'per_minute_output' },
    inputs: { required: ['image_urls'], one_of: ['script', 'audio_url'], required_with: { script: ['voice_id'] }, max_length: { script: 5000 } },
    params: { registered: true, passthrough: ['script'], fields: [...avatarFields, 'image_urls'].map((field) => ({ field })) } },
] };

function fakeR2() {
  const objects = new Map();
  const fetcher = async (url, init) => {
    const key = decodeURIComponent(new URL(url).pathname.split('/').slice(2).join('/'));
    const obj = objects.get(key);
    if (init.method === 'HEAD') return obj ? new Response(null, { headers: { 'content-length': String(obj.body.length) } }) : new Response(null, { status: 404 });
    if (init.method === 'GET') {
      if (!obj) return new Response(null, { status: 404 });
      const [, s, e] = init.headers.range.match(/bytes=(\d+)-(\d+)/);
      return new Response(obj.body.subarray(Number(s), Number(e) + 1), { status: 206 });
    }
    if (init.method === 'PUT') { objects.set(key, { body: Buffer.from(init.body ?? ''), type: init.headers['content-type'] }); return new Response(null, { status: 200 }); }
    if (init.method === 'DELETE') { objects.delete(key); return new Response(null, { status: 204 }); }
    return new Response(null, { status: 400 });
  };
  // Clock ticks 1 s per signature: two presigned URLs for the same object always differ (as they do across real requests).
  let ticks = 0;
  const storage = createR2Storage({ accountId: 'a'.repeat(32), bucket: 'ipzsk-media', accessKeyId: 'AKIDTEST', secretAccessKey: 'secret-test', archiveFrom: '2026-01-01T00:00:00Z' },
    fetcher, () => new Date(Date.now() + ticks++ * 1000));
  const browserPut = (putUrl, body) => objects.set(decodeURIComponent(new URL(putUrl).pathname.split('/').slice(2).join('/')), { body });
  return { storage, objects, browserPut };
}

test('数字人: audio upload, avatar generation, quote, lists, archive, subjects', { skip: spawnSync('ffmpeg', ['-version']).status !== 0 && 'ffmpeg not installed' }, async (t) => {
  assert.ok(process.env.TEST_DB_HOST, 'Set TEST_DB_HOST explicitly; tests only use gateway_test database.');
  const schema = 'avatar_' + randomUUID().replaceAll('-', '');
  const config = { host: process.env.TEST_DB_HOST, port: Number(process.env.TEST_DB_PORT ?? 5432), database: 'gateway_test', user: process.env.TEST_DB_USER ?? 'gateway', password: process.env.TEST_DB_PASSWORD };
  const setup = database(config);
  assert.equal((await setup.query('SELECT current_database() AS name')).rows[0].name, 'gateway_test');
  await setup.query(`CREATE SCHEMA ${schema}`);
  const db = database({ ...config, options: `-c search_path=${schema}` });
  const dir = await mkdtemp(join(tmpdir(), 'ipzsk-avatar-'));
  const audioFile = async (name, args) => {
    const out = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', ...args, '-y', join(dir, name)]);
    assert.equal(out.status, 0, String(out.stderr));
    return readFile(join(dir, name));
  };

  const users = new Map(), quotes = [], generations = [], lists = [];
  let nextUser = 70, taskResult = null, listsDown = false;
  const lanehubFetch = async (url, options = {}) => {
    const path = url.slice(LANE.length), body = options.body ? JSON.parse(options.body) : null;
    if (path.startsWith('/api/user/?keyword=')) {
      const name = new URL(url).searchParams.get('keyword');
      return Response.json({ success: true, data: { data: users.has(name) ? [{ id: users.get(name), username: name }] : [] } });
    }
    if (path === '/api/user/') { users.set(body.username, ++nextUser); return Response.json({ success: true }); }
    if (path === '/api/token/for_user') return Response.json({ success: true, data: { key: 'k' + randomUUID().replaceAll('-', '') } });
    if (path === '/api/option/') return Response.json({ success: true, data: [{ key: 'PaymentUSDRate', value: '7' }] });
    if (path === '/api/catalog') return Response.json({ success: true, data: catalog });
    if (path === '/v1/quote') {
      quotes.push(body);
      // Script: lanehub reports its own estimate. Audio: this fake ignores duration (the gateway must fill the estimate in).
      return Response.json({ quote_id: 'q_' + quotes.length, amount_cny: '0.99000000', amount_kind: 'estimate', expires_at: Math.floor(Date.now() / 1000) + 600,
        ...(body.script ? { estimated_seconds: 75 } : {}) });
    }
    if (path === '/v1/videos/generations') {
      generations.push(body);
      if (body.script === 'noface') return Response.json({ error: { code: 'invalid_parameter', message: 'No face detected in the photo' } }, { status: 400 });
      if (body.script === 'consent') return Response.json({ error: { code: 'avatar_consent_required', message: '该数字人需要先完成肖像授权（consent）才能用于生成' } }, { status: 400 });
      if (body.model === 'heygen-avatar-iii' && body.avatar_id === 'Iv_Only') return Response.json({ error: { code: 'invalid_parameter', message: 'avatar Iv_Only does not support engine avatar_iii' } }, { status: 400 });
      if (body.script === 'xor') return Response.json({ error: { code: 'constraint_violation', message: '参数 script / audio_url 必须恰好给一个', field: 'script|audio_url' } }, { status: 400 });
      return Response.json({ code: 200, data: [{ status: 'submitted', task_id: 'hg-' + generations.length }] }, { headers: { 'X-Oneapi-Request-Id': 'lane-' + generations.length } });
    }
    if (path.startsWith('/v1/heygen/')) {
      lists.push(path);
      if (listsDown || path.includes('language=English')) return Response.json({ error: { code: 'heygen_channel_unavailable', message: 'no channel' } }, { status: 503 });
      if (path.includes('language=Japanese')) return Response.json({ error: { code: 'heygen_upstream_error', upstream_code: 'x' } }, { status: 502 });
      return path.startsWith('/v1/heygen/avatars')
        ? Response.json({ items: [{ id: 'Abigail_2024', name: 'Abigail', type: 'avatar', avatar_type: 'studio_avatar', gender: 'female', preview_image_url: 'https://h.test/a.jpg',
          preview_video_url: 'https://h.test/a.mp4', default_voice_id: 'zh_v1', engines: ['avatar_iv', 'avatar_iii'] },
          { id: 'Iv_Only', name: 'IV only', engines: ['avatar_iv'] }, { id: 'No_Engines', name: 'unknown engines' }] })
        : Response.json({ items: [{ id: 'zh_v1', name: '晓晓', language: 'Chinese', gender: 'female', preview_audio_url: 'https://h.test/v.mp3', support_pause: true, type: 'public' }] });
    }
    if (path.startsWith('/v1/tasks/')) {
      const id = decodeURIComponent(path.slice('/v1/tasks/'.length));
      return Response.json({ code: 200, data: { id, status: taskResult ? 'completed' : 'processing', progress: 50, result: taskResult } });
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
    assert.equal((await db.query('SELECT max(version) AS v FROM schema_version')).rows[0].v, 31);
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
    await lanehubCatalog.refresh();
    const call = (user, method, url, payload, headers = {}) => app.inject({ url, method, payload, headers: { cookie: 'fixture=' + user, origin: 'https://www.ipzsk.com', ...headers } });
    const image = async (user, type = 'image/png') => (await db.query(`INSERT INTO media_assets(user_id,kind,source,status,object_key,content_type,bytes,width,height)
      VALUES($1::uuid,'image','upload','ready','u/'||$1::text||'/'||gen_random_uuid()||'/orig.img',$2,10,1,1) RETURNING id`, [user, type])).rows[0].id;
    const count = async (sql, args) => (await db.query(sql, args)).rows[0].n;
    const upload = async (user, type, bytes) => {
      const ticket = (await call(user, 'POST', '/api/me/uploads', { kind: 'audio', content_type: type, bytes: bytes.length })).json();
      r2.browserPut(ticket.put_url, bytes);
      return [ticket.asset_id, await call(user, 'POST', `/api/me/uploads/${ticket.asset_id}/complete`, {})];
    };

    let audioId;
    await t.test('audio upload: sniffed type, ffprobe duration persisted, no thumbnail job; bad audio rejected', async () => {
      const wav = await audioFile('two.wav', ['-i', 'sine=frequency=440:duration=2', '-ac', '1', '-c:a', 'pcm_s16le']);
      let r;
      [audioId, r] = await upload(alice, 'audio/wav', wav);
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.json().kind, 'audio'); assert.ok(Math.abs(r.json().duration_ms - 2000) < 100, String(r.json().duration_ms)); assert.equal(r.json().thumb_state, 'none');
      assert.equal((await db.query('SELECT duration_ms FROM media_assets WHERE id=$1', [audioId])).rows[0].duration_ms, r.json().duration_ms, 'stored in DB');
      const mp3 = await audioFile('two.mp3', ['-i', 'sine=frequency=440:duration=2', '-ac', '1', '-c:a', 'libmp3lame']);
      const [, okMp3] = await upload(alice, 'audio/mpeg', mp3);
      assert.ok(Math.abs(okMp3.json().duration_ms - 2000) < 150, okMp3.body);
      assert.equal((await upload(alice, 'audio/mpeg', wav))[1].json().error.code, 'upload_type_mismatch');
      assert.equal((await upload(alice, 'audio/wav', await audioFile('short.wav', ['-i', 'sine=duration=0.5', '-c:a', 'pcm_s16le'])))[1].json().error.code, 'audio_too_short');
      const long = await audioFile('long.mp3', ['-i', 'anullsrc=r=8000:cl=mono', '-t', '605', '-c:a', 'libmp3lame', '-b:a', '8k']);
      assert.equal((await upload(alice, 'audio/mpeg', long))[1].json().error.code, 'audio_too_long');
      assert.equal((await call(alice, 'POST', '/api/me/uploads', { kind: 'audio', content_type: 'audio/wav', bytes: 33 * 1024 * 1024 })).statusCode, 413);
      assert.equal((await call(alice, 'POST', '/api/me/uploads', { kind: 'audio', content_type: 'audio/mp4', bytes: 10 })).json().error.code, 'unsupported_media_type');
      assert.deepEqual((await call(alice, 'GET', '/api/me/assets?kind=audio')).json().items.map((a) => a.id).includes(audioId), true);
    });

    await t.test('catalog exposes mode + avatar block', async () => {
      const models = (await call(alice, 'GET', '/api/me/media/models')).json().models;
      assert.deepEqual(models.map((m) => [m.id, m.mode, m.avatar.engine, m.avatar.source[0]]),
        [['heygen-avatar', 'avatar', 'iv', 'library'], ['heygen-avatar-iii', 'avatar', 'iii', 'library'], ['heygen-image', 'talking_photo', 'iv', 'photo']]);
    });

    const photo = await image(alice, 'image/jpeg'), bg = await image(alice, 'image/png');
    const signed = (url) => { const u = new URL(url); return u.searchParams.get('X-Amz-Expires') === '3600' && u.pathname.startsWith(`/ipzsk-media/u/${alice}/`); };
    let libraryAudioTask;
    await t.test('generation: 4 source × voice combinations send exactly the mapped body', async () => {
      const cases = [
        [{ model: 'heygen-avatar', avatar_id: 'Abigail_2024', script: '大家好', voice_id: 'zh_v1', captions: true, background_color: '#112233', aspect_ratio: '9:16' },
          (b) => assert.deepEqual(b, { model: 'heygen-avatar', avatar_id: 'Abigail_2024', script: '大家好', voice_id: 'zh_v1', captions: true, background_color: '#112233', aspect_ratio: '9:16' }), []],
        [{ model: 'heygen-avatar-iii', avatar_id: 'Abigail_2024', audio_asset_id: audioId, background_asset_id: bg },
          (b) => { assert.deepEqual(Object.keys(b).sort(), ['audio_url', 'avatar_id', 'background_image_url', 'model']); assert.ok(signed(b.audio_url) && signed(b.background_image_url)); }, [audioId, bg]],
        [{ model: 'heygen-image', photo_asset_id: photo, script: 'hello', voice_id: 'en_v2', captions: false },
          (b) => { assert.deepEqual(Object.keys(b).sort(), ['captions', 'image_urls', 'model', 'script', 'voice_id']); assert.ok(b.image_urls.length === 1 && signed(b.image_urls[0])); }, [photo]],
        [{ model: 'heygen-image', photo_asset_id: photo, audio_asset_id: audioId, resolution: '1080p' },
          (b) => { assert.deepEqual(Object.keys(b).sort(), ['audio_url', 'image_urls', 'model', 'resolution']); assert.ok(!('prompt' in b)); }, [photo, audioId]],
      ];
      for (const [payload, check, refs] of cases) {
        const r = await call(alice, 'POST', '/api/me/videos/generations', { ...payload, source: 'studio' }, { 'idempotency-key': 'a:' + randomUUID() });
        assert.equal(r.statusCode, 200, r.body);
        check(generations.at(-1));
        const record = (await db.query('SELECT * FROM generation_records WHERE request_id=$1', [r.json().data[0].task_id])).rows[0];
        assert.equal(record.prompt, payload.script ?? '');
        assert.equal(record.params.avatar_source, payload.avatar_id ? 'library' : 'photo');
        assert.equal(record.params.voice_source, payload.script ? 'script' : 'audio');
        assert.ok(!JSON.stringify(record.params).includes('X-Amz'), 'no signed URLs stored');
        assert.deepEqual((await db.query('SELECT asset_id FROM generation_references WHERE record_id=$1 ORDER BY position', [record.id])).rows.map((x) => x.asset_id), refs);
        if (payload.model === 'heygen-avatar-iii') { libraryAudioTask = record; assert.ok(record.params.audio_duration_ms > 1900); }
      }
    });

    await t.test('generation rejects: conflicting/missing sources, webp photo, others\' assets, long script, prompt — no request rows', async () => {
      const before = await count('SELECT count(*)::int AS n FROM requests');
      const bobAudio = (await db.query(`INSERT INTO media_assets(user_id,kind,source,status,object_key,content_type,bytes,duration_ms)
        VALUES($1::uuid,'audio','upload','ready','u/'||$1::text||'/x/orig.mp3','audio/mpeg',10,3000) RETURNING id`, [bob])).rows[0].id;
      const cases = [
        [{ model: 'heygen-avatar', avatar_id: 'a', photo_asset_id: photo, script: 'x' }, 'avatar_source_conflict'],
        [{ model: 'heygen-avatar', script: 'x' }, 'avatar_source_required'],
        [{ model: 'heygen-avatar', photo_asset_id: photo, script: 'x' }, 'avatar_source_unsupported'],
        [{ model: 'heygen-avatar', avatar_id: 'a' }, 'avatar_voice_required'],
        [{ model: 'heygen-avatar', avatar_id: 'a', script: 'x', audio_asset_id: audioId }, 'avatar_voice_conflict'],
        [{ model: 'heygen-image', photo_asset_id: await image(alice, 'image/webp'), audio_asset_id: audioId }, 'avatar_photo_unsupported_type'],
        [{ model: 'heygen-image', photo_asset_id: await image(bob), audio_asset_id: audioId }, 'avatar_photo_not_found'],
        [{ model: 'heygen-avatar', avatar_id: 'a', audio_asset_id: bobAudio }, 'audio_asset_not_found'],
        [{ model: 'heygen-avatar', avatar_id: 'a', audio_asset_id: photo }, 'audio_asset_not_found'],
        [{ model: 'heygen-avatar', avatar_id: 'a', script: 'x'.repeat(5001) }, 'script_too_long'],
        [{ model: 'heygen-avatar', avatar_id: 'a', script: 'x', prompt: 'x' }, 'avatar_prompt_not_supported'],
        [{ model: 'heygen-image', photo_asset_id: photo, script: 'x' }, 'voice_id_required'],
      ];
      for (const [payload, code] of cases) {
        const r = await call(alice, 'POST', '/api/me/videos/generations', payload);
        assert.equal(r.statusCode, 400, code + ' ' + r.body); assert.equal(r.json().error.code, code); assert.ok(r.json().error.message.length > 10, 'human message');
      }
      assert.match((await call(alice, 'POST', '/api/me/videos/generations', cases[0][0])).json().error.message, /avatar_id[\s\S]*photo_asset_id/, 'names every alternative');
      assert.equal(await count('SELECT count(*)::int AS n FROM requests'), before);
    });

    await t.test('submit: lanehub user-side errors propagate code (+field); "no face" becomes avatar_photo_no_face', async () => {
      const r = await call(alice, 'POST', '/api/me/videos/generations', { model: 'heygen-image', photo_asset_id: photo, script: 'noface', voice_id: 'v' });
      assert.equal(r.statusCode, 400, r.body); assert.equal(r.json().error.code, 'avatar_photo_no_face');
      assert.equal((await db.query('SELECT failure_code FROM generation_records WHERE request_id=$1', [r.json().error.request_id])).rows[0].failure_code, 'avatar_photo_no_face');
      const consent = (await call(alice, 'POST', '/api/me/videos/generations', { model: 'heygen-avatar', avatar_id: 'Private_1', script: 'consent' })).json().error;
      assert.deepEqual([consent.code, consent.message], ['avatar_consent_required', '该数字人需要先完成肖像授权，请换一个已授权的数字人']);
      const xor = (await call(alice, 'POST', '/api/me/videos/generations', { model: 'heygen-avatar', avatar_id: 'a', script: 'xor' })).json().error;
      assert.deepEqual([xor.code, xor.field], ['constraint_violation', 'script|audio_url']);
    });

    await t.test('quote: same mapped body; audio carries server duration and a max(60s, duration) estimate', async () => {
      const r = (await call(alice, 'POST', '/api/me/media/quote', { items: [
        { model: 'heygen-avatar-iii', avatar_id: 'Abigail_2024', audio_asset_id: audioId },
        { model: 'heygen-avatar', avatar_id: 'Abigail_2024', script: '你好', voice_id: 'zh_v1' },
        { model: 'heygen-avatar', avatar_id: 'Abigail_2024', photo_asset_id: photo, script: 'x' },
      ] })).json();
      const audioQuote = quotes.find((q) => q.audio_url), scriptQuote = quotes.find((q) => q.script === '你好');
      assert.deepEqual(Object.keys(audioQuote).sort(), ['audio_url', 'avatar_id', 'duration', 'model']); assert.equal(audioQuote.duration, 2);
      assert.deepEqual(scriptQuote, { model: 'heygen-avatar', avatar_id: 'Abigail_2024', script: '你好', voice_id: 'zh_v1' });
      assert.deepEqual([r.items[0].estimated_seconds, r.items[0].estimate_basis, r.items[0].amount_kind], [60, 'audio_duration', 'estimate']);
      assert.deepEqual([r.items[1].estimated_seconds, r.items[1].estimate_basis], [75, 'script']);
      assert.equal(r.items[2].error.code, 'avatar_source_conflict'); assert.match(r.items[2].error.message, /photo_asset_id/);
    });

    await t.test('avatars / voices proxy with the user key, 10-minute cache, 503 when lanehub lacks them', async () => {
      assert.equal((await call(alice, 'GET', '/api/me/voices?language=English')).json().error.code, 'avatar_catalog_unavailable');
      assert.equal((await call(alice, 'GET', '/api/me/voices?language=Japanese')).json().error.code, 'avatar_catalog_upstream_error');
      const a1 = await call(alice, 'GET', '/api/me/avatars');
      assert.equal(a1.statusCode, 200, a1.body);
      assert.deepEqual(a1.json().items[0], { id: 'Abigail_2024', name: 'Abigail', type: 'avatar', avatar_type: 'studio_avatar', gender: 'female', preview_image_url: 'https://h.test/a.jpg',
        preview_video_url: 'https://h.test/a.mp4', default_voice_id: 'zh_v1', engines: ['avatar_iv', 'avatar_iii'] });
      const n = lists.length;
      assert.equal((await call(bob, 'GET', '/api/me/avatars')).statusCode, 200);
      assert.equal(lists.length, n, 'same tier → cache hit');
      assert.equal((await call(alice, 'GET', '/api/me/voices?language=Chinese&type=public')).json().items[0].support_pause, true);
      assert.equal(lists.at(-1), '/v1/heygen/voices?language=Chinese&type=public');
      assert.equal((await call(alice, 'GET', '/api/me/voices?type=shared')).statusCode, 400);
      assert.equal((await call(alice, 'GET', '/api/me/voices?language=../x')).statusCode, 400);
      listsDown = true;
      assert.equal((await call(alice, 'GET', '/api/me/avatars')).statusCode, 200, 'still cached');
    });

    await t.test('Avatar III engine: cold list → lanehub rejection mapped; warm list → rejected before any request row', async () => {
      const iii = { model: 'heygen-avatar-iii', avatar_id: 'Iv_Only', script: 'hi' };
      const warm = await call(alice, 'POST', '/api/me/videos/generations', iii);
      assert.deepEqual([warm.statusCode, warm.json().error.code, warm.json().error.field], [400, 'avatar_engine_unavailable', 'avatar_id']);
      assert.equal(warm.json().error.request_id, undefined, 'warm cache: refused before creating a request');
      const sent = generations.length;
      assert.equal((await call(alice, 'POST', '/api/me/media/quote', { items: [iii] })).json().items[0].error.code, 'avatar_engine_unavailable');
      assert.equal((await call(alice, 'POST', '/api/me/videos/generations', { ...iii, avatar_id: 'Abigail_2024' })).statusCode, 200, 'supports avatar_iii');
      assert.equal((await call(alice, 'POST', '/api/me/videos/generations', { ...iii, avatar_id: 'No_Engines' })).statusCode, 200, 'unknown engines → lanehub decides');
      assert.equal((await call(alice, 'POST', '/api/me/videos/generations', { ...iii, model: 'heygen-avatar' })).statusCode, 200, 'IV model unaffected');
      assert.equal(generations.length, sent + 3);
      // Cold cache (fresh catalog instance → empty list cache): lanehub rejects, the code is still avatar_engine_unavailable.
      const cold = new LanehubCatalog(lanehub, { log: () => {} }); await cold.refresh();
      const coldApp = await createApp({ db, upstream, customerAuth, imageStorage: r2.storage, scheduler: new Scheduler({ waitMs: 10 }), origin: 'https://api.ipzsk.com',
        lanehub, lanehubCatalog: cold, lanehubAccountId: accountId, lanehubSignupCny: 0, lanehubUsdCny: 7, lanehubQuotaPerUnit: 500000 });
      try {
        const r = await coldApp.inject({ url: '/api/me/videos/generations', method: 'POST', payload: iii, headers: { cookie: 'fixture=' + alice, origin: 'https://www.ipzsk.com' } });
        assert.deepEqual([r.statusCode, r.json().error.code, r.json().error.field], [400, 'avatar_engine_unavailable', 'avatar_id']);
        assert.ok(r.json().error.request_id, 'reached lanehub');
        assert.equal(generations.at(-1).avatar_id, 'Iv_Only');
      } finally { await coldApp.close(); }
    });

    await t.test('idempotency: replay with the same client body is request_already_received even though presigned URLs differ', async () => {
      const key = 'idem:' + randomUUID(), payload = { model: 'heygen-image', photo_asset_id: photo, audio_asset_id: audioId, background_asset_id: bg };
      assert.equal((await call(alice, 'POST', '/api/me/videos/generations', payload, { 'idempotency-key': key })).statusCode, 200);
      const sent = generations.length, firstUrl = generations.at(-1).image_urls[0];
      const replay = await call(alice, 'POST', '/api/me/videos/generations', payload, { 'idempotency-key': key });
      assert.deepEqual([replay.statusCode, replay.json().error.code], [409, 'request_already_received']);
      const changed = await call(alice, 'POST', '/api/me/videos/generations', { ...payload, resolution: '1080p' }, { 'idempotency-key': key });
      assert.deepEqual([changed.statusCode, changed.json().error.code], [409, 'idempotency_conflict']);
      assert.equal(generations.length, sent, 'nothing resubmitted');
      assert.notEqual(r2.storage.getUrl('u/x/orig.png', 3600), r2.storage.getUrl('u/x/orig.png', 3600), 'fixture really signs differently each time');
      assert.ok(firstUrl.includes('X-Amz-Signature'));
      assert.equal(await count('SELECT count(*)::int AS n FROM generation_records g JOIN requests r ON r.id=g.request_id WHERE r.idempotency_key=$1', [key]), 1);
    });

    await t.test('bearer /v1/videos/generations: avatar models without prompt, lanehub field names, user-side errors mapped', async () => {
      const token = 'ipz_' + 'b'.repeat(43);
      await db.query(`INSERT INTO access_tokens (id,user_id,token_hash,prefix,name) VALUES ($1,$2,$3,'ipz_bbbb','desktop')`, [randomUUID(), bob, hash(token)]);
      const bearer = (payload, headers = {}) => app.inject({ url: '/v1/videos/generations', method: 'POST', payload, headers: { authorization: 'Bearer ' + token, ...headers } });
      const body = { model: 'heygen-image', image_urls: ['https://cdn.example/p.png'], audio_url: 'https://cdn.example/a.mp3', background_color: '#000000', captions: true };
      const ok = await bearer(body, { 'idempotency-key': 'b1' });
      assert.equal(ok.statusCode, 200, ok.body);
      assert.deepEqual(generations.at(-1), body, 'forwarded as-is (lanehub names)');
      assert.equal((await db.query('SELECT count(*)::int AS n FROM generation_records WHERE user_id=$1', [bob])).rows[0].n, 0, 'no studio record for token clients');
      assert.equal((await bearer(body, { 'idempotency-key': 'b1' })).json().error.code, 'request_already_received');
      assert.equal((await bearer({ model: 'heygen-avatar', avatar_id: 'Abigail_2024', script: '你好' })).statusCode, 200);
      const before = await count('SELECT count(*)::int AS n FROM requests WHERE user_id=$1', [bob]);
      const e = async (payload) => { const r = await bearer(payload); assert.equal(r.statusCode, 400, r.body); return [r.json().error.code, r.json().error.field]; };
      assert.deepEqual(await e({ ...body, audio_url: undefined }), ['avatar_voice_required', 'script|audio_url']);
      assert.deepEqual(await e({ ...body, script: 'hi', audio_url: undefined }), ['voice_id_required', 'voice_id']);
      assert.deepEqual(await e({ ...body, prompt: 'hello' }), ['avatar_prompt_not_supported', 'prompt']);
      assert.deepEqual(await e({ ...body, image_urls: undefined, avatar_id: 'a' }), ['avatar_source_unsupported', 'avatar_id']);
      assert.equal((await bearer({ model: 'heygen-avatar', script: 'hi' })).json().error.code, 'avatar_source_required');
      assert.equal(await count('SELECT count(*)::int AS n FROM requests WHERE user_id=$1', [bob]), before, '4xx before any request row');
      const consent = await bearer({ model: 'heygen-avatar', avatar_id: 'Private_1', script: 'consent' });
      assert.deepEqual([consent.statusCode, consent.json().error.code], [400, 'avatar_consent_required']);
    });

    await t.test('queue (draft): avatar fields accepted, gaps listed in issues; shape / ownership / type still 400', async () => {
      const bobAudio2 = (await db.query(`INSERT INTO media_assets(user_id,kind,source,status,object_key,content_type,bytes,duration_ms)
        VALUES($1::uuid,'audio','upload','ready','u/'||$1::text||'/y/orig.mp3','audio/mpeg',10,3000) RETURNING id`, [bob])).rows[0].id;
      const draft = { item_id: randomUUID(), kind: 'video', model: 'heygen-image', prompt: '', photo_asset_id: photo, captions: true, params: { aspect_ratio: '9:16' } };
      const full = { item_id: randomUUID(), kind: 'video', model: 'heygen-avatar', prompt: '', avatar_id: 'Abigail_2024', audio_asset_id: audioId, background_asset_id: bg };
      const empty = { item_id: randomUUID(), kind: 'video', model: 'heygen-image', prompt: '' };
      const rev = (await call(alice, 'GET', '/api/me/queue')).json().revision;
      const saved = await call(alice, 'PUT', '/api/me/queue', { items: [draft, full, empty], revision: rev });
      assert.equal(saved.statusCode, 200, saved.body);
      const items = saved.json().items;
      assert.deepEqual(items[0].issues, [{ code: 'avatar_voice_required', field: 'script|audio_asset_id', message: items[0].issues[0].message }]);
      assert.deepEqual(items[1].issues, []);
      assert.deepEqual(items[2].issues.map((i) => i.field), ['photo_asset_id', 'script|audio_asset_id']);
      const again = await call(alice, 'PUT', '/api/me/queue', { items, revision: saved.json().revision });
      assert.equal(again.statusCode, 200, 'echoing issues back is fine');
      assert.ok(!JSON.stringify((await db.query('SELECT items FROM composer_queues WHERE user_id=$1', [alice])).rows[0].items).includes('issues'), 'issues not stored');
      const r0 = again.json().revision;
      const bad = async (patch, code) => {
        const r = await call(alice, 'PUT', '/api/me/queue', { items: [{ ...draft, ...patch }], revision: r0 });
        assert.equal(r.statusCode, 400, code + r.body); assert.equal(r.json().error.code, code); assert.equal(r.json().error.index, 0);
      };
      await bad({ photo_asset_id: await image(alice, 'image/webp') }, 'avatar_photo_unsupported_type');
      await bad({ photo_asset_id: await image(bob) }, 'avatar_photo_not_found');
      await bad({ audio_asset_id: bobAudio2 }, 'audio_asset_not_found');
      await bad({ audio_asset_id: photo }, 'audio_asset_not_found');
      await bad({ background_asset_id: await image(alice, 'image/webp') }, 'background_unsupported_type');
      await bad({ photo_asset_id: 'nope' }, 'invalid_photo_asset_id');
      await bad({ photo_asset_id: { slot: 0 } }, 'invalid_photo_asset_id');
      await bad({ prompt: 'talk' }, 'avatar_prompt_not_supported');
      await bad({ avatar_id: 'Abigail_2024' }, 'avatar_source_conflict');
      await bad({ script: 'x'.repeat(5001) }, 'script_too_long');
      await bad({ script: 'x', audio_asset_id: audioId }, 'avatar_voice_conflict');
      await bad({ reference_asset_ids: [photo] }, 'unsupported_parameter');
      await bad({ model: 'heygen-avatar' }, 'avatar_source_unsupported');
      await db.query("UPDATE media_assets SET status='deleted' WHERE id=$1", [bg]);
      const got = (await call(alice, 'GET', '/api/me/queue')).json().items;
      assert.deepEqual([got[0].missing, got[1].missing], [undefined, true], 'deleted background flags the item');
      await db.query("UPDATE media_assets SET status='ready' WHERE id=$1", [bg]);
    });

    await t.test('templates (strict): avatar items must be sendable; {slot} placeholders count as given', async () => {
      const item = { item_id: randomUUID(), kind: 'video', model: 'heygen-image', prompt: '', photo_asset_id: { slot: 0 }, audio_asset_id: { slot: 1 }, background_asset_id: bg };
      const created = await call(alice, 'POST', '/api/me/templates', { name: '口播模板', items: [item] });
      assert.equal(created.statusCode, 200, created.body);
      assert.deepEqual(created.json().items[0].photo_asset_id, { slot: 0 });
      const code = async (patch) => (await call(alice, 'POST', '/api/me/templates', { name: 't', items: [{ ...item, ...patch }] })).json().error?.code ?? 'ok';
      assert.equal(await code({ audio_asset_id: undefined }), 'avatar_voice_required');
      assert.equal(await code({ audio_asset_id: undefined, script: '{{文案}}' }), 'voice_id_required');
      assert.equal(await code({ audio_asset_id: undefined, script: '{{文案}}', voice_id: 'zh_v1' }), 'ok');
      assert.equal(await code({ photo_asset_id: { slot: 15 } }), 'invalid_photo_asset_id');
      assert.equal(await code({ photo_asset_id: { slot: 0, x: 1 } }), 'invalid_photo_asset_id');
      assert.equal(await code({ photo_asset_id: await image(bob) }), 'avatar_photo_not_found');
      assert.equal(await code({ background_asset_id: await image(alice, 'image/webp') }), 'background_unsupported_type');
      assert.equal(await code({ references: [{ slot: 0 }] }), 'unsupported_parameter');
    });

    await t.test('task sync + archive: success only with a real video; mp4 archived, jpg skipped, thumbnail becomes poster', async () => {
      const task = libraryAudioTask.task_id;
      const tick = async () => { await db.query("UPDATE media_tasks SET updated_at=now()-interval '1 minute' WHERE id=$1", [task]); await refreshMediaTask(db, upstream, task); };
      taskResult = { thumbnails: [{ url: ['https://cdn.test/thumb.jpg'] }] };
      await tick();
      assert.deepEqual(Object.values((await db.query('SELECT status,failure_code FROM generation_records WHERE id=$1', [libraryAudioTask.id])).rows[0]), ['failed', 'video_result_missing']);
      await db.query("UPDATE generation_records SET status='running',failure_code=NULL WHERE id=$1", [libraryAudioTask.id]);
      await db.query("UPDATE media_tasks SET status='processing',result=NULL WHERE id=$1", [task]);
      taskResult = { videos: [{ url: ['https://cdn.test/poster-as-video'] }, { url: ['https://cdn.test/still.jpg'] }, { url: ['https://cdn.test/out.mp4'] }],
        thumbnails: [{ url: ['https://cdn.test/thumb.jpg'] }], subtitles: [{ url: ['https://cdn.test/c.srt'] }], captioned_videos: [{ url: ['https://cdn.test/out_caption.mp4'] }] };
      await tick();
      assert.equal((await db.query('SELECT status FROM generation_records WHERE id=$1', [libraryAudioTask.id])).rows[0].status, 'succeeded');
      const fetched = [];
      await syncImageArchives(db, r2.storage, async (url) => { fetched.push(url); return { type: 'image/jpeg', body: Readable.from([fixture('small.jpg')]) }; },
        async (url) => { fetched.push(url); return url.endsWith('.mp4') ? { type: 'video/mp4', body: Readable.from([fixture('faststart.mp4')]) } : { type: 'image/jpeg', body: Readable.from([fixture('small.jpg')]) }; },
        async (url) => { fetched.push(url); return '1\n00:00:00,000 --> 00:00:02,000\n大家好\n'; });
      assert.ok(!fetched.includes('https://cdn.test/still.jpg'), 'image URL in videos[] is not even downloaded');
      const assets = (await db.query('SELECT * FROM media_assets WHERE task_id=$1', [task])).rows;
      assert.deepEqual(assets.map((a) => [a.kind, a.content_type, a.result_index]).sort((x, y) => x[2] - y[2]), [['video', 'video/mp4', 1], ['video', 'video/mp4', 2]], 'main + captioned');
      assert.match((await db.query('SELECT params FROM generation_records WHERE id=$1', [libraryAudioTask.id])).rows[0].params.subtitles_srt, /大家好/);
      assets.sort((x, y) => x.result_index - y.result_index);
      const poster = (await db.query('SELECT * FROM media_assets WHERE id=$1', [assets[0].poster_id])).rows[0];
      assert.deepEqual([poster.kind, poster.source, poster.content_type], ['image', 'poster', 'image/jpeg']);
      assert.equal((await db.query('SELECT state FROM image_archives WHERE task_id=$1', [task])).rows[0].state, 'completed');
    });

    await t.test('subjects: avatar kind with HeyGen reference or PNG/JPEG photos', async () => {
      const ref = { provider: 'heygen', avatar_id: 'Abigail_2024', name: 'Abigail', preview_image_url: 'https://h.test/a.jpg' };
      const created = await call(alice, 'POST', '/api/me/subjects', { name: '主播A', kind: 'avatar', external_ref: ref });
      assert.equal(created.statusCode, 200, created.body);
      assert.deepEqual(created.json().external_ref, { ...ref, preview_video_url: null }); assert.deepEqual(created.json().assets, []);
      assert.deepEqual((await call(alice, 'GET', '/api/me/subjects')).json().items[0].external_ref.avatar_id, 'Abigail_2024');
      const code = async (b) => (await call(alice, 'POST', '/api/me/subjects', { name: 'x' + randomUUID().slice(0, 8), ...b })).json().error?.code ?? 'ok';
      assert.equal(await code({ kind: 'avatar' }), 'avatar_source_required');
      assert.equal(await code({ kind: 'avatar', external_ref: ref, asset_ids: [photo] }), 'avatar_source_conflict');
      assert.equal(await code({ kind: 'avatar', asset_ids: [await image(alice, 'image/webp')] }), 'avatar_photo_unsupported_type');
      assert.equal(await code({ kind: 'avatar', asset_ids: [photo] }), 'ok');
      assert.equal(await code({ kind: 'person', external_ref: ref }), 'invalid_external_ref');
      assert.equal(await code({ kind: 'avatar', external_ref: { ...ref, provider: 'other' } }), 'invalid_external_ref');
      assert.equal(await code({ kind: 'avatar', external_ref: { ...ref, preview_image_url: 'http://insecure' } }), 'invalid_external_ref');
      const id = created.json().id;
      assert.equal((await call(alice, 'PUT', `/api/me/subjects/${id}/assets`, { asset_ids: [photo] })).json().error.code, 'avatar_source_conflict');
      assert.equal((await call(alice, 'PATCH', `/api/me/subjects/${id}`, { external_ref: { ...ref, avatar_id: 'Other_1' } })).json().external_ref.avatar_id, 'Other_1');
      assert.equal((await call(alice, 'PATCH', `/api/me/subjects/${id}`, { kind: 'person' })).json().error.code, 'invalid_external_ref');
      assert.equal((await call(alice, 'PATCH', `/api/me/subjects/${id}`, { kind: 'person', external_ref: null })).json().kind, 'person');
      // kind → avatar re-validates what the subject already holds.
      const person = async (assetIds) => (await call(alice, 'POST', '/api/me/subjects', { name: 'p' + randomUUID().slice(0, 8), kind: 'person', ...(assetIds ? { asset_ids: assetIds } : {}) })).json().id;
      const patch = async (sid, b) => { const r = await call(alice, 'PATCH', `/api/me/subjects/${sid}`, b); return r.json().error?.code ?? r.json().kind; };
      const webpSubject = await person([photo, await image(alice, 'image/webp')]);
      assert.equal(await patch(webpSubject, { kind: 'avatar' }), 'avatar_photo_unsupported_type');
      assert.equal((await call(alice, 'GET', '/api/me/subjects')).json().items.find((x) => x.id === webpSubject).kind, 'person', 'unchanged');
      assert.equal(await patch(webpSubject, { kind: 'avatar', external_ref: ref }), 'avatar_source_conflict');
      assert.equal(await patch(await person([photo, bg]), { kind: 'avatar' }), 'avatar');
      const bare = await person();
      assert.equal(await patch(bare, { kind: 'avatar' }), 'avatar_source_required');
      assert.equal(await patch(bare, { kind: 'avatar', external_ref: ref }), 'avatar');
      assert.equal(await patch(id, { kind: 'avatar', external_ref: ref }), 'avatar', 'back to avatar with a reference');
    });
  } finally {
    await app?.close(); await db.close(); await setup.query(`DROP SCHEMA ${schema} CASCADE`); await setup.close();
    await rm(dir, { recursive: true, force: true });
  }
});
