// 管理中台第一批（docs/admin-api.md，design §9）：案例库、用户与角色、生成记录、审计日志。
// 旧中台 /admin/api/* 在 admin*.mjs，不动。身份由 gateway.mjs 的 /api/admin/* 钩子识别（仅 cookie 会话 + 非 GET 校验 Origin），
// 每个路由第一行 requireRole；写操作的审计与改动同一事务。本模块不动钱：钱包只读，resync 调后台同一套同步/回填函数。
import { randomBytes, randomUUID } from 'node:crypto';
import { hash, RateLimiter } from './security.mjs';
import { stable } from './validation.mjs';
import { fail, isUuid, plainObject } from './studio.mjs';
import { publicAsset, OBJECT_CACHE_CONTROL } from './uploads.mjs';
import { CASE_ID, validCaseTemplate, withTemplateKeys, encodeCaseCursor } from './cases.mjs';
import { enqueueThumb } from './media-thumbs.mjs';
import { requireRole, grantRole, revokeRole, loadRoles, ROLES } from './roles.mjs';
import { refreshMediaTask } from './media-task-sync.mjs';
import { recordLanehubCharge, syncChargedPoints, lanehubBalance } from './lanehub-charges.mjs';
import { lanehubMode } from './lanehub.mjs';
import { wallet, points } from './billing.mjs';

const STATUSES = ['draft', 'published', 'hidden'];
const GEN_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'];
const TERMINAL = ['completed', 'failed', 'cancelled'];
const SESSION_MS = 12 * 3600_000;
const TEXT = { title: [100, false], prompt: [20000, false], category: [60, false], category_zh: [60, true], model: [100, true], author: [200, true],
  author_url: [2000, true], source_repo: [200, true], source_url: [2000, true], license_note: [2000, true] };
const FIELDS = [...Object.keys(TEXT), 'tags', 'params', 'template'];
// Changing any of these on a published case re-runs the publish check (§2.2).
const PUBLISH_FIELDS = ['title', 'prompt', 'category', 'license_note', 'source_repo', 'source_url', 'author_url', 'template'];

// ── 纯函数 ────────────────────────────────────────────────────────────────
const blank = (v) => typeof v !== 'string' || !v.trim();
const https = (v) => { try { return new URL(v).protocol === 'https:'; } catch { return false; } };
const like = (s) => s.replace(/[\\%_]/g, (m) => '\\' + m);
const encode = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');

// §2.2: every issue, not the first one.
export function publishIssues(c, coverStatus) {
  const out = [], issue = (field, code) => out.push({ field, code });
  if (blank(c.title)) issue('title', 'required'); else if (c.title.length > 100) issue('title', 'too_long');
  if (blank(c.prompt)) issue('prompt', 'required'); else if (c.prompt.length > 20000) issue('prompt', 'too_long');
  if (blank(c.category)) issue('category', 'required'); else if (!/^[a-z0-9-]{1,60}$/.test(c.category)) issue('category', 'invalid');
  if (coverStatus !== 'ready') issue('cover', 'cover_not_ready');
  if (blank(c.license_note)) issue('license_note', 'required');
  if (blank(c.source_repo) && blank(c.source_url)) issue('source_url', 'source_required');
  for (const k of ['source_url', 'author_url']) if (!blank(c[k]) && !https(c[k])) issue(k, 'invalid_url');
  try { validCaseTemplate(c.template); } catch (e) { issue('template', e.code); }
  return out;
}

// Type/length only (drafts may be incomplete). Returns the normalized subset present in body.
export function caseValues(b) {
  const out = {};
  for (const k of FIELDS) {
    if (!(k in b)) continue;
    const v = b[k];
    if (TEXT[k]) {
      const [max, nullable] = TEXT[k];
      if (v === null ? !nullable : typeof v !== 'string' || v.length > max) throw fail(400, `invalid_${k}`); // invalid_title, invalid_prompt, …
      out[k] = v;
    } else if (k === 'tags') {
      if (!Array.isArray(v) || v.length > 50 || v.some((t) => typeof t !== 'string' || !t.length || t.length > 40)) throw fail(400, 'invalid_tags');
      out.tags = [...new Set(v)];
    } else if (k === 'params') {
      if (!plainObject(v) || JSON.stringify(v).length > 10_000) throw fail(400, 'invalid_params');
      out.params = v;
    } else out.template = withTemplateKeys(validCaseTemplate(v));
  }
  return out;
}

export function limitOf(query) {
  if (query.limit === undefined) return 50;
  const n = Number(query.limit);
  if (!Number.isInteger(n) || n < 1 || n > 100) throw fail(400, 'invalid_limit');
  return n;
}

export function decodeCursor(cursor, check) {
  let v;
  try { v = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8')); } catch { /* below */ }
  if (!check(v)) throw fail(400, 'invalid_cursor');
  return v;
}

// from/to: YYYY-MM-DD (Asia/Shanghai day; `to` includes that day) or full ISO. Returns [fromMs|null, toExclusiveMs|null].
export function dateRange(query) {
  const bound = (v, end) => {
    if (v === undefined || v === '') return null;
    let t = NaN;
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) t = Date.parse(v + 'T00:00:00+08:00') + (end ? 86_400_000 : 0);
    else if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) t = Date.parse(v) + (end ? 1 : 0);
    if (!Number.isFinite(t)) throw fail(400, 'invalid_date_range');
    return t;
  };
  const from = bound(query.from, false), to = bound(query.to, true);
  if (from !== null && to !== null && (from >= to || to - from > 366 * 86_400_000)) throw fail(400, 'invalid_date_range');
  return [from, to];
}

// Upstream errors may carry keys or signed URLs; never return them.
export const sanitizeFailure = (s) => s ? String(s).replace(/https?:\/\/\S+/g, '[url]').replace(/\b(sk|ipz|key)[-_][A-Za-z0-9_-]{8,}/gi, '[redacted]').slice(0, 500) : null;

// ── 路由 ──────────────────────────────────────────────────────────────────
export function adminStudioRoutes(app, options) {
  const { db, imageStorage: storage } = options;
  const limiter = new RateLimiter();
  const writeLimit = (req) => limiter.take('admin-write:' + req.apiUser.id, 60); // bulk counts once
  const ready = () => { if (!storage) throw fail(503, 'media_storage_unavailable'); };
  const body = (req) => { if (!plainObject(req.body)) throw fail(400, 'invalid_json'); return req.body; };
  const audit = (c, req, action, target, details) => c.query('INSERT INTO audit_events(action,target_id,details,actor_user_id) VALUES($1,$2,$3,$4)',
    [action, target, JSON.stringify(details), req.apiUser.id]);
  const unknownField = (b, allowed) => { const k = Object.keys(b).find((x) => !allowed.includes(x)); if (k) throw fail(400, 'unknown_field', { field: k }); };
  const recordAsset = (row) => {
    if (row.status !== 'ready') return { id: row.id, status: row.status, missing: true };
    return publicAsset(row, storage);
  };

  // ── 案例 ──
  async function casesOut(q, rows, full) {
    if (!rows.length) return [];
    const covers = new Map((await q.query('SELECT * FROM media_assets WHERE id=ANY($1::uuid[])', [rows.map((r) => r.cover_id)])).rows.map((a) => [a.id, a]));
    const refs = full ? (await q.query(`SELECT r.case_id,a.* FROM inspiration_case_references r JOIN media_assets a ON a.id=r.asset_id
      WHERE r.case_id=ANY($1::text[]) ORDER BY r.position`, [rows.map((r) => r.id)])).rows : [];
    return rows.map((r) => ({ id: r.id, title: r.title, prompt: full ? r.prompt : r.prompt.slice(0, 200), category: r.category, category_zh: r.category_zh,
      tags: r.tags, model: r.model, params: r.params, template: r.template, cover: covers.has(r.cover_id) ? publicAsset(covers.get(r.cover_id), storage) : null,
      references: refs.filter((x) => x.case_id === r.id).map((a) => publicAsset(a, storage)), author: r.author, author_url: r.author_url,
      source_repo: r.source_repo, source_url: r.source_url, license_note: r.license_note, status: r.status, position: r.position,
      created_at: r.created_at, updated_at: r.updated_at }));
  }
  async function oneCase(q, id) {
    const row = CASE_ID.test(id) && (await q.query('SELECT * FROM inspiration_cases WHERE id=$1', [id])).rows[0];
    if (!row) throw fail(404, 'case_not_found');
    return (await casesOut(q, [row], true))[0];
  }
  async function assertPublishable(c, row) {
    const cover = (await c.query('SELECT status FROM media_assets WHERE id=$1', [row.cover_id])).rows[0];
    const issues = publishIssues(row, cover?.status);
    if (issues.length) throw fail(422, 'case_publish_invalid', { fields: issues });
  }
  // §2.4: only the actor's own ready image; the case gets a copy (user_id NULL, source 'case') so user cleanup never touches it.
  async function ownAsset(actorId, assetId) {
    const a = isUuid(assetId) && (await db.query(`SELECT * FROM media_assets WHERE id=$1 AND user_id=$2 AND status<>'deleted'`, [assetId, actorId])).rows[0];
    if (!a) throw fail(404, 'asset_not_found');
    if (a.kind !== 'image') throw fail(400, 'asset_not_image');
    if (a.status !== 'ready') throw fail(409, 'asset_not_ready');
    return a;
  }
  async function copyAsset(src) {
    const id = randomUUID(), key = `cases/${id}/orig.${src.object_key.split('.').pop()}`;
    try { await storage.copy(src.object_key, key, { cacheControl: OBJECT_CACHE_CONTROL, contentType: src.content_type }); }
    catch { throw fail(502, 'storage_copy_failed'); }
    return { id, key, src };
  }
  async function insertCopy(c, { id, key, src }) {
    await c.query(`INSERT INTO media_assets(id,user_id,kind,source,status,object_key,content_type,bytes,sha256,width,height)
      VALUES($1,NULL,'image','case','ready',$2,$3,$4,$5,$6,$7)`, [id, key, src.content_type, src.bytes, src.sha256, src.width, src.height]);
    await enqueueThumb(c, id);
  }
  // A failed transaction must not leave copied objects behind.
  async function withCopies(copies, work) {
    try { return await db.tx(work); }
    catch (e) { await Promise.all(copies.map((x) => storage.delete(x.key).catch(() => {}))); throw e; }
  }
  const caseExists = async (id) => {
    if (!CASE_ID.test(id) || !(await db.query('SELECT 1 FROM inspiration_cases WHERE id=$1', [id])).rowCount) throw fail(404, 'case_not_found');
  };
  const lockCase = async (c, id) => {
    const row = (await c.query('SELECT * FROM inspiration_cases WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!row) throw fail(404, 'case_not_found');
    return row;
  };
  const NOW_MS = "date_trunc('milliseconds',now())"; // updated_at at the precision clients echo back

  app.get('/api/admin/me', async (req) => {
    const roles = await requireRole(req, 'viewer', 'operator', 'admin');
    const u = req.apiUser, created = new Date(u.session_created_at);
    return { user: { id: u.id, email: u.email ?? null, name: u.name ?? null }, roles,
      session: { created_at: created.toISOString(), expires_at: new Date(created.getTime() + SESSION_MS).toISOString() } };
  });

  app.get('/api/admin/cases', async (req) => {
    await requireRole(req, 'viewer', 'operator', 'admin');
    ready();
    const q = req.query ?? {}, args = [], where = [];
    if (q.status !== undefined && q.status !== '') {
      if (!STATUSES.includes(q.status)) throw fail(400, 'invalid_status');
      args.push(q.status); where.push(`status=$${args.length}`);
    }
    if (q.category !== undefined && q.category !== '') {
      if (typeof q.category !== 'string' || q.category.length > 60) throw fail(400, 'invalid_category');
      args.push(q.category); where.push(`category=$${args.length}`);
    }
    if (q.q !== undefined && q.q !== '') {
      if (typeof q.q !== 'string' || q.q.length > 100) throw fail(400, 'invalid_query');
      args.push('%' + like(q.q.trim()) + '%', q.q.trim());
      const p = `$${args.length - 1}`;
      where.push(`(title ILIKE ${p} OR prompt ILIKE ${p} OR array_to_string(tags,' ') ILIKE ${p} OR id=$${args.length})`);
    }
    const limit = limitOf(q);
    const total = (await db.query(`SELECT count(*)::int AS n FROM inspiration_cases ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`, args)).rows[0].n;
    if (q.cursor !== undefined) {
      const [position, id] = decodeCursor(q.cursor, (v) => Array.isArray(v) && Number.isFinite(v[0]) && typeof v[1] === 'string' && CASE_ID.test(v[1]));
      args.push(position, id); where.push(`(position,id)>($${args.length - 1}::double precision,$${args.length})`);
    }
    const rows = (await db.query(`SELECT * FROM inspiration_cases ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY position,id LIMIT ${limit + 1}`, args)).rows;
    const page = rows.slice(0, limit), last = page.at(-1);
    return { items: await casesOut(db, page, false), next_cursor: rows.length > limit ? encodeCaseCursor(last.position, last.id) : null, total };
  });

  app.get('/api/admin/case-categories', async (req) => {
    await requireRole(req, 'viewer', 'operator', 'admin');
    return { items: (await db.query(`SELECT category,max(category_zh) AS category_zh,count(*)::int AS count FROM inspiration_cases
      GROUP BY category ORDER BY min(position)`)).rows };
  });

  app.get('/api/admin/cases/:id', async (req) => {
    await requireRole(req, 'viewer', 'operator', 'admin');
    ready();
    return oneCase(db, req.params.id);
  });

  app.post('/api/admin/cases', async (req, reply) => {
    await requireRole(req, 'operator', 'admin');
    ready();
    writeLimit(req);
    const b = body(req), actor = req.apiUser.id;
    unknownField(b, ['id', 'cover_asset_id', ...FIELDS]);
    if (b.id !== undefined && b.id !== null && (typeof b.id !== 'string' || !CASE_ID.test(b.id))) throw fail(400, 'invalid_case_id');
    const values = caseValues(b);
    if (values.title === undefined) throw fail(400, 'invalid_title');
    if (values.prompt === undefined) throw fail(400, 'invalid_prompt');
    if (values.category === undefined) throw fail(400, 'invalid_category');
    const key = req.headers['idempotency-key'];
    if (key !== undefined && (typeof key !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(key))) throw fail(400, 'invalid_idempotency_key');
    const fingerprint = hash(JSON.stringify(stable(b)));
    const replay = async () => {
      const prior = (await db.query(`SELECT fingerprint,case_id FROM admin_idempotency WHERE user_id=$1 AND key=$2 AND created_at>now()-interval '24 hours'`,
        [actor, key])).rows[0];
      if (!prior) return null;
      if (prior.fingerprint !== fingerprint) throw fail(409, 'idempotency_conflict');
      return reply.code(201).send(await oneCase(db, prior.case_id));
    };
    if (key) { const replayed = await replay(); if (replayed) return replayed; }
    const id = b.id ?? 'c_' + Date.now().toString(36) + randomBytes(4).toString('hex');
    if ((await db.query('SELECT 1 FROM inspiration_cases WHERE id=$1', [id])).rowCount) throw fail(409, 'case_id_taken');
    const copy = await copyAsset(await ownAsset(actor, b.cover_asset_id));
    const lostRace = new Error('idempotency_race');
    try {
      await withCopies([copy], async (c) => {
        if (key) {
          const won = await c.query(`INSERT INTO admin_idempotency(user_id,key,fingerprint,case_id) VALUES($1,$2,$3,$4)
            ON CONFLICT (user_id,key) DO UPDATE SET fingerprint=EXCLUDED.fingerprint,case_id=EXCLUDED.case_id,created_at=now()
            WHERE admin_idempotency.created_at<=now()-interval '24 hours'`, [actor, key, fingerprint, id]);
          if (!won.rowCount) throw lostRace;
        }
        await insertCopy(c, copy);
        const v = { category_zh: null, tags: [], model: null, params: {}, template: null, author: null, author_url: null, source_repo: null,
          source_url: null, license_note: null, ...values };
        await c.query(`INSERT INTO inspiration_cases(id,title,prompt,category,category_zh,tags,model,params,template,author,author_url,source_repo,source_url,
            license_note,cover_id,status,position,created_at,updated_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'draft',(SELECT coalesce(min(position),1)-1 FROM inspiration_cases),${NOW_MS},${NOW_MS})`,
        [id, v.title, v.prompt, v.category, v.category_zh, v.tags, v.model, JSON.stringify(v.params), v.template && JSON.stringify(v.template),
          v.author, v.author_url, v.source_repo, v.source_url, v.license_note, copy.id]).catch((e) => {
          throw e.code === '23505' && e.constraint === 'inspiration_cases_pkey' ? fail(409, 'case_id_taken') : e;
        });
        await audit(c, req, 'case.create', id, { status: 'draft' });
      });
    } catch (e) {
      if (e !== lostRace) throw e;
      return (await replay()) ?? Promise.reject(fail(409, 'idempotency_conflict'));
    }
    return reply.code(201).send(await oneCase(db, id));
  });

  app.patch('/api/admin/cases/:id', async (req, reply) => {
    await requireRole(req, 'operator', 'admin');
    ready();
    writeLimit(req);
    const b = body(req), id = req.params.id;
    unknownField(b, [...FIELDS, 'status', 'expected_updated_at']);
    const values = caseValues(b);
    if (b.status !== undefined && !STATUSES.includes(b.status)) throw fail(400, 'invalid_status');
    const expected = b.expected_updated_at ?? null;
    if (expected !== null && (typeof expected !== 'string' || !Number.isFinite(Date.parse(expected)))) throw fail(400, 'invalid_expected_updated_at');
    if (!CASE_ID.test(id)) throw fail(404, 'case_not_found');
    const conflict = await db.tx(async (c) => {
      const cur = await lockCase(c, id);
      if (expected !== null && cur.updated_at.getTime() !== Date.parse(expected)) return true;
      const to = b.status ?? cur.status, fields = Object.keys(values);
      if (to === 'published' && (cur.status !== 'published' || PUBLISH_FIELDS.some((k) => k in values))) await assertPublishable(c, { ...cur, ...values });
      if (!fields.length && to === cur.status) return false;
      const col = (k) => (['params', 'template'].includes(k) ? (values[k] === null ? null : JSON.stringify(values[k])) : values[k]);
      await c.query(`UPDATE inspiration_cases SET ${[...fields.map((k, i) => `${k}=$${i + 3}`), 'status=$2', `updated_at=${NOW_MS}`].join(',')} WHERE id=$1`,
        [id, to, ...fields.map(col)]);
      if (fields.length) await audit(c, req, 'case.update', id, { fields });
      if (to !== cur.status) await audit(c, req, 'case.status', id, { from: cur.status, to });
      return false;
    });
    if (conflict) return reply.code(409).send({ error: { code: 'case_conflict', message: 'case_conflict' }, case: await oneCase(db, id) });
    return oneCase(db, id);
  });

  app.patch('/api/admin/cases/:id/position', async (req) => {
    await requireRole(req, 'operator', 'admin');
    writeLimit(req);
    const b = body(req), id = req.params.id;
    const neighbor = (v) => {
      if (v === undefined || v === null) return null;
      if (typeof v !== 'string' || !CASE_ID.test(v)) throw fail(400, 'invalid_position');
      return v;
    };
    const after = neighbor(b.after_id), before = neighbor(b.before_id);
    if ((!after && !before) || after === id || before === id || (after && after === before)) throw fail(400, 'invalid_position');
    if (!CASE_ID.test(id)) throw fail(404, 'case_not_found');
    return db.tx(async (c) => {
      const ids = [id, after, before].filter(Boolean);
      const load = async () => new Map((await c.query('SELECT id,position FROM inspiration_cases WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE', [ids]))
        .rows.map((r) => [r.id, r]));
      let rows = await load();
      if (ids.some((x) => !rows.has(x))) throw fail(404, 'case_not_found');
      const from = rows.get(id).position;
      let A = after && rows.get(after), B = before && rows.get(before);
      if (A && B && (A.position > B.position || (A.position === B.position && A.id >= B.id))) throw fail(409, 'case_order_conflict');
      if (A && B && B.position - A.position < 1e-9) {
        await c.query(`UPDATE inspiration_cases c SET position=s.rn FROM (SELECT id,row_number() OVER (ORDER BY position,id)-1 AS rn FROM inspiration_cases) s
          WHERE c.id=s.id`);
        rows = await load(); A = rows.get(after); B = rows.get(before);
      }
      const to = A && B ? (A.position + B.position) / 2 : A ? A.position + 1 : B.position - 1;
      await c.query('UPDATE inspiration_cases SET position=$2 WHERE id=$1', [id, to]);
      await audit(c, req, 'case.reorder', id, { from, to });
      return { id, position: to };
    });
  });

  app.post('/api/admin/cases/bulk-status', async (req) => {
    await requireRole(req, 'operator', 'admin');
    writeLimit(req);
    const b = body(req);
    if (!Array.isArray(b.ids) || !b.ids.length || b.ids.length > 200 || b.ids.some((x) => typeof x !== 'string')) throw fail(400, 'invalid_ids');
    if (!STATUSES.includes(b.status)) throw fail(400, 'invalid_status');
    const items = [];
    for (const id of b.ids) {
      try {
        items.push({ id, ok: true, case: await db.tx(async (c) => {
          const cur = CASE_ID.test(id) ? await lockCase(c, id) : null;
          if (!cur) throw fail(404, 'case_not_found');
          if (cur.status === b.status) return { id, status: cur.status, updated_at: cur.updated_at };
          if (b.status === 'published') await assertPublishable(c, cur);
          const row = (await c.query(`UPDATE inspiration_cases SET status=$2,updated_at=${NOW_MS} WHERE id=$1 RETURNING updated_at`, [id, b.status])).rows[0];
          await audit(c, req, 'case.status', id, { from: cur.status, to: b.status, bulk: true });
          return { id, status: b.status, updated_at: row.updated_at };
        }) });
      } catch (e) {
        if (!(e.statusCode < 500)) throw e;
        items.push({ id, ok: false, error: { code: e.code, ...(e.fields ?? {}) } });
      }
    }
    return { items };
  });

  app.put('/api/admin/cases/:id/cover', async (req) => {
    await requireRole(req, 'operator', 'admin');
    ready();
    writeLimit(req);
    const b = body(req), id = req.params.id;
    await caseExists(id);
    const src = await ownAsset(req.apiUser.id, b.asset_id);
    const copy = await copyAsset(src);
    await withCopies([copy], async (c) => {
      const cur = await lockCase(c, id);
      await insertCopy(c, copy);
      await c.query(`UPDATE inspiration_cases SET cover_id=$2,updated_at=${NOW_MS} WHERE id=$1`, [id, copy.id]);
      await c.query(`UPDATE media_assets SET status='deleted',deleted_at=now() WHERE id=$1 AND source='case'
        AND NOT EXISTS (SELECT 1 FROM inspiration_case_references r WHERE r.asset_id=$1)`, [cur.cover_id]);
      await audit(c, req, 'case.cover', id, { from_asset_id: cur.cover_id, to_asset_id: copy.id, source_asset_id: src.id });
    });
    return oneCase(db, id);
  });

  app.put('/api/admin/cases/:id/references', async (req) => {
    await requireRole(req, 'operator', 'admin');
    ready();
    writeLimit(req);
    const b = body(req), id = req.params.id, ids = b.asset_ids;
    if (!Array.isArray(ids) || ids.length > 8 || ids.some((x) => !isUuid(x))) throw fail(400, 'invalid_asset_ids');
    if (new Set(ids).size !== ids.length) throw fail(400, 'duplicate_asset');
    await caseExists(id);
    const current = new Set((await db.query(`SELECT r.asset_id FROM inspiration_case_references r JOIN media_assets a ON a.id=r.asset_id
      WHERE r.case_id=$1 AND a.source='case'`, [id])).rows.map((r) => r.asset_id));
    const sources = [];
    for (const x of ids) sources.push(current.has(x) ? null : await ownAsset(req.apiUser.id, x)); // validate all before copying any
    const copies = [];
    try { for (const s of sources) copies.push(s && await copyAsset(s)); }
    catch (e) { await Promise.all(copies.filter(Boolean).map((x) => storage.delete(x.key).catch(() => {}))); throw e; }
    const final = ids.map((x, i) => copies[i]?.id ?? x);
    await withCopies(copies.filter(Boolean), async (c) => {
      await lockCase(c, id);
      for (const copy of copies.filter(Boolean)) await insertCopy(c, copy);
      const old = (await c.query('DELETE FROM inspiration_case_references WHERE case_id=$1 RETURNING asset_id', [id])).rows.map((r) => r.asset_id);
      for (const [position, assetId] of final.entries()) {
        await c.query('INSERT INTO inspiration_case_references(case_id,asset_id,position) VALUES($1,$2,$3)', [id, assetId, position]);
      }
      await c.query(`UPDATE media_assets SET status='deleted',deleted_at=now() WHERE id=ANY($1::uuid[]) AND source='case'
        AND NOT EXISTS (SELECT 1 FROM inspiration_cases c WHERE c.cover_id=media_assets.id)`, [old.filter((x) => !final.includes(x))]);
      await c.query(`UPDATE inspiration_cases SET updated_at=${NOW_MS} WHERE id=$1`, [id]);
      await audit(c, req, 'case.references', id, { count: final.length });
    });
    return oneCase(db, id);
  });

  app.delete('/api/admin/cases/:id', async (req, reply) => {
    await requireRole(req, 'operator', 'admin');
    writeLimit(req);
    const id = req.params.id;
    if (!CASE_ID.test(id)) throw fail(404, 'case_not_found');
    await db.tx(async (c) => {
      const cur = await lockCase(c, id);
      // "已发布或隐藏过": a draft that was ever published/hidden (audit history) is not deletable either.
      const wasPublic = cur.status !== 'draft' || (await c.query(`SELECT 1 FROM audit_events WHERE action='case.status' AND target_id=$1
        AND (details->>'from' IN ('published','hidden') OR details->>'to' IN ('published','hidden')) LIMIT 1`, [id])).rowCount;
      if (wasPublic) throw fail(409, 'case_not_draft');
      const refs = (await c.query('DELETE FROM inspiration_case_references WHERE case_id=$1 RETURNING asset_id', [id])).rows.map((r) => r.asset_id);
      await c.query('DELETE FROM inspiration_cases WHERE id=$1', [id]);
      await c.query(`UPDATE media_assets SET status='deleted',deleted_at=now() WHERE id=ANY($1::uuid[]) AND source='case'`, [[cur.cover_id, ...refs]]);
      await audit(c, req, 'case.delete', id, { title: cur.title });
    });
    return reply.code(204).send();
  });

  // ── 生成记录 ──
  const GEN_SELECT = `SELECT g.*,g.created_at::text AS cursor_at,u.email AS user_email,r.idempotency_key,r.upstream_id,r.cost_cny::text AS cost_text,
      r.error_code,(g.created_at<now()-interval '2 hours') AS cancel_age_ok,
      coalesce(g.charged_points,CASE WHEN b.state IN ('settled','released') THEN b.charged_cny*100 END)::numeric(20,8)::text AS points,
      b.state AS billing_state,t.upstream_task_id,t.status AS task_status,t.updated_at AS task_synced_at,t.result->'error'->>'message' AS task_error,a.provider_type
    FROM generation_records g JOIN users u ON u.id=g.user_id
    LEFT JOIN requests r ON r.id=g.request_id LEFT JOIN request_billing b ON b.request_id=g.request_id
    LEFT JOIN media_tasks t ON t.id=g.task_id LEFT JOIN upstream_keys k ON k.id=r.key_id LEFT JOIN upstream_accounts a ON a.id=k.account_id`;
  const genSummary = (g, full = false) => ({ id: g.id, user: { id: g.user_id, email: g.user_email }, kind: g.kind, model: g.model,
    prompt: full ? g.prompt : g.prompt.slice(0, 200), params: g.params, status: g.status, failure_code: g.failure_code, charged_points: g.points,
    source: g.source, batch_id: g.batch_id, batch_position: g.batch_position, created_at: g.created_at, updated_at: g.updated_at });
  async function oneGeneration(id) {
    const g = isUuid(id) && (await db.query(`${GEN_SELECT} WHERE g.id=$1`, [id])).rows[0];
    if (!g) throw fail(404, 'generation_not_found');
    return g;
  }
  async function generationDetail(g) {
    const refs = (await db.query(`SELECT a.* FROM generation_references gr JOIN media_assets a ON a.id=gr.asset_id WHERE gr.record_id=$1 ORDER BY gr.position`, [g.id])).rows;
    const results = g.task_id ? (await db.query(`SELECT * FROM media_assets WHERE task_id=$1 AND status='ready' ORDER BY result_index`, [g.task_id])).rows : [];
    return { ...genSummary(g, true), failure_message: sanitizeFailure(g.task_error ?? g.error_code), request_id: g.request_id, idempotency_key: g.idempotency_key ?? null,
      upstream: { provider: g.provider_type ?? null, request_id: g.upstream_id ?? null, task_id: g.upstream_task_id ?? null, task_status: g.task_status ?? null,
        last_synced_at: g.task_synced_at ?? null },
      billing: { mode: g.provider_type === 'lanehub' ? 'lanehub' : 'local', state: { settled: 'charged', released: 'released' }[g.billing_state] ?? 'pending',
        cost_cny: g.cost_text ?? null },
      thread_id: g.thread_id, anchor_record_id: g.anchor_record_id, parent_record_id: g.parent_record_id, source_case_id: g.source_case_id,
      references: refs.map(recordAsset), results: results.map(recordAsset), deleted_at: g.deleted_at };
  }
  // Same functions as the background loops: task refresh, then lanehub charge backfill. Returns 'upstream_unavailable' on upstream failure.
  async function resync(g) {
    let outcome = null;
    if (g.task_id && !TERMINAL.includes(g.task_status)) outcome = await refreshMediaTask(db, options.upstream, g.task_id);
    if (!g.request_id) return outcome;
    const row = (await db.query(`SELECT r.id,r.user_id,r.model,r.upstream_id,r.completed_at,t.status AS task_status,b.request_id AS billed,a.provider_type
      FROM requests r LEFT JOIN upstream_keys k ON k.id=r.key_id LEFT JOIN upstream_accounts a ON a.id=k.account_id
      LEFT JOIN media_tasks t ON t.id=r.id LEFT JOIN request_billing b ON b.request_id=r.id WHERE r.id=$1`, [g.request_id])).rows[0];
    if (row?.provider_type !== 'lanehub') return outcome;
    if (row.billed) await syncChargedPoints(db, row.id);
    else if (options.lanehub && options.lanehubUsdCny > 0 && row.upstream_id && row.completed_at && (!row.task_status || TERMINAL.includes(row.task_status))) {
      try { await recordLanehubCharge(db, options.lanehub, row, { usdCnyRate: options.lanehubUsdCny, quotaPerUnit: options.lanehubQuotaPerUnit }); }
      catch { outcome = 'upstream_unavailable'; }
    }
    return outcome;
  }

  app.get('/api/admin/generations', async (req) => {
    await requireRole(req, 'viewer', 'operator', 'admin');
    const q = req.query ?? {}, args = [], where = [];
    const genFilter = (sql, value) => { args.push(value); where.push(sql.replace('?', '$' + args.length)); };
    if (q.user !== undefined && q.user !== '') {
      if (typeof q.user !== 'string' || q.user.length > 320) throw fail(400, 'invalid_user');
      if (isUuid(q.user)) genFilter('g.user_id=?', q.user);
      else genFilter('g.user_id IN (SELECT id FROM users WHERE lower(email)=?)', q.user.trim().toLowerCase());
    }
    if (q.model !== undefined && q.model !== '') {
      if (typeof q.model !== 'string' || q.model.length > 100) throw fail(400, 'invalid_model');
      genFilter('g.model=?', q.model);
    }
    if (q.status !== undefined && q.status !== '') {
      const list = String(q.status).split(',');
      if (list.some((s) => !GEN_STATUSES.includes(s))) throw fail(400, 'invalid_status');
      genFilter('g.status=ANY(?::text[])', list);
    }
    if (q.kind !== undefined && q.kind !== '') {
      if (!['image', 'video'].includes(q.kind)) throw fail(400, 'invalid_kind');
      genFilter('g.kind=?', q.kind);
    }
    const [from, to] = dateRange(q);
    if (from !== null) genFilter('g.created_at>=?::timestamptz', new Date(from).toISOString());
    if (to !== null) genFilter('g.created_at<?::timestamptz', new Date(to).toISOString());
    const limit = limitOf(q);
    if (q.cursor !== undefined) {
      const [at, id] = decodeCursor(q.cursor, (v) => Array.isArray(v) && typeof v[0] === 'string' && Number.isFinite(Date.parse(v[0])) && isUuid(v[1]));
      args.push(at, id); where.push(`(g.created_at,g.id)<($${args.length - 1}::timestamptz,$${args.length}::uuid)`);
    }
    const rows = (await db.query(`${GEN_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY g.created_at DESC,g.id DESC LIMIT ${limit + 1}`, args)).rows;
    const last = rows.length > limit ? rows[limit - 1] : null;
    return { items: rows.slice(0, limit).map((g) => genSummary(g)), next_cursor: last ? encode([last.cursor_at, last.id]) : null };
  });

  app.get('/api/admin/generations/:id', async (req) => {
    await requireRole(req, 'viewer', 'operator', 'admin');
    return generationDetail(await oneGeneration(req.params.id));
  });

  app.post('/api/admin/generations/:id/resync', async (req) => {
    await requireRole(req, 'operator', 'admin');
    writeLimit(req);
    const g = await oneGeneration(req.params.id);
    if (!(['queued', 'running'].includes(g.status) || (g.status === 'succeeded' && g.charged_points === null))) throw fail(409, 'generation_not_syncable');
    if (await resync(g) === 'upstream_unavailable') throw fail(502, 'upstream_unavailable');
    const after = await oneGeneration(g.id);
    await audit(db, req, 'generation.resync', g.id, { status_before: g.status, status_after: after.status });
    return generationDetail(after);
  });

  app.post('/api/admin/generations/:id/cancel', async (req) => {
    await requireRole(req, 'operator', 'admin');
    writeLimit(req);
    const b = body(req), reason = typeof b.reason === 'string' ? b.reason.trim() : '';
    if (!reason || reason.length > 200) throw fail(400, 'invalid_reason');
    const g = await oneGeneration(req.params.id);
    if (!['queued', 'running'].includes(g.status)) throw fail(409, 'generation_not_cancellable', { reason: 'status_not_active' });
    if (!g.cancel_age_ok) throw fail(409, 'generation_not_cancellable', { reason: 'younger_than_2h' });
    // An unreachable upstream does not block: a lost upstream task is exactly what this clears.
    await resync(g);
    await db.tx(async (c) => {
      const cur = (await c.query('SELECT status FROM generation_records WHERE id=$1 FOR UPDATE', [g.id])).rows[0];
      if (!['queued', 'running'].includes(cur.status)) throw fail(409, 'generation_not_cancellable', { reason: 'resolved_by_resync' });
      // Local record only: no refund, no wallet_entries, charged_points untouched (lanehub refunds on its side).
      await c.query(`UPDATE generation_records SET status='cancelled',failure_code='admin_cancelled',updated_at=now() WHERE id=$1`, [g.id]);
      await audit(c, req, 'generation.cancel', g.id, { from_status: cur.status, reason });
    });
    return generationDetail(await oneGeneration(g.id));
  });

  // ── 用户与角色 ──
  const grantsOf = async (userIds) => (await db.query(`SELECT r.user_id,r.role,r.granted_at,g.id AS by_id,g.email AS by_email FROM user_roles r
    LEFT JOIN users g ON g.id=r.granted_by WHERE r.user_id=ANY($1::uuid[]) ORDER BY r.role`, [userIds])).rows;
  const grantOut = (r) => ({ role: r.role, granted_at: r.granted_at, granted_by: r.by_id ? { id: r.by_id, email: r.by_email } : null });
  const userFor = async (id) => {
    const u = isUuid(id) && (await db.query('SELECT id,email,name,email_verified,created_at,auth_user_id FROM users WHERE id=$1', [id])).rows[0];
    if (!u) throw fail(404, 'user_not_found');
    return u;
  };

  app.get('/api/admin/users', async (req) => {
    await requireRole(req, 'viewer', 'operator', 'admin');
    const q = req.query ?? {}, term = typeof q.q === 'string' ? q.q.trim() : '';
    if (!term || term.length > 100) throw fail(400, 'invalid_query');
    const limit = limitOf(q), rank = '(lower(u.email)=$1)::int', args = [term.toLowerCase()], where = [];
    if (isUuid(term)) { args.push(term); where.push('u.id=$2'); }
    else { args.push('%' + like(term) + '%'); where.push('(u.email ILIKE $2 OR u.name ILIKE $2)'); }
    if (q.cursor !== undefined) {
      const [r, at, id] = decodeCursor(q.cursor, (v) => Array.isArray(v) && [0, 1].includes(v[0]) && typeof v[1] === 'string' && Number.isFinite(Date.parse(v[1])) && isUuid(v[2]));
      args.push(r, at, id);
      where.push(`(${rank},u.created_at,u.id)<($${args.length - 2}::int,$${args.length - 1}::timestamptz,$${args.length}::uuid)`);
    }
    const rows = (await db.query(`SELECT u.id,u.email,u.name,u.email_verified,u.created_at,u.created_at::text AS cursor_at,${rank} AS rank,
        array(SELECT role FROM user_roles r WHERE r.user_id=u.id ORDER BY role) AS roles
      FROM users u WHERE ${where.join(' AND ')} ORDER BY rank DESC,u.created_at DESC,u.id DESC LIMIT ${limit + 1}`, args)).rows;
    const last = rows.length > limit ? rows[limit - 1] : null;
    return { items: rows.slice(0, limit).map(({ id, email, name, email_verified, created_at, roles }) => ({ id, email, name, email_verified, created_at, roles })),
      next_cursor: last ? encode([last.rank, last.cursor_at, last.id]) : null };
  });

  app.get('/api/admin/users/:id', async (req) => {
    await requireRole(req, 'viewer', 'operator', 'admin');
    const u = await userFor(req.params.id);
    // auth_sessions exists only where better-auth has migrated; its absence means "unknown", not an error.
    const lastSignIn = u.auth_user_id ? await db.query('SELECT max("createdAt") AS at FROM auth_sessions WHERE "userId"=$1', [u.auth_user_id])
      .then((r) => r.rows[0]?.at ?? null, () => null) : null;
    const developer = (await db.query('SELECT state FROM developer_profiles WHERE user_id=$1', [u.id])).rows[0]?.state ?? null;
    let walletOut = null, walletError = null;
    try {
      if (options.lanehub && await lanehubMode(db)) {
        // Read only: never provision here (provisioning grants the signup credit).
        const account = (await db.query('SELECT lanehub_user_id FROM lanehub_accounts WHERE user_id=$1', [u.id])).rows[0];
        if (!account) walletError = 'lanehub_account_missing';
        else {
          const b = await lanehubBalance(options.lanehub, account, { usdCnyRate: options.lanehubUsdCny, quotaPerUnit: options.lanehubQuotaPerUnit });
          walletOut = { available_points: points(b.available_cny), frozen_points: points(b.frozen_cny) };
        }
      } else {
        const b = await wallet(db, u.id);
        walletOut = { available_points: points(b.available_cny), frozen_points: points(b.frozen_cny) };
      }
    } catch { walletOut = null; walletError = 'billing_unavailable'; }
    const usage = (await db.query(`SELECT count(*) FILTER (WHERE created_at>now()-interval '30 days')::int AS generations,
        count(*) FILTER (WHERE created_at>now()-interval '30 days' AND status='succeeded')::int AS succeeded,
        count(*) FILTER (WHERE created_at>now()-interval '30 days' AND status='failed')::int AS failed,
        count(*) FILTER (WHERE created_at>now()-interval '30 days' AND status='cancelled')::int AS cancelled,
        coalesce(sum(charged_points) FILTER (WHERE created_at>now()-interval '30 days'),0)::numeric(20,8)::text AS charged_points,
        count(*)::int AS total FROM generation_records WHERE user_id=$1`, [u.id])).rows[0];
    const storageUse = (await db.query(`SELECT count(*)::int AS assets,coalesce(sum(bytes),0)::text AS bytes FROM media_assets
      WHERE user_id=$1 AND status IN ('pending','ready')`, [u.id])).rows[0];
    const recent = (await db.query(`${GEN_SELECT} WHERE g.user_id=$1 ORDER BY g.created_at DESC,g.id DESC LIMIT 10`, [u.id])).rows;
    return {
      user: { id: u.id, email: u.email, name: u.name, email_verified: u.email_verified, created_at: u.created_at, last_sign_in_at: lastSignIn },
      roles: (await grantsOf([u.id])).map(grantOut), developer: { state: developer }, wallet: walletOut, wallet_error: walletError,
      usage: { last_30d: { generations: usage.generations, succeeded: usage.succeeded, failed: usage.failed, cancelled: usage.cancelled, charged_points: usage.charged_points },
        total_generations: usage.total, storage: { assets: storageUse.assets, bytes: Number(storageUse.bytes) } },
      recent_generations: recent.map((g) => genSummary(g)),
    };
  });

  app.get('/api/admin/roles', async (req) => {
    await requireRole(req, 'viewer', 'operator', 'admin');
    const users = (await db.query(`SELECT DISTINCT u.id,u.email,u.name FROM user_roles r JOIN users u ON u.id=r.user_id ORDER BY u.email NULLS LAST,u.id`)).rows;
    const grants = users.length ? await grantsOf(users.map((u) => u.id)) : [];
    return { items: users.map((u) => ({ user: u, roles: grants.filter((g) => g.user_id === u.id).map(grantOut) })) };
  });

  app.put('/api/admin/users/:id/roles/:role', async (req) => {
    await requireRole(req, 'admin');
    writeLimit(req);
    if (!ROLES.includes(req.params.role)) throw fail(400, 'invalid_role');
    const u = await userFor(req.params.id);
    if (!u.email_verified) throw fail(409, 'email_not_verified');
    await grantRole(db, u.id, req.params.role, req.apiUser.id);
    return { roles: await loadRoles(db, u.id) };
  });

  app.delete('/api/admin/users/:id/roles/:role', async (req) => {
    await requireRole(req, 'admin');
    writeLimit(req);
    if (!ROLES.includes(req.params.role)) throw fail(400, 'invalid_role');
    const u = await userFor(req.params.id);
    await revokeRole(db, u.id, req.params.role, req.apiUser.id);
    return { roles: await loadRoles(db, u.id) };
  });

  // ── 审计 ──
  app.get('/api/admin/audit', async (req) => {
    await requireRole(req, 'viewer', 'operator', 'admin');
    const q = req.query ?? {}, args = [], where = [];
    const auditFilter = (sql, value) => { args.push(value); where.push(sql.replace('?', '$' + args.length)); };
    if (q.actor !== undefined && q.actor !== '') {
      if (typeof q.actor !== 'string' || q.actor.length > 320) throw fail(400, 'invalid_actor');
      if (isUuid(q.actor)) auditFilter('e.actor_user_id=?', q.actor);
      else auditFilter('e.actor_user_id IN (SELECT id FROM users WHERE lower(email)=?)', q.actor.trim().toLowerCase());
    }
    if (q.action !== undefined && q.action !== '') {
      if (typeof q.action !== 'string' || q.action.length > 100 || !/^[a-z0-9_-]+(\.[a-z0-9_-]+)*(\.\*)?$/.test(q.action)) throw fail(400, 'invalid_action');
      if (q.action.endsWith('.*')) auditFilter(`e.action LIKE ? ESCAPE '\\'`, like(q.action.slice(0, -1)) + '%');
      else auditFilter('e.action=?', q.action);
    }
    if (q.target !== undefined && q.target !== '') {
      if (typeof q.target !== 'string' || q.target.length > 200) throw fail(400, 'invalid_target');
      auditFilter('e.target_id=?', q.target);
    }
    const [from, to] = dateRange(q);
    if (from !== null) auditFilter('e.created_at>=?::timestamptz', new Date(from).toISOString());
    if (to !== null) auditFilter('e.created_at<?::timestamptz', new Date(to).toISOString());
    const limit = limitOf(q);
    if (q.cursor !== undefined) auditFilter('e.id<?', decodeCursor(q.cursor, (v) => Number.isSafeInteger(v) && v > 0));
    const rows = (await db.query(`SELECT e.id,e.action,e.actor_user_id,u.email AS actor_email,e.administrator_id,e.target_id,e.details,e.created_at
      FROM audit_events e LEFT JOIN users u ON u.id=e.actor_user_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY e.id DESC LIMIT ${limit + 1}`, args)).rows;
    const last = rows.length > limit ? rows[limit - 1] : null;
    return { items: rows.slice(0, limit).map((e) => ({ id: Number(e.id), action: e.action, actor: e.actor_user_id ? { id: e.actor_user_id, email: e.actor_email } : null,
      legacy_administrator_id: e.administrator_id, target_id: e.target_id, details: e.details, created_at: e.created_at })),
    next_cursor: last ? encode(Number(last.id)) : null };
  });
}

// 契约登记，见 src/studio.mjs routeMeta。
export const routeMeta = {
  'GET /api/admin/me': { response: 'AdminMe' },
  'GET /api/admin/cases': { query: 'AdminCaseQuery', response: 'AdminCasePage' },
  'GET /api/admin/case-categories': { response: 'CaseCategories' },
  'GET /api/admin/cases/:id': { response: 'AdminCase' },
  'POST /api/admin/cases': { body: 'AdminCaseCreate', response: 'AdminCase', headers: ['Idempotency-Key'] },
  'PATCH /api/admin/cases/:id': { body: 'AdminCasePatch', response: 'AdminCase', conflict: 'CaseConflict' },
  'PATCH /api/admin/cases/:id/position': { body: 'CasePositionPatch', response: 'CasePosition' },
  'POST /api/admin/cases/bulk-status': { body: 'BulkStatusRequest', response: 'BulkStatusResult' },
  'PUT /api/admin/cases/:id/cover': { body: 'CaseCoverPut', response: 'AdminCase' },
  'PUT /api/admin/cases/:id/references': { body: 'CaseReferencesPut', response: 'AdminCase' },
  'DELETE /api/admin/cases/:id': { response: 'Empty' },
  'GET /api/admin/users': { query: 'AdminUserQuery', response: 'Page<AdminUserSummary>' },
  'GET /api/admin/users/:id': { response: 'AdminUserDetail' },
  'GET /api/admin/roles': { response: 'AdminStaff' },
  'PUT /api/admin/users/:id/roles/:role': { response: 'RolesResponse' },
  'DELETE /api/admin/users/:id/roles/:role': { response: 'RolesResponse' },
  'GET /api/admin/generations': { query: 'AdminGenerationQuery', response: 'Page<AdminGeneration>' },
  'GET /api/admin/generations/:id': { response: 'AdminGenerationDetail' },
  'POST /api/admin/generations/:id/resync': { response: 'AdminGenerationDetail' },
  'POST /api/admin/generations/:id/cancel': { body: 'GenerationCancel', response: 'AdminGenerationDetail' },
  'GET /api/admin/audit': { query: 'AuditQuery', response: 'Page<AuditEvent>' },
};
