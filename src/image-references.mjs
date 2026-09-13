import { httpError } from './security.mjs';

// Standard GPT Image 2.5 accepts URLs only. Keep credentials and uploads on the server.
export async function uploadImageReferences(upstream, row, images, signal) {
  let total=0;
  const inputs=images.map(image=>{
    if(/^https?:\/\//.test(image)){
      let url;try{url=new URL(image);}catch{throw httpError(400,'invalid_reference_images');}
      if(url.username||url.password)throw httpError(400,'invalid_reference_images');
      return image;
    }
    const match=/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(image);
    if(!match)throw httpError(400,'invalid_reference_images');
    const bytes=Buffer.from(match[2],'base64');total+=bytes.length;
    if(total>3*1024*1024)throw httpError(413,'reference_images_too_large');
    return {bytes,type:match[1]};
  });
  const urls=[];
  for(const input of inputs){
    if(typeof input==='string'){urls.push(input);continue;}
    const form=new FormData();
    form.append('file',new Blob([input.bytes],{type:input.type}),'reference.'+input.type.split('/')[1]);
    const response=await upstream.request(row,'/v1/uploads/images',{method:'POST',body:form,signal});
    if(!response.ok){await response.body?.cancel();throw httpError(502,'reference_upload_failed');}
    const data=await response.json();
    if(typeof data.url!=='string'||!['https://upload.apimart.ai/','https://getapib.org/'].some(prefix=>data.url.startsWith(prefix)))throw httpError(502,'invalid_reference_upload');
    urls.push(data.url);
  }
  return urls;
}
