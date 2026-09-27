// 网关 ↔ 官网共享契约（§10.2 / §11）：响应与请求体形状的唯一描述。
// scripts/export-contracts.mjs 由它生成 contracts/ipzsk-api.d.ts；test/contracts.test.mjs 用 validate()
// 把真实 handler 的响应对上这里，形状改了而这里没改，测试就会失败。没有依赖，也没有 TS 工具链。

const opt = (x) => ({ ...x, optional: true });
export const t = {
  string: { kind: 'string' },
  uuid: { kind: 'string', format: 'uuid' },
  datetime: { kind: 'string', format: 'datetime' },
  decimal: { kind: 'string', format: 'decimal' },
  number: { kind: 'number' },
  boolean: { kind: 'boolean' },
  unknown: { kind: 'unknown' },
  int: (min, max) => ({ kind: 'integer', min, max }),
  lit: (...values) => ({ kind: 'enum', values }),
  array: (of, max) => ({ kind: 'array', of, max }),
  // open: 允许未声明的键（上游参数透传、画布节点等）。
  object: (props, { open = false } = {}) => ({ kind: 'object', props, open }),
  nullable: (of) => ({ kind: 'nullable', of }),
  record: (of) => ({ kind: 'record', of }),
  union: (...of) => ({ kind: 'union', of }),
  ref: (name) => ({ kind: 'ref', name }),
  page: (of) => ({ kind: 'page', of }),
  opt,
};
const { string, uuid, datetime, decimal, number, boolean, unknown, int, lit, array, object, nullable, record, union, ref, page } = t;
const json = record(unknown);

const MediaKind = lit('image', 'video');
const generationFields = {
  reference_asset_ids: opt(array(uuid, 15)),
  image_urls: opt(array(string)),
  batch_id: opt(nullable(uuid)),
  batch_position: opt(nullable(int(0, 11))),
  thread_id: opt(nullable(uuid)),
  anchor_record_id: opt(nullable(uuid)),
  parent_record_id: opt(nullable(uuid)),
  mentions: opt(array(ref('Mention'), 20)),
  prompt_doc: opt(nullable(json)),
  source: opt(lit('studio', 'template', 'canvas')),
  // 数字人（ModelSpec.mode 为 avatar / talking_photo）：形象 avatar_id | photo_asset_id，声音 script(+voice_id) | audio_asset_id，
  // 不收 prompt / reference_asset_ids。背景 background_color | background_asset_id。
  avatar_id: opt(string), photo_asset_id: opt(uuid), script: opt(string), voice_id: opt(string), audio_asset_id: opt(uuid),
  captions: opt(boolean), background_color: opt(string), background_asset_id: opt(uuid),
};
const queueItemBase = {
  item_id: uuid, kind: ref('MediaKind'), model: string, prompt: string, params: opt(ref('GenerationParams')),
  anchor_of: opt(nullable(uuid)), mentions: opt(array(ref('Mention'), 20)), prompt_doc: opt(nullable(json)),
};
// 数字人项（型号 mode 为 avatar / talking_photo）：字段与规则同 GenerationBody（avatarChoice），prompt 必须是 ''。
const avatarItemFields = (asset) => ({
  avatar_id: opt(nullable(string)), photo_asset_id: opt(nullable(asset)), script: opt(nullable(string)), voice_id: opt(nullable(string)),
  audio_asset_id: opt(nullable(asset)), captions: opt(boolean), background_color: opt(nullable(string)), background_asset_id: opt(nullable(asset)),
});
const caseFields = {
  id: string, title: string, prompt: string, category: string, category_zh: nullable(string), tags: array(string), model: nullable(string),
  params: json, template: nullable(ref('CaseTemplate')), author: nullable(string), author_url: nullable(string), source_url: nullable(string),
  source_repo: nullable(string), license_note: nullable(string), image: ref('CaseImage'),
  kind: ref('CaseKind'), video: nullable(ref('CaseVideo')), license_tier: nullable(ref('LicenseTier')),
};
const canvasSummary = {
  id: uuid, title: string, revision: int(1), thumb_id: nullable(uuid), thumb: nullable(ref('MediaAsset')), created_at: datetime, updated_at: datetime,
};
const errorBody = ref('ApiError');
const adminCaseFields = {
  title: string, prompt: string, category: string, category_zh: nullable(string), tags: array(string), model: nullable(string), params: json,
  template: nullable(ref('CaseTemplate')), author: nullable(string), author_url: nullable(string), source_repo: nullable(string), source_url: nullable(string),
  license_note: nullable(string), kind: ref('CaseKind'), license_tier: nullable(ref('LicenseTier')),
};
const optionalCaseFields = Object.fromEntries(Object.entries(adminCaseFields).map(([k, v]) => [k, opt(v)]));
const adminGeneration = {
  id: uuid, user: ref('UserRef'), kind: ref('MediaKind'), model: string, prompt: string, params: ref('GenerationParams'), status: ref('GenerationStatus'),
  failure_code: nullable(string), charged_points: nullable(decimal), source: lit('studio', 'template', 'canvas'), batch_id: nullable(uuid),
  batch_position: nullable(int(0, 11)), created_at: datetime, updated_at: datetime,
};

export const schemas = {
  // ── 通用 ──
  MediaKind,
  // index/field：队列与模板逐项校验；request_id/status：幂等键冲突（409 request_already_received / idempotency_conflict）。
  // fields: 422 case_publish_invalid（全部问题）；reason: 409 generation_not_cancellable 不满足哪条。
  ApiError: object({ code: string, message: string, index: opt(int(0)), field: opt(string), request_id: opt(uuid), status: opt(string),
    fields: opt(array(ref('PublishIssue'))), reason: opt(string) }),
  ApiErrorBody: object({ error: errorBody }),
  // 204 无响应体。
  Empty: { kind: 'void' },
  // /api/me/{images,videos}/generations 与 /v1/*：上游响应原样透传，X-Request-Id 头给出请求 id。
  UpstreamPassthrough: unknown,

  // ── 素材 ──
  ThumbState: lit('none', 'queued', 'running', 'done', 'skipped', 'failed'),
  AssetUrls: object({ orig: string, w480: opt(string), w960: opt(string), poster: opt(string) }),
  AssetKind: lit('image', 'video', 'audio'),
  MediaAsset: object({
    id: uuid, kind: ref('AssetKind'), source: lit('upload', 'generation', 'case', 'poster'), status: lit('pending', 'ready', 'failed', 'deleted'),
    width: nullable(int(0)), height: nullable(int(0)), duration_ms: nullable(int(0)), thumb_state: ref('ThumbState'), created_at: datetime, urls: ref('AssetUrls'),
  }),
  // 生成记录/主体里引用的素材已不可用（被删、未就绪）。
  MissingAsset: object({ id: uuid, status: lit('pending', 'failed', 'deleted'), missing: lit(true) }),
  RecordAsset: union(ref('MediaAsset'), ref('MissingAsset')),
  // 音频：mp3/wav，≤32MB，时长 1s–10min（服务端 ffprobe 实测，写入 duration_ms）。
  UploadRequest: object({ kind: ref('AssetKind'), content_type: lit('image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'audio/mpeg', 'audio/wav', 'audio/x-wav'), bytes: int(1) }),
  UploadTicket: object({ asset_id: uuid, put_url: string, headers: object({ 'Content-Type': string, 'Cache-Control': string }), expires_at: datetime }),
  AssetListQuery: object({ cursor: opt(string), kind: opt(ref('AssetKind')), source: opt(lit('upload', 'generation', 'poster')), folder: opt(uuid) }),

  // ── 型号目录与报价 ──
  ParamSpec: object({
    field: string, type: lit('enum', 'integer', 'boolean', 'string'), values: opt(array(union(string, number))),
    default: nullable(union(string, number)), unit: opt(lit('s')),
  }),
  ModelReferences: object({ maxImages: int(0), firstFrame: opt(boolean), lastFrame: opt(boolean) }),
  ModelSpec: object({
    id: string, name: string, kind: ref('MediaKind'), billing: object({ unit: nullable(string), tiers: opt(array(string)) }),
    params: array(ref('ParamSpec')), references: ref('ModelReferences'), unsupported: record(string),
    mode: opt(ref('ModelMode')), avatar: opt(ref('AvatarCapability')),
  }),
  // HeyGen 产品线。只有 avatar / talking_photo 带 avatar 能力块，也只有这两条能在工作台生成。
  ModelMode: lit('avatar', 'talking_photo', 'cinematic_avatar', 'studio'),
  AvatarCapability: object({
    source: array(lit('library', 'photo')), voice: array(lit('script', 'audio')),
    script: object({ max: int(1), voice_required: boolean }), captions: boolean, background: array(lit('color', 'image')), engine: string,
  }),
  // engines: avatar_iv / avatar_iii…；ModelSpec.avatar.engine 为 iii 的型号只能选 engines 含 avatar_iii 的形象。
  AvatarItem: object({ id: string, name: string, type: lit('avatar', 'talking_photo'), avatar_type: nullable(string), gender: nullable(string),
    preview_image_url: nullable(string), preview_video_url: nullable(string), default_voice_id: nullable(string), engines: array(string) }),
  AvatarList: object({ items: array(ref('AvatarItem')) }),
  VoiceItem: object({ id: string, name: string, language: nullable(string), gender: nullable(string), preview_audio_url: nullable(string),
    support_pause: nullable(boolean), type: nullable(string) }),
  VoiceList: object({ items: array(ref('VoiceItem')) }),
  ModelCatalog: object({ models: array(ref('ModelSpec')) }),
  GenerationParams: record(unknown),
  Mention: object({ type: lit('subject', 'reference'), id: uuid, name: string }),
  // 真实生成请求体：model/prompt + 型号参数（透传）+ studio 字段（网关消费，不发上游）。
  GenerationBody: object({ model: string, prompt: opt(string), ...generationFields }, { open: true }),
  QuoteRequest: object({ items: array(ref('GenerationBody'), 12) }),
  // POST /v1/quote（Bearer）：与 /v1/*/generations 相同的 lanehub 字段名 body，原样转发 lanehub /v1/quote；响应原样透传。
  BearerQuoteBody: object({ model: string }, { open: true }),
  // amount_kind: exact | estimate（按估算成片时长冻结，终态按真实时长多退少补）| cap。
  // estimated_seconds/estimate_basis 只在数字人项出现：录音驱动 = max(60, 录音时长)，脚本 = lanehub 按字数估。
  QuoteOk: object({ points: nullable(decimal), amount_cny: decimal, quote_id: nullable(string), expires_at: datetime,
    amount_kind: opt(string), estimated_seconds: opt(number), estimate_basis: opt(lit('audio_duration', 'script')) }),
  QuoteItemResult: union(ref('QuoteOk'), object({ error: object({ code: string, message: string }) })),
  QuoteResponse: object({ items: array(ref('QuoteItemResult'), 12) }),

  // ── 生成记录与会话 ──
  GenerationStatus: lit('queued', 'running', 'succeeded', 'failed', 'cancelled'),
  GenerationRecord: object({
    id: uuid, kind: ref('MediaKind'), model: string, prompt: string, params: ref('GenerationParams'), status: ref('GenerationStatus'),
    failure_code: nullable(string), charged_points: nullable(decimal), thread_id: nullable(uuid), batch_id: nullable(uuid),
    batch_position: nullable(int(0, 11)), anchor_record_id: nullable(uuid), parent_record_id: nullable(uuid),
    source: lit('studio', 'template', 'canvas'), mentions: array(ref('Mention')), prompt_doc: nullable(json),
    request_id: nullable(uuid), task_id: nullable(uuid), idempotency_key: nullable(string), created_at: datetime, updated_at: datetime,
    references: array(ref('RecordAsset')), results: array(ref('RecordAsset')),
  }),
  GenerationListQuery: object({ thread: opt(uuid), batch_id: opt(uuid), status: opt(lit('active')), idempotency_key: opt(string), cursor: opt(string) }),
  GenerationPatch: object({ thread_id: nullable(uuid) }),
  DeletedCount: object({ deleted: int(0) }),
  Thread: object({ id: uuid, title: string, created_at: datetime, updated_at: datetime }),
  ThreadCreate: object({ id: opt(uuid), title: opt(string) }),
  ThreadPatch: object({ title: string }),

  // ── 发送队列 ──
  // 队列是草稿：数字人项的缺项不拒收，GET/PUT 回包在 issues 里列出（按当前目录现算，写入时忽略）；格式 / 归属 / 类型错仍 400。
  QueueIssue: object({ code: string, field: nullable(string), message: string }),
  QueueItem: object({ ...queueItemBase, reference_asset_ids: opt(array(uuid, 15)), ...avatarItemFields(uuid), missing: opt(lit(true)), issues: opt(array(ref('QueueIssue'))) }),
  Queue: object({ items: array(ref('QueueItem'), 12), revision: int(0) }),
  QueuePut: object({ items: array(ref('QueueItem'), 12), revision: int(0) }),
  QueueConflict: object({ error: errorBody, queue: ref('Queue') }),

  // ── 用户模板 ──
  TemplateReference: union(object({ slot: int(0) }), object({ asset_id: uuid })),
  // 模板要能直接套用：数字人项缺项 400；照片 / 录音 / 背景可用 {slot} 占位（算已给）。
  TemplateAssetSlot: union(uuid, object({ slot: int(0, 14) })),
  TemplateItem: object({ ...queueItemBase, references: opt(array(ref('TemplateReference'), 15)), ...avatarItemFields(ref('TemplateAssetSlot')) }),
  TemplateVariable: object({ name: string, label: string, default: opt(string), required: boolean }),
  UserTemplate: object({
    id: uuid, name: string, cover_id: nullable(uuid), items: array(ref('TemplateItem'), 12), variables: array(ref('TemplateVariable'), 20),
    // cover_id 对应的素材（被删 / 不可用 → MissingAsset；没设封面 → null）。
    cover: nullable(ref('RecordAsset')),
    // items[].references 里 {asset_id} 的素材，按 asset_id 索引；只解析本人的，其余一律 MissingAsset。
    reference_assets: record(ref('RecordAsset')),
    created_at: datetime, updated_at: datetime,
  }),
  // limit 1–50，默认 50；按 updated_at 倒序。
  TemplateListQuery: object({ cursor: opt(string), limit: opt(int(1, 50)) }),
  UserTemplateCreate: object({ name: string, cover_id: opt(nullable(uuid)), items: array(ref('TemplateItem'), 12), variables: opt(array(ref('TemplateVariable'), 20)) }),
  UserTemplatePatch: object({ name: opt(string), cover_id: opt(nullable(uuid)), items: opt(array(ref('TemplateItem'), 12)), variables: opt(array(ref('TemplateVariable'), 20)) }),

  // ── 主体库 ──
  SubjectKind: lit('person', 'character', 'product', 'object', 'scene', 'avatar'),
  // kind=avatar：external_ref（形象库数字人）与 asset_ids（PNG/JPEG 照片）二选一。
  AvatarRef: object({ provider: lit('heygen'), avatar_id: string, name: opt(nullable(string)), preview_image_url: opt(nullable(string)), preview_video_url: opt(nullable(string)) }),
  Subject: object({
    id: uuid, name: string, kind: ref('SubjectKind'), note: nullable(string), external_ref: nullable(ref('AvatarRef')), cover_id: nullable(uuid), cover: nullable(ref('RecordAsset')),
    assets: array(ref('RecordAsset'), 8), created_at: datetime, updated_at: datetime,
  }),
  SubjectCreate: object({ name: string, kind: opt(ref('SubjectKind')), note: opt(nullable(string)), external_ref: opt(nullable(ref('AvatarRef'))), asset_ids: opt(array(uuid, 8)), cover_id: opt(nullable(uuid)) }),
  SubjectPatch: object({ name: opt(string), kind: opt(ref('SubjectKind')), note: opt(nullable(string)), external_ref: opt(nullable(ref('AvatarRef'))), cover_id: opt(nullable(uuid)) }),
  SubjectAssetsPut: object({ asset_ids: array(uuid, 8), cover_id: opt(nullable(uuid)) }),

  // ── 收藏与文件夹 ──
  FavoriteType: lit('asset', 'case'),
  Favorite: object({ target_type: ref('FavoriteType'), target_id: string, created_at: datetime }),
  Folder: object({ id: uuid, name: string, position: number, count: int(0), created_at: datetime }),
  FolderList: object({ items: array(ref('Folder')) }),
  FolderCreate: object({ name: string, position: opt(number) }),
  FolderPatch: object({ name: opt(string), position: opt(number) }),
  FolderItemsPut: object({ asset_ids: array(uuid, 500) }),
  FolderItemsResult: object({ count: int(0) }),

  // ── 画布 ──
  CanvasDocument: object({
    version: int(1), nodes: array(json), edges: array(json), groups: array(json),
    viewport: object({ x: number, y: number, zoom: number }, { open: true }),
  }, { open: true }),
  CanvasProjectSummary: object(canvasSummary),
  CanvasProject: object({ ...canvasSummary, document: ref('CanvasDocument') }),
  CanvasCreate: object({ id: opt(uuid), title: opt(string), document: ref('CanvasDocument') }),
  CanvasPut: object({ title: opt(string), document: ref('CanvasDocument'), revision: int(1) }),
  CanvasThumbPost: object({ asset_id: nullable(uuid) }),
  CanvasConflict: object({ error: errorBody, project: ref('CanvasProject') }),

  // ── 案例库（公开） ──
  CaseImage: object({ width: nullable(int(0)), height: nullable(int(0)), urls: object({ w480: nullable(string), w960: nullable(string), orig: string }) }),
  // image = picture cases; video / avatar (数字人) cases carry an example video. A video case without its own cover shows the video poster as image.
  CaseKind: lit('image', 'video', 'avatar'),
  CaseVideo: object({ width: nullable(int(0)), height: nullable(int(0)), duration_ms: nullable(int(0)), urls: object({ orig: string, poster: nullable(string) }) }),
  // A: the repo author's own prompt under the repo licence; B: curated repost, rights stay with the original author (credit author/source_url).
  LicenseTier: lit('A', 'B'),
  CaseTemplateItem: object({
    key: opt(string), label: string, description: opt(string), count: opt(int(1, 12)),
    params: opt(object({ aspect_ratio: opt(string), resolution: opt(string) })), anchor: opt(boolean), references: opt(array(object({ slot: string }))),
  }),
  CaseTemplate: object({ items: array(ref('CaseTemplateItem'), 12) }),
  InspirationCase: object(caseFields),
  InspirationCaseDetail: object({ ...caseFields, references: array(ref('CaseImage')), similar: array(ref('InspirationCase'), 12) }),
  // cat: comma-separated categories (OR); repeated cat= is accepted too.
  // kind defaults to image, so old clients keep getting picture cases only.
  CaseListQuery: object({ cat: opt(string), q: opt(string), cursor: opt(string), limit: opt(int(1, 60)), kind: opt(ref('CaseKind')) }),
  CaseCategoriesQuery: object({ kind: opt(ref('CaseKind')) }),
  CaseCategory: object({ category: string, category_zh: nullable(string), count: int(0) }),
  CaseCategories: object({ items: array(ref('CaseCategory')) }),

  // ── 桌面端安装包（公开）──
  // 安装包存私有 R2 的 desktop/<version>/，url 是时间切片签名 GET（同案例图，几小时内稳定可缓存）。
  DesktopReleaseFile: object({ platform: lit('mac', 'mac-intel', 'windows'), name: string, bytes: int(1), sha256: string, url: string }),
  DesktopRelease: object({ version: string, released_at: datetime, files: array(ref('DesktopReleaseFile'), 10) }),
  // version 省略取 desktop/latest.json；给了就取 desktop/<version>/manifest.json。
  DesktopReleaseQuery: object({ version: opt(string) }),

  // ── 角色 ──
  Role: lit('admin', 'operator', 'viewer'),
  RolesResponse: object({ roles: array(ref('Role')) }),

  // ── 管理中台（docs/admin-api.md） ──
  UserRef: object({ id: uuid, email: nullable(string), name: opt(nullable(string)) }),
  AdminMe: object({ user: ref('UserRef'), roles: array(ref('Role')), session: object({ created_at: datetime, expires_at: datetime }) }),
  CaseStatus: lit('draft', 'published', 'hidden'),
  AdminCase: object({ ...adminCaseFields, id: string, cover: nullable(ref('MediaAsset')), video: nullable(ref('MediaAsset')), references: array(ref('MediaAsset'), 8), status: ref('CaseStatus'),
    position: number, created_at: datetime, updated_at: datetime }),
  AdminCasePage: object({ items: array(ref('AdminCase')), next_cursor: nullable(string), total: int(0) }),
  AdminCaseQuery: object({ status: opt(ref('CaseStatus')), category: opt(string), kind: opt(ref('CaseKind')), q: opt(string), cursor: opt(string), limit: opt(int(1, 100)) }),
  AdminCaseCreate: object({ ...optionalCaseFields, id: opt(nullable(string)), title: string, prompt: string, category: string, cover_asset_id: uuid }),
  AdminCasePatch: object({ ...optionalCaseFields, status: opt(ref('CaseStatus')), expected_updated_at: opt(nullable(datetime)) }),
  CaseConflict: object({ error: errorBody, case: ref('AdminCase') }),
  CasePositionPatch: object({ after_id: opt(nullable(string)), before_id: opt(nullable(string)) }),
  CasePosition: object({ id: string, position: number }),
  PublishIssue: object({ field: string, code: string }),
  BulkStatusRequest: object({ ids: array(string, 200), status: ref('CaseStatus') }),
  BulkStatusItem: union(
    object({ id: string, ok: lit(true), case: object({ id: string, status: ref('CaseStatus'), updated_at: datetime }) }),
    object({ id: string, ok: lit(false), error: object({ code: string, fields: opt(array(ref('PublishIssue'))) }) }),
  ),
  BulkStatusResult: object({ items: array(ref('BulkStatusItem'), 200) }),
  CaseCoverPut: object({ asset_id: uuid }),
  // The actor's own ready video (uploaded via /api/me/uploads); null removes the case video.
  CaseVideoPut: object({ asset_id: nullable(uuid) }),
  CaseReferencesPut: object({ asset_ids: array(uuid, 8) }),
  AdminUserQuery: object({ q: string, cursor: opt(string), limit: opt(int(1, 100)) }),
  AdminUserSummary: object({ id: uuid, email: nullable(string), name: string, email_verified: boolean, created_at: datetime, roles: array(ref('Role')) }),
  RoleGrant: object({ role: ref('Role'), granted_at: datetime, granted_by: nullable(ref('UserRef')) }),
  AdminUserDetail: object({
    user: object({ id: uuid, email: nullable(string), name: string, email_verified: boolean, created_at: datetime, last_sign_in_at: nullable(datetime) }),
    roles: array(ref('RoleGrant')),
    developer: object({ state: nullable(lit('pending', 'approved', 'rejected', 'disabled')) }),
    // wallet null → wallet_error: billing_unavailable | lanehub_account_missing（从未开通 lanehub 账户，不代为开通）。
    wallet: nullable(object({ available_points: decimal, frozen_points: decimal })),
    wallet_error: nullable(string),
    usage: object({
      last_30d: object({ generations: int(0), succeeded: int(0), failed: int(0), cancelled: int(0), charged_points: decimal }),
      total_generations: int(0), storage: object({ assets: int(0), bytes: int(0) }),
    }),
    recent_generations: array(ref('AdminGeneration'), 10),
  }),
  AdminStaff: object({ items: array(object({ user: ref('UserRef'), roles: array(ref('RoleGrant')) })) }),
  AdminGeneration: object(adminGeneration),
  AdminGenerationDetail: object({
    ...adminGeneration, failure_message: nullable(string), request_id: nullable(uuid), idempotency_key: nullable(string),
    upstream: object({ provider: nullable(string), request_id: nullable(string), task_id: nullable(string), task_status: nullable(string), last_synced_at: nullable(datetime) }),
    billing: object({ mode: lit('lanehub', 'local'), state: lit('pending', 'charged', 'released'), cost_cny: nullable(decimal) }),
    thread_id: nullable(uuid), anchor_record_id: nullable(uuid), parent_record_id: nullable(uuid), source_case_id: nullable(string),
    references: array(ref('RecordAsset')), results: array(ref('RecordAsset')), deleted_at: nullable(datetime),
  }),
  AdminGenerationQuery: object({ user: opt(string), model: opt(string), status: opt(string), kind: opt(ref('MediaKind')), from: opt(string), to: opt(string),
    cursor: opt(string), limit: opt(int(1, 100)) }),
  GenerationCancel: object({ reason: string }),
  AuditEvent: object({ id: int(1), action: string, actor: nullable(ref('UserRef')), legacy_administrator_id: nullable(int(0)), target_id: nullable(string),
    details: nullable(json), created_at: datetime }),
  AuditQuery: object({ actor: opt(string), action: opt(string), target: opt(string), from: opt(string), to: opt(string), cursor: opt(string), limit: opt(int(1, 100)) }),
};

// ── 校验：返回错误路径列表，空数组即通过。对象默认严格（多出的键也算漂移）。 ──
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validate(node, value, path = '$', errors = []) {
  const bad = (msg) => { errors.push(`${path}: ${msg}`); return errors; };
  if (typeof node === 'string') node = parseShape(node);
  switch (node.kind) {
    case 'unknown': return errors;
    case 'void': return value === undefined || value === '' || value === null ? errors : bad('expected empty body');
    case 'ref': {
      if (!schemas[node.name]) return bad('unknown schema ' + node.name);
      return validate(schemas[node.name], value, path, errors);
    }
    case 'string':
      if (typeof value !== 'string') return bad('expected string, got ' + JSON.stringify(value));
      if (node.format === 'uuid' && !UUID.test(value)) return bad('expected uuid');
      if (node.format === 'datetime' && !Number.isFinite(Date.parse(value))) return bad('expected datetime');
      if (node.format === 'decimal' && !/^-?\d+(\.\d+)?$/.test(value)) return bad('expected decimal string');
      return errors;
    case 'number': return typeof value === 'number' && Number.isFinite(value) ? errors : bad('expected number');
    case 'boolean': return typeof value === 'boolean' ? errors : bad('expected boolean');
    case 'integer':
      if (!Number.isInteger(value)) return bad('expected integer, got ' + JSON.stringify(value));
      if ((node.min !== undefined && value < node.min) || (node.max !== undefined && value > node.max)) return bad(`integer ${value} outside ${node.min}..${node.max}`);
      return errors;
    case 'enum': return node.values.includes(value) ? errors : bad(`expected one of ${JSON.stringify(node.values)}, got ${JSON.stringify(value)}`);
    case 'nullable': return value === null ? errors : validate(node.of, value, path, errors);
    case 'array':
      if (!Array.isArray(value)) return bad('expected array');
      if (node.max !== undefined && value.length > node.max) bad(`array longer than ${node.max}`);
      value.forEach((v, i) => validate(node.of, v, `${path}[${i}]`, errors));
      return errors;
    case 'record':
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return bad('expected object');
      for (const [k, v] of Object.entries(value)) validate(node.of, v, `${path}.${k}`, errors);
      return errors;
    case 'page':
      return validate(object({ items: array(node.of), next_cursor: nullable(string) }), value, path, errors);
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return bad('expected object');
      for (const [k, p] of Object.entries(node.props)) {
        if (!(k in value) || value[k] === undefined) { if (!p.optional) bad(`missing ${k}`); continue; }
        validate(p, value[k], `${path}.${k}`, errors);
      }
      if (!node.open) for (const k of Object.keys(value)) if (!(k in node.props)) bad(`unexpected key ${k}`);
      return errors;
    }
    case 'union': {
      const attempts = node.of.map((o) => validate(o, value, path, []));
      return attempts.some((e) => !e.length) ? errors : bad('no union member matched: ' + attempts.map((e) => e[0]).join(' | '));
    }
    default: return bad('bad schema node ' + node.kind);
  }
}

// 路由登记里的响应名：'Thread' / 'Page<Thread>' / 'Empty'。
export function parseShape(name) {
  const m = /^Page<(\w+)>$/.exec(name);
  return m ? page(ref(m[1])) : ref(name);
}

// ── d.ts 生成 ──
const key = (k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k));
export function toTs(node, indent = '') {
  switch (node.kind) {
    case 'unknown': return 'unknown';
    case 'void': return 'void';
    case 'ref': return node.name;
    case 'string': return { uuid: 'Uuid', datetime: 'IsoTime', decimal: 'Decimal' }[node.format] ?? 'string';
    case 'number': case 'integer': return 'number';
    case 'boolean': return 'boolean';
    case 'enum': return node.values.map((v) => JSON.stringify(v)).join(' | ');
    case 'nullable': return `${wrap(node.of, indent)} | null`;
    case 'array': return `${wrap(node.of, indent)}[]`;
    case 'record': return `Record<string, ${toTs(node.of, indent)}>`;
    case 'page': return `Page<${toTs(node.of, indent)}>`;
    case 'union': return node.of.map((o) => wrap(o, indent)).join(' | ');
    case 'object': {
      const inner = indent + '  ';
      const lines = Object.entries(node.props).map(([k, p]) => `${inner}${key(k)}${p.optional ? '?' : ''}: ${toTs(p, inner)}${comment(p)}`);
      if (node.open) lines.push(`${inner}[extra: string]: unknown`);
      return `{\n${lines.join('\n')}\n${indent}}`;
    }
    default: throw new Error('bad schema node ' + node.kind);
  }
}
const wrap = (node, indent) => (['union', 'nullable', 'enum'].includes(node.kind) ? `(${toTs(node, indent)})` : toTs(node, indent));
const comment = (p) => {
  const n = p.kind === 'nullable' ? p.of : p.kind === 'array' ? p.of : p;
  const notes = [];
  if (n.kind === 'integer' && (n.min !== undefined || n.max !== undefined)) notes.push(`integer ${n.min ?? ''}..${n.max ?? ''}`);
  if (p.kind === 'array' && p.max !== undefined) notes.push(`max ${p.max} items`);
  return notes.length ? ` // ${notes.join(', ')}` : '';
};

export function renderDts() {
  const out = [
    '// Generated by ipzsk-api-gateway scripts/export-contracts.mjs from src/contracts-schema.mjs. Do not edit.',
    'export type Uuid = string',
    'export type IsoTime = string',
    '/** Decimal as string, 8 fraction digits (points / CNY). */',
    'export type Decimal = string',
    'export interface Page<T> { items: T[]; next_cursor: string | null }',
    '',
  ];
  for (const name of Object.keys(schemas).sort()) {
    const node = schemas[name];
    out.push(node.kind === 'object' ? `export interface ${name} ${toTs(node)}` : `export type ${name} = ${toTs(node)}`);
  }
  return out.join('\n') + '\n';
}
