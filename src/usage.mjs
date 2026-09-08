export function extractUsage(data) {
  const u = data?.usage ?? data?.data?.usage ?? data?.response?.usage ?? data?.message?.usage;
  if (!u) return null;
  let input=u.prompt_tokens??u.input_tokens;
  const output=u.completion_tokens??u.output_tokens;
  if (!Number.isSafeInteger(input)||input<0||!Number.isSafeInteger(output)||output<0) return null;
  for(const key of ['cache_creation_input_tokens','cache_read_input_tokens']) {
    if(u[key]===undefined)continue;
    if(!Number.isSafeInteger(u[key])||u[key]<0)return null;
    input+=u[key];
  }
  const total=u.total_tokens??input+output;
  if(!Number.isSafeInteger(input)||!Number.isSafeInteger(total)||total<input+output)return null;
  return {input,output,total};
}
// Parse complete SSE events across arbitrary byte boundaries without retaining content.
export function extractBillingUsage(data) {
  const counts=extractUsage(data);
  if (!counts) return null;
  const u=data?.usage??data?.data?.usage??data?.response?.usage??data?.message?.usage;
  const inputDetails=u.prompt_tokens_details??u.input_tokens_details;
  const outputDetails=u.completion_tokens_details??u.output_tokens_details;
  return {...counts,cached_input:u.cache_read_input_tokens??inputDetails?.cached_tokens??null,
    cache_write:u.cache_creation_input_tokens??inputDetails?.cache_write_tokens??null,
    multimodal:[inputDetails?.audio_tokens,inputDetails?.image_tokens,outputDetails?.audio_tokens,outputDetails?.image_tokens].some(v=>v>0)};
}
export class UsageReader {
  constructor(protocol='chat') { this.protocol=protocol; }
  decoder = new TextDecoder();
  buffer = '';
  usage = null;
  billingUsage = null;
  serviceTier = null;
  upstreamId = null;
  done = false;
  failed = false;
  ended = false;
  push(chunk) {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    this.parse();
  }
  finish() {
    this.buffer += this.decoder.decode();
    this.parse();
  }
  parse() {
    let boundary;
    while ((boundary = /\r?\n\r?\n/.exec(this.buffer))) {
      const event = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary[0].length);
      const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, '')).join('\n');
      if (!data) continue;
      if (data === '[DONE]') { this.done = true; continue; }
      try {
        const value = JSON.parse(data);
        if (value.error || value.data?.error || ['error','response.failed','response.incomplete'].includes(value.type)) this.failed = true;
        const usage = extractUsage(value);
        if (usage) this.usage = usage;
        if (usage) this.billingUsage = extractBillingUsage(value);
        const tier=value.service_tier??value.response?.service_tier;
        if(typeof tier==='string')this.serviceTier=tier;
        if(this.protocol==='messages'&&value.type==='message_delta'&&this.usage&&Number.isSafeInteger(value.usage?.output_tokens)&&value.usage.output_tokens>=0) {
          this.usage={input:this.usage.input,output:value.usage.output_tokens,total:this.usage.input+value.usage.output_tokens};
          if(this.billingUsage)this.billingUsage={...this.billingUsage,...this.usage};
        }
        if(this.protocol==='responses'&&value.type==='response.completed'&&value.response?.status==='completed')this.done=true;
        if(this.protocol==='messages'&&value.type==='message_stop')this.done=true;
        const id = value.id ?? value.data?.id ?? value.response?.id ?? value.message?.id;
        if (typeof id === 'string') this.upstreamId = id.slice(0, 200);
        if (value.choices?.some((x) => x.finish_reason)) this.ended = true;
      } catch { this.failed = true; }
    }
    if (this.buffer.length > 2_000_000) throw new Error('sse_event_too_large');
  }
}
