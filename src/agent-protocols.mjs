import { bool, chat, integer, text } from './validation.mjs';
import { httpError } from './security.mjs';

export function agentRequest(path, body) {
  if (path === '/v1/chat/completions') return chat(body);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400,'invalid_request');
  text(body.model,128);
  if (body.stream !== undefined) bool(body.stream);
  if (['/v1/images/generations','/v1/videos/generations'].includes(path)) {
    text(body.prompt,32000);
    if(body.stream)throw httpError(400,'media_uses_task_polling');
    if(body.n!==undefined)integer(body.n,1,4);
    if(body.image_urls!==undefined&&(!Array.isArray(body.image_urls)||body.image_urls.length>15||body.image_urls.some(url=>typeof url!=='string')))throw httpError(400,'invalid_reference_images');
    return {...body,stream:false};
  }
  if (path === '/v1/responses') {
    if (typeof body.input !== 'string' && !Array.isArray(body.input)) throw httpError(400,'invalid_input');
    // Stateless requests avoid exposing upstream response IDs across platform users.
    if (body.previous_response_id || body.conversation || body.background || body.store === true) throw httpError(400,'use_stateless_responses');
    if (body.max_output_tokens !== undefined) integer(body.max_output_tokens,1,128000);
    return {...body,store:false,stream:body.stream??false,max_output_tokens:body.max_output_tokens??32768};
  }
  if (path === '/v1/messages') {
    if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length>2000) throw httpError(400,'invalid_messages');
    for (const m of body.messages) if (!m || !['user','assistant'].includes(m.role)) throw httpError(400,'invalid_message_role');
    integer(body.max_tokens,1,128000);
    return {...body,stream:body.stream??false};
  }
  throw httpError(404,'unsupported_protocol');
}

export function agentHeaders(path, headers) {
  if (path !== '/v1/messages') return {};
  const version = headers['anthropic-version']??'2023-06-01';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(version)) throw httpError(400,'invalid_anthropic_version');
  const result={'anthropic-version':version};
  const beta=headers['anthropic-beta'];
  if (beta!==undefined) {
    if (typeof beta!=='string'||!/^[-a-zA-Z0-9, ]{1,2000}$/.test(beta)) throw httpError(400,'invalid_anthropic_beta');
    result['anthropic-beta']=beta;
  }
  return result;
}

export function agentResponse(path, raw) {
  if (['/v1/images/generations','/v1/videos/generations'].includes(path)) {
    if(raw?.code!==200||!Array.isArray(raw.data)||raw.data.length!==1||typeof raw.data[0]?.task_id!=='string'||!/^[-a-zA-Z0-9_]{1,200}$/.test(raw.data[0].task_id))throw new Error('invalid_upstream_task');
    return raw;
  }
  const value=raw?.data && !raw.object && !raw.type ? raw.data : raw;
  if (!value || value.error) throw new Error('invalid_upstream_response');
  if (path==='/v1/chat/completions' && !Array.isArray(value.choices)) throw new Error('invalid_upstream_response');
  if (path==='/v1/responses' && (value.object!=='response'||value.status!=='completed'||!Array.isArray(value.output))) throw new Error('invalid_upstream_response');
  if (path==='/v1/messages' && (value.type!=='message'||!Array.isArray(value.content))) throw new Error('invalid_upstream_response');
  if (path==='/v1/audio/transcriptions' && typeof value.text!=='string') throw new Error('invalid_upstream_response');
  return value;
}
