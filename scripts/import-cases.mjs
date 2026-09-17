// Import the website's case manifest into inspiration_cases + media_assets (R2 cases/{asset_id}/orig.{ext}).
// Usage (explicit DATABASE_URL and R2_CONFIG_FILE; no production defaults):
//   DATABASE_URL=... R2_CONFIG_FILE=... node scripts/import-cases.mjs <cases.manifest.json> [--images-dir <website repo root>] [--site-origin https://www.ipzsk.com] [--dry-run]
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { database } from '../src/database.mjs';
import { loadR2Storage } from '../src/r2-storage.mjs';
import { importCases } from '../src/cases.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  'images-dir': { type: 'string' }, 'site-origin': { type: 'string' }, 'dry-run': { type: 'boolean', default: false } } });
if (!process.env.DATABASE_URL || !process.env.R2_CONFIG_FILE || positionals.length !== 1) {
  console.error('usage: DATABASE_URL=... R2_CONFIG_FILE=... node scripts/import-cases.mjs <manifest.json> [--images-dir DIR] [--site-origin URL] [--dry-run]');
  process.exit(2);
}
const db = database({ connectionString: process.env.DATABASE_URL });
try {
  if (!(await db.query('SELECT 1 FROM schema_version WHERE version=21')).rowCount) throw new Error('schema_v21_missing: deploy the gateway first');
  const storage = await loadR2Storage(process.env.R2_CONFIG_FILE);
  const manifest = JSON.parse(await readFile(positionals[0], 'utf8'));
  const stats = await importCases({ db, storage, manifest, imagesDir: values['images-dir'], siteOrigin: values['site-origin'], dryRun: values['dry-run'] });
  console.log(JSON.stringify(stats));
  if (stats.failed) process.exitCode = 1;
} finally { await db.close(); }
