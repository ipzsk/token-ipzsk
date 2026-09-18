import { createHash } from 'node:crypto';import { uploadDesktopRelease } from '../scripts/upload-desktop-release.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import Fastify from 'fastify';import {desktopReleaseRoutes,desktopDownloadRoutes,parseDesktopManifest} from '../src/desktop-releases.mjs';
test('desktop updates use the IPZSK release channel and exact-version downloads',async()=>{
 const app=Fastify();let calls=0;desktopReleaseRoutes(app,{readDesktopReleases:async()=>({stable:{version:'2.0.6',assets:{'darwin-arm64':'IPZSK-Desktop-2.0.6-arm64.dmg'}}}),desktopReleaseFetch:async(url,init)=>{calls++;assert.match(url,/github.com\/JayceHuang\/ipzsk-dsh-desktop\/releases\/download\/v2.0.6\//);assert.equal(init.headers,undefined);return new Response('fixture-image')}});
 try{assert.deepEqual((await app.inject({url:'/api/desktop/version',headers:{'x-ipzsk-platform':'darwin','x-ipzsk-arch':'arm64'}})).json(),{version:'2.0.6',channel:'stable'});assert.equal((await app.inject({url:'/api/desktop/version',headers:{'x-dsh-desktop-channel':'beta'}})).statusCode,404);assert.equal((await app.inject({url:'/api/desktop/download/mac',headers:{'x-dsh-desktop-target-version':'2.0.5'}})).statusCode,409);const response=await app.inject({url:'/api/desktop/download/mac',headers:{'x-dsh-desktop-target-version':'2.0.6','x-ipzsk-arch':'arm64'}});assert.equal(response.statusCode,200);assert.equal(response.body,'fixture-image');assert.equal(calls,1)}finally{await app.close()}
});

// ── 官网下载：/api/public/desktop-release ──
const SHA = 'a'.repeat(64);
const manifest = (over = {}) => ({ version: '2.0.8', released_at: '2026-09-18T00:00:00.000Z',
  files: [{ platform: 'mac', name: 'IPZSK.Desktop-2.0.8-arm64.dmg', bytes: 187_000_000, sha256: SHA }], ...over });

function stubStorage(objects) {
  return {
    getRange: async (key) => { const v = objects[key]; if (v === undefined) throw new Error('r2_get_failed'); return Buffer.from(v); },
    presignGetSliced: (key) => `https://r2.example/${key}?X-Amz-Signature=deadbeef`,
  };
}
const releaseApp = (objects) => { const app = Fastify(); desktopDownloadRoutes(app, { imageStorage: stubStorage(objects) }); return app; };

test('desktop-release manifest validation rejects anything the endpoint cannot sign safely', () => {
  const code = (doc) => { try { parseDesktopManifest(doc); return null; } catch (e) { return e.code; } };
  assert.deepEqual(parseDesktopManifest(manifest()), manifest());
  for (const bad of [null, [], 'x', manifest({ version: 'v2.0.8' }), manifest({ released_at: 'nope' }), manifest({ files: [] }),
    manifest({ files: [{ platform: 'linux', name: 'a.deb', bytes: 1, sha256: SHA }] }),
    manifest({ files: [{ platform: 'mac', name: '../../secrets/key', bytes: 1, sha256: SHA }] }),
    manifest({ files: [{ platform: 'mac', name: 'other/a.dmg', bytes: 1, sha256: SHA }] }),
    manifest({ files: [{ platform: 'mac', name: 'a.dmg', bytes: 0, sha256: SHA }] }),
    manifest({ files: [{ platform: 'mac', name: 'a.dmg', bytes: 1, sha256: 'short' }] }),
    manifest({ files: [{ platform: 'mac', name: 'a.dmg', bytes: 1, sha256: SHA }, { platform: 'mac', name: 'b.dmg', bytes: 1, sha256: SHA }] })]) {
    assert.equal(code(bad), 'desktop_release_unavailable', JSON.stringify(bad));
  }
});

test('desktop-release serves latest.json with signed URLs, ?version= serves a historical manifest', async () => {
  const app = releaseApp({
    'desktop/latest.json': JSON.stringify(manifest()),
    'desktop/2.0.7/manifest.json': JSON.stringify(manifest({ version: '2.0.7', files: [{ platform: 'mac', name: 'IPZSK.Desktop-2.0.7-arm64.dmg', bytes: 1, sha256: SHA }] })),
    'desktop/2.0.6/manifest.json': JSON.stringify(manifest()), // 版本不一致：当作没有这个发布
    'desktop/2.0.5/manifest.json': 'not json',
  });
  try {
    const latest = await app.inject({ url: '/api/public/desktop-release' });
    assert.equal(latest.statusCode, 200);
    assert.equal(latest.headers['cache-control'], 'private, max-age=300'); // 内含签名 URL
    assert.deepEqual(latest.json(), { ...manifest(), files: [{ ...manifest().files[0], url: 'https://r2.example/desktop/2.0.8/IPZSK.Desktop-2.0.8-arm64.dmg?X-Amz-Signature=deadbeef' }] });

    assert.equal((await app.inject({ url: '/api/public/desktop-release?version=2.0.7' })).json().version, '2.0.7');
    for (const [url, status, code] of [
      ['/api/public/desktop-release?version=2.0.9', 503, 'desktop_release_unavailable'], // 桶里没有
      ['/api/public/desktop-release?version=2.0.6', 503, 'desktop_release_unavailable'], // 内容与路径不符
      ['/api/public/desktop-release?version=2.0.5', 503, 'desktop_release_unavailable'], // 坏 JSON
      ['/api/public/desktop-release?version=../latest', 400, 'invalid_version'],
      ['/api/public/desktop-release?version=2.0', 400, 'invalid_version'],
    ]) {
      const r = await app.inject({ url });
      assert.equal(r.statusCode, status, url);
      assert.equal(r.json().error?.code ?? r.json().code, code, url);
    }
  } finally { await app.close() }
});

test('desktop-release without R2 configured is 503, never a raw storage error', async () => {
  const app = Fastify();
  desktopDownloadRoutes(app, {});
  try {
    const r = await app.inject({ url: '/api/public/desktop-release' });
    assert.equal(r.statusCode, 503);
    assert.match(JSON.stringify(r.json()), /desktop_release_unavailable/);
    assert.doesNotMatch(JSON.stringify(r.json()), /r2_|Signature/);
  } finally { await app.close() }
});

test('upload-desktop-release: sha256 + manifest + latest, skips an object already the right size', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const dir = await mkdtemp((await import('node:path')).join((await import('node:os')).tmpdir(), 'dsh-'));
  await writeFile(dir + '/IPZSK.Desktop-2.0.7-arm64.dmg', 'mac-arm');
  await writeFile(dir + '/DSH-Desktop-2.0.7-x64-Setup.exe', 'win');
  await writeFile(dir + '/latest.yml', 'ignored'); // 不是安装包
  const objects = new Map([['desktop/2.0.7/IPZSK.Desktop-2.0.7-arm64.dmg', 7]]);
  const puts = [];
  const storage = { head: async (k) => (objects.has(k) ? { bytes: objects.get(k) } : null),
    put: async (k, body) => { puts.push(k); objects.set(k, body.length); } };
  const manifest = await uploadDesktopRelease(storage, '2.0.7', dir, { releasedAt: '2026-09-01T00:00:00Z', log: () => {} });
  assert.deepEqual(manifest.files.map((f) => [f.platform, f.name, f.bytes]),
    [['windows', 'DSH-Desktop-2.0.7-x64-Setup.exe', 3], ['mac', 'IPZSK.Desktop-2.0.7-arm64.dmg', 7]]);
  assert.equal(manifest.files[1].sha256, createHash('sha256').update('mac-arm').digest('hex'));
  assert.deepEqual(puts, ['desktop/2.0.7/DSH-Desktop-2.0.7-x64-Setup.exe', 'desktop/2.0.7/manifest.json', 'desktop/latest.json'], 'arm64 dmg already uploaded');
  // 幂等：再跑一次不再传安装包，两份 JSON 内容不变。
  puts.length = 0;
  assert.deepEqual(await uploadDesktopRelease(storage, '2.0.7', dir, { releasedAt: '2026-09-01T00:00:00Z', log: () => {} }), manifest);
  assert.deepEqual(puts, ['desktop/2.0.7/manifest.json', 'desktop/latest.json']);
  await (await import('node:fs/promises')).rm(dir, { recursive: true });
});
