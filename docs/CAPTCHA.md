# captcha-canvas 图片验证码

2026-09-07：用 captcha-canvas 3.4.0 替换 Cloudflare Turnstile。

## 用户流程

注册、重新发送邮箱验证码、找回密码：填写邮箱 → 图片验证码 → 输入图片中的 5 位字符 → 后台校验 → 发送邮件。密码登录沿用既有风控策略，频繁尝试时要求图片验证码。图片必须手动输入，不会自动通过。

## 后台校验

- `POST /api/account/captcha`：提交 action、email。返回随机 id、PNG 图片、120 秒有效期和字符长度，不返回答案。
- `POST /api/account/captcha/verify`：提交 id、answer、action、email，返回一次性随机 token。答案不区分大小写。
- 注册或发送邮件接口携带 `captcha: {token}`。校验成功不等于可以省略业务接口的验证。
- 答案使用 Node crypto 安全随机数生成；PostgreSQL 只保存以已有账户认证密钥计算的 HMAC。验证码记录绑定邮箱、操作和由可信代理解析的真实 IP。
- 验证答案通过数据库行锁实现；最多 5 次错误猜测，验证成功后清除答案摘要并生成 90 秒有效凭证。凭证在业务请求中原子删除，只能用一次。
- 图片生成及校验接口分别限制 IP 请求频率，生成接口另有全局限制和最多 2 个同时生成任务。邮件原有 60 秒冷却、IP 和总量限制保留。
- 服务不可用、输入错误或图片过期时关闭放行路径；弹窗保留错误提示，允许换图。

## 部署与成本

captcha-canvas 为 Apache-2.0，skia-canvas 为 MIT。免费自行部署，无验证码按次服务费用，消耗现有服务器资源。Docker 镜像安装 skia-canvas 原生绘图库及 DejaVu 字体；字体缓存写入已有 /tmp 临时目录。

无 Cloudflare 脚本、Siteverify 网络请求、Site Key 或 Secret Key 配置。前端 CSP 仅放行本网站脚本和 PNG data 图片；不再允许 Cloudflare iframe。

数据库仅新增 `image_captchas` 表和 schema 13；不修改账户、余额、API Key 或邮件配置。

## 验证

- `npm test`：22 项单元测试通过，包含实际 PNG 生成检查。
- `node --test test/captcha.test.mjs test/image-captcha.test.mjs test/customer-auth.test.mjs`：在服务器的 gateway_test 隔离 schema 中 21 项通过，覆盖五次猜错、并发、过期、跨邮箱/操作/IP、一次性消费及真实认证路由。测试不使用生产账户和真实邮件。
- 前端 `node --test tests/captcha-ui.test.mjs`：6 项通过，覆盖手动输入、后台校验、错误重试、换图、网络失败和取消中的延迟回调。

项目：https://github.com/Shashank3736/captcha-canvas
绘图库：https://skia-canvas.org/getting-started

## 上线核验

前端发布 `dpl_FxnerctynBMDrCGt551Xf9UZq4aK`，后台镜像 `ipzsk-gateway:captcha-canvas`。正式状态返回 captcha_provider=captcha-canvas、captcha_ready=true，五个认证文件哈希与本地一致；页面 CSP 无 Cloudflare 域名。正式浏览器已显示 PNG、字符输入框和换图按钮。等待用户手动完成最后一次正式邮件发送验证。

已删除生产 secrets/mail/turnstile.json 和 ops/configure-captcha.py。数据库与源文件备份位于 backups/before-image-captcha-20260907，旧镜像保留用于回退；旧验证码密钥已移除，因此回退旧验证码方案需要重新配置。
