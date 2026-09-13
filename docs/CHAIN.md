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

### 归属：两条来源

| 谁发的请求 | 怎么归属 |
| --- | --- |
| 插件自己发（生图这类） | 用插件凭据作 `Authorization`，天然归属 |
| agent 主循环发（**skill 型插件**：提示词是它给的，请求却是主循环发的） | 主令牌 + `X-IPZSK-Plugin-Token: <该插件的凭据>` |

第二条为什么要**出示凭据**而不是「头里带个 plugin_id 就认」：插件作者按归属分钱，
只认 id 等于让任何人指定收款人。凭据还必须属于同一个用户（`plugin_token_denied`），
所以也不能把消费记到别人头上。

桌面端的接入点：skill 激活期间，把 `plugin_configs` 里那把 `credential` 放进这个头。
（网关侧已就绪并有测试；桌面端 harness 侧尚未接。）

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

### 两种计提，两种计量单位

| 谁 | 按什么计 | 为什么 |
| --- | --- | --- |
| 用户 | **token**（lanehub 实扣） | 那是真实成本 |
| 提示词型 skill 的作者 | **调用次数** × 单价 | 见下 |
| 自己发请求的插件（生图那类） | 实扣 × 分成比例 | 它的每次调用就是一次完整的活 |

**为什么不按 token 分给 skill 作者**：实测一次 agent 调用 17644 token，同样一句话裸调用
只要 56 —— 99% 的消耗是 harness 的系统提示词、工具定义和工作区上下文，跟 skill 作者无关。
按 token 分等于让作者分走平台基础设施产生的消耗；还带出一串没有标准答案的问题
（一轮加载两个 skill 怎么分、加载后第五轮还算不算、作者故意让 skill 常驻套利）。
按次数计，这四个问题一次消失，作者的收入也不再随用户上下文长短波动十倍。

市面上的做法支持这个判断：SKILL.md 类市场（Agensi 等）走一次性买断；OpenRouter 做了
完整的 app 归属却刻意不与收入挂钩；真正按用量分成的（Apify、MCP server）都是
「作者的代码在跑」，归属天然成立。

### skill 归属：扫请求体，不靠客户端声称

每个被加载的 skill 都以 `<skill_content name="...">` 出现在请求里
（`@deepseek-ai/dsh-skill` 的 `renderSkillContent`，模型自主加载和用户显式调用共用同一个渲染），
所以网关从**它本来就要计费的那个请求**里直接读得出这一轮用了哪些 skill。

这比让客户端报请求头好在三处：是**可证实的事实**（skill 内容确实在上下文里，
用户为它付了 token）、客户端一行不用改、harness 不用打补丁。
`X-IPZSK-Skill` 头保留作备用，给不经过 harness 的客户端显式上报。

代价是依赖 harness 的渲染格式：哪天它改了标签名，我方会**漏记**（不会错记），
从「某个 skill 的调用数突然归零」看得出来。

### 分成的前提是登记

skills 是本地文件，谁都能往 `~/.../dsh-home/skills/` 扔一个。所以只有在
`plugin_skills` 里登记过、且归属到某个有 owner 的插件的 skill 才计提；本地随手放的
照常能用，只是不产生任何计提。首次登记确权，之后请求里报什么都只做匹配、不改写归属
（这条借自 OpenRouter：元数据只在注册那一刻接受）。

单价在 `plugins.price_per_call_cny`，**默认 0**：管道先跑起来，等真实调用分布看清楚了
再定价。单价为 0 时仍然记一行 —— 「这次用了哪个 skill」本身就是要统计的事实。

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
| 变现链真钱 E2E | `node scripts/skill-chain-e2e.mjs` | 从 HTTP 入口进：提示词型 skill → 归属 → token → 扣费补记 → 作者计提 → 结算单 |

2026-09-13 实跑（APIMart 的 `deepseek-v4-flash`，经 lanehub 转发）：

```
用量        入 11 / 出 40 / 共 51 tokens
lanehub 扣  quota 13  →  ¥0.00017440（× 6.7078 / 500000）
作者计提    ¥0.00005232 = 实扣 × 30%
结算单      ¥0.00005232 / 1 条明细，已冻结
13/13 通过，连跑两次幂等
```

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
