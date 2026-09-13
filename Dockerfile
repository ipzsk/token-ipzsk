FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-core fontconfig libssl3 && rm -rf /var/lib/apt/lists/*
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
