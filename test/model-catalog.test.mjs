import {test} from 'node:test';
import assert from 'node:assert/strict';
import {modelCatalog,desktopCatalog,adaptModelRequest,toUpstreamRequest,resolveTier,mediaPricing} from '../src/model-catalog.mjs';
const throws=(fn,code)=>assert.throws(fn,e=>e.statusCode===400&&e.code===code);
test('desktop exposes only enabled product capabilities',()=>{
 const c=desktopCatalog(new Set(['gpt-5.6-sol','gpt-image-2','z-image-turbo','seedance-2.0-mini','gpt-4o-mini','whisper-1']));
 assert.deepEqual(c.models.map(m=>m.id),['gpt-5.6-sol']);
 assert.deepEqual(c.models[0].name,'GPT 5.6');assert.equal(c.models[0].contextWindow,128000);
 assert.deepEqual(c.image_models.map(m=>m.name),['GPT Image 2','Z-Image Turbo']);
 assert.deepEqual(c.image_models.map(m=>m.id),['gpt-image-2','z-image-turbo']);
 assert.deepEqual(c.video_models.map(m=>m.id),['seedance-2.0-mini']);
 assert.deepEqual(c.video_models[0].tiers,['480p','720p']);
 assert.equal(desktopCatalog(new Set()).default_model,undefined);
 assert.deepEqual(desktopCatalog(new Set(['gpt-image-2'])).video_models,[]);
});
test('force_params from the catalog override whatever the client sent',()=>{
 for(const effort of [undefined,'high','none']){
 const input={model:'gpt-5.6-sol',reasoning_effort:effort,tools:[{type:'function'}]};
 const output=adaptModelRequest('/v1/chat/completions',input);
 assert.equal(output.reasoning_effort,'none');assert.equal(output.tools,input.tools);assert.equal(input.reasoning_effort,effort);
 }
 const input={model:'other'};assert.equal(adaptModelRequest('/v1/chat/completions',input),input);
});
test('image defaults and allowed sizes are owned by the backend',()=>{
 assert.deepEqual(adaptModelRequest('/v1/images/generations',{model:'gpt-image-2',prompt:'cat'}),{model:'gpt-image-2',prompt:'cat',size:'1:1',resolution:'1k',n:1});
 throws(()=>adaptModelRequest('/v1/images/generations',{model:'gpt-image-2',size:'bad'}),'unsupported_image_size');
 assert.deepEqual(resolveTier('gpt-image-2',{model:'gpt-image-2',prompt:'cat'}),{tier:'1k',durationSec:null});
});
test('plugin pixel sizes and clarity map to the upstream protocol',()=>{
 const result=adaptModelRequest('/v1/images/generations',{model:'gpt-image-2',size:'1792x1024',quality:'medium',response_format:'b64_json'});
 assert.equal(result.size,'16:9');assert.equal(result.resolution,'2k');assert.equal(result.quality,undefined);assert.equal(result.response_format,undefined);
 assert.equal(resolveTier('gpt-image-2',{quality:'high'}).tier,'4k');
 throws(()=>adaptModelRequest('/v1/images/generations',{model:'gpt-image-2',quality:'ultra'}),'unsupported_resolution');
});
test('prompt extension is its own tier',()=>{
 assert.deepEqual(adaptModelRequest('/v1/images/generations',{model:'z-image-turbo',prompt:'cat'}),{model:'z-image-turbo',prompt:'cat',prompt_extend:false,n:1});
 assert.equal(resolveTier('z-image-turbo',{}).tier,'default');
 assert.equal(resolveTier('z-image-turbo',{prompt_extend:true}).tier,'prompt_extend');
 throws(()=>resolveTier('z-image-turbo',{prompt_extend:'yes'}),'invalid_boolean');
});
test('video keeps duration and refuses to guess a tier',()=>{
 assert.deepEqual(adaptModelRequest('/v1/videos/generations',{model:'seedance-2.0-mini',prompt:'cat',resolution:'720p'}),
  {model:'seedance-2.0-mini',prompt:'cat',resolution:'720p',duration:5});
 assert.deepEqual(resolveTier('seedance-2.0-mini',{resolution:'480p',duration:8}),{tier:'480p',durationSec:8});
 throws(()=>resolveTier('seedance-2.0-mini',{duration:5}),'missing_resolution');
 throws(()=>resolveTier('seedance-2.0-mini',{resolution:'1080p'}),'unsupported_resolution');
 // i2v stays shut: the upstream reference-image field is unverified, so no key we did not register gets forwarded.
 for(const extra of [{image:'data:...'},{image_urls:['data:...']},{first_frame:'x'},{seed:1}])
  throws(()=>adaptModelRequest('/v1/videos/generations',{model:'seedance-2.0-mini',prompt:'cat',resolution:'720p',...extra}),'unsupported_parameter');
 for(const duration of [0,11,'5',2.5]) throws(()=>resolveTier('seedance-2.0-mini',{resolution:'480p',duration}),'invalid_number');
});
test('media bodies are whitelisted, and image edits still get through',()=>{
 for(const extra of [{seed:1},{negative_prompt:'x'},{guidance_scale:7}])
  throws(()=>adaptModelRequest('/v1/images/generations',{model:'gpt-image-2',prompt:'cat',...extra}),'unsupported_parameter');
 const edit=adaptModelRequest('/v1/images/generations',{model:'gpt-image-2',prompt:'cat',stream:false,n:2,quality:'high',
  response_format:'b64_json',image_urls:['data:image/png;base64,x'],mask_url:'data:image/png;base64,y',background:'transparent',
  output_format:'png',output_compression:80,input_fidelity:'high',user:'u1'});
 assert.equal(edit.n,1);assert.equal(edit.resolution,'4k');assert.deepEqual(edit.image_urls,['data:image/png;base64,x']);
 assert.equal(edit.background,'transparent');assert.equal(edit.response_format,undefined);
});
test('the frontend speaks canonical fields and never sees upstream keys',()=>{
 const c=desktopCatalog(new Set(['gpt-image-2','z-image-turbo','seedance-2.0-mini']));
 assert.equal(c.canonical_params.aspect_ratio.length>0,true);
 const image=c.image_models.find(m=>m.id==='gpt-image-2');
 assert.deepEqual(image.params.map(p=>p.field),['prompt','resolution','aspect_ratio']);
 assert.deepEqual(image.params.find(p=>p.field==='aspect_ratio').values,['1:1','16:9','9:16','3:2','2:3']);
 assert.deepEqual(Object.keys(image.unsupported),['duration','enhance_prompt']);
 const video=c.video_models[0].params;
 assert.deepEqual(video.map(p=>p.field),['prompt','resolution','duration']);
 assert.equal(video.find(p=>p.field==='resolution').required,true);
 assert.deepEqual([video.find(p=>p.field==='duration').min,video.at(-1).max],[1,10]);
 // No internal name, upstream key or OpenAI dialect key may reach the client.
 const dumped=JSON.stringify(c);
 for(const leak of ['upstream','from_openai','prompt_extend','"size"','quality','tier_from'])
  assert.equal(dumped.includes(leak),leak==='prompt_extend',leak);// prompt_extend survives only as a tier name
});
test('canonical fields in, upstream fields out',()=>{
 assert.deepEqual(adaptModelRequest('/v1/images/generations',{model:'z-image-turbo',prompt:'cat',enhance_prompt:true}),
  {model:'z-image-turbo',prompt:'cat',prompt_extend:true,n:1});
 assert.equal(resolveTier('z-image-turbo',{enhance_prompt:true}).tier,'prompt_extend');
 const image=adaptModelRequest('/v1/images/generations',{model:'gpt-image-2',prompt:'cat',aspect_ratio:'16:9',resolution:'2k'});
 assert.deepEqual(image,{model:'gpt-image-2',prompt:'cat',size:'16:9',resolution:'2k',n:1});
 assert.equal(image.aspect_ratio,undefined);
 assert.deepEqual(adaptModelRequest('/v1/videos/generations',{model:'seedance-2.0-mini',prompt:'cat',resolution:'480p',duration:8}),
  {model:'seedance-2.0-mini',prompt:'cat',resolution:'480p',duration:8});
 assert.deepEqual(toUpstreamRequest('gpt-image-2',{model:'gpt-image-2',prompt:'cat'}),{model:'gpt-image-2',prompt:'cat',size:'1:1',resolution:'1k',n:1});
});
test('one parameter, one spelling per request',()=>{
 throws(()=>adaptModelRequest('/v1/images/generations',{model:'gpt-image-2',prompt:'c',aspect_ratio:'16:9',size:'1:1'}),'conflicting_parameter');
 throws(()=>adaptModelRequest('/v1/images/generations',{model:'gpt-image-2',prompt:'c',resolution:'2k',quality:'high'}),'conflicting_parameter');
 // Same value twice is not a conflict.
 assert.equal(adaptModelRequest('/v1/images/generations',{model:'gpt-image-2',prompt:'c',aspect_ratio:'16:9',size:'1792x1024'}).size,'16:9');
});
test('a field this model cannot honour is refused, not dropped',()=>{
 throws(()=>adaptModelRequest('/v1/images/generations',{model:'z-image-turbo',prompt:'c',aspect_ratio:'16:9'}),'unsupported_parameter_for_model');
 throws(()=>adaptModelRequest('/v1/images/generations',{model:'gpt-image-2',prompt:'c',enhance_prompt:true}),'unsupported_parameter_for_model');
 throws(()=>adaptModelRequest('/v1/videos/generations',{model:'seedance-2.0-mini',prompt:'c',resolution:'720p',aspect_ratio:'16:9'}),'unsupported_parameter_for_model');
 // Unregistered is a different failure from unsupported-by-this-model: the frontend must be able to tell them apart.
 throws(()=>adaptModelRequest('/v1/images/generations',{model:'z-image-turbo',prompt:'c',seed:1}),'unsupported_parameter');
});
test('unknown models and unpriced tiers are refused, never billed at ratio one',()=>{
 for(const call of [()=>adaptModelRequest('/v1/images/generations',{model:'sdxl'}),()=>resolveTier('sdxl',{}),()=>mediaPricing('sdxl')]) throws(call,'unknown_model');
 const tiers=modelCatalog().models['gpt-image-2'].tiers;
 try{modelCatalog().models['gpt-image-2'].tiers={'1k':1};throws(()=>resolveTier('gpt-image-2',{quality:'high'}),'unknown_tier');}
 finally{modelCatalog().models['gpt-image-2'].tiers=tiers;}
 assert.deepEqual(mediaPricing('seedance-2.0-mini'),{kind:'video',billing_unit:'per_second',base_usd:0.0064,
  tiers:{'480p':1.65,'720p':3.575},require_tier:true,default_tier:null});
 for(const call of [()=>mediaPricing('gpt-5.6-sol'),()=>resolveTier('gpt-5.6-sol',{}),()=>adaptModelRequest('/v1/images/generations',{model:'gpt-5.6-sol'})]) throws(call,'model_not_media');
});
