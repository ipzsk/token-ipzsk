# 客户端分佣接入与模拟验收

日期：2026-10-12。全部使用隔离 PostgreSQL schema、模拟模型返回和模拟 LaneHub 消费回执；没有生产充值、真实模型调用或实际转账。

## 已接入

- 官方桌面端只上报当前 Skill 名称及内容 SHA-256；网关验证登记版本、启用状态、模型权限，并决定插件作者归属。
- 模型请求通过 `X-IPZSK-Skill-Calls` 上报完整标记列表。客户端不能在标记中指定收款人、价格、成本或比例。
- 普通聊天、辅助请求和其他 provider 不借用作者归属；换轮或 agent 结束后清除临时归属。
- 安装插件复用 `ipzskPluginPatches`，将当前用户的插件凭据注入已有配置槽。
- 客户端账户页展示邀请链接、收益余额、可用时间、收益流水及操作状态。提现和转余额打开官网 `/#wallet` 流程。
- 生图和视频响应只返回白名单媒体字段，内部成本回执留在后台。

## 实测链路

测试入口：`test/desktop-commission-chain.test.mjs`。
真实 `IpzskAuth.restore()` → 本地 HTTP bootstrap → Cordis / AgentLoop / SkillRegistry / ToolSkill / pi-ai → 本地真实网关 → `requests` → 模拟成本回执 → PostgreSQL 分佣函数 → BD 和开发者分别读取收益接口 → 客户端收益解析。

每笔模拟有效付费消费 100 元，可信成本回执为 40 元。BD 取得消费的 20%；归属明确的插件开发者取得剩余利润 `(100−40−20)×40%`。下表为 schema 32 规则下的断言值，桌面链路测试需要 `IPZSK_DESKTOP_BUILD`，规则调整后尚待复跑确认。

| 请求 | BD 入账 | 开发者入账 |
| --- | ---: | ---: |
| `/fixture-skill` 实际加载并调用模型 | 20.00000000 | 16.00000000 |
| 下一轮普通聊天，包含伪造 Skill 标签 | 20.00000000 | 0.00000000 |
| 插件凭据发起 API 请求 | 20.00000000 | 16.00000000 |
| 同轮两个作者 Skill，后台记录 ambiguous | 20.00000000 | 0.00000000 |
| 生图插件发起生成并轮询结果 | 20.00000000 | 16.00000000 |
| 合计 | 100.00000000 | 48.00000000 |

重复导入消费回执后仍只有 8 条分佣流水。第二位作者没有错误入账。收益处于 30 天观察期时，可用余额为 0。成本未确认前只入账 BD，开发者部分等真实成本回执后补计。

补充断言覆盖并行 agent、辅助请求、内容哈希变化、Skill 归属冲突、非法哈希、版本撤销、多作者 ambiguous、伪造收款人和跨用户凭据。多作者时后台保存所有候选，不自动拆分开发者份额。

## 重跑

先在桌面端 `official-desktop` 运行 `node scripts/run.mjs build`，再在网关仓库执行：

```sh
TEST_DB_HOST=127.0.0.1 TEST_DB_PORT=55439 \
IPZSK_DESKTOP_BUILD=../ipzsk-dsh-desktop-next/official-desktop/.build/upstream \
node --test test/desktop-commission-chain.test.mjs
node --test test/skill-attribution.test.mjs test/image-results.test.mjs
```

数据库必须是隔离的 `gateway_test`。

## 启用条件和边界

- 超级管理员登记 `skill_ref`、`content_sha256`、`enabled` 和审核理由；内容变化后重新登记。
- 登记、归属和启用状态全部由后台读取，已登记版本撤销后立即停止作者归属。
- 同轮混用多个插件时保存 `skill_attribution_state=ambiguous`，不自动计开发者收益。
- 模拟验证不代表生产验收；真实支付、退款和提现仍需生产环境验证。
