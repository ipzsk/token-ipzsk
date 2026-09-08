import test from 'node:test';
import assert from 'node:assert/strict';
import { agentRequest, agentResponse, agentHeaders } from '../src/agent-protocols.mjs';
import { UsageReader, extractUsage } from '../src/usage.mjs';

test('Responses preserves function outputs and stateless encrypted reasoning', () => {
  const input = [{ type:'function_call_output', call_id:'call_1', output:'file saved' }];
  const body = agentRequest('/v1/responses', { model:'gpt-test', input, stream:true, include:['reasoning.encrypted_content'], store:false });
  assert.deepEqual(body.input, input);
  assert.deepEqual(body.include, ['reasoning.encrypted_content']);
  assert.equal(body.store, false);
  assert.equal(body.max_output_tokens, 32768);
  assert.throws(() => agentRequest('/v1/responses', {model:'gpt-test',input:'hello',background:true}));
  assert.throws(() => agentRequest('/v1/responses', {model:'gpt-test',input:'hello',previous_response_id:'another-user-response'}));
});

test('Anthropic forwards tools and limits without Chat Completions fields', () => {
  const request={model:'claude-test',max_tokens:8192,messages:[{role:'user',content:[{type:'tool_result',tool_use_id:'tool_1',content:'ok'}]}],tools:[{name:'read',input_schema:{type:'object'}}]};
  const body=agentRequest('/v1/messages',request);
  assert.deepEqual(body,{...request,stream:false});
  assert.equal(body.n,undefined);
  assert.throws(()=>agentRequest('/v1/messages',{...request,max_tokens:0}));
  assert.deepEqual(agentHeaders('/v1/messages',{'anthropic-version':'2023-06-01','anthropic-beta':'interleaved-thinking-2025-05-14',authorization:'secret','x-api-key':'secret'}),
    {'anthropic-version':'2023-06-01','anthropic-beta':'interleaved-thinking-2025-05-14'});
});

test('Responses usage includes cached input once; failed responses fail validation',()=>{
  assert.deepEqual(extractUsage({usage:{input_tokens:20,output_tokens:8,total_tokens:28,input_tokens_details:{cached_tokens:10}}}),{input:20,output:8,total:28});
  assert.equal(agentResponse('/v1/responses',{id:'r',object:'response',status:'completed',output:[]}).id,'r');
  assert.throws(()=>agentResponse('/v1/responses',{object:'response',status:'failed',output:[]}));
});

test('Anthropic usage combines cache writes and hits; stream deltas retain input totals',()=>{
  const start={type:'message_start',message:{id:'msg_fixture',type:'message',usage:{input_tokens:12,cache_creation_input_tokens:5,cache_read_input_tokens:7,output_tokens:0}}};
  const delta={type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:8}};
  const sse=[start,delta,{type:'message_stop'}].map(v=>'data: '+JSON.stringify(v)+'\n\n').join('');
  const reader=new UsageReader('messages');
  for(const byte of Buffer.from(sse))reader.push(Uint8Array.of(byte));
  reader.finish();
  assert.deepEqual(reader.usage,{input:24,output:8,total:32});
  assert.equal(reader.upstreamId,'msg_fixture');
  assert.equal(reader.done,true);
});

test('Responses completion is terminal without DONE; partial stream stays uncertain',()=>{
  const sse='event: response.completed\ndata: '+JSON.stringify({type:'response.completed',response:{id:'resp_fixture',status:'completed',usage:{input_tokens:4,output_tokens:3,total_tokens:7}}})+'\n\n';
  const reader=new UsageReader('responses');reader.push(Buffer.from(sse));reader.finish();
  assert.equal(reader.done,true);assert.equal(reader.failed,false);
  assert.deepEqual(reader.usage,{input:4,output:3,total:7});
  const partial=new UsageReader('responses');partial.push(Buffer.from('data: {"type":"response.created","response":{"id":"partial"}}\n\n'));partial.finish();
  assert.equal(partial.done,false);
  const failed=new UsageReader('responses');failed.push(Buffer.from('data: {"type":"response.failed","response":{"status":"failed"}}\n\n'));failed.finish();assert.equal(failed.failed,true);
});
