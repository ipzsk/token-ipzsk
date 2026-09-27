// B5 管理中台（docs/admin-api.md）：§6 权限矩阵 + 行为测试。只连 gateway_test，每次一个临时 schema。
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { database } from '../src/database.mjs';
import { createApp } from '../src/app.mjs';
import { createR2Storage } from '../src/r2-storage.mjs';
import { grantRole, revokeRole } from '../src/roles.mjs';
import { refreshMediaTask } from '../src/media-task-sync.mjs';
import { publishIssues, dateRange } from '../src/admin-studio.mjs';
import { httpError } from '../src/security.mjs';

const SITE = 'https://www.ipzsk.com';

function fakeR2() {
  const objects = new Map();
  const fetcher = async (url, init) => {
    const key = decodeURIComponent(new URL(url).pathname.split('/').slice(2).join('/'));
    if (init.method === 'PUT' && init.headers['x-amz-copy-source']) {
      const src = objects.get(decodeURIComponent(init.headers['x-amz-copy-source']).split('/').slice(2).join('/'));
      if (!src) return new Response(null, { status: 404 });
      objects.set(key, { ...src, type: init.headers['content-type'] ?? src.type });
      return new Response('<CopyObjectResult/>', { status: 200 });
    }
    if (init.method === 'DELETE') { objects.delete(key); return new Response(null, { status: 204 }); }
    return new Response(null, { status: 400 });
  };
  const storage = createR2Storage({ accountId: 'a'.repeat(32), bucket: 'ipzsk-media', accessKeyId: 'AKIDTEST', secretAccessKey: 'secret-test', archiveFrom: '2026-01-01T00:00:00Z' }, fetcher);
  return { storage, objects };
}

test('pure: publish issues list every problem; date ranges', () => {
  const issues = publishIssues({ title: ' ', prompt: 'p', category: 'Bad Cat', license_note: null, source_repo: '', source_url: 'http://x', author_url: 'nope', template: null }, 'pending');
  assert.deepEqual(issues, [{ field: 'title', code: 'required' }, { field: 'category', code: 'invalid' }, { field: 'cover', code: 'cover_not_ready' },
    { field: 'license_note', code: 'required' }, { field: 'source_url', code: 'invalid_url' }, { field: 'author_url', code: 'invalid_url' }]);
  assert.deepEqual(publishIssues({ title: 't', prompt: 'p', category: 'c', license_note: 'MIT', source_repo: null, source_url: null, template: { items: [{ label: 'a', anchor: true }, { label: 'b', anchor: true }] } }, 'ready'),
    [{ field: 'source_url', code: 'source_required' }, { field: 'template', code: 'template_multiple_anchors' }]);
  assert.deepEqual(dateRange({ from: '2026-09-17', to: '2026-09-17' }), [Date.parse('2026-09-16T16:00:00Z'), Date.parse('2026-09-17T16:00:00Z')]);
  for (const q of [{ from: '2026-09-18', to: '2026-09-17' }, { from: '2025-01-01', to: '2026-09-17' }, { from: 'yesterday' }]) {
    assert.throws(() => dateRange(q), { code: 'invalid_date_range' }, JSON.stringify(q));
  }
});

test('B5 admin API: permission matrix and behaviour', async (t) => {
  assert.ok(process.env.TEST_DB_HOST, 'Set TEST_DB_HOST explicitly; tests only use gateway_test database.');
  const schema = 'b5_' + randomUUID().replaceAll('-', '');
  const config = { host: process.env.TEST_DB_HOST, port: Number(process.env.TEST_DB_PORT ?? 5432), database: 'gateway_test', user: process.env.TEST_DB_USER ?? 'gateway', password: process.env.TEST_DB_PASSWORD };
  const setup = database(config);
  assert.equal((await setup.query('SELECT current_database() AS name')).rows[0].name, 'gateway_test');
  await setup.query(`CREATE SCHEMA ${schema}`);
  const db = database({ ...config, options: `-c search_path=${schema}` });
  const r2 = fakeR2();
  const apps = [];
  try {
    await db.migrate(); await db.migrate();
    const U = {}, sessions = new Map();
    for (const name of ['admin', 'admin2', 'operator', 'viewer', 'plain', 'expired', 'unverified', 'target']) {
      U[name] = randomUUID();
      await db.query('INSERT INTO users(id,name,email,email_verified) VALUES($1,$2,$3,$4)', [U[name], name, name + '@example.com', name !== 'unverified']);
      sessions.set(U[name], new Date(Date.now() - (name === 'expired' ? 13 : 1) * 3600_000).toISOString());
    }
    for (const [name, role] of [['admin', 'admin'], ['admin2', 'admin'], ['expired', 'admin'], ['operator', 'operator'], ['viewer', 'viewer']]) await grantRole(db, U[name], role);
    const customerAuth = { async identify(headers) {
      const id = headers.cookie?.replace('fixture=', '');
      if (!sessions.has(id)) throw httpError(401, 'customer_login_required');
      const u = (await db.query('SELECT id,name,email FROM users WHERE id=$1', [id])).rows[0];
      return { ...u, token_id: null, session_id: 'session-' + id, session_created_at: sessions.get(id) };
    } };
    const lane = { reply: () => ({ data: [] }) };
    const task = { reply: () => Response.json({ data: { status: 'processing' } }) };
    const upstream = { request: async (_ref, path) => { const r = task.reply(path); return r instanceof Response ? r : Response.json(r); } };
    const makeApp = async () => {
      const app = await createApp({ db, customerAuth, imageStorage: r2.storage, upstream, scheduler: { keys: new Map(), accounts: new Map() }, origin: 'https://api.ipzsk.com',
        lanehub: { call: async () => lane.reply(), usdRate: async () => 7, balance: async () => ({ quota: 0 }) }, lanehubUsdCny: 7, lanehubQuotaPerUnit: 500000 });
      apps.push(app);
      return (who, method, url, payload, headers = {}) => app.inject({ method, url, payload,
        headers: { origin: SITE, ...(who ? { cookie: 'fixture=' + U[who] } : {}), ...headers } });
    };

    // ── fixtures ──
    const upload = async (who, { kind = 'image', status = 'ready', put = true } = {}) => {
      const id = randomUUID(), key = `u/${U[who]}/${id}/orig.${kind === 'image' ? 'png' : 'mp4'}`;
      await db.query(`INSERT INTO media_assets(id,user_id,kind,source,status,object_key,content_type,bytes,sha256,width,height) VALUES($1,$2,$3,'upload',$4,$5,$6,10,'abc',4,3)`,
        [id, U[who], kind, status, key, kind === 'image' ? 'image/png' : 'video/mp4']);
      if (put) r2.objects.set(key, { body: Buffer.from('png'), type: 'image/png' });
      return id;
    };
    const seedCase = async ({ id = 'c-' + randomUUID().slice(0, 8), status = 'draft', position = 100, ...over } = {}) => {
      const cover = randomUUID();
      await db.query(`INSERT INTO media_assets(id,user_id,kind,source,status,object_key,content_type,bytes) VALUES($1,NULL,'image','case','ready',$2,'image/png',10)`, [cover, `cases/${cover}/orig.png`]);
      await db.query(`INSERT INTO inspiration_cases(id,title,prompt,category,cover_id,status,position,license_note,source_repo) VALUES($1,$2,'p','posters',$3,$4,$5,$6,$7)`,
        [id, over.title ?? 't', cover, status, position, over.license_note ?? 'MIT · fetched 2026-09-07', over.source_repo ?? 'repo']);
      return id;
    };
    const accountId = randomUUID(), keyId = randomUUID();
    await db.query(`INSERT INTO upstream_accounts(id,name,base_url,provider_type) VALUES($1,'lane','https://lane.test','lanehub')`, [accountId]);
    await db.query(`INSERT INTO upstream_keys(id,account_id,name,fingerprint,suffix,secret_ref) VALUES($1,$2,'k','fp','0000','lane.key')`, [keyId, accountId]);
    const seedGeneration = async ({ who = 'plain', status = 'running', age = '3 hours', model = 'gpt-image-2', kind = 'image', taskStatus = 'processing', deleted = false, charged = null, completed = false } = {}) => {
      const requestId = randomUUID();
      await db.query(`INSERT INTO requests(id,user_id,key_id,model,fingerprint,stream,upstream_id,created_at,completed_at)
        VALUES($1,$2,$3,$4,'f',false,$5,now()-$6::interval,CASE WHEN $7 THEN now()-interval '1 hour' END)`, [requestId, U[who], keyId, model, 'lh-' + requestId, age, completed]);
      await db.query(`INSERT INTO media_tasks(id,upstream_task_id,kind,status,updated_at) VALUES($1,$2,$3,$4,now()-interval '1 hour')`, [requestId, 'task_' + requestId, kind, taskStatus]);
      return (await db.query(`INSERT INTO generation_records(user_id,request_id,task_id,kind,model,prompt,status,failure_code,charged_points,created_at,updated_at,deleted_at)
        VALUES($1,$2,$2,$3,$4,$5,$6,$7,$8,now()-$9::interval,now()-$9::interval,CASE WHEN $10 THEN now() END) RETURNING id`,
      [U[who], requestId, kind, model, 'prompt '.repeat(60), status, status === 'failed' ? 'media_task_failed' : null, charged, age, deleted])).rows[0].id;
    };
    const auditRows = async (action, target) => (await db.query('SELECT details,actor_user_id FROM audit_events WHERE action=$1 AND target_id=$2 ORDER BY id', [action, target])).rows;

    await t.test('§6 permission matrix: every role × every endpoint', async () => {
      const call = await makeApp();
      const matrixCase = await seedCase({ position: 1 }), neighbor = await seedCase({ position: 2 });
      const syncable = await seedGeneration({ status: 'queued', taskStatus: 'submitted', age: '1 minute' });
      await db.query('UPDATE media_tasks SET updated_at=now()-interval \'1 hour\'');
      const routes = [
        ['R', 'GET', () => '/api/admin/me'],
        ['R', 'GET', () => '/api/admin/cases'],
        ['R', 'GET', () => '/api/admin/case-categories'],
        ['R', 'GET', () => `/api/admin/cases/${matrixCase}`],
        ['R', 'GET', () => '/api/admin/users?q=example'],
        ['R', 'GET', () => `/api/admin/users/${U.target}`],
        ['R', 'GET', () => '/api/admin/roles'],
        ['R', 'GET', () => '/api/admin/generations'],
        ['R', 'GET', () => `/api/admin/generations/${syncable}`],
        ['R', 'GET', () => '/api/admin/audit'],
        ['W', 'POST', () => '/api/admin/cases', async (who) => ({ title: 't', prompt: 'p', category: 'posters', cover_asset_id: await upload(who) })],
        ['W', 'PATCH', () => `/api/admin/cases/${matrixCase}`, () => ({ title: 'renamed' })],
        ['W', 'PATCH', () => `/api/admin/cases/${matrixCase}/position`, () => ({ after_id: neighbor })],
        ['W', 'POST', () => '/api/admin/cases/bulk-status', () => ({ ids: [matrixCase], status: 'draft' })],
        ['W', 'PUT', () => `/api/admin/cases/${matrixCase}/cover`, async (who) => ({ asset_id: await upload(who) })],
        ['W', 'PUT', () => `/api/admin/cases/${matrixCase}/video`, async (who) => ({ asset_id: await upload(who, { kind: 'video' }) })],
        ['W', 'PUT', () => `/api/admin/cases/${matrixCase}/references`, () => ({ asset_ids: [] })],
        ['W', 'DELETE', () => seedCase().then((id) => `/api/admin/cases/${id}`)],
        ['W', 'POST', () => `/api/admin/generations/${syncable}/resync`, () => ({})],
        ['W', 'POST', () => seedGeneration().then((id) => `/api/admin/generations/${id}/cancel`), () => ({ reason: '上游任务已丢失' })],
        ['A', 'PUT', () => `/api/admin/users/${U.target}/roles/viewer`],
        ['A', 'DELETE', () => `/api/admin/users/${U.target}/roles/viewer`],
      ];
      // 「expired」= 13 小时前登录的管理员：会话时长与官网一致后，它和普通管理员没有区别（2026-09-18）。
      const expected = { R: { anon: 401, plain: 403, viewer: 200, operator: 200, admin: 200, expired: 200 },
        W: { anon: 401, plain: 403, viewer: 403, operator: 'ok', admin: 'ok', expired: 'ok' },
        A: { anon: 401, plain: 403, viewer: 403, operator: 403, admin: 'ok', expired: 'ok' } };
      const failures = [];
      for (const [group, method, url, payload] of routes) {
        for (const who of ['anon', 'plain', 'viewer', 'operator', 'admin', 'expired']) {
          const actor = who === 'anon' ? null : who;
          const path = await url();
          const res = await call(actor, method, path, payload ? await payload(actor ?? 'plain') : undefined);
          const want = expected[group][who];
          const ok = want === 'ok' ? res.statusCode >= 200 && res.statusCode < 300 : res.statusCode === want;
          const code = res.statusCode >= 400 ? res.json().error.code : null;
          const codeOk = { 401: 'customer_login_required', 403: 'forbidden_role' }[res.statusCode] ?? code;
          if (!ok || code !== codeOk) failures.push(`${who} ${method} ${path} → ${res.statusCode} ${res.body.slice(0, 200)}`);
        }
      }
      assert.deepEqual(failures, []);
    });

    await t.test('session: 与官网同寿命、写操作校验 Origin、拒绝 bearer、me 形状', async () => {
      const call = await makeApp();
      const me = (await call('admin', 'GET', '/api/admin/me')).json();
      assert.deepEqual(me.roles, ['admin']); assert.equal(me.user.email, 'admin@example.com');
      assert.ok(Date.parse(me.session.expires_at) > Date.now(), 'expires_at 用登录会话自己的过期时间');
      // 13 小时前登录的管理员照样可用：管理中台不再额外要求「最近 12 小时登录过」。
      assert.equal((await call('expired', 'GET', '/api/admin/me')).statusCode, 200);
      const evil = await call('admin', 'POST', '/api/admin/cases/bulk-status', { ids: ['x'], status: 'draft' }, { origin: 'https://evil.test' });
      assert.equal(evil.statusCode, 403); assert.equal(evil.json().error.code, 'origin_not_allowed');
      assert.equal((await call('admin', 'GET', '/api/admin/me', undefined, { origin: 'https://evil.test' })).statusCode, 200, 'GET is not origin-checked');
      const bearer = await call(null, 'GET', '/api/admin/me', undefined, { authorization: 'Bearer ipz_' + 'a'.repeat(43) });
      assert.equal(bearer.statusCode, 401); assert.equal(bearer.json().error.code, 'customer_login_required');
      assert.equal((await call('admin', 'GET', '/api/admin/me')).headers['cache-control'], 'no-store');
    });

    await t.test('cases: create (idempotency, asset ownership), publish validation 422 with all fields, conflict, template, hidden', async () => {
      const call = await makeApp();
      const cover = await upload('operator');
      assert.equal((await call('operator', 'POST', '/api/admin/cases', { title: 't', prompt: 'p', category: 'x', cover_asset_id: await upload('plain') })).json().error.code, 'asset_not_found', 'others\' asset → 404');
      assert.equal((await call('operator', 'POST', '/api/admin/cases', { title: 't', prompt: 'p', category: 'x', cover_asset_id: await upload('operator', { status: 'pending' }) })).json().error.code, 'asset_not_ready');
      assert.equal((await call('operator', 'POST', '/api/admin/cases', { title: 't', prompt: 'p', category: 'x', cover_asset_id: await upload('operator', { kind: 'video' }) })).json().error.code, 'asset_not_image');
      assert.equal((await call('operator', 'POST', '/api/admin/cases', { title: 't', prompt: 'p', category: 'x', cover_asset_id: cover, bogus: 1 })).json().error.code, 'unknown_field');
      const draft = { title: '极简', prompt: 'prompt', category: 'Bad Cat', author_url: 'http://insecure', cover_asset_id: cover };
      const created = await call('operator', 'POST', '/api/admin/cases', draft, { 'idempotency-key': 'k1' });
      assert.equal(created.statusCode, 201, created.body);
      const c = created.json();
      assert.equal(c.status, 'draft'); assert.match(c.id, /^c_[a-z0-9]+$/); assert.equal(c.cover.source, 'case');
      const replay = await call('operator', 'POST', '/api/admin/cases', draft, { 'idempotency-key': 'k1' });
      assert.equal(replay.statusCode, 201); assert.equal(replay.json().id, c.id);
      assert.equal((await call('operator', 'POST', '/api/admin/cases', { ...draft, title: 'other' }, { 'idempotency-key': 'k1' })).json().error.code, 'idempotency_conflict');
      assert.equal((await db.query('SELECT count(*)::int AS n FROM inspiration_cases WHERE title=$1', ['极简'])).rows[0].n, 1);
      assert.ok(c.position < (await db.query('SELECT min(position) AS p FROM inspiration_cases WHERE id<>$1', [c.id])).rows[0].p, 'new cases go first');
      assert.equal((await call('operator', 'POST', '/api/admin/cases', { ...draft, id: c.id })).json().error.code, 'case_id_taken');
      assert.deepEqual(await auditRows('case.create', c.id).then((r) => r.map((x) => [x.details, x.actor_user_id])), [[{ status: 'draft' }, U.operator]]);

      const bad = await call('operator', 'PATCH', `/api/admin/cases/${c.id}`, { status: 'published' });
      assert.equal(bad.statusCode, 422);
      assert.equal(bad.json().error.code, 'case_publish_invalid');
      assert.deepEqual(bad.json().error.fields, [{ field: 'category', code: 'invalid' }, { field: 'license_note', code: 'required' },
        { field: 'source_url', code: 'source_required' }, { field: 'author_url', code: 'invalid_url' }]);
      assert.equal((await call('operator', 'PATCH', `/api/admin/cases/${c.id}`, { titel: 'typo' })).json().error.code, 'unknown_field');
      assert.equal((await call('operator', 'PATCH', `/api/admin/cases/${c.id}`, { template: { items: [{ label: 'a', count: 7 }, { label: 'b', count: 6 }] } })).json().error.code, 'template_too_many_outputs');
      assert.equal((await call('operator', 'PATCH', `/api/admin/cases/${c.id}`, { template: { items: [{ label: 'a', anchor: true }, { label: 'b', anchor: true }] } })).json().error.code, 'template_multiple_anchors');
      const templated = (await call('operator', 'PATCH', `/api/admin/cases/${c.id}`, { template: { items: [{ label: '主图', anchor: true, params: { aspect_ratio: '1:1' } }, { key: 'x', label: '卖点', count: 2 }] } })).json();
      assert.deepEqual(templated.template.items.map((i) => i.key), ['item-1', 'x']);

      const stale = await call('operator', 'PATCH', `/api/admin/cases/${c.id}`, { title: 'stale', expected_updated_at: c.updated_at });
      assert.equal(stale.statusCode, 409); assert.equal(stale.json().error.code, 'case_conflict'); assert.equal(stale.json().case.updated_at, templated.updated_at);
      const fix = { category: 'posters', author_url: 'https://github.com/a', license_note: 'MIT · fetched 2026-09-07', source_repo: 'Punk-Skill', status: 'published', expected_updated_at: templated.updated_at };
      const published = await call('operator', 'PATCH', `/api/admin/cases/${c.id}`, fix);
      assert.equal(published.statusCode, 200, published.body); assert.equal(published.json().status, 'published');
      assert.deepEqual((await auditRows('case.status', c.id)).map((r) => r.details), [{ from: 'draft', to: 'published' }]);
      assert.deepEqual((await auditRows('case.update', c.id)).at(-1).details, { fields: ['category', 'author_url', 'source_repo', 'license_note'] });
      assert.equal((await call(null, 'GET', `/api/public/cases/${c.id}`)).statusCode, 200);
      assert.equal((await call('operator', 'PATCH', `/api/admin/cases/${c.id}`, { license_note: '' })).json().error.code, 'case_publish_invalid', 'changing a required field of a published case re-validates');
      await call('operator', 'PATCH', `/api/admin/cases/${c.id}`, { status: 'hidden' });
      assert.equal((await call(null, 'GET', `/api/public/cases/${c.id}`)).statusCode, 404, 'hidden = gone from public');

      const full = (await call('viewer', 'GET', `/api/admin/cases/${c.id}`)).json();
      assert.equal(full.prompt, 'prompt');
      await db.query('UPDATE inspiration_cases SET prompt=$2 WHERE id=$1', [c.id, 'x'.repeat(500)]);
      const listed = (await call('viewer', 'GET', `/api/admin/cases?status=hidden&q=${c.id}`)).json();
      assert.equal(listed.total, 1); assert.equal(listed.items[0].prompt.length, 200); assert.deepEqual(listed.items[0].references, []);
      assert.equal((await call('viewer', 'GET', '/api/admin/cases?limit=101')).json().error.code, 'invalid_limit');
      assert.equal((await call('viewer', 'GET', '/api/admin/cases?cursor=zzz')).json().error.code, 'invalid_cursor');
      const cats = (await call('viewer', 'GET', '/api/admin/case-categories')).json().items;
      assert.ok(cats.find((x) => x.category === 'posters').count >= 2, 'all statuses counted');
    });

    await t.test('bulk status: independent items, audit bulk:true', async () => {
      const call = await makeApp();
      const good = await seedCase(), bad = await seedCase({ license_note: '' });
      const r = await call('operator', 'POST', '/api/admin/cases/bulk-status', { ids: [good, bad, 'missing'], status: 'published' });
      assert.equal(r.statusCode, 200);
      const [a, b, m] = r.json().items;
      assert.equal(a.ok, true); assert.equal(a.case.status, 'published');
      assert.deepEqual(b, { id: bad, ok: false, error: { code: 'case_publish_invalid', fields: [{ field: 'license_note', code: 'required' }] } });
      assert.deepEqual(m, { id: 'missing', ok: false, error: { code: 'case_not_found' } });
      assert.deepEqual((await auditRows('case.status', good)).map((x) => x.details), [{ from: 'draft', to: 'published', bulk: true }]);
      assert.equal((await auditRows('case.status', bad)).length, 0);
      assert.equal((await call('operator', 'POST', '/api/admin/cases/bulk-status', { ids: [], status: 'published' })).json().error.code, 'invalid_ids');
    });

    await t.test('reorder: neighbours, stale view 409, renumber on tiny gap', async () => {
      const call = await makeApp();
      const [p1, p2, p3] = [await seedCase({ position: 1000 }), await seedCase({ position: 1001 }), await seedCase({ position: 1002 })];
      const moved = await call('operator', 'PATCH', `/api/admin/cases/${p3}/position`, { after_id: p1, before_id: p2 });
      assert.deepEqual(moved.json(), { id: p3, position: 1000.5 });
      assert.deepEqual((await auditRows('case.reorder', p3)).map((x) => x.details), [{ from: 1002, to: 1000.5 }]);
      assert.equal((await call('operator', 'PATCH', `/api/admin/cases/${p1}/position`, { after_id: p2 })).json().position, 1002);
      assert.equal((await call('operator', 'PATCH', `/api/admin/cases/${p2}/position`, { before_id: p3 })).json().position, 999.5);
      const conflict = await call('operator', 'PATCH', `/api/admin/cases/${p1}/position`, { after_id: p3, before_id: p2 });
      assert.equal(conflict.statusCode, 409); assert.equal(conflict.json().error.code, 'case_order_conflict');
      assert.equal((await call('operator', 'PATCH', `/api/admin/cases/${p1}/position`, {})).json().error.code, 'invalid_position');
      assert.equal((await call('operator', 'PATCH', `/api/admin/cases/${p1}/position`, { after_id: 'nope' })).json().error.code, 'case_not_found');
      await db.query('UPDATE inspiration_cases SET position=5000 WHERE id=$1', [p2]);
      await db.query('UPDATE inspiration_cases SET position=5000.0000000001 WHERE id=$1', [p3]);
      const tight = (await call('operator', 'PATCH', `/api/admin/cases/${p1}/position`, { after_id: p2, before_id: p3 })).json();
      const order = (await db.query('SELECT id,position FROM inspiration_cases ORDER BY position,id')).rows;
      assert.ok(order.every((r, i) => i === 0 || r.position > order[i - 1].position), 'positions strictly increasing after renumber');
      assert.deepEqual(order.map((r) => r.id).slice(-3), [p2, p1, p3]);
      assert.equal(order.find((r) => r.id === p1).position, tight.position);
      assert.ok(Number.isInteger(order.at(-1).position));
    });

    await t.test('case video: own ready mp4 copied; kind / license_tier; poster gates publish; not removable while it is the cover', async () => {
      const call = await makeApp();
      const id = await seedCase({ status: 'draft' });
      assert.equal((await call('admin', 'PUT', `/api/admin/cases/${id}/video`, { asset_id: await upload('admin') })).json().error.code, 'asset_not_video');
      assert.equal((await call('admin', 'PUT', `/api/admin/cases/${id}/video`, { asset_id: 'x' })).json().error.code, 'invalid_asset_id');
      const src = await upload('admin', { kind: 'video' });
      const r = await call('admin', 'PUT', `/api/admin/cases/${id}/video`, { asset_id: src });
      assert.equal(r.statusCode, 200, r.body);
      const vid = r.json().video.id;
      assert.notEqual(vid, src);
      assert.deepEqual((await db.query('SELECT user_id,source,kind,content_type,object_key,thumb_state FROM media_assets WHERE id=$1', [vid])).rows[0],
        { user_id: null, source: 'case', kind: 'video', content_type: 'video/mp4', object_key: `cases/${vid}/orig.mp4`, thumb_state: 'queued' });
      assert.deepEqual((await auditRows('case.video', id)).map((x) => x.details), [{ from_asset_id: null, to_asset_id: vid, source_asset_id: src }]);
      const p = await call('admin', 'PATCH', `/api/admin/cases/${id}`, { kind: 'video', license_tier: 'B' });
      assert.equal(p.statusCode, 200, p.body); assert.equal(p.json().kind, 'video'); assert.equal(p.json().license_tier, 'B');
      assert.equal((await call('admin', 'PATCH', `/api/admin/cases/${id}`, { kind: 'gif' })).json().error.code, 'invalid_kind');
      assert.equal((await call('admin', 'PATCH', `/api/admin/cases/${id}`, { license_tier: 'C' })).json().error.code, 'invalid_license_tier');
      assert.deepEqual((await call('admin', 'GET', '/api/admin/cases?kind=video')).json().items.map((x) => x.id), [id]);
      // The video as its own cover: publishing waits for the ffmpeg poster; removing the video is refused.
      await db.query('UPDATE inspiration_cases SET cover_id=video_id WHERE id=$1', [id]);
      const early = await call('admin', 'PATCH', `/api/admin/cases/${id}`, { status: 'published' });
      assert.equal(early.statusCode, 422); assert.deepEqual(early.json().error.fields, [{ field: 'cover', code: 'cover_not_ready' }]);
      await db.query(`UPDATE media_assets SET variants=$2 WHERE id=$1`, [vid, { poster: `cases/${vid}/poster.jpg` }]);
      assert.equal((await call('admin', 'PATCH', `/api/admin/cases/${id}`, { status: 'published' })).statusCode, 200);
      assert.equal((await call('admin', 'PUT', `/api/admin/cases/${id}/video`, { asset_id: null })).json().error.code, 'video_is_cover');
      // A new own cover keeps the old cover (the video) alive; then the video can be removed and is retired.
      assert.equal((await call('admin', 'PUT', `/api/admin/cases/${id}/cover`, { asset_id: await upload('admin') })).statusCode, 200);
      assert.equal((await db.query('SELECT status FROM media_assets WHERE id=$1', [vid])).rows[0].status, 'ready');
      const removed = await call('admin', 'PUT', `/api/admin/cases/${id}/video`, { asset_id: null });
      assert.equal(removed.statusCode, 200, removed.body); assert.equal(removed.json().video, null);
      assert.equal((await db.query('SELECT status FROM media_assets WHERE id=$1', [vid])).rows[0].status, 'deleted');
    });

    await t.test('cover and references are re-homed copies (user_id NULL, source case, thumb queued); copy failure 502', async () => {
      const call = await makeApp();
      const id = await seedCase();
      const oldCover = (await db.query('SELECT cover_id FROM inspiration_cases WHERE id=$1', [id])).rows[0].cover_id;
      const src = await upload('admin');
      const r = await call('admin', 'PUT', `/api/admin/cases/${id}/cover`, { asset_id: src });
      assert.equal(r.statusCode, 200, r.body);
      const newCover = r.json().cover.id;
      assert.notEqual(newCover, src);
      const row = (await db.query('SELECT user_id,source,status,object_key,thumb_state,width,height,sha256 FROM media_assets WHERE id=$1', [newCover])).rows[0];
      assert.deepEqual(row, { user_id: null, source: 'case', status: 'ready', object_key: `cases/${newCover}/orig.png`, thumb_state: 'queued', width: 4, height: 3, sha256: 'abc' });
      assert.ok(r2.objects.has(`cases/${newCover}/orig.png`));
      assert.equal((await db.query('SELECT status FROM media_assets WHERE id=$1', [oldCover])).rows[0].status, 'deleted');
      assert.deepEqual((await auditRows('case.cover', id)).map((x) => x.details), [{ from_asset_id: oldCover, to_asset_id: newCover, source_asset_id: src }]);
      assert.equal((await call('admin', 'PUT', `/api/admin/cases/${id}/cover`, { asset_id: await upload('operator') })).json().error.code, 'asset_not_found', 'another admin\'s upload');
      const missing = await call('admin', 'PUT', `/api/admin/cases/${id}/cover`, { asset_id: await upload('admin', { put: false }) });
      assert.equal(missing.statusCode, 502); assert.equal(missing.json().error.code, 'storage_copy_failed');
      assert.equal((await db.query('SELECT cover_id FROM inspiration_cases WHERE id=$1', [id])).rows[0].cover_id, newCover, 'case unchanged');

      const [a, b, c] = [await upload('admin'), await upload('admin'), await upload('admin')];
      const first = (await call('admin', 'PUT', `/api/admin/cases/${id}/references`, { asset_ids: [a, b] })).json().references.map((x) => x.id);
      assert.equal(first.length, 2); assert.ok(!first.includes(a));
      const second = (await call('admin', 'PUT', `/api/admin/cases/${id}/references`, { asset_ids: [first[1], c] })).json().references.map((x) => x.id);
      assert.equal(second[0], first[1], 'existing case reference reused, not copied again');
      assert.equal((await db.query('SELECT status FROM media_assets WHERE id=$1', [first[0]])).rows[0].status, 'deleted');
      assert.equal((await call('admin', 'PUT', `/api/admin/cases/${id}/references`, { asset_ids: [c, c] })).json().error.code, 'duplicate_asset');
      assert.equal((await call('admin', 'PUT', `/api/admin/cases/${id}/references`, { asset_ids: Array.from({ length: 9 }, () => randomUUID()) })).json().error.code, 'invalid_asset_ids');
      assert.deepEqual((await auditRows('case.references', id)).map((x) => x.details), [{ count: 2 }, { count: 2 }]);
      // Deleting the admin's own upload leaves the case untouched.
      await call('admin', 'DELETE', `/api/me/assets/${src}`);
      assert.equal((await db.query('SELECT status FROM media_assets WHERE id=$1', [newCover])).rows[0].status, 'ready');
    });

    await t.test('delete: drafts only (never-public), hard delete + assets soft-deleted', async () => {
      const call = await makeApp();
      const published = await seedCase({ status: 'published' });
      assert.equal((await call('operator', 'DELETE', `/api/admin/cases/${published}`)).json().error.code, 'case_not_draft');
      await call('operator', 'PATCH', `/api/admin/cases/${published}`, { status: 'draft' });
      assert.equal((await call('operator', 'DELETE', `/api/admin/cases/${published}`)).json().error.code, 'case_not_draft', 'was public once');
      const draft = await seedCase({ title: '草稿' });
      const cover = (await db.query('SELECT cover_id FROM inspiration_cases WHERE id=$1', [draft])).rows[0].cover_id;
      assert.equal((await call('operator', 'DELETE', `/api/admin/cases/${draft}`)).statusCode, 204);
      assert.equal((await call('operator', 'GET', `/api/admin/cases/${draft}`)).statusCode, 404);
      assert.equal((await db.query('SELECT status FROM media_assets WHERE id=$1', [cover])).rows[0].status, 'deleted');
      assert.deepEqual((await auditRows('case.delete', draft)).map((x) => x.details), [{ title: '草稿' }]);
    });

    await t.test('users & roles: search, detail, grant/revoke rules, last admin, cache invalidation', async () => {
      const call = await makeApp();
      assert.equal((await call('viewer', 'GET', '/api/admin/users')).json().error.code, 'invalid_query');
      const found = (await call('viewer', 'GET', '/api/admin/users?q=target%40example.com')).json().items;
      assert.equal(found[0].id, U.target);
      const all = (await call('viewer', 'GET', '/api/admin/users?q=example.com&limit=3')).json();
      assert.equal(all.items.length, 3); assert.ok(all.next_cursor);
      const rest = (await call('viewer', 'GET', `/api/admin/users?q=example.com&limit=100&cursor=${all.next_cursor}`)).json();
      assert.equal(new Set([...all.items, ...rest.items].map((u) => u.id)).size, 8);
      assert.deepEqual((await call('viewer', 'GET', `/api/admin/users?q=${U.admin}`)).json().items.map((u) => [u.id, u.roles]), [[U.admin, ['admin']]]);

      await seedGeneration({ who: 'target', status: 'succeeded', charged: '6', age: '1 day' });
      const detail = (await call('viewer', 'GET', `/api/admin/users/${U.target}`)).json();
      assert.deepEqual(detail.wallet, { available_points: '0.00000000', frozen_points: '0.00000000' });
      assert.equal(detail.usage.last_30d.succeeded, 1); assert.equal(detail.usage.last_30d.charged_points, '6.00000000');
      assert.equal(detail.recent_generations.length, 1); assert.equal(detail.user.last_sign_in_at, null);
      await db.query("INSERT INTO app_settings(key,value) VALUES('lanehub_mode','on')");
      const lanehubDetail = (await call('viewer', 'GET', `/api/admin/users/${U.target}`)).json();
      assert.deepEqual([lanehubDetail.wallet, lanehubDetail.wallet_error], [null, 'lanehub_account_missing'], 'never provisions an account from the admin view');
      await db.query("DELETE FROM app_settings WHERE key='lanehub_mode'");
      assert.equal((await call('viewer', 'GET', `/api/admin/users/${randomUUID()}`)).json().error.code, 'user_not_found');

      assert.equal((await call('target', 'GET', '/api/admin/me')).statusCode, 403);
      const granted = await call('admin', 'PUT', `/api/admin/users/${U.target}/roles/operator`);
      assert.deepEqual(granted.json(), { roles: ['operator'] });
      assert.equal((await call('target', 'GET', '/api/admin/me')).statusCode, 200, 'role cache invalidated immediately');
      await call('admin', 'PUT', `/api/admin/users/${U.target}/roles/operator`);
      assert.equal((await auditRows('role.grant', U.target)).filter((r) => r.details.role === 'operator').length, 1, 'idempotent grant audits once');
      assert.equal((await call('admin', 'PUT', `/api/admin/users/${U.unverified}/roles/viewer`)).json().error.code, 'email_not_verified');
      assert.equal((await call('admin', 'PUT', `/api/admin/users/${U.target}/roles/root`)).json().error.code, 'invalid_role');
      const staff = (await call('viewer', 'GET', '/api/admin/roles')).json().items;
      assert.deepEqual(staff.find((s) => s.user.id === U.target).roles.map((r) => [r.role, r.granted_by.id]), [['operator', U.admin]]);

      const own = await call('admin', 'DELETE', `/api/admin/users/${U.admin}/roles/admin`);
      assert.equal(own.statusCode, 409); assert.equal(own.json().error.code, 'cannot_revoke_own_admin');
      assert.deepEqual((await call('admin', 'DELETE', `/api/admin/users/${U.expired}/roles/admin`)).json(), { roles: [] });
      assert.deepEqual((await call('admin', 'DELETE', `/api/admin/users/${U.expired}/roles/admin`)).json(), { roles: [] }, 'idempotent');
      assert.equal((await auditRows('role.revoke', U.expired)).length, 1);
      assert.equal((await call('admin', 'DELETE', `/api/admin/users/${U.admin2}/roles/admin`)).statusCode, 200);
      // Only one admin left: it cannot be removed by anyone (script path has no actor).
      await assert.rejects(() => revokeRole(db, U.admin, 'admin'), { code: 'last_admin' });
      const self = await call('admin', 'DELETE', `/api/admin/users/${U.admin}/roles/admin`);
      assert.equal(self.statusCode, 409);
      await grantRole(db, U.admin2, 'admin');
      const last = await call('admin2', 'DELETE', `/api/admin/users/${U.admin}/roles/admin`);
      assert.equal(last.statusCode, 200, 'two admins → one may remove the other');
      const lastOne = await Promise.all([revokeRole(db, U.admin2, 'admin').catch((e) => e.code)]);
      assert.deepEqual(lastOne, ['last_admin']);
      await grantRole(db, U.admin, 'admin'); await grantRole(db, U.expired, 'admin');
      assert.equal((await call('admin', 'DELETE', `/api/admin/users/${U.target}/roles/operator`)).statusCode, 200);
      assert.equal((await call('target', 'GET', '/api/admin/me')).statusCode, 403);
    });

    await t.test('generations: filters, cursor, detail, resync and cancel rules, audit, no money moved', async () => {
      const call = await makeApp();
      await db.query('DELETE FROM generation_records');
      const g = {
        a: await seedGeneration({ who: 'plain', status: 'succeeded', model: 'm-a', age: '10 minutes', taskStatus: 'completed', charged: '12.5' }),
        b: await seedGeneration({ who: 'plain', status: 'failed', model: 'm-b', age: '2 days', taskStatus: 'failed', deleted: true }),
        c: await seedGeneration({ who: 'target', status: 'running', model: 'm-a', kind: 'video', age: '3 hours' }),
        d: await seedGeneration({ who: 'target', status: 'queued', model: 'm-b', age: '40 days', taskStatus: 'submitted' }),
      };
      const ids = async (qs) => (await call('viewer', 'GET', '/api/admin/generations' + qs)).json().items.map((x) => x.id);
      assert.deepEqual(await ids(''), [g.a, g.c, g.b, g.d]);
      assert.deepEqual(await ids('?user=PLAIN@example.com'), [g.a, g.b], 'soft-deleted included');
      assert.deepEqual(await ids(`?user=${U.target}&model=m-a`), [g.c]);
      assert.deepEqual(await ids('?status=queued,running'), [g.c, g.d]);
      assert.deepEqual(await ids('?kind=video'), [g.c]);
      assert.deepEqual(await ids('?user=nobody@example.com'), []);
      const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
      const monthAgo = new Date(Date.now() - 30 * 86400_000).toISOString();
      assert.deepEqual(await ids(`?from=${monthAgo}&to=${today}`), [g.a, g.c, g.b]);
      assert.equal((await call('viewer', 'GET', '/api/admin/generations?status=done')).json().error.code, 'invalid_status');
      assert.equal((await call('viewer', 'GET', '/api/admin/generations?from=2026-09-18&to=2026-09-01')).json().error.code, 'invalid_date_range');
      const p1 = (await call('viewer', 'GET', '/api/admin/generations?limit=2')).json();
      const p2 = (await call('viewer', 'GET', `/api/admin/generations?limit=2&cursor=${p1.next_cursor}`)).json();
      assert.deepEqual([...p1.items, ...p2.items].map((x) => x.id), [g.a, g.c, g.b, g.d]); assert.equal(p2.next_cursor, null);
      assert.equal(p1.items[0].prompt.length, 200); assert.equal(p1.items[0].user.email, 'plain@example.com');

      await db.query(`UPDATE media_tasks SET result='{"error":{"message":"boom at https://r2.example/signed?X-Amz-Signature=abc key sk-abcdefghijkl"}}' WHERE id=(SELECT task_id FROM generation_records WHERE id=$1)`, [g.b]);
      const detail = (await call('viewer', 'GET', `/api/admin/generations/${g.b}`)).json();
      assert.equal(detail.failure_code, 'media_task_failed'); assert.equal(detail.failure_message, 'boom at [url] key [redacted]');
      assert.match(detail.upstream.task_id, /^task_/); assert.match(detail.upstream.request_id, /^lh-/); assert.equal(detail.upstream.provider, 'lanehub');
      assert.ok(detail.deleted_at); assert.equal(detail.prompt.length, 'prompt '.repeat(60).length);
      assert.equal((await call('viewer', 'GET', `/api/admin/generations/${randomUUID()}`)).json().error.code, 'generation_not_found');

      // resync
      assert.equal((await call('operator', 'POST', `/api/admin/generations/${g.b}/resync`, {})).json().error.code, 'generation_not_syncable');
      assert.equal((await call('operator', 'POST', `/api/admin/generations/${g.a}/resync`, {})).json().error.code, 'generation_not_syncable', 'succeeded and already charged');
      task.reply = () => new Response('down', { status: 503 });
      const down = await call('operator', 'POST', `/api/admin/generations/${g.c}/resync`, {});
      assert.equal(down.statusCode, 502); assert.equal(down.json().error.code, 'upstream_unavailable');
      await db.query("UPDATE media_tasks SET updated_at=now()-interval '1 hour'");
      task.reply = (path) => ({ data: { id: path.split('/').pop(), status: 'completed', result: { videos: [{ url: ['https://cdn.test/v.mp4'] }] } } }); // video task: succeeded needs a real video URL
      const synced = await call('operator', 'POST', `/api/admin/generations/${g.c}/resync`, {});
      assert.equal(synced.statusCode, 200, synced.body); assert.equal(synced.json().status, 'succeeded');
      assert.deepEqual((await auditRows('generation.resync', g.c)).map((x) => [x.details, x.actor_user_id]), [[{ status_before: 'running', status_after: 'succeeded' }, U.operator]]);
      // succeeded + charged_points NULL → lanehub charge backfill (same function as the background loop).
      const settleMe = await seedGeneration({ status: 'succeeded', taskStatus: 'completed', completed: true, age: '2 hours' });
      lane.reply = () => ({ data: [{ type: 2, quota: 50000 }] });
      const settled = (await call('operator', 'POST', `/api/admin/generations/${settleMe}/resync`, {})).json();
      assert.equal(settled.charged_points, '70.00000000'); assert.equal(settled.billing.state, 'charged');

      // cancel
      const young = await seedGeneration({ age: '30 minutes' });
      const tooYoung = await call('operator', 'POST', `/api/admin/generations/${young}/cancel`, { reason: '卡住' });
      assert.equal(tooYoung.statusCode, 409); assert.deepEqual(tooYoung.json().error, { code: 'generation_not_cancellable', message: 'generation_not_cancellable', reason: 'younger_than_2h' });
      assert.equal((await call('operator', 'POST', `/api/admin/generations/${g.b}/cancel`, { reason: 'x' })).json().error.reason, 'status_not_active');
      assert.equal((await call('operator', 'POST', `/api/admin/generations/${g.d}/cancel`, { reason: '' })).json().error.code, 'invalid_reason');
      const resolves = await call('operator', 'POST', `/api/admin/generations/${g.d}/cancel`, { reason: '卡住' });
      assert.equal(resolves.json().error.reason, 'resolved_by_resync', 'upstream finished during the pre-cancel resync');
      const stuck = await seedGeneration({ age: '5 hours' });
      task.reply = (path) => ({ data: { id: path.split('/').pop(), status: 'processing' } });
      const before = (await db.query('SELECT (SELECT count(*) FROM wallet_entries) AS w,(SELECT count(*) FROM request_billing) AS b,(SELECT count(*) FROM wallet_debits) AS d')).rows[0];
      const cancelled = await call('operator', 'POST', `/api/admin/generations/${stuck}/cancel`, { reason: '上游任务已丢失' });
      assert.equal(cancelled.statusCode, 200, cancelled.body);
      assert.deepEqual([cancelled.json().status, cancelled.json().failure_code, cancelled.json().charged_points], ['cancelled', 'admin_cancelled', null]);
      assert.deepEqual((await db.query('SELECT (SELECT count(*) FROM wallet_entries) AS w,(SELECT count(*) FROM request_billing) AS b,(SELECT count(*) FROM wallet_debits) AS d')).rows[0], before, 'no money moved');
      assert.deepEqual((await auditRows('generation.cancel', stuck)).map((x) => x.details), [{ from_status: 'running', reason: '上游任务已丢失' }]);
      // Upstream later succeeds: the record stays cancelled.
      task.reply = (path) => ({ data: { id: path.split('/').pop(), status: 'completed', result: {} } });
      await db.query("UPDATE media_tasks SET updated_at=now()-interval '1 hour'");
      await refreshMediaTask(db, upstream, (await db.query('SELECT task_id FROM generation_records WHERE id=$1', [stuck])).rows[0].task_id);
      assert.equal((await db.query('SELECT status FROM generation_records WHERE id=$1', [stuck])).rows[0].status, 'cancelled');
    });

    await t.test('audit: filters by actor, action prefix, target, date range; cursor; legacy events', async () => {
      const call = await makeApp();
      await db.query("INSERT INTO administrators(id,password_hash,username) VALUES(1,'x','legacy') ON CONFLICT DO NOTHING");
      await db.query("INSERT INTO audit_events(action,target_id,details,administrator_id) VALUES('voucher.code.revoke','v1','{}',1)");
      const items = async (qs) => (await call('viewer', 'GET', '/api/admin/audit' + qs)).json().items;
      const legacy = (await items('?target=v1'))[0];
      assert.deepEqual([legacy.actor, legacy.legacy_administrator_id], [null, 1]);
      const cases = await items('?action=case.*&limit=100');
      assert.ok(cases.length > 5 && cases.every((e) => e.action.startsWith('case.')));
      assert.ok((await items('?actor=operator@example.com&limit=100')).every((e) => e.actor.id === U.operator));
      assert.ok((await items(`?actor=${U.admin}&action=role.grant`)).every((e) => e.action === 'role.grant' && e.actor.email === 'admin@example.com'));
      assert.deepEqual(await items('?from=2020-01-01&to=2020-01-02'), []);
      assert.equal((await call('viewer', 'GET', '/api/admin/audit?action=DROP TABLE')).json().error.code, 'invalid_action');
      const page = (await call('viewer', 'GET', '/api/admin/audit?limit=2')).json();
      const next = (await call('viewer', 'GET', `/api/admin/audit?limit=2&cursor=${page.next_cursor}`)).json();
      assert.ok(next.items[0].id < page.items[1].id);
      assert.equal((await call('viewer', 'GET', '/api/admin/audit?cursor=abc')).json().error.code, 'invalid_cursor');
    });

    await t.test('write rate limit: 60/min per user', async () => {
      const call = await makeApp();
      let last;
      for (let i = 0; i < 61; i++) last = await call('operator', 'POST', '/api/admin/cases/bulk-status', { ids: ['missing'], status: 'draft' });
      assert.equal(last.statusCode, 429); assert.equal(last.json().error.code, 'rate_limited');
    });
  } finally {
    for (const app of apps) await app.close();
    await db.close();
    await setup.query(`DROP SCHEMA ${schema} CASCADE`);
    await setup.close();
  }
});
