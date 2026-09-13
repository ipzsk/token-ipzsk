#!/usr/bin/env node
/**
 * **上架之后的闭环自检**：插件在 IPZSK 市场上架 → 用户装上 → 调用 → 计次 → 作者分成 → 结算单。
 *
 * 回答的是这三个问题：
 *   1. 上架的 skill 被调用时，计次对不对？
 *   2. 生图 / 生视频这类插件，能不能按**调用次数**计费？
 *   3. 算给作者的分成对不对，进不进得了结算单？
 *
 * 不依赖真的 GitHub Release 和真的下载：分发渠道和计费链路是解耦的——插件装上之后，
 * 调用时的归属跟它当初是怎么装的没有关系。这里把上架那一步做成库里的真实记录
 * （plugin_releases state='published'），然后验证市场接口确实列得出来，
 * 再从**网关的 HTTP 入口**打真实请求，一路验到结算单。
 *
 * **可以反复跑**：所有 id 固定，插件、作者、上架记录都幂等；每跑一次只多花几次
 * 真实模型调用的钱（文本模型一次几厘）。
 *
 *   export DATABASE_URL=... LANEHUB_BASE_URL=... LANEHUB_ADMIN_TOKEN=...
 *   node scripts/market-chain-e2e.mjs
 */
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { database } from '../src/database.mjs';
import { createApp } from '../src/app.mjs';
import { Upstream } from '../src/upstream.mjs';
import { Scheduler } from '../src/scheduler.mjs';
import { Lanehub } from '../src/lanehub.mjs';
import { reconcileLanehubCharges } from '../src/lanehub-charges.mjs';
import { hash, token, passwordHash } from '../src/security.mjs';

const env = (name, fallback) => process.env[name] ?? fallback;
const missing = ['DATABASE_URL', 'LANEHUB_BASE_URL', 'LANEHUB_ADMIN_TOKEN'].filter((n) => !process.env[n]);
if (missing.length) { console.error('缺少环境变量：' + missing.join(' ')); process.exit(2); }

const TEXT_MODEL = env('MARKET_E2E_TEXT_MODEL', 'deepseek-v4-flash');
const IMAGE_MODEL = env('MARKET_E2E_IMAGE_MODEL', 'gpt-image-2');
const USD_CNY = Number(env('LANEHUB_USD_CNY', '6.7078'));
const QUOTA_PER_UNIT = Number(env('LANEHUB_QUOTA_PER_UNIT', '500000'));
const spend = process.argv.includes('--spend');

// 固定身份：跑第二次要落在同一批行上。
const CUSTOMER = '00000000-0000-4000-8000-00000000d001';
const AUTHOR   = '00000000-0000-4000-8000-00000000d002';
const SKILL_PLUGIN = '00000000-0000-4000-8000-00000000d003';   // 提示词型：按次计
const MEDIA_PLUGIN = '00000000-0000-4000-8000-00000000d004';   // 生图型：自己发请求，也按次计
const SKILL_REF = 'market-e2e-ppt';
const SKILL_PRICE = '0.08', MEDIA_PRICE = '0.30';

const checks = [];
const check = (name, ok, detail = '') => { checks.push({ ok }); console.log(`${ok ? '✔' : '✘'} ${name}${detail ? '  ' + detail : ''}`); };

const db = database({ connectionString: process.env.DATABASE_URL });
const secretDir = env('UPSTREAM_SECRET_DIR', join(tmpdir(), 'ipzsk-e2e-secrets'));
await mkdir(secretDir, { recursive: true, mode: 0o700 });
const upstream = new Upstream(db, secretDir);
const lanehub = new Lanehub({ baseUrl: process.env.LANEHUB_BASE_URL, adminToken: process.env.LANEHUB_ADMIN_TOKEN });
let app;

try {
  await db.migrate();
  // DO UPDATE 而不是 DO NOTHING：别的自检脚本可能已经建过管理员，
  // 那时 DO NOTHING 会留下一个我们不知道密码的账号，后面登录必然失败。
  await db.query(`INSERT INTO administrators(id,password_hash) VALUES (1,$1)
    ON CONFLICT (id) DO UPDATE SET password_hash=EXCLUDED.password_hash`,
  [await passwordHash('market-e2e-admin-password')]);

  const accountId = (await db.query(
    `INSERT INTO upstream_accounts (id,name,concurrency,base_url,provider_type)
     VALUES ($1,'lanehub-e2e',5,$2,'lanehub') ON CONFLICT (name) DO UPDATE SET base_url=EXCLUDED.base_url RETURNING id`,
    [randomUUID(), process.env.LANEHUB_BASE_URL])).rows[0].id;
  await db.query(`INSERT INTO app_settings (key,value) VALUES ('lanehub_mode','on') ON CONFLICT (key) DO UPDATE SET value='on'`);
  await db.query(`INSERT INTO users (id,name,rpm) VALUES ($1,'market-e2e 客户',60),($2,'插件作者',60) ON CONFLICT (id) DO NOTHING`, [CUSTOMER, AUTHOR]);
  await db.query(`INSERT INTO developer_profiles (user_id,display_name,state) VALUES ($1,'市场作者','approved')
    ON CONFLICT (user_id) DO UPDATE SET state='approved'`, [AUTHOR]);

  // ── 1. 上架：两个插件各发一个版本，管理员审核通过 ───────────────────
  const publish = async (pluginId, slug, name, pkg, models, pricePerCall, runtimeId, credentialPaths) => {
    await db.query(`INSERT INTO plugins (id,slug,name,repository,package_name,publisher_ref,allowed_models,
        runtime_id,runtime_config,credential_paths,owner_user_id,revenue_share_bps,price_per_call_cny)
      VALUES ($1,$2,$3,'example/market-e2e',$4,'example',$5,$6,'{}',$7,$8,3000,$9)
      ON CONFLICT (id) DO UPDATE SET allowed_models=EXCLUDED.allowed_models,owner_user_id=EXCLUDED.owner_user_id,
        price_per_call_cny=EXCLUDED.price_per_call_cny,credential_paths=EXCLUDED.credential_paths,enabled=true`,
    [pluginId, slug, name, pkg, models, runtimeId, credentialPaths, AUTHOR, pricePerCall]);
    // 上架一个版本。artifact_url 必须是已登记仓库的 GitHub Release 地址——
    // 客户端那侧（dsh-community-market 的 approvedCatalog）会逐条校验这一点。
    await db.query(`INSERT INTO plugin_releases (id,plugin_id,version,github_release_id,github_asset_id,
        release_url,artifact_url,sha256,size_bytes,notes,state,imported_by,published_by,published_at)
      VALUES ($1,$2,'1.0.0',1,1,'https://github.com/example/market-e2e/releases/tag/v1.0.0',
        'https://github.com/example/market-e2e/releases/download/v1.0.0/' || $3 || '-1.0.0.tgz',
        repeat('a',64),12345,'自检版本','published',1,1,now())
      ON CONFLICT (plugin_id,version) DO UPDATE SET state='published',published_at=now()`,
    [randomUUID(), pluginId, pkg]);
  };
  await publish(SKILL_PLUGIN, 'market-e2e-skill', '自检 · PPT skill', 'market-e2e-skill', [TEXT_MODEL], SKILL_PRICE, 'e2e-skill', '[]');
  await publish(MEDIA_PLUGIN, 'market-e2e-imagegen', '自检 · 生图插件', 'market-e2e-imagegen', [IMAGE_MODEL], MEDIA_PRICE, 'e2e-imagegen',
    JSON.stringify([['channelSecrets', 'ipzsk']]));
  await db.query(`INSERT INTO plugin_skills (skill_ref,plugin_id,display_name) VALUES ($1,$2,'自检 PPT')
    ON CONFLICT (skill_ref) DO NOTHING`, [SKILL_REF, SKILL_PLUGIN]);

  app = await createApp({ db, upstream, scheduler: new Scheduler({ waitMs: 10 }),
    origin: 'http://127.0.0.1:3100', secureCookies: false,
    lanehub, lanehubAccountId: accountId, lanehubSignupCny: 5, lanehubUsdCny: USD_CNY, lanehubQuotaPerUnit: QUOTA_PER_UNIT });

  const issue = async (name, pluginId) => {
    const value = token('ipz_');
    await db.query(`INSERT INTO access_tokens (id,user_id,token_hash,prefix,name,plugin_id) VALUES ($1,$2,$3,$4,$5,$6)`,
      [randomUUID(), CUSTOMER, hash(value), value.slice(0, 12), name, pluginId]);
    return value;
  };
  const main = await issue('主令牌', null);
  const mediaCredential = await issue('生图插件凭据', MEDIA_PLUGIN);

  // ── 2. 市场目录：客户端看到的就是这个 ───────────────────────────────
  const market = await app.inject({ url: '/api/me/plugin-market', headers: { authorization: 'Bearer ' + main } });
  const listed = market.statusCode === 200 ? market.json() : {};
  const ours = (listed.plugins ?? []).filter((p) => [SKILL_PLUGIN, MEDIA_PLUGIN].includes(p.id));
  check('上架：市场目录列得出这两个插件', listed.market_id === 'dsh-ipzsk-market' && ours.length === 2,
    `market_id=${listed.market_id} 共 ${listed.plugins?.length ?? 0} 个`);
  check('上架：目录里带着安装所需的校验信息', ours.every((p) => p.artifact_url?.startsWith('https://github.com/') && /^[0-9a-f]{64}$/.test(p.sha256) && p.size_bytes > 0),
    '版本 / artifact_url / sha256 / size_bytes 齐全');

  const earnings = async (pluginId) => (await db.query(
    `SELECT e.* FROM plugin_earnings e JOIN requests r ON r.id=e.request_id
     WHERE e.plugin_id=$1 AND r.user_id=$2 ORDER BY e.created_at DESC`, [pluginId, CUSTOMER])).rows;
  // 计提按「同一用户 + 同一 skill，窗口内只算一次」去重，所以上一次跑留下的计提会
  // 把这一次吞掉。把历史记录的时间挪到窗口之外，这个脚本才能真的反复跑。
  await db.query(`UPDATE plugin_earnings e SET created_at=now()-interval '2 hours'
    FROM requests r WHERE r.id=e.request_id AND r.user_id=$1`, [CUSTOMER]);
  const before = { skill: (await earnings(SKILL_PLUGIN)).length, media: (await earnings(MEDIA_PLUGIN)).length };

  // ── 3. 上架的 skill 被调用：按次计 ──────────────────────────────────
  const askWithSkill = () => app.inject({ url: '/v1/chat/completions', method: 'POST',
    headers: { authorization: 'Bearer ' + main },
    payload: { model: TEXT_MODEL, max_tokens: 30, messages: [{ role: 'user',
      content: `做个 PPT\n<skill_content name="${SKILL_REF}">\n<skill_instructions>按大纲出片</skill_instructions>\n</skill_content>` }] } });
  const answered = await askWithSkill();
  check('调用：上架的 skill 跑通', answered.statusCode === 200, answered.statusCode === 200 ? '' : answered.body.slice(0, 120));
  const skillAll = await earnings(SKILL_PLUGIN);
  const skillRows = skillAll.slice(0, skillAll.length - before.skill);
  check('计次：skill 调用计了一次，金额是固定单价', skillRows.length === 1 && Number(skillRows[0].amount_cny) === Number(SKILL_PRICE),
    `${skillRows.length} 条 / ¥${skillRows[0]?.amount_cny ?? '-'}（单价 ¥${SKILL_PRICE}）`);
  check('计次：归属到作者', skillRows[0]?.owner_user_id === AUTHOR && skillRows[0]?.skill_ref === SKILL_REF);

  // 同一轮的后续步骤不重复计（agent 会反复发请求，skill 一直在上下文里）。
  await askWithSkill(); await askWithSkill();
  check('计次：同一轮的后续调用不重复计', (await earnings(SKILL_PLUGIN)).length === before.skill + 1,
    `共 ${(await earnings(SKILL_PLUGIN)).length} 条`);

  // ── 4. 生图插件：自己发请求，同样按次计 ─────────────────────────────
  if (!spend) {
    console.log('\n（没加 --spend，跳过真实生图；skill 那条已经验完）');
  } else {
    const image = await app.inject({ url: '/v1/images/generations', method: 'POST',
      headers: { authorization: 'Bearer ' + mediaCredential },
      payload: { model: IMAGE_MODEL, prompt: 'a single yellow lemon on a white table', aspect_ratio: '1:1' } });
    check('调用：生图插件用自己的凭据跑通', image.statusCode === 200, image.statusCode === 200 ? '' : image.body.slice(0, 160));
    const taskId = image.statusCode === 200 ? image.json().data?.[0]?.task_id : undefined;
    for (let i = 0; i < 30 && taskId; i++) {
      const task = await app.inject({ url: '/v1/tasks/' + taskId, headers: { authorization: 'Bearer ' + mediaCredential } });
      if (['completed', 'failed'].includes(task.json()?.data?.status)) break;
      await new Promise((done) => setTimeout(done, 5000));
    }
    await db.query(`UPDATE requests SET completed_at=now()-interval '2 minutes' WHERE user_id=$1`, [CUSTOMER]);
    await reconcileLanehubCharges(db, lanehub, { usdCnyRate: USD_CNY, quotaPerUnit: QUOTA_PER_UNIT });
    const mediaRows = await earnings(MEDIA_PLUGIN);
    check('计次：生图按调用次数计，不看这一单收了多少钱',
      mediaRows.length === before.media + 1 && Number(mediaRows[0]?.amount_cny) === Number(MEDIA_PRICE),
      `${mediaRows.length - before.media} 条 / ¥${mediaRows[0]?.amount_cny ?? '-'}（单价 ¥${MEDIA_PRICE}）`);
  }

  // ── 5. 分成进结算单 ────────────────────────────────────────────────
  const login = await app.inject({ url: '/admin/api/login', method: 'POST', payload: { password: 'market-e2e-admin-password' },
    headers: { origin: 'http://127.0.0.1:3100' } });
  const cookie = login.headers['set-cookie'].split(';')[0];
  const admin = (url, method = 'GET', payload) => app.inject({ url: '/admin/api' + url, method, payload, headers: { cookie, origin: 'http://127.0.0.1:3100' } });
  const pending = (await admin('/settlements')).json().pending.find((p) => p.owner_user_id === AUTHOR);
  check('结算：作者的计提进了待出单', Number(pending?.amount_cny) > 0, `待结算 ¥${pending?.amount_cny ?? 0}（${pending?.item_count ?? 0} 条）`);
  const draft = (await admin('/settlements', 'POST', { owner_user_id: AUTHOR, from: '2000-01-01', to: '2099-12-31' })).json();
  const frozen = (await admin('/settlements/' + draft.id + '/freeze', 'POST', {})).json();
  check('结算：出单并冻结', Number(frozen.amount_cny) === Number(draft.amount_cny) && frozen.item_count > 0,
    `¥${frozen.amount_cny} / ${frozen.item_count} 条明细`);
} finally {
  await app?.close();
  await db.close();
}

const failed = checks.filter((c) => !c.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} 通过`);
process.exitCode = failed ? 1 : 0;
