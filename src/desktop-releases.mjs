import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { httpError, RateLimiter } from './security.mjs';
const repository='JayceHuang/ipzsk-dsh-desktop';
export function desktopReleaseRoutes(app,{desktopReleaseFetch=fetch,readDesktopReleases=async()=>JSON.parse(await readFile(new URL('./desktop-releases.json',import.meta.url),'utf8'))}={}) {
  const manifest=readDesktopReleases;
  app.get('/api/desktop/version',async(req,reply)=>{
    const channel=req.headers['x-dsh-desktop-channel']??'stable',release=(await manifest())[channel];
    if(!release || !release.assets[req.headers['x-ipzsk-platform']+'-'+req.headers['x-ipzsk-arch']])return reply.code(404).send({error:'release_unavailable'});
    return {version:release.version,channel};
  });
  app.get('/api/desktop/download/:platform',async(req,reply)=>{
    const channel=req.headers['x-dsh-desktop-channel']??'stable',release=(await manifest())[channel];
    if(!release || req.headers['x-dsh-desktop-target-version']!==release.version)return reply.code(409).send({error:'release_changed'});
    const platform={mac:'darwin',windows:'win32'}[req.params.platform];
    const asset=release.assets[platform+'-'+req.headers['x-ipzsk-arch']];
    if(!asset)return reply.code(404).send({error:'platform_unavailable'});
    let url='https://github.com/'+repository+'/releases/download/v'+release.version+'/'+encodeURIComponent(asset);
    for(let i=0;i<4;i++){
      const target=new URL(url);
      if(target.protocol!=='https:'||target.port||target.username||target.password||!['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(target.hostname))throw new Error('invalid_release_redirect');
      const response=await desktopReleaseFetch(url,{redirect:'manual',signal:AbortSignal.timeout(300000)});
      if([301,302,303,307,308].includes(response.status)) {const next=response.headers.get('location');await response.body?.cancel();if(!next)break;url=new URL(next,url).href;continue;}
      if(!response.ok||!response.body)break;
      reply.header('Content-Type','application/octet-stream').header('Content-Disposition','attachment; filename="'+asset+'"');
      const length=response.headers.get('content-length');if(length)reply.header('Content-Length',length);
      return reply.send(Readable.fromWeb(response.body));
    }
    return reply.code(502).send({error:'release_download_failed'});
  });
}

// ── 官网下载（§8）：安装包放私有 R2 的 desktop/<version>/，网关下发时间切片签名 URL ──
// 桶里两份 JSON 形状相同：desktop/latest.json（指向最新正式版）与 desktop/<version>/manifest.json（历史版本）。
export const DESKTOP_PLATFORMS = ['mac', 'mac-intel', 'windows'];
export const DESKTOP_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/; // 不含 '/'：名字只能落在自己的 desktop/<version>/ 前缀下

/** 形状不对就当「没有发布」，不把存储/解析细节透给客户端。 */
export function parseDesktopManifest(doc) {
  const bad = () => { throw httpError(503, 'desktop_release_unavailable'); };
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) bad();
  if (!DESKTOP_VERSION.test(doc.version ?? '') || !Number.isFinite(Date.parse(doc.released_at ?? ''))) bad();
  if (!Array.isArray(doc.files) || !doc.files.length || doc.files.length > 10) bad();
  const seen = new Set();
  const files = doc.files.map((f) => {
    if (!f || typeof f !== 'object' || !DESKTOP_PLATFORMS.includes(f.platform) || seen.has(f.platform)) bad();
    seen.add(f.platform);
    if (!FILE_NAME.test(f.name ?? '') || !Number.isInteger(f.bytes) || f.bytes <= 0 || !/^[a-f0-9]{64}$/.test(f.sha256 ?? '')) bad();
    return { platform: f.platform, name: f.name, bytes: f.bytes, sha256: f.sha256 };
  });
  return { version: doc.version, released_at: new Date(doc.released_at).toISOString(), files };
}

export function desktopDownloadRoutes(app, { imageStorage = null } = {}) {
  const limiter = new RateLimiter();
  app.get('/api/public/desktop-release', async (req, reply) => {
    limiter.take('desktop-release:' + req.ip, 60);
    if (!imageStorage) throw httpError(503, 'desktop_release_unavailable');
    const version = req.query?.version;
    if (version !== undefined && !DESKTOP_VERSION.test(String(version))) throw httpError(400, 'invalid_version');
    const key = version ? `desktop/${version}/manifest.json` : 'desktop/latest.json';
    let raw;
    try { raw = await imageStorage.getRange(key, 0, 65535); } // 两份 JSON 都是几百字节；缺对象时 R2 返 404 → r2_get_failed
    catch { throw httpError(503, 'desktop_release_unavailable'); }
    let doc = null;
    try { doc = JSON.parse(raw.toString('utf8')); } catch { /* parseDesktopManifest 统一报错 */ }
    const release = parseDesktopManifest(doc);
    if (version && release.version !== String(version)) throw httpError(503, 'desktop_release_unavailable');
    reply.header('Cache-Control', 'private, max-age=300'); // 内含签名 URL，只允许浏览器私有缓存
    return { ...release, files: release.files.map((f) => ({ ...f, url: imageStorage.presignGetSliced(`desktop/${release.version}/${f.name}`) })) };
  });
}

// 契约登记，见 src/studio.mjs routeMeta。
export const routeMeta = {
  'GET /api/public/desktop-release': { query: 'DesktopReleaseQuery', response: 'DesktopRelease' },
};
