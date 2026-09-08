import { recordTaskCharge } from './task-charges.mjs';

const terminal = ['completed', 'failed', 'cancelled'];
// A database lock deduplicates browser polling and workers, including across processes.
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
      if (!response.ok) { await response.body?.cancel(); return; }
      const raw = await response.json(), data = raw.data;
      if (!data || data.id && data.id !== task.upstream_task_id || ![...terminal,'submitted','pending','queued','processing'].includes(data.status)) return;
      const result = {id,status:data.status,progress:data.progress??0,result:data.result??null,
        ...(terminal.includes(data.status) && data.status !== 'completed' ? {error:{message:'Media generation failed.'}} : {})};
      await c.query('UPDATE media_tasks SET status=$2,result=$3 WHERE id=$1',[id,data.status,JSON.stringify(result)]);
      await recordTaskCharge({tx:fn=>fn(c)},task,data);
    } catch {
      // A transient network error leaves the remote task pending, with backoff.
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
