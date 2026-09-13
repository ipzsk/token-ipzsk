import { createHash } from 'node:crypto';
import { imageUrls, fetchResultImage } from './image-results.mjs';
import { httpError } from './security.mjs';

export async function archiveImageTask(db, storage, id, download = fetchResultImage) {
  return db.tx(async c => {
    const lock = await c.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired', ['image-archive:' + id]);
    if (!lock.rows[0].acquired) return;
    const task = (await c.query(`SELECT t.result,r.user_id,a.attempts FROM image_archives a
      JOIN media_tasks t ON t.id=a.task_id JOIN requests r ON r.id=t.id
      WHERE a.task_id=$1 AND a.state='pending' AND a.next_attempt_at<=now()`, [id])).rows[0];
    if (!task) return;
    try {
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
        const key = `users/${task.user_id}/imagegen/${id}/${index}-${sha}.${extension}`;
        await storage.put(key, data, image.type);
        await c.query(`INSERT INTO archived_images(task_id,image_index,object_key,content_type,bytes,sha256)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [id,index,key,image.type,size,sha]);
      }
      await c.query("UPDATE image_archives SET state='completed',archived_at=now(),last_error=NULL WHERE task_id=$1", [id]);
    } catch {
      // Commit successful image rows and retry remaining files. Never resubmit generation.
      const seconds = Math.min(3600, 30 * 2 ** Math.min(task.attempts, 7));
      await c.query(`UPDATE image_archives SET attempts=attempts+1,next_attempt_at=now()+$2*interval '1 second',
        last_error='image_archive_failed' WHERE task_id=$1`, [id,seconds]);
    }
  });
}

export async function syncImageArchives(db, storage, download = fetchResultImage) {
  if (!storage) return;
  // Only IP knowledge-base accounts and tasks created since the explicit rollout date.
  await db.query(`INSERT INTO image_archives(task_id)
    SELECT t.id FROM media_tasks t JOIN requests r ON r.id=t.id JOIN users u ON u.id=r.user_id
    WHERE t.kind='image' AND t.status='completed' AND u.auth_user_id IS NOT NULL AND u.email_verified
      AND r.created_at >= $1 AND NOT EXISTS(SELECT 1 FROM image_archives a WHERE a.task_id=t.id)
    ORDER BY r.created_at LIMIT 20 ON CONFLICT DO NOTHING`, [storage.archiveFrom]);
  const tasks = (await db.query("SELECT task_id FROM image_archives WHERE state='pending' AND next_attempt_at<=now() ORDER BY next_attempt_at LIMIT 5")).rows;
  for (const task of tasks) await archiveImageTask(db, storage, task.task_id, download);
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
    const rows = (await db.query(`SELECT i.task_id,i.image_index,i.content_type,i.bytes,i.object_key,r.model,r.created_at
      FROM archived_images i JOIN requests r ON r.id=i.task_id WHERE r.user_id=$1
      ORDER BY r.created_at DESC,i.task_id DESC,i.image_index LIMIT 51 OFFSET $2`, [req.apiUser.id,Number(offset)])).rows;
    return { rows: rows.slice(0,50).map(({ object_key, ...row }) => ({ ...row,url:imageStorage.getUrl(object_key) })),
      next_offset: rows.length>50 ? Number(offset)+50 : null, url_expires_in:300 };
  });
}
