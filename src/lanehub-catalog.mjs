import { httpError } from './security.mjs';
import { referencesFor } from './media-references.mjs';
import { avatarCatalogSpec, AVATAR_MODES } from './avatar-contract.mjs';

// 型号目录的真源在 lanehub（GET /api/catalog）：哪些型号能卖、什么价、收什么参数。
// 这边不再维护 model-catalog.json 那份手抄快照——快照是第二份真源，上线当天就靠它把
// 5 个型号的清单发给了桌面端，而 lanehub 那边实际能卖 113 个。
//
// 失败语义照 lanehub 抓取脚本那套：拉不到 → 保留上一份（记时间），从没拉到过 → 明确 503，
// 不回落到任何快照——回落的那份一定是旧的，而「旧目录」和「没目录」在客户端上长得一样。
export class LanehubCatalog {
  // onRefresh(data)：每次**成功**刷新后触发、不等待（server.mjs 用它预热数字人形象列表）；它失败只记日志。
  constructor(lanehub, { refreshMs = 600_000, log = () => {}, onRefresh = null } = {}) {
    this.lanehub = lanehub;
    this.onRefresh = onRefresh;
    this.refreshMs = refreshMs;
    this.log = log;
    this.data = null;
    this.fetchedAt = null;
    this.lastError = null;
  }

  async refresh() {
    try {
      const data = await this.lanehub.call('/api/catalog');
      if (!data || !Array.isArray(data.models)) throw new Error('catalog_shape');
      this.data = data;
      this.fetchedAt = new Date();
      this.lastError = null;
      Promise.resolve().then(() => this.onRefresh?.(data)).catch((e) => this.log({ err: e?.message }, 'lanehub_catalog_on_refresh_failed'));
    } catch (e) {
      this.lastError = e;
      this.log({ err: e?.message, stale_since: this.fetchedAt }, 'lanehub_catalog_refresh_failed');
    }
    return this.data;
  }

  start() {
    const timer = setInterval(() => this.refresh(), this.refreshMs);
    timer.unref();
    return this.refresh();
  }

  /** 桌面端 bootstrap 用的形状。`available` 是这边 upstream_keys 里挂着的型号集合。 */
  // lanehub 模式下目录本身就是真源：哪些能卖由 lanehub 的渠道白名单决定，不再用这边
  // upstream_keys.models（旧多上游模式的密钥型号表）二次过滤——lanehub 密钥行的 models 是空的。
  desktop() {
    if (!this.data) throw httpError(503, 'catalog_unavailable');
    return desktopFromCatalog(this.data, new Set(this.data.models.map((m) => m.id)));
  }

  /** 网页型号目录（ModelSpec[]）。按目录对象缓存：每次刷新换一份 data，缓存随之失效。 */
  media() {
    if (!this.data) throw httpError(503, 'catalog_unavailable');
    if (this.mediaFor !== this.data) { this.mediaCache = mediaModelsFromCatalog(this.data); this.mediaFor = this.data; }
    return this.mediaCache;
  }
}

// 网页输入框可调的参数（canonical 字段 + flare 的 n）。参考图类字段不在这里，走 references。
const STUDIO_PARAMS = { aspect_ratio: 'enum', resolution: 'enum', quality: 'enum', mode: 'enum', n: 'integer', duration: 'integer',
  seed: 'integer', scale_by: 'integer', sound: 'boolean', enhance_prompt: 'boolean', negative_prompt: 'string' };

// HeyGen 是唯一带 mode 的产品线：lanehub 的 controller/catalog.go 只在
// providers/heygen 的入参契约（params.go）登记过这个型号时才给 mode + inputs。
// 没 mode 的 heygen- 型号意味着 lanehub 压根没有它的提交路径（docs/heygen-onboarding.md：
// 「这两条线没有提交路径，卖出去必失败」），网关也不知道它收什么参数——目录里既没有
// duration、也没有 avatar 块，工作台只能摆出一个点了必失败的型号。所以不下发。
// 今天命中的是 heygen-video-agent / heygen-video-translate；heygen-avatar(-iii) 有
// mode=avatar、heygen-image/studio/cinematic-avatar 也各有 mode，都照常下发。
const composableModel = (m) => !/^heygen-/.test(m.id) || Boolean(avatarCatalogSpec(m).mode);

// lanehub 目录 → 网页 ModelSpec。取值原样保留（flare 的 "1K" 不转小写）。默认值以 lanehub 的
// field.default 为准（它就是计价用的兜底值，自己另猜一个会让报价和实扣对不上，例如 flare 的
// quality 猜成 low、z-image 的 enhance_prompt 猜成 true 直接翻倍）；目录没给才回落到
// 比例优先 1:1、其余取第一个取值。
export function mediaModelsFromCatalog(catalog) {
  return catalog.models.filter((m) => ['image', 'video'].includes(m.kind) && typeof m.id === 'string' && composableModel(m)).map((m) => {
    const fields = m.params?.fields ?? [];
    const supported = (name) => fields.some((f) => f.field === name && !f.unsupported);
    const params = [];
    for (const f of fields) {
      const kind = STUDIO_PARAMS[f.field];
      if (!kind || f.unsupported || params.some((p) => p.field === f.field)) continue;
      const values = f.values?.length ? [...f.values] : undefined;
      params.push({ field: f.field, type: values ? 'enum' : kind, ...(values ? { values } : {}),
        // 布尔开关回落到 false：取第一个取值会默认开着，而开关往往是加价项（z-image 的扩写是 2 倍）。
        default: f.default != null ? String(f.default)
          : !values ? null
          : values.length === 2 && values.includes('true') && values.includes('false') ? 'false'
          : f.field === 'aspect_ratio' && values.includes('1:1') ? '1:1' : values[0],
        ...(f.field === 'duration' ? { unit: 's' } : {}) });
    }
    const references = referencesFor(m.id);
    // 白名单已录入却不收 image_urls，或明确标了不支持：这个型号实际收不了参考图。
    if (fields.some((f) => f.field === 'image_urls' && f.unsupported) || (m.params?.registered && !supported('image_urls'))) references.maxImages = 0;
    // lanehub 现在按型号下发 image_urls.counts（上游实际接受的张数）：它比这边的手抄表新，优先用。
    else {
      const counts = fields.find((f) => f.field === 'image_urls')?.counts;
      if (counts?.length) references.maxImages = Math.max(...counts.map(Number).filter(Number.isFinite));
    }
    if (supported('first_frame_image')) references.firstFrame = true;
    if (supported('last_frame_image')) references.lastFrame = true;
    const unsupported = {};
    for (const f of fields) if (f.unsupported) unsupported[f.field] = f.unsupported;
    const tiers = m.billing?.tiers ? Object.keys(m.billing.tiers) : undefined;
    return { id: m.id, name: m.name || m.id, kind: m.kind, billing: { unit: m.billing?.unit ?? null, ...(tiers ? { tiers } : {}) },
      params, references, unsupported, ...avatarCatalogSpec(m) }; // HeyGen: mode (+ avatar block for avatar / talking_photo)
  });
}

// lanehub 目录 → 桌面端 bootstrap 的形状。纯函数，测试直接喂 fixture。
export function desktopFromCatalog(catalog, available, { defaultChatModel = process.env.DESKTOP_DEFAULT_MODEL } = {}) {
  // 已发布客户端对每个 id 做 /^[a-zA-Z0-9._-]{1,128}$/ 校验，一个不合规（如 Wan-AI/Wan2.6-T2V 带 /）
  // 就整个登录失败。这种型号这里直接不下发，而不是让客户端炸。
  const entries = catalog.models
    .filter((m) => available.has(m.id) && /^[a-zA-Z0-9._-]{1,128}$/.test(m.id) && typeof (m.name || m.id) === 'string')
    // 数字人（avatar / talking_photo）不下发：它们不收 prompt（发了就是 avatar_prompt_not_supported），要的是 avatar_id /
    // 照片 / script，而已发布的桌面端只会拿 params 里的 canonical 字段拼 prompt 请求。客户端支持这类输入前不进桌面目录。
    .filter((m) => m.kind === 'chat' || !AVATAR_MODES.includes(avatarCatalogSpec(m).mode))
    .map((m) => {
      const params = paramsOf(m);
      const base = { id: m.id, name: m.name || m.id, kind: m.kind, params, unsupported: unsupportedOf(m) };
      // 客户端把 contextWindow / maxTokens 当硬校验（不是 ≥1 的整数就整个登录失败）。
      // lanehub 的 model_info 多数还没有上下文长度，缺省时给保守值：这是客户端的**预算**，
      // 不是对上游上限的声明（老快照就是这么做的），有真值再覆盖。
      if (m.kind === 'chat') return { ...base, contextWindow: m.context_length > 0 ? m.context_length : chatDefaults(m.id).contextWindow,
        maxTokens: m.max_tokens > 0 ? m.max_tokens : chatDefaults(m.id).maxTokens };
      const tiers = m.billing?.tiers ? Object.keys(m.billing.tiers) : undefined;
      const media = { ...base, billing_unit: m.billing?.unit, tiers, require_tier: Boolean(tiers?.length) && !m.billing?.usd, default_tier: tiers ? 'default' : null };
      // 已发布的桌面端在图片型号上校验 sizes/default_size（ipzsk-auth.ts），缺了会把已装客户端
      // 锁在登录页外。这里从 aspect_ratio 字段派生，与旧 deprecatedSizes 同义。
      if (m.kind === 'image') {
        // 已发布的客户端把 sizes / default_size 当硬校验（缺了整个登录失败，2026-09-14 实录）。
        // 契约里有枚举就用契约的；没有枚举（上游按字符串收比例）就下发通用比例表——
        // 这是客户端的选项，不是上游上限的声明。
        const ratio = params.find((p) => p.field === 'aspect_ratio');
        const sizes = ratio?.values?.length ? ratio.values : DEFAULT_ASPECT_RATIOS;
        Object.assign(media, { sizes, default_size: ratio?.default ?? (sizes.includes('1:1') ? '1:1' : sizes[0]) });
      }
      return media;
    });
  const byKind = (kind) => entries.filter((m) => m.kind === kind);
  const models = byKind('chat');
  // 默认聊天模型由配置指定（DESKTOP_DEFAULT_MODEL）；不在清单里或没配就取第一个，不让客户端拿到空默认。
  const preferred = models.find((m) => m.id === defaultChatModel);
  return {
    canonical_params: CANONICAL_PARAMS,
    default_model: (preferred ?? models[0])?.id,
    models,
    image_models: byKind('image'),
    video_models: byKind('video'),
  };
}

// 客户端只认 canonical 字段名；这份说明与 lanehub providers/canonical 的字段表一致。
const CANONICAL_PARAMS = {
  prompt: '提示词，所有生成型号通用',
  aspect_ratio: '画面比例，如 1:1 / 16:9',
  resolution: '清晰度档位，取值按型号而定（图片 1k/2k/4k，视频 480p/720p）',
  duration: '视频时长（秒）',
  enhance_prompt: '是否让上游自动扩写提示词',
};

const DEFAULT_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '3:2', '2:3', '4:3', '3:4', '5:4', '4:5', '2:1', '1:2', '3:1', '1:3', '21:9', '9:21'];
const chatDefaults = (id) => (/^gpt-(3\.5|4(?:-|$))/.test(id) ? { contextWindow: 4096, maxTokens: 1024 } : { contextWindow: 32768, maxTokens: 4096 });

function paramsOf(m) {
  const out = m.kind === 'chat' ? [] : [{ field: 'prompt', type: 'string', required: true }];
  for (const f of m.params?.fields ?? []) {
    if (!Object.hasOwn(CANONICAL_PARAMS, f.field) || f.unsupported || out.some((p) => p.field === f.field)) continue;
    out.push({ field: f.field, type: f.values?.length ? 'enum' : 'string', values: f.values, required: false });
  }
  return out;
}

function unsupportedOf(m) {
  const out = {};
  for (const f of m.params?.fields ?? []) if (f.unsupported) out[f.field] = f.unsupported;
  return out;
}
