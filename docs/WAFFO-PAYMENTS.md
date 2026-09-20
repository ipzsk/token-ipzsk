# Waffo 充值接入

## 已配置的商品（测试与正式环境）

| 额度 | 商品 ID |
| --- | --- |
| ¥10.00 | PROD_2jEkFZu7DbiJRrdvYWTnlG |
| ¥50.00 | PROD_2Eg60lOL3vticuSl1RTe5h |
| ¥100.00 | PROD_15jMXdfeNH0v5s1pKrnjgo |

一次性购买，不自动续费。三档商品已于 2026-09-19 从测试环境发布到正式环境，商品 ID 保持不变。测试配置位于本地 `ops/waffo-test.json`，正式配置位于本地/服务器 `ops/waffo-prod.json`，均不含密钥；两份运行配置不提交 Git，由维护者单独保管。网站余额、档位和消费明细使用人民币显示。
官方 SDK 固定为 @waffo/pancake-ts 0.22.0。该版本标注 CNY 一次性订单支持微信；支付方式以 Waffo 实际收银台及商户权限为准。

## 账户与订单

- 账户页调用 `GET /api/me/payments/options` 获取服务端认可的档位。
- `POST /api/me/payments/checkout` 需要已验证的登录会话及 UUID `Idempotency-Key`，body 仅使用 `pack`。
- 服务端固定商品、金额和登录用户，以 authenticated checkout 的 buyerIdentity 和 orderMerchantExternalId 关联订单。
- `buyerEmail` 使用登录账户邮箱（去空格、小写），缺失或无效时返回 `payment_email_unavailable`，不创建订单；前端不能覆盖邮箱、金额、身份或账单国家。
- `billingDetail` 为 `{ country: 'CN', isBusiness: false }`，默认简体中文。Waffo 会根据账单国家限定中国支付市场，用户不能在收银台切换支付市场。成功后返回首页 `/?payment=return#wallet`；原账户页回跳提示继续有效。
- 当前 SDK 0.22.0 的 CNY 一次性订单支付方式为微信；API 枚举没有 `alipay`。不发送虚构的支付宝参数，也不在网站显示可用的支付宝付款按钮。商户支付宝提现和买家支付宝付款是不同能力。
- 返回结账 URL 仅发给发起请求的登录会话，不写日志/数据库。私钥仅从 WAFFO_PRIVATE_KEY_FILE 读取。
- `GET /api/me/payments/orders` 只显示本人的最近订单。支付返回 URL 不改变余额。
- Webhook: `POST /api/payments/waffo/webhook`，订阅 order.completed、refund.succeeded、refund.failed。
- 用原始请求体验签，限定商店及环境，再向 Waffo 查询订单复核用户、商品、状态、金额和币种。
- 原始 Webhook 不保存；只保存事件 ID、订单 ID、内容哈希及审计记录。事务成功后返回 200。
- 正式支付由每 5 秒执行的工作器入账；测试事件永远只进入 test_completed，不写 wallet_entries，也不调用 LaneHub 加额度。
- 测试入口仅管理员登录可见；未配置 Waffo 时在线支付入口隐藏，用户无法付费充值，需等正式支付开通。激活码发行、导出、分配、兑换和补账功能均已删除。

## 注册赠送与历史数据

新用户完成注册及邮箱验证后，赠送 ¥5.00，每个用户仅一次；重复登录不重复赠送。服务器统一使用 SIGNUP_BONUS_CNY=5，旧 LANEHUB_SIGNUP_CNY 环境变量不再覆盖该规则。已有用户不补发、不清零。

旧兑换码表和关联字段只作历史账目存档，不提供可操作入口；已入账余额、消费流水和审计记录保持不变。旧加密密钥不再创建、挂载或读取，部署时无需删除服务器上原有密钥文件。上线前应核对是否存在历史已兑换但未到账的记录，单独人工核账，不自动重复加款。

## 异常和退款

LaneHub 的加额度接口不提供上游幂等键。请求提交后的超时、崩溃或结果不明必须进入 review_required，不能盲目重试加额度。
管理员从 `GET /api/admin/payments` 查看订单及原因，用订单 UUID 对照 LaneHub 的充值备注核对到账情况。当前不提供自动重试人工核对订单的接口。

退款成功事件将订单置为 refund_review；尚未发额度的订单停止发放。已发放额度保留原始充值流水，待管理员核实退款金额与已消费额度后处理。
这一步不会自动扣回额度或自动冻结整个用户账户。正式上线前必须落实退款处理流程；尤其不能把“有退款记录”等同于“已自动冲销钱包”。

## 本地测试

Node 24+，npm。新增生产依赖已获用户批准。

```sh
npm ci --ignore-scripts
npm rebuild skia-canvas
npm test
# 用本地隔离的 gateway_test 数据库；测试会创建并最终删除自己的随机 schema。
TEST_DB_HOST=127.0.0.1 TEST_DB_PORT=55439 npm run test:payments
```

测试口令由环境安全注入，不使用生产数据库。支付专项覆盖原文验签、错金额/错用户/错商品、重复/并发回调、事务失败重试、测试与正式隔离、LaneHub 不明结果、退款乱序。

`ops/waffo-check.mjs` 在测试环境检查商品价格；可选 `--checkouts` 创建短期测试收银台会话，不发起付款，不输出令牌。

## 正式配置（2026-09-19）

- Waffo 商店设置显示所有激活步骤已完成，可以接收正式付款。提款账户的具体设置未在本轮变更或验收。
- 正式 Webhook ID：`fda45a5c-6ffe-40f2-b7c7-5adbd8a623a2`，地址 `https://api.ipzsk.com/api/payments/waffo/webhook`，订阅 `order.completed`、`refund.succeeded`、`refund.failed`，`testMode=false`。
- 服务器 `/home/ubuntu/api-gateway/ops/waffo-prod.json` 只读挂载为 `/run/waffo/config.json`，`WAFFO_CONFIG_FILE` 指向该容器路径，配置 `mode=prod`。
- 正式私钥保存在服务器 `secrets/waffo-production-key.pem`，权限 600、属主 UID 1000，只读挂载为 `/run/secrets/waffo-production-key.pem`，`WAFFO_PRIVATE_KEY_FILE` 指向该路径。私钥不进入镜像、代码仓库、日志或前端。
- 只为网关追加上述两项环境变量和两项挂载；保留服务器其他 Compose 配置及 override，未替换数据库、LaneHub 或 Caddy。切换前的配置备份位于 `/home/ubuntu/ipzsk-waffo-prod-20260919-1501-backup`。
- 容器内正式 API 校验通过：商店 active、三个商品均 active 且人民币价格匹配、回调唯一且事件匹配、订单复核所需 GraphQL 字段存在。网关 healthy，未登录支付接口及无签名回调均返回 401。
- 已从正式网关创建一条 5 分钟有效的 ¥10 收银台验证会话（部署检查身份，无真实用户信息）；仅检查会话和跳转域名，不输出访问令牌、不打开付款页、不提交支付，也未给用户加款。
- 本轮单元测试 143 项、隔离数据库支付/钱包/注册测试 31 项、前端测试 9 项通过。测试未对生产用户发放额度或代用户支付。

## 仍需人工验收

1. 用本人已验证账户从网站账户页发起一笔 ¥10 真实充值；付款由本人完成。核对 Waffo 完成订单、Webhook 投递成功、IPZSK 订单 `credited`、LaneHub 实际额度到账，并检查只入账一次。当前不能将配置完成视为真实支付到账已经验收。
2. 完成正式退款通知与人工核对演练。退款后需核实用户已消费额度，并人工处理余额；当前没有自动扣回余额功能。
3. 沙盒付款到公网回调的完整链路仍待验收；已有隔离测试覆盖测试事件不发放真实额度。

本分支基于与服务器部署标记一致的 86e8985。旧目录 jayce_blog/services/api-gateway 与独立主工作区均有历史或未提交变更，因此支付代码使用独立工作树 ipzsk-api-gateway-waffo。
服务器仍可能有未提交变更，生产部署前必须逐文件核对差异，避免覆盖。官网改动位于 /Users/jaycehuang/Projects/ipzsk/account.html 和 account.js。

Waffo 持有并按商户协议结算实际款项；IPZSK 与 LaneHub 保存用户可消费的服务额度，两者需要按订单对账。

## 首页账户区与收银台预填（2026-09-20 已发布）

官网新增“余额与账单” Tab，点击后显示余额、充值和近期消费，默认首页仅展示功能介绍。消费来源为本人 `/api/me/usage` 的实际扣款字段；完整分页消费在账户页。共享前端辅助脚本为 `billing-ui.js`。
原支付代码已传 `buyerEmail`，本次补充校验与 SDK 传输测试，并新增中国账单参数；尚未在真实收银台复现或验证用户所见邮箱空白的原因，不能以本地测试代替上线验收。
官网新增脚本、样式和后端结账参数已一起发布；仅保留微信支付，充值档位为人民币 10 / 50 / 100 元。没有数据库迁移、余额变更、真实支付或自动退款操作。
官方依据：[创建收银台会话](https://docs.waffo.ai/api-reference/endpoints/orders/create-checkout-session)、[买家付款与商户提现](https://docs.waffo.ai/mor/supported-countries)。

官网部署为 `dpl_EsAfVqfwTwBsujTZVxHMLMu45rvR`，正式地址为 `https://www.ipzsk.com/#wallet`。网关只更新 `src/payments.mjs`，新镜像为 `ipzsk-gateway:home-20260920-jtbygo`；旧镜像保留为 `ipzsk-gateway:rollback-home-20260920-jtbygo`，旧支付源码备份位于服务器 `/home/ubuntu/ipzsk-home-backup.G3VTMg/payments.mjs`。保留原生产 Compose 配置、密钥挂载、数据库及其他服务。

本轮验证：前端 15 项测试、网关 144 项单元测试通过；六个官网运行文件与正式域名内容哈希一致；网关健康接口返回 200，匿名支付选项和消费记录接口返回 401。真实收银台邮箱/国家展示及支付到账闭环仍待本人试充验收。完整发布记录见官网仓库 `docs/releases/2026-09-20-home-wallet.md`。

后续仅前端修正 Tab 切换，正式部署更新为 `dpl_GJFWkwXn8m8t7YmHwxK46ipN1ciy`；网关未再修改或部署。见官网仓库 `docs/releases/2026-09-20-wallet-tabs.md`。
