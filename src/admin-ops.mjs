// 运维后台（ipzsk-ops docs/admin-ops.md「网关契约」）：/api/admin/ops/* 代理 lanehub 管理 API。
// 读 viewer+，写 operator+。lanehub 原对象一律不透传：每个响应都按契约类型逐字段组装（key / proxy / header_override /
// model_headers / custom_parameter / plugin / other / base_url / metadata / source_ip 不出网关）。
// 金额全部在这里换成人民币：quota 走 quotaToCny，美元（余额、每分钟消费）乘 usdRate()。时间一律 unix 秒。
import { RateLimiter } from './security.mjs';
import { fail, plainObject } from './studio.mjs';
import { requireRole } from './roles.mjs';
import { quotaToCny } from './lanehub-charges.mjs';
import { t, schemas } from './contracts-schema.mjs';

const PRICE_SOURCES = ['row', 'borrowed', 'overridden', 'fallback'];
// lanehub 的 update_balance 失败时只剩 message（Lanehub.call 丢掉了 balance_state）；这几句是
// registry.ErrBalanceUnsupported / ErrBalanceUnimplemented / 声明未实现 / openai 关掉余额查询 的原文。
const NO_BALANCE_API = /没有余额接口|未实现余额查询|没有实现 base\.BalanceInterface|不支持余额查询/;
const META_TTL_MS = 10 * 60_000;

const num = (v, d = 0) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d);
const unix = () => Math.floor(Date.now() / 1000);
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')).toString();

function intParam(q, name, min, max) {
  const v = q[name];
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < min || (max !== undefined && n > max)) throw fail(400, 'invalid_query', { field: name });
  return n;
}
function strParam(q, name, max = 200) {
  const v = q[name];
  if (v === undefined || v === '') return undefined;
  if (typeof v !== 'string' || v.length > max) throw fail(400, 'invalid_query', { field: name });
  return v;
}

// ── 纯变换 ────────────────────────────────────────────────────────────────
export const usdToCny = (usd, rate) => Math.round(num(usd) * num(rate) * 1e6) / 1e6;
// 上游余额口径（lanehub balance_unit）：USD 换算、CNY 原样、raw（各家点数，未核实）不猜，balance_cny 为 null。
const UNITS = ['USD', 'CNY', 'raw'];
export const unitOf = (u) => (UNITS.includes(u) ? u : 'raw');
export const balanceCny = (raw, unit, rate) => (raw === null ? null : unit === 'USD' ? usdToCny(raw, rate) : unit === 'CNY' ? raw : null);
export const quotaCny = (quota, rate, perUnit) => Number(quotaToCny(Math.trunc(num(quota)), rate, perUnit));

function laneChannel(c, rate) {
  const checked = num(c.balance_updated_time) || null;
  const supported = c.balance_supported ?? true;
  const unit = unitOf(c.balance_unit), raw = supported && checked ? num(c.balance) : null;
  return {
    id: c.id, name: String(c.name ?? ''), type: num(c.type), status: num(c.status), priority: num(c.priority), weight: num(c.weight, 1),
    lanes: Array.isArray(c.lanes) ? c.lanes.map(String) : [], vendor: String(c.vendor ?? ''),
    // 余额是 lanehub channels.balance 的缓存，从没查过就是 null，不是 0。
    balance_cny: balanceCny(raw, unit, rate), balance_checked_at: checked, balance_raw: raw, balance_unit: unit, balance_supported: supported,
  };
}
const priceOf = (p) => (p ? { unit: String(p.unit ?? ''), cny: num(p.cny), source: PRICE_SOURCES.includes(p.source) ? p.source : 'fallback' } : null);

export function transformLaneMatrix(d, rate) {
  const channels = {}, vendor_icons = {};
  const seen = (c) => {
    channels[c.id] ??= laneChannel(c, rate);
    if (c.vendor && c.vendor_icon) vendor_icons[c.vendor] ??= c.vendor_icon;
    return c.id;
  };
  const chain = d.auto_chain ?? [];
  const at = (s) => (chain.includes(s) ? chain.indexOf(s) : chain.length);
  const lanes = (d.lanes ?? []).map(({ symbol, name, ratio }) => ({ symbol, name, ratio: num(ratio) }))
    .map((l, i) => [l, i]).sort(([a, i], [b, j]) => at(a.symbol) - at(b.symbol) || i - j).map(([l]) => l);
  const rows = (d.rows ?? []).map((r) => {
    for (const [k, v] of Object.entries(r.vendor_icons ?? {})) vendor_icons[k] ??= v;
    const prices = {};
    const note = (c) => { if (!(c.id in prices)) prices[c.id] = priceOf(c.price); return seen(c); };
    const channel_ids = (r.channels ?? []).map(note);
    const cells = Object.fromEntries(Object.entries(r.cells ?? {}).map(([sym, cell]) => [sym, { channel_ids: (cell?.channels ?? []).map(note) }]));
    return { model: r.model, vendors: r.vendors ?? [], modalities: r.modalities ?? [], cells, channel_ids, prices };
  });
  return { lanes, scenario: { resolution: String(d.scenario?.resolution ?? ''), duration: num(d.scenario?.duration) }, rows, channels, vendor_icons };
}

export function channelSummary(c, meta, rate, perUnit) {
  const type = meta.types.get(num(c.type));
  const group = String(c.group ?? '');
  const models = Array.isArray(c.effective_models) ? c.effective_models : String(c.models ?? '').split(',').filter(Boolean);
  return {
    ...laneChannel({ id: c.id, name: c.name, type: c.type, status: c.status, priority: c.priority, weight: c.weight,
      lanes: group.split(',').map((g) => g.trim()).filter((g) => meta.lanes.has(g)), vendor: type?.vendor,
      balance: c.balance, balance_updated_time: c.balance_updated_time, balance_supported: type?.balance_supported, balance_unit: type?.balance_unit }, rate),
    group, tag: String(c.tag ?? ''), models_count: models.length, used_cny: quotaCny(c.used_quota, rate, perUnit), created_at: num(c.created_time),
  };
}

export const periodRow = (r, rate, perUnit) => {
  const requests = num(r.RequestCount);
  return { date: String(r.Date ?? ''), key: String(r.Channel ?? ''), requests, amount_cny: quotaCny(r.Quota, rate, perUnit), cost_cny: quotaCny(r.CostQuota, rate, perUnit),
    prompt_tokens: num(r.PromptTokens), completion_tokens: num(r.CompletionTokens),
    // statistics.request_time 是每条日志 request_time（毫秒）的和。
    avg_latency_ms: requests ? Math.round(num(r.RequestTime) / requests) : 0 };
};

export const logEntry = (l, rate, perUnit) => ({
  id: l.id, created_at: num(l.created_at), type: num(l.type), username: String(l.username ?? ''), token_name: String(l.token_name ?? ''),
  model: String(l.model_name ?? ''), channel: l.channel?.id ? { id: l.channel.id, name: String(l.channel.name ?? '') } : null,
  amount_cny: quotaCny(l.quota, rate, perUnit), cost_cny: quotaCny(l.cost_quota, rate, perUnit),
  cost_source: ['real', 'estimated'].includes(l.cost_source) ? l.cost_source : '',
  prompt_tokens: num(l.prompt_tokens), completion_tokens: num(l.completion_tokens), latency_ms: num(l.request_time), is_stream: Boolean(l.is_stream),
  request_id: String(l.request_id ?? ''), upstream_request_id: String(l.upstream_request_id ?? ''), content: String(l.content ?? ''),
});

export function laneChanges(body) {
  if (!plainObject(body) || Object.keys(body).some((k) => k !== 'changes')) throw fail(400, 'invalid_lane_changes');
  const { changes } = body;
  if (!Array.isArray(changes) || !changes.length || changes.length > 200) throw fail(400, 'invalid_lane_changes');
  return changes.map((c, index) => {
    const bad = () => fail(400, 'invalid_lane_changes', { index });
    if (!plainObject(c) || Object.keys(c).some((k) => !['channel_id', 'priority', 'status', 'lanes'].includes(k))) throw bad();
    if (!Number.isSafeInteger(c.channel_id) || c.channel_id < 1) throw bad();
    if (c.priority !== undefined && !Number.isSafeInteger(c.priority)) throw bad();
    if (c.status !== undefined && c.status !== 1 && c.status !== 2) throw bad();
    if (c.lanes !== undefined && (!Array.isArray(c.lanes) || c.lanes.length > 50 || c.lanes.some((s) => typeof s !== 'string' || !s || s.length > 64))) throw bad();
    return { channel_id: c.channel_id, priority: c.priority, status: c.status, lanes: c.lanes };
  });
}

// ── 路由 ──────────────────────────────────────────────────────────────────
export function adminOpsRoutes(app, options) {
  const { db, lanehubQuotaPerUnit: perUnit } = options;
  const limiter = new RateLimiter();
  const writeLimit = (req) => limiter.take('admin-write:' + req.apiUser.id, 60);
  const audit = (req, action, target, details) => db.query('INSERT INTO audit_events(action,target_id,details,actor_user_id) VALUES($1,$2,$3,$4)',
    [action, target, JSON.stringify(details), req.apiUser.id]);
  const hub = () => { if (!options.lanehub) throw fail(503, 'lanehub_unavailable'); return options.lanehub; };
  const rate = () => options.lanehub.usdRate().catch(() => options.lanehubUsdCny);
  // Lanehub.call 的 502 只带 detail 属性；换成 fail() 才会出现在响应体里。网络错误 / 超时同样算 lanehub 失败。
  const call = async (path, init) => {
    try { return await hub().call(path, init); } catch (e) {
      if (e.statusCode && e.code !== 'lanehub_api_failed') throw e;
      throw fail(502, 'lanehub_api_failed', { detail: String(e.detail ?? e.message ?? 'lanehub_error').slice(0, 1000) });
    }
  };

  // 渠道列表 / 探测没有 vendor / balance_supported / balance_unit / 档位集合：从最近一次线路矩阵里按渠道类型取，进程内缓存 10 分钟。
  let meta = null;
  const remember = (d) => {
    const types = new Map(), channelTypes = new Map();
    for (const r of d.rows ?? []) for (const c of [...(r.channels ?? []), ...Object.values(r.cells ?? {}).flatMap((x) => x?.channels ?? [])]) {
      channelTypes.set(c.id, num(c.type));
      if (!types.has(num(c.type))) types.set(num(c.type), { vendor: c.vendor, balance_supported: c.balance_supported, balance_unit: c.balance_unit });
    }
    meta = { at: Date.now(), lanes: new Set((d.lanes ?? []).map((l) => l.symbol)), types, channelTypes };
  };
  const channelMeta = async () => {
    if (!meta || Date.now() - meta.at > META_TTL_MS) remember(await call('/api/lane_matrix'));
    return meta;
  };

  app.get('/api/admin/ops/lane-matrix', async (req) => {
    await requireRole(req, 'viewer', 'operator', 'admin');
    const resolution = strParam(req.query, 'resolution', 20), duration = intParam(req.query, 'duration', 1, 3600);
    const d = await call('/api/lane_matrix?' + qs({ resolution, duration }));
    remember(d);
    return transformLaneMatrix(d, await rate());
  });

  app.put('/api/admin/ops/lane-matrix', async (req) => {
    await requireRole(req, 'operator', 'admin');
    const changes = laneChanges(req.body);
    writeLimit(req);
    let data;
    try {
      data = await call('/api/lane_matrix/batch', { method: 'PUT', body: { changes } });
    } catch (e) {
      await audit(req, 'ops.lane_matrix.save', null, { changes, error: e.code, detail: e.fields?.detail ?? null });
      throw e;
    }
    const state = (s) => ({ group: String(s?.group ?? ''), priority: num(s?.priority), status: num(s?.status) });
    const results = (Array.isArray(data) ? data : []).map((r) => ({ channel_id: r.channel_id, name: String(r.name ?? ''), before: state(r.before), after: state(r.after) }));
    await audit(req, 'ops.lane_matrix.save', null, { changes, results });
    meta = null;
    return { results };
  });

  app.get('/api/admin/ops/channels', async (req) => {
    await requireRole(req, 'viewer', 'operator', 'admin');
    const q = req.query ?? {};
    const page = intParam(q, 'page', 1) ?? 1, size = intParam(q, 'size', 1, 100) ?? 20;
    const d = await call('/api/channel/?' + qs({ page, size, status: intParam(q, 'status', 1, 3), type: intParam(q, 'type', 0),
      group: strParam(q, 'group', 64), name: strParam(q, 'keyword', 100) }));
    const [m, r] = [await channelMeta(), await rate()];
    return { items: (d?.data ?? []).map((c) => channelSummary(c, m, r, perUnit)), page: num(d?.page, page), size: num(d?.size, size), total: num(d?.total_count) };
  });

  app.post('/api/admin/ops/channels/:id/probe', async (req) => {
    await requireRole(req, 'operator', 'admin');
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) throw fail(400, 'invalid_channel_id');
    writeLimit(req);
    const started = Date.now();
    let out;
    try {
      const r = await call(`/api/channel/update_balance/${id}`);
      out = { state: 'ok', balance: r?.balance, message: '' };
    } catch (e) {
      if (e.code !== 'lanehub_api_failed') throw e;
      const message = String(e.fields.detail);
      out = { state: NO_BALANCE_API.test(message) ? 'unsupported' : 'failed', balance: null, message };
    }
    const latency_ms = Date.now() - started;
    // 渠道不在线路矩阵里（没挂任何档位）就不知道类型，按 raw 处理。
    const m = await channelMeta();
    const unit = unitOf(m.types.get(m.channelTypes.get(id))?.balance_unit);
    const raw = out.state === 'ok' ? num(out.balance) : null;
    const probe = { channel_id: id, state: out.state, balance_cny: balanceCny(raw, unit, await rate()), balance_raw: raw, balance_unit: unit,
      latency_ms, message: out.message, checked_at: unix() };
    await audit(req, 'ops.channel.probe', String(id), { state: probe.state, latency_ms, balance_raw: raw, balance_unit: unit, balance_cny: probe.balance_cny, message: probe.message || undefined });
    return probe;
  });

  app.get('/api/admin/ops/dashboard/realtime', async (req) => {
    await requireRole(req, 'viewer', 'operator', 'admin');
    const d = await call('/api/analytics/rpm');
    return { rpm: num(d?.rpm), tpm: num(d?.tpm), cost_per_min_cny: usdToCny(d?.cpm, await rate()) };
  });

  app.get('/api/admin/ops/dashboard/period', async (req) => {
    await requireRole(req, 'viewer', 'operator', 'admin');
    const q = req.query ?? {};
    const start = intParam(q, 'start', 0), end = intParam(q, 'end', 0);
    if (start === undefined || end === undefined || end < start || end - start > 366 * 86400) throw fail(400, 'invalid_date_range');
    const group_by = q.group_by ?? 'model';
    if (!['model', 'channel'].includes(group_by)) throw fail(400, 'invalid_query', { field: 'group_by' });
    const d = await call('/api/analytics/period?' + qs({ start_timestamp: start, end_timestamp: end, group_type: group_by,
      channel_id: intParam(q, 'channel_id', 1), model_name: strParam(q, 'model') }));
    const r = await rate();
    return { rows: (d?.channel_statistics ?? []).map((row) => periodRow(row, r, perUnit)) };
  });

  const logFilters = (q = {}) => ({
    start_timestamp: intParam(q, 'start', 0), end_timestamp: intParam(q, 'end', 0), model_name: strParam(q, 'model'), username: strParam(q, 'username'),
    channel_id: intParam(q, 'channel_id', 1), request_id: strParam(q, 'request_id'), upstream_request_id: strParam(q, 'upstream_request_id'),
    log_type: intParam(q, 'type', 1, 4),
  });

  app.get('/api/admin/ops/logs', async (req) => {
    await requireRole(req, 'viewer', 'operator', 'admin');
    const page = intParam(req.query ?? {}, 'page', 1) ?? 1, size = intParam(req.query ?? {}, 'size', 1, 100) ?? 20;
    const d = await call('/api/log/?' + qs({ page, size, ...logFilters(req.query) }));
    const r = await rate();
    return { items: (d?.data ?? []).map((l) => logEntry(l, r, perUnit)), page: num(d?.page, page), size: num(d?.size, size), total: num(d?.total_count) };
  });

  app.get('/api/admin/ops/logs/stat', async (req) => {
    await requireRole(req, 'viewer', 'operator', 'admin');
    const d = await call('/api/log/stat?' + qs(logFilters(req.query)));
    return { amount_cny: quotaCny(d?.quota, await rate(), perUnit) };
  });
}

// ── 契约登记（schemas 并进 contracts-schema.mjs 的同一张表，export-contracts 照常渲染） ──
const { string, number, boolean, int, lit, array, object, nullable, record, ref, opt } = t;
const laneChannelProps = {
  id: int(1), name: string, type: int(0), status: lit(1, 2, 3), priority: number, weight: number, lanes: array(string), vendor: string,
  balance_cny: nullable(number), balance_checked_at: nullable(int(0)),
  balance_raw: nullable(number), balance_unit: lit('USD', 'CNY', 'raw'), balance_supported: boolean,
};
const logQuery = { start: opt(int(0)), end: opt(int(0)), model: opt(string), username: opt(string), channel_id: opt(int(1)), request_id: opt(string),
  upstream_request_id: opt(string), type: opt(lit(1, 2, 3, 4)) };
const laneState = object({ group: string, priority: number, status: int(0) });
Object.assign(schemas, {
  LaneChange: object({ channel_id: int(1), priority: opt(int()), status: opt(lit(1, 2)), lanes: opt(array(string, 50)) }),
  LaneMatrixSave: object({ changes: array(ref('LaneChange'), 200) }),
  LaneMatrixSaveResult: object({ results: array(object({ channel_id: int(1), name: string, before: laneState, after: laneState })) }),
  LaneMatrixQuery: object({ resolution: opt(string), duration: opt(int(1, 3600)) }),
  LaneChannel: object(laneChannelProps),
  LaneMatrix: object({
    lanes: array(object({ symbol: string, name: string, ratio: number })),
    scenario: object({ resolution: string, duration: number }),
    rows: array(object({
      model: string, vendors: array(string), modalities: array(string), cells: record(object({ channel_ids: array(int(1)) })), channel_ids: array(int(1)),
      prices: record(nullable(object({ unit: string, cny: number, source: lit(...PRICE_SOURCES) }))),
    })),
    channels: record(ref('LaneChannel')),
    vendor_icons: record(string),
  }),
  ChannelSummary: object({ ...laneChannelProps, group: string, tag: string, models_count: int(0), used_cny: number, created_at: int(0) }),
  OpsChannelQuery: object({ page: opt(int(1)), size: opt(int(1, 100)), status: opt(int(1, 3)), type: opt(int(0)), group: opt(string), keyword: opt(string) }),
  OpsChannelPage: object({ items: array(ref('ChannelSummary')), page: int(1), size: int(1), total: int(0) }),
  Probe: object({ channel_id: int(1), state: lit('ok', 'unsupported', 'failed'), balance_cny: nullable(number),
    balance_raw: nullable(number), balance_unit: lit('USD', 'CNY', 'raw'), latency_ms: int(0), message: string, checked_at: int(0) }),
  OpsRealtime: object({ rpm: number, tpm: number, cost_per_min_cny: number }),
  OpsPeriodQuery: object({ start: int(0), end: int(0), group_by: opt(lit('model', 'channel')), channel_id: opt(int(1)), model: opt(string) }),
  OpsPeriod: object({ rows: array(object({ date: string, key: string, requests: int(0), amount_cny: number, cost_cny: number, prompt_tokens: int(0),
    completion_tokens: int(0), avg_latency_ms: int(0) })) }),
  OpsLogQuery: object({ page: opt(int(1)), size: opt(int(1, 100)), ...logQuery }),
  OpsLogStatQuery: object(logQuery),
  LogEntry: object({
    id: int(1), created_at: int(0), type: lit(1, 2, 3, 4), username: string, token_name: string, model: string,
    channel: nullable(object({ id: int(1), name: string })), amount_cny: number, cost_cny: number, cost_source: lit('real', 'estimated', ''),
    prompt_tokens: int(0), completion_tokens: int(0), latency_ms: int(0), is_stream: boolean, request_id: string, upstream_request_id: string, content: string,
  }),
  OpsLogPage: object({ items: array(ref('LogEntry')), page: int(1), size: int(1), total: int(0) }),
  OpsLogStat: object({ amount_cny: number }),
});
// 502 lanehub_api_failed 的 detail（lanehub 原文）。
schemas.ApiError.props.detail ??= opt(string);

export const routeMeta = {
  'GET /api/admin/ops/lane-matrix': { query: 'LaneMatrixQuery', response: 'LaneMatrix' },
  'PUT /api/admin/ops/lane-matrix': { body: 'LaneMatrixSave', response: 'LaneMatrixSaveResult' },
  'GET /api/admin/ops/channels': { query: 'OpsChannelQuery', response: 'OpsChannelPage' },
  'POST /api/admin/ops/channels/:id/probe': { response: 'Probe' },
  'GET /api/admin/ops/dashboard/realtime': { response: 'OpsRealtime' },
  'GET /api/admin/ops/dashboard/period': { query: 'OpsPeriodQuery', response: 'OpsPeriod' },
  'GET /api/admin/ops/logs': { query: 'OpsLogQuery', response: 'OpsLogPage' },
  'GET /api/admin/ops/logs/stat': { query: 'OpsLogStatQuery', response: 'OpsLogStat' },
};
