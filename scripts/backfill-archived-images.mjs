// Copy archived_images (old users/... keys) into media_assets under u/{user}/{asset}/orig.{ext}. Old objects are kept.
// Usage: DATABASE_URL=... R2_CONFIG_FILE=... node scripts/backfill-archived-images.mjs [--limit N] [--dry-run]
// Resumable: re-running skips rows that already have a media_assets row for (task_id, result_index).
import { parseArgs } from 'node:util';
import { database } from '../src/database.mjs';
import { loadR2Storage } from '../src/r2-storage.mjs';
import { backfillArchivedImages } from '../src/image-archive.mjs';

const { values } = parseArgs({ options: { limit: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } } });
const limit = values.limit === undefined ? Infinity : Number(values.limit);
if (!process.env.DATABASE_URL || !process.env.R2_CONFIG_FILE || !(limit > 0)) {
  console.error('usage: DATABASE_URL=... R2_CONFIG_FILE=... node scripts/backfill-archived-images.mjs [--limit N] [--dry-run]');
  process.exit(2);
}
const db = database({ connectionString: process.env.DATABASE_URL });
try {
  if (!(await db.query('SELECT 1 FROM schema_version WHERE version=21')).rowCount) throw new Error('schema_v21_missing: deploy the gateway first');
  const stats = await backfillArchivedImages({ db, storage: await loadR2Storage(process.env.R2_CONFIG_FILE), limit, dryRun: values['dry-run'] });
  console.log(JSON.stringify(stats));
  if (stats.failed) process.exitCode = 1;
} finally { await db.close(); }
