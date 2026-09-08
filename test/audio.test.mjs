import test from 'node:test';
import assert from 'node:assert/strict';
import { audioRequest } from '../src/audio.mjs';

async function multipart(fields, file=true){
  const form=new FormData();
  for(const [key,value]of Object.entries(fields))form.set(key,value);
  if(file)form.set('file',new Blob(['synthetic-audio'],{type:'audio/wav'}),'sample.wav');
  const request=new Request('https://fixture.invalid',{method:'POST',body:form});
  return [Buffer.from(await request.arrayBuffer()),request.headers.get('content-type')];
}
test('audio upload preserves original multipart bytes but fingerprints content without retaining it',async()=>{
  const args=await multipart({model:'whisper-1',response_format:'srt',language:'zh'});
  const value=await audioRequest(...args);
  assert.equal(value.metadata.model,'whisper-1');
  assert.equal(value.metadata.response_format,'srt');
  assert.equal(value.metadata.stream,false);
  assert.match(value.metadata.file_sha256,/^[a-f0-9]{64}$/);
  assert.deepEqual(value.payload,args[0]);
  assert.equal(JSON.stringify(value.metadata).includes('synthetic-audio'),false);
});
test('audio upload rejects malformed content, missing files and unsupported response formats',async()=>{
  await assert.rejects(audioRequest(Buffer.from('bad'),'application/json'));
  await assert.rejects(audioRequest(...await multipart({model:'whisper-1'},false)));
  await assert.rejects(audioRequest(...await multipart({model:'whisper-1',response_format:'html'})));
});
