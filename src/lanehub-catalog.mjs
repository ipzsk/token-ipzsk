import { httpError } from './security.mjs';

// 型号目录的真源在 lanehub（GET /api/catalog）：哪些型号能卖、什么价、收什么参数。
// 这边不再维护 model-catalog.json 那份手抄快照——快照是第二份真源，上线当天就靠它把
// 5 个型号的清单发给了桌面端，而 lanehub 那边实际能卖 113 个。
//
// 失败语义照 lanehub 抓取脚本那套：拉不到 → 保留上一份（记时间），从没拉到过 → 明确 503，
// 不回落到任何快照——回落的那份一定是旧的，而「旧目录」和「没目录」在客户端上长得一样。
export class LanehubCatalog {
  constructor(lanehub, { refreshMs = 600_000, log = () => {} } = {}) {
    this.lanehub = lanehub;
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
  desktop(available) {
    if (!this.data) throw httpError(503, 'catalog_unavailable');
    return desktopFromCatalog(this.data, available);
  }
}

// lanehub 目录 → 桌面端 bootstrap 的形状。纯函数，测试直接喂 fixture。
export function desktopFromCatalog(catalog, available) {
  const entries = catalog.models
    .filter((m) => available.has(m.id))
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
        const ratio = params.find((p) => p.field === 'aspect_ratio');
        if (ratio?.values?.length) Object.assign(media, { sizes: ratio.values, default_size: ratio.default ?? ratio.values[0] });
      }
      return media;
    });
  const byKind = (kind) => entries.filter((m) => m.kind === kind);
  const models = byKind('chat');
  return {
    canonical_params: CANONICAL_PARAMS,
    default_model: models[0]?.id,
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
