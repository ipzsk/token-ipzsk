import {test} from 'node:test';
import assert from 'node:assert/strict';
import {imageUrls,publicImageTask} from '../src/image-results.mjs';
test('image replies use only the authenticated gateway while stored metadata remains intact',()=>{
 const task={id:'task-id',status:'completed',result:{images:[{url:['https://cdn.example/private.png']}]}};
 const output=publicImageTask(task,'https://api.ipzsk.com');
 assert.deepEqual(imageUrls(output),['https://api.ipzsk.com/v1/tasks/task-id/image/0']);
 assert.deepEqual(imageUrls(task),['https://cdn.example/private.png']);
 assert.equal(publicImageTask({status:'processing'},'https://api.ipzsk.com').status,'processing');
});
test('public task responses allowlist media fields and hide nested financial metadata',()=>{
 for(const status of ['processing','completed','failed']){
  const task={id:'fixture',status,progress:20,credits_cost:40,cost_cny:40,pricing_details:{multiplier:2.5},
   error:{message:'private cost 40',cost_cny:40},result:{cost_cny:40,profit:60,
    images:[{url:['https://cdn.example/image.png'],credits_cost:40}],
    videos:[{url:['https://cdn.example/video.mp4'],duration:10,cost_cny:40}],
    thumbnails:[{url:'https://cdn.example/poster.png',cost_cny:40}],
    subtitles:[{url:['https://cdn.example/subtitle.srt'],pricing_details:{secret:true}}]}};
  const value=publicImageTask(task,'https://api.ipzsk.com');
  assert.doesNotMatch(JSON.stringify(value),/credits_cost|cost_cny|pricing_details|profit|private cost/);
  assert.deepEqual(value.result.videos,[{url:['https://cdn.example/video.mp4'],duration:10}]);
  assert.equal(task.result.cost_cny,40,'Internal receipts must remain available to server accounting');
 }
 const pending=publicImageTask({id:'fixture',status:'processing',result:{cost_cny:40}},'https://api.ipzsk.com');
 assert.deepEqual(pending.result,{});
});
