import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn as realSpawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { backoffMs, runProcess, runThumbJobs, drainThumbJobs, thumbConcurrency, thumbPriority, thumbnailAsset } from '../src/media-thumbs.mjs';
import { probeMedia } from '../src/media-probe.mjs';

const webpHeader = (w, h) => { const b = Buffer.alloc(30); b.write('RIFF', 0); b.write('WEBP', 8); b.write('VP8X', 12); b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3); return b; };

// Child-process double: handler(call) → { outputs:[Buffer per output pipe], code, stderr } or { hang:true }.
function fakeSpawn(handler) {
  const calls = [];
  const spawn = (bin, argv, opts) => {
    const child = new EventEmitter();
    child.stdio = opts.stdio.map(m => m === 'pipe' ? new PassThrough() : null);
    child.stderr = child.stdio[2];
    const close = (code, sig) => setImmediate(() => child.emit('close', code, sig));
    child.kill = sig => { child.killedWith = sig; close(null, sig); };
    const call = { bin, argv, stdio: opts.stdio, child }; calls.push(call);
    const r = handler(call);
    if (!r.hang) setImmediate(() => {
      (r.outputs ?? []).forEach((b, i) => child.stdio[i === 0 ? 1 : i + 2].end(b));
      if (r.stderr) child.stderr.write(r.stderr);
      close(r.code ?? 0, null);
    });
    return child;
  };
  return { spawn, calls };
}
const probeJson = (width, height, extra = {}) => ({ outputs: [Buffer.from(JSON.stringify({ streams: [{ codec_type: 'video', width, height, ...extra.stream }], format: extra.format ?? {} }))] });
const fakeR2 = () => { const puts = []; return { puts, getUrl: key => 'https://r2.example/' + key, async put(key, body, type, o) { puts.push({ key, body, type, ...o }); } }; };
const image = (over = {}) => ({ id: 'a1', kind: 'image', content_type: 'image/png', bytes: '1000', object_key: 'u/U/a1/orig.png', ...over });
const opts = (spawn, r2) => ({ r2, spawn, ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', format: 'webp', timeoutMs: 60_000, nice: null });

test('image job: args array, both widths in one ffmpeg process, uploads with cache control', async () => {
  const { spawn, calls } = fakeSpawn(c => c.argv.includes('-show_streams') ? probeJson(2000, 1000) : { outputs: [webpHeader(480, 240), webpHeader(960, 480)] });
  const r2 = fakeR2();
  const result = await thumbnailAsset(image(), opts(spawn, r2));
  assert.deepEqual(result, { variants: { w480: 'u/U/a1/w480.webp', w960: 'u/U/a1/w960.webp' }, meta: { width: 2000, height: 1000, duration_ms: null } });
  const [probe, ff] = calls;
  assert.equal(probe.bin, 'ffprobe'); assert.equal(ff.bin, 'ffmpeg');
  assert.deepEqual(ff.stdio, ['ignore', 'pipe', 'pipe', 'pipe'], 'second output on fd 3');
  const at = f => ff.argv[ff.argv.indexOf(f) + 1];
  assert.equal(at('-i'), 'https://r2.example/u/U/a1/orig.png'); assert.equal(at('-f'), 'png_pipe');
  assert.equal(at('-rw_timeout'), '15000000'); assert.equal(at('-threads'), '1');
  assert.equal(at('-filter_complex'), "[0:v]split=2[s0][s1];[s0]scale=w='min(480,iw)':h=-2:flags=lanczos[o0];[s1]scale=w='min(960,iw)':h=-2:flags=lanczos[o1]");
  assert.deepEqual(ff.argv.slice(-13), ['-map', '[o1]', '-frames:v', '1', '-threads', '1', '-c:v', 'libwebp', '-quality', '80', '-f', 'webp', 'pipe:3']);
  assert.ok(ff.argv.includes('pipe:1') && ff.argv.at(-1) === 'pipe:3');
  assert.deepEqual(r2.puts.map(p => [p.key, p.type, p.cacheControl]), [['u/U/a1/w480.webp', 'image/webp', 'private, max-age=21600'], ['u/U/a1/w960.webp', 'image/webp', 'private, max-age=21600']]);

  const niced = fakeSpawn(() => probeJson(10, 10));
  await thumbnailAsset(image(), { ...opts(niced.spawn, fakeR2()), nice: '/usr/bin/nice' });
  assert.deepEqual(niced.calls[0].argv.slice(0, 3), ['-n', '10', 'ffprobe']); assert.equal(niced.calls[0].bin, '/usr/bin/nice');
});

test('no upscale, rotation-aware drop, pixel and byte guards', async () => {
  const small = fakeSpawn(() => probeJson(480, 300));
  assert.deepEqual((await thumbnailAsset(image(), opts(small.spawn, fakeR2()))).variants, {});
  assert.equal(small.calls.length, 1, 'no ffmpeg run when every width would upscale');

  // 700x1000 portrait: 960 < long side so both are attempted; w960 comes back 700 wide and is dropped.
  const mid = fakeSpawn(c => c.argv.includes('-show_streams') ? probeJson(700, 1000) : { outputs: [webpHeader(480, 686), webpHeader(700, 1000)] });
  const r2 = fakeR2();
  assert.deepEqual((await thumbnailAsset(image(), opts(mid.spawn, r2))).variants, { w480: 'u/U/a1/w480.webp' });
  assert.deepEqual(r2.puts.map(p => p.key), ['u/U/a1/w480.webp']);

  const big = fakeSpawn(() => { throw new Error('must not spawn'); });
  await assert.rejects(thumbnailAsset(image({ bytes: String(60 * 1024 * 1024 + 1) }), opts(big.spawn, fakeR2())), { skip: true, message: 'image_too_large' });
  await assert.rejects(thumbnailAsset(image(), opts(fakeSpawn(() => probeJson(8193, 100)).spawn, fakeR2())), { skip: true, message: 'too_many_pixels' });
  const edge = fakeSpawn(c => c.argv.includes('-show_streams') ? probeJson(4096, 4096) : { outputs: [webpHeader(480, 480), webpHeader(960, 960)] });
  assert.deepEqual(Object.keys((await thumbnailAsset(image(), opts(edge.spawn, fakeR2()))).variants), ['w480', 'w960'], '4096² is allowed');
  const junk = fakeSpawn(c => c.argv.includes('-show_streams') ? probeJson(2000, 1000) : { outputs: [Buffer.from('nope'), webpHeader(960, 480)] });
  await assert.rejects(thumbnailAsset(image(), opts(junk.spawn, fakeR2())), { message: 'bad_ffmpeg_output' });
});

test('video job: ffprobe metadata, seek min(1s, duration/2), poster + w480', async () => {
  for (const [duration, ss] of [['5.0', '1'], ['1.2', '0.6']]) {
    const { spawn, calls } = fakeSpawn(c => c.argv.includes('-show_streams')
      ? probeJson(1920, 1080, { format: { duration }, stream: { side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }] } })
      : { outputs: [webpHeader(960, 540), webpHeader(480, 270)] });
    const r2 = fakeR2();
    const row = { id: 'v1', kind: 'video', content_type: 'video/mp4', bytes: '1', object_key: 'u/U/v1/orig.mp4' };
    const result = await thumbnailAsset(row, opts(spawn, r2));
    assert.deepEqual(result, { variants: { poster: 'u/U/v1/poster.webp', w480: 'u/U/v1/w480.webp' },
      meta: { width: 1080, height: 1920, duration_ms: Number(duration) * 1000 } });
    const ff = calls[1].argv;
    assert.equal(ff[ff.indexOf('-ss') + 1], ss); assert.ok(ff.indexOf('-ss') < ff.indexOf('-i'), 'input seek');
    assert.equal(ff[ff.indexOf('-f') + 1], 'mov');
  }
});

test('process runner: SIGKILL on timeout, stderr truncated to 2KB, non-zero exit', async () => {
  const hang = fakeSpawn(() => ({ hang: true }));
  await assert.rejects(runProcess(hang.spawn, 'ffmpeg', ['-x'], { timeoutMs: 20, nice: null }), { message: 'timeout' });
  assert.equal(hang.calls[0].child.killedWith, 'SIGKILL');
  const fail = fakeSpawn(() => ({ code: 1, stderr: 'e'.repeat(5000) + 'TAIL' }));
  const err = await runProcess(fail.spawn, 'ffmpeg', [], { nice: null }).catch(e => e);
  assert.equal(err.message, 'exit_1'); assert.equal(err.stderr.length, 2048); assert.ok(err.stderr.endsWith('TAIL'));
});

test('backoff schedule and single-flight loop', async () => {
  assert.deepEqual([1, 2, 3, 4].map(backoffMs), [60_000, 300_000, 1_800_000, 7_200_000]);
  let release;
  const db = { queries: 0, query() { this.queries++; return new Promise(r => { release = () => r({ rows: [] }); }); } };
  const first = runThumbJobs({ db, r2: fakeR2(), format: 'webp' });
  assert.equal(await runThumbJobs({ db, r2: fakeR2(), format: 'webp' }), null, 'busy: second call returns at once');
  assert.equal(db.queries, 1);
  release(); assert.equal(await first, null);
});

// Real ffmpeg against a local HTTP origin. Uses whatever encoder the build has (libwebp in the image, jpg fallback otherwise).
const hasFfmpeg = !spawnSync('ffmpeg', ['-version']).error && !spawnSync('ffprobe', ['-version']).error;
test('real ffmpeg: PNG, EXIF-rotated JPEG and MP4 over HTTP', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'thumbs-'));
  const gen = (args, out) => { const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args, join(dir, out)]); assert.equal(r.status, 0, String(r.stderr)); };
  gen(['-f', 'lavfi', '-i', 'testsrc=size=1200x800:rate=1', '-frames:v', '1'], 'orig.png');
  gen(['-f', 'lavfi', '-i', 'testsrc=size=1000x500:rate=1', '-frames:v', '1'], 'base.jpg');
  gen(['-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25', '-t', '2', '-pix_fmt', 'yuv420p', '-c:v', 'mpeg4'], 'orig.mp4');
  // EXIF APP1 with Orientation=6 (rotate 90° CW) inserted after SOI.
  const tiff = Buffer.from([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0]);
  const app1 = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]), jpg = readFileSync(join(dir, 'base.jpg'));
  writeFileSync(join(dir, 'orig.jpg'), Buffer.concat([jpg.subarray(0, 2), Buffer.from([0xff, 0xe1, 0, app1.length + 2]), app1, jpg.subarray(2)]));
  // Honours Range like R2: ffmpeg seeks to a tail moov and to -ss offsets.
  const server = createServer((req, res) => {
    let body; try { body = readFileSync(join(dir, req.url.split('/').pop())); } catch { res.statusCode = 404; return res.end(); }
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
    if (!m) return res.writeHead(200, { 'content-length': body.length, 'accept-ranges': 'bytes' }).end(body);
    const start = Number(m[1]), end = m[2] ? Number(m[2]) : body.length - 1;
    res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${body.length}`, 'content-length': end - start + 1 }).end(body.subarray(start, end + 1));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const format = /\blibwebp\b/.test(spawnSync('ffmpeg', ['-hide_banner', '-encoders']).stdout) ? 'webp' : 'jpg';
  const r2 = { puts: new Map(), getUrl: key => `http://127.0.0.1:${server.address().port}/${key}`, async put(key, body) { this.puts.set(key, body); } };
  const dims = async key => { const b = r2.puts.get(key); const i = await probeMedia(b, b.length, async (s, e) => b.subarray(s, e + 1)); return [i.contentType, i.width, i.height]; };
  const type = format === 'webp' ? 'image/webp' : 'image/jpeg';
  try {
    const o = { r2, spawn: realSpawn, ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', format, timeoutMs: 60_000 };
    let r = await thumbnailAsset({ kind: 'image', content_type: 'image/png', bytes: '1', object_key: 'orig.png' }, o);
    assert.deepEqual(Object.keys(r.variants), ['w480', 'w960']);
    assert.deepEqual(await dims(r.variants.w480), [type, 480, 320]); assert.deepEqual(await dims(r.variants.w960), [type, 960, 640]);
    if (format === 'webp') assert.equal(r2.puts.get(r.variants.w480).toString('latin1', 8, 12), 'WEBP');
    r = await thumbnailAsset({ kind: 'image', content_type: 'image/jpeg', bytes: '1', object_key: 'orig.jpg' }, o);
    assert.deepEqual(Object.keys(r.variants), ['w480'], 'displayed width is 500: w960 would upscale');
    assert.deepEqual(await dims(r.variants.w480), [type, 480, 960], 'EXIF orientation applied');
    r = await thumbnailAsset({ kind: 'video', content_type: 'video/mp4', bytes: '1', object_key: 'orig.mp4' }, o);
    assert.deepEqual(r.meta, { width: 640, height: 360, duration_ms: 2000 });
    assert.deepEqual(await dims(r.variants.poster), [type, 640, 360]); assert.deepEqual(await dims(r.variants.w480), [type, 480, 270]);
    await assert.rejects(thumbnailAsset({ kind: 'image', content_type: 'image/png', bytes: '1', object_key: 'missing.png' }, o), e => !e.skip && e.stderr.length > 0);
  } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
});

// Fake queue db: claims pop `jobs` in order (the claim SQL is recorded); completion updates are counted.
function queueDb(jobs) {
  const claims = [], updates = [];
  return { claims, updates, async query(sql) {
    if (sql.includes('thumb_attempts=thumb_attempts+1')) { claims.push(sql); const job = jobs.shift(); return { rows: job ? [job] : [] }; }
    updates.push(sql); return { rows: [] };
  } };
}
const smallImage = id => ({ ...image({ id, object_key: `u/U/${id}/orig.png` }), thumb_attempts: 1 });

// Counts live child processes (spawn → close); each process closes after `ms` so concurrent workers really overlap.
function countingSpawn(ms = 0) {
  const live = { now: 0, peak: 0 };
  const { spawn } = fakeSpawn(() => ({ hang: true }));
  return { live, spawn: (bin, argv, o) => {
    const c = spawn(bin, argv, o);
    live.peak = Math.max(live.peak, ++live.now);
    setTimeout(() => { c.stdio[1].end(probeJson(10, 10).outputs[0]); live.now--; c.emit('close', 0, null); }, ms);
    return c;
  } };
}

test('drain: keeps claiming until the queue is empty, one ffmpeg at a time by default', async () => {
  const { spawn, live } = countingSpawn(2);
  const db = queueDb(['a', 'b', 'c'].map(smallImage));
  assert.equal(await drainThumbJobs({ db, r2: fakeR2(), spawn, format: 'webp', nice: null }), 3);
  assert.equal(db.claims.length, 4, 'three jobs + the empty claim that ends the drain');
  assert.equal(live.peak, 1);
});

test('drain: stops at the time budget even if jobs remain', async () => {
  let t = 0;
  const db = queueDb(['a', 'b', 'c', 'd'].map(smallImage));
  const { spawn } = fakeSpawn(() => { t += 2000; return probeJson(10, 10); });
  assert.equal(await drainThumbJobs({ db, r2: fakeR2(), spawn, format: 'webp', nice: null, budgetMs: 4500, clock: () => t }), 3);
  assert.equal(db.claims.length, 3, 'no claim after the budget is spent');
});

test('concurrency: cap shared across overlapping drains; env clamps to 1..2; priority orders case jobs last', async () => {
  const { spawn, live } = countingSpawn(5);
  const db = queueDb(['a', 'b', 'c', 'd', 'e', 'f'].map(smallImage));
  const opts = { db, r2: fakeR2(), spawn, format: 'webp', nice: null, concurrency: 2 };
  const [x, y] = await Promise.all([drainThumbJobs(opts), drainThumbJobs(opts)]);
  assert.equal(x + y, 6); assert.equal(live.peak, 2, 'never more than two processes, even with two overlapping drains');
  assert.deepEqual([undefined, '0', '1', '2', '3', 'x'].map(v => thumbConcurrency({ THUMB_CONCURRENCY: v })), [1, 1, 1, 2, 2, 1]);
  assert.deepEqual([undefined, '1', '0'].map(v => thumbPriority({ THUMB_PRIORITY: v })), [true, true, false]);
  assert.match(db.claims[0], /ORDER BY \(source='case'\),thumb_next_at/);
  const fifo = queueDb([]);
  await runThumbJobs({ db: fifo, r2: fakeR2(), format: 'webp', priority: false });
  assert.match(fifo.claims[0], /ORDER BY thumb_next_at/);
});
