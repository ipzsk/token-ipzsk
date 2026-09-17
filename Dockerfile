FROM node:24-bookworm-slim
# ca-certificates：静态 ffmpeg 读 R2 预签名 https 地址要验证证书；slim 镜像不带根证书（Node 自带，所以网关本身不受影响）。
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates fonts-dejavu-core fontconfig libssl3 && rm -rf /var/lib/apt/lists/*
# 缩略图/海报用静态 ffmpeg（GPLv3 构建，作为独立进程调用，网关代码不链接它）。
# 比 bookworm 的 apt ffmpeg 小一半（+210MB vs +386MB 解压后），版本与本地测试用的 9.0.1 一致。
COPY --from=mwader/static-ffmpeg:9.0.1@sha256:54e55b0cb8f672870fc38ceb2e6c411855cb3b39c505f5f3b2505ee01ed5f2b7 /ffmpeg /ffprobe /usr/local/bin/
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm rebuild skia-canvas && npm cache clean --force
COPY src ./src
# 运维脚本（余额迁移、lanehub 开关）要在容器里跑：它们需要的是内网地址和数据库
# 凭据，这两样都只在容器里成立。
COPY scripts ./scripts
COPY public ./public
USER node
ENV NODE_ENV=production
ENV XDG_CACHE_HOME=/tmp/.cache
EXPOSE 3000
CMD ["node", "src/server.mjs"]
