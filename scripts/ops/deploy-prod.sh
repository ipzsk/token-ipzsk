#!/usr/bin/env bash
# 把网关源码推到生产并重建。**先部署新版 lanehub 再跑这个**：网关启动时要拉 /api/catalog。
#   secretctl secret run ipzsk-prod-server --map password=SSHPASS --map username=SSH_USER -- scripts/ops/deploy-prod.sh
set -euo pipefail
: "${SSHPASS:?需要 SSHPASS（用 secretctl secret run 注入）}"
SSH_USER="${SSH_USER:-ubuntu}"; SSH_HOST="${SSH_HOST:-43.135.34.238}"; REMOTE_DIR="${REMOTE_DIR:-/home/ubuntu/api-gateway}"
cd "$(dirname "$0")/../.."
rsync -a --rsh="sshpass -e ssh -o StrictHostKeyChecking=accept-new" src/ "$SSH_USER@$SSH_HOST:$REMOTE_DIR/src/"
rsync -a --rsh="sshpass -e ssh -o StrictHostKeyChecking=accept-new" scripts/ package.json package-lock.json Dockerfile "$SSH_USER@$SSH_HOST:$REMOTE_DIR/"
sshpass -e ssh -o StrictHostKeyChecking=accept-new "$SSH_USER@$SSH_HOST" bash -s "$REMOTE_DIR" <<'REMOTE'
set -euo pipefail; cd "$1"
sudo docker compose build gateway 2>&1 | tail -1
sudo docker compose up -d gateway 2>&1 | tail -1
for i in $(seq 1 30); do s=$(sudo docker compose ps --format "{{.Service}} {{.Status}}" | grep gateway); echo "$s" | grep -q healthy && break; sleep 3; done; echo "$s"
echo "$s" | grep -q healthy || { echo "网关不健康"; sudo docker compose logs gateway --tail 30; exit 1; }
echo "== 目录拉取 =="
sudo docker compose logs gateway --since 2m 2>&1 | grep -i "catalog_refresh_failed" && { echo "目录拉取失败"; exit 1; } || echo "无失败日志"
sudo docker compose exec -T gateway node -e 'fetch("http://lanehub:3000/api/catalog").then(r=>r.json()).then(d=>console.log("catalog models:",d.data.models.length))'
REMOTE
