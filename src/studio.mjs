// 创作工作台（studio）后端：型号目录、批量报价、生成记录、会话、发送队列、用户模板、主体库、收藏。
// 生成本身仍走 gateway.mjs 的统一入口；这里提供它要用的校验与记录写入。
import { hash, httpError, RateLimiter } from './security.mjs';
import { stable } from './validation.mjs';
import { publicAsset } from './uploads.mjs';
import { referencesFor } from './media-references.mjs';
import { lanehubMode, ensureLanehubKey } from './lanehub.mjs';
import { points } from './billing.mjs';
import { avatarChoice, avatarUpstreamBody, isAvatarPhotoType, avatarItem, voiceItem, avatarDraftIssues, LIST_PATHS, QUOTE_MIN_SECONDS,
  AVATAR_ITEM_FIELDS, AVATAR_ASSET_FIELDS, AVATAR_SLOT_PLACEHOLDER } from './avatar-contract.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v) => typeof v === 'string' && UUID.test(v);
const PAGE = 50;
export const REFERENCE_URL_TTL = 3600;
export const MAX_ACTIVE_RECORDS = 24;
export const fail = (status, code, fields) => Object.assign(httpError(status, code), fields ? { fields } : {});
export const plainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ── 纯校验 ────────────────────────────────────────────────────────────────
export function validMentions(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 20) throw fail(400, 'invalid_mentions');
  for (const m of value) {
    if (!plainObject(m) || Object.keys(m).some((k) => !['type', 'id', 'name'].includes(k)) || !['subject', 'reference'].includes(m.type)
      || !isUuid(m.id) || typeof m.name !== 'string' || !m.name.length || m.name.length > 60) throw fail(400, 'invalid_mentions');
  }
  return value;
}

export function validPromptDoc(value) {
  if (value === undefined || value === null) return null;
  if (!plainObject(value) || Buffer.byteLength(JSON.stringify(value)) > 50_000) throw fail(400, 'invalid_prompt_doc');
  return value;
}

// 进程内 LRU：key = sha256(规范化 JSON{user, body})，TTL 取 10 分钟与 lanehub expires_at 的较小值。
export class QuoteCache {
  constructor({ max = 5000, ttlMs = 600_000, now = Date.now } = {}) { Object.assign(this, { max, ttlMs, now, map: new Map() }); }
  static key(userId, body) { return hash(JSON.stringify(stable({ user: userId, body }))); }
  get(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    this.map.delete(key);
    if (hit.until <= this.now()) return undefined;
    this.map.set(key, hit);
    return hit.value;
  }
  set(key, value, expiresAtMs = Infinity) {
    const until = Math.min(this.now() + this.ttlMs, expiresAtMs);
    if (until <= this.now()) return;
    this.map.delete(key);
    this.map.set(key, { value, until });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
}

function catalogModels({ lanehubCatalog }) {
  if (!lanehubCatalog) throw httpError(503, 'catalog_unavailable');
  return lanehubCatalog.media();
}
function maxImagesFor(options, model) {
  if (options.lanehubCatalog?.data) return options.lanehubCatalog.media().find((m) => m.id === model)?.references.maxImages ?? 0;
  return referencesFor(String(model)).maxImages;
}

const STUDIO_FIELDS = ['reference_asset_ids', 'batch_id', 'batch_position', 'thread_id', 'anchor_record_id', 'parent_record_id', 'mentions', 'prompt_doc', 'source'];

// 形象 / 音色列表缓存挂在目录实例上：列表接口写，生成校验（Avatar III 引擎）读，两边拿到的是同一个 lanehubCatalog。
const avatarLists = new WeakMap();
const avatarListCache = (catalog) => { let c = avatarLists.get(catalog); if (!c) avatarLists.set(catalog, c = new QuoteCache({ max: 200 })); return c; };
// 缓存里（任一档位、未过期）找到这个形象才返回；冷缓存 / 没见过 → null，交给 lanehub 判。
function cachedAvatar(catalog, id) {
  const cache = catalog && avatarLists.get(catalog);
  if (!cache) return null;
  for (const [key, hit] of cache.map) {
    if (!key.startsWith('avatars:') || hit.until <= cache.now()) continue;
    const found = hit.value.items.find((a) => a.id === id);
    if (found) return found;
  }
  return null;
}

const HEYGEN_ITEM = { avatars: avatarItem, voices: voiceItem };
// 按档位缓存 10 分钟；key 与 cachedAvatar 的 'avatars:' 前缀约定一致。account 只要 {secret_ref, lane}。
async function fetchHeygenList(options, account, kind, query = '') {
  const listCache = avatarListCache(options.lanehubCatalog ?? options);
  const key = `${kind}:${account.lane ?? 'official'}:${query}`;
  const hit = listCache.get(key);
  if (hit) return hit;
  const path = LIST_PATHS[kind] + (query ? '?' + query : '');
  const response = await options.upstream.request({ secret_ref: account.secret_ref, base_url: options.lanehub.baseUrl }, path, { signal: AbortSignal.timeout(15_000) })
    .catch(() => null);
  const data = response?.ok ? await response.json().catch(() => null) : (await response?.body?.cancel(), null);
  // lanehub: 503 heygen_channel_unavailable（没开 HeyGen 渠道）、502 heygen_upstream_error（HeyGen 失败）；老版本没有这两个接口（404）。
  if (response?.status === 502) throw fail(502, 'avatar_catalog_upstream_error');
  if (!Array.isArray(data?.items)) throw fail(503, 'avatar_catalog_unavailable');
  const value = { items: data.items.filter((x) => plainObject(x) && ['string', 'number'].includes(typeof x.id)).map(HEYGEN_ITEM[kind]) };
  listCache.set(key, value);
  return value;
}

// 冷缓存时 Avatar III 引擎预检不生效（交给 lanehub 拒）。目录每次刷新后在后台按档位预热一次形象列表：
// 每个档位借一个现有客户的令牌（列表只随档位变），没有 HeyGen 数字人型号 / 不在 lanehub 模式就什么也不做。
export async function warmAvatarLists(options) {
  const { db, lanehub, lanehubCatalog } = options;
  if (!lanehub || !lanehubCatalog?.data || !lanehubCatalog.media().some((m) => m.avatar) || !(await lanehubMode(db))) return [];
  const accounts = (await db.query(`SELECT DISTINCT ON (a.lane) a.lane,k.secret_ref FROM lanehub_accounts a JOIN upstream_keys k ON k.id=a.key_id
    WHERE k.enabled ORDER BY a.lane,a.created_at DESC`)).rows;
  const warmed = [];
  for (const account of accounts) { await fetchHeygenList(options, account, 'avatars'); warmed.push(account.lane); }
  return warmed;
}

// 运维用：最新一份形象列表缓存的年龄（秒）；没有未过期的就是 null。
export function avatarListCacheAge(catalog, now = Date.now()) {
  const cache = catalog && avatarLists.get(catalog);
  let newest = -Infinity;
  for (const [key, hit] of cache?.map ?? []) if (key.startsWith('avatars:') && hit.until > now) newest = Math.max(newest, hit.until);
  return newest === -Infinity ? null : Math.max(0, Math.round((now - (newest - cache.ttlMs)) / 1000));
}

const modelSpecOf = (options, model) => (options.lanehubCatalog?.data ? options.lanehubCatalog.media().find((m) => m.id === model) : undefined);

// 数字人：形象来源 × 声音来源由 avatarChoice 一处判定；素材（照片 / 录音 / 背景图）必须本人、ready、类型对。
// 返回 lanehub body（字段名见 avatar-contract.mjs）、引用素材 id（顺序：照片、录音、背景）和记录用的参数。
async function resolveAvatar(db, options, user, body, spec, { quote }) {
  const plain = Object.fromEntries(Object.entries(body).filter(([k]) => !STUDIO_FIELDS.includes(k)));
  if (Array.isArray(body.reference_asset_ids) && body.reference_asset_ids.length) {
    throw fail(400, 'unsupported_parameter', { field: 'reference_asset_ids', message: '数字人不收参考图：照片用 photo_asset_id，背景图用 background_asset_id' });
  }
  const choice = avatarChoice(plain, spec);
  if (spec.avatar.engine === 'iii' && choice.source === 'library') {
    const known = cachedAvatar(options.lanehubCatalog, plain.avatar_id);
    if (known?.engines.length && !known.engines.includes('avatar_iii')) {
      throw fail(400, 'avatar_engine_unavailable', { field: 'avatar_id', message: '该数字人不支持 Avatar III 引擎，请换一个数字人或改用 Avatar IV 型号' });
    }
  }
  const wanted = [['photo', choice.source === 'photo', plain.photo_asset_id], ['audio', choice.voice === 'audio', plain.audio_asset_id],
    ['background', choice.background === 'image', plain.background_asset_id]].filter(([, on]) => on);
  for (const [name, , id] of wanted) if (!isUuid(id)) throw fail(400, `invalid_${name}_asset_id`, { field: `${name}_asset_id` });
  const urls = {}, refs = [];
  let durationMs;
  if (wanted.length) {
    if (!options.imageStorage) throw httpError(503, 'media_storage_unavailable');
    const rows = (await db.query(`SELECT id,kind,content_type,object_key,duration_ms FROM media_assets WHERE id=ANY($1::uuid[]) AND user_id=$2 AND status='ready'`,
      [wanted.map(([, , id]) => id), user.id])).rows;
    for (const [name, , id] of wanted) {
      const row = rows.find((x) => x.id === id);
      if (name === 'audio') {
        if (row?.kind !== 'audio') throw fail(400, 'audio_asset_not_found', { field: 'audio_asset_id', message: '录音不存在或未上传完成，请重新上传 MP3/WAV' });
        if (!Number.isInteger(row.duration_ms)) throw fail(400, 'audio_duration_unknown', { field: 'audio_asset_id', message: '录音时长未知，请重新上传' });
        durationMs = row.duration_ms;
      } else {
        const label = name === 'photo' ? '照片' : '背景图';
        if (row?.kind !== 'image') throw fail(400, `${name === 'photo' ? 'avatar_photo' : 'background_asset'}_not_found`, { field: `${name}_asset_id`, message: `${label}不存在或未上传完成` });
        if (!isAvatarPhotoType(row.content_type)) {
          throw fail(400, `${name === 'photo' ? 'avatar_photo' : 'background'}_unsupported_type`, { field: `${name}_asset_id`, message: `${label}只支持 PNG 或 JPEG（HeyGen 不收 WebP），请转换格式后重新上传` });
        }
      }
      urls[name] = options.imageStorage.getUrl(row.object_key, REFERENCE_URL_TTL);
      refs.push(id);
    }
  }
  const upstream = avatarUpstreamBody(plain, choice, urls, { duration: quote && durationMs !== undefined ? Math.ceil(durationMs / 1000) : undefined });
  const { model, script, ...rest } = plain;
  const params = { ...rest, avatar_source: choice.source, voice_source: choice.voice, ...(durationMs !== undefined ? { audio_duration_ms: durationMs } : {}) };
  return { upstream, refs, avatar: { choice, durationMs, params, prompt: typeof script === 'string' ? script : '' } };
}

// 参考素材 id → 1 小时预签名 GET（私有 bucket，绝不给公开 URL）。返回去掉 studio 字段后的上游 body。
export async function resolveReferences(db, options, user, body, { quote = false } = {}) {
  const spec = modelSpecOf(options, body.model);
  if (spec?.avatar) return resolveAvatar(db, options, user, body, spec, { quote });
  const upstream = Object.fromEntries(Object.entries(body).filter(([k]) => !STUDIO_FIELDS.includes(k)));
  const refs = body.reference_asset_ids ?? [];
  if (!Array.isArray(refs) || refs.some((id) => !isUuid(id)) || new Set(refs).size !== refs.length) throw fail(400, 'invalid_reference_asset_ids');
  if (!refs.length) return { upstream, refs };
  if (refs.length > maxImagesFor(options, body.model)) throw fail(400, 'too_many_references');
  if (upstream.image_urls !== undefined) throw fail(400, 'conflicting_parameter');
  if (!options.imageStorage) throw httpError(503, 'media_storage_unavailable');
  const rows = (await db.query(`SELECT id,object_key FROM media_assets WHERE id=ANY($1::uuid[]) AND user_id=$2 AND status='ready' AND kind='image'`,
    [refs, user.id])).rows;
  if (rows.length !== refs.length) throw fail(400, 'reference_asset_not_found');
  const keys = new Map(rows.map((r) => [r.id, r.object_key]));
  upstream.image_urls = refs.map((id) => options.imageStorage.getUrl(keys.get(id), REFERENCE_URL_TTL));
  return { upstream, refs };
}

// cookie 会话的生成请求：校验 studio 字段（全部在创建 requests 之前，4xx 不留记录）。
export async function prepareStudioGeneration(db, options, user, kind, body) {
  if (!plainObject(body) || Buffer.isBuffer(body)) return null;
  const { upstream, refs, avatar } = await resolveReferences(db, options, user, body);
  const { batch_id = null, batch_position = null, thread_id = null, anchor_record_id = null, parent_record_id = null, source = 'studio' } = body;
  if (batch_id !== null && !isUuid(batch_id)) throw fail(400, 'invalid_batch_id');
  if (batch_position !== null && (!Number.isInteger(batch_position) || batch_position < 0 || batch_position > 11 || batch_id === null)) throw fail(400, 'invalid_batch_position');
  if (!['studio', 'template', 'canvas'].includes(source)) throw fail(400, 'invalid_source');
  const mentions = validMentions(body.mentions), prompt_doc = validPromptDoc(body.prompt_doc);
  for (const [value, code] of [[thread_id, 'invalid_thread_id'], [anchor_record_id, 'invalid_anchor_record_id'], [parent_record_id, 'invalid_parent_record_id']]) {
    if (value !== null && !isUuid(value)) throw fail(400, code);
  }
  if (thread_id && !(await db.query('SELECT 1 FROM generation_threads WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL', [thread_id, user.id])).rowCount) {
    throw fail(404, 'thread_not_found');
  }
  if (anchor_record_id) {
    const anchor = (await db.query('SELECT status FROM generation_records WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL', [anchor_record_id, user.id])).rows[0];
    if (!anchor) throw fail(404, 'record_not_found');
    if (anchor.status !== 'succeeded') throw fail(409, 'anchor_not_succeeded');
  }
  if (parent_record_id && !(await db.query('SELECT 1 FROM generation_records WHERE id=$1 AND user_id=$2', [parent_record_id, user.id])).rowCount) {
    throw fail(404, 'record_not_found');
  }
  const { model, prompt, image_urls, stream, ...params } = upstream;
  // 数字人：script 进 prompt 列，参数存素材 id 与选择（不存预签名 URL）。
  return { body: upstream, avatar: Boolean(avatar), record: { kind, model: String(model ?? ''),
    prompt: avatar ? avatar.prompt : typeof prompt === 'string' ? prompt : '', params: avatar ? avatar.params : params, refs,
    batch_id, batch_position, thread_id, anchor_record_id, parent_record_id, source, mentions, prompt_doc } };
}

// 与 INSERT requests 同一事务调用。进行中上限用每用户咨询锁串行化计数。
export async function insertGenerationRecord(c, requestId, userId, r) {
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['generation-active:' + userId]);
  const active = (await c.query(`SELECT count(*)::int AS n FROM generation_records WHERE user_id=$1 AND status IN ('queued','running')`, [userId])).rows[0].n;
  if (active >= MAX_ACTIVE_RECORDS) throw fail(429, 'too_many_active');
  const id = (await c.query(`INSERT INTO generation_records(user_id,request_id,batch_id,batch_position,anchor_record_id,parent_record_id,
      kind,model,prompt,params,status,thread_id,source,mentions,prompt_doc)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'queued',$11,$12,$13,$14) RETURNING id`,
  [userId, requestId, r.batch_id, r.batch_position, r.anchor_record_id, r.parent_record_id, r.kind, r.model, r.prompt, JSON.stringify(r.params),
    r.thread_id, r.source, JSON.stringify(r.mentions), r.prompt_doc === null ? null : JSON.stringify(r.prompt_doc)])).rows[0].id;
  for (const [position, assetId] of r.refs.entries()) {
    await c.query('INSERT INTO generation_references(record_id,asset_id,position) VALUES($1,$2,$3)', [id, assetId, position]);
  }
  if (r.thread_id) await c.query('UPDATE generation_threads SET updated_at=now() WHERE id=$1', [r.thread_id]);
  return id;
}

// media_tasks 上游状态 → 记录状态。
export function recordStatus(taskStatus) {
  return { completed: 'succeeded', failed: 'failed', cancelled: 'cancelled', processing: 'running' }[taskStatus] ?? 'queued';
}

// ── 路由 ──────────────────────────────────────────────────────────────────
export function me(req) {
  if (!req.apiUser?.session_id) throw httpError(403, 'customer_login_required');
  return req.apiUser.id;
}
function decodeCursor(cursor) {
  let at, id;
  try { [at, id] = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8')); } catch { /* invalid below */ }
  if (typeof at !== 'string' || !Number.isFinite(Date.parse(at)) || !isUuid(id)) throw fail(400, 'invalid_cursor');
  return [at, id];
}
// where/args are mutated; col is the ordering timestamp column (qualified), idCol its id.
export function addCursor(query, where, args, col, idCol) {
  if (query?.cursor === undefined) return;
  const [at, id] = decodeCursor(query.cursor);
  args.push(at, id);
  where.push(`(${col},${idCol})<($${args.length - 1}::timestamptz,$${args.length}::uuid)`);
}
export function paged(rows, map, size = PAGE) {
  const last = rows.length > size ? rows[size - 1] : null;
  return { items: rows.slice(0, size).map(map), next_cursor: last ? Buffer.from(JSON.stringify([last.cursor_at, last.id])).toString('base64url') : null };
}
export function body(req) {
  if (!plainObject(req.body)) throw fail(400, 'invalid_request');
  return req.body;
}
export function pageLimit(value) {
  if (value === undefined) return PAGE;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > PAGE) throw fail(400, 'invalid_limit');
  return n;
}
export const idParam = (value, code) => { if (!isUuid(value)) throw fail(404, code); return value; };

export function studioRoutes(app, options) {
  const { db, imageStorage: storage } = options;
  const quoteLimiter = new RateLimiter(), quoteCache = new QuoteCache();
  const asset = (row) => {
    if (!row) return null;
    if (row.status !== 'ready') return { id: row.id, status: row.status, missing: true };
    if (!storage) return { id: row.id, kind: row.kind, status: row.status, thumb_state: row.thumb_state, urls: {} };
    return publicAsset(row, storage);
  };
  const ownedAssets = async (userId, ids, extra = '') => ids.length ? (await db.query(
    `SELECT id FROM media_assets WHERE id=ANY($1::uuid[]) AND user_id=$2 AND status<>'deleted' ${extra}`, [ids, userId])).rows.length : 0;

  // ── B2：型号目录与报价 ──
  app.get('/api/me/media/models', async () => ({ models: catalogModels(options) }));

  app.post('/api/me/media/quote', async (req) => {
    const user = req.apiUser;
    quoteLimiter.take('quote:' + user.id, 60); // 按调用计，数组算一次
    const items = req.body?.items;
    if (!Array.isArray(items) || !items.length || items.length > 12) throw fail(400, 'invalid_items');
    if (!options.lanehub || !(await lanehubMode(db))) throw fail(409, 'quote_requires_lanehub');
    const account = await ensureLanehubKey(db, options, user);
    // 用户自己的 lanehub 令牌：lanehub 按令牌所在档位报价。
    const channel = { secret_ref: account.secret_ref, base_url: options.lanehub.baseUrl };
    const quoteOne = async (item) => {
      if (!plainObject(item)) throw fail(400, 'invalid_item');
      const key = QuoteCache.key(user.id, item);
      const hit = quoteCache.get(key);
      if (hit) return hit;
      const { upstream: payload, avatar } = await resolveReferences(db, options, user, item, { quote: true });
      const response = await options.upstream.request(channel, '/v1/quote', { method: 'POST', body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000) });
      let data = null;
      try { data = await response.json(); } catch { /* handled below */ }
      if (!response.ok) throw Object.assign(new Error(String(data?.message ?? data?.error?.message ?? 'quote_failed').slice(0, 300)),
        { code: String(data?.code ?? data?.error?.code ?? 'upstream_http_' + response.status).slice(0, 100) });
      if (typeof data?.amount_cny !== 'string' || !/^\d{1,12}\.\d{8}$/.test(data.amount_cny) || !Number.isFinite(data.expires_at)) {
        throw Object.assign(new Error('invalid_quote_response'), { code: 'invalid_quote_response' });
      }
      const value = { points: points(data.amount_cny), amount_cny: data.amount_cny, quote_id: data.quote_id ?? null,
        expires_at: new Date(data.expires_at * 1000).toISOString() };
      if (typeof data.amount_kind === 'string') value.amount_kind = data.amount_kind;
      if (avatar) {
        // 录音驱动：报价体带了服务端测得的 duration（lanehub 按它估）；对面没回秒数时按 max(60s, 录音时长) 自算展示值。
        const audio = avatar.choice.voice === 'audio';
        const seconds = Number(data.estimated_seconds) > 0 ? Number(data.estimated_seconds)
          : audio ? Math.max(QUOTE_MIN_SECONDS, Math.ceil(avatar.durationMs / 1000)) : null;
        if (seconds !== null) Object.assign(value, { estimated_seconds: seconds, estimate_basis: audio ? 'audio_duration' : 'script' });
      }
      quoteCache.set(key, value, data.expires_at * 1000);
      return value;
    };
    return { items: await Promise.all(items.map((item) => quoteOne(item)
      .catch((e) => ({ error: { code: e.code ?? 'quote_failed', message: e.fields?.message ?? e.message ?? 'quote_failed' } })))) };
  });

  // ── Bearer 报价：/v1/* 的 API 客户端用 lanehub 字段名的 body（与 /v1/videos/generations 相同）问价，原样转发给
  // lanehub /v1/quote（用这个客户自己的令牌 → 按他的档位报价），响应状态与 JSON 原样返回。不缓存、不改写。
  app.post('/v1/quote', async (req, reply) => {
    const user = req.apiUser;
    quoteLimiter.take('quote:' + user.id, 60);
    const payload = req.body;
    if (!plainObject(payload) || typeof payload.model !== 'string' || !payload.model || payload.model.length > 128) throw fail(400, 'invalid_request');
    if (!options.lanehub || !(await lanehubMode(db))) throw fail(409, 'quote_requires_lanehub');
    const account = await ensureLanehubKey(db, options, user);
    const response = await options.upstream.request({ secret_ref: account.secret_ref, base_url: options.lanehub.baseUrl }, '/v1/quote',
      { method: 'POST', body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000) }).catch(() => null);
    const text = response ? await response.text().catch(() => null) : null;
    let data = null;
    try { data = text !== null && text.length <= 1_000_000 ? JSON.parse(text) : null; } catch { /* handled below */ }
    // 401/403 说明是我们给这个客户签的 lanehub 令牌出了问题，不能原样回给客户端冒充他自己的凭证无效。
    if (!plainObject(data) || [401, 403].includes(response.status)) throw fail(502, 'quote_upstream_error');
    return reply.code(response.status).send(data);
  });

  // ── 数字人形象 / 音色列表：用户自己的 lanehub 令牌代理，按档位缓存 10 分钟 ──
  const heygenList = (kind) => async (req) => {
    const user = req.apiUser;
    quoteLimiter.take(kind + ':' + user.id, 60);
    const q = req.query ?? {}, filters = new URLSearchParams();
    if (kind === 'voices' && q.language !== undefined) {
      if (typeof q.language !== 'string' || !/^[\p{L}\p{N} _()-]{1,40}$/u.test(q.language)) throw fail(400, 'invalid_language');
      filters.set('language', q.language);
    }
    if (kind === 'voices' && q.type !== undefined) {
      if (!['public', 'private'].includes(q.type)) throw fail(400, 'invalid_voice_type');
      filters.set('type', q.type);
    }
    if (!options.lanehub || !(await lanehubMode(db))) throw fail(503, 'avatar_catalog_unavailable');
    const account = await ensureLanehubKey(db, options, user);
    return fetchHeygenList(options, account, kind, filters.toString());
  };
  app.get('/api/me/avatars', heygenList('avatars'));
  app.get('/api/me/voices', heygenList('voices'));

  // ── 生成记录 ──
  const generationSelect = `SELECT g.*,g.created_at::text AS cursor_at,r.idempotency_key,
      coalesce(g.charged_points,CASE WHEN b.state IN ('settled','released') THEN b.charged_cny*100 END)::numeric(20,8)::text AS points
    FROM generation_records g LEFT JOIN requests r ON r.id=g.request_id LEFT JOIN request_billing b ON b.request_id=g.request_id`;
  async function generationItems(rows) {
    const ids = rows.map((r) => r.id), tasks = rows.map((r) => r.task_id).filter(Boolean);
    const refs = ids.length ? (await db.query(`SELECT gr.record_id,a.* FROM generation_references gr JOIN media_assets a ON a.id=gr.asset_id
      WHERE gr.record_id=ANY($1::uuid[]) ORDER BY gr.position`, [ids])).rows : [];
    const results = tasks.length ? (await db.query(`SELECT * FROM media_assets WHERE task_id=ANY($1::uuid[]) AND status='ready' ORDER BY result_index`, [tasks])).rows : [];
    return rows.map((g) => ({ id: g.id, kind: g.kind, model: g.model, prompt: g.prompt, params: g.params, status: g.status, failure_code: g.failure_code,
      charged_points: g.points, thread_id: g.thread_id, batch_id: g.batch_id, batch_position: g.batch_position,
      anchor_record_id: g.anchor_record_id, parent_record_id: g.parent_record_id, source: g.source, mentions: g.mentions, prompt_doc: g.prompt_doc,
      request_id: g.request_id, task_id: g.task_id, idempotency_key: g.idempotency_key, created_at: g.created_at, updated_at: g.updated_at,
      references: refs.filter((x) => x.record_id === g.id).map(asset), results: results.filter((x) => x.task_id === g.task_id).map(asset) }));
  }
  const oneGeneration = async (userId, id) => {
    const rows = (await db.query(`${generationSelect} WHERE g.id=$1 AND g.user_id=$2 AND g.deleted_at IS NULL`, [idParam(id, 'generation_not_found'), userId])).rows;
    if (!rows.length) throw fail(404, 'generation_not_found');
    return (await generationItems(rows))[0];
  };

  app.get('/api/me/generations', async (req) => {
    const userId = me(req), q = req.query ?? {}, args = [userId], where = ['g.user_id=$1', 'g.deleted_at IS NULL'];
    if (q.thread !== undefined) { if (!isUuid(q.thread)) throw fail(400, 'invalid_thread'); args.push(q.thread); where.push(`g.thread_id=$${args.length}`); }
    if (q.batch_id !== undefined) { if (!isUuid(q.batch_id)) throw fail(400, 'invalid_batch_id'); args.push(q.batch_id); where.push(`g.batch_id=$${args.length}`); }
    if (q.status !== undefined) { if (q.status !== 'active') throw fail(400, 'invalid_status'); where.push("g.status IN ('queued','running')"); }
    if (q.idempotency_key !== undefined) {
      if (typeof q.idempotency_key !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(q.idempotency_key)) throw fail(400, 'invalid_idempotency_key');
      args.push(q.idempotency_key); where.push(`r.idempotency_key=$${args.length}`);
    }
    addCursor(q, where, args, 'g.created_at', 'g.id');
    const rows = (await db.query(`${generationSelect} WHERE ${where.join(' AND ')} ORDER BY g.created_at DESC,g.id DESC LIMIT ${PAGE + 1}`, args)).rows;
    const page = paged(rows, (r) => r);
    return { items: await generationItems(page.items), next_cursor: page.next_cursor };
  });
  app.get('/api/me/generations/:id', async (req) => oneGeneration(me(req), req.params.id));
  app.patch('/api/me/generations/:id', async (req) => {
    const userId = me(req), { thread_id } = body(req);
    if (thread_id !== null && !isUuid(thread_id)) throw fail(400, 'invalid_thread_id');
    await oneGeneration(userId, req.params.id);
    if (thread_id && !(await db.query('SELECT 1 FROM generation_threads WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL', [thread_id, userId])).rowCount) {
      throw fail(404, 'thread_not_found');
    }
    await db.query('UPDATE generation_records SET thread_id=$3,updated_at=now() WHERE id=$1 AND user_id=$2', [req.params.id, userId, thread_id]);
    return oneGeneration(userId, req.params.id);
  });
  app.delete('/api/me/generations/:id', async (req, reply) => {
    const userId = me(req);
    const r = await db.query('UPDATE generation_records SET deleted_at=now() WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL', [idParam(req.params.id, 'generation_not_found'), userId]);
    if (!r.rowCount) throw fail(404, 'generation_not_found');
    return reply.code(204).send();
  });
  app.delete('/api/me/generations', async (req) => {
    const userId = me(req), batch = req.query?.batch_id;
    if (!isUuid(batch)) throw fail(400, 'invalid_batch_id');
    const r = await db.query('UPDATE generation_records SET deleted_at=now() WHERE batch_id=$1 AND user_id=$2 AND deleted_at IS NULL', [batch, userId]);
    return { deleted: r.rowCount };
  });

  // ── 会话 ──
  const threadOut = ({ id, title, created_at, updated_at }) => ({ id, title, created_at, updated_at });
  const title = (v) => { if (typeof v !== 'string' || v.length > 80) throw fail(400, 'invalid_title'); return v; };
  app.get('/api/me/threads', async (req) => {
    const args = [me(req)], where = ['user_id=$1', 'deleted_at IS NULL'];
    addCursor(req.query, where, args, 'updated_at', 'id');
    return paged((await db.query(`SELECT *,updated_at::text AS cursor_at FROM generation_threads WHERE ${where.join(' AND ')}
      ORDER BY updated_at DESC,id DESC LIMIT ${PAGE + 1}`, args)).rows, threadOut);
  });
  app.post('/api/me/threads', async (req) => {
    const userId = me(req), b = body(req);
    if (b.id !== undefined && !isUuid(b.id)) throw fail(400, 'invalid_id'); // 客户端可带 id 做乐观创建
    const row = (await db.query(`INSERT INTO generation_threads(id,user_id,title) VALUES(coalesce($1::uuid,gen_random_uuid()),$2,$3) RETURNING *`,
      [b.id ?? null, userId, title(b.title ?? '')])).rows[0];
    return threadOut(row);
  });
  app.patch('/api/me/threads/:id', async (req) => {
    const userId = me(req), b = body(req);
    const row = (await db.query('UPDATE generation_threads SET title=$3,updated_at=now() WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL RETURNING *',
      [idParam(req.params.id, 'thread_not_found'), userId, title(b.title)])).rows[0];
    if (!row) throw fail(404, 'thread_not_found');
    return threadOut(row);
  });
  app.delete('/api/me/threads/:id', async (req, reply) => {
    const userId = me(req), id = idParam(req.params.id, 'thread_not_found');
    await db.tx(async (c) => {
      const r = await c.query('UPDATE generation_threads SET deleted_at=now() WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL', [id, userId]);
      if (!r.rowCount) throw fail(404, 'thread_not_found');
      await c.query('UPDATE generation_records SET deleted_at=now() WHERE thread_id=$1 AND user_id=$2 AND deleted_at IS NULL', [id, userId]);
    });
    return reply.code(204).send();
  });

  // ── 队列与模板共用的项校验 ──
  async function validateItems(userId, items, template) {
    if (!Array.isArray(items) || items.length > 12 || (template && !items.length)) throw fail(400, 'invalid_items');
    if (Buffer.byteLength(JSON.stringify(items)) > 150_000) throw fail(413, 'items_too_large');
    const models = catalogModels(options), ids = new Set(), assetIds = new Set(), avatarAssets = [];
    items.forEach((item, index) => {
      const bad = (code, extra) => fail(400, code, { index, ...extra });
      if (!plainObject(item)) throw bad('invalid_item');
      const model = models.find((m) => m.id === item.model);
      const allowed = ['item_id', 'kind', 'model', 'prompt', 'params', 'anchor_of', 'mentions', 'prompt_doc', template ? 'references' : 'reference_asset_ids',
        ...(model?.avatar ? AVATAR_ITEM_FIELDS : [])];
      const extra = Object.keys(item).find((k) => !allowed.includes(k));
      if (extra) throw bad('unsupported_item_field', { field: extra.slice(0, 64) });
      if (!isUuid(item.item_id) || ids.has(item.item_id)) throw bad('invalid_item_id');
      ids.add(item.item_id);
      if (!model) throw bad('unknown_model');
      if (item.kind !== model.kind) throw bad('invalid_kind');
      if (typeof item.prompt !== 'string' || item.prompt.length > 16000) throw bad('invalid_prompt');
      if (model.avatar) avatarAssets.push(...avatarItemAssets(item, model, index, template));
      const params = item.params ?? {};
      if (!plainObject(params)) throw bad('invalid_params');
      for (const [field, value] of Object.entries(params)) {
        const spec = model.params.find((p) => p.field === field);
        if (!spec) throw bad(model.unsupported[field] ? 'unsupported_parameter_for_model' : 'unsupported_parameter', { field });
        const ok = spec.values ? ['string', 'number'].includes(typeof value) && spec.values.includes(String(value))
          : spec.type === 'integer' ? Number.isInteger(value) : spec.type === 'boolean' ? typeof value === 'boolean' : typeof value === 'string' && value.length <= 2000;
        if (!ok) throw bad('invalid_param_value', { field });
      }
      const refs = (template ? item.references : item.reference_asset_ids) ?? [];
      if (!Array.isArray(refs)) throw bad('invalid_reference');
      if (refs.length > model.references.maxImages) throw bad('too_many_references');
      for (const ref of refs) {
        if (template) {
          if (!plainObject(ref) || Object.keys(ref).length !== 1) throw bad('invalid_reference');
          if ('slot' in ref) { if (!Number.isInteger(ref.slot) || ref.slot < 0 || ref.slot >= model.references.maxImages) throw bad('invalid_reference'); continue; }
          if (!isUuid(ref.asset_id)) throw bad('invalid_reference');
          assetIds.add(ref.asset_id);
        } else {
          if (!isUuid(ref)) throw bad('invalid_reference');
          assetIds.add(ref);
        }
      }
      if (item.anchor_of != null && !isUuid(item.anchor_of)) throw bad('invalid_anchor');
      validMentions(item.mentions); validPromptDoc(item.prompt_doc);
    });
    items.forEach((item, index) => {
      if (item.anchor_of != null && (item.anchor_of === item.item_id || !ids.has(item.anchor_of))) throw fail(400, 'invalid_anchor', { index });
    });
    if (await ownedAssets(userId, [...assetIds]) !== assetIds.size) throw fail(400, 'reference_asset_not_found');
    await checkAvatarAssets(userId, avatarAssets);
  }

  // 数字人项：avatarChoice 同一套规则。队列 = 草稿（缺项只进 issues）；模板 = 可直接套用（缺项 400，{slot} 占位算已给）。
  // 返回要查归属 / 类型的素材 [index, field, id]。
  function avatarItemAssets(item, model, index, template) {
    const bad = (code, extra) => fail(400, code, { index, ...extra });
    if (item.prompt !== '') throw bad('avatar_prompt_not_supported', { field: 'prompt', message: '数字人不收 prompt：念的文字放 script，prompt 留空字符串' });
    const refs = (template ? item.references : item.reference_asset_ids) ?? [];
    if (!Array.isArray(refs) || refs.length) throw bad('unsupported_parameter', { field: template ? 'references' : 'reference_asset_ids', message: '数字人不收参考图：照片用 photo_asset_id，背景图用 background_asset_id' });
    const fields = {}, assets = [];
    for (const k of AVATAR_ITEM_FIELDS) {
      const v = item[k];
      if (v === undefined) continue;
      if (AVATAR_ASSET_FIELDS[k] && v !== null && v !== '') {
        const slot = template && plainObject(v) && Object.keys(v).length === 1 && Number.isInteger(v.slot) && v.slot >= 0 && v.slot < 15;
        if (!slot && !isUuid(v)) throw bad(`invalid_${AVATAR_ASSET_FIELDS[k]}_asset_id`, { field: k });
        if (!slot) assets.push([index, k, v]);
        fields[k] = slot ? AVATAR_SLOT_PLACEHOLDER : v;
      } else fields[k] = v;
    }
    let issues;
    try { issues = avatarDraftIssues(item.model, fields, model); } catch (e) { throw bad(e.code, e.fields); }
    if (template && issues.length) throw bad(issues[0].code, { field: issues[0].field, message: issues[0].message });
    return assets;
  }
  const ASSET_ERRORS = {
    photo_asset_id: ['image', true, 'avatar_photo_not_found', 'avatar_photo_unsupported_type', '照片'],
    background_asset_id: ['image', true, 'background_asset_not_found', 'background_unsupported_type', '背景图'],
    audio_asset_id: ['audio', false, 'audio_asset_not_found', null, '录音'],
  };
  async function checkAvatarAssets(userId, wanted) {
    if (!wanted.length) return;
    const rows = (await db.query(`SELECT id,kind,content_type FROM media_assets WHERE id=ANY($1::uuid[]) AND user_id=$2 AND status<>'deleted'`,
      [[...new Set(wanted.map((w) => w[2]))], userId])).rows;
    for (const [index, field, id] of wanted) {
      const row = rows.find((r) => r.id === id), [kind, photo, missing, badType, label] = ASSET_ERRORS[field];
      if (row?.kind !== kind) throw fail(400, missing, { index, field, message: `${label}不存在或不是${kind === 'audio' ? '录音' : '图片'}` });
      if (photo && !isAvatarPhotoType(row.content_type)) throw fail(400, badType, { index, field, message: `${label}只支持 PNG 或 JPEG（HeyGen 不收 WebP）` });
    }
  }

  // ── 发送队列 ──
  // missing：引用的素材被删了；issues：数字人草稿还缺什么（读取时按当前目录现算，不落库）。
  async function queueOut(userId, row) {
    const items = row?.items ?? [];
    const idsOf = (i) => [...(Array.isArray(i.reference_asset_ids) ? i.reference_asset_ids : []), ...Object.keys(AVATAR_ASSET_FIELDS).map((k) => i[k]).filter(isUuid)];
    const wanted = [...new Set(items.flatMap(idsOf))];
    const present = new Set(wanted.length ? (await db.query(`SELECT id FROM media_assets WHERE id=ANY($1::uuid[]) AND user_id=$2 AND status<>'deleted'`,
      [wanted, userId])).rows.map((r) => r.id) : []);
    return { items: items.map((i) => {
      const spec = modelSpecOf(options, i.model), out = idsOf(i).some((id) => !present.has(id)) ? { ...i, missing: true } : { ...i };
      if (spec?.avatar) {
        const fields = Object.fromEntries(AVATAR_ITEM_FIELDS.filter((k) => i[k] !== undefined).map((k) => [k, i[k]]));
        try { out.issues = avatarDraftIssues(i.model, fields, spec); } catch (e) { out.issues = [{ code: e.code, field: e.fields?.field ?? null, message: e.fields?.message ?? e.code }]; }
      }
      return out;
    }), revision: row?.revision ?? 0 };
  }
  const readQueue = async (c, userId) => (await c.query('SELECT items,revision FROM composer_queues WHERE user_id=$1', [userId])).rows[0];
  app.get('/api/me/queue', async (req) => { const userId = me(req); return queueOut(userId, await readQueue(db, userId)); });
  app.put('/api/me/queue', async (req, reply) => {
    const userId = me(req), { items, revision } = body(req);
    if (!Number.isInteger(revision) || revision < 0) throw fail(400, 'invalid_revision');
    const conflict = async (row) => reply.code(409).send({ error: { code: 'queue_conflict', message: 'queue_conflict' }, queue: await queueOut(userId, row) });
    const before = await readQueue(db, userId);
    if ((before?.revision ?? 0) !== revision) return conflict(before);
    // 保存时不回存 missing 标记，那是读取时算的。
    const clean = Array.isArray(items) ? items.map((i) => plainObject(i) ? Object.fromEntries(Object.entries(i).filter(([k]) => k !== 'missing' && k !== 'issues')) : i) : items;
    await validateItems(userId, clean, false);
    const saved = await db.tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['queue:' + userId]);
      const row = await readQueue(c, userId);
      if ((row?.revision ?? 0) !== revision) return { conflict: row };
      return (await c.query(`INSERT INTO composer_queues(user_id,items,revision) VALUES($1,$2,1)
        ON CONFLICT(user_id) DO UPDATE SET items=EXCLUDED.items,revision=composer_queues.revision+1,updated_at=now() RETURNING items,revision`,
      [userId, JSON.stringify(clean)])).rows[0];
    });
    if ('conflict' in saved) return conflict(saved.conflict);
    return queueOut(userId, saved);
  });

  // ── 用户模板 ──
  // cover / reference_assets 按当前用户解析（其他用户的素材、查不到的都当 MissingAsset），换设备也能直接显示缩略图。
  async function templatesOut(userId, rows) {
    const refIds = (t) => (Array.isArray(t.items) ? t.items : []).flatMap((i) => Array.isArray(i?.references) ? i.references : [])
      .map((r) => r?.asset_id).filter(isUuid);
    const wanted = [...new Set(rows.flatMap((t) => [t.cover_id, ...refIds(t)]).filter(isUuid))];
    const found = wanted.length ? (await db.query('SELECT * FROM media_assets WHERE user_id=$1 AND id=ANY($2::uuid[])', [userId, wanted])).rows : [];
    const resolve = (id) => asset(found.find((a) => a.id === id)) ?? { id, status: 'deleted', missing: true };
    return rows.map(({ id, name, cover_id, items, variables, created_at, updated_at }) => ({
      id, name, cover_id, cover: cover_id ? resolve(cover_id) : null, items, variables,
      reference_assets: Object.fromEntries(refIds({ items }).map((a) => [a, resolve(a)])), created_at, updated_at }));
  }
  const templateOut = async (userId, row) => (await templatesOut(userId, [row]))[0];
  const name = (v, max) => { if (typeof v !== 'string' || !v.trim() || v.trim().length > max) throw fail(400, 'invalid_name'); return v.trim(); };
  function variablesOf(v) {
    if (!Array.isArray(v) || v.length > 20) throw fail(400, 'invalid_variables');
    const names = new Set();
    for (const x of v) {
      if (!plainObject(x) || Object.keys(x).some((k) => !['name', 'label', 'default', 'required'].includes(k))
        || typeof x.name !== 'string' || !/^[\p{L}\p{N}_]{1,30}$/u.test(x.name) || names.has(x.name)
        || typeof x.label !== 'string' || !x.label.length || x.label.length > 60 || typeof x.required !== 'boolean'
        || (x.default !== undefined && (typeof x.default !== 'string' || x.default.length > 2000))) throw fail(400, 'invalid_variables');
      names.add(x.name);
    }
    return v;
  }
  const cover = async (userId, id) => {
    if (id === null || id === undefined) return null;
    if (!isUuid(id) || !(await ownedAssets(userId, [id]))) throw fail(400, 'invalid_cover');
    return id;
  };
  app.get('/api/me/templates', async (req) => {
    const userId = me(req), args = [userId], where = ['user_id=$1', 'deleted_at IS NULL'], limit = pageLimit(req.query?.limit);
    addCursor(req.query, where, args, 'updated_at', 'id');
    const page = paged((await db.query(`SELECT *,updated_at::text AS cursor_at FROM user_templates WHERE ${where.join(' AND ')}
      ORDER BY updated_at DESC,id DESC LIMIT ${limit + 1}`, args)).rows, (r) => r, limit);
    return { ...page, items: await templatesOut(userId, page.items) };
  });
  app.post('/api/me/templates', async (req) => {
    const userId = me(req), b = body(req);
    const n = name(b.name, 60), variables = variablesOf(b.variables ?? []), coverId = await cover(userId, b.cover_id);
    await validateItems(userId, b.items, true);
    return templateOut(userId, (await db.query(`INSERT INTO user_templates(user_id,name,cover_id,items,variables) VALUES($1,$2,$3,$4,$5) RETURNING *`,
      [userId, n, coverId, JSON.stringify(b.items), JSON.stringify(variables)])).rows[0]);
  });
  app.patch('/api/me/templates/:id', async (req) => {
    const userId = me(req), b = body(req), id = idParam(req.params.id, 'template_not_found');
    const row = (await db.query('SELECT * FROM user_templates WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL', [id, userId])).rows[0];
    if (!row) throw fail(404, 'template_not_found');
    const next = { name: b.name === undefined ? row.name : name(b.name, 60), variables: b.variables === undefined ? row.variables : variablesOf(b.variables),
      cover_id: b.cover_id === undefined ? row.cover_id : await cover(userId, b.cover_id), items: b.items === undefined ? row.items : b.items };
    if (b.items !== undefined) await validateItems(userId, b.items, true);
    return templateOut(userId, (await db.query(`UPDATE user_templates SET name=$3,cover_id=$4,items=$5,variables=$6,updated_at=now()
      WHERE id=$1 AND user_id=$2 RETURNING *`, [id, userId, next.name, next.cover_id, JSON.stringify(next.items), JSON.stringify(next.variables)])).rows[0]);
  });
  app.delete('/api/me/templates/:id', async (req, reply) => {
    const r = await db.query('UPDATE user_templates SET deleted_at=now() WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL', [idParam(req.params.id, 'template_not_found'), me(req)]);
    if (!r.rowCount) throw fail(404, 'template_not_found');
    return reply.code(204).send();
  });

  // ── 主体库 ──
  const SUBJECT_KINDS = ['person', 'character', 'product', 'object', 'scene', 'avatar'];
  // 数字人主体：HeyGen 形象库引用（external_ref）或 PNG/JPEG 照片素材，二选一。
  const httpsUrl = (v) => v === null || v === undefined || (typeof v === 'string' && v.length <= 2000 && /^https:\/\//.test(v));
  function externalRef(v) {
    if (v === null) return null;
    const ok = plainObject(v) && Object.keys(v).every((k) => ['provider', 'avatar_id', 'name', 'preview_image_url', 'preview_video_url'].includes(k))
      && v.provider === 'heygen' && typeof v.avatar_id === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(v.avatar_id)
      && (v.name === undefined || v.name === null || (typeof v.name === 'string' && v.name.length <= 100)) && httpsUrl(v.preview_image_url) && httpsUrl(v.preview_video_url);
    if (!ok) throw fail(400, 'invalid_external_ref');
    return { provider: 'heygen', avatar_id: v.avatar_id, name: v.name ?? null, preview_image_url: v.preview_image_url ?? null, preview_video_url: v.preview_video_url ?? null };
  }
  async function subjectsOut(rows) {
    const ids = rows.map((r) => r.id);
    const assets = ids.length ? (await db.query(`SELECT sa.subject_id,a.* FROM subject_assets sa JOIN media_assets a ON a.id=sa.asset_id
      WHERE sa.subject_id=ANY($1::uuid[]) ORDER BY sa.position`, [ids])).rows : [];
    return rows.map((s) => {
      const mine = assets.filter((a) => a.subject_id === s.id);
      return { id: s.id, name: s.name, kind: s.kind, note: s.note, external_ref: s.external_ref ?? null, cover_id: s.cover_id, cover: asset(mine.find((a) => a.id === s.cover_id)),
        assets: mine.map(asset), created_at: s.created_at, updated_at: s.updated_at };
    });
  }
  const oneSubject = async (userId, id) => {
    const row = (await db.query('SELECT * FROM subjects WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL', [idParam(id, 'subject_not_found'), userId])).rows[0];
    if (!row) throw fail(404, 'subject_not_found');
    return row;
  };
  const nameTaken = (e) => { if (e.code === '23505') throw fail(409, 'subject_name_taken'); throw e; };
  // 整份替换参考图（1–8，本人、ready、图片，顺序即 position）。封面：给了必须在其中；null → 第一张；不传 → 旧封面仍在其中则保留，否则第一张。
  async function setSubjectAssets(c, userId, subject, assetIds, coverId) {
    if (!Array.isArray(assetIds) || !assetIds.length || assetIds.length > 8 || assetIds.some((x) => !isUuid(x)) || new Set(assetIds).size !== assetIds.length) {
      throw fail(400, 'invalid_asset_ids');
    }
    const found = (await c.query(`SELECT id,content_type FROM media_assets WHERE id=ANY($1::uuid[]) AND user_id=$2 AND status='ready' AND kind='image'`, [assetIds, userId])).rows;
    if (found.length !== assetIds.length) throw fail(400, 'reference_asset_not_found');
    if (subject.kind === 'avatar') {
      if (subject.external_ref) throw fail(400, 'avatar_source_conflict', { message: '该数字人主体引用的是形象库数字人，不能再加照片' });
      if (found.some((a) => !isAvatarPhotoType(a.content_type))) throw fail(400, 'avatar_photo_unsupported_type', { message: '数字人照片只支持 PNG 或 JPEG（HeyGen 不收 WebP）' });
    }
    if (coverId !== undefined && coverId !== null && !assetIds.includes(coverId)) throw fail(400, 'invalid_cover');
    const nextCover = coverId ?? (coverId === undefined && assetIds.includes(subject.cover_id) ? subject.cover_id : assetIds[0]);
    await c.query('DELETE FROM subject_assets WHERE subject_id=$1', [subject.id]);
    for (const [position, id] of assetIds.entries()) await c.query('INSERT INTO subject_assets(subject_id,asset_id,position) VALUES($1,$2,$3)', [subject.id, id, position]);
    await c.query('UPDATE subjects SET cover_id=$2,updated_at=now() WHERE id=$1', [subject.id, nextCover]);
  }
  const subjectFields = (b, row = {}) => {
    const kind = b.kind ?? row.kind ?? 'person', note = b.note === undefined ? row.note ?? null : b.note;
    if (!SUBJECT_KINDS.includes(kind)) throw fail(400, 'invalid_kind');
    if (note !== null && (typeof note !== 'string' || note.length > 500)) throw fail(400, 'invalid_note');
    const ref = b.external_ref === undefined ? row.external_ref ?? null : externalRef(b.external_ref);
    if (ref && kind !== 'avatar') throw fail(400, 'invalid_external_ref', { message: 'external_ref 只用于 kind=avatar 的主体' });
    return { name: b.name === undefined ? row.name : name(b.name, 30), kind, note, external_ref: ref };
  };
  app.get('/api/me/subjects', async (req) => {
    const args = [me(req)], where = ['user_id=$1', 'deleted_at IS NULL'];
    addCursor(req.query, where, args, 'updated_at', 'id');
    const rows = (await db.query(`SELECT *,updated_at::text AS cursor_at FROM subjects WHERE ${where.join(' AND ')}
      ORDER BY updated_at DESC,id DESC LIMIT ${PAGE + 1}`, args)).rows;
    const page = paged(rows, (r) => r);
    return { items: await subjectsOut(page.items), next_cursor: page.next_cursor };
  });
  app.post('/api/me/subjects', async (req) => {
    const userId = me(req), b = body(req), f = subjectFields(b);
    if (f.name === undefined) throw fail(400, 'invalid_name');
    if (f.kind === 'avatar' && Boolean(f.external_ref) === (b.asset_ids !== undefined)) {
      throw fail(400, f.external_ref ? 'avatar_source_conflict' : 'avatar_source_required', { message: '数字人主体二选一：external_ref（形象库数字人）或 asset_ids（PNG/JPEG 照片）' });
    }
    const row = await db.tx(async (c) => {
      const s = (await c.query('INSERT INTO subjects(user_id,name,kind,note,external_ref) VALUES($1,$2,$3,$4,$5) RETURNING *',
        [userId, f.name, f.kind, f.note, f.external_ref && JSON.stringify(f.external_ref)]).catch(nameTaken)).rows[0];
      if (b.asset_ids !== undefined) await setSubjectAssets(c, userId, s, b.asset_ids, b.cover_id);
      return s;
    });
    return (await subjectsOut([await oneSubject(userId, row.id)]))[0];
  });
  app.patch('/api/me/subjects/:id', async (req) => {
    const userId = me(req), b = body(req), row = await oneSubject(userId, req.params.id), f = subjectFields(b, row);
    let coverId = row.cover_id;
    if (b.cover_id !== undefined) {
      if (b.cover_id !== null && !(await db.query('SELECT 1 FROM subject_assets WHERE subject_id=$1 AND asset_id=$2', [row.id, isUuid(b.cover_id) ? b.cover_id : null])).rowCount) {
        throw fail(400, 'invalid_cover');
      }
      coverId = b.cover_id ?? (await db.query('SELECT asset_id FROM subject_assets WHERE subject_id=$1 ORDER BY position LIMIT 1', [row.id])).rows[0]?.asset_id ?? null;
    }
    // 改成 avatar 或新挂形象库引用：现有照片要重新过 avatar 规则（external_ref 与照片二选一，照片只收 PNG/JPEG）。
    if (f.kind === 'avatar' && (row.kind !== 'avatar' || (f.external_ref && b.external_ref !== undefined))) {
      const types = (await db.query(`SELECT a.content_type FROM subject_assets sa JOIN media_assets a ON a.id=sa.asset_id WHERE sa.subject_id=$1`, [row.id])).rows.map((r) => r.content_type);
      if (f.external_ref && types.length) throw fail(400, 'avatar_source_conflict', { message: '该主体已有照片，不能再引用形象库数字人' });
      if (!f.external_ref && !types.length) throw fail(400, 'avatar_source_required', { message: '改成数字人主体需要 external_ref（形象库数字人）或先有 PNG/JPEG 照片' });
      if (!f.external_ref && types.some((t) => !isAvatarPhotoType(t))) {
        throw fail(400, 'avatar_photo_unsupported_type', { message: '该主体里有非 PNG/JPEG 的图片，数字人照片只支持 PNG 或 JPEG；先替换图片或改用 external_ref' });
      }
    }
    await db.query('UPDATE subjects SET name=$2,kind=$3,note=$4,cover_id=$5,external_ref=$6,updated_at=now() WHERE id=$1',
      [row.id, f.name, f.kind, f.note, coverId, f.external_ref && JSON.stringify(f.external_ref)]).catch(nameTaken);
    return (await subjectsOut([await oneSubject(userId, row.id)]))[0];
  });
  app.put('/api/me/subjects/:id/assets', async (req) => {
    const userId = me(req), b = body(req), row = await oneSubject(userId, req.params.id);
    await db.tx((c) => setSubjectAssets(c, userId, row, b.asset_ids, b.cover_id));
    return (await subjectsOut([await oneSubject(userId, row.id)]))[0];
  });
  app.delete('/api/me/subjects/:id', async (req, reply) => {
    const row = await oneSubject(me(req), req.params.id);
    await db.query('UPDATE subjects SET deleted_at=now() WHERE id=$1', [row.id]);
    return reply.code(204).send();
  });

  // ── 收藏 ──
  async function favoriteTarget(userId, type, id) {
    if (type === 'asset') {
      if (!isUuid(id) || !(await ownedAssets(userId, [id]))) throw fail(404, 'asset_not_found');
    } else if (type === 'case') {
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(id) || !(await db.query("SELECT 1 FROM inspiration_cases WHERE id=$1 AND status='published'", [id])).rowCount) {
        throw fail(404, 'case_not_found');
      }
    } else throw fail(400, 'invalid_favorite_type');
  }
  app.put('/api/me/favorites/:type/:id', async (req, reply) => {
    const userId = me(req), { type, id } = req.params;
    await favoriteTarget(userId, type, id);
    await db.query('INSERT INTO favorites(user_id,target_type,target_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [userId, type, id]);
    return reply.code(204).send();
  });
  app.delete('/api/me/favorites/:type/:id', async (req, reply) => {
    const userId = me(req), { type, id } = req.params;
    if (!['asset', 'case'].includes(type)) throw fail(400, 'invalid_favorite_type');
    await db.query('DELETE FROM favorites WHERE user_id=$1 AND target_type=$2 AND target_id=$3', [userId, type, id]);
    return reply.code(204).send();
  });
  app.get('/api/me/favorites', async (req) => {
    const userId = me(req), q = req.query ?? {}, args = [userId], where = ['user_id=$1'];
    if (q.type !== undefined) { if (!['asset', 'case'].includes(q.type)) throw fail(400, 'invalid_favorite_type'); args.push(q.type); where.push(`target_type=$${args.length}`); }
    if (q.cursor !== undefined) {
      let at, key;
      try { [at, key] = JSON.parse(Buffer.from(String(q.cursor), 'base64url').toString('utf8')); } catch { /* below */ }
      if (typeof at !== 'string' || !Number.isFinite(Date.parse(at)) || typeof key !== 'string') throw fail(400, 'invalid_cursor');
      args.push(at, key); where.push(`(created_at,target_type||':'||target_id)<($${args.length - 1}::timestamptz,$${args.length})`);
    }
    const rows = (await db.query(`SELECT target_type,target_id,created_at,created_at::text AS cursor_at FROM favorites WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC,target_type||':'||target_id DESC LIMIT ${PAGE + 1}`, args)).rows;
    const last = rows.length > PAGE ? rows[PAGE - 1] : null;
    return { items: rows.slice(0, PAGE).map(({ target_type, target_id, created_at }) => ({ target_type, target_id, created_at })),
      next_cursor: last ? Buffer.from(JSON.stringify([last.cursor_at, last.target_type + ':' + last.target_id])).toString('base64url') : null };
  });
}

// 契约登记（scripts/export-contracts.mjs → contracts/endpoints.json）。形状名见 src/contracts-schema.mjs；
// 鉴权与错误码由导出脚本从 handler 源码推出，这里只写请求/响应形状。
export const routeMeta = {
  'POST /api/me/images/generations': { body: 'GenerationBody', response: 'UpstreamPassthrough', headers: ['Idempotency-Key'] },
  'POST /api/me/videos/generations': { body: 'GenerationBody', response: 'UpstreamPassthrough', headers: ['Idempotency-Key'] },
  'GET /api/me/media/models': { response: 'ModelCatalog' },
  'GET /api/me/avatars': { response: 'AvatarList' },
  'GET /api/me/voices': { query: 'language,type', response: 'VoiceList' },
  'POST /api/me/media/quote': { body: 'QuoteRequest', response: 'QuoteResponse' },
  'POST /v1/quote': { body: 'BearerQuoteBody', response: 'UpstreamPassthrough' },
  'GET /api/me/generations': { query: 'GenerationListQuery', response: 'Page<GenerationRecord>' },
  'DELETE /api/me/generations': { query: 'batch_id', response: 'DeletedCount' },
  'GET /api/me/generations/:id': { response: 'GenerationRecord' },
  'PATCH /api/me/generations/:id': { body: 'GenerationPatch', response: 'GenerationRecord' },
  'DELETE /api/me/generations/:id': { response: 'Empty' },
  'GET /api/me/threads': { query: 'cursor', response: 'Page<Thread>' },
  'POST /api/me/threads': { body: 'ThreadCreate', response: 'Thread' },
  'PATCH /api/me/threads/:id': { body: 'ThreadPatch', response: 'Thread' },
  'DELETE /api/me/threads/:id': { response: 'Empty' },
  'GET /api/me/queue': { response: 'Queue' },
  'PUT /api/me/queue': { body: 'QueuePut', response: 'Queue', conflict: 'QueueConflict' },
  'GET /api/me/templates': { query: 'TemplateListQuery', response: 'Page<UserTemplate>' },
  'POST /api/me/templates': { body: 'UserTemplateCreate', response: 'UserTemplate' },
  'PATCH /api/me/templates/:id': { body: 'UserTemplatePatch', response: 'UserTemplate' },
  'DELETE /api/me/templates/:id': { response: 'Empty' },
  'GET /api/me/subjects': { query: 'cursor', response: 'Page<Subject>' },
  'POST /api/me/subjects': { body: 'SubjectCreate', response: 'Subject' },
  'PATCH /api/me/subjects/:id': { body: 'SubjectPatch', response: 'Subject' },
  'PUT /api/me/subjects/:id/assets': { body: 'SubjectAssetsPut', response: 'Subject' },
  'DELETE /api/me/subjects/:id': { response: 'Empty' },
  'PUT /api/me/favorites/:type/:id': { response: 'Empty' },
  'DELETE /api/me/favorites/:type/:id': { response: 'Empty' },
  'GET /api/me/favorites': { query: 'type,cursor', response: 'Page<Favorite>' },
};
