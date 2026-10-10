# 分佣模块 v1

业务规则按 2026-10-10 确认的《IPZSK 计费与分销统一方案》执行。此文记录本地实现和接入边界，不表示生产已迁移或已启用。

## 已实现的资金链路

- 新用户经邀请链接注册并验证邮箱后绑定直接邀请人。链接在 API 域名设置 HttpOnly、SameSite=Lax、30 天 Cookie；后一次有效链接覆盖前一次，已有账户不能补绑。
- 普通邀请人获一次有效的 5 元奖励：累计已到账的生产环境充值减已确认退款，严格大于 10 元。退款跌破门槛追加冲回，重新达标恢复同一奖励，不叠加第二份。
- 充值只入使用余额，不计 BD 或作者分佣。每笔实际消费按扣款来源分配，赠额和收益转入的余额不分佣。本金和赠额按入账顺序消耗，并发扣款串行分配。
- 设本次扣款为 S，实际成本 C，本金比例 q，则可分利润 P=max(S×q−C×q,0)。BD 先取 P×20%，作者取剩余利润×40%。无 BD 时作者直接取 P×40%。金额按 8 位小数截取，尾差留平台。
- 100 元付费消费、40 元实际成本：BD 12 元、作者 19.2 元、平台 28.8 元；其中 20 元来自赠额时：BD 9.6 元、作者 15.36 元。
- 成本只取 requests.cost_cny。估算值、销售价除以 2.5、缺失成本都不能冒充实际成本。成本未知挂起，管理员账单确认或实际成本同步后补计。已知零成本有效。
- 请求创建时快照邀请人当时的 BD 身份及经插件凭证验证的作者归属。以后调身份或插件归属不改历史。自消费不产生自身 BD／作者收益。
- 新规则关闭 Skill 固定调用费和十分钟窗口计佣，正文 Skill 标签只保留观测。每笔请求最多一个作者池；生图插件凭证归生图作者，主 Skill 不再重复取得这一池。不能可靠归属的请求不凭正文给作者计佣。
- 观察期 30 天。上月已成熟收益可按月申请人工提现，单笔至少 100 元、保留到分；分以下尾款留账。系统预留申请金额，管理员审核、转账后登记回执。取消申请原额解冻。
- 已成熟收益可从 0.01 元起 1:1 转使用余额，不可逆，也不再分佣。LaneHub 通过持久化待办入账，响应丢失转人工核对，不自动重复加额度；额度最小单位的上舍入由平台承担。
- 消费退款沿原来源比例恢复本金／赠额，累计舍入尾差归最后一个可容纳的来源。部分退款重新计算利润，保留实际上游成本；全额退款冲回全部收益。成本修正也追加差额，不改旧流水。
- 充值退款回调先冻结相关收益；管理员核对真实支付回执后登记金额。未消费退款扣回余额并检查邀请奖励；拒付沿充值来源追溯消费，冲回对应利润。已经付出的收益形成负余额，用后续收益抵扣。
- 所有提现、转余额、邀请奖励、退款记录带幂等约束；财务操作和审计在同一数据库事务中保存。

## 本地操作入口

用户在官网 `/#wallet` 的“邀请与收益”查看链接、收益流水、转余额、提现和申请记录。开发者用量报表合并展示历史收益及新账本的作者收益，提现入口统一到收益中心。

管理员在 API 管理台 `/admin` 的“分佣与提现”开通 BD、冻结／解冻、核对成本待办、审核提现及记录回执。该页仅 superadmin 可读写；普通网站角色和插件令牌不能调用财务管理接口。

提现收款信息由运营与用户通过已有联系渠道核对，平台仅保存人工转账回执，不在流水和审计中保存银行卡明文。每月 1–5 日审核、15 日人工转账（非工作日顺延）由运营执行，系统不发起自动银行打款。

## 启用与历史迁移

1. `db.migrate()` 在同一事务应用 schema.sql 与 commissions.sql。默认新规则关闭，历史 plugin_earnings 和 settlements 保留。已创建请求的政策快照不随开关变化。
2. 老账户默认 sources_confirmed=false，禁止猜测旧余额都是本金。先暂停新规则，确认账户无在途／待定扣费，再通过期初余额接口核对。剩余本金须对应已到账的生产充值订单，且不能超过该订单扣除历史分配及退款后的可验证金额；其余余额按不分佣余额处理。迁移应在接单暂停期间进行，尤其 LaneHub 可能存在外部消费。
3. 在管理台启用新请求计佣。未迁移来源或实际成本缺失的请求保持待核对，不能提取虚构收益。开关影响新请求，不补算旧请求。
4. 核对网关和 LaneHub 的销售倍率确为 2.5、输入／输出／缓存及媒体规格价格正确。本模块不自动修改渠道售价。
5. 部署后需用已授权的真实支付和账单完成验收。当前测试使用独立 gateway_test 和支付／LaneHub 替身，不代表已跑通生产打款。

## 接口

| 接口 | 用途 |
| --- | --- |
| GET /api/me/commissions | 自己的链接、余额、流水、申请 |
| POST /api/me/commissions/convert | amount_cny + UUID idempotency_key，转使用余额 |
| POST /api/me/commissions/payouts | amount_cny + UUID idempotency_key，提现申请 |
| GET /api/account/referral/:code | 有效邀请链接并跳转注册 |
| GET /admin/api/commissions | 管理台汇总 |
| POST /admin/api/commissions/policy | enabled + reason，切换新请求规则 |
| POST /admin/api/commissions/profiles/:id | bd_active + frozen + reason |
| POST /admin/api/commissions/reconcile | 重核对具备条件的待办 |
| POST /admin/api/commissions/opening-balance/:id | paid_lots + reference，核实旧余额 |
| POST /admin/api/commissions/payouts/:id | state + reference，审核／取消／登记已转账 |
| POST /admin/api/commissions/conversions/:id/resolve | result=applied/not_applied + reference，人工核对中转入账 |
| POST /admin/api/commissions/payment-refunds/:id | amount_cny + chargeback + reference，确认已发生的充值退款／拒付 |

使用已有 `/admin/api/requests/:id/charge` 录入经核实的实际成本，`/admin/api/billing/:id/refund` 处理服务退款。已经拒付的请求禁止再走普通服务退款，须人工核对，避免重复返还本金。

## Skill 接入边界

插件自行调用使用其用户专属凭证；主模型代表 Skill 调用时，通过已有 `X-IPZSK-Plugin-Token` 出示同一用户的该插件凭证，网关查验启用状态与模型白名单，客户端不能直接指定收款作者或比例。普通正文标签、未注册 Skill 和跨用户凭证不能取得作者池。

本次交付覆盖分佣资金链路；桌面 Host 的 Skill 版本／任务边界事件、跨调用总预算和组合 Skill 的作者份额编排属于执行侧接入，尚未在本次本地验收中证明。当前可靠的作者归属是插件凭证；没有此凭证的纯提示词 Skill 暂不产生作者分佣，不能对外宣称桌面 Skill 已全量自动计佣。账户级预留继续使用原计费链路。

## 验证

`npm test` 验证单元与契约。`TEST_DB_HOST=127.0.0.1 TEST_DB_PORT=<隔离端口> npm run test:integration` 只连接 gateway_test。集成测试串行运行，避免 better-auth 跨 schema 内省与其他测试清理 schema 并发冲突。新增 commissions.test.mjs 覆盖利润、来源、成本、退款、拒付、观察期、幂等、并发提现、历史余额及中转响应不确定。
