import { randomUUID } from 'node:crypto';
import { httpError, RateLimiter } from './security.mjs';
import { uuid } from './validation.mjs';
import { probeMedia } from './media-probe.mjs';
import { probeAudioDurationMs } from './media-thumbs.mjs';
import { AUDIO_MAX_BYTES, AUDIO_MIN_MS, AUDIO_MAX_MS } from './avatar-contract.mjs';

// Audio (数字人录音驱动): mp3 / wav only. HeyGen's audio input documents MP3/WAV; m4a is not accepted here until verified.
const TYPES = { 'image/png': ['image', 'png'], 'image/jpeg': ['image', 'jpg'], 'image/webp': ['image', 'webp'], 'video/mp4': ['video', 'mp4'],
  'audio/mpeg': ['audio', 'mp3'], 'audio/wav': ['audio', 'wav'], 'audio/x-wav': ['audio', 'wav'] };
const MAX_BYTES = { image: 20 * 1024 * 1024, video: 200 * 1024 * 1024, audio: AUDIO_MAX_BYTES };
const sniffedType = (type) => (type === 'audio/x-wav' ? 'audio/wav' : type);
const QUOTA_BYTES = 2 * 1024 ** 3, QUOTA_COUNT = 2000;
export const OBJECT_CACHE_CONTROL = 'private, max-age=21600';
const PAGE = 50;

export function publicAsset(row, storage) {
  const urls = { orig: storage.presignGetSliced(row.object_key) };
  const prefix = row.object_key.slice(0, row.object_key.lastIndexOf('/') + 1);
  for (const size of ['w480', 'w960', 'poster']) {
    const key = row.variants?.[size];
    if (typeof key === 'string' && key.startsWith(prefix)) urls[size] = storage.presignGetSliced(key);
  }
  return { id: row.id, kind: row.kind, source: row.source, status: row.status, width: row.width, height: row.height,
    duration_ms: row.duration_ms, thumb_state: row.thumb_state, created_at: row.created_at, urls };
}

export function uploadRoutes(app, { db, imageStorage: storage, spawn, ffprobe }) {
  const limiter = new RateLimiter();
  const ready = () => { if (!storage) throw httpError(503, 'media_storage_unavailable'); };

  app.post('/api/me/uploads', async req => {
    ready();
    const { kind, content_type: type, bytes } = req.body ?? {};
    if (!TYPES[type] || TYPES[type][0] !== kind) throw httpError(400, 'unsupported_media_type');
    if (!Number.isSafeInteger(bytes) || bytes < 1) throw httpError(400, 'invalid_bytes');
    if (bytes > MAX_BYTES[kind]) throw httpError(413, 'file_too_large');
    limiter.take('upload:' + req.apiUser.id, 20);
    const id = randomUUID(), key = `u/${req.apiUser.id}/${id}/orig.${TYPES[type][1]}`;
    await db.tx(async c => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['media-quota:' + req.apiUser.id]);
      const used = (await c.query(`SELECT count(*)::int AS count,coalesce(sum(bytes),0)::bigint AS bytes FROM media_assets
        WHERE user_id=$1 AND status IN ('pending','ready')`, [req.apiUser.id])).rows[0];
      if (used.count + 1 > QUOTA_COUNT || Number(used.bytes) + bytes > QUOTA_BYTES) throw httpError(403, 'storage_quota_exceeded');
      await c.query(`INSERT INTO media_assets(id,user_id,kind,source,object_key,content_type,bytes) VALUES($1,$2,$3,'upload',$4,$5,$6)`,
        [id, req.apiUser.id, kind, key, type, bytes]);
    });
    const expiresSec = 600;
    return { asset_id: id, put_url: storage.presignPut(key, { contentType: type, contentLength: bytes, cacheControl: OBJECT_CACHE_CONTROL, expiresSec }),
      headers: { 'Content-Type': type, 'Cache-Control': OBJECT_CACHE_CONTROL }, expires_at: new Date(Date.now() + expiresSec * 1000).toISOString() };
  });

  app.post('/api/me/uploads/:id/complete', async req => {
    ready();
    const row = (await db.query('SELECT * FROM media_assets WHERE id=$1 AND user_id=$2 AND source=$3', [uuid(req.params.id), req.apiUser.id, 'upload'])).rows[0];
    if (!row || row.status === 'deleted') throw httpError(404, 'asset_not_found'); // 404 for others' ids too
    if (row.status === 'ready') return publicAsset(row, storage);
    if (row.status !== 'pending') throw httpError(409, 'upload_not_pending');
    const head = await storage.head(row.object_key);
    if (!head) throw httpError(409, 'upload_not_found'); // still pending: the client may retry the PUT
    const fail = async code => {
      await db.query("UPDATE media_assets SET status='failed' WHERE id=$1 AND status='pending'", [row.id]);
      await storage.delete(row.object_key).catch(() => {}); // cleanup loop removes failed rows later
      throw httpError(422, code);
    };
    if (head.bytes !== Number(row.bytes)) await fail('upload_size_mismatch');
    const read = (start, end) => storage.getRange(row.object_key, start, end);
    const info = await probeMedia(await read(0, Math.min(head.bytes, 65536) - 1), head.bytes, read).catch(() => null);
    if (!info || info.contentType !== sniffedType(row.content_type)) await fail('upload_type_mismatch');
    let durationMs = info.duration_ms;
    if (row.kind === 'audio') {
      // Duration is measured here from the stored bytes (≤32MB) and persisted; the client's value is never used.
      durationMs = await probeAudioDurationMs(await read(0, head.bytes - 1), { spawn, ffprobe }).catch(() => null);
      if (durationMs === null) await fail('audio_unreadable');
      if (durationMs < AUDIO_MIN_MS) await fail('audio_too_short');
      if (durationMs > AUDIO_MAX_MS) await fail('audio_too_long');
    }
    // Queued in the same UPDATE as ready (same effect as enqueueThumb), so no ready asset can miss its thumbnail job.
    // Audio has no thumbnails: thumb_state stays 'none'.
    const saved = (await db.query(`UPDATE media_assets SET status='ready',width=$2,height=$3,duration_ms=$4,
        thumb_state=CASE WHEN kind='audio' THEN 'none' ELSE 'queued' END,thumb_attempts=0,
        thumb_next_at=CASE WHEN kind='audio' THEN NULL ELSE now() END,thumb_error=NULL
      WHERE id=$1 AND status='pending' RETURNING *`, [row.id, info.width, info.height, durationMs])).rows[0];
    if (!saved) throw httpError(409, 'upload_not_pending');
    return publicAsset(saved, storage);
  });

  app.get('/api/me/assets', async (req, reply) => {
    ready();
    const args = [req.apiUser.id], where = ["user_id=$1", "status='ready'"];
    const { cursor, kind, source, folder } = req.query ?? {};
    if (folder !== undefined) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(folder))
        || !(await db.query('SELECT 1 FROM asset_folders WHERE id=$1 AND user_id=$2', [folder, req.apiUser.id])).rowCount) throw httpError(404, 'folder_not_found');
      args.push(folder); where.push(`EXISTS (SELECT 1 FROM asset_folder_items i WHERE i.folder_id=$${args.length} AND i.asset_id=media_assets.id)`);
    }
    if (kind !== undefined) { if (!['image', 'video', 'audio'].includes(kind)) throw httpError(400, 'invalid_kind'); args.push(kind); where.push(`kind=$${args.length}`); }
    if (source !== undefined) { if (!['upload', 'generation', 'poster'].includes(source)) throw httpError(400, 'invalid_source'); args.push(source); where.push(`source=$${args.length}`); }
    if (cursor !== undefined) {
      let at, id;
      try { [at, id] = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8')); } catch { /* fall through */ }
      if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) throw httpError(400, 'invalid_cursor');
      args.push(at, uuid(id)); where.push(`(created_at,id)<($${args.length - 1}::timestamptz,$${args.length}::uuid)`);
    }
    // created_at::text keeps microseconds; a JS Date would truncate them and skip rows at page edges.
    const rows = (await db.query(`SELECT *,created_at::text AS cursor_at FROM media_assets WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC,id DESC LIMIT ${PAGE + 1}`, args)).rows;
    const last = rows.length > PAGE ? rows[PAGE - 1] : null;
    reply.header('Cache-Control', 'private, max-age=60');
    return { items: rows.slice(0, PAGE).map(row => publicAsset(row, storage)),
      next_cursor: last ? Buffer.from(JSON.stringify([last.cursor_at, last.id])).toString('base64url') : null };
  });

  app.delete('/api/me/assets/:id', async (req, reply) => {
    const result = await db.query(`UPDATE media_assets SET status='deleted',deleted_at=coalesce(deleted_at,now())
      WHERE id=$1 AND user_id=$2 RETURNING id`, [uuid(req.params.id), req.apiUser.id]);
    if (!result.rowCount) throw httpError(404, 'asset_not_found');
    return reply.code(204).send();
  });
}

// Removes stale pending uploads (>24h), failed rows (>24h) and soft-deleted assets (>30d), objects first.
export async function cleanupMedia(db, storage, now = new Date()) {
  if (!storage) return { removed: 0, failed: 0 };
  const rows = (await db.query(`SELECT id,object_key,variants FROM media_assets
    WHERE (status IN ('pending','failed') AND created_at < $1::timestamptz - interval '24 hours')
       OR (status='deleted' AND deleted_at < $1::timestamptz - interval '30 days'
         -- history keeps the reference ids it was generated with; subjects keep theirs until replaced.
         AND NOT EXISTS (SELECT 1 FROM generation_references g WHERE g.asset_id=media_assets.id)
         AND NOT EXISTS (SELECT 1 FROM subject_assets s WHERE s.asset_id=media_assets.id)
         AND NOT EXISTS (SELECT 1 FROM inspiration_cases c WHERE c.cover_id=media_assets.id)
         AND NOT EXISTS (SELECT 1 FROM inspiration_case_references cr WHERE cr.asset_id=media_assets.id)
         AND NOT EXISTS (SELECT 1 FROM canvas_projects p WHERE p.thumb_id=media_assets.id))
    ORDER BY created_at LIMIT 100`, [now.toISOString()])).rows;
  let removed = 0, failed = 0;
  for (const row of rows) {
    try {
      for (const key of [row.object_key, ...Object.values(row.variants ?? {})]) await storage.delete(key);
      await db.tx(async c => {
        await c.query('UPDATE media_assets SET poster_id=NULL WHERE poster_id=$1', [row.id]);
        await c.query('UPDATE subjects SET cover_id=NULL WHERE cover_id=$1', [row.id]);
        await c.query('UPDATE user_templates SET cover_id=NULL WHERE cover_id=$1', [row.id]);
        await c.query('DELETE FROM media_assets WHERE id=$1', [row.id]);
      });
      removed++;
    } catch { failed++; } // retried on the next loop
  }
  return { removed, failed };
}

// 契约登记，见 src/studio.mjs routeMeta。
export const routeMeta = {
  'POST /api/me/uploads': { body: 'UploadRequest', response: 'UploadTicket' },
  'POST /api/me/uploads/:id/complete': { response: 'MediaAsset' },
  'GET /api/me/assets': { query: 'AssetListQuery', response: 'Page<MediaAsset>' },
  'DELETE /api/me/assets/:id': { response: 'Empty' },
};
