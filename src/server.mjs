import { loadR2Storage } from './r2-storage.mjs';
import { syncImageArchives } from './image-archive.mjs';
import { syncMediaTasks } from './media-task-sync.mjs';
import { lookup } from 'node:dns/promises';
import { readFile } from 'node:fs/promises';
import { database, bootstrap } from './database.mjs';
import { Upstream } from './upstream.mjs';
import { Scheduler } from './scheduler.mjs';
import { createCustomerAuth } from './customer-auth.mjs';
import { loadMailer } from './email.mjs';
import { createImageCaptcha } from './captcha.mjs';
import { createApp } from './app.mjs';

const db = database({ host:process.env.PGHOST ?? 'db', port:Number(process.env.PGPORT ?? 5432),
  user:'gateway', database:'gateway', password:(await readFile(process.env.PGPASSWORD_FILE ?? '/run/secrets/db-password','utf8')).trim() });
const secretDir = process.env.UPSTREAM_SECRET_DIR ?? '/run/upstream';
const upstream = new Upstream(db,secretDir);
await db.migrate();
await bootstrap(db,upstream,{ secretDir,adminPasswordFile:process.env.ADMIN_PASSWORD_FILE ?? '/run/secrets/admin-password',
  initialModels:(process.env.INITIAL_MODELS ?? 'gpt-4o-mini').split(',').filter(Boolean) });
await db.recover();
await upstream.refresh();
const voucherKey=Buffer.from((await readFile('/run/secrets/voucher-encryption-key','utf8')).trim(),'base64url');
const origin=process.env.PUBLIC_ORIGIN ?? 'https://api.ipzsk.com';
const customerAuthSecret=(await readFile('/run/secrets/customer-auth-secret','utf8')).trim();
const customerAuth=createCustomerAuth({db,origin,secret:customerAuthSecret,
  mailer:await loadMailer('/run/mail/tencent-ses.json'),captcha:createImageCaptcha({db,secret:customerAuthSecret})});
await customerAuth.migrate();
let trustedProxyAddresses=new Set(['127.0.0.1','::1']);
async function refreshProxyAddresses(){
  const records=await lookup('caddy',{all:true}).catch(()=>[]);
  trustedProxyAddresses=new Set(['127.0.0.1','::1',...records.map(r=>r.address)]);
}
await refreshProxyAddresses();
const proxyTimer=setInterval(refreshProxyAddresses,60000);proxyTimer.unref();
const imageStorage = await loadR2Storage(process.env.R2_CONFIG_FILE);
const app = await createApp({ db,upstream,voucherKey,customerAuth,imageStorage,
  trustProxy:(address)=>trustedProxyAddresses.has(address.replace(/^::ffff:/,'')),scheduler:new Scheduler(),
  origin:process.env.PUBLIC_ORIGIN ?? 'https://api.ipzsk.com',secureCookies:true,
  logger:{ level:'warn', redact:['req.headers.authorization','req.headers.cookie','res.headers.set-cookie','password','key','token'] } });
const syncTimer = setInterval(() => upstream.refresh().catch(() => app.log.error('balance_refresh_failed')),120_000);
syncTimer.unref();
const syncCharges = () => upstream.syncTaskCharges().then(result => {
  if (result.failed) app.log.warn({failed:result.failed},'task_charge_sync_failed');
}).catch(() => app.log.error('task_charge_sync_failed'));
const chargeTimer = setInterval(syncCharges,120_000);
chargeTimer.unref();
let mediaPending;
const syncMedia = () => { if (!mediaPending) mediaPending=syncMediaTasks(db,upstream).finally(()=>{mediaPending=null;}).catch(()=>{}); };
const mediaTimer=setInterval(syncMedia,5000);mediaTimer.unref();syncMedia();
let archivePending;
const syncArchives = () => {
  if (!archivePending && imageStorage) archivePending = syncImageArchives(db,imageStorage)
    .catch(() => app.log.error('image_archive_sync_failed')).finally(() => { archivePending=null; });
};
const archiveTimer=setInterval(syncArchives,5000);archiveTimer.unref();syncArchives();
if (!imageStorage) app.log.warn('image_archive_disabled');
let stopping = false;
for (const event of ['SIGTERM','SIGINT']) process.on(event,async () => {
  if (stopping) return; stopping=true;
  clearInterval(archiveTimer);clearInterval(mediaTimer);clearInterval(syncTimer);clearInterval(proxyTimer);clearInterval(chargeTimer); upstream.close();
  await app.close(); await upstream.pending?.catch(() => {}); await upstream.taskChargesPending?.catch(() => {}); await mediaPending; await archivePending; await db.close();
});
await app.listen({ host:'0.0.0.0',port:3000 });
console.log('gateway_listening');
syncCharges();
