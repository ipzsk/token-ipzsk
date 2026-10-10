# 客户端分佣接入与模拟验收

日期：2026-10-10。全部使用隔离 PostgreSQL schema、模拟模型返回和模拟 Lanehub 消费回执；没有生产充值、真实模型调用或实际转账。

## 已接入

- 官方桌面端不接收 Skill 作者映射、登记目录或分佣比例。实际 Skill registry 加载后，只记录当前 agent 当前轮次的 Skill 名称及内容 SHA-256。
- 模型请求通过 `X-IPZSK-Skill-Calls` 上报完整标记列表。网关检查格式、登记版本、启用状态、模型权限，并在后台决定归属；请求保存全部标记、后台解析结果及作者快照。客户端不能在标记中指定收款人、价格、成本或比例。
- 普通聊天、标题等辅助请求、其他 provider 不借用作者归属；换轮、agent 结束均清除临时归属。
- 安装插件继续复用现有 `ipzskPluginPatches`，将会话绑定的插件凭据注入已有配置槽。
- 客户端账户页复用现有 wallet、table-wrap、quiet button 等组件，展示邀请链接、收益余额、可用时间、收益流水及操作状态。仅通过白名单 IPC 返回自己的显示字段，不返回本金占比、实际成本、公式或凭据。
- 提现和转使用余额按钮打开官网现有 `/#wallet` 流程。客户端没有另外实现一套金融写入表单。
- 账户页不再包含上游成本倍率；生图/视频任务响应对白名单媒体字段逐层投影，内部成本回执保留在后台，不透传给客户端。

## 实测链路

测试入口：`test/desktop-commission-chain.test.mjs`。
真实 `IpzskAuth.restore()` → 本地 HTTP bootstrap → Cordis / AgentLoop / SkillRegistry / ToolSkill / pi-ai → 本地真实网关 → 真实 `requests` → `recordLanehubCharge` 导入模拟回执 → PostgreSQL 分佣函数 → BD / 作者各自调用真实收益接口 → 客户端收益解析。
插件分支使用真实 bootstrap 和 `ipzskPluginPatches` 注入的配置发起 HTTP 请求；上游和回执均为测试替身。

每笔模拟消费 100 元，实际成本回执 40 元，全部来自真实充值来源的模拟资金。生图成本经真实 `refreshMediaTask` / `recordTaskCharge` 路径读取模拟上游回执，其他请求使用模拟对账成本。

| 请求 | BD 入账 | 作者入账 |
| --- | ---: | ---: |
| `/fixture-skill` 实际加载并调用模型 | 12.00000000 | 19.20000000 |
| 下一轮普通聊天，包含伪造 Skill 标签 | 12.00000000 | 0.00000000 |
| 插件凭据发起 API 请求 | 12.00000000 | 19.20000000 |
| 同轮两个作者 Skill，后台记录 ambiguous | 12.00000000 | 0.00000000 |
| 生图插件发起生成并轮询结果 | 12.00000000 | 19.20000000 |
| 合计 | 60.00000000 | 57.60000000 |

核对：成本未知时保持 `pending_cost`；成本确认后入账。重复导入消费回执后仍只有 8 条分佣流水。第二位作者没有错误入账。收益在 30 天观察期内，因此两个账户可用余额均为 0。

补充断言覆盖：并行 agent 不串标记、辅助请求不带标记、内容变化如实上报并由后台校验、Skill 归属冲突拒绝、非法哈希拒绝、版本撤销拒绝、完成轮次不遗留标记。多作者时客户端仍完整上报，后台保存所有归属候选，按当前单插件规则不自动分配作者池。

边界回归：`test/skill-attribution.test.mjs` 验证伪造收款人/成本/比例、超长列表、重复标记、未登记 Skill、禁用插件和模型权限；`test/image-results.test.mjs` 验证进行中/完成/失败及嵌套媒体对象均不泄漏内部财务字段。

页面验证入口在桌面端 `official-desktop/tests/commission-renderer-smoke.mjs`：真实 Chrome 无头加载账户页及现有 CSS/JS，模拟 IPC。BD / 作者分别在 900px、520px 验证余额、成熟时间、申请状态、官网入口及读取失败保留旧数据；没有横向页面溢出或运行时错误。截图保存在桌面端 `official-desktop/.build/commission-qa/`。

## 重跑

先在桌面端 `official-desktop` 运行 `node scripts/run.mjs build`。
在网关仓库中执行（数据库必须是隔离的 `gateway_test`）：

```sh
TEST_DB_HOST=127.0.0.1 TEST_DB_PORT=55439 \
IPZSK_DESKTOP_BUILD=../ipzsk-dsh-desktop-next/official-desktop/.build/upstream \
node --test test/desktop-commission-chain.test.mjs
node --test test/skill-attribution.test.mjs test/image-results.test.mjs
```

浏览器验证在桌面端 `official-desktop` 运行：

```sh
PLAYWRIGHT_MODULE=/path/to/existing/playwright-core node tests/commission-renderer-smoke.mjs
```

## 启用条件和边界

- 超级管理员通过 `POST /admin/api/plugins/:id/skill-versions` 登记 `skill_ref`、`content_sha256`、`enabled`、`reason`。哈希针对 Skill registry 返回的 `content` UTF-8 内容，不是包含 frontmatter 的整份文件；审核后登记，变更需重新登记。
- 登记、归属和启用状态全部由后台实时读取，修改无需下发新作者映射。已登记版本撤销后，在网关立即拒绝对应调用；未登记的本地 Skill 标记保留，但不获得作者归属。
- 同轮混用多个插件时，后台保存 `skill_attribution_state=ambiguous` 及全部 `skill_calls`，不自动计作者佣金；多作者拆分仍需独立方案。插件凭据与 Skill 归属冲突由后台拒绝。
- 模拟验证不等于生产验收；验证范围不含部署、打包签名或真实支付，真实请求的成本仍须由现有可信成本回执链路确认。
