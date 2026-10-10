import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
import { probeMedia } from '../src/media-probe.mjs';
import { presignUrl, authorization, slicedWindow, createR2Storage } from '../src/r2-storage.mjs';
import { createApp } from '../src/app.mjs';

const fixture = name => readFileSync(new URL('./fixtures/' + name, import.meta.url));
const ranged = b => async (s, e) => b.subarray(s, e + 1);

test('magic bytes and dimensions for PNG, JPEG, WebP and MP4 (moov at head or tail)', async () => {
  for (const [name, expected] of [
    ['pixel.png', { contentType: 'image/png', width: 1, height: 1, duration_ms: null }],
    ['small.jpg', { contentType: 'image/jpeg', width: 3, height: 2, duration_ms: null }],
    ['pixel.webp', { contentType: 'image/webp', width: 1, height: 1, duration_ms: null }],
    ['faststart.mp4', { contentType: 'video/mp4', width: 32, height: 18, duration_ms: 500 }],
    ['tail-moov.mp4', { contentType: 'video/mp4', width: 32, height: 18, duration_ms: 500 }],
  ]) {
    const b = fixture(name);
    assert.deepEqual(await probeMedia(b, b.length, ranged(b)), expected, name);
  }
  // Only 16 head bytes: the tail moov must be located and fetched through Range reads.
  const mp4 = fixture('tail-moov.mp4'), reads = [];
  const info = await probeMedia(mp4.subarray(0, 16), mp4.length, async (s, e) => { reads.push([s, e]); return mp4.subarray(s, e + 1); });
  assert.equal(info.duration_ms, 500);
  assert.ok(reads.some(([s]) => s === 124), 'reads the moov box at its tail offset');
  // VP8X (extended) WebP header: canvas 1000x700.
  const vp8x = Buffer.alloc(30); vp8x.write('RIFF', 0); vp8x.write('WEBP', 8); vp8x.write('VP8X', 12);
  vp8x.writeUIntLE(999, 24, 3); vp8x.writeUIntLE(699, 27, 3);
  assert.deepEqual(await probeMedia(vp8x, 30, ranged(vp8x)), { contentType: 'image/webp', width: 1000, height: 700, duration_ms: null });
  assert.equal(await probeMedia(Buffer.from('<html>not an image</html>'), 25, ranged(Buffer.alloc(0))), null);
});

test('SigV4 known answers from the AWS S3 documentation', () => {
  const c = { host: 'examplebucket.s3.amazonaws.com', region: 'us-east-1', accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', date: new Date('2013-05-24T00:00:00Z') };
  assert.match(presignUrl({ ...c, method: 'GET', path: '/test.txt', expiresSec: 86400 }),
    /X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404$/);
  const empty = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  assert.match(authorization({ ...c, method: 'GET', path: '/test.txt', payloadHash: empty,
    headers: { range: 'bytes=0-9', 'x-amz-content-sha256': empty, 'x-amz-date': '20130524T000000Z' } }),
  /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
});

const config = { accountId: 'a'.repeat(32), bucket: 'ipzsk-media', accessKeyId: 'AKIDTEST', secretAccessKey: 'secret-test', archiveFrom: '2026-01-01T00:00:00Z' };

test('presigned PUT signs content-length and content-type into the canonical request', () => {
  const r2 = createR2Storage(config, fetch, () => new Date('2026-09-17T01:02:03Z'));
  const url = new URL(r2.presignPut('u/x/y/orig.png', { contentType: 'image/png', contentLength: 1234, expiresSec: 600 }));
  assert.equal(url.searchParams.get('X-Amz-SignedHeaders'), 'content-length;content-type;host');
  assert.equal(url.searchParams.get('X-Amz-Expires'), '600');
  // Rebuild the canonical request by hand; any drift in header order/format changes the signature.
  const query = url.search.slice(1).replace(/&X-Amz-Signature=.*$/, '');
  const canonical = `PUT\n/ipzsk-media/u/x/y/orig.png\n${query}\ncontent-length:1234\ncontent-type:image/png\nhost:${url.host}\n\ncontent-length;content-type;host\nUNSIGNED-PAYLOAD`;
  const h = (k, v) => createHmac('sha256', k).update(v).digest();
  const key = h(h(h(h('AWS4secret-test', '20260917'), 'auto'), 's3'), 'aws4_request');
  const sts = `AWS4-HMAC-SHA256\n20260917T010203Z\n20260917/auto/s3/aws4_request\n${createHash('sha256').update(canonical).digest('hex')}`;
  assert.equal(url.searchParams.get('X-Amz-Signature'), h(key, sts).toString('hex'));
});

test('put streams a large body: caller-supplied sha256 signs it, metadata and timeout ride along', async () => {
  const seen = [];
  const fetcher = async (url, init) => { seen.push({ url: String(url), init }); return new Response(null, { status: 200 }); };
  const r2 = createR2Storage(config, fetcher, () => new Date('2026-09-17T01:02:03Z'));
  const sha = 'd'.repeat(64);
  const blob = { size: 180_070_247 }; // 站位：真实调用传的是 openAsBlob 的文件 Blob，不进内存
  await r2.put('desktop/2.0.7/a.dmg', blob, 'application/octet-stream',
    { cacheControl: 'public, max-age=31536000, immutable', hash: sha, metadata: { sha256: sha }, timeout: 3_600_000 });
  const { init } = seen[0];
  assert.equal(init.body, blob, 'body 原样交给 fetch，没有被读成 Buffer');
  assert.equal(init.headers['x-amz-content-sha256'], sha, '签名用调用方算好的 hash');
  assert.equal(init.headers['x-amz-meta-sha256'], sha);
  assert.match(init.headers.authorization, /SignedHeaders=cache-control;content-type;host;x-amz-content-sha256;x-amz-date;x-amz-meta-sha256,/);
  assert.ok(init.signal instanceof AbortSignal);

  // 默认路径没被削弱：不传 timeout/hash 时仍是 30 秒、仍对 body 本身求 digest。
  seen.length = 0;
  await r2.put('u/x/y/orig.png', 'hi', 'image/png');
  assert.equal(seen[0].init.headers['x-amz-content-sha256'], createHash('sha256').update('hi').digest('hex'));
  assert.equal(seen[0].init.headers['x-amz-meta-sha256'], undefined);
});

test('time-sliced GET URLs are stable inside a slice and never near expiry', () => {
  let now = new Date('2026-09-17T06:00:00Z');
  const r2 = createR2Storage(config, fetch, () => now);
  const a = r2.presignGetSliced('u/x/y/orig.png');
  now = new Date('2026-09-17T11:29:59Z');
  assert.equal(r2.presignGetSliced('u/x/y/orig.png'), a, 'byte-identical within the slice');
  const q = new URL(a).searchParams;
  assert.equal(q.get('X-Amz-Date'), '20260917T060000Z'); assert.equal(q.get('X-Amz-Expires'), String(6 * 3600 + 1800));
  now = new Date('2026-09-17T11:45:00Z'); // < 30 min left: stays valid through the next slice
  const late = new URL(r2.presignGetSliced('u/x/y/orig.png')).searchParams;
  assert.equal(late.get('X-Amz-Date'), '20260917T060000Z'); assert.equal(late.get('X-Amz-Expires'), String(12 * 3600 + 1800));
  assert.equal(r2.presignGetSliced('u/x/y/orig.png'), r2.presignGetSliced('u/x/y/orig.png'));
  for (let t = Date.parse('2026-09-17T00:00:00Z'); t < Date.parse('2026-09-18T00:00:00Z'); t += 60_000) {
    const w = slicedWindow(new Date(t));
    assert.ok(w.date.getTime() <= t && w.expiresAt.getTime() - t >= 3600_000);
  }
});

test('CORS preflight covers public/admin/bearer prefixes and write methods; admin console stays same-origin', async () => {
  const app = await createApp({ db: {}, upstream: {}, scheduler: { keys: new Map(), accounts: new Map() }, origin: 'https://api.ipzsk.com' });
  app.get('/api/public/cache-probe', async (_req, reply) => { reply.header('Cache-Control', 'private, max-age=60'); return {}; });
  try {
    const preflight = (url, origin, method) => app.inject({ url, method: 'OPTIONS', headers: { origin, 'access-control-request-method': method } });
    for (const prefix of ['/api/auth/x', '/api/me/assets', '/api/account/status', '/api/public/cases', '/api/admin/cases',
      '/v1/images/generations', '/v1/videos/generations', '/api/videos/generations']) {
      for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
        const r = await preflight(prefix, 'https://www.ipzsk.com', method);
        assert.equal(r.statusCode, 204, prefix + method);
        assert.match(r.headers['access-control-allow-methods'], new RegExp(`\\b${method}\\b`));
        assert.equal(r.headers['access-control-allow-headers'], 'Authorization, Content-Type, Idempotency-Key, X-IPZSK-Plugin-Token, X-IPZSK-Skill-Version, X-IPZSK-Skill-Calls');
        assert.equal(r.headers['access-control-allow-origin'], 'https://www.ipzsk.com');
        assert.equal((await preflight(prefix, 'https://evil.example', method)).statusCode, 403);
      }
    }
    // the browser must be able to read the response too, including the 401 the site shows as "请先登录"
    const unauth = await app.inject({ url: '/v1/images/generations', method: 'POST', headers: { origin: 'https://www.ipzsk.com' }, payload: {} });
    assert.equal(unauth.statusCode, 401);
    assert.equal(unauth.headers['access-control-allow-origin'], 'https://www.ipzsk.com');
    const admin = await preflight('/admin/api/users', 'https://www.ipzsk.com', 'POST');
    assert.ok(admin.statusCode >= 400); assert.equal(admin.headers['access-control-allow-origin'], undefined);
    assert.equal((await app.inject({ url: '/api/public/cache-probe' })).headers['cache-control'], 'private, max-age=60');
  } finally { await app.close(); }
});

test('publicAddress: public unicast of either family, private ranges rejected', async () => {
  const { publicAddress } = await import('../src/image-results.mjs');
  for (const ip of ['108.157.254.86', '2600:9000:2753:e600:1a:6e0e:c180:93a1', '::ffff:8.8.8.8']) assert.equal(publicAddress(ip), true, ip);
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.20.0.2', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '::', '::1', 'fc00::1', 'fd12::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::a00:1', '2001:db8::1', 'not-an-ip'])
    assert.equal(publicAddress(ip), false, ip);
});
