import { recordTaskCharge } from './task-charges.mjs';
import { settleMediaRequest } from './billing.mjs';
import { recordStatus } from './studio.mjs';
import { settleStatus } from './image-results.mjs';
import { avatarErrorFor } from './avatar-contract.mjs';

const terminal = ['completed', 'failed', 'cancelled'];

/**
 * What a task status means for the generation record and for billing. A `completed` task only counts as succeeded
 * with a real result (an image URL, or a video URL — thumbnails / subtitles live in separate keys); otherwise it is a
 * failure and the hold is released, never charged for nothing.
 */
export function taskOutcome(kind, rawStatus, task, failReason) {
  const settle = settleStatus(kind, rawStatus, task);
  if (settle !== rawStatus) { const failureCode = kind === 'video' ? 'video_result_missing' : 'image_result_missing'; return { status: 'failed', failureCode, settle, settleReason: failureCode }; }
  const status = recordStatus(rawStatus);
  const failureCode = ['failed', 'cancelled'].includes(status) ? (avatarErrorFor(null, failReason)?.code ?? 'media_task_' + rawStatus) : null;
  return { status, failureCode, settle, settleReason: undefined };
}
// A database lock deduplicates browser polling and workers, including across processes.
// Returns 'upstream_unavailable' when the upstream could not be read (callers other than the admin resync ignore it).
export async function refreshMediaTask(db, upstream, id) {
  return db.tx(async c => {
    const lock = await c.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired', ['media:'+id]);
    if (!lock.rows[0].acquired) return;
    const task = (await c.query(`SELECT t.*,r.created_at,k.secret_ref FROM media_tasks t
      JOIN requests r ON r.id=t.id JOIN upstream_keys k ON k.id=r.key_id WHERE t.id=$1`, [id])).rows[0];
    if (!task || terminal.includes(task.status) && task.result) return;
    const age = Date.now()-new Date(task.created_at).getTime();
    const interval = age < 60000 ? 5000 : age < 300000 ? 15000 : 30000;
    if (task.result && Date.now()-new Date(task.updated_at).getTime() < interval) return;
    try {
      const response = await upstream.request(task.secret_ref, '/v1/tasks/'+encodeURIComponent(task.upstream_task_id), {signal:AbortSignal.timeout(15000)});
      if (!response.ok) { await response.body?.cancel(); return 'upstream_unavailable'; }
      const raw = await response.json(), data = raw.data;
      if (!data || data.id && data.id !== task.upstream_task_id || ![...terminal,'submitted','pending','queued','processing'].includes(data.status)) return;
      const result = {id,status:data.status,progress:data.progress??0,result:data.result??null,
        ...(terminal.includes(data.status) && data.status !== 'completed' ? {error:{message:'Media generation failed.'}} : {})};
      await c.query('UPDATE media_tasks SET status=$2,result=$3 WHERE id=$1',[id,data.status,JSON.stringify(result)]);
      const outcome=taskOutcome(task.kind,data.status,result,data.fail_reason);
      await c.query(`UPDATE generation_records SET status=$2,failure_code=$3,updated_at=now()
        WHERE task_id=$1 AND status IN ('queued','running') AND status<>$2`,[id,outcome.status,outcome.failureCode]);
      await recordTaskCharge({tx:fn=>fn(c)},task,data);
      // A terminal task must not leave funds frozen, even when the upstream reports no cost; a completed task without a
      // result settles as failed (released).
      if (terminal.includes(data.status)) await settleMediaRequest(c,id,outcome.settle,outcome.settleReason);
    } catch {
      // A transient network error leaves the remote task pending, with backoff.
      return 'upstream_unavailable';
    } finally {
      await c.query("UPDATE media_tasks SET updated_at=now(),result=coalesce(result,jsonb_build_object('id',id,'status',status,'progress',0,'result',NULL)) WHERE id=$1",[id]);
    }
  });
}

export async function syncMediaTasks(db, upstream) {
  const tasks = (await db.query(`SELECT t.id FROM media_tasks t JOIN requests r ON r.id=t.id
    WHERE t.status NOT IN ('completed','failed','cancelled')
    AND t.updated_at < now() - CASE WHEN r.created_at>now()-interval '1 minute' THEN interval '5 seconds'
      WHEN r.created_at>now()-interval '5 minutes' THEN interval '15 seconds' ELSE interval '30 seconds' END
    ORDER BY t.updated_at LIMIT 20`)).rows;
  let cursor=0;
  await Promise.all(Array.from({length:Math.min(4,tasks.length)},async()=>{
    while(cursor<tasks.length) { const task=tasks[cursor++]; await refreshMediaTask(db,upstream,task.id).catch(()=>{}); }
  }));
}
