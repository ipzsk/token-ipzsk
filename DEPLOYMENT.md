# 部署记录 · 2026-09-05

- 管理台：https://api.ipzsk.com/admin
- 客户端 Base URL：https://api.ipzsk.com/v1
- 服务器：ubuntu@43.135.34.238，工作目录 `/home/ubuntu/api-gateway`。
- Spaceship 新增 api A 记录，TTL 30 分钟；主域名和 www 的 Vercel 记录保持原值。
- 腾讯云新增 TCP 443 允许规则；原有 TCP 80 已开放。
- Caddy、Node.js 网关、PostgreSQL 均已运行，公网 HTTPS 健康检查返回 200。
- 首把 APIMart Key 已导入主账户；默认开放 gpt-4o-mini。
- 密码与上游 Key 留在服务器受限文件中，未进入源码或镜像。

## 已验证

- 6 项核心测试：流式分片解析、重复累计用量、缺失用量、上游流式错误、账户共享并发、取消及密码验证。
- 11 个数据库集成场景：管理员鉴权与同源保护、秘密文件/余额分组、用户隔离、幂等、流式与缺失用量、渠道不可用、429/402、结果不明、凭证轮换、真实网络断开、进程恢复。
- 2 条真实 APIMart 请求：普通和流式各一条；每条输入 11、输出 2、总计 13 token；状态 succeeded，usage_state=reported。
- 真实验收用户已停用，测试调用记录保留，可在面板查看。
- 初次数据库备份已生成，systemd 每日中国标准时间 03:15 自动备份。
- 备份已恢复到独立临时数据库，用户/Key/请求数量与原库一致（1/1/2）；恢复检查库随后删除，生产数据未被覆盖。

## 使用与限制

2026-09-05 充值码管理上线：10 / 50 / 100 元批次生成、AES-256-GCM 加密库存、TXT/CSV 受限导出、导入确认与渠道锁定、单码/批次作废、兑换记录及用户钱包入账。用户入口 `/redeem` 暂使用已签发的平台凭证；邮箱注册和钱包消费扣款未接入。没有在生产库生成演示充值码或注入测试余额。新增并发抢兑、同钱包并发入账、事务失败回滚及失效码测试通过，原有集成检查通过。迁移前备份 `backups/gateway-20260905T123622Z.dump`，配套密钥备份扩展名 `.voucher-key`。

2026-09-05 逐笔扣费记录：调用列表、详情和 CSV 新增人民币扣费字段；支持管理员按账单人工录入，最多 8 位小数，变更写入审计。现有 4 条调用未取得逐笔账单，保持待核实。自动账单回填尚缺可用的上游接口。部署前备份 `backups/gateway-20260905T112720Z.dump`；6 项核心测试、12 个数据库集成场景和金额显示检查通过。

2026-09-05 余额单位修正：按账户所有者确认，将 `remain_credits` / `used_credits` 保存并展示为人民币元；原始 balance 字段保留。账户、Key 和余额快照新增 credits 字段，历史未知 credits 保持为空。部署前备份为 `backups/gateway-20260905T111941Z.dump`。6 项核心测试及 11 个数据库集成场景通过，已验证 credits 精度保存和账户去重汇总。

管理员用户名 admin，初始密码由管理员在服务器终端查看 `secrets/admin-password`。面板创建用户后会签发独立的平台凭证，客户端使用该凭证调用，不能使用 APIMart Key 直接访问本网关。

目前只上线文本 OpenAI Chat Completions 接口；其他模型可在号池设置里配置后逐一验证。已支持兑换码充值入账；尚未实现在线支付、自动扣费或图片/视频任务适配。当前备份位于同机，异机备份目的地尚未指定。未做大规模压测，2GB 单机不提供高可用保证。


## 2026-09-05 邮箱认证接入

Better Auth 1.7.2 邮箱验证码注册/登录及 `/account` 已部署。包含独立普通用户会话、邮箱验证后创建用户、钱包与兑换记录关联、平台 API 凭证生成/轮换，以及后台注册人数和邮件配置状态。`/redeem` 保留原平台凭证流程。代理 IP 信任改为明确的 Caddy 容器地址，避免所有访客共享验证码 IP 限额。

部署前备份 `backups/gateway-20260905T131931Z.dump`，对应 `.voucher-key` 和 `.customer-auth-secret` 均为 600 权限。生产迁移版本 5，HTTPS 健康检查、账户页面、原兑换入口及后台查询返回正常；4 条既有请求保留，邮箱注册用户为 0，未生成生产测试兑换码或钱包流水。6 项核心测试与 29 项数据库/认证/兑换集成测试全部通过，测试在独立数据库 schema 中执行。未进行浏览器视觉验收。

真实邮件尚未开通：服务器没有腾讯云 SES 发信配置，`/api/account/status` 返回 false，验证码发送明确返回 503。仍需配置已验证的发件地址、审核通过的模板及发送凭证，并使用真实邮箱完成送达验收。步骤见 `ops/email/SETUP.md`。本次部署不包含自动钱包扣费及多管理员功能。


## 2026-09-05 主站账户页面发布

用户入口调整为 `https://www.ipzsk.com/account`，首页加入登录/注册按钮，`/login`、`/register` 和裸域名 `/account` 跳转到统一入口。API 原 `/account` 也跳转到主站。主站源码位于 `/Users/jaycehuang/Projects/ipzsk`；API 和数据库继续部署腾讯云。跨域用户请求仅允许精确来源 `https://www.ipzsk.com`，携带 API 域名 Cookie，管理员接口不开放 CORS。

腾讯云更新前备份 `backups/gateway-20260905T132704Z.dump`。30 项集成测试通过，包括 www 来源的验证码登录、钱包操作、凭证轮换，以及非法来源拒绝。Vercel 正式部署 `dpl_8hifSokJnDcp3eWKSgdGXus1vjUj` 已推广至正式域名。首次部署因旧 Git 提交作者无法关联团队被平台阻止，随后使用当前所有者账号上传独立源文件发布包成功；未修改仓库历史或权限。

浏览器已验证首页登录按钮进入 www 账户页，样式与脚本正常加载，显示发信未配置提示；线上验证页面、资源及旧生图页面 HTTP 200，入口别名跳转和 CORS 预检正确。真实邮件发送仍待 SES 配置，因此未进行真实收信与生产注册。

2026-09-06 13:08（北京时间）任务扣费自动记录已上线：保存 APIMart 任务最终结果的 credits_cost 为人民币 cost_cny，附上任务编号和字段来源，支持客户端查询即时记录及后台每 2 分钟补查。非最终状态、无效金额和任务编号不匹配不会写入，已有人工金额不覆盖；重复和并发查询仅产生一次入账审计。没有新增依赖或数据库结构变更。47 项测试在 gateway_test 隔离数据库通过。部署前备份 backups/gateway-20260906T050804Z.dump；上线后健康检查通过，历史 gpt-image-2 请求 59b7b3b0-c259-4b0f-b310-19b81fddc973 自动补入 0.085 元，后台筛选及来源标签验证通过。

本轮直接向 APIMart 做了两条极小文本响应检查（未通过用户网关）：gpt-4o-mini 非流式和 gpt-5.6-sol 流式，分别返回 13 token，正文和相关响应头均未返回逐笔金额。请求追踪号分别为 202609061303568660037878KBTKMMA、20260906130447349451985i8lA9D3Z，仅作为排查证据，不归到客户消费。文本请求的自动金额回填仍缺可访问的逐笔账单来源；本次不按余额差额估算，也不实施钱包自动扣款。

2026-09-06 13:26（北京时间）GPT 文字价目表估算上线：从 APIMart 定价中心 LLM/GPT 提取 56 个文字模型 ID、62 个档位，快照 apimart-gpt-2026-09-06-v1，采用“我们的价格”。新增 schema 7 的 estimated_cost_cny 与 pricing_details，不改动实际 cost_cny。支持普通输入/缓存命中/缓存写入/输出拆分、272000 输入阈值、BigInt 8 位小数计算；流式使用最后累计 usage。未知模型、未公布缓存单价、异常用量及非默认服务档等不估算。后台与 CSV 分开显示实际费用和估算费用，并保留复算快照。

56 项自动测试全部通过（gateway_test 隔离数据库）；部署前备份 backups/gateway-20260906T052348Z.dump，部署后 schema 7 与 healthz 验证通过。显式补算 26 条历史记录，缓存按零的假设及当前价目表回溯依据逐笔保存；没有把估算值写为实际账单。正式公网接口验收请求 bba36eaf-3030-4cf5-9869-547ac9c5a345：gpt-5.6-sol，输入 9 / 输出 4，估算 0.00092800 元，与独立复算一致。专用“文字定价验收（Codex 代发）”账户验收后停用、临时访问凭据已撤销。浏览器确认费用列、文档入口和完整价格说明页面正常。

文档：docs/GPT-PRICING.md；公开阅读副本：https://api.ipzsk.com/admin/pricing.html；复算 CLI：ops/calculate-price.mjs。价格不会随网页自动修改；后续调价须更新 JSON 版本并部署，旧请求保留原计算快照。没有启用用户钱包自动扣款。

2026-09-07 桌面登录即用接口已部署。备份：backups/gateway-20260906T232204Z.dump；原服务源文件备份：/tmp/ipzsk-before-desktop-login-20260907.tgz。新增 schema 9 的 access_tokens.auth_session_id 与 /api/me/desktop/bootstrap，复用现有网关、密码登录和模型池。没有更改计费开关或价格。65 项自动测试在 gateway_test 隔离数据库通过。

正式 API 验收请求 b39bf187-9c9d-4f96-9c82-35dd610251de：独立验收账号通过真实密码登录及自动 bootstrap，gpt-5.6-sol 输入 9 / 输出 4 token；用户归属正确。sign-out 后调用凭证返回 401。验收账号随后停用，访问凭证已撤销，测试密码已清除，不向真实用户邮箱发送邮件。线上密码登录可用，注册/找回密码仍受未就绪邮件服务限制。

## 2026-09-07 三角色门户

schema 11 与开发者权限接口已部署。82 项隔离数据库测试通过，新增开发者资格审批、插件所有者关联、提交/审核/撤回/下架流程、使用人数统计和按请求快照计算的应计分成。超级管理员独享开发者审批、插件审核、全局财务和充值码操作；普通用户 API Token 不可作为开发者后台登录凭证。

Vercel 正式版本 `dpl_8ANJgTtvgk249ymY3vAPj4MjYAwB` 提供 `https://www.ipzsk.com/developer`；账户页新增开发者链接与分页调用记录。后台源文件备份 `/tmp/ipzsk-before-three-roles.tgz`。收费开关、密码、实际充值码和资金未修改，也未为现有插件猜测开发者账号或分成比例。

线上管理员页面已确认开发者申请、插件归属与分成、全局费用字段。开发者完整工作区使用隔离界面数据验证；跨账号、跨角色接口在 gateway_test 验证。主站 /developer、/account 与 API healthz 发布后返回正常。误触发的未绑定域名博客部署已删除，没有切换博客正式域名。

## 运维环境变量（网关）

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `THUMB_CONCURRENCY` | `1` | 同时跑的 ffmpeg 缩略图进程数，取值 1–2（越界按边界取）。每 5 秒一轮，一轮内连续取任务直到队列空或 4.5 秒用完。ffmpeg 与 node 共用 `mem_limit: 768m`，8192² 最坏单进程 ~390MB，2GB 单机保持 1；只有确认内存余量后才开 2。 |
| `THUMB_PRIORITY` | 开（`0` 关） | 开：用户上传/生成的缩略图任务先于 `source='case'` 案例回填任务。关：按到期时间先进先出。 |
| `HEALTH_DETAILS_TOKEN` | 空 | `/healthz/details` 默认只给容器内本机（`docker compose exec -T gateway node -e 'fetch("http://127.0.0.1:3000/healthz/details").then(r=>r.text()).then(console.log)'`）。配了之后带 `Authorization: Bearer <token>` 也能读（例如宿主机 `127.0.0.1:3000`）。 |

固定值（不是环境变量）：图片归档失败 8 次，或任务创建超过 7 天后再失败，`image_archives.state` 置为 `failed`（`last_error` 为 `attempts_exhausted` / `upstream_expired`），日志 `image_archive_gave_up` 只记一次，不改计费。数字人形象列表在 lanehub 目录每次刷新成功后（10 分钟一次）后台预热，失败记 `avatar_list_warm_failed`。

`/healthz/details` 返回：`thumb_queue{queued,running,failed}`、`archive_queue{pending,failed}`、`lanehub_catalog{age_seconds,last_refresh_failed}`、`avatar_list_cache_age_seconds`、`r2_configured`。只有计数与年龄，不含密钥。

## 部署前 compose 核对

`scripts/ops/deploy-prod.sh` 不同步 `compose.yaml`：服务器那份有 lanehub 服务与 R2 配置，本仓库的会把它们抹掉。脚本改为先拉回服务器 compose，用 `scripts/ops/check-compose.mjs` 核对 gateway 服务块，缺任一项即中止：

- `mem_limit` ≥ 768m
- `R2_CONFIG_FILE`
- `LANEHUB_BASE_URL`、`LANEHUB_ADMIN_TOKEN_FILE`（或 `LANEHUB_ADMIN_TOKEN`）、`LANEHUB_ACCOUNT_ID`、`LANEHUB_USD_CNY`
- `build: .`（用本仓库 Dockerfile 构建，镜像内有静态 ffmpeg/ffprobe）

缺项在服务器上手工补齐后再部署。键放在 `env_file` 里脚本看不到，人工确认后 `FORCE_COMPOSE=1`。`DRY_RUN=1` 只做只读核对并打印 rsync 计划，不构建不重启。

`scripts` 目录此前以 `scripts/`（带尾斜杠）同步，内容被摊到服务器项目根，镜像里的 `scripts/` 是旧的。已改为同步目录本身。按旧脚本部署过的话，服务器项目根下可能遗留 `grant-role.mjs`、`import-cases.mjs` 等散文件，需人工核对清理。

## 2026-09-17 21:26 运维后台代理（admin-ops）

lanehub 先部署：新增 `PUT /api/lane_matrix/batch`，矩阵渠道增加 `balance` / `balance_updated_time` / `balance_supported` / `balance_unit`。部署前备份 `backups/lanehub-20260917T132605Z.db`，verify-prod 全部通过。

网关随后部署 `b89cc03`：新增 `/api/admin/ops/*` 8 条路由（线路矩阵读写、渠道、探测=余额接口、仪表盘、日志），无数据库迁移。DRY_RUN 核对只传 admin-ops 相关 4 个文件；134 项测试通过。线上验证：lanehub 新字段已返回、批量接口空请求不写库、网关未登录返回 `customer_login_required`、healthz 200。网站 `/admin` 运维页未部署，方案见网站仓库 `docs/admin-ops.md`。

## 部署方式：服务器自己 git fetch（2026-09-21 起）

以前是本机 rsync 同步 + `src/.deployed-commit` 文本文件记账。那套有两个坑：手工发布会漏记，
脚本就误判「有人在服务器上改过」（2026-09-20 实际发生过，把一次 3 行的修复卡了半天）；
`rsync --delete` 还可能删掉没进仓库的文件。现在服务器自己是一个 git 仓库：

- 漂移检测交给 `git status --porcelain`，真相就是仓库状态，没有第二套记账
- `git reset --hard` 只动被跟踪的文件，服务器独有的 `compose.yaml` / `Caddyfile` / `downloads/` /
  `secrets/` 都在 `.gitignore` 里，部署不会碰
- 回滚 = `REF=<旧提交> scripts/ops/deploy-prod.sh`

仓库里的 `compose.example.yaml` / `Caddyfile.example` 只是样板。服务器那份不一样（有 lanehub
服务、R2 配置、真实域名），由服务器持有。本地开发 `cp compose.example.yaml compose.yaml`。

### 一次性初始化（已做过就跳过）

服务器用只读 deploy key 拉私有仓库。公钥在 `~/.ssh/ipzsk_gateway_deploy.pub`，由仓库 admin
在 GitHub → Settings → Deploy keys 添加，**不要勾 Allow write access**。

```sh
cd /home/ubuntu/api-gateway
ssh -T git@github.com                     # 认证通了会说 successfully authenticated
git init -b main
git remote add origin git@github.com:JayceHuang/ipzsk-api-gateway.git
git fetch origin
git reset --mixed origin/main             # 只建索引，不覆盖任何文件
git status                                # 确认差异只有预期内的那些，再往下走
git reset --hard origin/main              # 确认无误后对齐
```

`git reset --mixed` 之后一定要看一眼 `git status`：那是唯一能在覆盖前发现「服务器上有未入库改动」
的机会。2026-09-20 就是靠这一步发现生产跑着 Waffo 支付那套没合进 main 的代码。

### 日常部署

```sh
secretctl secret run ipzsk-prod-server --map password=SSHPASS --map username=SSH_USER -- \
  scripts/ops/deploy-prod.sh
```

`DRY_RUN=1` 只看差异；`REF=<提交>` 部署/回滚到指定版本；`FORCE=1` 丢弃服务器上被跟踪文件的改动。
