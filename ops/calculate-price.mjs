import { estimateTextCost } from '../src/text-pricing.mjs';
const [model,input,output,read,write]=process.argv.slice(2);
if(!model||input===undefined||output===undefined) {
  console.error('Usage: node ops/calculate-price.mjs MODEL INPUT OUTPUT [CACHED_INPUT] [CACHE_WRITE]');
  process.exit(1);
}
console.log(JSON.stringify(estimateTextCost(model,{input:Number(input),output:Number(output),
  cached_input:read===undefined?null:Number(read),cache_write:write===undefined?null:Number(write)}),null,2));
