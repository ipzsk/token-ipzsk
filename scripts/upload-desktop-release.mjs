#!/usr/bin/env node
// 把一目录安装包传到私有 R2 的 desktop/<version>/，写 manifest.json，并把 latest.json 指过去。
// 用法（在生产网关容器里跑，R2_CONFIG_FILE 已在环境里）：
//   node scripts/upload-desktop-release.mjs 2.0.7 /tmp/installers [--released-at 2026-09-01T00:00:00Z] [--keep-latest]
// 安装包是几百 MB 且上行不快：文件全程流式（openAsBlob，不进内存），超时按大小放宽，每 15 秒打一次心跳。
// 幂等：同名同大小、且对象上记的 sha256 一致就跳过；manifest/latest 每次按当前目录重写。
// CI 不走这个脚本（CI 直接传），它只是给手工迁移历史版本用的。
import { createHash } from 'node:crypto';
import { createReadStream, openAsBlob } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { loadR2Storage } from '../src/r2-storage.mjs';
import { DESKTOP_VERSION, parseDesktopManifest } from '../src/desktop-releases.mjs';

// 文件名 → 平台，与 CI 产物命名一致（IPZSK.Desktop-<v>-arm64.dmg / -x64.dmg / DSH-Desktop-<v>-x64-Setup.exe）。
function platformOf(name) {
  if (/\.dmg$/i.test(name)) return /arm64/i.test(name) ? 'mac' : 'mac-intel';
  if (/\.(exe|msi)$/i.test(name)) return 'windows';
  return null;
}

// 默认 30 秒是给几十 KB 的 JSON 和缩略图用的，180MB 装在那里面必然超时。
// 按 50 KB/s 的下限给时间（180MB ≈ 1 小时），再加 60 秒基数；真正卡死的连接仍然会断。
export const uploadTimeoutMs = (bytes) => 60_000 + Math.ceil(bytes / 50);
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1) + ' MB';

/** 流式算 sha256：读一遍磁盘，内存只有一个 64KB 缓冲。 */
export function hashFile(path) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path).on('error', reject).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex')));
  });
}

export async function uploadDesktopRelease(storage, version, dir, { releasedAt, keepLatest = false, log = console.log, openBlob = openAsBlob } = {}) {
  if (!DESKTOP_VERSION.test(version)) throw new Error('version must be x.y.z');
  const files = [];
  for (const name of (await readdir(dir)).sort()) {
    const platform = platformOf(name);
    if (!platform) { log(`skip\t${name}\t(no platform)`); continue; }
    const path = join(dir, name), key = `desktop/${version}/${name}`;
    const bytes = (await stat(path)).size;
    const sha256 = await hashFile(path);
    files.push({ platform, name, bytes, sha256 });

    const existing = await storage.head(key);
    // 对象上没记 sha256（例如 CI 传的）就只能按大小判断，不为此重传几百 MB。
    if (existing && existing.bytes === bytes && (existing.sha256 ?? sha256) === sha256) { log(`exists\t${key}\t${mb(bytes)}`); continue; }
    if (existing) log(`replace\t${key}\t${existing.bytes === bytes ? 'sha256 不一致' : `大小 ${existing.bytes} → ${bytes}`}`);

    const started = Date.now(), elapsed = () => Math.round((Date.now() - started) / 1000);
    log(`put\t${key}\t${mb(bytes)}\t开始上传…`);
    // R2 不接受 chunked，所以必须让 fetch 拿到 content-length：openAsBlob 的 Blob 由磁盘支撑，
    // 既有 size 又是流式读取，不会把 180MB 塞进堆里。签名用上面算好的 sha256，不必再 digest 一遍。
    const tick = setInterval(() => log(`...\t${key}\t${elapsed()}s`), 15_000);
    tick.unref?.();
    try {
      await storage.put(key, await openBlob(path), 'application/octet-stream',
        { cacheControl: 'public, max-age=31536000, immutable', hash: sha256, metadata: { sha256 }, timeout: uploadTimeoutMs(bytes) });
    } finally { clearInterval(tick); }
    log(`done\t${key}\t${mb(bytes)}\t${elapsed()}s`);
  }
  if (!files.length) throw new Error('no installers found in ' + dir);
  // 复用线上接口的校验器：这里过不了的，接口上也一定过不了。
  const manifest = parseDesktopManifest({ version, released_at: releasedAt ?? (await stat(dir)).mtime.toISOString(), files });
  const json = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  await storage.put(`desktop/${version}/manifest.json`, json, 'application/json', { cacheControl: 'no-cache' });
  log(`put\tdesktop/${version}/manifest.json`);
  if (keepLatest) log('keep\tdesktop/latest.json');
  else { await storage.put('desktop/latest.json', json, 'application/json', { cacheControl: 'no-cache' }); log('put\tdesktop/latest.json'); }
  return manifest;
}

if (process.argv[1]?.endsWith('upload-desktop-release.mjs')) {
  const { values, positionals } = (await import('node:util')).parseArgs({
    allowPositionals: true, options: { 'released-at': { type: 'string' }, 'keep-latest': { type: 'boolean' } },
  });
  const [version, dir] = positionals, releasedAt = values['released-at'], keepLatest = values['keep-latest'] ?? false;
  if (!version || !dir) { console.error('usage: upload-desktop-release.mjs <version> <dir> [--released-at <iso>] [--keep-latest]'); process.exit(2); }
  const storage = await loadR2Storage(process.env.R2_CONFIG_FILE);
  if (!storage) { console.error('R2_CONFIG_FILE not set'); process.exit(2); }
  const manifest = await uploadDesktopRelease(storage, version, dir, { releasedAt, keepLatest });
  console.log(JSON.stringify(manifest, null, 2));
}
