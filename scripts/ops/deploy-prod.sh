#!/usr/bin/env bash
# 把网关源码推到生产并重建。**先部署新版 lanehub 再跑这个**：网关启动时要拉 /api/catalog。
#   secretctl secret run ipzsk-prod-server --map password=SSHPASS --map username=SSH_USER -- scripts/ops/deploy-prod.sh
set -euo pipefail
: "${SSHPASS:?需要 SSHPASS（用 secretctl secret run 注入）}"
SSH_USER="${SSH_USER:-ubuntu}"; SSH_HOST="${SSH_HOST:-43.135.34.238}"; REMOTE_DIR="${REMOTE_DIR:-/home/ubuntu/api-gateway}"
cd "$(dirname "$0")/../.."
# 先把服务器现网 src 拉回来，和**上次部署的提交**比：生产上跑过从未进 git 的代码（2026-09-13 被覆盖
# 一次，官网整块功能静默失效）。服务器上有人改过（与上次部署的提交不同）就停下来先合并，不覆盖。
# 第一次部署（服务器上还没有 .deployed-commit）只能人工确认：FORCE=1。
TMP=$(mktemp -d); rsync -a --rsh="sshpass -e ssh -o StrictHostKeyChecking=accept-new" "$SSH_USER@$SSH_HOST:$REMOTE_DIR/src/" "$TMP/src/"
DEPLOYED=$(cat "$TMP/src/.deployed-commit" 2>/dev/null || true)
if [[ -n "$DEPLOYED" ]] && git cat-file -e "$DEPLOYED^{commit}" 2>/dev/null; then
  git worktree add -q "$TMP/ref" "$DEPLOYED"
  if ! diff -rq -x .deployed-commit -x '._*' "$TMP/ref/src" "$TMP/src" >/dev/null 2>&1; then
    echo "⚠️ 服务器 src 与上次部署的提交 $DEPLOYED 不一致（有人在服务器上改过）："; diff -rq -x .deployed-commit -x '._*' "$TMP/ref/src" "$TMP/src" || true
    git worktree remove -f "$TMP/ref"
    if [[ -z "${FORCE:-}" ]]; then echo "先把服务器上的改动合回 git 再部署；确认要覆盖就 FORCE=1 重跑。服务器副本在 $TMP/src"; exit 1; fi
  else git worktree remove -f "$TMP/ref"; fi
elif [[ -z "${FORCE:-}" ]]; then
  echo "服务器上没有 .deployed-commit（从没用本脚本部署过），无法判断现网是否有未进 git 的改动。人工核对后 FORCE=1。服务器副本在 $TMP/src"; exit 1
fi
rm -rf "$TMP"
git rev-parse HEAD > src/.deployed-commit
rsync -a --delete --exclude "._*" --rsh="sshpass -e ssh -o StrictHostKeyChecking=accept-new" src/ "$SSH_USER@$SSH_HOST:$REMOTE_DIR/src/"
rm -f src/.deployed-commit
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
