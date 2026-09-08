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
