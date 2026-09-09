import {httpError} from './security.mjs';

// imageUpload 能产出的、且**不由模型目录登记**的 body 键的唯一真源。
// model-catalog 的图片白名单 import 它，不要在别处再抄一份 —— 两份名单必然漂移。
// 注意这里刻意不含 size/quality/resolution：那几个是按模型登记的计价参数，
// 由目录逐模型放行；无差别放进来会让没登记尺寸的模型（如 z-image-turbo）
// 把 size 透传给上游，那是「未登记参数改变上游价格」。
export const imageUploadExtraKeys=new Set(['image_urls','mask_url','background','output_format','output_compression','input_fidelity','user']);
const imageUploadFormFields=new Set(['model','prompt','size','quality','detail','n','response_format','resolution',...imageUploadExtraKeys]);
imageUploadFormFields.delete('image_urls');imageUploadFormFields.delete('mask_url');

// OpenAI multipart edits become APIMart JSON reference images; nothing is written to disk.
export async function imageUpload(payload,contentType){
  if(!Buffer.isBuffer(payload)||!/^multipart\/form-data;/i.test(contentType??''))throw httpError(400,'invalid_image_upload');
  if(payload.length>32_000_000)throw httpError(413,'image_upload_too_large');
  let form;
  try{form=await new Request('https://multipart.invalid',{method:'POST',headers:{'Content-Type':contentType},body:payload}).formData();}
  catch{throw httpError(400,'invalid_image_upload');}
  const body={},images=[];let bytes=0;
  const fields=imageUploadFormFields;
  for(const [name,value] of form){
    if(['image','image[]','mask'].includes(name)){
      if(!(value instanceof File)||!value.size)throw httpError(400,'image_file_required');
      if(name==='mask'&&body.mask_url)throw httpError(400,'invalid_image_field');
      const data=Buffer.from(await value.arrayBuffer());bytes+=data.length;
      if(bytes>20_000_000)throw httpError(413,'image_upload_too_large');
      const mime=data.length>=8&&data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':data.length>=3&&data[0]===255&&data[1]===216&&data[2]===255?'image/jpeg':data.length>=12&&data.toString('ascii',0,4)==='RIFF'&&data.toString('ascii',8,12)==='WEBP'?'image/webp':null;
      if(!mime||name==='mask'&&mime!=='image/png')throw httpError(400,'unsupported_image_format');
      const url=`data:${mime};base64,${data.toString('base64')}`;
      if(name==='mask')body.mask_url=url;else images.push(url);
      if(images.length>15)throw httpError(400,'too_many_reference_images');
    }else{
      if(!fields.has(name)||typeof value!=='string'||form.getAll(name).length!==1||value.length>32000)throw httpError(400,'invalid_image_field');
      if(['n','output_compression'].includes(name)){
        if(!/^\d+$/.test(value))throw httpError(400,'invalid_image_field');body[name]=Number(value);
      }else body[name]=value;
    }
  }
  if(!images.length)throw httpError(400,'image_file_required');
  return {...body,image_urls:images};
}
