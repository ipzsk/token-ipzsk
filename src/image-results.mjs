import { Readable } from 'node:stream';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { httpError } from './security.mjs';

export function imageUrls(task) {
  const images=task?.result?.images;
  if(!Array.isArray(images))return [];
  return images.flatMap(image=>Array.isArray(image?.url)?image.url:[image?.url]).filter(url=>typeof url==='string');
}
// Result kinds besides images. Each URL is served by the gateway (gateway.mjs /…/tasks/:id/media/:kind/:index),
// never handed out: upstream URLs are often signed and name the upstream provider.
export const MEDIA_KINDS=['videos','thumbnails','subtitles','captioned_videos'];
const MEDIA_FIELDS=['revised_prompt','mime_type','width','height','duration'];
/** Flattened result URLs of one kind with their item's public metadata; videos skip stray posters (same order as videoUrls). */
export function resultEntries(task,key){
  const items=task?.result?.[key];
  if(!Array.isArray(items))return [];
  return items.filter(item=>item&&typeof item==='object').flatMap(item=>{
    const meta={};
    for(const field of MEDIA_FIELDS)if(typeof item[field]==='string'||typeof item[field]==='number'&&Number.isFinite(item[field]))meta[field]=item[field];
    return (Array.isArray(item.url)?item.url:[item.url]).filter(url=>typeof url==='string'&&!(key==='videos'&&NOT_VIDEO.test(url))).map(url=>({url,meta}));
  });
}
/**
 * Public task shape. `base` follows the caller: '/v1/tasks' for Bearer clients, '/api/me/tasks' for the website's cookie
 * session (a cookie can ride an <img>/<video> request, a Bearer header cannot).
 */
export function publicImageTask(task,origin,base='/v1/tasks') {
  const output={id:task.id,status:task.status,progress:typeof task.progress==='number'&&Number.isFinite(task.progress)?task.progress:0,result:null};
  if(task.error)output.error={message:'Media generation failed.'};
  if(task.result&&typeof task.result==='object'&&!Array.isArray(task.result)){
    output.result={};
    const images=imageUrls(task);
    if(images.length)output.result.images=images.map((_,i)=>({url:[`${origin}${base}/${task.id}/image/${i}`]}));
    // URL-less images (b64_json) carry no upstream address and pass through allowlisted.
    else if(Array.isArray(task.result.images))output.result.images=task.result.images.filter(item=>item&&typeof item==='object').map(item=>{
      const value={};
      for(const field of ['b64_json',...MEDIA_FIELDS])if(typeof item[field]==='string'||typeof item[field]==='number'&&Number.isFinite(item[field]))value[field]=item[field];
      return value;
    });
    for(const key of MEDIA_KINDS){
      if(!Array.isArray(task.result[key]))continue;
      output.result[key]=resultEntries(task,key).map(({meta},i)=>({url:[`${origin}${base}/${task.id}/media/${key}/${i}`],...meta}));
    }
  }
  return output;
}
// Public unicast only, either family. CDNs (CloudFront behind HeyGen) resolve to IPv6 as well: rejecting every IPv6
// address failed each such result as invalid_image_host. Loopback / private / link-local / ULA / multicast stay blocked.
export function publicAddress(ip){
  if(isIP(ip)===4){const [a,b]=ip.split('.').map(Number);return a!==0&&a!==10&&a!==127&&a<224&&!(a===169&&b===254)&&!(a===172&&b>=16&&b<=31)&&!(a===192&&b===168)&&!(a===100&&b>=64&&b<=127);}
  if(isIP(ip)!==6)return false;
  const v=ip.toLowerCase();
  if(v.startsWith('::ffff:'))return publicAddress(v.slice(7)); // IPv4-mapped: judge the IPv4 (hex form is not IPv4 → rejected)
  return !(v==='::'||v==='::1'||/^f[cd]/.test(v)||/^fe[89ab]/.test(v)||/^ff/.test(v)||v.startsWith('64:ff9b:')||v.startsWith('2001:db8:'));
}
// Only upstream-returned public HTTPS images may be retrieved. Never forward a key.
// lanehub puts thumbnails / subtitles / captioned videos under their own keys; still drop obvious image/subtitle links
// from videos[] so a poster can never be archived or counted as the result.
const NOT_VIDEO=/\.(?:jpe?g|png|webp|gif|srt|vtt)(?:$|[?#])/i;
export function videoUrls(task) {
  const videos=task?.result?.videos;
  if(!Array.isArray(videos))return [];
  return videos.flatMap(video=>Array.isArray(video?.url)?video.url:[video?.url]).filter(url=>typeof url==='string'&&!NOT_VIDEO.test(url));
}
/**
 * Status to settle a media hold with. A task the upstream calls `completed` but that carries no result of its kind
 * (no image URL; no real video URL) settles as `failed`: the hold is released, never charged for nothing.
 */
export function settleStatus(kind,rawStatus,data){
  if(rawStatus!=='completed')return rawStatus;
  const task={result:data?.result};
  return (kind==='video'?videoUrls(task):imageUrls(task)).length?'completed':'failed';
}
// lanehub side keys: thumbnails / subtitles (srt) / captioned_videos (burned-in captions).
export const sideUrls=(task,key)=>{
  const items=task?.result?.[key];
  if(!Array.isArray(items))return [];
  return items.flatMap(item=>Array.isArray(item?.url)?item.url:[item?.url]).filter(url=>typeof url==='string');
};
export const thumbnailUrls=(task)=>sideUrls(task,'thumbnails');
// Subtitles are small text: the signed upstream URL expires, so the archiver keeps the text itself (≤64KB).
export async function fetchSubtitle(url,fetcher=fetch){
  const file=await fetchResultMedia(url,fetcher,{types:['application/x-subrip','text/plain','text/srt','text/vtt','application/octet-stream','binary/octet-stream'],maxBytes:65_536});
  const chunks=[];for await(const chunk of file.body)chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
export const fetchResultImage=(url,fetcher=fetch)=>fetchResultMedia(url,fetcher);
// Videos: real type is sniffed after download (CDNs often answer octet-stream). Image types are accepted so the archiver can skip a stray poster.
export const fetchResultVideo=(url,fetcher=fetch)=>fetchResultMedia(url,fetcher,{types:['video/mp4','application/octet-stream','binary/octet-stream','image/jpeg','image/png','image/webp'],maxBytes:200*1024*1024,timeoutMs:300_000});
export async function fetchResultMedia(url,fetcher=fetch,{types=['image/png','image/jpeg','image/webp'],maxBytes=32_000_000,timeoutMs=30000}={}) {
  let parsed;try{parsed=new URL(url);}catch{throw httpError(502,'invalid_image_url');}
  if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.port&&parsed.port!=='443')throw httpError(502,'invalid_image_url');
  const addresses=await lookup(parsed.hostname,{all:true});
  if(!addresses.length||addresses.some(row=>!publicAddress(row.address)))throw httpError(502,'invalid_image_host');
  const response=await fetcher(url,{redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
  const type=response.headers.get('content-type')?.split(';')[0];
  if(!response.ok||!types.includes(type)){await response.body?.cancel();throw httpError(502,'image_download_failed');}
  const body=Readable.from((async function*(){
    let bytes=0;
    for await(const chunk of response.body){
      bytes+=chunk.length;
      if(bytes>maxBytes)throw httpError(502,'media_too_large');
      yield chunk;
    }
  })());
  return {type,body};
}
