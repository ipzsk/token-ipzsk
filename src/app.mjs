import {desktopReleaseRoutes} from './desktop-releases.mjs';
import {developerRoutes} from './developers.mjs';
import { pluginRoutes } from './plugins.mjs';
import { adminAccountRoutes } from './admin-accounts.mjs';
import { accountKeyRoutes } from './account-keys.mjs';
import { desktopRoutes } from './desktop.mjs';
import { billingRoutes } from './billing.mjs';
import { earningsRoutes } from './earnings.mjs';
import Fastify, { LogController } from 'fastify';
import { readFile } from 'node:fs/promises';
import { customerAuthRoutes, customerOrigin } from './customer-auth.mjs';
import { adminRoutes } from './admin.mjs';
import { voucherRoutes } from './vouchers.mjs';
import { gatewayRoutes } from './gateway.mjs';

export async function createApp(options) {
  const app = Fastify({ logger: options.logger ?? false, logController:new LogController({ disableRequestLogging:true }),
    bodyLimit:1_000_000, requestTimeout:30_000, trustProxy:options.trustProxy ?? ['127.0.0.1','::1'] });
  app.addHook('onRequest', async (_req, reply) => {
    reply.header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer')
      .header('X-Frame-Options','DENY').header('Cache-Control','no-store')
      .header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  });
  // Only the customer website can make credentialed browser requests. Admin stays same-origin.
  app.addHook('onRequest', async (req, reply) => {
    if (!/^\/api\/(auth\/|me\/|account\/)/.test(req.url)) return;
    reply.header('Vary', 'Origin');
    if (req.headers.origin === customerOrigin) {
      reply.header('Access-Control-Allow-Origin', customerOrigin)
        .header('Access-Control-Allow-Credentials', 'true');
      if (req.method === 'OPTIONS') return reply.code(204)
        .header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        .header('Access-Control-Allow-Headers', 'Content-Type').send();
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
    reply.code(status).send({ error:{ code, message:code } });
  });
  app.get('/healthz', async () => { await options.db.query('SELECT 1'); return { status:'ok' }; });
  app.get('/', async (_req, reply) => reply.redirect('/admin'));
  for (const [path, file, type] of [['/admin','index.html','text/html'],['/admin/','index.html','text/html'],
    ['/redeem','redeem.html','text/html'],['/redeem.js','redeem.js','text/javascript'],['/admin/pricing.html','pricing.html','text/html'],
    ['/admin/plugins.js','plugins.js','text/javascript'],['/admin/accounts.js','accounts.js','text/javascript'],['/admin/style.css','style.css','text/css'],['/admin/app.js','app.js','text/javascript'],['/admin/vouchers.js','vouchers.js','text/javascript']]) {
    const content = await readFile(new URL(`../public/${file}`,import.meta.url));
    app.get(path, async (_req, reply) => reply.type(type + '; charset=utf-8').send(content));
  }
  desktopReleaseRoutes(app,options);
  adminRoutes(app,options);
  gatewayRoutes(app,options);
  voucherRoutes(app,options);
  customerAuthRoutes(app,options);
  accountKeyRoutes(app,options);
  desktopRoutes(app,options);
  billingRoutes(app,options);
  earningsRoutes(app,options);
  adminAccountRoutes(app,options);
  pluginRoutes(app,options);
  developerRoutes(app,options);
  return app;
}
