import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { hash, passwordHash } from './security.mjs';

export function database(config) {
  const pool = new pg.Pool({ ...config, max: 8, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5000,
    statement_timeout: 10_000, application_name: 'ipzsk-gateway' });
  pool.on('error', () => console.error('database_connection_error'));
  return {
    pool,
    query: (sql, args) => pool.query(sql, args),
    async tx(work) {
      const c = await pool.connect();
      try { await c.query('BEGIN'); const result = await work(c); await c.query('COMMIT'); return result; }
      catch (e) { await c.query('ROLLBACK'); throw e; }
      finally { c.release(); }
    },
    async migrate() { await pool.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8')); },
    async recover() {
      await pool.query(`UPDATE requests SET status='uncertain',usage_state='unknown',
        error_code='process_restarted',completed_at=now() WHERE status IN ('queued','running')`);
      // 视频的冻结要持续到上游任务终态（几分钟），不是一次 HTTP 请求（几秒）。
      // 还在跑的媒体任务保持 reserved，由 syncMediaTasks 到终态时结算；
      // 无条件转 pending 会让每次部署都把在途视频打成待人工核销，且之后永不自动结算。
      await pool.query(`UPDATE request_billing b SET state='pending',reason='process_restarted'
        WHERE b.state='reserved' AND NOT EXISTS (SELECT 1 FROM media_tasks t
          WHERE t.id=b.request_id AND t.status NOT IN ('completed','failed','cancelled'))`);
      await pool.query('DELETE FROM admin_sessions WHERE expires_at<now()');
    },
    close: () => pool.end(),
  };
}
export async function bootstrap(db, upstream, { adminPasswordFile, secretDir, initialModels }) {
  if (!(await db.query('SELECT id FROM administrators WHERE id=1')).rowCount) {
    const password = (await readFile(adminPasswordFile, 'utf8')).trim();
    if (password.length < 20) throw new Error('bootstrap_password_too_short');
    await db.query('INSERT INTO administrators (id,password_hash) VALUES (1,$1)', [await passwordHash(password)]);
  }
  const ref = 'apimart-primary.key';
  let key;
  try { key = (await readFile(join(secretDir, ref), 'utf8')).trim(); }
  catch (e) { if (e.code === 'ENOENT') return; throw e; }
  if ((await db.query('SELECT id FROM upstream_keys WHERE fingerprint=$1', [hash(key)])).rowCount) return;
  const existing = await db.query('SELECT id FROM upstream_accounts WHERE name=$1', ['APIMart 主账户']);
  const id = existing.rows[0]?.id ?? randomUUID();
  if (!existing.rowCount) await db.query('INSERT INTO upstream_accounts (id,name) VALUES ($1,$2)', [id, 'APIMart 主账户']);
  await upstream.addKey({ account_id: id, name: '主账户 Key 01', key, models: initialModels }, ref);
}
