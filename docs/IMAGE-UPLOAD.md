# 图片上传兼容修复

2026-09-07：电商卖点图带商品参考图时，客户端以 multipart/form-data 调用 /v1/images/edits。原网关只允许音频使用 multipart，并缺少 edits 路由，因此返回 415 unsupported_content_type。

新增图片上传适配：/v1/images/edits 和 /v1/images/generations 接受 multipart，解析 image 或多个 image[]，转换为 image_urls PNG/JPEG/WebP data URI，以 application/json 调用 APIMart /v1/images/generations。mask PNG 映射为 mask_url。继续使用已有模型参数适配、认证、号池调度、幂等、任务隔离、任务查询和费用记录。

上传总内容 32MB，参考图片及遮罩字节总计最多 20MB，参考图最多 15 张；验证文件标识、字段重复、必需图片和数值字段。图片仅在内存转换，不保存磁盘或写入请求记录。

验证：24 项单元测试通过；服务器 gateway_test 隔离数据库的 21 项集成测试通过，覆盖上传→JSON 上游请求→任务查询与费用记录，以及其他协议回归。上游为测试替身，本次未额外提交收费的真实图片生成。

来源：https://docs.apimart.ai/en/api-reference/images/gpt-image-2/generation

发布镜像：ipzsk-gateway:image-upload。回退镜像：ipzsk-gateway:before-image-upload-20260907。仅发布后台，无数据库结构改动，不要求客户端升级。
