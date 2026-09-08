import prices from './gpt-prices.json' with { type:'json' };
export { prices };
const scale = 100000000n;
function units(value) {
  const [whole,fraction=''] = value.split('.');
  return BigInt(whole)*scale+BigInt(fraction.padEnd(8,'0'));
}
function decimal(value) { return `${value/scale}.${String(value%scale).padStart(8,'0')}`; }

export function estimateTextCost(model,usage,{status='succeeded',billableTools=false,serviceTier='default',historical=false,catalog=prices}={}) {
  const details={version:catalog.version,source:catalog.source,model,currency:'CNY',cny_per_credit:catalog.cny_per_credit,
    status:'unavailable',reason:null,usage:usage??null,warnings:[]};
  const fail=reason=>({amount:null,details:{...details,reason}});
  if (!catalog.models[model]) return fail('model_not_priced');
  if (!usage) return fail('usage_missing');
  if (!['succeeded','uncertain'].includes(status)) return fail('request_not_completed');
  if (billableTools || model.includes('search-api')) return fail('tool_price_not_included');
  if (!['default','auto',null,undefined].includes(serviceTier)) return fail('service_tier_not_priced');
  if (usage.multimodal) return fail('multimodal_price_not_included');
  const {input,output}=usage;
  const read=usage.cached_input??0,write=usage.cache_write??0;
  if (![input,output,read,write].every(v=>Number.isSafeInteger(v)&&v>=0)||read+write>input) return fail('invalid_usage_breakdown');
  const tier=catalog.models[model].tiers.find(t=>t.max_input_tokens===null||input<=t.max_input_tokens);
  if (read>0&&tier.cached_input===null) return fail('cache_read_price_unpublished');
  if (write>0&&tier.cache_write===null) return fail('cache_write_price_unpublished');
  if (usage.cached_input===null||usage.cached_input===undefined) details.warnings.push('cache_read_missing_assumed_zero');
  if (usage.cache_write===null||usage.cache_write===undefined) details.warnings.push('cache_write_missing_assumed_zero');
  if (status==='uncertain') details.warnings.push('partial_usage_request_uncertain');
  if (historical) details.warnings.push('historical_usage_current_price_snapshot');
  const counts={input:input-read-write,cached_input:read,cache_write:write,output};
  let numerator=0n;
  for (const [kind,count] of Object.entries(counts)) if(count) numerator+=BigInt(count)*units(tier[kind]);
  // Sum exact decimal products first, then round half-up once to 8 decimal yuan.
  const amount=decimal((numerator+500000n)/1000000n);
  return {amount,details:{...details,status:'estimated',rates:tier,counts,amount_cny:amount,
    formula:'(input*input_rate + cached_input*cached_rate + cache_write*write_rate + output*output_rate) / 1000000'}};
}
