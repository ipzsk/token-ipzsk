import { syncMediaTasks } from './media-task-sync.mjs';
import { lookup } from 'node:dns/promises';
import { readFile } from 'node:fs/promises';
import { databaseFromEnv, bootstrap } from './database.mjs';
import { Upstream } from './upstream.mjs';
import { Scheduler } from './scheduler.mjs';
import { createCustomerAuth, SIGNUP_BONUS_CNY } from './customer-auth.mjs';
import { loadMailer } from './email.mjs';
import { createImageCaptcha } from './captcha.mjs';
import { createApp } from './app.mjs';
import { Lanehub, adminTokenFromEnv } from './lanehub.mjs';
import { LanehubCatalog } from './lanehub-catalog.mjs';
import { loadR2Storage } from './r2-storage.mjs';
import { syncImageArchives } from './image-archive.mjs';
import { cleanupMedia } from './uploads.mjs';
import { drainThumbJobs, thumbConcurrency, thumbPriority } from './media-thumbs.mjs';
import { warmAvatarLists } from './studio.mjs';
import { reconcileLanehubCharges } from './lanehub-charges.mjs';
import { reconcileCommissions, deliverConversions } from './commissions.mjs';
import { loadWaffo } from './waffo.mjs';
import { deliverPayments } from './payments.mjs';
import { finalizeAdjustments } from './lanehub-adjustments.mjs';

const db = await databaseFromEnv();
const secretDir = process.env.UPSTREAM_SECRET_DIR ?? '/run/upstream';
const upstream = new Upstream(db,secretDir);
await db.migrate();
await bootstrap(db,upstream,{ secretDir,adminPasswordFile:process.env.ADMIN_PASSWORD_FILE ?? '/run/secrets/admin-password',
  initialModels:(process.env.INITIAL_MODELS ?? 'gpt-4o-mini').split(',').filter(Boolean) });
await db.recover();
await upstream.refresh();
const origin=process.env.PUBLIC_ORIGIN ?? 'https://api.ipzsk.com';
// lanehub 客户端要在建 customerAuth **之前**备好：新人赠额发在谁那边，取决于这条链路是否真的接上。
// 只配了地址、没配管理令牌是配置错误，不能静默降级成「本地也不发」——那会让每个新用户
// 既拿不到对面的额度、也拿不到本地的（localSignupBonus 会跟着变成 false）。
// 管理令牌优先从文件读：这台机器上别的密钥（数据库口令、管理员口令）都走 *_FILE，
// 权限 600、不进 compose.yaml，这一个不该例外。
const lanehubAdminToken = await adminTokenFromEnv();
if (process.env.LANEHUB_BASE_URL && !lanehubAdminToken) throw new Error('lanehub_admin_token_required');
// lanehub 客户端只在配好时才建：没配就是没开这条路，createApp 里那个 `Boolean(lanehub)`
// 会把整条分支关掉——不会出现「开关是 on 但没有客户端」的半开状态。
const lanehub = process.env.LANEHUB_BASE_URL
  ? new Lanehub({ baseUrl:process.env.LANEHUB_BASE_URL, adminToken:lanehubAdminToken })
  : null;
const customerAuthSecret=(await readFile('/run/secrets/customer-auth-secret','utf8')).trim();
const customerAuth=createCustomerAuth({db,origin,secret:customerAuthSecret,
  // 接了 lanehub 时新人赠额由对面发（provisionCustomer），本地不再发，否则一个新用户拿两份。
  // 判据是**客户端是否真的建起来**，不是环境变量有没有填。
  localSignupBonus:!lanehub,
  mailer:await loadMailer('/run/mail/tencent-ses.json'),captcha:createImageCaptcha({db,secret:customerAuthSecret})});
await customerAuth.migrate();
let trustedProxyAddresses=new Set(['127.0.0.1','::1']);
async function refreshProxyAddresses(){
  const records=await lookup('caddy',{all:true}).catch(()=>[]);
  trustedProxyAddresses=new Set(['127.0.0.1','::1',...records.map(r=>r.address)]);
}
await refreshProxyAddresses();
const proxyTimer=setInterval(refreshProxyAddresses,60000);proxyTimer.unref();

const lanehubUsdCny=Number(process.env.LANEHUB_USD_CNY ?? 0);
const lanehubQuotaPerUnit=Number(process.env.LANEHUB_QUOTA_PER_UNIT ?? 500000);
// 型号目录跟着 lanehub 走：启动拉一次，之后每 10 分钟刷新；拉不到保留上一份。
const lanehubCatalog = lanehub ? new LanehubCatalog(lanehub, { log: (o,msg)=>console.error(msg, o) }) : null;
if (lanehubCatalog) await lanehubCatalog.start();
// R2 图片归档：没配 R2_CONFIG_FILE 就关掉（日志里会有 image_archive_disabled），生图不受影响。
const imageStorage = process.env.R2_CONFIG_FILE ? await loadR2Storage(process.env.R2_CONFIG_FILE) : null;
const appOptions = { db,upstream,customerAuth,imageStorage,waffo:await loadWaffo(),
  lanehub,lanehubCatalog,lanehubAccountId:process.env.LANEHUB_ACCOUNT_ID ?? null,
  // 与本地钱包共用注册赠额；旧环境变量不再覆盖 ¥5 的规则。
  lanehubSignupCny:SIGNUP_BONUS_CNY,
  lanehubUsdCny,lanehubQuotaPerUnit,
  // 可选：HEALTH_DETAILS_TOKEN 让本机以外（如宿主机经 127.0.0.1:3000）也能读 /healthz/details。
  healthToken:process.env.HEALTH_DETAILS_TOKEN || null,
  trustProxy:(address)=>trustedProxyAddresses.has(address.replace(/^::ffff:/,'')),scheduler:new Scheduler(),
  origin:process.env.PUBLIC_ORIGIN ?? 'https://api.ipzsk.com',secureCookies:true,
  logger:{ level:'warn', redact:['req.headers.authorization','req.headers.cookie','res.headers.set-cookie','password','key','token'] } };
const app = await createApp(appOptions);
let paymentsPending;
const syncPayments = () => {
  if (appOptions.waffo?.mode !== 'prod' || paymentsPending) return;
  paymentsPending = deliverPayments(db,lanehub).catch(() => app.log.error('payment_delivery_failed'))
    .finally(() => { paymentsPending=null; });
};
const paymentTimer=setInterval(syncPayments,5000);paymentTimer.unref();syncPayments();
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
  }).catch(() => app.log.error('lanehub_charge_sync_failed'))
  .then(() => reconcileCommissions(db)).then(() => deliverConversions(db,appOptions))
  .catch(() => app.log.error('commission_sync_failed'))
  // lanehub 额度调整：applying 超时转人工核对；pending（远程未开始）以 CAS 接手执行；已生效未落账的退款补落账。
  // 从不重放 applying / review。
  .then(() => finalizeAdjustments(db,lanehub)).catch(() => app.log.error('lanehub_adjustment_sync_failed'));
const chargeTimer = setInterval(syncCharges,120_000);
chargeTimer.unref();
// 形象列表预热：每次目录刷新成功后后台跑一次（10 分钟一次），失败只记日志，不挡启动。
if (lanehubCatalog) {
  lanehubCatalog.onRefresh = () => warmAvatarLists(appOptions).catch((e) => app.log.warn({ err:e?.code ?? e?.message },'avatar_list_warm_failed'));
  lanehubCatalog.onRefresh();
}
let archivePending;
const syncArchives = () => {
  if (!archivePending && imageStorage) archivePending = syncImageArchives(db,imageStorage)
    .then(({ failed }) => { for (const f of failed) app.log.warn(f,'image_archive_gave_up'); })
    .catch(() => app.log.error('image_archive_sync_failed')).finally(() => { archivePending=null; });
};
const archiveTimer=setInterval(syncArchives,5000);archiveTimer.unref();syncArchives();
if (!imageStorage) app.log.warn('image_archive_disabled');
let cleanupPending;
const syncCleanup = () => {
  if (!cleanupPending && imageStorage) cleanupPending = cleanupMedia(db,imageStorage)
    .catch(() => app.log.error('media_cleanup_failed')).finally(() => { cleanupPending=null; });
};
const cleanupTimer=setInterval(syncCleanup,600_000);cleanupTimer.unref();
// 缩略图：每 5 秒一轮，一轮内连续取任务直到队列空或 4.5 秒用完；ffmpeg 默认串行（THUMB_CONCURRENCY=1，最多 2），
// 用户上传/生成先于案例回填（THUMB_PRIORITY=0 关掉）。没配 R2 就不跑，前端用 orig 兜底。
let thumbPending;
const thumbOptions = { concurrency:thumbConcurrency(), priority:thumbPriority() };
const syncThumbs = () => {
  if (!thumbPending && imageStorage) thumbPending = drainThumbJobs({ db,r2:imageStorage,log:app.log,...thumbOptions })
    .catch(() => app.log.error('thumbnail_loop_failed')).finally(() => { thumbPending=null; });
};
const thumbTimer=setInterval(syncThumbs,5000);thumbTimer.unref();
let mediaPending;
const syncMedia = () => { if (!mediaPending) mediaPending=syncMediaTasks(db,upstream).finally(()=>{mediaPending=null;}).catch(()=>{}); };
const mediaTimer=setInterval(syncMedia,5000);mediaTimer.unref();syncMedia();
let stopping = false;
for (const event of ['SIGTERM','SIGINT']) process.on(event,async () => {
  if (stopping) return; stopping=true;
  clearInterval(paymentTimer);await paymentsPending;
  clearInterval(archiveTimer);clearInterval(cleanupTimer);clearInterval(thumbTimer);clearInterval(mediaTimer);clearInterval(syncTimer);clearInterval(proxyTimer);clearInterval(chargeTimer); upstream.close();
  await app.close(); await upstream.pending?.catch(() => {}); await upstream.taskChargesPending?.catch(() => {}); await mediaPending; await archivePending; await cleanupPending; await thumbPending; await db.close();
});
await app.listen({ host:'0.0.0.0',port:3000 });
console.log('gateway_listening');
syncCharges();
