#!/usr/bin/env node
/**
 * 切换 lanehub 模式（额度真源在 lanehub）。**开与关都是幂等的**，重复执行不会有副作用。
 *
 *   node scripts/lanehub-switch.mjs status
 *   node scripts/lanehub-switch.mjs on   [--force]
 *   node scripts/lanehub-switch.mjs off
 *
 * 开之前会跑四项前置检查，任何一项不过就拒绝（除非 --force）。这四项都是「跑起来
 * 才会发现、而发现时钱已经错了」的那类：
 *
 *   1. lanehub 账户存在且类型是 lanehub —— 类型写错会让任务轮询去打不存在的路径
 *   2. 还有余额没迁走的客户 —— 切过去之后这边的余额就没人看了，他会以为钱丢了
 *   3. billing_policy 仍开着 —— 两边都预扣 = 同一笔钱冻两次
 *   4. 有未结算的预扣 —— 切换会让它们永远停在 reserved，钱一直冻着
 *
 * 关掉不做检查：回滚要能立刻生效。
 */
import { database } from '../src/database.mjs';
import { wallet } from '../src/billing.mjs';

const [action] = process.argv.slice(2);
const force = process.argv.includes('--force');
const db = database({ connectionString: process.env.DATABASE_URL });

async function mode() {
  return (await db.query("SELECT value FROM app_settings WHERE key='lanehub_mode'")).rows[0]?.value ?? 'off';
}

async function setMode(value) {
  // ON CONFLICT 让重复执行落到同一行上：开两次和开一次没有区别。
  await db.query(`INSERT INTO app_settings (key,value) VALUES ('lanehub_mode',$1)
    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [value]);
}

async function preflight() {
  const problems = [];

  const account = (await db.query("SELECT id,name,enabled FROM upstream_accounts WHERE provider_type='lanehub'")).rows;
  if (!account.length) problems.push('没有 provider_type=lanehub 的上游账户——先在后台建一个，地址指向 lanehub');
  else if (!account.some((a) => a.enabled)) problems.push('lanehub 上游账户全是停用状态');

  const users = (await db.query('SELECT id,name FROM users WHERE enabled')).rows;
  const stranded = [];
  for (const user of users) {
    const balance = await wallet(db, user.id);
    const mapped = (await db.query('SELECT 1 FROM lanehub_accounts WHERE user_id=$1', [user.id])).rowCount;
    if (Number(balance.available_cny) > 0 && !mapped) stranded.push(`${user.name ?? user.id}（¥${balance.available_cny}）`);
  }
  if (stranded.length) {
    problems.push(`这些客户还有余额但没迁到 lanehub：${stranded.slice(0, 8).join('、')}${stranded.length > 8 ? ` 等 ${stranded.length} 个` : ''}
    → 先跑 scripts/lanehub-migrate.mjs --batch <批次> --apply`);
  }

  const policy = (await db.query('SELECT enabled FROM billing_policy WHERE id=1')).rows[0];
  if (policy?.enabled) problems.push('billing_policy.enabled 仍是 true——两边都预扣会把同一笔钱冻两次，先关掉它');

  const held = (await db.query("SELECT count(*)::int AS n FROM request_billing WHERE state IN ('reserved','pending')")).rows[0];
  if (held?.n > 0) problems.push(`还有 ${held.n} 笔预扣没结算——切过去它们会永远停在 reserved，等它们结完再切`);

  return problems;
}

try {
  if (action === 'status') {
    console.log('lanehub_mode =', await mode());
    const problems = await preflight();
    console.log(problems.length ? '前置检查未通过：\n  - ' + problems.join('\n  - ') : '前置检查全过');
  } else if (action === 'on') {
    const problems = await preflight();
    if (problems.length && !force) {
      console.error('拒绝开启：\n  - ' + problems.join('\n  - '));
      console.error('\n确认要带着这些问题开启，加 --force。');
      process.exitCode = 1;
    } else {
      if (problems.length) console.error('⚠️ 带问题强开：\n  - ' + problems.join('\n  - '));
      await setMode('on');
      console.log('lanehub_mode = on（额度真源在 lanehub；这一侧不再预扣、不再改写字段、不再换线）');
    }
  } else if (action === 'off') {
    await setMode('off');
    console.log('lanehub_mode = off（回到原来的多上游池与本地钱包）');
  } else {
    console.error('用法: lanehub-switch.mjs status|on|off [--force]');
    process.exitCode = 2;
  }
} finally {
  await db.close();
}
