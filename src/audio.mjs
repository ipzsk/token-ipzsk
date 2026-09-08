import { hash, httpError } from './security.mjs';
import { text } from './validation.mjs';

export async function audioRequest(payload, contentType) {
  if(!Buffer.isBuffer(payload)||!/^multipart\/form-data;\s*boundary=/i.test(contentType??''))throw httpError(400,'invalid_audio_upload');
  if(payload.length>26_000_000)throw httpError(413,'audio_too_large');
  let form;
  try{form=await new Request('https://multipart.invalid',{method:'POST',headers:{'Content-Type':contentType},body:payload}).formData();}
  catch{throw httpError(400,'invalid_audio_upload');}
  const allowed=new Set(['file','model','language','prompt','temperature','response_format']);
  const fields={};
  for(const [name,value]of form){
    if(!allowed.has(name)||form.getAll(name).length!==1)throw httpError(400,'invalid_audio_field');
    if(name!=='file'){if(typeof value!=='string')throw httpError(400,'invalid_audio_field');fields[name]=value;}
  }
  text(fields.model,128);
  const file=form.get('file');
  if(!(file instanceof File)||!file.size)throw httpError(400,'audio_file_required');
  if(file.size>25_000_000)throw httpError(413,'audio_too_large');
  if(!/\.(mp3|mp4|mpeg|mpga|m4a|wav|webm)$/i.test(file.name))throw httpError(400,'unsupported_audio_format');
  const format=fields.response_format??'json';
  if(!['json','verbose_json','text','srt','vtt'].includes(format))throw httpError(400,'invalid_audio_response_format');
  if(fields.language!==undefined&&!/^[a-z]{2}$/.test(fields.language))throw httpError(400,'invalid_audio_language');
  if(fields.prompt!==undefined&&fields.prompt.length>4000)throw httpError(400,'audio_prompt_too_long');
  if(fields.temperature!==undefined&&(!fields.temperature.trim()||!Number.isFinite(Number(fields.temperature))||Number(fields.temperature)<0||Number(fields.temperature)>1))throw httpError(400,'invalid_audio_temperature');
  return {payload,contentType,metadata:{...fields,response_format:format,stream:false,file_sha256:hash(Buffer.from(await file.arrayBuffer()))}};
}
