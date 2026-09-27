// Import researched video / 数字人 inspiration cases (cases.video.json / cases.avatar.json: {items:[...]}) as DRAFT cases.
// Maps each item onto the importCases manifest shape (kind, license_tier, video url, optional cover) and reuses its
// download → R2 cases/{asset_id}/orig.{ext} → media_assets pipeline. Items without any media (licence tier A, prompt only)
// are skipped: a case needs a cover or a video to show; generate one on the platform first.
// Usage:
//   node scripts/import-video-cases.mjs <cases.video.json> [<cases.avatar.json> ...]            # dry run: validate + print, touches nothing
//   R2_CONFIG_FILE=... node scripts/import-video-cases.mjs <files...> --apply  # writes drafts (DB from DATABASE_URL, or PGHOST in the gateway container)
//   --placeholder-cover <https url>  prompt-only cases import behind this cover instead of being skipped
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { CASE_ID, caseFromManifest } from '../src/cases.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { apply: { type: 'boolean', default: false }, 'placeholder-cover': { type: 'string' } } });
if (!positionals.length) {
  console.error('usage: node scripts/import-video-cases.mjs <cases.json>... [--apply]  (--apply needs R2_CONFIG_FILE and a database: DATABASE_URL or PGHOST)');
  process.exit(2);
}

const https = (v) => { try { return new URL(v).protocol === 'https:'; } catch { return false; } };
const PUBLISHABLE_CATEGORY = /^[a-z0-9-]{1,60}$/; // admin publish check (§2.2)

// Research item → importCases manifest entry, or { skip: reason }. Pure; tolerates missing fields.
function toManifest(x) {
  if (!x || typeof x !== 'object') return { skip: 'not_an_object' };
  const id = typeof x.id === 'string' ? x.id.replace(/[^A-Za-z0-9_-]/g, '-') : ''; // zl-1.1 → zl-1-1
  if (!CASE_ID.test(id)) return { skip: 'invalid_id' };
  const kind = x.kind === 'avatar' ? 'avatar' : x.kind === 'video' ? 'video' : null;
  if (!kind) return { id, skip: 'invalid_kind' };
  const media = x.media ?? {}, video = media.video_url ?? null, cover = media.cover_url ?? null;
  // Prompt-only (A 级) cases can still land as drafts behind a shared placeholder cover, swapped before publishing.
  if (!video && !cover && !values['placeholder-cover']) return { id, skip: 'no_media' };
  if (video && !https(video)) return { id, skip: 'video_not_https' };
  if (cover && !https(cover)) return { id, skip: 'cover_not_https' };
  const prompt = typeof x.prompt === 'string' && x.prompt.trim() ? x.prompt : x.prompt_zh;
  if (typeof x.title !== 'string' || !x.title.trim() || typeof prompt !== 'string' || !prompt.trim()) return { id, skip: 'missing_title_or_prompt' };
  if (typeof x.category !== 'string' || !PUBLISHABLE_CATEGORY.test(x.category)) return { id, skip: 'invalid_category' };
  const tier = x.license?.tier ?? x.license_tier ?? null;
  if (tier !== 'A' && tier !== 'B') return { id, skip: 'missing_license_tier' };
  if (typeof x.license_note !== 'string' || !x.license_note.trim()) return { id, skip: 'missing_license_note' };
  const m = {
    id, kind, license_tier: tier, title: x.title.slice(0, 100), prompt, category: x.category, category_zh: x.category_zh ?? null,
    tags: Array.isArray(x.tags) ? x.tags.filter((t) => typeof t === 'string' && t.length && t.length <= 40).slice(0, 50) : [],
    model: typeof x.model === 'string' ? x.model : null, params: x.params && typeof x.params === 'object' && !Array.isArray(x.params) ? x.params : {},
    author: x.author_name ?? x.author ?? null, author_url: https(x.author_url) ? x.author_url : null,
    source_url: https(x.source_url) ? x.source_url : null, source_repo: x.source_repo ?? null, license_note: x.license_note,
    ...(video && { video_url: video }), ...((cover || !video) && { image: { url: cover ?? values['placeholder-cover'] } }),
  };
  if (!m.source_url && !m.source_repo) return { id, skip: 'missing_source' };
  try { caseFromManifest(m, 0); } catch (e) { return { id, skip: e.message.split(' ')[0] }; }
  return { id, manifest: m };
}

const items = [];
for (const file of positionals) {
  const data = JSON.parse(await readFile(file, 'utf8'));
  items.push(...(Array.isArray(data) ? data : data.items ?? []));
}
const mapped = items.map(toManifest);
const seen = new Set(), manifest = [], skipped = {};
for (const r of mapped) {
  if (r.manifest && seen.has(r.id)) r.skip = 'duplicate_id';
  if (r.skip) { (skipped[r.skip] ??= []).push(r.id ?? '?'); continue; }
  seen.add(r.id); manifest.push(r.manifest);
}
const count = (f) => manifest.reduce((o, m) => ({ ...o, [f(m)]: (o[f(m)] ?? 0) + 1 }), {});

if (!values.apply) {
  for (const m of manifest) console.log(`plan\t${m.kind}\t${m.license_tier}\t${m.id}\t${m.video_url ? 'video' : '-'}\t${m.image ? 'cover' : 'poster'}\t${m.title}`);
  console.log(JSON.stringify({ dry_run: true, items: items.length, importable: manifest.length, by_kind: count((m) => m.kind),
    by_tier: count((m) => m.license_tier), without_own_cover: manifest.filter((m) => !m.image).length,
    skipped: Object.fromEntries(Object.entries(skipped).map(([k, ids]) => [k, { count: ids.length, ids: ids.slice(0, 5) }])) }, null, 2));
} else {
  if (!process.env.R2_CONFIG_FILE) { console.error('--apply needs R2_CONFIG_FILE'); process.exit(2); }
  const { databaseFromEnv } = await import('../src/database.mjs');
  const { loadR2Storage } = await import('../src/r2-storage.mjs');
  const { importCases } = await import('../src/cases.mjs');
  const db = await databaseFromEnv(); // DATABASE_URL locally, PGHOST + PGPASSWORD_FILE in the container
  try {
    if (!(await db.query('SELECT 1 FROM schema_version WHERE version=26')).rowCount) throw new Error('schema_v26_missing: deploy the gateway first');
    const storage = await loadR2Storage(process.env.R2_CONFIG_FILE);
    // Drafts: an operator reviews and publishes in the admin console (poster must be ready for cases without a cover).
    const stats = await importCases({ db, storage, manifest, status: 'draft', concurrency: 2 });
    console.log(JSON.stringify(stats));
    if (stats.failed) process.exitCode = 1;
  } finally { await db.close(); }
}
