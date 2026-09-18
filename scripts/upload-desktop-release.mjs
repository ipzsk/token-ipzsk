#!/usr/bin/env node
// 把一目录安装包传到私有 R2 的 desktop/<version>/，写 manifest.json，并把 latest.json 指过去。
// 用法（在生产网关容器里跑，R2_CONFIG_FILE 已在环境里）：
//   node scripts/upload-desktop-release.mjs 2.0.7 /tmp/installers [--released-at 2026-09-01T00:00:00Z] [--keep-latest]
// 幂等：同名同大小的对象跳过上传；manifest/latest 每次按当前目录重写。CI 不走这个脚本（CI 直接传），
// 它只是给手工迁移历史版本用的。
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { loadR2Storage } from '../src/r2-storage.mjs';
import { DESKTOP_VERSION, parseDesktopManifest } from '../src/desktop-releases.mjs';

// 文件名 → 平台，与 CI 产物命名一致（IPZSK.Desktop-<v>-arm64.dmg / -x64.dmg / DSH-Desktop-<v>-x64-Setup.exe）。
function platformOf(name) {
  if (/\.dmg$/i.test(name)) return /arm64/i.test(name) ? 'mac' : 'mac-intel';
  if (/\.(exe|msi)$/i.test(name)) return 'windows';
  return null;
}

export async function uploadDesktopRelease(storage, version, dir, { releasedAt, keepLatest = false, log = console.log } = {}) {
  if (!DESKTOP_VERSION.test(version)) throw new Error('version must be x.y.z');
  const files = [];
  for (const name of (await readdir(dir)).sort()) {
    const platform = platformOf(name);
    if (!platform) { log(`skip\t${name}\t(no platform)`); continue; }
    const body = await readFile(join(dir, name));
    const key = `desktop/${version}/${name}`;
    const existing = await storage.head(key);
    if (existing && existing.bytes === body.length) log(`exists\t${key}`);
    else { await storage.put(key, body, 'application/octet-stream', { cacheControl: 'public, max-age=31536000, immutable' }); log(`put\t${key}\t${body.length}`); }
    files.push({ platform, name, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') });
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
