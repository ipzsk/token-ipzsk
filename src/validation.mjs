import { httpError } from './security.mjs';
export function text(value, max = 100) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw httpError(400, 'invalid_text');
  return value.trim();
}
export function uuid(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw httpError(400, 'invalid_id');
  }
  return value;
}
export function integer(value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw httpError(400, 'invalid_number');
  return value;
}
export function bool(value) {
  if (typeof value !== 'boolean') throw httpError(400, 'invalid_boolean');
  return value;
}
export function models(value) {
  if (!Array.isArray(value) || !value.length || value.length > 1000) throw httpError(400, 'invalid_models');
  return [...new Set(value.map((x) => text(x, 128)))];
}
export function chat(body) {
  if (!body || Array.isArray(body)) throw httpError(400, 'invalid_request');
  text(body.model, 128);
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 200) throw httpError(400, 'invalid_messages');
  for (const m of body.messages) {
    if (!m || !['system','user','assistant','tool','developer','function'].includes(m.role)) throw httpError(400, 'invalid_message_role');
  }
  if (body.stream !== undefined) bool(body.stream);
  if (body.n !== undefined && body.n !== 1) throw httpError(400, 'only_n_one_supported');
  for (const key of ['max_tokens', 'max_completion_tokens']) if (body[key] !== undefined) integer(body[key], 1, 32768);
  const limits = body.max_tokens === undefined && body.max_completion_tokens === undefined ? { max_tokens:4096 } : {};
  return { ...body, ...limits, stream: body.stream ?? false, n: 1 };
}
export function requestFilter(query, forcedUser) {
  const where = [], args = [];
  const add = (sql, value) => { args.push(value); where.push(sql.replace('?', `$${args.length}`)); };
  if (query.plugin_id) add('r.plugin_id=?', uuid(query.plugin_id));
  if (forcedUser || query.user_id) add('r.user_id=?', uuid(forcedUser || query.user_id));
  if (query.model) add('r.model=?', text(query.model, 128));
  if (query.status) {
    if (!['queued','running','succeeded','failed','uncertain'].includes(query.status)) throw httpError(400, 'invalid_status');
    add('r.status=?', query.status);
  }
  for (const [key, sql] of [['from', 'r.created_at>=?::timestamptz'], ['to', "r.created_at<(?::timestamptz+interval '1 day')"]]) {
    if (!query[key]) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(query[key]) || !Number.isFinite(Date.parse(query[key]))) throw httpError(400, 'invalid_date');
    add(sql, query[key] + 'T00:00:00+08:00');
  }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', args };
}
export function oneOf(value, values, code) {
  if (!values.includes(value)) throw httpError(400, code);
  return value;
}
// Maps an OpenAI-shaped body onto the upstream params a catalog model declares.
export function modelParams(params, body) {
  const out = {};
  for (const [name, spec] of Object.entries(params)) {
    // aliases (the frontend's shared vocabulary) and from_openai (the SDK dialect) both normalize onto one internal name.
    const tables = spec.from_openai ?? {}, given = new Set();
    for (const key of new Set([name, ...(spec.aliases ?? []), ...Object.keys(tables)])) {
      if (body[key] != null) given.add(tables[key] ? tables[key][body[key]] ?? body[key] : body[key]);
    }
    if (given.size > 1) throw httpError(400, 'conflicting_parameter');
    let value = given.values().next().value ?? spec.default;
    if (value == null) {
      if (spec.required) throw httpError(400, `missing_${name}`);
      continue;
    }
    if (spec.type === 'enum') oneOf(value, spec.values, `unsupported_${name === 'size' ? 'image_size' : name}`);
    if (spec.type === 'boolean') bool(value);
    if (spec.type === 'integer') integer(value, spec.min, spec.max);
    out[name] = value;
  }
  return out;
}
export function onlyKnownKeys(body, allowed) {
  const extra = Object.keys(body).find((key) => !allowed.has(key));
  // The API error body echoes only the code; the offending key rides along for the server log.
  if (extra !== undefined) throw Object.assign(httpError(400, 'unsupported_parameter'), { message: `unsupported_parameter: ${extra.slice(0, 64)}` });
}
