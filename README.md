# IPZSK API 网关

IPZSK 平台后端：号池调度、统一账户、模型代理、钱包计费、插件审核与开发者用量归属。

源码仓库：`JayceHuang/ipzsk-api-gateway`。本地目录：`/Users/jaycehuang/Projects/ipzsk-api-gateway`。服务器目录仍为 `/home/ubuntu/api-gateway`。

Codex 分工与操作步骤见 [Codex 开发执行手册](docs/CODEX-DEVELOPMENT.md)，开发入口见 [开发指南](docs/DEVELOPMENT.md)，AI 协作规则见 [AGENTS.md](AGENTS.md)。下文包含历史追加记录，当前行为请结合较新的专门文档和源码核对。

独立仓库中的 Node.js 服务，管理 APIMart 号池、账户余额、用户访问凭证和文本调用用量。前端使用原生 HTML/CSS/JavaScript，后端模块为原生 ESM，避免增加前端构建链。数据库使用 PostgreSQL，入口使用 Caddy。

## 功能

- 管理员登录、12 小时会话、同源写请求检查、登录限流。
- 上游账户分组，Key 新增/启停/模型配置，账户与 Key 两级并发限制。
- 用户创建、停用、限流与访问凭证轮换；凭证完整值只显示一次。
- OpenAI 格式 `/v1/chat/completions`、`/v1/responses` 与 Anthropic `/v1/messages`，支持原生工具调用和 SSE；`/v1/models` 返回已开放模型。
- 图片/视频异步生成与用户隔离的 `/v1/tasks/:id` 查询；`/v1/audio/transcriptions` 支持最大 25 MB 的音频文件，返回 JSON、纯文本或字幕。
- 输入/输出/总 token、请求归属、状态、耗时、上游尝试记录。
- 账户去重的余额同步；区分未知余额、无限 Key 额度、过期快照。
- 查询筛选、分页和最多 10,000 行 CSV 导出，CSV 单元格公式防护。
- Docker 持久化、日志轮转、数据库备份脚本和每日 systemd 定时器。

已移除激活码充值，保留新用户一次性赠送 5 元；Waffo 在线充值实现及上线前检查见 [支付接入](docs/WAFFO-PAYMENTS.md)。token 统计不等同于财务账本。新增工作台协议已通过隔离环境测试，正式环境尚未发布；生产模型仍须在号池中显式开放。仅部署一个网关进程；内存队列不能用于多副本部署。

## 本地检查

```sh
npm ci --ignore-scripts
npm rebuild skia-canvas
npm test
```

集成测试需要独立的 `gateway_test` PostgreSQL 数据库，应用角色必须有创建 schema 的权限。每次测试创建随机 schema，并在结束时删除该测试 schema。绝不使用生产 `gateway` 数据库作为测试目标。

```sh
# TEST_DB_PASSWORD 由本地安全方式注入，不写到仓库。
TEST_DB_HOST=127.0.0.1 TEST_DB_PORT=5432 npm run test:integration
```

## 服务器部署

工作目录 `/home/ubuntu/api-gateway`。部署只上传本目录源码、锁文件和运维文件，禁止上传或覆盖已有 `secrets/`、`backups/`。

```sh
python3 ops/prepare-secrets.py
sudo docker compose up -d --build
sudo docker compose ps
```

准备脚本仅生成缺失的随机凭证，不打印或覆盖已有凭证。首次运行将先前单独保存的 APIMart 凭证移至 `secrets/upstream/apimart-primary.key`，容器启动时自动导入；默认仅开放 `gpt-4o-mini`，其他模型在号池设置中显式添加并联调。

- 管理入口：`https://api.ipzsk.com/admin`
- 管理员用户名：`admin`
- 初始随机密码：服务器 `secrets/admin-password`，由管理员在自己的终端查看。
- 应用数据库密码：`secrets/db-password`。
- 数据库管理员密码：`secrets/db-admin-password`，与应用密码独立。
- 上游 Key 文件：`secrets/upstream/*.key`，文件权限 600，目录 700。

网关容器以 UID 1000 运行，与服务器 ubuntu 用户匹配。上游凭证目录可写，以支持面板录入；应用源码只读，其他秘密文件只读挂载。数据库无宿主机端口，网关的 3000 端口仅绑定宿主机回环地址，80/443 由 Caddy 对外服务。

DNS A 记录 `api.ipzsk.com` 应指向 `43.135.34.238`，腾讯云防火墙放行 TCP 80/443。Caddy 自动申请证书，HTTP 自动跳转 HTTPS。初次证书申请可能需要短暂等待。

## 客户端接入

在面板“用户管理”创建用户，将生成的平台凭证交给对应用户。客户端 Base URL 使用 `https://api.ipzsk.com/v1`，API Key 使用平台的 `ipz_` 凭证。上游 APIMart Key 不发送给客户端。

```http
POST /v1/chat/completions
Authorization: Bearer <平台用户凭证>
Content-Type: application/json
Idempotency-Key: <本次业务请求的唯一标识>

{"model":"gpt-4o-mini","messages":[{"role":"user","content":"你好"}],"stream":true}
```

流式请求自动附加 `stream_options.include_usage=true`。默认最大输出 4096 token，允许显式指定不超过 32768 的上限；整个请求最长 180 秒。模型未返回 usage 时显示“用量待核实”，不会用零冒充真实消费。

幂等键按用户隔离。同键重试返回 409 和原 request_id，不重放上游调用，也不缓存用户正文以重放响应；客户端应查询 `/api/me/usage` 确认结果。成功、失败和结果不明确的请求均保留记录。当前实现采取保守策略，不自动重试已提交的上游请求。

账户/Key 并发初始为 3，不代表 APIMart 确认的额度。等待队列最多 30 个，等待不超过约 15 秒。余额每 2 分钟同步，调用完成后合并触发约 5 秒后的刷新；超过 10 分钟无成功余额快照的渠道暂停接收新请求。

余额以 APIMart 原始单位显示。上游账户累计消费可能包含其他客户端和接入前消费，不能归因到本站用户。本网关只用响应 usage 统计 token，不用账户余额差额计算单条请求费用。

## 备份和恢复

```sh
sudo bash ops/backup.sh
sudo install -m 644 ops/ipzsk-backup.service /etc/systemd/system/ipzsk-backup.service
sudo install -m 644 ops/ipzsk-backup.timer /etc/systemd/system/ipzsk-backup.timer
sudo systemctl daemon-reload
sudo systemctl enable --now ipzsk-backup.timer
```

每天中国标准时间 03:15 创建只对管理员可读的 PostgreSQL 自定义格式备份，并校验归档目录。默认保留备份，不自动删除。定期检查磁盘容量。

恢复应先创建独立的空数据库，再用 `pg_restore --no-owner --no-privileges --exit-on-error` 导入指定备份，验证用户、Key 元数据与请求记录完整后再考虑切换。不要直接恢复覆盖正在运行的生产数据库。

数据库备份不包含上游秘密文件；`secrets/` 需要单独受控备份。同机备份无法抵御主机丢失，异机备份目标尚待指定。正式收费前需完成异机备份和恢复演练，并增加余额预留、结算和对账逻辑。

## 维护

```sh
sudo docker compose ps
sudo docker compose logs --tail=50 gateway
sudo docker compose exec -T db psql -U postgres -d gateway
```

不要导出完整环境变量、容器详细配置、请求授权头或秘密文件到聊天/日志。服务重启会将遗留排队/处理中记录标为待核实，不自动补发请求。

### 人民币余额字段

按账户所有者确认的口径，APIMart 的 `remain_credits` / `used_credits` 分别记录人民币剩余余额和累计消费，单位为元。面板保留两位小数；数据库保存接口返回精度。同时保留 `remain_balance` / `used_balance` 原始值，旧快照没有 credits 的保持为空，不推算历史人民币余额。Key 返回 `-1` 且未设独立限额时展示“未设独立上限”，可用资金以所属账户余额为准。

### 逐笔扣费

调用记录及 CSV 包含 `cost_cny`（人民币元）、`cost_reference`（核对依据）和 `cost_recorded_at`。金额为空表示尚未核实，不能按零元计。管理员点击请求 ID，可按 APIMart 逐笔账单录入实际扣费；金额支持最多 8 位小数，修改前后金额及依据写入审计日志。录入操作只记账，不发起付款或上游调用。

当前聊天响应未返回单次扣费，API Key 无法访问已尝试的账单查询接口，尚未实现自动回填。需要 APIMart 提供可授权访问、可按上游请求编号匹配的账单接口后再接入；禁止以账户余额差额作为某次调用实际扣费。历史测试请求保持待核实。

GPT 文字请求会使用 2026-09-06 APIMart 价目表快照自动计算 `estimated_cost_cny`，与实际费用 `cost_cny` 分开。`pricing_details` 保存缓存拆分、单价、档位、版本及假设，CSV 可导出。完整 56 个模型 ID / 62 档价格与复算说明见 [GPT-PRICING.md](docs/GPT-PRICING.md)，部署后的阅读入口为 `/admin/pricing.html`。缺失价格或不支持的用量保持待核实；已有历史 token 可显式运行 `ops/backfill-text-estimates.mjs` 按当前价格补算，旧缓存缺失会保留假设提示。

图片和视频任务会保存上游最终状态中的 `credits_cost`，本账户按人民币元记账；不使用不同单位的 `cost`。客户端查询任务时立即入库，后台也会在启动时及每 2 分钟补查缺少金额的任务（每批最多 20 条）。只接受匹配任务 ID 的最终结果及非负有限金额；重复查询不会重复记账，也不会覆盖已有人工金额。自动记录以 `apimart:task:…:credits_cost` 标识来源，并写入审计。

### 注册赠额与在线充值

新用户完成注册与邮箱验证后获得 5 元（500 点），每人仅限一次。重复登录不赠送，已有用户余额与历史流水不变。
账户页使用 Waffo 在线充值，固定 10 / 50 / 100 元档位；生产开通前须完成 [支付接入检查](docs/WAFFO-PAYMENTS.md)。
用户端及管理端发码、导出、分配、兑换、作废和定时补账逻辑均已删除，旧接口返回 404。
`GET /api/me/wallet` 保留用户自己的余额与最近 30 条流水；后台“入账流水”保留历史记录。
旧兑换码表及外键仅作账目存档，不清零余额、不删除历史数据；旧加密密钥不再用于运行服务。

### 邮箱注册与登录

Better Auth 1.7.2 提供六位邮箱验证码登录，首次验证成功创建用户。钱包、充值记录和 API 凭证关联稳定用户 ID，邮箱用于身份验证；现有手工创建的用户不会自动合并。普通用户会话与管理员会话隔离。验证码有效期 5 分钟，最多尝试 5 次，数据库保存哈希；同邮箱发送间隔 60 秒、每天最多 20 次，并有 IP 和全局限流。

`/account` 支持登录、退出、查看自己的钱包和调用统计、在线充值、生成或重置 API 凭证。完整凭证只显示一次，重置立即撤销旧凭证。管理台显示邮箱注册总数、今日注册数、启用注册用户及手工创建用户数，并显示邮件配置状态。

邮件通过腾讯云 SES API 的审核模板投递，配置方法见 [ops/email/SETUP.md](ops/email/SETUP.md)。未配置时发送接口返回 503，页面明确提示暂不可用，不会假装发送。配置就绪仅代表字段齐全，实际送达须用可查收的邮箱验证。

`secrets/customer-auth-secret` 由准备脚本生成并只读挂载，禁止覆盖。备份同时保存 `.customer-auth-secret`，已配置邮件时保存 `.mail-settings`，权限均为 600。认证表以 `auth_` 开头，启动时执行 Better Auth 数据库迁移。生产代理仅信任当前 Caddy 容器地址及本机回环地址。


### 主站账户入口（2026-09-05）

账户页面源码迁至 `/Users/jaycehuang/Projects/ipzsk/account.html`、`account.js` 和 `account.css`，发布到 `https://www.ipzsk.com/account`。API 域名 `/account` 仅跳转；认证接口和数据库继续运行在腾讯云。仅对 `https://www.ipzsk.com` 的用户接口允许凭证跨域，管理员接口不开放跨域。Cookie 仍仅属于 API 域名，主站通过 credentials: include 发送同站请求。

## 账户架构改造（2026-09-07）

现支持同一账户多把独立平台凭证、有效期和单凭证限速；新增凭证不吊销旧凭证。新增请求保存平台凭证归属。管理台“账户与账单”提供每日统计、凭证、流水、收费核对和独立管理员。完整说明见 [账户与计费架构](docs/ACCOUNT-ARCHITECTURE.md)。

收费默认关闭，超级管理员确认售价后可开启。开启后仅接受已定价、指定最大输出 token 的文字请求，先冻结、后结算；媒体定价未配置时拒绝调用。邮箱验证码仍需要 SES 模板审核完成。

### 网站密码登录（2026-09-07）

网站默认邮箱 + 密码登录，注册和找回密码分开。注册验证通过后才绑定业务账户；密码重置撤销已有会话。邮件服务未开放时，已有已验证账户仍可用密码登录；注册和找回密码暂不可用。旧验证码登录端点关闭。64 项测试通过。

### 桌面登录即用（2026-09-07）

`POST /api/me/desktop/bootstrap` 仅接受已验证账户的登录会话，返回会话绑定的模型调用凭证、可用聊天模型和默认模型。模型目录定义在 `src/desktop.mjs`，与启用号池取交集，默认优先 `gpt-5.6-sol`，其次 `gpt-4o-mini`。桌面端使用内置 API 地址，无需手动复制 Key。

schema 9 为 access_tokens 增加可空唯一 `auth_session_id`；一个登录会话对应一个桌面凭证记录，重复初始化轮换秘密，不影响其他会话或普通 API Key，不占普通 Key 的 20 个配额。网关在入口与排队后的上游提交前验证关联会话；退出、密码重置、用户禁用、凭证撤销和过期都能阻止后续调用。原请求的 token_id 保留，账单归属继续使用同一业务用户。

## lanehub 模式（额度真源在 lanehub）

开启后，这一侧不再预扣、不再改写字段、不再换线，请求带着**该客户自己的 lanehub 令牌**
转发过去；额度、价目、扣费、账本全在 lanehub。这一侧保留账号、登录、插件授权、
桌面端 bootstrap、并发闸与幂等边缘。

环境变量：

```
LANEHUB_BASE_URL=https://lane.example      # lanehub 地址
LANEHUB_ADMIN_TOKEN=...                    # lanehub 的管理令牌（建号、加额度用）
LANEHUB_ACCOUNT_ID=<uuid>                  # 后台里那个 provider_type=lanehub 的上游账户
LANEHUB_USD_CNY=7                          # 折算汇率，显式给，不从对面实时取
LANEHUB_QUOTA_PER_UNIT=500000              # lanehub 的 1 美元 = 多少 quota
```

### 一个客户一个密钥

客户**注册/登录当场**就会在 lanehub 建好账号并签一个令牌，映射表的主键
就是客户 id——一个客户永远只有一个密钥。桌面端 bootstrap 和第一次发请求各会再备一次，
三处都幂等（同一个 `provisionIfEnabled`）。不等到首单才建号，是因为在那之前
新用户在后台查不到、余额显示 0，而「注册送 5 块」是注册页答应过的。

令牌按客户的档位（官方线 / 便宜线）签发，`unlimited_quota=true`：**额度管在用户身上，
不是令牌上**，这样后台看到的「这个客户还剩多少」就是唯一那个数。

首次建号时发放固定 5 元的新人额度（与本地钱包共用 `SIGNUP_BONUS_CNY`），幂等键 `signup:<客户 id>`：
重复登录不会重复发；**余额迁移脚本先建过映射的老客户不会被当成新人**（created 为 false）；
发放失败不影响登录——额度事后能补，登录不能卡。

三条不配就不生效：没有客户端时整条分支关闭，不会出现「开关是 on 但没有客户端」的半开状态。

### 扣费回到这一侧（插件分成的地基）

lanehub 模式下这一侧**不预扣也不扣钱**，但「这一单收了多少」必须回来：插件作者的
分成口径（`/api/me/developer/usage`、插件后台）读的是 `request_billing.charged_cny`，
没有这张表的行，作者收益永远是 0——而那正是要卖的东西。

数据来源是 **lanehub 的消费日志**，按 `request_id` 反查（这一侧早就把 lanehub 回的
`X-Oneapi-Request-Id` 存进了 `requests.upstream_id`），所以 lanehub 侧不用改任何东西。
折算汇率取**对面现行的** `PaymentUSDRate`，不是这边配的那个——实测两边差过 4%
（配 7 / 对面 6.7078），差的就是作者分成的基数。配置值只在读不到时兜底。

补记跑在和余额刷新同一个定时器上（120 秒），幂等键是 `request_id`：

- 查到消费日志 → 写一条 `settled` 行，`charged_cny` 就是客户实扣（E2E 验到分毫不差）
- 查不到，且完成不到 10 分钟 → 什么都不做，下一轮再来（日志可能还没落库）
- 查不到，且已超过 10 分钟 → 写一条 `released` 行终止重试（失败的请求本来就没扣钱）

媒体请求要等任务走到终态才补记：lanehub 那边任务失败会退费，中途查到的数字会被退掉。

`reconcileTaskCharges`（APIMart 的 `credits_cost` 口径）已排除 lanehub 渠道——
不排的话那 20 个名额会被永远查不出结果的 lanehub 任务占满。

### 在线充值与余额

Waffo 支付确认后由支付工作器发放到用户对应钱包，详见 [支付接入](docs/WAFFO-PAYMENTS.md)。
`GET /api/me/wallet` 在 LaneHub 模式下读取其权威余额（`source: "lanehub"`），本地历史入账记录继续保留。

### 切换与回滚（幂等）

```
node scripts/lanehub-switch.mjs status     # 看当前状态 + 前置检查
node scripts/lanehub-switch.mjs on         # 四项前置检查全过才开
node scripts/lanehub-switch.mjs off        # 立刻回滚，不做检查
```

前置检查挡的都是「跑起来才会发现、而发现时钱已经错了」的那类：lanehub 账户不存在或
类型写错、还有客户的余额没迁走、`billing_policy` 仍开着（两边都预扣 = 同一笔钱冻两次）、
还有未结算的预扣（切过去会永远停在 reserved）。

### 端到端自检（可反复跑）

```
export DATABASE_URL=postgres://user:pass@127.0.0.1:5433/ipzsk_e2e
export LANEHUB_BASE_URL=http://localhost:3000
export LANEHUB_ADMIN_TOKEN=<lanehub root 的 access_token>

node scripts/lanehub-e2e.mjs            # 不花钱：建号、新人额度、报价、报价校验
node scripts/lanehub-e2e.mjs --spend    # 连真实生成、扣费回写、分成基数一起验（会扣真钱）
node scripts/skill-chain-e2e.mjs       # 提示词型 skill 的变现全链路（会扣真钱，文本模型一次几厘）
```

`skill-chain-e2e.mjs` 验的是**变现那条链**，而且请求从网关的 HTTP 入口进去，
走完整的鉴权 → 归属 → 计费 → 补记 → 计提 → 结算单：装成插件的 skill 调一次真模型
（默认 `deepseek-v4-flash`），断言 token 记下了、归属落到插件、扣费从 lanehub 的
消费日志补回来、作者的计提 = 实扣 × 比例、重复补记不会算两遍。

打的是真 lanehub 和真库，不是 mock——单元测试能证明幂等逻辑对，证明不了「对面的接口
真是这个形状」。这一轮就是靠它打出了四个只有真打才看得见的错：用户名 12 字上限、
密码 20 字上限、签令牌要走 `/api/token/for_user`（`/api/token/` 只给当前登录者签，
用管理员令牌调它会把管理员自己的密钥发给客户）、done-hub 的令牌**没有 `sk-` 前缀**。

写操作的幂等键都是固定的（测试客户 id、reference），所以第二次跑会跳过建号与发钱；
唯一不幂等的是真实生成——上游不认我们的幂等键，所以它默认关着。

`UPSTREAM_SECRET_DIR` 要跨次稳定（默认 `$TMPDIR/ipzsk-e2e-secrets`）：库里存的是
文件名，目录变了就读不到上次那把密钥。

### 余额迁移（幂等）

```
node scripts/lanehub-migrate.mjs --batch 2026-09-11            # dry-run，什么都不写
node scripts/lanehub-migrate.mjs --batch 2026-09-11 --apply
```

幂等键是 `migrate:<批次>:<客户 id>`。**同一个批次重跑不会重复加钱；换一个批次号就是
真的再加一次**——批次号要写进运行记录，不要随手改。折算汇率由 `LANEHUB_USD_CNY`
显式指定，不从对面实时取：用请求时抓到的汇率迁历史余额，会让同一批客户按不同汇率折算。
