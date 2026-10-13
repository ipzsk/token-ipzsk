import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pluginAttributionState } from '../src/gateway.mjs';

const source = file => readFile(new URL('../src/' + file, import.meta.url), 'utf8');
const PLUGIN = '7d8b7d87-b85f-49f1-bde7-a0b1a2f33401';

// bootstrap 未上报 installed_packages 时签发的插件凭证，与上报后签发的凭证在网关看来完全相同：
// 都是 access_tokens.plugin_id 绑定的凭证。下面每一条都覆盖这两种来源。
test('插件凭证本身永远不使归属可支付', () => {
  // 直接用插件凭证，或主令牌 + X-IPZSK-Plugin-Token 出示（两者 credentialPlugin 都是凭证上的插件）。
  for (const skillState of ['none', 'unregistered', 'ambiguous'])
    assert.equal(pluginAttributionState({ pluginId: PLUGIN, credentialPlugin: PLUGIN, skillState }), 'credential_unverified', skillState);
});

test('X-IPZSK-Skill-Version 依赖凭证确定插件，不能把凭证归属升级为可支付', () => {
  // 该头只在出示插件凭证后才被接受，resolveSkillCalls 状态仍为 none。
  assert.equal(pluginAttributionState({ pluginId: PLUGIN, credentialPlugin: PLUGIN, skillState: 'none' }), 'credential_unverified');
});

test('只有按登记内容哈希独立解析出的 Skill 归属可支付；没有插件就没有归属', () => {
  assert.equal(pluginAttributionState({ pluginId: PLUGIN, credentialPlugin: null, skillState: 'attributed' }), 'skill_marker');
  // 同时出示凭证不增加也不减少可支付性：去掉凭证，这一单经 Skill 解析仍归同一插件。
  assert.equal(pluginAttributionState({ pluginId: PLUGIN, credentialPlugin: PLUGIN, skillState: 'attributed' }), 'skill_marker');
  assert.equal(pluginAttributionState({ pluginId: null, credentialPlugin: null, skillState: 'none' }), 'none');
});

test('网关落库用这个判定；三处分佣入口都排除 credential_unverified', async () => {
  const gateway = await source('gateway.mjs');
  assert.match(gateway, /const pluginAttribution=pluginAttributionState\(\{pluginId,credentialPlugin,skillState:skillCalls\.state\}\)/);
  assert.match(gateway, /skill_attribution_state,plugin_attribution_state\)/);
  // 永久分佣：commission_snapshot 不给未核验归属设开发者。
  const sql = await source('commissions.sql');
  const snapshot = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION commission_snapshot'), sql.indexOf('DROP TRIGGER IF EXISTS commission_snapshot'));
  assert.match(snapshot, /NEW\.plugin_attribution_state<>'credential_unverified'/);
  // 旧版 plugin_earnings 计提与退款冲回。
  const earnings = await source('earnings.mjs');
  const accrue = earnings.slice(earnings.indexOf('export async function accrueEarning'), earnings.indexOf('const amount=(value)=>'));
  assert.match(accrue, /r\.plugin_attribution_state<>'credential_unverified'/);
  assert.match(earnings, /request\.plugin_attribution_state!=='credential_unverified'/);
});

test('未上报 installed_packages 的旧客户端仍兼容签发，并在审计中标明', async () => {
  const desktop = await source('desktop.mjs');
  assert.match(desktop, /AND \(\$2::text\[\] IS NULL OR package_name=ANY\(\$2::text\[\]\)\)/);
  assert.match(desktop, /installed_declared:Boolean\(installed\)/);
});
