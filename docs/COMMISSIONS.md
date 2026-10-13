# API 消费分佣模块

业务规则按 2026-10-12 确认的永久方案执行：BD 取得有效付费 API 消费的 20%，插件开发者取得剩余利润的 40%。规则没有期限，`enabled` 是唯一运营开关。此文记录实现和接入边界。

## 已实现的资金链路

- 新用户经邀请链接注册并验证邮箱后绑定直接邀请人。链接在 API 域名设置 HttpOnly、SameSite=Lax、30 天 Cookie；后一次有效链接覆盖前一次，已有账户不能补绑。
- 普通邀请人获一次有效的 5 元奖励：累计已到账的生产环境充值减已确认退款，严格大于 10 元。退款跌破门槛追加冲回，重新达标恢复同一奖励，不叠加第二份。
- 充值只入使用余额，不计 BD 或作者分佣。每笔实际消费按扣款来源分配，赠额和收益转入的余额不分佣。本金和赠额按入账顺序消耗，并发扣款串行分配。
- 设退款和拒付后的有效付费 API 消费为 E，可信实际上游成本为 C，扣款时本金占比为 q。BD 收益 `B=E×20%`；开发者收益为 `max(E−C×q−B,0)×40%`，没有 BD 时 B 记为 0。每项按 8 位小数截取，尾差留平台。
- 100 元有效付费消费、40 元成本：BD 20 元，开发者 `(100−40−20)×40%=16` 元，平台 24 元；没有 BD 时开发者 24 元。若其中 20 元来自赠额，E=80、付费部分承担 32 元成本：BD 16 元、开发者 12.8 元。成本达到或超过 `E−B` 时开发者为 0，BD 照常计提。
- 实际成本只取 `requests.cost_cny`。估算值和缺失成本都不能当实际成本或 0。BD 收益在扣款来源确定后立即计提，不等成本；有开发者归属时，开发者部分保持 `pending_cost`，等实际成本确认后补计。已知零成本有效。
- 成本按扣款时的本金占比分摊；消费退款不退还上游成本，所以部分退款后 C×q 不变，只有 E 和 B 变小。成本修正只追加开发者差额流水，BD 金额不变。
- 请求创建时快照 BD 比例、开发者比例和开发者口径 `developer_basis`。新请求为 `profit`；schema 31 期间创建的请求为 `consumption`（开发者 35% 付费消费）；schema 30 及更早的请求为 `legacy_profit`（BD 与开发者都按扣成本后的利润）。退款、拒付和成本修正都按原快照重算，历史请求保持可审计。
- LaneHub 管理端消费日志的 `cost_source=real`、`cost_quota` 可自动回填成本；请求 ID、日志 ID、用户归属及完整性必须通过校验，多行全部为真实成本后才汇总。已记消费但成本迟到的请求继续核对，沿用原销售账单的汇率及 quota 单位。若销售 quota 同时变化，标记 `lanehub_receipt_changed` 待人工核账。DeepSeek 文本上游目前没有真实费用回执适配，这类请求的开发者收益会停在 `pending_cost`，需管理员按可信账单录入成本后才计提。
- 请求创建时快照邀请人当时的 BD 身份及作者归属；仅凭插件凭证的作者归属不可支付（schema 34）。以后调身份或插件归属不改历史。自消费不产生自身 BD／作者收益。
- 新规则关闭 Skill 固定调用费和十分钟窗口计佣，正文 Skill 标签只保留观测。每笔请求最多一个作者池；生图插件凭证归生图作者，主 Skill 不再重复取得这一池。不能可靠归属的请求不凭正文给作者计佣。
- 观察期 30 天。上月已成熟收益可按月申请人工提现，单笔至少 100 元、保留到分；分以下尾款留账。系统预留申请金额，管理员审核、转账后登记回执。取消申请原额解冻。
- 已成熟收益可从 0.01 元起 1:1 转使用余额，不可逆，也不再分佣。LaneHub 通过持久化待办入账，响应丢失转人工核对，不自动重复加额度；额度最小单位的上舍入由平台承担。
- LaneHub 待转入项在领取时重查冻结及冲销后负余额，预留已扣收益，不要求再扣一次。冻结／负余额保持待办并轮转，不阻塞其他用户。`applying` 表示已领取的外部调用，在途之后的冻结不能撤回已发出的上游操作；丢失回执仍须人工核对。
- 消费退款沿原来源比例恢复本金和赠额，累计舍入尾差归最后一个可容纳的来源。部分退款按剩余有效付费消费重算 BD 和开发者收益；全额退款冲回全部收益。所有调整追加差额流水，不改旧流水。
- 充值退款回调先冻结相关收益；管理员核对真实支付回执后登记金额。未消费退款扣回余额并检查邀请奖励；拒付沿充值来源追溯消费，冲回对应分佣。已经付出的收益形成负余额，用后续收益抵扣。
- 所有提现、转余额、邀请奖励、退款记录带幂等约束；财务操作和审计在同一数据库事务中保存。

## BD 与插件开发者邀请（schema 33）

BD 和插件开发者只能由管理员邀请、被邀请账号本人接受后开通。没有自助申请入口，管理员也不能按用户 ID 直接开通。

- 管理员在“分佣与提现 · BD 与插件开发者邀请”按已验证邮箱（大小写不敏感）或用户 ID 发起。目标必须是已启用、邮箱已验证、可登录网站的账户；已持有该身份时拒绝（`role_already_active`）。开发者邀请可附开发者名称，留空时新档案用账户名，已有档案保留原名称。
- 令牌为 256 位随机值，数据库只存 SHA-256。明文链接形如官网 `/account#invite=…`，只在创建或重发的响应中出现一次；令牌位于 URL 片段，浏览器不会把它发给服务器或写入 Referer。列表、审计和用户接口都不返回令牌或哈希。
- 有效期 7 天。同一用户同一身份最多一份待接受邀请（部分唯一索引）。过期的待接受行在读取时显示为已过期，下一次写入时落盘为 `expired`。
- 接受只认会话：令牌哈希、绑定用户、待接受状态和未过期四个条件在同一条带行锁的更新里判定，因此接受与撤销、两次并发接受、接受与过期之间只会有一个结果提交。BD 接受后 `referral_profiles.bd_active=true`，冻结状态不变；开发者接受后 `developer_profiles` 创建或更新为 `approved`，复审人记为发起邀请的管理员。
- 撤销只作用于待接受邀请。重发会撤销仍有效的旧邀请（或把已过期的旧邀请落盘为过期），再签发绑定同一用户与身份的新令牌，并以 `previous_id` 串起链路；已接受的邀请不能重发。
- 取消 BD 仍可在“邀请人、BD 与收益冻结”操作；开发者审核只允许驳回旧版待审申请或停用已批准开发者。恢复任一身份都要重新邀请。已有的 BD、已批准开发者和历史账本保持不变；旧版待审申请需管理员改为邀请或驳回。
- 审计：`role_invitation.create`、`role_invitation.revoke`、`role_invitation.accept` 以邀请 ID 为 `target_id`，记录身份、目标用户、依据和接受前的身份状态；接受事件的 `actor_user_id` 是被邀请人。`developer.review` 记录审核前后状态，`commission.profile` 记录调整前后的 BD／冻结状态。管理台写操作另有通用 `admin.operation` 记录。

邀请表 `role_invitations` 字段：id（uuid）、role（bd 或 developer）、user_id（被邀请用户）、email（创建时的小写邮箱快照）、display_name（可空）、token_hash（唯一）、reason（5–500 字）、state（pending／accepted／revoked／expired）、created_by 与 revoked_by（管理员）、created_at、expires_at、accepted_at、revoked_at、previous_id（重发来源）。检查约束保证接受时间与 accepted 状态、撤销时间与撤销人和 revoked 状态一一对应，且接受时间早于过期时间。

## 本地操作入口

用户在官网 `/#wallet` 的“邀请与收益”查看当前身份、邀请链接与邀请人数、按来源累计的分佣、逐笔流水、转余额、提现和申请记录。BD 在此处看到自己的分佣比例说明。已批准的插件开发者在 `/developer` 看到自己归属的插件、按插件／模型的用量收益，以及同一收益账户的“开发者收益账户”视图，开发者流水标注插件名称。官网 `/account` 的“身份与邀请”显示 BD／开发者状态、仍有效的待接受邀请，并在打开邀请链接后提供接受按钮。

管理员在 API 管理台 `/admin` 的“分佣与提现”发起和管理邀请、取消 BD、冻结或解冻账户、核对待办、审核提现及记录回执。该页仅 superadmin 可读写；普通网站角色和插件令牌不能调用财务管理接口。

提现收款信息由运营与用户通过已有联系渠道核对，平台仅保存人工转账回执，不在流水和审计中保存银行卡明文。每月 1–5 日审核、15 日人工转账（非工作日顺延）由运营执行，系统不发起自动银行打款。

## 启用与历史迁移

1. `db.migrate()` 在同一事务应用 schema.sql 与 commissions.sql。默认新规则关闭，历史 plugin_earnings 和 settlements 保留。已创建请求的政策快照不随开关变化。
2. 老账户默认 sources_confirmed=false，禁止猜测旧余额都是本金。先暂停新规则，确认账户无在途／待定扣费或缺失最终账单，再通过期初余额接口核对。剩余本金须对应已到账的生产充值订单，且不能超过该订单扣除历史分配及退款后的可验证金额；其余余额按不分佣余额处理。迁移应在接单暂停期间进行，尤其 LaneHub 可能存在外部消费。
3. 误启用后已消费、仍未分配来源的历史请求，在期初迁移时进入 `historical_sources_review`，保留政策及作者／BD 快照；自动核对和成本更新不能让它们重复消耗当前余额。关闭政策期间的未分配请求也同样隔离。已分配来源或已产生分佣的账户不能通过此接口重置。历史请求须根据原始来源另行人工核账，本接口只恢复后续消费的资金链路。
4. 管理台在所有历史账户（包括零余额）确认来源后才能开启新规则，否则返回 `commission_sources_migration_required`。开关影响新请求，不补算旧请求。schema 32 删除了 schema 31 的活动开始／截止时间和自动过期；当时的启用时间仍保存在 `commission.policy` 审计事件中。
5. 核对网关和 LaneHub 的销售倍率确为 2.5、输入／输出／缓存及媒体规格价格正确。本模块不自动修改渠道售价。
6. 部署后需用已授权的真实支付和账单完成验收。当前测试使用独立 gateway_test 和支付／LaneHub 替身，不代表已跑通生产打款。

## 接口

| 接口 | 用途 |
| --- | --- |
| GET /api/me/commissions | 自己的身份（BD、开发者档案）、链接、余额、按来源累计、流水（开发者行带插件名）、申请 |
| GET /api/me/role-invitations | 自己的 BD／开发者状态与仍有效的待接受邀请，不含令牌 |
| POST /api/me/role-invitations/accept | token，接受发给本人的邀请 |
| POST /api/me/commissions/convert | amount_cny + UUID idempotency_key，转使用余额 |
| POST /api/me/commissions/payouts | amount_cny + UUID idempotency_key，提现申请 |
| GET /api/account/referral/:code | 有效邀请链接并跳转注册 |
| GET /admin/api/commissions | 管理台汇总 |
| POST /admin/api/commissions/policy | enabled + reason，切换新请求规则 |
| POST /admin/api/commissions/profiles/:id | bd_active + frozen + reason；只能取消 BD 或调整冻结，开通返回 `bd_invitation_required` |
| GET /admin/api/commissions/invitations | 最近 200 份邀请及有效状态，不含令牌 |
| POST /admin/api/commissions/invitations | role + target（邮箱或用户 ID）+ reason + 可选 display_name，返回一次性链接 |
| POST /admin/api/commissions/invitations/:id/revoke | reason，撤销待接受邀请 |
| POST /admin/api/commissions/invitations/:id/resend | reason，作废旧链接并签发新链接 |
| POST /admin/api/commissions/reconcile | 重核对具备条件的待办 |
| POST /admin/api/commissions/opening-balance/:id | paid_lots + reference，核实旧余额 |
| POST /admin/api/commissions/payouts/:id | state + reference，审核／取消／登记已转账 |
| POST /admin/api/commissions/conversions/:id/resolve | result=applied/not_applied + reference，人工核对中转入账 |
| POST /admin/api/commissions/payment-refunds/:id | amount_cny + chargeback + reference，确认已发生的充值退款／拒付 |

使用已有 `/admin/api/requests/:id/charge` 录入经核实的实际成本，`/admin/api/billing/:id/refund` 处理服务退款。已经拒付的请求禁止再走普通服务退款，须人工核对，避免重复返还本金。

## LaneHub 额度调整与资金约束（schema 34）

LaneHub 的 `/api/user/quota/:id` 是增量接口（允许负 delta），没有幂等键。所有经 `lanehub_credits` 的加额度（注册赠送、补发、迁移、消费退款）和扣额度（LaneHub 充值订单退款）都按同一状态机执行：

| 状态 | 含义 | 后续 |
| --- | --- | --- |
| pending | 占位已独立提交，远程调用尚未开始 | 同一 reference 重试可接手执行；进程在调用前退出时，后台循环（约 2 分钟一次，宽限 60 秒）以 CAS 接手执行一次并完成落账；未配置 LaneHub 时不执行；管理员也可直接终止 |
| applying | 已领取并发出远程调用 | 成功转 applied；任何未知结果转 review；超过 5 分钟未收尾由后台转 review |
| applied | 已确认生效 | 需要本地落账的（消费退款、充值退款）由 `booked_at` 幂等落账 |
| review | 远程结果未知 | 只能由超级管理员核对 LaneHub 额度日志后处理，绝不自动重试 |
| cancelled | 人工确认未生效并终止 | 充值退款预留的本金退回，订单保持 refund_review 待重新登记 |

- 管理端“分佣与提现 → LaneHub 额度调整”列出 pending／applying／review 及已生效未落账的行。review 可选：确认已生效（随后自动落本地账）、确认未生效并重试一次、确认未生效并终止。每次处理都写审计并要求填写核对依据。迁移前缺少 LaneHub 用户号的历史行只能确认生效或终止。
- 旧数据迁移：有 `applied_at` 的行视为已生效并已落账；没有的行是历史中断调用，标为 review（`legacy_unconfirmed`）。
- 消费退款（LaneHub 模式）：先提交占位和退款序号，再加额度，确认生效后才累加 `refunded_cny` 并冲回作者计提。同一请求同时只允许一笔在途退款。
- 充值退款（订单 `target=lanehub`）：未消费本金部分按订单入账时的 quota/金额比例换算后扣回 LaneHub，先在本地预留对应本金并把订单置为 refund_review，确认扣回后才写 `commission_payment_refunds`。同一订单同时只允许一笔在途退款。纯拒付部分不涉及 LaneHub 额度。本次修复前已登记的 LaneHub 订单退款只写了本地 `balance_deduction_cny`，需要人工核对是否已在 LaneHub 扣回。
- 管理员补发在 LaneHub 结果未知时不写本地流水；人工确认生效后用同一幂等键重提即可补齐。补发幂等键永久有效：同一管理员、同一 key、同参数永远复用原 grant，参数不同永远冲突。键以 `wallet-grant:` 前缀存入 `admin_idempotency`，这是保留前缀，案例创建等其他路径拒绝以它开头的 Idempotency-Key；迁移把历史补发键复制进该命名空间。
- 数据库约束：`request_billing.refunded_cny <= charged_cny`，`commission_allocations.returned_cny + chargeback_cny <= amount_cny`。约束以 NOT VALID 加入，所有新写入都受检查；旧数据满足时启动即完成校验，不满足时只记 WARNING、不阻断启动。

## 插件归属的可支付边界（schema 34）

服务端没有可信的插件安装记录。桌面 bootstrap 签发的插件凭证只是使用授权，不是安装证明：

- 新客户端可在 bootstrap 请求体上报 `installed_packages`（包名数组），服务端只为这些包签发凭证，本会话其余插件凭证立即过期（不吊销，之后可续签）。上报仍属客户端声明。
- 未上报清单的旧客户端为保持已装插件可用，仍获得全部启用插件的凭证。审计 `desktop.bootstrap` 的 `installed_declared` 区分两条路径。
- 无论哪条路径，凭插件凭证产生的归属（直接使用凭证、主令牌加 `X-IPZSK-Plugin-Token`，或再加只能配合凭证使用的 `X-IPZSK-Skill-Version`）都记为 `requests.plugin_attribution_state='credential_unverified'`。插件照常可用，用量、模型白名单和任务隔离不变；`commission_snapshot` 不设开发者，旧版 `plugin_earnings` 不计提也不冲回。
- 只有 `X-IPZSK-Skill-Calls` 按后台登记的 Skill 内容哈希独立解析出插件时记为 `skill_marker`，沿用原规则。这条路不依赖凭证，出示凭证也不会增加可支付性。注意它仍是客户端上报的哈希。
- 历史请求保持 `none`，不回溯。

## Skill 接入边界

插件自行调用使用其用户专属凭证；主模型代表 Skill 调用时，通过已有 `X-IPZSK-Plugin-Token` 出示同一用户的该插件凭证，网关查验启用状态与模型白名单，客户端不能直接指定收款作者或比例。自 schema 34 起，这两种凭证归属都只记录、不可支付（见上一节）。普通正文标签、未注册 Skill 和跨用户凭证不能取得作者池。

桌面 Host 已上报 Skill 名称／内容哈希及任务边界，网关依据登记版本校验并决定归属，详见 [客户端模拟验收](COMMISSION-DESKTOP-SIMULATION.md)。插件凭证路径继续校验用户、启用状态及模型权限。组合 Skill 的多作者份额编排和跨调用总预算尚未实现；有多个作者候选时后台保留 ambiguous，不自动拆分作者池。

## 验证

`npm test` 验证单元与契约。`TEST_DB_HOST=127.0.0.1 TEST_DB_PORT=<隔离端口> npm run test:integration` 只连接 gateway_test。集成测试串行运行，避免 better-auth 跨 schema 内省与其他测试清理 schema 并发冲突。`commissions.test.mjs` 覆盖永久 20%／剩余利润 40% 规则、成本待定与修正、负利润、来源、退款、拒付、历史口径快照与迁移、观察期、幂等、并发提现、历史余额及中转响应不确定。`role-invitations.test.mjs` 覆盖邀请的邮箱大小写、令牌只存哈希、绑定账号、单次使用、撤销、过期、重发、接受与撤销并发、直接开通 BD 被拒及账本按用户隔离；`developers.test.mjs` 覆盖自助申请关闭与开发者邀请接受。
