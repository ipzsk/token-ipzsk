import {test} from 'node:test';
import assert from 'node:assert/strict';
import {imageUrls,publicImageTask,resultEntries} from '../src/image-results.mjs';
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
  assert.deepEqual(value.result.videos,[{url:['https://api.ipzsk.com/v1/tasks/fixture/media/videos/0'],duration:10}]);
  assert.equal(task.result.cost_cny,40,'Internal receipts must remain available to server accounting');
 }
 const pending=publicImageTask({id:'fixture',status:'processing',result:{cost_cny:40}},'https://api.ipzsk.com');
 assert.deepEqual(pending.result,{});
});

test('no upstream URL of any result kind reaches the client; cookie callers get same-origin cookie paths',()=>{
 const task={id:'t1',status:'completed',result:{
  images:[{url:['https://up.example/a.png?X-Amz-Signature=s1','https://up.example/b.png']}],
  videos:[{url:['https://up.example/poster.jpg','https://up.example/v.mp4?sig=s2'],duration:8}],
  captioned_videos:[{url:'https://up.example/c.mp4?sig=s3'}],
  thumbnails:[{url:'https://up.example/t.webp?sig=s4',width:320}],
  subtitles:[{url:['https://up.example/s.srt?sig=s5']}]}};
 for(const [base,prefix] of [[undefined,'https://api.ipzsk.com/v1/tasks/t1'],['/api/me/tasks','https://api.ipzsk.com/api/me/tasks/t1']]){
  const out=publicImageTask(task,'https://api.ipzsk.com',base);
  assert.doesNotMatch(JSON.stringify(out),/up\.example|sig=|Signature/);
  assert.deepEqual(imageUrls(out),[prefix+'/image/0',prefix+'/image/1']);
  // The poster in videos[] is not a video result: indexes follow resultEntries (same as the archiver's videoUrls).
  assert.deepEqual(out.result.videos,[{url:[prefix+'/media/videos/0'],duration:8}]);
  assert.deepEqual(out.result.captioned_videos,[{url:[prefix+'/media/captioned_videos/0']}]);
  assert.deepEqual(out.result.thumbnails,[{url:[prefix+'/media/thumbnails/0'],width:320}]);
  assert.deepEqual(out.result.subtitles,[{url:[prefix+'/media/subtitles/0']}]);
 }
 assert.deepEqual(resultEntries(task,'videos').map(e=>e.url),['https://up.example/v.mp4?sig=s2']);
});
test('URL-less image results keep their allowlisted data',()=>{
 const out=publicImageTask({id:'t2',status:'completed',result:{images:[{b64_json:'aGk=',cost_cny:1}]}},'https://api.ipzsk.com');
 assert.deepEqual(out.result.images,[{b64_json:'aGk='}]);
});
