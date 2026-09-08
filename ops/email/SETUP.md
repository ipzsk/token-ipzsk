# 腾讯云邮件推送接入

应用使用 Better Auth 邮箱和密码登录，邮箱验证码用于注册验证及找回密码。正式发信需要由账户所有者开通腾讯云邮件推送并完成以下配置：

1. 选择邮件服务地域（ap-hongkong 或 ap-guangzhou），添加发信域名，例如 mail.ipzsk.com。
2. 将腾讯云控制台给出的域名验证、SPF、DKIM 等记录添加到 Spaceship。以控制台实际提供的记录为准。
3. 配置发件地址，例如 noreply@mail.ipzsk.com。
4. 提交本目录 verification.txt 作为纯文本验证码模板，变量只有 code；等待模板审核通过并记录模板 ID。
5. 准备限权 CAM API 凭证，授予所选账号发送邮件所需的 ses:SendEmail 权限；不要使用服务器 SSH 密码或 APIMart Key。
6. 在服务器交互终端运行 `python3 /home/ubuntu/api-gateway/ops/configure-email.py`，输入已验证发件地址、地域、模板 ID 及发送凭证。凭证输入不回显，不进入聊天、命令参数或代码仓库。
7. 在 `/home/ubuntu/api-gateway` 运行 `sudo docker compose up -d --no-deps --force-recreate gateway`，加载配置。
8. 在 `/account` 用本人可查收邮箱发验证码，完成真实收信、注册、重新登录测试。配置存在不代表投递已验证。

未配置时邮箱发送返回 503，不生成假验证码，不输出到日志。原 `/redeem` 平台凭证兑换入口保留。后台“用户管理”显示发信配置状态和已验证注册人数。

参考：
- [腾讯云发送邮件 API](https://cloud.tencent.com/document/product/1288/51034)
- [发信模板配置](https://cloud.tencent.com/document/product/1288/55193)
- [Better Auth Email OTP](https://better-auth.com/docs/plugins/email-otp)


2026-09-05 实际配置进度：

- 中国香港 SES 已开通；mail.ipzsk.com 验证通过，MX、SPF、DMARC、2048 位 DKIM 已添加至 Spaceship 并从腾讯云主机解析确认。信誉等级 1，每日上限 500 封。
- noreply@mail.ipzsk.com 已创建，别名 IPZSK 知识库工作台。
- 纯文本模板 217108（IPZSK邮箱注册登录验证码）仍审核中；控制台提示预计一个工作日，周末节假日顺延。内容对应 verification.txt。
- CAM 用户 ipzsk-mail-sender 已创建，仅编程访问，关联 IPZSKEmailSendOnly 策略，仅允许 ses:SendEmail。
- 发送凭据已通过 SSH 标准输入保存到服务器 secrets/mail/tencent-ses.pending.json，文件权限 600；未进入代码仓库或命令参数。
- 等模板审核通过后，将服务器待启用配置更名为 tencent-ses.json，并重建 gateway 容器加载。当前尚未启用公开邮件发送。
- 下一步通过 https://www.ipzsk.com/account 向 3318984@qq.com 发送验证码，验证真实收信和注册登录；尚未完成实际投递测试。


2026-09-07 启用与验证：

- 腾讯云控制台确认模板 217108 已审核通过。
- 服务器待启用配置已更名为 secrets/mail/tencent-ses.json，并重建 gateway 容器加载。启用前已备份数据库：backups/gateway-20260907T070925Z.dump。
- 公开状态接口返回 password_login_ready=true、registration_ready=true；email_login_ready=false 表示不支持验证码直接登录，登录仍使用邮箱和密码。
- 通过正式找回密码接口向 3318984@qq.com 请求验证码，返回 HTTP 200、success=true。发送实现要求腾讯云返回 MessageId 才判定成功；尚未由收件人确认实际收信。
- 本次仅请求验证码，未执行密码重置，原密码保持有效。注册、找回密码可在 https://www.ipzsk.com/account 使用。
