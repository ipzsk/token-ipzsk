import { httpError } from './security.mjs';

// Product adapters live here; clients only understand chat and image capabilities.
const catalog = [
  { id:'gpt-5.6-sol', name:'GPT 5.6', kind:'chat', contextWindow:128000, maxTokens:8192 },
  { id:'gpt-image-2', name:'GPT Image 2', kind:'image', sizes:['1:1','16:9','9:16','3:2','2:3'], default_size:'1:1' },
];
export function desktopCatalog(available) {
  const enabled = catalog.filter(model => available.has(model.id));
  const models = enabled.filter(model => model.kind === 'chat');
  const images = enabled.filter(model => model.kind === 'image');
  return { default_model:models[0]?.id, models, image_models:images };

}
export function adaptModelRequest(path, body) {
  if (body.model === 'gpt-5.6-sol' && path === '/v1/chat/completions') {
    // APIMart chat function tools require reasoning disabled, including when omitted.
    return { ...body, reasoning_effort:'none' };
  }
  if (body.model === 'gpt-image-2' && path === '/v1/images/generations') {
    const model = catalog.find(model => model.id === body.model);
    const sizes = {'1024x1024':'1:1','1792x1024':'16:9','1024x1792':'9:16','1536x1024':'3:2','1024x1536':'2:3'};
    const size = sizes[body.size] ?? (body.size === 'auto' ? model.default_size : body.size) ?? model.default_size;
    if (!model.sizes.includes(size)) throw httpError(400,'unsupported_image_size');
    const resolution = {low:'1k',medium:'2k',high:'4k'}[body.quality] ?? '1k';
    const {quality,detail,response_format,...rest} = body;
    return { ...rest, size, resolution, n:1 };
  }
  return body;
}
