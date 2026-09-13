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
import { Lanehub } from './lanehub.mjs';
import { reconcileLanehubCharges, reconcileLanehubTopups } from './lanehub-charges.mjs';
import { provisionIfEnabled } from './lanehub.mjs';

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
// lanehub 客户端只在配好时才建：没配就是没开这条路，createApp 里那个 `Boolean(lanehub)`
// 会把整条分支关掉——不会出现「开关是 on 但没有客户端」的半开状态。
// 管理令牌优先从文件读：这台机器上别的密钥（数据库口令、管理员口令）都走
// *_FILE，权限 600、不进 compose.yaml，这一个不该例外。
const lanehubAdminToken = process.env.LANEHUB_ADMIN_TOKEN
  ?? (process.env.LANEHUB_ADMIN_TOKEN_FILE
    ? (await readFile(process.env.LANEHUB_ADMIN_TOKEN_FILE, 'utf8')).trim()
    : undefined);
const lanehub = process.env.LANEHUB_BASE_URL && lanehubAdminToken
  ? new Lanehub({ baseUrl:process.env.LANEHUB_BASE_URL, adminToken:lanehubAdminToken })
  : null;

const lanehubUsdCny=Number(process.env.LANEHUB_USD_CNY ?? 0);
const lanehubQuotaPerUnit=Number(process.env.LANEHUB_QUOTA_PER_UNIT ?? 500000);
const appOptions = { db,upstream,voucherKey,customerAuth,
  lanehub,lanehubAccountId:process.env.LANEHUB_ACCOUNT_ID ?? null,
  // 新人额度：默认 ¥5。折算汇率显式给，不从对面实时取——同一批新用户按不同汇率
  // 折算会让「都送了 5 块」变成各自不同的积分。
  lanehubSignupCny:Number(process.env.LANEHUB_SIGNUP_CNY ?? 5),
  lanehubUsdCny,lanehubQuotaPerUnit,
  trustProxy:(address)=>trustedProxyAddresses.has(address.replace(/^::ffff:/,'')),scheduler:new Scheduler(),
  origin:process.env.PUBLIC_ORIGIN ?? 'https://api.ipzsk.com',secureCookies:true,
  logger:{ level:'warn', redact:['req.headers.authorization','req.headers.cookie','res.headers.set-cookie','password','key','token'] } };
const app = await createApp(appOptions);
const syncTimer = setInterval(() => upstream.refresh().catch(() => app.log.error('balance_refresh_failed')),120_000);
syncTimer.unref();
const syncCharges = () => upstream.syncTaskCharges().then(result => {
  if (result.failed) app.log.warn({failed:result.failed},'task_charge_sync_failed');
}).catch(() => app.log.error('task_charge_sync_failed'))
  // lanehub 模式下这一侧不扣钱，但「这单收了多少」必须回来——插件作者的分成读的就是它。
  .then(async () => {
    if (!lanehub || !(lanehubUsdCny>0)) return;
    const charges = await reconcileLanehubCharges(db,lanehub,{usdCnyRate:lanehubUsdCny,quotaPerUnit:lanehubQuotaPerUnit});
    if (charges.failed) app.log.warn({failed:charges.failed},'lanehub_charge_sync_failed');
    // 充值补账：兑换当场那次调用失败时，这里是唯一的补救。
    const topups = await reconcileLanehubTopups(db,lanehub,{usdCnyRate:lanehubUsdCny,quotaPerUnit:lanehubQuotaPerUnit},
      (user) => provisionIfEnabled(db,appOptions,user));
    if (topups.failed) app.log.warn({failed:topups.failed},'lanehub_topup_sync_failed');
  }).catch(() => app.log.error('lanehub_charge_sync_failed'));
const chargeTimer = setInterval(syncCharges,120_000);
chargeTimer.unref();
let mediaPending;
const syncMedia = () => { if (!mediaPending) mediaPending=syncMediaTasks(db,upstream).finally(()=>{mediaPending=null;}).catch(()=>{}); };
const mediaTimer=setInterval(syncMedia,5000);mediaTimer.unref();syncMedia();
let stopping = false;
for (const event of ['SIGTERM','SIGINT']) process.on(event,async () => {
  if (stopping) return; stopping=true;
  clearInterval(mediaTimer);clearInterval(syncTimer);clearInterval(proxyTimer);clearInterval(chargeTimer); upstream.close();
  await app.close(); await upstream.pending?.catch(() => {}); await upstream.taskChargesPending?.catch(() => {}); await mediaPending; await db.close();
});
await app.listen({ host:'0.0.0.0',port:3000 });
console.log('gateway_listening');
syncCharges();
