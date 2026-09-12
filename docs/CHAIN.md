# IPZSK 全链路（注册 → 使用 → 记账 → 分成）

这份文档是**整条链的唯一真源**：谁负责哪一段、钱和 token 在哪一步被记下来、
哪些环节还缺。改动涉及链路时先更新这里。

变现模型（决定了这条链的形状）：**skill 绑定 token 消耗，token 收入给插件作者分成。**
所以每一笔请求都必须能回答三个问题：**谁发的、属于哪个插件、收了多少钱。**
任何一个答不上来，作者的分成就是 0。

---

## 仓库分工

| 仓库 | 角色 | lanehub 相关分支 |
| --- | --- | --- |
| `Icy-Cat/lanehub` | 线路矩阵 / 价目 / 额度 / 扣费 / 消费日志 —— **钱的真源** | `dev` |
| `JayceHuang/ipzsk-api-gateway` | 账号、登录、插件授权、转发、归属与记账 | `dev` |
| `JayceHuang/ipzsk`（官网） | 落地页、账户页、网页生图 | `dev`（本地，缺推送权限） |
| `JayceHuang/ipzsk-dsh-desktop` | 桌面端：登录、bootstrap、插件宿主 | 无需改动 |
| `JayceHuang/dsh-imagegen` 等插件 | 拿 bootstrap 下发的凭据打网关 | 无需改动 |

插件与 skill 本身不碰 lanehub：它们只认 `https://api.ipzsk.com/v1` 和一把
自己的凭据，网关背后换成 lanehub 对它们是透明的。

---

## 一、注册与建号

```
浏览器/桌面端 ──① 注册+邮箱验证──▶ 网关 auth
                                   └─② ensureCustomer  → users 行
                                   └─③ provisionIfEnabled
                                        ├─ lanehub 建用户（用户名 = ipz+客户 id 哈希，12 位）
                                        ├─ 签令牌（分组 = 档位，unlimited_quota）
                                        ├─ 落成 upstream_keys 行 + lanehub_accounts 映射
                                        └─ 发新人额度 ¥5（幂等键 signup:<客户 id>）
```

`provisionIfEnabled` 在**四处**调用，全部幂等，一个客户永远只有一个 lanehub 用户和一把密钥：
注册/登录（`customer-auth.mjs`）、桌面端 bootstrap、网页 session-key、第一次发请求（网关）。
放这么多处是因为任何一处单独失败都不该让客户卡住；放少了则会出现「注册完在后台查不到、
余额显示 0」——而「注册送 5 块」是注册页答应过的。

折算汇率取 lanehub 现行的 `PaymentUSDRate`，配置值只兜底。**历史余额迁移不走这条路**：
`scripts/lanehub-migrate.mjs` 要求显式指定汇率，一批客户必须按同一个数折算。

## 二、拿到能打 /v1 的凭据

| 入口 | 接口 | 凭据形态 |
| --- | --- | --- |
| 桌面端 | `POST /api/me/desktop/bootstrap` | 一把主令牌 + **每个插件一把**（`access_tokens.plugin_id`） |
| 网页 | `POST /api/me/web/session-key` | 一把绑登录会话的令牌 |
| 开发者自用 | `POST /api/me/token` | 长期 Key（最多 20 把，可撤销） |

前两种都按 `auth_session_id` 唯一：刷新只轮换同一行，**退出登录立即失效**。
插件那把是链路的关键——请求一进来就知道属于哪个插件，才有后面的分成。

## 三、一次请求

```
插件/网页 ──Bearer ipz_…──▶ 网关 /v1/*
   ① 认令牌 → 拿到 user_id / plugin_id
   ② 插件模型白名单校验（plugins.allowed_models）
   ③ 写 requests 行：plugin_id、plugin_publisher_ref、
      plugin_owner_user_id、plugin_share_bps ← **发生时快照**，事后改归属不影响历史账
   ④ lanehub 模式：不预扣、不改写参数、**不换线**，用这个客户自己的 lanehub 令牌打一次
   ⑤ 回包：记 input/output/total_tokens、usage_state、upstream_id
```

**不换线是硬约束**：换线会改变这一单的价钱。自动选线只在下单前发生，失败就提示用户手动换。

`requests.upstream_id` 在 lanehub 模式下存的是 lanehub 回的 `X-Oneapi-Request-Id`，
**不能被响应体里的 id 覆盖**（那是上游的上游的 id）——扣费就是靠它反查回来的。

## 四、钱：谁扣、扣多少、怎么回来

| 环节 | 位置 | 说明 |
| --- | --- | --- |
| 定价 | lanehub | `provider_price_catalog`，两轴（质量 × 分辨率），DB 优先于代码 |
| 报价 | lanehub `POST /v1/quote` | 返回 `quote_id` + 金额；提交时带 `X-Quote-Id` 校验，改了影响价钱的参数会被拒 |
| 扣费 | lanehub | 从客户自己的额度里扣，写一条消费日志（`quota` + `request_id`） |
| 回写 | 网关 `lanehub-charges.mjs` | 按 `request_id` 反查消费日志 → `request_billing` 一条 `settled` 行 |
| 汇率 | lanehub `PaymentUSDRate` | 自动同步真实汇率；回写时取**对面现行的**值（差 4% 就是分成差 4%） |

回写跑在 120 秒的定时器上，幂等键是 `request_id`：

- 查到日志 → `settled`，`charged_cny` = 客户实扣（E2E 验到分毫不差）
- 查不到且完成不到 10 分钟 → 不动，下一轮再来
- 查不到且已超 10 分钟 → `released` 终止重试（失败的请求本来就没扣钱）

媒体请求要等任务终态才回写，而且**失败/取消的任务直接落 `released`，根本不查日志**：
lanehub 退款写的是一条系统日志，原来那条消费日志还在、quota 还是全额——照着它记账
会把已退款的失败任务算成收入，还给作者分了钱。

## 五、分成与结算

### 计提

`plugin_earnings` 是**作者应得的唯一真源**：结算时计提一行，退款时再记一行负数。
报表和结算单都从它汇总，不各自按 `charged_cny` 再算一遍——两份口径只要差一点，
打给作者的钱就是错的。

```
计提 = (charged_cny - refunded_cny) × plugin_share_bps / 10000
```

比例和归属取 `requests` 上的**发生时快照**，改当前归属不会改写历史收益。
写入点两个，都在结算的同一个事务里：`billing.debit()`（本地）和
`recordLanehubCharge()`（lanehub 模式）——分开写会出现「扣了钱但没计提」的窗口。

### 退款

`POST /admin/api/billing/:id/refund`（superadmin），一个事务里做三件事：

1. `refunded_cny` 累加 —— `charged_cny` 不动，它是「当时收了多少」的事实
2. `plugin_earnings` 记一条负数，按同样的比例冲回
3. 钱真回到用户手里：lanehub 模式加回对面额度（幂等键 `refund:<请求 id>:<序号>`），
   本地模式写 `wallet_entries`

退不出比收的多（`refund_exceeds_charge`）。

### 结算单（人工打款的凭据）

`settlements` + `plugin_earnings.settlement_id`。状态机：

```
draft ──freeze──▶ frozen ──pay──▶ paid
  └──void──▶ void（释放明细，可重新出单；已打款的不能作废）
```

| 接口 | 作用 |
| --- | --- |
| `GET /admin/api/settlements` | 单列表 + **还没出单的计提合计**（按作者分组） |
| `POST /admin/api/settlements` | 起草：把区间内还没归属任何单的计提圈进来 |
| `GET /admin/api/settlements/:id` | 单详情 + 明细 |
| `POST /admin/api/settlements/:id/freeze` | 冻结（重算一次再锁金额） |
| `POST /admin/api/settlements/:id/pay` | 登记人工打款，`paid_note` 必填（转账单号） |
| `POST /admin/api/settlements/:id/void` | 作废，释放明细 |
| `GET /api/me/developer/settlements` | 作者自己看（要浏览器登录态） |

两条关键语义：

- **同一条明细只能进一张单**（`settlement_id IS NULL` 才圈），重复出单只会是空单
- **冻结之后不回溯**：之后发生的退款作为一条负数计提落到下一张单里 ——
  已经打出去的钱不能被事后改账

打款本身是人工的：没有提现流程、没有付款流水，`paid_note` 就是凭据。

## 六、充值与余额

- 兑换码 → `wallet_entries`（本地流水）→ 立刻搬到 lanehub（幂等键 `voucher:<兑换码 id>`），
  失败由定时扫描补上
- `GET /api/me/wallet`：lanehub 模式下读对面的额度（`source: "lanehub"`），
  本地那张表只剩充值流水

---

## 切换与回滚

```
node scripts/lanehub-switch.mjs status   # 四项前置检查
node scripts/lanehub-switch.mjs on
node scripts/lanehub-switch.mjs off      # 立刻回滚，不做检查
```

前置检查挡的都是「跑起来才发现、而发现时钱已经错了」的：lanehub 账户缺失、
还有余额没迁走的客户、`billing_policy` 没关（两边都预扣 = 同一笔钱冻两次）、
还有没结算的预扣。

## 验证这条链

| 层 | 命令 | 覆盖 |
| --- | --- | --- |
| 单元 | `npm test` | 折算、幂等、日志缺失分支、汇率兜底 |
| 整链（真库 + 假 lanehub） | `test/lanehub-chain.test.mjs` | 建号→插件归属→token→回写→分成报表→余额 |
| 真钱 E2E | `node scripts/lanehub-e2e.mjs --spend` | 真 lanehub + 真上游，报价 = 实扣 = 回写 |

---

## 还缺的

1. **打款流程**：结算单只到「登记已打款」为止——没有提现申请、没有付款流水对接。
   运营后台也还没有结算单页面，目前只有接口。
2. **skill 粒度**：记账最细到插件（`plugin_id`），一个插件里多个 skill 分不开。
   要分得开，插件调用时得带 skill 标识，网关再落一列。
3. **七个上游没验过**：只有 APIMart 用真 Key 跑通过；优云 / 优云H3 / AutoDL
   价目表是空的，它们的模型会被价格闸拒掉。
4. **官网仓库推送权限**：`dev` 分支只在本地。
5. **桌面端 PPT 代理**：还指着官网的 `/api/v1/chat/completions`（现已改为纯转发），
   桌面端改直连后那个文件可以删掉。
