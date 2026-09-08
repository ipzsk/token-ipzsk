# 开发与 AI 任务入口

## 服务职责与仓库边界

本仓库是 IPZSK 平台后端。号池只是其中一部分：负责上游账户/Key、模型准入、余额同步、并发和排队；平台还负责用户认证、访问凭证、模型协议代理、钱包、开发者审批、插件版本审核及用量归属。

- 官网与账户/开发者页面：`JayceHuang/ipzsk`。
- 桌面与本地 Harness：`JayceHuang/ipzsk-dsh-desktop`。
- 生图插件：`JayceHuang/dsh-imagegen`。
- 平台 API 与管理员页面：当前仓库。

源码从个人博客 `jayce_blog/services/api-gateway` 独立提取；运行代码、包锁与生产配置保持原样，不需要更改数据库或域名。旧目录暂留作迁移保护，后续开发以新仓库为准。

## 找到要改的位置

| 功能 | 源码入口 | 相关测试/文档 |
| --- | --- | --- |
| 服务启动、装配、路由挂载 | src/server.mjs、src/app.mjs | test/integration.test.mjs |
| 号池、上游与调度 | src/upstream.mjs、src/scheduler.mjs、src/admin.mjs | test/core.test.mjs、test/integration.test.mjs |
| 模型代理与协议 | src/gateway.mjs、src/agent-protocols.mjs | test/agent-protocols.test.mjs |
| 用户认证、验证码、凭证 | src/customer-auth.mjs、src/account-keys.mjs、src/captcha.mjs | test/customer-auth.test.mjs、test/captcha.test.mjs |
| 管理员权限 | src/admin-accounts.mjs、src/security.mjs | test/accounts-billing.test.mjs |
| 钱包、充值、冻结结算 | src/vouchers.mjs、src/billing.mjs、src/text-pricing.mjs | test/vouchers.test.mjs、test/accounts-billing.test.mjs、docs/ACCOUNT-ARCHITECTURE.md |
| 插件审核、开发者、分成 | src/plugins.mjs、src/developers.mjs | test/plugins.test.mjs、test/developers.test.mjs、docs/plugin-market.md |
| 媒体任务与费用 | src/media-task-sync.mjs、src/task-charges.mjs、src/image-results.mjs、src/image-upload.mjs | test/image-upload.test.mjs、test/image-results.test.mjs、docs/ASYNC-IMAGE-TASKS.md |
| 桌面初始化与版本目录 | src/desktop.mjs、src/desktop-releases.mjs、src/desktop-releases.json | test/desktop-releases.test.mjs |
| 数据结构 | src/schema.sql、src/database.mjs | 涉及目标模块的隔离数据库测试 |
| 管理界面 | public/ | 对应后台接口的权限及接口测试，加浏览器验证 |

任务示例：“增加号池筛选”先读管理员界面、admin 路由和 upstream 查询；“插件增加功能”先在插件仓库定位，只有需要新后端接口时才修改当前仓库。新增用户入口通常还要同步官网仓库。

## 安装与测试

Node.js ≥24，使用 npm 和已有锁文件。

```sh
git clone https://github.com/JayceHuang/ipzsk-api-gateway.git
cd ipzsk-api-gateway
npm ci --ignore-scripts
npm rebuild skia-canvas
npm test
```

集成测试依赖独立 `gateway_test` 数据库、`gateway` 测试用户和安全注入的 `TEST_DB_PASSWORD`，应用用户须有创建 schema 的权限。部分测试不读取自定义端口和用户名，建议使用隔离环境默认 5432 与 gateway 用户。每个测试自行创建并清理随机 schema。

```sh
TEST_DB_HOST=127.0.0.1 npm run test:integration
```

`npm start` 运行完整网关，需要 PostgreSQL 和 `/run/secrets` 等配置；它会执行迁移、初始化及未完成请求恢复，不是零配置演示命令。先使用单元测试与模拟上游开发，完整联调需维护者提供隔离服务环境。不要对生产数据库运行集成测试，也不要为检查响应擅自发起付费请求。

## 当前路径与生产维护

- 维护者本机：`/Users/jaycehuang/Projects/ipzsk-api-gateway`。
- 服务器：`ubuntu@43.135.34.238`；SSH 默认端口 22。
- 生产服务目录：`/home/ubuntu/api-gateway`。
- API：`https://api.ipzsk.com`；管理员入口 `/admin`；模型通道 `/v1`。
- Docker：gateway 镜像内 `/app`，PostgreSQL 命名卷，Caddy 对外 80/443，gateway 宿主端口仅 `127.0.0.1:3000`。

SSH 需要负责人为开发者公钥单独授权。本轮拆仓不修改服务器，也不复制秘密文件。部署步骤与历史见 DEPLOYMENT.md、README.md；飞书开发手册包含 SSH 配置、路径地图和发布步骤。旧文档中的博客源码路径已被当前本机路径替代，服务器路径保持不变。

## 完成标准

实现指定行为并验证权限、异常和幂等；运行直接相关测试；必要时同步接口调用方和文档；说明尚未完成的隔离环境或界面验收。生产发布作为独立动作，由维护者执行。
