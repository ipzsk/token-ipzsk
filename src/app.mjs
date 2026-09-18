import { workspaceRoutes } from './workspace.mjs';
import { imageArchiveRoutes } from './image-archive.mjs';
import {desktopReleaseRoutes, desktopDownloadRoutes} from './desktop-releases.mjs';
import {developerRoutes} from './developers.mjs';
import { pluginRoutes } from './plugins.mjs';
import { adminAccountRoutes } from './admin-accounts.mjs';
import { accountKeyRoutes } from './account-keys.mjs';
import { desktopRoutes } from './desktop.mjs';
import { billingRoutes } from './billing.mjs';
import { earningsRoutes } from './earnings.mjs';
import Fastify, { LogController } from 'fastify';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { httpError } from './security.mjs';
import { customerAuthRoutes, customerOrigin } from './customer-auth.mjs';
import { adminRoutes } from './admin.mjs';
import { voucherRoutes } from './vouchers.mjs';
import { gatewayRoutes } from './gateway.mjs';
import { roleRoutes } from './roles.mjs';
import { uploadRoutes } from './uploads.mjs';
import { studioRoutes, avatarListCacheAge } from './studio.mjs';
import { libraryRoutes } from './library.mjs';
import { caseRoutes } from './cases.mjs';
import { adminStudioRoutes } from './admin-studio.mjs';
import { adminOpsRoutes } from './admin-ops.mjs';

export async function createApp(options) {
  const app = Fastify({ logger: options.logger ?? false, logController:new LogController({ disableRequestLogging:true }),
    bodyLimit:1_000_000, requestTimeout:30_000, trustProxy:options.trustProxy ?? ['127.0.0.1','::1'] });
  if (options.onRoute) app.addHook('onRoute', options.onRoute); // scripts/export-contracts.mjs 收集路由清单
  app.addHook('onRequest', async (_req, reply) => {
    reply.header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer')
      .header('X-Frame-Options','DENY').header('Cache-Control','no-store')
      .header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  });
  // Only the customer website can make credentialed browser requests. Admin stays same-origin.
  app.addHook('onRequest', async (req, reply) => {
    if (!/^\/api\/(auth|me|account|public|admin)\//.test(req.url)) return;
    reply.header('Vary', 'Origin');
    if (req.headers.origin === customerOrigin) {
      reply.header('Access-Control-Allow-Origin', customerOrigin)
        .header('Access-Control-Allow-Credentials', 'true');
      if (req.method === 'OPTIONS') return reply.code(204)
        .header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
        .header('Access-Control-Allow-Headers', 'Content-Type, Idempotency-Key').send();
    } else if (req.method === 'OPTIONS') return reply.code(403).send();
  });
  app.options('/api/*', async (_req, reply) => reply.code(403).send());
  app.get('/account', async (_req, reply) => reply.redirect(customerOrigin + '/account'));
  app.setErrorHandler((error, req, reply) => {
    if (reply.raw.headersSent) { reply.raw.destroy(); return; }
    const dbConflict = error.code === '23505';
    const status = dbConflict ? 409 : (error.statusCode >= 400 && error.statusCode <= 599 ? error.statusCode : 500);
    // Never return SQL details, upstream credentials, request bodies, or headers.
    const code = dbConflict ? 'already_exists' : (error.statusCode && error.code ? error.code : (status < 500 ? 'invalid_request' : 'internal_error'));
    if (status === 500) app.log.error({ request_id:req.id },'request_failed');
    const messages={insufficient_balance:'点数不足，请先使用充值码充值后再使用。',billing_unavailable:'计费服务暂不可用，请稍后重试。',billing_requires_priced_text_and_output_limit:'此模型或服务尚未配置可靠价格，暂不可用。',unpriced_image_options:'此图片规格暂未开放计费。'};
    reply.code(status).send({ error:{ code, message:messages[code]??code, ...(error.statusCode && error.fields ? error.fields : {}) } });
  });
  app.get('/healthz', async () => { await options.db.query('SELECT 1'); return { status:'ok' }; });
  // 运维详情：只给本机（容器内 node -e fetch）或带 HEALTH_DETAILS_TOKEN 的请求；只有计数与年龄，没有密钥、没有用户数据。
  // req.ip 经 trustProxy 解析：经 Caddy 转发的公网请求拿到的是客户端地址，不会是 127.0.0.1。
  app.get('/healthz/details', async (req) => {
    const given = Buffer.from(String(req.headers.authorization ?? '')), want = Buffer.from('Bearer ' + (options.healthToken ?? ''));
    const tokenOk = Boolean(options.healthToken) && given.length === want.length && timingSafeEqual(given, want);
    if (!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.ip) && !tokenOk) throw httpError(404,'not_found');
    const { db, imageStorage, lanehubCatalog } = options;
    const thumbs = Object.fromEntries((await db.query(`SELECT thumb_state,count(*)::int AS n FROM media_assets
      WHERE thumb_state IN ('queued','running','failed') GROUP BY thumb_state`)).rows.map((r) => [r.thumb_state, r.n]));
    const archives = Object.fromEntries((await db.query(`SELECT state,count(*)::int AS n FROM image_archives
      WHERE state IN ('pending','failed') GROUP BY state`)).rows.map((r) => [r.state, r.n]));
    const age = (at) => (at ? Math.round((Date.now() - at.getTime()) / 1000) : null);
    return { status:'ok', r2_configured:Boolean(imageStorage),
      thumb_queue:{ queued:thumbs.queued ?? 0, running:thumbs.running ?? 0, failed:thumbs.failed ?? 0 },
      archive_queue:{ pending:archives.pending ?? 0, failed:archives.failed ?? 0 },
      lanehub_catalog:lanehubCatalog ? { age_seconds:age(lanehubCatalog.fetchedAt), last_refresh_failed:Boolean(lanehubCatalog.lastError) } : null,
      avatar_list_cache_age_seconds:avatarListCacheAge(lanehubCatalog) };
  });
  app.get('/', async (_req, reply) => reply.redirect('/admin'));
  for (const [path, file, type] of [['/admin','index.html','text/html'],['/admin/','index.html','text/html'],
    ['/redeem','redeem.html','text/html'],['/redeem.js','redeem.js','text/javascript'],['/admin/pricing.html','pricing.html','text/html'],
    ['/admin/plugins.js','plugins.js','text/javascript'],['/admin/accounts.js','accounts.js','text/javascript'],['/admin/style.css','style.css','text/css'],['/admin/app.js','app.js','text/javascript'],['/admin/vouchers.js','vouchers.js','text/javascript']]) {
    const content = await readFile(new URL(`../public/${file}`,import.meta.url));
    app.get(path, async (_req, reply) => reply.type(type + '; charset=utf-8').send(content));
  }
  desktopReleaseRoutes(app,options);
  desktopDownloadRoutes(app,options);
  adminRoutes(app,options);
  gatewayRoutes(app,options);
  imageArchiveRoutes(app,options);
  workspaceRoutes(app,options);
  voucherRoutes(app,options);
  customerAuthRoutes(app,options);
  accountKeyRoutes(app,options);
  desktopRoutes(app,options);
  billingRoutes(app,options);
  earningsRoutes(app,options);
  adminAccountRoutes(app,options);
  pluginRoutes(app,options);
  developerRoutes(app,options);
  roleRoutes(app,options);
  uploadRoutes(app,options);
  studioRoutes(app,options);
  libraryRoutes(app,options);
  caseRoutes(app,options);
  adminStudioRoutes(app,options);
  adminOpsRoutes(app,options);
  return app;
}
