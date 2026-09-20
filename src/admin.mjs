import { issueKey } from './account-keys.mjs';
import { passwordHash } from './security.mjs';
import { randomUUID } from 'node:crypto';
import { hash, token, httpError, verifyPassword, sessionCookie, readSession, RateLimiter } from './security.mjs';
import * as v from './validation.mjs';
import { providerTypes, providerOptions } from './upstream.mjs';

// 渠道地址必须是 https 且不带查询串；扣费口径按 provider_type 走注册表，未登记的类型直接拒绝。
//
// 唯一的例外是**回环地址**：本机自检要能把 lanehub 起在 http://localhost:3000 上打一遍。
// 这个口子开得起——回环流量不出网卡，密钥不会在链路上裸奔；而没有这个口子的代价是
// 整条链路只能在生产上第一次跑通，而形状类的错（字段名、任务结构）恰恰只有真打才看得见。
// 明文 http 只放两类地址：回环（本机自检），以及 compose 内部网络里的 lanehub 服务名。
// 后者的流量走 docker 的 host-local 网桥，不出网卡，信任级别与回环相同；放开成任意
// http 主机就等于把上游密钥交给随便哪条明文链路。
const PLAIN_HTTP_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', 'lanehub']);
function baseUrl(value) {
  let url;
  try { url = new URL(v.text(value, 200)); } catch { throw httpError(400, 'invalid_base_url'); }
  const plainOk = url.protocol === 'http:' && PLAIN_HTTP_HOSTS.has(url.hostname);
  if ((url.protocol !== 'https:' && !plainOk) || url.search || url.hash || url.username || url.password) throw httpError(400, 'invalid_base_url');
  return (url.origin + url.pathname).replace(/\/+$/, '');
}
function providerType(value) {
  if (!providerTypes.includes(value)) throw httpError(400, 'invalid_provider_type');
  return value;
}

const fields = `r.id,r.user_id,u.name AS user_name,k.name AS key_name,r.model,r.status,r.usage_state,
  r.input_tokens,r.output_tokens,r.total_tokens,r.duration_ms,r.created_at,r.error_code,r.upstream_id,r.stream,r.cost_cny,r.cost_reference,r.cost_recorded_at,r.estimated_cost_cny,r.pricing_details,r.access_token_id,r.plugin_id,r.plugin_publisher_ref,
  (SELECT name FROM access_tokens WHERE id=r.access_token_id) AS access_token_name,
  (SELECT charged_cny FROM request_billing WHERE request_id=r.id) AS charged_cny,
  (SELECT state FROM request_billing WHERE request_id=r.id) AS billing_state`;
export async function listRequests(db, query, forcedUser, exportCsv = false) {
  const filter = v.requestFilter(query, forcedUser);
  const page = query.page ? v.integer(Number(query.page), 1, 100000) : 1;
  const count = await db.query(`SELECT count(*) FROM requests r ${filter.sql}`, filter.args);
  const limit = exportCsv ? 10000 : 30;
  const args = [...filter.args, limit, exportCsv ? 0 : (page - 1) * limit];
  const { rows } = await db.query(`SELECT ${fields} FROM requests r JOIN users u ON u.id=r.user_id
    LEFT JOIN upstream_keys k ON k.id=r.key_id ${filter.sql} ORDER BY r.created_at DESC,r.id
    LIMIT $${args.length - 1} OFFSET $${args.length}`, args);
  return { rows, count: Number(count.rows[0].count), page, page_size: limit };
}
const audit = (db, action, id) => db.query('INSERT INTO audit_events (action,target_id) VALUES ($1,$2)', [action, id]);
const requiredRow = (result) => { if (!result.rowCount) throw httpError(404, 'not_found'); return result.rows[0]; };

export function adminRoutes(app, { db, upstream, scheduler, origin, secureCookies }) {
  const loginLimit = new RateLimiter();
  const adminLimit = new RateLimiter();
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/admin/api/')) return;
    if (!req.routeOptions.url) throw httpError(404,'not_found');
    if (!['GET','HEAD'].includes(req.method) && req.headers.origin !== origin) throw httpError(403, 'origin_denied');
    if (req.routeOptions.url === '/admin/api/login') {
      loginLimit.take('global', 30);
      loginLimit.take(req.ip, 8, 600_000);
      return;
    }
    const session = readSession(req.headers.cookie);
    if (!session || session.length > 100) throw httpError(401, 'admin_login_required');
    const result = await db.query('SELECT s.token_hash,a.id,a.username,a.role FROM admin_sessions s JOIN administrators a ON a.id=s.administrator_id WHERE s.token_hash=$1 AND s.expires_at>now() AND a.enabled', [hash(session)]);
    if (!result.rowCount) throw httpError(401, 'admin_login_required');
    req.administrator=result.rows[0];
    const route=req.routeOptions.url;
    const roleScoped=/^\/admin\/api\/(?:developers|plugins|plugin-usage|plugin-skills|skill-sightings|settlements|wallet|ledger|overview|requests|audit)(?:[/?]|$)/.test(route);
    const sensitive=roleScoped||route.startsWith('/admin/api/administrators')||route.startsWith('/admin/api/billing')||route.includes('/export')||route.endsWith('/charge');
    if(req.administrator.role!=='superadmin' && (sensitive || (req.administrator.role==='viewer'&&!['GET','HEAD'].includes(req.method)&&!['/admin/api/logout','/admin/api/password'].includes(route))))throw httpError(403,'admin_permission_denied');
    adminLimit.take(result.rows[0].token_hash, 180);
    reply.header('Cache-Control', 'no-store');
  });
  app.addHook('onResponse',async (req,reply)=>{
    if(req.administrator&&!['GET','HEAD'].includes(req.method)&&req.raw.url.startsWith('/admin/api/'))
      await db.query('INSERT INTO audit_events(action,target_id,administrator_id,details) VALUES($1,$2,$3,$4)',
        ['admin.operation',req.params?.id??null,req.administrator.id,JSON.stringify({method:req.method,route:req.routeOptions.url,status:reply.statusCode})]);
  });
  app.post('/admin/api/login', async (req, reply) => {
    const password = v.text(req.body?.password, 256);
    const row = (await db.query('SELECT id,password_hash FROM administrators WHERE username=$1 AND enabled', [v.text(req.body?.username??'admin',100)])).rows[0];
    if (!row || !await verifyPassword(password, row.password_hash)) throw httpError(401, 'invalid_password');
    const session = token();
    await db.tx(async (c) => {
      await c.query('DELETE FROM admin_sessions WHERE expires_at<now()');
      await c.query("INSERT INTO admin_sessions(token_hash,expires_at,administrator_id) VALUES ($1,now()+interval '12 hours',$2)", [hash(session),row.id]);
      await audit(c, 'admin.login', null);
    });
    reply.header('Set-Cookie', sessionCookie(session, 43200, secureCookies));
    return { ok: true };
  });
  app.get('/admin/api/session', async req => ({username:req.administrator.username,role:req.administrator.role,id:req.administrator.id}));
  app.post('/admin/api/logout', async (req, reply) => {
    await db.query('DELETE FROM admin_sessions WHERE token_hash=$1', [hash(readSession(req.headers.cookie))]);
    reply.header('Set-Cookie', sessionCookie('', 0, secureCookies));
    return { ok: true };
  });
  app.get('/admin/api/overview', async () => {
    const today = "(date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')";
    const [keys, accounts, requests, chart, recent] = await Promise.all([
      db.query(`SELECT count(*) AS total,count(*) FILTER(WHERE enabled) AS enabled,
        count(*) FILTER(WHERE balance_error IS NOT NULL OR last_error IS NOT NULL) AS errors FROM upstream_keys`),
      db.query(`SELECT sum(balance) FILTER(WHERE balance_at>now()-interval '10 minutes' AND balance_error IS NULL) AS balance,
        sum(remain_credits) FILTER(WHERE balance_at>now()-interval '10 minutes' AND balance_error IS NULL) AS remain_credits,
        count(*) AS total,count(*) FILTER(WHERE remain_credits IS NULL OR balance_at IS NULL OR balance_at<=now()-interval '10 minutes' OR balance_error IS NOT NULL) AS stale FROM upstream_accounts WHERE enabled`),
      db.query(`SELECT count(*) AS total,count(*) FILTER(WHERE created_at>=${today}) AS today,
        coalesce(sum(total_tokens) FILTER(WHERE created_at>=${today}),0) AS today_tokens,
        coalesce(sum(input_tokens) FILTER(WHERE created_at>=${today}),0) AS today_input,
        coalesce(sum(output_tokens) FILTER(WHERE created_at>=${today}),0) AS today_output,
        count(*) FILTER(WHERE created_at>=${today} AND status='failed') AS today_failed,
        count(*) FILTER(WHERE created_at>=${today} AND status='succeeded') AS today_success,
        count(*) FILTER(WHERE usage_state='unknown') AS unknown,
        round(avg(duration_ms) FILTER(WHERE created_at>=${today} AND status='succeeded')) AS avg_ms FROM requests`),
      db.query(`SELECT to_char(created_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS day,
        coalesce(sum(total_tokens),0) AS tokens FROM requests WHERE created_at>=${today}-interval '6 days'
        GROUP BY 1 ORDER BY 1`),
      listRequests(db, {}),
    ]);
    return { keys: keys.rows[0], accounts: accounts.rows[0], requests: requests.rows[0],
      chart: chart.rows, recent: recent.rows.slice(0, 5), queue: scheduler.waiting,
      active: [...scheduler.accounts.values()].reduce((a,b) => a+b,0), updated_at: new Date().toISOString() };
  });
  // 下拉选项由注册表直接吐出，前端不再维护第二份名单。
  app.get('/admin/api/accounts', async () => ({ provider_types: providerOptions, rows: (await db.query(`SELECT a.*,
    (SELECT count(*) FROM upstream_keys k WHERE k.account_id=a.id) AS key_count FROM upstream_accounts a ORDER BY created_at`)).rows
    .map((a) => ({ ...a, active: scheduler.accounts.get(a.id) ?? 0 })) }));
  app.post('/admin/api/accounts', async (req) => {
    const id = randomUUID(), name = v.text(req.body?.name), concurrency = v.integer(req.body?.concurrency ?? 3, 1, 50);
    const base = baseUrl(req.body?.base_url ?? 'https://api.apimart.ai'), provider = providerType(req.body?.provider_type ?? 'apimart');
    await db.tx(async (c) => {
      await c.query('INSERT INTO upstream_accounts (id,name,concurrency,base_url,provider_type) VALUES ($1,$2,$3,$4,$5)', [id, name, concurrency, base, provider]);
      await audit(c, 'account.create', id);
    });
    return { id };
  });
  app.patch('/admin/api/accounts/:id', async (req) => {
    const id = v.uuid(req.params.id);
    const row = requiredRow(await db.query('SELECT * FROM upstream_accounts WHERE id=$1', [id]));
    const b = req.body ?? {};
    await db.tx(async (c) => {
      await c.query('UPDATE upstream_accounts SET name=$2,enabled=$3,concurrency=$4,base_url=$5,provider_type=$6 WHERE id=$1',
        [id, b.name === undefined ? row.name : v.text(b.name), b.enabled === undefined ? row.enabled : v.bool(b.enabled),
          b.concurrency === undefined ? row.concurrency : v.integer(b.concurrency,1,50),
          b.base_url === undefined ? row.base_url : baseUrl(b.base_url), b.provider_type === undefined ? row.provider_type : providerType(b.provider_type)]);
      await audit(c, 'account.update', id);
    });
    upstream.refreshSoon(); return { ok: true };
  });
  app.get('/admin/api/keys', async () => ({ rows: (await db.query(`SELECT k.id,k.account_id,k.name,k.suffix,k.enabled,
    k.models,k.concurrency,k.balance,k.used_balance,k.remain_credits,k.used_credits,k.unlimited,k.balance_at,k.balance_error,k.last_error,
    k.cooldown_until,k.created_at,a.name AS account_name FROM upstream_keys k
    JOIN upstream_accounts a ON a.id=k.account_id ORDER BY k.created_at`)).rows.map((k) => ({ ...k, active: scheduler.keys.get(k.id) ?? 0 })) }));
  app.post('/admin/api/keys', async (req) => {
    const b = req.body ?? {}, account_id = v.uuid(b.account_id);
    requiredRow(await db.query('SELECT id FROM upstream_accounts WHERE id=$1', [account_id]));
    const id = await upstream.addKey({ account_id, name: v.text(b.name), key: v.text(b.key, 243),
      concurrency: v.integer(b.concurrency ?? 3,1,50), models: v.models(b.models) });
    await audit(db, 'key.create', id); upstream.refreshSoon(); return { id };
  });
  app.patch('/admin/api/keys/:id', async (req) => {
    const id = v.uuid(req.params.id), b = req.body ?? {};
    const row = requiredRow(await db.query('SELECT * FROM upstream_keys WHERE id=$1', [id]));
    await db.tx(async (c) => {
      await c.query('UPDATE upstream_keys SET name=$2,enabled=$3,concurrency=$4,models=$5 WHERE id=$1',
        [id, b.name === undefined ? row.name : v.text(b.name), b.enabled === undefined ? row.enabled : v.bool(b.enabled),
          b.concurrency === undefined ? row.concurrency : v.integer(b.concurrency,1,50), b.models === undefined ? row.models : v.models(b.models)]);
      await audit(c, 'key.update', id);
    });
    upstream.refreshSoon(); return { ok: true };
  });
  app.post('/admin/api/balances/refresh', async () => {
    adminLimit.take('balance-refresh', 6);
    upstream.refresh().catch(() => app.log.error('balance_refresh_failed'));
    return { ok: true, status: 'refreshing' };
  });
  app.get('/admin/api/customers/summary',async()=>{
    return (await db.query(`SELECT count(*) FILTER(WHERE auth_user_id IS NOT NULL AND email_verified) AS registered,
      count(*) FILTER(WHERE auth_user_id IS NOT NULL AND email_verified AND created_at>=(date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')) AS today_registered,
      count(*) FILTER(WHERE auth_user_id IS NOT NULL AND email_verified AND enabled) AS enabled_registered,
      count(*) FILTER(WHERE auth_user_id IS NULL) AS manual_users FROM users`)).rows[0];
  });
  app.get('/admin/api/users', async () => ({ rows: (await db.query(`SELECT u.*,
    (SELECT coalesce(sum(amount_cny),0) FROM wallet_entries w WHERE w.user_id=u.id)-(SELECT coalesce(sum(amount_cny),0) FROM wallet_debits w WHERE w.user_id=u.id) AS wallet_balance_cny,
    (SELECT count(*) FROM access_tokens t WHERE t.user_id=u.id AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())) AS access_key_count,
    (SELECT prefix FROM access_tokens t WHERE t.user_id=u.id AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1) AS token_prefix,
    (SELECT coalesce(sum(total_tokens),0) FROM requests r WHERE r.user_id=u.id) AS total_tokens,
    (SELECT count(*) FROM requests r WHERE r.user_id=u.id) AS request_count,
    (SELECT max(created_at) FROM requests r WHERE r.user_id=u.id) AS last_request_at
    FROM users u ORDER BY created_at DESC LIMIT 1000`)).rows }));
  async function issue(c,userId){return (await issueKey(c,userId)).token;}
  app.post('/admin/api/users', async (req) => {
    const id = randomUUID(), b = req.body ?? {}, name = v.text(b.name), rpm = v.integer(b.rpm ?? 30,1,600);
    return db.tx(async (c) => {
      await c.query('INSERT INTO users (id,name,rpm) VALUES ($1,$2,$3)', [id,name,rpm]);
      const value = await issue(c, id); await audit(c,'user.create',id); return { id, token: value };
    });
  });
  app.patch('/admin/api/users/:id', async (req) => {
    const id = v.uuid(req.params.id), b = req.body ?? {};
    const row = requiredRow(await db.query('SELECT * FROM users WHERE id=$1', [id]));
    await db.tx(async (c) => {
      await c.query('UPDATE users SET name=$2,enabled=$3,rpm=$4 WHERE id=$1',
        [id,b.name === undefined ? row.name : v.text(b.name),b.enabled === undefined ? row.enabled : v.bool(b.enabled),
          b.rpm === undefined ? row.rpm : v.integer(b.rpm,1,600)]);
      await audit(c,'user.update',id);
    }); return { ok: true };
  });
  app.post('/admin/api/users/:id/token', async (req) => {
    const id = v.uuid(req.params.id);
    return db.tx(async (c) => {
      requiredRow(await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [id]));
      const value = await issue(c,id); await audit(c,'user.rotate_token',id); return { token: value };
    });
  });
  app.get('/admin/api/requests', (req) => listRequests(db, req.query));
  app.get('/admin/api/requests/export', async (req, reply) => {
    const data = await listRequests(db, req.query, null, true);
    const columns = ['id','user_name','key_name','model','status','usage_state','input_tokens','output_tokens','total_tokens','cost_cny','estimated_cost_cny','charged_cny','billing_state','access_token_name','access_token_id','plugin_id','plugin_publisher_ref','pricing_details','cost_reference','cost_recorded_at','duration_ms','created_at'];
    const cell = (value) => {
      let s = value instanceof Date ? value.toISOString() : value&&typeof value==='object'?JSON.stringify(value):String(value ?? '');
      if (/^[\s]*[=+@-]/.test(s)) s = "'" + s;
      return '"' + s.replaceAll('"','""') + '"';
    };
    reply.header('Content-Disposition','attachment; filename="api-requests.csv"').type('text/csv; charset=utf-8');
    return '\uFEFF' + [columns.map(cell).join(','), ...data.rows.map((r) => columns.map((k) => cell(r[k])).join(','))].join('\r\n');
  });
  app.patch('/admin/api/requests/:id/charge', async (req) => {
    const id=v.uuid(req.params.id), amount=req.body?.cost_cny;
    if (typeof amount !== 'string' || !/^(?:0|[1-9]\d{0,8})(?:\.\d{1,8})?$/.test(amount)) throw httpError(400,'invalid_charge');
    const reference=v.text(req.body?.cost_reference,500);
    await db.tx(async (c) => {
      const old=requiredRow(await c.query('SELECT cost_cny,cost_reference,status,key_id FROM requests WHERE id=$1 FOR UPDATE',[id]));
      if (['queued','running'].includes(old.status) || !old.key_id) throw httpError(409,'charge_not_ready');
      await c.query('UPDATE requests SET cost_cny=$2,cost_reference=$3,cost_recorded_at=now() WHERE id=$1',[id,amount,reference]);
      await c.query('INSERT INTO audit_events (action,target_id,details) VALUES ($1,$2,$3)',
        ['request.charge.confirm',id,JSON.stringify({administrator_id:req.administrator.id,currency:'CNY',source:'manual_apimart_bill',
          previous:{cost_cny:old.cost_cny,cost_reference:old.cost_reference},next:{cost_cny:amount,cost_reference:reference}})]);
    });
    return {ok:true};
  });
  app.get('/admin/api/requests/:id', async (req) => {
    const id = v.uuid(req.params.id);
    const request = requiredRow(await db.query(`SELECT ${fields} FROM requests r JOIN users u ON u.id=r.user_id
      LEFT JOIN upstream_keys k ON k.id=r.key_id WHERE r.id=$1`, [id]));
    const attempts = (await db.query(`SELECT a.id,k.name AS key_name,a.upstream_id,a.http_status,a.error_code,a.usage,
      a.started_at,a.completed_at FROM request_attempts a JOIN upstream_keys k ON k.id=a.key_id WHERE request_id=$1 ORDER BY started_at`, [id])).rows;
    return { request, attempts };
  });
}
