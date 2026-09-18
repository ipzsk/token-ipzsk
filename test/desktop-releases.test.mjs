import { createHash } from 'node:crypto';import { uploadDesktopRelease, uploadTimeoutMs } from '../scripts/upload-desktop-release.mjs';
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

test('upload-desktop-release: scales the timeout with size instead of the 30s default', () => {
  // 180MB 在默认 30 秒里必然超时（线上就是这么挂的）；按 50 KB/s 下限给时间。
  assert.equal(uploadTimeoutMs(0), 60_000);
  assert.ok(uploadTimeoutMs(180_070_247) > 55 * 60_000, '180MB 至少给到 55 分钟');
  assert.ok(uploadTimeoutMs(180_070_247) < 90 * 60_000, '也不能无限等');
});

test('upload-desktop-release: streams the file, records sha256, skips an object already identical', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-'));
  await writeFile(join(dir, 'IPZSK.Desktop-2.0.7-arm64.dmg'), 'mac-arm');
  await writeFile(join(dir, 'DSH-Desktop-2.0.7-x64-Setup.exe'), 'win');
  await writeFile(join(dir, 'latest.yml'), 'ignored'); // 不是安装包
  const macSha = createHash('sha256').update('mac-arm').digest('hex');
  const winSha = createHash('sha256').update('win').digest('hex');

  // 安装包用「像 Blob」的对象上传（只有 size，没有内容进内存）；两份 JSON 仍是 Buffer。
  const openBlob = async (path) => ({ size: (await (await import('node:fs/promises')).stat(path)).size, isBlob: true });
  const heads = new Map([['desktop/2.0.7/IPZSK.Desktop-2.0.7-arm64.dmg', { bytes: 7, sha256: macSha }]]);
  const puts = [];
  const storage = { head: async (k) => heads.get(k) ?? null, put: async (k, body, type, opts = {}) => { puts.push({ k, body, type, opts }); } };
  const run = () => uploadDesktopRelease(storage, '2.0.7', dir, { releasedAt: '2026-09-01T00:00:00Z', log: () => {}, openBlob });

  const manifest = await run();
  assert.deepEqual(manifest.files.map((f) => [f.platform, f.name, f.bytes]),
    [['windows', 'DSH-Desktop-2.0.7-x64-Setup.exe', 3], ['mac', 'IPZSK.Desktop-2.0.7-arm64.dmg', 7]]);
  assert.equal(manifest.files[1].sha256, macSha);
  assert.deepEqual(puts.map((p) => p.k), ['desktop/2.0.7/DSH-Desktop-2.0.7-x64-Setup.exe', 'desktop/2.0.7/manifest.json', 'desktop/latest.json'],
    'sha256 与大小都对得上的 arm64 dmg 不重传');

  const exe = puts[0];
  assert.deepEqual(exe.body, { size: 3, isBlob: true }, '安装包是流式 Blob，不是 Buffer');
  assert.equal(exe.opts.hash, winSha, '签名直接用算好的 sha256，不再把文件读进内存 digest');
  assert.deepEqual(exe.opts.metadata, { sha256: winSha }, '写进 x-amz-meta-sha256，下次好校验');
  assert.equal(exe.opts.timeout, uploadTimeoutMs(3));
  assert.match(exe.opts.cacheControl, /immutable/);
  assert.equal(puts[1].opts.timeout, undefined, '小 JSON 仍走默认 30s');

  // 大小一样但 sha256 对不上 ⇒ 必须重传；对象上没记 sha256（CI 传的）⇒ 只按大小判断，不白传几百 MB。
  puts.length = 0;
  heads.set('desktop/2.0.7/IPZSK.Desktop-2.0.7-arm64.dmg', { bytes: 7, sha256: 'c'.repeat(64) });
  await run();
  assert.ok(puts.some((p) => p.k.endsWith('arm64.dmg')), 'sha256 不一致要重传');

  puts.length = 0;
  heads.set('desktop/2.0.7/IPZSK.Desktop-2.0.7-arm64.dmg', { bytes: 7, sha256: null });
  assert.deepEqual(await run(), manifest);
  assert.ok(!puts.some((p) => p.k.endsWith('arm64.dmg')), '没有 sha256 元数据时按大小认定已存在');

  await rm(dir, { recursive: true });
});
