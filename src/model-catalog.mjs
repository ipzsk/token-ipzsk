import { readFileSync } from 'node:fs';
import { httpError } from './security.mjs';
import { modelParams, onlyKnownKeys } from './validation.mjs';
import { imageUploadExtraKeys } from './image-upload.mjs';

const data = JSON.parse(readFileSync(new URL('./model-catalog.json', import.meta.url), 'utf8'));
const mediaPaths = ['/v1/images/generations','/v1/videos/generations'];
// Media bodies are whitelisted: an unregistered key can change what the upstream charges, so it is refused rather than forwarded.
// agentRequest already forced stream/n, and detail/response_format are OpenAI-only fields we strip below.
const gatewayKeys = ['model','prompt','stream','n','detail','response_format'];
// Image edits arrive as multipart; image-upload.mjs already whitelists these fields before we see them.
// The list is imported, never re-typed: two copies of the same whitelist drift, and a drifted copy here means a 400 on a valid edit.
const imageEditKeys = [...imageUploadExtraKeys];
// Every spelling a param answers to on the way in: internal name, frontend alias, OpenAI dialect key.
const spellings = m => Object.entries(m.params).flatMap(([name, p]) => [name, ...(p.aliases ?? []), ...Object.keys(p.from_openai ?? {})]);
function media(id) {
  const model = data.models[id];
  if (!model) throw httpError(400, 'unknown_model');
  if (!model.tiers) throw httpError(400, 'model_not_media');
  return model;
}
export function modelCatalog() { return data; }
// The frontend renders from canonical fields only; internal names and upstream keys stay inside the gateway.
const canonicalParams = m => [
  ...(m.kind === 'chat' ? [] : [{ field:'prompt', type:'string', required:true }]),
  ...Object.values(m.params).flatMap(p => (p.aliases ?? []).filter(a => Object.hasOwn(data.canonical_params, a)).map(field => ({
    field, type:p.type, values:p.values, default:p.default, required:p.required ?? false, min:p.min, max:p.max, unit:p.unit }))),
];
function deprecatedSizes(m) {
  const ratio = m.params?.size ?? Object.values(m.params ?? {}).find(p => p.aliases?.includes('aspect_ratio'));
  if (!ratio?.values?.length) return {};
  return { sizes:ratio.values, default_size:ratio.default ?? ratio.values[0] };
}

export function desktopCatalog(available) {
  const entries = Object.entries(data.models).filter(([id]) => available.has(id)).map(([id, m]) => ({
    id, name:m.name, kind:m.kind, billing_unit:m.billing_unit, require_tier:m.require_tier,
    default_tier:m.default_tier, tiers:m.tiers && Object.keys(m.tiers),
    params:canonicalParams(m), unsupported:m.unsupported ?? {},
    ...(m.kind === 'chat' ? { contextWindow:m.context_window, maxTokens:m.max_tokens } : {}),
    // Deprecated compat for shipped desktop clients: ipzsk-auth.ts throws when an image model
    // lacks sizes/default_size, so removing them locks every installed client out at login.
    // New code reads params[field==='aspect_ratio'] instead. Drop once no released client validates them.
    ...(m.kind === 'image' ? deprecatedSizes(m) : {}),
  }));
  const byKind = kind => entries.filter(m => m.kind === kind);
  const models = byKind('chat');
  return { canonical_params:data.canonical_params, default_model:models[0]?.id, models, image_models:byKind('image'), video_models:byKind('video') };
}
export function adaptModelRequest(path, body) {
  // force_params are the upstream-mandated overrides a model declares; they win over anything the client sent.
  if (!mediaPaths.includes(path)) {
    const model = data.models[body.model];
    return model?.force_params ? { ...body, ...model.force_params } : body;
  }
  const model = media(body.model);
  // A field the model cannot honour is refused, never dropped: a silent drop looks like it took effect.
  for (const [field, reason] of Object.entries(model.unsupported ?? {})) {
    if (body[field] !== undefined) throw Object.assign(httpError(400, 'unsupported_parameter_for_model'), { message:`${field}: ${reason}` });
  }
  onlyKnownKeys(body, new Set([...gatewayKeys, ...spellings(model), ...(model.kind === 'image' ? imageEditKeys : [])]));
  return toUpstreamRequest(body.model, body);
}
// Renames the normalized params to what this model's upstream calls them; internal names never leave the gateway.
export function toUpstreamRequest(model, body) {
  const m = media(model), params = modelParams(m.params, body);
  const drop = new Set(['detail', 'response_format', ...spellings(m)]);
  const rest = Object.fromEntries(Object.entries(body).filter(([key]) => !drop.has(key)));
  const upstream = Object.entries(params).map(([name, value]) => {
    const { key, values } = m.params[name].upstream;
    return [key, values?.[value] ?? value];
  });
  return { ...rest, ...Object.fromEntries(upstream), ...m.force_params, ...(m.kind === 'image' ? { n:1 } : {}) };
}
export function resolveTier(model, body) {
  const m = media(model), params = modelParams(m.params, body);
  let tier = m.default_tier;
  for (const field of m.tier_from) {
    const value = params[field];
    if (value == null || value === false) continue;
    tier = value === true ? m.params[field].tier_when_true : value;
    break;
  }
  if (tier == null) throw httpError(400, 'missing_tier');
  if (!Object.hasOwn(m.tiers, tier)) throw httpError(400, 'unknown_tier');
  return { tier, durationSec:m.billing_unit === 'per_second' ? params.duration : null };
}
export function mediaPricing(model) {
  const { kind, billing_unit, base_usd, tiers, require_tier, default_tier } = media(model);
  return { kind, billing_unit, base_usd, tiers, require_tier, default_tier };
}
