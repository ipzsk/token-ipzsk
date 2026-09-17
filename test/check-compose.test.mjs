import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { checkCompose, gatewayBlock } from '../scripts/ops/check-compose.mjs';

const fixture = (name) => new URL('./fixtures/compose/' + name, import.meta.url);

test('server compose with every required gateway key passes', () => {
  assert.deepEqual(checkCompose(readFileSync(fixture('server-ok.yaml'), 'utf8')), []);
  assert.ok(!gatewayBlock(readFileSync(fixture('server-ok.yaml'), 'utf8')).includes('SQL_DSN'), 'the lanehub service block is not read as gateway');
  const r = spawnSync(process.execPath, ['scripts/ops/check-compose.mjs', fixture('server-ok.yaml').pathname]);
  assert.equal(r.status, 0, String(r.stderr));
});

test('missing keys are listed (commented-out keys do not count) and the CLI exits 1', () => {
  const missing = checkCompose(readFileSync(fixture('server-missing.yaml'), 'utf8'));
  assert.equal(missing.length, 6, missing.join('\n'));
  assert.ok(missing[0].startsWith('mem_limit') && missing.some((m) => m.startsWith('R2_CONFIG_FILE')) && missing.some((m) => m.startsWith('build:')));
  assert.ok(!missing.includes('LANEHUB_BASE_URL'));
  const r = spawnSync(process.execPath, ['scripts/ops/check-compose.mjs', fixture('server-missing.yaml').pathname]);
  assert.equal(r.status, 1); assert.match(String(r.stderr), /R2_CONFIG_FILE/);
});

test('env list form, byte/gigabyte mem_limit, missing gateway service', () => {
  const svc = (body) => `services:\n  gateway:\n    build: .\n${body}\n  caddy:\n    image: caddy\n`;
  const env = '    environment:\n      - R2_CONFIG_FILE=/r2\n      - LANEHUB_BASE_URL=http://l\n      - LANEHUB_ADMIN_TOKEN=x\n      - LANEHUB_ACCOUNT_ID=1\n      - "LANEHUB_USD_CNY=7"';
  assert.deepEqual(checkCompose(svc('    mem_limit: 1g\n' + env)), []);
  assert.deepEqual(checkCompose(svc(`    mem_limit: ${768 * 1024 * 1024}\n` + env)), []);
  assert.equal(checkCompose(svc(`    mem_limit: 767m\n` + env)).length, 1);
  assert.deepEqual(checkCompose('services:\n  db:\n    image: postgres\n'), ['services.gateway 服务块']);
});
