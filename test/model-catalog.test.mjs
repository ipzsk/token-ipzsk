import {test} from 'node:test';
import assert from 'node:assert/strict';
import {desktopCatalog,adaptModelRequest} from '../src/model-catalog.mjs';
test('desktop exposes only enabled product capabilities',()=>{
 const c=desktopCatalog(new Set(['gpt-5.6-sol','gpt-image-2','gpt-4o-mini','whisper-1']));
 assert.deepEqual(c.models.map(m=>m.id),['gpt-5.6-sol']);
 assert.deepEqual(c.image_models.map(m=>m.id),['gpt-image-2']);
 assert.equal(desktopCatalog(new Set()).default_model,undefined);
});
test('Sol chat normalizes absent and conflicting reasoning without removing tools',()=>{
 for(const effort of [undefined,'high','none']){
 const input={model:'gpt-5.6-sol',reasoning_effort:effort,tools:[{type:'function'}]};
 const output=adaptModelRequest('/v1/chat/completions',input);
 assert.equal(output.reasoning_effort,'none');assert.equal(output.tools,input.tools);assert.equal(input.reasoning_effort,effort);
 }
 const input={model:'other'};assert.equal(adaptModelRequest('/v1/chat/completions',input),input);
});
test('image defaults and allowed sizes are owned by the backend',()=>{
 assert.deepEqual(adaptModelRequest('/v1/images/generations',{model:'gpt-image-2',prompt:'cat'}),{model:'gpt-image-2',prompt:'cat',size:'1:1',resolution:'1k',n:1});
 assert.throws(()=>adaptModelRequest('/v1/images/generations',{model:'gpt-image-2',size:'bad'}));
});
test('plugin pixel sizes and clarity map to the upstream protocol',()=>{
 const result=adaptModelRequest('/v1/images/generations',{model:'gpt-image-2',size:'1792x1024',quality:'medium',response_format:'b64_json'});
 assert.equal(result.size,'16:9');assert.equal(result.resolution,'2k');assert.equal(result.quality,undefined);assert.equal(result.response_format,undefined);
});
