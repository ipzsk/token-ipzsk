# IPZSK Codex 开发执行手册

## Codex 先读：任务路由与当前状态

这份手册面向使用 Codex 的项目协作者。收到功能需求后，先确定所属仓库，再读取相关代码、实施最小改动、完成对应验证。文档提供定位依据，当前仓库源码、AGENTS.md 和实际授权决定最终操作。不要把本文命令示例视为自动发布授权。

| 用户要改什么 | 在 Codex 打开哪个项目 | 主要文件 |
| --- | --- | --- |
| 官网首页、下载页、账户页、开发者页面 | ipzsk | index.html、workstation.*、account.*、developer.*、api/desktop-release.js |
| 号池、后台管理、认证、模型接口、计费、审核 | ipzsk-api-gateway | src/、public/、test/、docs/ |
| 桌面启动、登录窗口、托盘、安装恢复、桌面市场 | ipzsk-dsh-desktop | dsh-plugin-desktop/、dsh-plugin-desktop-beta/、dsh-community-market/ |
| 生图、画布、模板、图片历史、插件任务体验 | dsh-imagegen-ipzsk（GitHub 名为 dsh-imagegen） | src/index.ts、routes.ts、generation-runtime.ts、src/client/ |
| 用户功能涉及多个组件 | 分别打开涉及仓库，先定义接口契约 | 例如官网账户页面 + 网关账户接口；插件界面 + 网关任务接口 |

当前维护者的四个本地目录都位于 /Users/jaycehuang/Projects/。其他开发者可以放在自己的 ~/Projects，不能照抄维护者用户名路径。个人博客 jayce_blog 与 IPZSK 官网分开；网关已提取到独立本地项目，旧博客目录仅暂留作迁移保护。

源码入口：https://github.com/JayceHuang/ipzsk-api-gateway 是公开的独立网关仓库，包含源码、测试与开发文档。开发者克隆后按本手册安装依赖并验证。SSH 主机可达但本机认证被拒绝。不要据此宣称远端联调或部署已验证。

## 所有任务共同遵循的执行步骤

1. 将功能需求写成可验收行为：在哪个页面或接口触发、输入是什么、期望输出是什么、失败时如何处理。缺失信息会改变实现时再提问。
2. 在 Codex 中选择上表项目目录。先执行 pwd、git status --short，读取仓库及目标目录 AGENTS.md、README、package.json 和锁文件；保护既有未提交改动。
3. 使用 rg 定位界面文字、路由、函数、类型及测试，读完整相关实现。先说明准备改哪些文件，是否影响其他仓库、数据库或计费。
4. 沿用现有结构实现最小可运行功能，不引入新框架、不顺手重构。新增生产依赖或破坏性接口变更先确认。
5. 先执行范围最小的相关测试，再验证用户触发路径。涉及权限、金额、幂等、恢复的变更必须覆盖异常路径；纯样式改动优先界面验证。
6. 交付文件清单、功能效果、实际执行的检查结果及未验证项。明确代码已改、安装包已生成、已上线三者的状态。
7. 只有用户明确要求时再提交、推送或发布。上线前先给出可审阅的 diff、目标环境和影响，不把服务器命令自动加入普通开发流程。

```bash
pwd
git status --short
rg --files -g AGENTS.md -g README.md -g package.json -g "*lock*" -g "!node_modules"
# 用实际功能名替换下方搜索词
rg -n "功能名或接口路径" src public test docs -g "!node_modules"
```

最后一个搜索命令适用于网关结构，官网和插件须按实际目录调整；目录不存在时先用 rg --files 查看，不能凭文档硬造文件。

## 开发官网：页面、账户和下载入口

项目：https://github.com/JayceHuang/ipzsk；维护者路径 /Users/jaycehuang/Projects/ipzsk。这是原生 HTML/CSS/JavaScript 与 Vercel API 函数项目，没有根 package.json，不能执行 npm run dev 或创建 Next.js 工程替换它。

| 功能 | 优先读取 |
| --- | --- |
| 首页与登录入口 | index.html、home-account.js 及 HTML 引用的样式 |
| 账户登录、注册与钱包 | account.html、account.js、account.css、auth-ui.js、captcha-ui.js |
| 开发者门户 | developer.html、developer.js 及其样式 |
| 桌面下载 | workstation.html、workstation.js、api/desktop-release.js、tests/desktop-release.test.cjs |
| 域名路由和访问策略 | vercel.json；只有任务确需时修改 |

1. 读取目标 HTML 及它引用的 JS/CSS，定位用户操作和已有 API 请求。
2. 纯文案或样式只改对应前端文件；新增字段先检查网关是否已提供。缺少能力时转到后台流程，并约定请求、响应和权限。
3. 本机启动静态预览验证布局、按钮和空态；涉及路由重写时静态预览使用具体 .html 路径。
4. 执行关联测试，并用浏览器验证成功、加载、空数据和失败状态。账户接口使用凭证 Cookie，localhost 静态页面不能等价验证正式域名认证。
5. 交付页面效果和测试结果。需要发布时由有 Vercel 项目权限的人按现有绑定部署官网项目，再检查正式 URL。

```bash
cd /Users/jaycehuang/Projects/ipzsk
python3 -m http.server 8080 --bind 127.0.0.1
# 浏览器打开 http://127.0.0.1:8080/index.html 或对应 .html 页面
```

```bash
cd /Users/jaycehuang/Projects/ipzsk
node --test tests/desktop-release.test.cjs
node --test tests/captcha-ui.test.mjs
```

测试按改动选用。静态服务不会执行 Vercel /api 函数；函数开发需使用项目现有 Vercel 开发方式或测试模拟，不承诺上述预览能执行后端函数。新增账户功能要同时核对 API Origin、权限和正式域名 Cookie，不为本地调试放宽生产 CORS。

```text
请按本手册开发 IPZSK 官网功能：【描述功能】。
项目目录：【本机 ipzsk 路径】。
先读目标页面、相关脚本和现有 API，再实现并验证。
涉及后台缺少字段时先列出跨仓库契约。
本次只完成本地开发和相关验证，不提交、不推送、不部署。
```

## 开发后台：号池、接口、管理员与计费

项目：https://github.com/JayceHuang/ipzsk-api-gateway；维护者本机 /Users/jaycehuang/Projects/ipzsk-api-gateway。Node.js ≥24、Fastify、ESM、PostgreSQL、npm。开发者可从公开仓库克隆源码，写入和推送仍需独立授权。

| 功能 | 实现入口 | 测试入口 |
| --- | --- | --- |
| 启动与路由 | src/server.mjs、src/app.mjs | test/integration.test.mjs |
| 号池与限流调度 | src/admin.mjs、src/upstream.mjs、src/scheduler.mjs | test/core.test.mjs、test/integration.test.mjs |
| 模型与媒体协议 | src/gateway.mjs、src/agent-protocols.mjs、src/image-upload.mjs | test/agent-protocols.test.mjs、test/image-upload.test.mjs |
| 认证与平台凭证 | src/customer-auth.mjs、src/account-keys.mjs、src/captcha.mjs | test/customer-auth.test.mjs、test/captcha.test.mjs |
| 钱包与价格 | src/billing.mjs、src/wallet.mjs、src/payments.mjs、src/text-pricing.mjs | test/accounts-billing.test.mjs、test/wallet.test.mjs、test/text-pricing.test.mjs |
| 插件与开发者 | src/plugins.mjs、src/developers.mjs | test/plugins.test.mjs、test/developers.test.mjs |
| 管理端页面 | public/index.html、app.js、accounts.js、plugins.js、wallet.js | 对应接口测试及浏览器验收 |
| 数据库结构 | src/schema.sql、src/database.mjs | 对应隔离数据库集成测试 |

1. 从 createApp 的路由挂载和相关模块开始，读取对应管理界面及测试，明确使用管理员会话、用户会话还是插件凭证。
2. 能复用现有字段就不改 schema。需要持久化字段时，检查已有迁移惯例、默认值、历史数据影响及读写方。
3. 实现接口验证、资源归属、业务逻辑和必要页面；金额、充值、冻结与结算保留事务和幂等。
4. 安装依赖并执行单元测试；与数据库有关的改动必须在独立 gateway_test 完成集成测试后才能声称端到端通过。
5. 本地全服务启动需要完整隔离数据库与配置；npm start 会执行初始化、迁移和请求恢复，不能直接接生产作为测试。
6. 交付 API 契约、变化文件、验证与迁移影响；生产操作单独授权，按后文部署步骤执行。

```bash
cd /Users/jaycehuang/Projects/ipzsk-api-gateway
npm ci --ignore-scripts
npm rebuild skia-canvas
npm test
# TEST_DB_PASSWORD 已由负责人安全注入，且本机有隔离 gateway_test 时
TEST_DB_HOST=127.0.0.1 npm run test:integration
```

验证码依赖 skia-canvas 的原生组件，忽略安装脚本后需显式 rebuild；本机曾验证补齐该步骤后相关 30 项测试通过。本轮文档改写未重跑测试；Docker 服务未运行且没有可用本地 PostgreSQL，集成测试尚未完成。部分集成测试不读取自定义端口/用户名，按现有默认 5432 和 gateway 用户准备隔离环境。

```text
请在 ipzsk-api-gateway 实现后台功能：【描述功能】。
先读取 AGENTS.md、docs/DEVELOPMENT.md、相关路由、数据结构及测试。
明确身份权限与资源归属，完成最小改动及相关单元/隔离集成测试。
若需要数据库迁移，先给出数据影响及验证方案。
不要访问生产秘密、执行生产迁移、变更收费开关或部署。
```

## 开发桌面：启动、登录、市场与原生体验

项目：https://github.com/JayceHuang/ipzsk-dsh-desktop；维护者本机 /Users/jaycehuang/Projects/ipzsk-dsh-desktop。外层 Yarn 4.18.0，Node.js ^22.19.0 或 ≥24；deepseek-harness 子模块使用自己的 pnpm 锁文件。

| 功能 | 入口 |
| --- | --- |
| 正式版 / Beta 主程序 | dsh-plugin-desktop/src/；dsh-plugin-desktop-beta/src/ |
| 登录和会话 | src/ipzsk-auth.ts、ipzsk-login-window.ts、ipzsk-session-store.ts |
| 登录界面 | src/native-ui/ipzsk-login.html 及相关脚本 |
| 插件凭证配置 | src/ipzsk-plugin-config.ts |
| IPZSK 市场 | dsh-community-market/src/host/ipzsk.ts 及对应客户端实现 |
| 原生行为、窗口、安装恢复 | 在主程序 src/ 与 tests/ 搜索对应行为；不要直接修改上游子模块替代桌面适配 |

1. 读取 docs/architecture.md、docs/ipzsk-login.md 和功能对应模块，判断在 Electron 主进程、Host 还是界面层实现。
2. 安装子模块与工作区依赖；只在确需上游 runtime 改动时按既有构建文档处理子模块。
3. 先改一个明确入口，再检查 stable/beta 的对应实现与差异。共同行为应同步，通道特有行为说明原因。
4. 运行目标工作区的类型检查、相关测试和构建，在实际开发版桌面启动验证。
5. 涉及凭证时检查退出、过期、恢复与多设备隔离；涉及插件安装时检查产物校验、失败恢复和用户数据。
6. 区分开发版可运行与正式包验收。需要发版时走主程序 GitHub Release 和后台版本目录，不把源码修改当成用户已更新。

```bash
cd /Users/jaycehuang/Projects/ipzsk-dsh-desktop
git submodule update --init --recursive
corepack yarn install --immutable
corepack yarn dev
```

```bash
corepack yarn workspace dsh-plugin-desktop typecheck
corepack yarn workspace dsh-plugin-desktop test
corepack yarn workspace dsh-plugin-desktop build
# 同时涉及 Beta 时
corepack yarn workspace dsh-plugin-desktop-beta typecheck
corepack yarn workspace dsh-plugin-desktop-beta test
# 涉及市场时
corepack yarn workspace dsh-community-market typecheck
corepack yarn workspace dsh-community-market test
```

正常桌面登录会连接正式 IPZSK API；没有专用测试账户或调用额度授权时使用已有模拟测试，不自动触发收费模型请求。记住登录采用 safeStorage，调用凭证只驻留内存；不得写到 Renderer、普通设置或日志。

```text
请给 IPZSK Desktop 增加功能：【描述功能】。
先判断主进程、Host、界面层及 stable/beta 的修改范围。
复用现有服务与 IPC/路由边界，补齐相关验证并启动开发版验收。
不要把场景插件代码塞入 Desktop 生产依赖。
本次不发布安装包、不修改正式更新目录。
```

## 开发插件：功能实现、装入 Host 与独立发布

生图参考仓库：https://github.com/JayceHuang/dsh-imagegen；维护者本机 /Users/jaycehuang/Projects/dsh-imagegen-ipzsk。沿用 pnpm-lock.yaml、TypeScript 与 tsdown。新增其他插件先独立定包名和仓库，不将所有新功能堆进生图插件。

| 功能 | 入口 |
| --- | --- |
| 插件声明、配置与服务注入 | src/index.ts：name、inject、Config、apply |
| 界面到 Host API | src/client/api.ts、src/routes.ts |
| 生图参数与任务调度 | src/engine.ts、src/generation-runtime.ts、src/protocol.ts |
| 界面组件 | src/client/ImageGenPanel.tsx、CanvasWorkspace.tsx、TemplateLibrary.tsx 及关联样式 |
| 历史记录与持久化 | src/history-store.ts 及对应 store 实现 |
| 恢复测试与发布规则 | test/async-recovery.test.ts、IPZSK-RELEASE.md |

1. 先定位一个具体用户动作及相关组件，再追踪 client API → Host route → runtime/engine → 网关请求。
2. 配置变更同步类型与运行验证，界面状态与生成任务状态分开。使用后台注入的插件专属凭证，不能借用主客户端 token 伪造归属。
3. 修改后执行类型检查、构建和相关恢复测试，再打包 tgz，确认产物包含更新文件。
4. 在专用开发 Profile/Host 验证插件加载。若使用独立 DSH 开发环境，可通过下方现有 CLI 语义安装本地 tgz；先确认命令支持、Profile 与 Harness home，不触碰真实用户 Profile。
5. IPZSK 桌面完整验收使用审核目录的插件安装/更新链路；不要绕过产品的包校验。至少验证新安装、旧版本升级、历史数据、断网恢复和失败提示。
6. 需要发布时更新 package.json 与 src/protocol.ts 版本，GitHub Release 上传 tgz，经开发者中心提交和管理员审核上架，客户端手动更新后重启。

```bash
cd /Users/jaycehuang/Projects/dsh-imagegen-ipzsk
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run build
node --test test/async-recovery.test.ts
npm pack --ignore-scripts
```

```bash
# 仅在已准备的独立 DSH 开发环境，先查实际 CLI
dsh plugin --help
# 将占位符替换为 npm pack 实际生成的文件绝对路径
dsh plugin --profile web add /ABSOLUTE/PATH/plugin-package.tgz
```

上面的 web 是独立 DSH 开发示例，不能照搬为当前 IPZSK 桌面 Profile。本机历史桌面安装使用 desktop Profile，但执行前仍须核对实际 home/profile。构建不会自动刷新已安装插件，必须重新安装对应产物并重启宿主。

生图 fork 保留 @dickpy/dsh-imagegen 包身份与 imagegen runtime ID，用 JayceHuang/dsh-imagegen Release 交付；不得向原作者 npm 命名空间发布。其他新插件使用自己的包身份。后台配置 runtime ID、credential_paths 与模型白名单；插件先安装，bootstrap 才能对已安装包注入配置。

```text
请在生图插件增加功能：【描述功能】。
先追踪界面 → client API → Host 路由 → runtime → 网关的现有调用。
尽量只修改插件；若网关缺少能力，先列出接口契约和两边改动。
完成类型检查、构建、相关测试，并说明怎样在专用 Profile 安装验收。
保留原任务 ID；取图失败只重试下载，不自动重新生成。
本次不发布 Release、不审核上架、不触发真实收费请求。
```

## 跨仓库功能、权限与完成标准

例一：开发者中心增加插件统计筛选，应先修改网关 developers 查询与权限测试，再同步官网 developer.js 的字段和空态。例二：生图增加批量任务，先明确插件并发与恢复设计，只有现有网关能力不足时才扩接口。例三：桌面增加可选模型，须核对后台模型目录、号池实际开放和客户端能力，不能只增加下拉选项。

1. 列出所有调用方和服务端，写清请求字段、响应字段、错误码、身份与资源归属。
2. 先完成必要后端能力及测试，再接界面。若改变旧接口，明确兼容策略和版本顺序；不为假设需求增加兼容层。
3. 分别运行仓库相关检查，并完成一条完整用户流程。暂缺测试账户、可用包或数据库时明确停在哪一步。
4. 分别描述每个仓库的 diff 与部署产物。发布按实际依赖排序，不因一个仓库通过测试就宣布全部上线。

必须保留：普通用户仅访问自身资源；开发者只管理自己插件；超级管理员掌握审批、价格与分成。上游成本 cost_cny、估算成本 estimated_cost_cny、用户扣款 charged_cny 分开，未知不填 0。分成按请求时所有者和比例快照计算；应计分成不等于已付款。当前收费准入只接受已定价文字请求，媒体成本记录不等于媒体用户钱包扣款。

| 交付项 | Codex 应明确写出 |
| --- | --- |
| 改动 | 所属仓库、文件、触发条件和结果 |
| 验证 | 实际执行的命令、通过/失败、浏览器或桌面验收结果 |
| 边界 | 未验证项、测试账号/数据库/平台环境缺口 |
| 发布 | 未提交 / 已提交 / 已推送 / 已发包 / 已部署，逐项如实报告 |
| 后续 | 需要谁提供什么权限或进行哪一步，不写“全部完成”掩盖缺口 |

## 账号、密码与凭据：Codex 应如何获得权限

本手册不包含已核实的真实密码。当前没有读取服务器秘密，也没有可用 SSH 登录；不能填入猜测密码或将文件路径当成密码。以下是接入所需凭据与获得方式，负责人应通过单独受控渠道授权。项目公开仓库和通用协作文档不存放真实密码、私钥、Token 或充值码。

| 用途 | 账号 / 入口 | 凭据如何提供 |
| --- | --- | --- |
| GitHub 拉代码 | JayceHuang 下对应公开仓库 | 公开只读克隆无需密码；推送需协作者权限 |
| GitHub 提交代码 | 开发者自己的 GitHub 账号 | 负责人添加协作者；在自己机器 gh auth login，不共享所有者 Token |
| 腾讯云 SSH | 43.135.34.238:22；现有维护账号 ubuntu | 负责人授权开发者公钥；私钥仅留本机。当前 SSH 密码未知 |
| 管理员后台 | https://api.ipzsk.com/admin；历史初始账号 admin | 由超级管理员创建独立权限账号；历史初始密码文件为服务器 secrets/admin-password，实际账号可能已在数据库更新，不能保证该文件仍有效 |
| 网站 / 桌面测试账户 | https://www.ipzsk.com/account | 负责人提供专用测试账号与额度，或授权开发者自助注册；不共用真实用户账户 |
| 开发者门户 | https://www.ipzsk.com/developer | 使用自己的已验证账户，申请后由超级管理员批准 |
| 模型调用 | https://api.ipzsk.com/v1 | 用户平台凭证或 bootstrap 签发的插件凭证；上游 Key 不发给开发者 |
| 隔离集成测试 | gateway_test 数据库，gateway 用户 | 负责人安全注入 TEST_DB_PASSWORD；不使用生产库密码 |
| Vercel 部署 | ipzsk 对应 Vercel 项目 | 自己的已授权账号登录，确认项目绑定；不共享所有者 Token |

服务器秘密相对 /home/ubuntu/api-gateway：secrets/db-password、secrets/db-admin-password、secrets/admin-password、secrets/customer-auth-secret、secrets/mail/、secrets/upstream/。这些是运维定位信息，不是允许 Codex 读取或写入文档的授权。正式运行通过文件挂载使用，排查先看配置就绪状态及脱敏错误。

在任务提示中可以写“所需测试凭据已通过环境或受控文件配置，可使用但不得输出”，前提是负责人已实际完成配置。Codex 先检查是否可用，不打印值；缺少权限时继续完成无凭据可做的代码和模拟测试，并明确列出待授权项。

## 服务器接入：SSH 与开发者授权

现有部署记录：腾讯云服务器 43.135.34.238，维护账户 ubuntu，网关目录 /home/ubuntu/api-gateway。2026-09-08 本轮尝试默认 SSH 端口连接，服务端返回 Permission denied (publickey,password)，说明已到达 SSH 认证阶段，但本机当前凭据未获准登录；没有读取远端文件或核验容器状态。下列远端路径以已有部署记录和本地 Compose 配置为依据，登录成功后须执行后文只读核对。

| 参数 | 现有值或使用要求 |
| --- | --- |
| Host | 43.135.34.238 |
| SSH 端口 | 本轮默认 22 可达；服务端认证拒绝 |
| 维护账户 | ubuntu；新成员实际账户由项目负责人分配 |
| 身份认证 | 由负责人授权开发者公钥；当前可用私钥路径及密码未确认 |
| 生产代码目录 | /home/ubuntu/api-gateway |
| 生产入口 | https://api.ipzsk.com；管理台 /admin；模型 /v1 |

新成员先将自己的 SSH 公钥交给项目负责人，由负责人配置服务器登录账号、authorized_keys、目录与 sudo 权限，并提供 SSH 主机指纹。GitHub 协作者资格、网站开发者资格与服务器 SSH 权限彼此独立。本文不包含任何真实私钥或密码。

本机操作：先检查拟用的密钥文件名是否已存在；已有密钥就复用或换新文件名。只在新建时执行 ssh-keygen，若提示覆盖已有文件应取消。为私钥设置口令。

```bash
ssh-keygen -t ed25519 -f ~/.ssh/ipzsk_dev_ed25519 -C "ipzsk-dev"
# 只把下面输出的公钥交给负责人
cat ~/.ssh/ipzsk_dev_ed25519.pub
```

负责人授权完成后，在 ~/.ssh/config 新增独立 Host 段，不覆盖原配置。下例 ubuntu 对应现有维护账户；若负责人分配了独立账户，修改 User。IdentityFile 指向开发者自己的私钥文件。

```text
Host ipzsk-api
    HostName 43.135.34.238
    User ubuntu
    Port 22
    IdentityFile ~/.ssh/ipzsk_dev_ed25519
    IdentitiesOnly yes
    ServerAliveInterval 30
    ServerAliveCountMax 3
```

```bash
ssh ipzsk-api
# 不配置别名时的等价命令
ssh -p 22 -i ~/.ssh/ipzsk_dev_ed25519 ubuntu@43.135.34.238
```

首次连接将显示服务器主机指纹，与负责人提供的指纹比对一致后再接受。不要关闭 StrictHostKeyChecking；出现指纹变化应核对重装或更换主机情况。Permission denied 时检查 User、私钥路径与服务端公钥授权；连接超时则检查网络及腾讯云 SSH 入站规则。不要为排错关闭服务器防火墙或将数据库开放公网。

## 路径速查：本机、服务器与容器

| 位置 | 绝对路径 / 容器路径 | 用途 |
| --- | --- | --- |
| 当前维护者 Mac | /Users/jaycehuang/Projects/ipzsk | 官网及账户、开发者页面；部署至 Vercel |
| 当前维护者 Mac | /Users/jaycehuang/Projects/ipzsk-dsh-desktop | Desktop 主体与 deepseek-harness 子模块 |
| 当前维护者 Mac | /Users/jaycehuang/Projects/dsh-imagegen-ipzsk | 独立生图插件；远端仓库 JayceHuang/dsh-imagegen |
| 当前维护者 Mac | /Users/jaycehuang/Projects/ipzsk-api-gateway | 腾讯云网关对应源码 |
| 服务器 | /home/ubuntu/api-gateway/src | 网关 ESM 源码、schema.sql、desktop-releases.json 等 |
| 服务器 | /home/ubuntu/api-gateway/public | 网关管理端静态页面 |
| 服务器 | /home/ubuntu/api-gateway/compose.yaml；Dockerfile；Caddyfile | 容器编排、网关镜像构建与反向代理配置 |
| 服务器 | /home/ubuntu/api-gateway/ops | 备份、数据库启动、邮件配置等运维脚本 |
| 服务器 | /home/ubuntu/api-gateway/secrets | 数据库、会话和邮件秘密；不纳入源码同步 |
| 服务器 | /home/ubuntu/api-gateway/secrets/upstream | 上游凭证目录；不向客户端或开发仓库分发 |
| 服务器 | /home/ubuntu/api-gateway/backups | 数据库 dump 及配套受限秘密备份 |
| 服务器 | /home/ubuntu/api-gateway/downloads | Caddy /downloads/ 静态下载挂载；不等同于官网 GitHub Latest |
| gateway 容器 | /app/src；/app/public | Dockerfile COPY 进入镜像的运行代码，改宿主源码后须重新构建 |
| gateway 容器 | /run/secrets；/run/upstream；/run/mail | 秘密挂载位置，不能作为普通调试输出 |
| db 容器 | /var/lib/postgresql/data | PostgreSQL 持久化数据，来自 postgres_data 命名卷 |
| caddy 容器 | /etc/caddy/Caddyfile；/srv/downloads；/data；/config | 代理配置、下载目录和 Caddy 命名卷 |

新开发者可把仓库克隆到自己的 ~/Projects，替换上述 Mac 用户路径即可；这些路径不是其他电脑的硬编码要求。服务器网关目录不表示整个 jayce_blog 都部署到腾讯云，官网也不部署在此目录。

当前架构不使用旧 ipzsk/docs/DEPLOYMENT.md 方案中的 /srv/ipzsk/current/backend/ipzskd、/srv/ipzsk/releases 或 deploy 用户作为已确认入口。不要将旧 PocketBase/二进制服务方案的操作套到当前 Node.js 网关。Docker 命名卷以 compose.yaml 的 postgres_data、caddy_data、caddy_config 为准，实际卷名通过 docker volume ls 查询；不手改 Docker 内部数据目录。

桌面数据另存于用户电脑。当前维护者 macOS 正式版为 /Users/jaycehuang/Library/Application Support/IPZSK Desktop，其下 dsh-home 是默认 Harness home。插件和用户数据位于应用安装包外；调试安装、升级问题时区分仓库源码、已安装 App 与用户数据。不要复制真实登录数据作为测试样本。

## 登录后核对与远程开发方式

以下命令在 SSH 登录成功后执行，均为只读检查。sudo 是否可用取决于负责人分配的权限；失败时联系负责人，不自行改账号权限。

```bash
whoami
pwd
cd /home/ubuntu/api-gateway
pwd
ls -ld src public ops backups downloads
ls -l compose.yaml Dockerfile Caddyfile package.json package-lock.json
sudo docker compose ps
sudo docker compose images
curl -fsS http://127.0.0.1:3000/healthz
curl -fsS https://api.ipzsk.com/healthz
systemctl status ipzsk-backup.timer --no-pager
```

推荐工作流是本机修改与测试，再由有发布权限的维护者同步指定源码。腾讯云现有目录为生产服务目录，编辑文件或重建网关会影响所有用户；它不是已隔离的开发环境。独立测试服务器、测试域名与测试账户尚未在本轮确认。

如使用 VS Code Remote SSH，可选择已配置的 ipzsk-api 主机，再打开 /home/ubuntu/api-gateway 查看代码和日志。只有明确安排的生产维护任务才在此目录写入；普通开发应打开个人克隆目录或负责人提供的隔离环境。VS Code 会在远端安装自身服务组件，是否允许由服务器维护规范决定。

需要从本机查看网关回环端口时，可以使用只绑定本机的 SSH 隧道。在本机单独终端运行并保持终端打开：

```bash
ssh -N -L 127.0.0.1:13000:127.0.0.1:3000 ipzsk-api
# 另开本机终端验证
curl -fsS http://127.0.0.1:13000/healthz
```

该隧道用于健康检查和受控排错；账户系统使用正式 Origin、Cookie 和 CORS，不能认为 localhost 页面可以直接完成正式登录。PostgreSQL 当前没有宿主机 5432 映射，ssh -L 到远端 127.0.0.1:5432 无法直接连接现有数据库；不要为了调试修改生产 Compose 暴露数据库。

## 本地测试与上传：逐步操作

在当前维护者 Mac 上执行以下网关检查；其他开发者先替换为自己的仓库绝对路径。此处只演示命令，不表示本轮已执行测试或上传。

```bash
cd /Users/jaycehuang/Projects/ipzsk-api-gateway
npm ci --ignore-scripts
npm rebuild skia-canvas
npm test
```

集成测试要求独立 gateway_test 数据库、测试用户 gateway 和预先安全注入的 TEST_DB_PASSWORD。现有部分测试只读取 TEST_DB_HOST 与 TEST_DB_PASSWORD，不能假设设置 TEST_DB_PORT/TEST_DB_USER 会对所有测试生效。使用与测试一致的本地或隔离数据库默认端口，确认连接目标后再运行：

```bash
TEST_DB_HOST=127.0.0.1 npm run test:integration
```

上传前审阅 Git diff，并确认提交范围。现有生产发布通过同步网关子目录实现；远端是否存在 Git checkout、跟踪哪个分支未确认，不提供未经核实的生产 git pull。下面使用源码白名单，不同步 secrets、backups、node_modules、downloads，也不使用 --delete。

```bash
cd /Users/jaycehuang/Projects/ipzsk-api-gateway
# 先预览：-n 不修改远端
rsync -avzn --itemize-changes src/ ipzsk-api:/home/ubuntu/api-gateway/src/
rsync -avzn --itemize-changes public/ ipzsk-api:/home/ubuntu/api-gateway/public/
rsync -avzn package.json package-lock.json Dockerfile ipzsk-api:/home/ubuntu/api-gateway/
```

只有发布范围已审核、远端备份完成并得到本次上线安排后，才去掉 -n 实际同步：

```bash
rsync -avz src/ ipzsk-api:/home/ubuntu/api-gateway/src/
rsync -avz public/ ipzsk-api:/home/ubuntu/api-gateway/public/
rsync -avz package.json package-lock.json Dockerfile ipzsk-api:/home/ubuntu/api-gateway/
```

默认同步仅覆盖同名源码，不删除远端旧文件。若本次包含删除文件或 ops、compose.yaml、Caddyfile 改动，在 diff 中单列并由维护者针对确切路径处理，不扩大为整个目录镜像。一般业务修改无需改数据库、反向代理或 SSH 配置。

## 生产发布、备份与回退边界

本节仅供获得发布权限的维护者操作。顺序是检查 → 备份 → 上传 → 构建 → 切换 → 验证。先在远端记录现有镜像和服务状态，并在源码上传前保存源文件备份：

```bash
cd /home/ubuntu/api-gateway
sudo docker compose ps
sudo docker compose images
sudo bash ops/backup.sh
archive_stamp=$(date -u +%Y%m%dT%H%M%SZ)
tar -czf "/tmp/ipzsk-source-${archive_stamp}.tgz" src public ops package.json package-lock.json Dockerfile compose.yaml Caddyfile
printf "%s\n" "/tmp/ipzsk-source-${archive_stamp}.tgz"
```

备份脚本会创建并校验 backups/gateway-时间戳.dump，同时在相关秘密存在时备份会话秘密和邮件配置。这些备份不上传飞书、GitHub 或普通协作目录。同机备份不能覆盖主机丢失风险；既有文档中的旧 /tmp 备份名称不能作为当前可用回退点。

在本机完成上一节实际同步后，回到远端运行：

```bash
cd /home/ubuntu/api-gateway
sudo docker compose build gateway
sudo docker compose up -d --no-deps gateway
sudo docker compose ps
curl -fsS http://127.0.0.1:3000/healthz
curl -fsS https://api.ipzsk.com/healthz
curl -fsS https://api.ipzsk.com/api/account/status
sudo docker compose logs --tail=80 gateway
```

此操作重建并切换 gateway，会中断或结束当前进程；正在运行的请求可能进入待核对。服务启动可能执行代码内数据库迁移，有 schema 改动时先审核迁移与数据兼容性。不要把单纯服务重启当作零影响操作，也不要对当前内存队列直接扩多副本。

构建失败时先保留仍运行的服务并排查，不继续切换。切换后异常时先保存错误与健康状态，由维护者选择已验证旧镜像或旧源码回退；恢复旧源码后仍需重建。存在数据库迁移时，单独回退代码未必安全，不提供覆盖生产库的快捷恢复命令。数据库恢复必须先导入独立空库验收，再决定切换。

官网修改仍在 /Users/jaycehuang/Projects/ipzsk 经 Vercel 发布，不通过上述 rsync；插件发布走独立 GitHub Release 和后台审核；客户端发布走 Desktop Release 与版本目录。不要把一个组件上线视为所有组件都已更新。

## 日志、数据库与常见排查

| 问题 | 先检查 |
| --- | --- |
| SSH 认证拒绝 | 确认账户、IdentityFile、公钥授权；私钥口令与服务器密码不同 |
| SSH 超时 | 网络、22 端口入站策略与主机状态 |
| 公网 502 / 网关不可用 | compose ps；gateway 健康；Caddy 到 gateway:3000 的连接 |
| 本地改了代码线上没变 | 同步目录是否正确；gateway 是否重新 build 并切换镜像 |
| 登录或注册失败 | /api/account/status；正式域名与 Cookie；邮件和验证码状态 |
| 生图等待或结果未显示 | 原 request_id / task_id、任务状态、查询错误、结果下载，避免重新生成 |
| 插件新版本不出现 | 开发者提交、管理员上架、目录版本、客户端手动更新 |
| 用户扣费或分成有疑问 | 实际扣款与上游成本分开核对；请求时比例快照；pending 状态 |

```bash
cd /home/ubuntu/api-gateway
sudo docker compose logs --since=10m --tail=100 gateway
sudo docker compose logs --since=10m --tail=100 caddy
sudo docker compose logs --since=10m --tail=100 db
sudo docker stats --no-stream
df -h
systemctl list-timers ipzsk-backup.timer --no-pager
```

日志先在授权终端检查，只分享脱敏错误、状态码、请求编号和时间；不要输出环境变量全集、docker inspect 全量内容、授权头或秘密文件。不要把用户提示词、邮箱清单与账单明细贴入公开 Issue。

数据库只供获准维护者排查，使用容器入口，不开公网数据库端口。下例进入 psql 后立即使用只读事务，只列结构或执行经过审核的查询；这不赋予数据库操作权限：

```bash
sudo docker compose exec db psql -U postgres -d gateway
```

```sql
BEGIN READ ONLY;
SELECT current_database(), current_user;
\dt
ROLLBACK;
\q
```

所有者仍需补充给新成员的接入信息：实际分配的 SSH 账号、已授权公钥、服务器主机指纹、允许操作范围、测试账户与数据库、发布审批负责人。服务器密码、私钥和上游 Key 通过受控凭据渠道管理。本轮仅增加说明文档，未修改 SSH、腾讯云策略、生产文件或数据。
