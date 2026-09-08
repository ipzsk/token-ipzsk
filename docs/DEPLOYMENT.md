
### 2026-09-07 账户架构改造

数据库 schema 8，历史用户、平台凭证、充值流水保留。新增 request_billing / wallet_debits 和请求平台凭证 ID；独立管理员与角色、每日用量与账单页面上线。升级前备份：`backups/gateway-20260906T162746Z.dump`。改造验证 66 项通过（独立 gateway_test），生产收费保持关闭，未产生用户消费流水。SES 模板 217108 在本次核验时仍为“审核中”，没有启用发信。

用户账户页已发布到 `https://www.ipzsk.com/account`，部署 `dpl_9uVqn53WGmg8WkE14GpuLvgkbNkL`。正式 HTML / JS 与本地文件哈希一致。Vercel 仓库发布因旧提交作者邮箱为本机地址而被阻止；本次采用当前项目所有者登录身份部署源码包，保留 Git 历史，预发布校验后 promote 到正式域名。

### 2026-09-07 网站登录与注册分离

Better Auth 开启邮箱密码登录，要求邮箱验证，注册后不自动登录。使用现有 emailOTP 完成邮箱验证和忘记密码，关闭验证码登录端点。注册密码至少 12 位，密码重置撤销旧会话。邮箱未配置时注册和找回密码停止服务，已有已验证账户的密码登录可用。

64 项测试通过。升级备份：`backups/gateway-20260906T225612Z.dump`；上线前 auth_users=0，未替真实用户创建密码。Vercel 部署 `dpl_2tFnr5gDFoVJFXFyGVxSxwwMVW2i`，预发布 HTML/JS/CSS 哈希验证后 promote，已在 www 正式域名浏览器验证独立登录和注册页面。
