import test from 'node:test';
import assert from 'node:assert/strict';
import {estimateTextCost,prices} from '../src/text-pricing.mjs';
import {extractBillingUsage,UsageReader} from '../src/usage.mjs';
const usage={input:10000,output:2000,cached_input:6000,cache_write:1000};
test('GPT price snapshot has exact model IDs and published credit units',()=>{
  assert.equal(Object.keys(prices.models).length,56);
  assert.equal(prices.models['gpt-5.6-sol'].tiers[0].input,'32');
  assert.equal(estimateTextCost('gpt-5.6',usage).amount,null);
  assert.equal(estimateTextCost('gpt-4o-mini-unknown',usage).amount,null);
});
test('cache read/write replace ordinary input and output reasoning is counted once',()=>{
  const u=extractBillingUsage({usage:{prompt_tokens:10000,completion_tokens:2000,total_tokens:12000,
    prompt_tokens_details:{cached_tokens:6000,cache_write_tokens:1000},completion_tokens_details:{reasoning_tokens:1900}}});
  const e=estimateTextCost('gpt-5.6-sol',u);
  assert.equal(e.amount,'0.47520000');
  assert.equal(e.details.counts.input,3000);
  assert.deepEqual(e.details.warnings,[]);
});
test('272000 threshold selects rates for the entire request',()=>{
  const base={output:2000,cached_input:0,cache_write:0};
  assert.equal(estimateTextCost('gpt-5.6-sol',{...base,input:272000}).amount,'9.02400000');
  assert.equal(estimateTextCost('gpt-5.6-sol',{...base,input:272001}).amount,'17.88806400');
  assert.equal(estimateTextCost('gpt-5.6-sol',{...base,input:273000}).amount,'17.95200000');
});
test('tiny requests preserve eight decimal precision with no repeated 20% discount',()=>{
  assert.equal(estimateTextCost('gpt-4o-mini',{input:14,output:3,cached_input:0,cache_write:0}).amount,'0.00003120');
  assert.equal(estimateTextCost('gpt-5.6-luna',{input:1,output:0,cached_input:1,cache_write:0}).amount,'0.00000016');
  assert.equal(estimateTextCost('gpt-3.5-turbo-instruct',{input:0,output:1,cached_input:0,cache_write:0}).amount,'0.00001596');
});
test('missing cache data is disclosed; unpublished cache rates never invented',()=>{
  const e=estimateTextCost('gpt-5.6-sol',{input:10000,output:2000},{historical:true});
  assert.equal(e.amount,'0.64000000');
  assert.equal(e.details.warnings.length,3);
  assert.equal(estimateTextCost('gpt-4o-mini',usage).details.reason,'cache_read_price_unpublished');
  assert.equal(estimateTextCost('gpt-5.4',{...usage,cached_input:0}).details.reason,'cache_write_price_unpublished');
});
test('invalid or unsupported billing inputs do not become zero-cost successes',()=>{
  for(const u of [null,{...usage,input:-1},{...usage,output:NaN},{...usage,cached_input:11000},{...usage,cache_write:'10'},{...usage,input:Number.MAX_SAFE_INTEGER+1}])
    assert.equal(estimateTextCost('gpt-5.6-sol',u).amount,null);
  assert.equal(estimateTextCost('gpt-5.6-sol',{...usage,multimodal:true}).amount,null);
  for(const opts of [{billableTools:true},{serviceTier:'priority'},{status:'failed'}])assert.equal(estimateTextCost('gpt-5.6-sol',usage,opts).amount,null);
  assert.equal(estimateTextCost('gpt-5-search-api',usage).amount,null);
  assert.ok(estimateTextCost('gpt-5.6-sol',usage,{status:'uncertain'}).details.warnings.includes('partial_usage_request_uncertain'));
});
test('Responses SSE keeps the final cumulative pricing usage, including caches',()=>{
  const r=new UsageReader('responses');
  const value={type:'response.completed',response:{id:'resp',status:'completed',service_tier:'default',usage:{input_tokens:10000,output_tokens:2000,input_tokens_details:{cached_tokens:6000,cache_write_tokens:1000}}}};
  const events=('data: '+JSON.stringify(value)+'\n\n').repeat(2);
  for(const b of Buffer.from(events))r.push(Uint8Array.of(b));
  r.finish();assert.equal(r.done,true);
  assert.equal(estimateTextCost('gpt-5.6-sol',r.billingUsage).amount,'0.47520000');
  assert.equal(r.serviceTier,'default');
});
test('Messages cache counters are outside raw input and survive output deltas',()=>{
  const r=new UsageReader('messages');
  for(const event of [{type:'message_start',message:{usage:{input_tokens:3000,cache_read_input_tokens:6000,cache_creation_input_tokens:1000,output_tokens:0}}},
    {type:'message_delta',usage:{output_tokens:2000}},{type:'message_stop'}])r.push(Buffer.from('data: '+JSON.stringify(event)+'\n\n'));
  assert.equal(estimateTextCost('gpt-5.6-sol',r.billingUsage).amount,'0.47520000');
});
