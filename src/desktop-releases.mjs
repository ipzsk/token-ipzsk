import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
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
