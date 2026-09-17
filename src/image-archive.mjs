import { createHash, randomUUID } from 'node:crypto';
import { probeMedia } from './media-probe.mjs';
import { enqueueThumb } from './media-thumbs.mjs';
import { OBJECT_CACHE_CONTROL, publicAsset } from './uploads.mjs';
import { imageUrls, videoUrls, thumbnailUrls, sideUrls, fetchResultImage, fetchResultVideo, fetchSubtitle } from './image-results.mjs';
import { httpError } from './security.mjs';

// Upstream result URLs expire; after this many failed attempts, or this long after the task was created (≈ completed: generation
// takes minutes), a failure marks the archive 'failed' for good instead of retrying hourly forever. Billing is not touched.
export const ARCHIVE_MAX_ATTEMPTS = 8, ARCHIVE_MAX_AGE_DAYS = 7;

// Returns { task_id, reason } when this call gave up on the task permanently, otherwise undefined.
export async function archiveImageTask(db, storage, id, download = fetchResultImage, downloadVideo = fetchResultVideo, downloadText = fetchSubtitle) {
  return db.tx(async c => {
    const lock = await c.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired', ['image-archive:' + id]);
    if (!lock.rows[0].acquired) return;
    const task = (await c.query(`SELECT t.kind,t.result,r.user_id,a.attempts,
        r.created_at < now() - make_interval(days => ${ARCHIVE_MAX_AGE_DAYS}) AS expired FROM image_archives a
      JOIN media_tasks t ON t.id=a.task_id JOIN requests r ON r.id=t.id
      WHERE a.task_id=$1 AND a.state='pending' AND a.next_attempt_at<=now()`, [id])).rows[0];
    if (!task) return;
    try {
      if (task.kind === 'video') {
        await archiveVideos(c, storage, id, task, downloadVideo, download, downloadText);
        await c.query("UPDATE image_archives SET state='completed',archived_at=now(),last_error=NULL WHERE task_id=$1", [id]);
        return;
      }
      const urls = imageUrls(task.result);
      if (!urls.length) throw new Error('image_result_missing');
      for (const [index, url] of urls.entries()) {
        if ((await c.query('SELECT 1 FROM archived_images WHERE task_id=$1 AND image_index=$2', [id, index])).rowCount) continue;
        const image = await download(url);
        const chunks = []; let size = 0;
        for await (const chunk of image.body) {
          size += chunk.length;
          if (size > 32_000_000) throw new Error('image_too_large');
          chunks.push(Buffer.from(chunk));
        }
        if (!size) throw new Error('image_empty');
        const data = Buffer.concat(chunks);
        const sha = createHash('sha256').update(data).digest('hex');
        const extension = { 'image/png':'png', 'image/jpeg':'jpg', 'image/webp':'webp' }[image.type];
        if (!extension) throw new Error('unsupported_image_type');
        // v19 key layout: one directory per asset, so thumbnails (w480/w960) never collide between result indexes.
        const assetId = randomUUID(), key = `u/${task.user_id}/${assetId}/orig.${extension}`;
        const info = await probeMedia(data, size, async (s, e) => data.subarray(s, e + 1)).catch(() => null);
        await storage.put(key, data, image.type, { cacheControl: OBJECT_CACHE_CONTROL });
        await c.query(`INSERT INTO archived_images(task_id,image_index,object_key,content_type,bytes,sha256)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [id,index,key,image.type,size,sha]);
        // The studio reads results as media_assets(task_id,result_index); generation_records links through task_id.
        const asset = await c.query(`INSERT INTO media_assets(id,user_id,kind,source,status,object_key,content_type,bytes,sha256,width,height,task_id,result_index)
          VALUES($1,$2,'image','generation','ready',$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING id`,
        [assetId,task.user_id,key,image.type,size,sha,info?.width ?? null,info?.height ?? null,id,index]);
        if (asset.rowCount) await enqueueThumb(c, assetId);
      }
      await c.query("UPDATE image_archives SET state='completed',archived_at=now(),last_error=NULL WHERE task_id=$1", [id]);
    } catch {
      // Commit successful image rows and retry remaining files. Never resubmit generation.
      if (task.expired || task.attempts + 1 >= ARCHIVE_MAX_ATTEMPTS) {
        const reason = task.expired ? 'upstream_expired' : 'attempts_exhausted';
        await c.query("UPDATE image_archives SET state='failed',attempts=attempts+1,last_error=$2 WHERE task_id=$1", [id, reason]);
        return { task_id: id, reason };
      }
      const seconds = Math.min(3600, 30 * 2 ** Math.min(task.attempts, 7));
      await c.query(`UPDATE image_archives SET attempts=attempts+1,next_attempt_at=now()+$2*interval '1 second',
        last_error='image_archive_failed' WHERE task_id=$1`, [id,seconds]);
    }
  });
}

// Video results (same queue table, same retry/backoff): stream with a 200MB cap into u/{user}/{asset}/orig.mp4.
// ponytail: the file is buffered in memory for the signed PUT (≤200MB); switch to multipart upload if videos get larger.
// Only mp4 (by magic bytes) is archived; an image served from videos[] is skipped, not retried forever.
// The upstream thumbnail (result.thumbnails[0]) becomes the first video's poster asset (source 'poster').
// A captioned version (captions=true) is stored as one more result asset right after the main videos (result_index = videos count).
// Subtitles (srt) are archived as text into generation_records.params.subtitles_srt.
const best = async (c, name, fn) => { await c.query(`SAVEPOINT ${name}`); await fn().then(() => c.query(`RELEASE SAVEPOINT ${name}`), () => c.query(`ROLLBACK TO SAVEPOINT ${name}`)); };
async function archiveVideos(c, storage, id, task, download, downloadImage, downloadText) {
  const urls = videoUrls(task.result);
  if (!urls.length) throw new Error('video_result_missing');
  const captioned = sideUrls(task.result, 'captioned_videos')[0];
  let archived = 0;
  for (const [index, url] of [...urls, ...(captioned ? [captioned] : [])].entries()) {
    const main = index < urls.length;
    if ((await c.query('SELECT 1 FROM media_assets WHERE task_id=$1 AND result_index=$2', [id, index])).rowCount) { if (main) archived++; continue; }
    if (!main && !archived) break; // no main video: nothing to caption
    const video = await download(url);
    if (video.type?.startsWith('image/')) { video.body.destroy(); continue; }
    const chunks = []; let size = 0;
    for await (const chunk of video.body) {
      size += chunk.length;
      if (size > 200 * 1024 * 1024) throw new Error('video_too_large');
      chunks.push(Buffer.from(chunk));
    }
    if (!size) throw new Error('video_empty');
    const data = Buffer.concat(chunks);
    const info = await probeMedia(data, size, async (s, e) => data.subarray(s, e + 1)).catch(() => null);
    if (info?.contentType !== 'video/mp4') continue; // e.g. a JPEG served as octet-stream
    const assetId = randomUUID(), key = `u/${task.user_id}/${assetId}/orig.mp4`;
    await storage.put(key, data, 'video/mp4', { cacheControl: OBJECT_CACHE_CONTROL });
    await c.query(`INSERT INTO media_assets(id,user_id,kind,source,status,object_key,content_type,bytes,sha256,width,height,duration_ms,task_id,result_index)
      VALUES($1,$2,'video','generation','ready',$3,'video/mp4',$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
    [assetId, task.user_id, key, size, createHash('sha256').update(data).digest('hex'), info.width, info.height, info.duration_ms, id, index]);
    await enqueueThumb(c, assetId); // poster.webp + w480.webp
    // Poster is best effort: a failed insert must not abort the archive transaction.
    if (main && !archived++) await best(c, 'poster', () => archivePoster(c, storage, task, assetId, downloadImage));
  }
  if (!archived) throw new Error('video_result_missing');
  const srt = sideUrls(task.result, 'subtitles')[0];
  if (srt && !(await c.query("SELECT 1 FROM generation_records WHERE task_id=$1 AND params ? 'subtitles_srt'", [id])).rowCount) {
    await best(c, 'subtitles', async () => {
      const text = await downloadText(srt);
      if (text && Buffer.byteLength(text) <= 65_536) {
        await c.query(`UPDATE generation_records SET params=params||jsonb_build_object('subtitles_srt',$2::text) WHERE task_id=$1`, [id, text]);
      }
    });
  }
}

async function archivePoster(c, storage, task, videoId, download) {
  const [url] = thumbnailUrls(task.result);
  if (!url) return;
  const image = await download(url);
  const chunks = []; let size = 0;
  for await (const chunk of image.body) { size += chunk.length; if (size > 32_000_000) throw new Error('image_too_large'); chunks.push(Buffer.from(chunk)); }
  const data = Buffer.concat(chunks);
  const info = await probeMedia(data, size, async (s, e) => data.subarray(s, e + 1)).catch(() => null);
  const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[info?.contentType];
  if (!extension) return;
  const posterId = randomUUID(), key = `u/${task.user_id}/${posterId}/orig.${extension}`;
  await storage.put(key, data, info.contentType, { cacheControl: OBJECT_CACHE_CONTROL });
  await c.query(`INSERT INTO media_assets(id,user_id,kind,source,status,object_key,content_type,bytes,sha256,width,height)
    VALUES($1,$2,'image','poster','ready',$3,$4,$5,$6,$7,$8)`,
  [posterId, task.user_id, key, info.contentType, size, createHash('sha256').update(data).digest('hex'), info.width, info.height]);
  await c.query('UPDATE media_assets SET poster_id=$2 WHERE id=$1', [videoId, posterId]);
}

export async function syncImageArchives(db, storage, download = fetchResultImage, downloadVideo = fetchResultVideo, downloadText = fetchSubtitle) {
  if (!storage) return { failed: [] };
  // Only IP knowledge-base accounts and tasks created since the explicit rollout date.
  await db.query(`INSERT INTO image_archives(task_id)
    SELECT t.id FROM media_tasks t JOIN requests r ON r.id=t.id JOIN users u ON u.id=r.user_id
    WHERE t.kind IN ('image','video') AND t.status='completed' AND u.auth_user_id IS NOT NULL AND u.email_verified
      AND r.created_at >= $1 AND NOT EXISTS(SELECT 1 FROM image_archives a WHERE a.task_id=t.id)
    ORDER BY r.created_at LIMIT 20 ON CONFLICT DO NOTHING`, [storage.archiveFrom]);
  const tasks = (await db.query("SELECT task_id FROM image_archives WHERE state='pending' AND next_attempt_at<=now() ORDER BY next_attempt_at LIMIT 5")).rows;
  const failed = [];
  for (const task of tasks) {
    const gaveUp = await archiveImageTask(db, storage, task.task_id, download, downloadVideo, downloadText);
    if (gaveUp) failed.push(gaveUp);
  }
  return { failed }; // each task appears here exactly once: the row leaves 'pending' in the same transaction
}

export async function ownedArchivedImage(db, user, id, index) {
  return (await db.query(`SELECT i.object_key,i.content_type FROM archived_images i JOIN requests r ON r.id=i.task_id
    WHERE i.task_id=$1 AND i.image_index=$2 AND r.user_id=$3 AND ($4::uuid IS NULL OR r.plugin_id=$4)`,
    [id,index,user.id,user.plugin_id??null])).rows[0];
}

export function imageArchiveRoutes(app, { db, imageStorage }) {
  app.get('/api/me/images', async req => {
    if (!imageStorage) throw httpError(503,'image_storage_unavailable');
    const offset = String(req.query.offset ?? '0');
    if (!/^\d{1,7}$/.test(offset)) throw httpError(400,'invalid_offset');
    // After the v19 backfill an archived image also exists as a media_assets row (same task_id/result_index): hand out that
    // asset's 6h time-sliced URLs (cacheable, plus w480/w960 when thumbnailed) instead of signing the pre-v19 key every call.
    const rows = (await db.query(`SELECT i.task_id,i.image_index,i.content_type,i.bytes,i.object_key,r.model,r.created_at,
        m.object_key AS asset_key,m.variants AS asset_variants
      FROM archived_images i JOIN requests r ON r.id=i.task_id
      LEFT JOIN media_assets m ON m.task_id=i.task_id AND m.result_index=i.image_index AND m.user_id=r.user_id AND m.status='ready'
      WHERE r.user_id=$1
      ORDER BY r.created_at DESC,i.task_id DESC,i.image_index LIMIT 51 OFFSET $2`, [req.apiUser.id,Number(offset)])).rows;
    return { rows: rows.slice(0,50).map(({ object_key, asset_key, asset_variants, ...row }) => {
      if (!asset_key) return { ...row,url:imageStorage.getUrl(object_key) };
      const { urls } = publicAsset({ object_key:asset_key, variants:asset_variants }, imageStorage);
      return { ...row,url:urls.orig,urls };
    }),
      next_offset: rows.length>50 ? Number(offset)+50 : null, url_expires_in:300 };
  });
}

// One-off: copy pre-v19 archived_images (users/{user}/imagegen/...) to u/{user}/{asset}/orig.{ext} as media_assets.
// Resumable: rows already present by (task_id,result_index) are skipped; the asset id is derived from (task,index),
// so a crash between copy and insert re-copies onto the same key. Old objects are left in place.
export const backfillAssetId = (taskId, index) => {
  const h = createHash('sha256').update(`archived-image:${taskId}:${index}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
export async function backfillArchivedImages({ db, storage, limit = Infinity, dryRun = false, concurrency = 4, log = console.log }) {
  const stats = { copied: 0, failed: 0, planned: 0 };
  let after = ['00000000-0000-0000-0000-000000000000', -1], seen = 0;
  while (seen < limit) {
    const rows = (await db.query(`SELECT i.task_id,i.image_index,i.object_key,i.content_type,i.bytes,i.sha256,r.user_id,r.created_at
      FROM archived_images i JOIN requests r ON r.id=i.task_id
      WHERE (i.task_id,i.image_index)>($1::uuid,$2::int)
        AND NOT EXISTS (SELECT 1 FROM media_assets m WHERE m.task_id=i.task_id AND m.result_index=i.image_index)
      ORDER BY i.task_id,i.image_index LIMIT $3`, [...after, Math.min(100, limit - seen)])).rows;
    if (!rows.length) break;
    seen += rows.length; after = [rows.at(-1).task_id, rows.at(-1).image_index];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
      while (next < rows.length) {
        const row = rows[next++], assetId = backfillAssetId(row.task_id, row.image_index);
        const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[row.content_type];
        const key = `u/${row.user_id}/${assetId}/orig.${ext}`;
        if (dryRun) { stats.planned++; log(`copy\t${row.object_key}\t${key}`); continue; }
        try {
          const read = (s, e) => storage.getRange(row.object_key, s, e);
          const info = await probeMedia(await read(0, Math.min(row.bytes, 65536) - 1), row.bytes, read).catch(() => null);
          if (!info || info.contentType !== row.content_type) throw new Error('type_mismatch');
          await storage.copy(row.object_key, key, { cacheControl: OBJECT_CACHE_CONTROL, contentType: row.content_type });
          await db.tx(async (c) => {
            const inserted = await c.query(`INSERT INTO media_assets(id,user_id,kind,source,status,object_key,content_type,bytes,sha256,width,height,task_id,result_index,created_at)
              VALUES($1,$2,'image','generation','ready',$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
            [assetId, row.user_id, key, row.content_type, row.bytes, row.sha256, info.width, info.height, row.task_id, row.image_index, row.created_at]);
            if (inserted.rowCount) await enqueueThumb(c, assetId);
          });
          stats.copied++;
        } catch (e) { stats.failed++; log(`failed\t${row.task_id}/${row.image_index}\t${e.message}`); }
      }
    }));
  }
  return stats;
}
