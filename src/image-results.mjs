import { Readable } from 'node:stream';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { httpError } from './security.mjs';

export function imageUrls(task) {
  const images=task?.result?.images;
  if(!Array.isArray(images))return [];
  return images.flatMap(image=>Array.isArray(image?.url)?image.url:[image?.url]).filter(url=>typeof url==='string');
}
export function publicImageTask(task,origin) {
  if(!imageUrls(task).length)return task;
  return {...task,result:{...task.result,images:imageUrls(task).map((_,i)=>({url:[`${origin}/v1/tasks/${task.id}/image/${i}`]}))}};
}
// Only upstream-returned public HTTPS images may be retrieved. Never forward a key.
export async function fetchResultImage(url,fetcher=fetch) {
  let parsed;try{parsed=new URL(url);}catch{throw httpError(502,'invalid_image_url');}
  if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.port&&parsed.port!=='443')throw httpError(502,'invalid_image_url');
  const addresses=await lookup(parsed.hostname,{all:true});
  const publicV4=ip=>{const [a,b]=ip.split('.').map(Number);return isIP(ip)===4&&a!==0&&a!==10&&a!==127&&a<224&&!(a===169&&b===254)&&!(a===172&&b>=16&&b<=31)&&!(a===192&&b===168)&&!(a===100&&b>=64&&b<=127);};
  if(!addresses.length||addresses.some(row=>!publicV4(row.address)))throw httpError(502,'invalid_image_host');
  const response=await fetcher(url,{redirect:'error',signal:AbortSignal.timeout(30000)});
  const type=response.headers.get('content-type')?.split(';')[0];
  if(!response.ok||!['image/png','image/jpeg','image/webp'].includes(type)){await response.body?.cancel();throw httpError(502,'image_download_failed');}
  const body=Readable.from((async function*(){
    let bytes=0;
    for await(const chunk of response.body){
      bytes+=chunk.length;
      if(bytes>32_000_000)throw httpError(502,'image_too_large');
      yield chunk;
    }
  })());
  return {type,body};
}
