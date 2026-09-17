// 案例库（§8.7）：公开读取接口 + 导入逻辑（scripts/import-cases.mjs 调用）。
import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { httpError, RateLimiter } from './security.mjs';
import { publicAsset, OBJECT_CACHE_CONTROL } from './uploads.mjs';
import { probeMedia } from './media-probe.mjs';
import { enqueueThumb } from './media-thumbs.mjs';

export const CASE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_LIMIT = 60, CASE_IMAGE_BYTES = 25 * 1024 * 1024;
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ── 纯函数 ────────────────────────────────────────────────────────────────
export const encodeCaseCursor = (position, id) => Buffer.from(JSON.stringify([position, id])).toString('base64url');

// Published feed, ordered (position,id). q is ILIKE over title/prompt/tags with LIKE metacharacters escaped.
export function caseListQuery({ cat, q, cursor, limit } = {}) {
  const args = [], where = ["c.status='published'"];
  if (cat !== undefined && cat !== '') {
    if (typeof cat !== 'string' || cat.length > 60) throw httpError(400, 'invalid_category');
    args.push(cat); where.push(`c.category=$${args.length}`);
  }
  if (q !== undefined && q !== '') {
    if (typeof q !== 'string' || q.length > 100) throw httpError(400, 'invalid_query');
    args.push('%' + q.trim().replace(/[\\%_]/g, (m) => '\\' + m) + '%');
    where.push(`(c.title ILIKE $${args.length} OR c.prompt ILIKE $${args.length} OR array_to_string(c.tags,' ') ILIKE $${args.length})`);
  }
  if (cursor !== undefined) {
    let position, id;
    try { [position, id] = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8')); } catch { /* below */ }
    if (typeof position !== 'number' || !Number.isFinite(position) || typeof id !== 'string' || !CASE_ID.test(id)) throw httpError(400, 'invalid_cursor');
    args.push(position, id); where.push(`(c.position,c.id)>($${args.length - 1}::double precision,$${args.length})`);
  }
  const n = limit === undefined ? MAX_LIMIT : Number(limit);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) throw httpError(400, 'invalid_limit');
  args.push(n + 1);
  return { limit: n, args, sql: `SELECT c.*,a.object_key,a.variants,a.width,a.height,a.thumb_state,a.source AS asset_source
    FROM inspiration_cases c JOIN media_assets a ON a.id=c.cover_id WHERE ${where.join(' AND ')} ORDER BY c.position,c.id LIMIT $${args.length}` };
}

// Same category scores 100, each shared tag 1; ties by feed order. Returns up to `max`.
export function rankSimilar(base, candidates, max = 12) {
  const tags = new Set(base.tags ?? []);
  return candidates.filter((c) => c.id !== base.id)
    .map((c) => ({ c, score: (c.category === base.category ? 100 : 0) + (c.tags ?? []).filter((t) => tags.has(t)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.c.position - b.c.position || (a.c.id < b.c.id ? -1 : 1))
    .slice(0, max).map((x) => x.c);
}

// Case-library template (docs/admin-api.md §2.1): {items:[{key?,label,description?,count?,params?:{aspect_ratio?,resolution?},anchor?,references?:[{slot}]}]}.
// 1–12 items, total outputs ≤ 12, at most one anchor, keys unique. Unknown keys are rejected so a typo cannot be stored silently.
const ITEM_KEYS = ['key', 'label', 'description', 'count', 'params', 'anchor', 'references'];
export function validCaseTemplate(t) {
  if (t === undefined || t === null) return null;
  const bad = (code = 'invalid_template') => httpError(400, code);
  if (!plain(t) || Object.keys(t).some((k) => k !== 'items') || !Array.isArray(t.items) || !t.items.length || t.items.length > 12) throw bad();
  let outputs = 0, anchors = 0;
  const keys = new Set();
  for (const item of t.items) {
    if (!plain(item) || Object.keys(item).some((k) => !ITEM_KEYS.includes(k))) throw bad();
    if (typeof item.label !== 'string' || !item.label.length || item.label.length > 60) throw bad();
    if (item.key !== undefined && (typeof item.key !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(item.key) || keys.has(item.key))) throw bad();
    keys.add(item.key);
    if (item.description !== undefined && (typeof item.description !== 'string' || item.description.length > 200)) throw bad();
    const count = item.count ?? 1;
    if (!Number.isInteger(count) || count < 1) throw bad();
    if (count > 12) throw bad('template_too_many_outputs');
    outputs += count;
    if (item.params !== undefined && (!plain(item.params)
      || Object.entries(item.params).some(([k, v]) => !['aspect_ratio', 'resolution'].includes(k) || typeof v !== 'string' || !v.length || v.length > 20))) throw bad();
    if (item.anchor !== undefined && typeof item.anchor !== 'boolean') throw bad();
    if (item.anchor) anchors++;
    if (item.references !== undefined && (!Array.isArray(item.references)
      || item.references.some((r) => !plain(r) || Object.keys(r).join() !== 'slot' || typeof r.slot !== 'string' || !r.slot.length || r.slot.length > 30))) throw bad();
  }
  if (outputs > 12) throw bad('template_too_many_outputs');
  if (anchors > 1) throw bad('template_multiple_anchors');
  return t;
}

// Omitted keys become item-{n} (n = 1-based position), skipping any taken by explicit keys.
export function withTemplateKeys(t) {
  if (!t) return t;
  const taken = new Set(t.items.map((i) => i.key).filter(Boolean));
  return { items: t.items.map((item, i) => {
    if (item.key) return item;
    let n = i + 1;
    while (taken.has('item-' + n)) n++;
    taken.add('item-' + n);
    return { key: 'item-' + n, ...item };
  }) };
}

// ── 公开接口 ──────────────────────────────────────────────────────────────
export function caseRoutes(app, { db, imageStorage: storage }) {
  const limiter = new RateLimiter();
  const guard = (req, reply) => {
    limiter.take('cases:' + req.ip, 120);
    if (!storage) throw httpError(503, 'media_storage_unavailable');
    // Signed URLs inside: private cache only, overriding the global no-store.
    reply.header('Cache-Control', 'private, max-age=300');
  };
  const image = (row) => {
    const { urls } = publicAsset({ id: row.cover_id, kind: 'image', object_key: row.object_key, variants: row.variants }, storage);
    return { width: row.width, height: row.height, urls: { w480: urls.w480 ?? null, w960: urls.w960 ?? null, orig: urls.orig } };
  };
  const item = (r) => ({ id: r.id, title: r.title, prompt: r.prompt, category: r.category, category_zh: r.category_zh, tags: r.tags, model: r.model,
    params: r.params, template: r.template, author: r.author, author_url: r.author_url, source_url: r.source_url, source_repo: r.source_repo,
    license_note: r.license_note, image: image(r) });

  app.get('/api/public/cases', async (req, reply) => {
    guard(req, reply);
    const query = caseListQuery(req.query ?? {});
    const rows = (await db.query(query.sql, query.args)).rows;
    const page = rows.slice(0, query.limit), last = page.at(-1);
    return { items: page.map(item), next_cursor: rows.length > query.limit ? encodeCaseCursor(last.position, last.id) : null };
  });
  app.get('/api/public/cases/:id', async (req, reply) => {
    guard(req, reply);
    const id = req.params.id;
    if (!CASE_ID.test(id)) throw httpError(404, 'case_not_found');
    const sql = `SELECT c.*,a.object_key,a.variants,a.width,a.height FROM inspiration_cases c JOIN media_assets a ON a.id=c.cover_id WHERE c.status='published'`;
    const row = (await db.query(`${sql} AND c.id=$1`, [id])).rows[0];
    if (!row) throw httpError(404, 'case_not_found');
    const candidates = (await db.query(`${sql} AND c.id<>$1 AND (c.category=$2 OR c.tags && $3::text[]) ORDER BY c.position LIMIT 300`,
      [id, row.category, row.tags])).rows;
    const refs = (await db.query(`SELECT a.id AS cover_id,a.object_key,a.variants,a.width,a.height FROM inspiration_case_references r
      JOIN media_assets a ON a.id=r.asset_id WHERE r.case_id=$1 AND a.status='ready' ORDER BY r.position`, [id])).rows;
    return { ...item(row), references: refs.map(image), similar: rankSimilar(row, candidates).map(item) };
  });
  app.get('/api/public/case-categories', async (req, reply) => {
    guard(req, reply);
    return { items: (await db.query(`SELECT category,max(category_zh) AS category_zh,count(*)::int AS count FROM inspiration_cases
      WHERE status='published' GROUP BY category ORDER BY min(position)`)).rows };
  });
}

// ── 导入 ──────────────────────────────────────────────────────────────────
export async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const i = next++; await fn(items[i], i); } }));
}

export async function retry(fn, attempts = 3, baseMs = 500) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) { if (i >= attempts || e.permanent) throw e; await new Promise((r) => setTimeout(r, baseMs * 2 ** (i - 1))); }
  }
}

const permanent = (msg) => Object.assign(new Error(msg), { permanent: true });

// Site-relative paths read from imagesDir (website repo root) when given, else from siteOrigin; absolute https URLs fetched.
export async function readCaseImage(source, { siteOrigin, imagesDir, fetcher = fetch }) {
  if (source.startsWith('/') && imagesDir) {
    const root = resolve(imagesDir), path = resolve(root, '.' + decodeURIComponent(source.split('?')[0]));
    if (!path.startsWith(root + sep)) throw permanent('path_outside_images_dir');
    if ((await stat(path)).size > CASE_IMAGE_BYTES) throw permanent('image_too_large');
    return readFile(path);
  }
  const url = source.startsWith('/') ? new URL(source, siteOrigin ?? (() => { throw permanent('site_origin_required'); })()) : new URL(source);
  if (url.protocol !== 'https:') throw permanent('https_required');
  const response = await fetcher(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) { await response.body?.cancel(); const e = new Error('http_' + response.status); e.permanent = response.status === 404; throw e; }
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > CASE_IMAGE_BYTES) { await response.body.cancel?.().catch(() => {}); throw permanent('image_too_large'); }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const text = (v, max) => (typeof v === 'string' && v.length ? v.slice(0, max) : null);

export function caseFromManifest(m, position) {
  if (!plain(m) || typeof m.id !== 'string' || !CASE_ID.test(m.id)) throw new Error('invalid_case_id');
  if (typeof m.title !== 'string' || typeof m.prompt !== 'string' || typeof m.category !== 'string' || !m.category) throw new Error('invalid_case ' + m.id);
  const source = m.image?.orig ?? m.image?.url;
  if (typeof source !== 'string' || !source) throw new Error('invalid_case_image ' + m.id);
  return { id: m.id, title: m.title, prompt: m.prompt, category: m.category, category_zh: text(m.categoryZh ?? m.category_zh, 60),
    tags: Array.isArray(m.tags) ? m.tags.filter((t) => typeof t === 'string') : [], model: text(m.model, 100), params: plain(m.params) ? m.params : {},
    template: validCaseTemplate(m.template), author: text(m.author, 200), author_url: text(m.author_url, 2000), source_url: text(m.source_url, 2000),
    source_repo: text(m.source_repo, 200), license_note: text(m.license_note, 2000), position, source, manifest_size: m.image };
}

const META = ['title', 'prompt', 'category', 'category_zh', 'tags', 'model', 'params', 'template', 'author', 'author_url', 'source_url', 'source_repo', 'license_note', 'position'];

// Idempotent: unchanged image source → no fetch; same sha256 → cover reused; metadata update only when something differs.
// Status is set to published on insert only, so a case an operator hid stays hidden after a re-import.
export async function importCases({ db, storage, manifest, siteOrigin, imagesDir, dryRun = false, fetcher = fetch, concurrency = 4, log = console.log }) {
  if (!Array.isArray(manifest)) throw new Error('manifest_must_be_array');
  const cases = manifest.map((m, i) => caseFromManifest(m, i));
  if (new Set(cases.map((c) => c.id)).size !== cases.length) throw new Error('duplicate_case_id');
  const existing = new Map((await db.query(`SELECT c.id,c.cover_id,c.cover_source,a.sha256 FROM inspiration_cases c JOIN media_assets a ON a.id=c.cover_id
    WHERE c.id=ANY($1::text[])`, [cases.map((c) => c.id)])).rows.map((r) => [r.id, r]));
  const stats = { created: 0, updated: 0, unchanged: 0, image_uploaded: 0, failed: 0 };
  if (dryRun) {
    for (const c of cases) {
      const old = existing.get(c.id);
      const action = !old ? 'create' : old.cover_source !== c.source ? 'refetch-image' : 'check-metadata';
      log(`${action}\t${c.id}\t${c.source}`);
    }
    return stats;
  }
  await pool(cases, concurrency, async (c) => {
    try {
      const old = existing.get(c.id);
      let coverId = old?.cover_id, oldCover = null;
      if (!old || old.cover_source !== c.source) {
        const data = await retry(() => readCaseImage(c.source, { siteOrigin, imagesDir, fetcher }));
        const sha = createHash('sha256').update(data).digest('hex');
        if (!old || old.sha256 !== sha) {
          const info = await probeMedia(data, data.length, async (s, e) => data.subarray(s, e + 1)).catch(() => null);
          if (!info || !EXT[info.contentType]) throw new Error('unsupported_image_type');
          const assetId = randomUUID(), key = `cases/${assetId}/orig.${EXT[info.contentType]}`;
          await retry(() => storage.put(key, data, info.contentType, { cacheControl: OBJECT_CACHE_CONTROL }));
          await db.tx(async (tx) => {
            await tx.query(`INSERT INTO media_assets(id,user_id,kind,source,status,object_key,content_type,bytes,sha256,width,height)
              VALUES($1,NULL,'image','case','ready',$2,$3,$4,$5,$6,$7)`,
            [assetId, key, info.contentType, data.length, sha, info.width ?? c.manifest_size?.width ?? null, info.height ?? c.manifest_size?.height ?? null]);
            await enqueueThumb(tx, assetId);
          });
          oldCover = old?.cover_id ?? null; coverId = assetId; stats.image_uploaded++;
        }
      }
      const values = [c.id, ...META.map((k) => ['params', 'template'].includes(k) ? (c[k] === null ? null : JSON.stringify(c[k])) : c[k]), coverId, c.source];
      const cols = ['id', ...META, 'cover_id', 'cover_source'];
      const r = await db.tx(async (tx) => {
        const row = (await tx.query(`INSERT INTO inspiration_cases(${cols.join(',')},status) VALUES(${cols.map((_, i) => '$' + (i + 1)).join(',')},'published')
          ON CONFLICT (id) DO UPDATE SET ${cols.slice(1).map((k) => `${k}=EXCLUDED.${k}`).join(',')},updated_at=now()
          WHERE (${cols.slice(1).map((k) => 'inspiration_cases.' + k).join(',')}) IS DISTINCT FROM (${cols.slice(1).map((k) => 'EXCLUDED.' + k).join(',')})
          RETURNING (xmax=0) AS inserted`, values)).rows[0];
        // Replaced covers become soft-deleted; cleanup removes them after 30 days once nothing references them.
        if (oldCover) await tx.query(`UPDATE media_assets SET status='deleted',deleted_at=now() WHERE id=$1 AND source='case'`, [oldCover]);
        return row;
      });
      if (!r) stats.unchanged++; else if (r.inserted) stats.created++; else stats.updated++;
    } catch (e) {
      stats.failed++;
      log(`failed\t${c.id}\t${e.message}`);
    }
  });
  return stats;
}

// 契约登记，见 src/studio.mjs routeMeta。
export const routeMeta = {
  'GET /api/public/cases': { query: 'CaseListQuery', response: 'Page<InspirationCase>' },
  'GET /api/public/cases/:id': { response: 'InspirationCaseDetail' },
  'GET /api/public/case-categories': { response: 'CaseCategories' },
};
