import { prices } from './text-pricing.mjs';
import { httpError } from './security.mjs';
import chatCatalog from './desktop-chat-models.json' with { type: 'json' };

// Product adapters live here; clients only understand chat and image capabilities.
const catalog = [
  { id:'gpt-5.6-sol', name:'GPT 5.6', kind:'chat', contextWindow:128000, maxTokens:8192 },
  // Conservative client budgets, not claims about upstream context limits.
  // Keep the existing default first and expose only the reviewed upstream IDs.
  ...chatCatalog.ids.filter(id=>id!=='gpt-5.6-sol').map(id=>({
    id,name:id,kind:'chat',contextWindow:/^gpt-(3\.5|4(?:-|$))/.test(id)?4096:32768,maxTokens:/^gpt-(3\.5|4(?:-|$))/.test(id)?1024:4096,
  })),
  { id:'gpt-image-2', name:'GPT Image 2', kind:'image', sizes:['1:1','16:9','9:16','3:2','2:3','4:3','3:4','5:4','4:5','2:1','1:2','3:1','1:3','21:9','9:21'], default_size:'1:1' },
  { id:'gpt-image-2.5-flare', name:'GPT Image 2.5 Flare', kind:'image', sizes:['1:1','16:9','9:16','3:2','2:3','4:3','3:4','5:4','4:5','2:1','1:2','3:1','1:3','21:9','9:21'], default_size:'1:1' },
  { id:'gemini-3.1-flash-image-preview', name:'Gemini 3.1 Flash Image (Nano Banana 2)', kind:'image', sizes:['1:1','3:2','2:3','4:3','3:4','16:9','9:16','5:4','4:5','21:9','1:4','4:1','1:8','8:1'], default_size:'1:1' },
];
export function desktopCatalog(available) {
  const enabled = catalog.filter(model => available.has(model.id)&&(model.kind==='image'||Boolean(prices.models[model.id])&&!model.id.includes('search')));
  const models = enabled.filter(model => model.kind === 'chat');
  const images = enabled.filter(model => model.kind === 'image');
  return { default_model:models[0]?.id, models, image_models:images };

}
export function adaptModelRequest(path, body) {
  if (body.model === 'gpt-5.6-sol' && path === '/v1/chat/completions') {
    // APIMart chat function tools require reasoning disabled, including when omitted.
    return { ...body, reasoning_effort:'none' };
  }
  if(body.model==='gemini-3.1-flash-image-preview' && path==='/v1/images/generations'){
    const size=body.size==='auto'?'1:1':body.size??'1:1';
    const resolution=String(body.resolution??'1K').toUpperCase();
    if(!catalog.find(m=>m.id===body.model).sizes.includes(size))throw httpError(400,'unsupported_image_size');
    if(!['1K','2K','4K'].includes(resolution)||body.n!==undefined&&body.n!==1||body.image_urls?.length>14)throw httpError(400,'unpriced_image_options');
    if(body.official_fallback||body.google_search||body.google_image_search)throw httpError(400,'unpriced_image_options');
    return {model:body.model,prompt:body.prompt,size,resolution,n:1,stream:false,...(body.image_urls?{image_urls:body.image_urls}:{})};
  }
  if (['gpt-image-2','gpt-image-2.5-flare'].includes(body.model) && path === '/v1/images/generations') {
    const model = catalog.find(model => model.id === body.model);
    const sizes = {'1024x1024':'1:1','1792x1024':'16:9','1024x1792':'9:16','1536x1024':'3:2','1024x1536':'2:3'};
    const size = sizes[body.size] ?? (body.size === 'auto' ? model.default_size : body.size) ?? model.default_size;
    if (!model.sizes.includes(size)) throw httpError(400,'unsupported_image_size');
    const standard = body.model === 'gpt-image-2.5-flare';
    if(standard && body.quality!==undefined && body.quality!=='medium')throw httpError(400,'unsupported_image_quality');
    const resolution = body.resolution ?? (standard?'1k':undefined) ?? {low:'1k',medium:'2k',high:'4k'}[body.quality] ?? '1k';
    if(!['1k','2k','4k'].includes(resolution)||body.n!==undefined&&body.n!==1)throw httpError(400,'unpriced_image_options');
    const {quality,detail,response_format,...rest} = body;
    return { ...rest, size, resolution, n:1, ...(standard?{quality:'medium'}:{}) };
  }
  return body;
}
