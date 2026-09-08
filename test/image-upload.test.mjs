import test from 'node:test';
import assert from 'node:assert/strict';
import {imageUpload} from '../src/image-upload.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE9sAAAAASUVORK5CYII=','base64');
async function upload(form){const r=new Request('https://test.invalid',{method:'POST',body:form});return imageUpload(Buffer.from(await r.arrayBuffer()),r.headers.get('content-type'));}
function form(){const f=new FormData();f.set('model','gpt-image-2');f.set('prompt','Product selling points');return f;}
test('multipart single and multiple references become JSON data URLs with numeric fields',async()=>{
 for(const count of [1,2]){const f=form();for(let i=0;i<count;i++)f.append(count===1?'image':'image[]',new Blob([png],{type:'image/png'}),'product.png');f.set('n','1');f.set('size','1024x1024');const result=await upload(f);assert.equal(result.image_urls.length,count);assert.equal(result.image_urls[0],'data:image/png;base64,'+png.toString('base64'));assert.equal(result.n,1);assert.equal(result.size,'1024x1024');}
});
test('missing images, spoofed types, repeated fields and malformed multipart fail before upstream',async()=>{
 await assert.rejects(()=>upload(form()),{code:'image_file_required'});
 const f=form();f.append('image',new Blob(['not-png'],{type:'image/png'}),'x.png');await assert.rejects(()=>upload(f),{code:'unsupported_image_format'});
 const g=form();g.append('prompt','duplicate');await assert.rejects(()=>upload(g),{code:'invalid_image_field'});
 await assert.rejects(()=>imageUpload(Buffer.from('invalid'),'multipart/form-data; boundary=broken'),{code:'invalid_image_upload'});
});
