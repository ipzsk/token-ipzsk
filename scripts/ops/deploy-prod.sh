#!/usr/bin/env bash
# 把网关源码推到生产并重建。**先部署新版 lanehub 再跑这个**：网关启动时要拉 /api/catalog。
#   secretctl secret run ipzsk-prod-server --map password=SSHPASS --map username=SSH_USER -- scripts/ops/deploy-prod.sh
# DRY_RUN=1：照常做只读核对（现网 src 漂移、服务器 compose 键），再用 rsync --dry-run 打印将要传的文件，不构建不重启。
# FORCE_COMPOSE=1：服务器 compose 核对不过也继续（例如键放在 env_file 里，脚本看不到）——先人工确认。
set -euo pipefail
: "${SSHPASS:?需要 SSHPASS（用 secretctl secret run 注入）}"
SSH_USER="${SSH_USER:-ubuntu}"; SSH_HOST="${SSH_HOST:-43.135.34.238}"; REMOTE_DIR="${REMOTE_DIR:-/home/ubuntu/api-gateway}"
# 整个脚本复用一条 SSH 主连接：只认证一次。连着多次 sshpass 登录会被 sshd 间歇拒掉
# （实测 Permission denied, please try again ×3），而且每次都把口令交给一个新进程。
SSH_OPTS="-o StrictHostKeyChecking=accept-new -o ControlMaster=auto -o ControlPath=/tmp/ipzsk-cm-%r@%h:%p -o ControlPersist=300"
sshpass -e ssh $SSH_OPTS -fN "$SSH_USER@$SSH_HOST"
trap 'ssh $SSH_OPTS -O exit "$SSH_USER@$SSH_HOST" 2>/dev/null || true' EXIT
cd "$(dirname "$0")/../.."
# 先把服务器现网 src 拉回来，和**上次部署的提交**比：生产上跑过从未进 git 的代码（2026-09-13 被覆盖
# 一次，官网整块功能静默失效）。服务器上有人改过（与上次部署的提交不同）就停下来先合并，不覆盖。
# 第一次部署（服务器上还没有 .deployed-commit）只能人工确认：FORCE=1。
TMP=$(mktemp -d); rsync -a --rsh="ssh $SSH_OPTS" "$SSH_USER@$SSH_HOST:$REMOTE_DIR/src/" "$TMP/src/"
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
# compose.yaml 不同步（服务器那份有 lanehub 服务与 R2 配置，本仓库的会把它们抹掉）：只核对网关需要的键，缺了就停。
rsync -a --rsh="ssh $SSH_OPTS" "$SSH_USER@$SSH_HOST:$REMOTE_DIR/compose.yaml" "$TMP/compose.yaml"
if ! node scripts/ops/check-compose.mjs "$TMP/compose.yaml"; then
  if [[ -z "${FORCE_COMPOSE:-}" ]]; then echo "服务器 compose 副本在 $TMP/compose.yaml"; exit 1; fi
  echo "FORCE_COMPOSE=1：忽略 compose 核对结果继续。"
fi
rm -rf "$TMP"
RSYNC_DRY=(); [[ -n "${DRY_RUN:-}" ]] && RSYNC_DRY=(--dry-run --itemize-changes)
git rev-parse HEAD > src/.deployed-commit
rsync -a ${RSYNC_DRY[@]+"${RSYNC_DRY[@]}"} --delete --exclude "._*" --rsh="ssh $SSH_OPTS" src/ "$SSH_USER@$SSH_HOST:$REMOTE_DIR/src/"
rm -f src/.deployed-commit
# scripts 不带尾斜杠：落成 $REMOTE_DIR/scripts/（带斜杠会把里面的文件摊到项目根，镜像里就没有 scripts/*.mjs）。
rsync -a ${RSYNC_DRY[@]+"${RSYNC_DRY[@]}"} --exclude "._*" --rsh="ssh $SSH_OPTS" scripts package.json package-lock.json Dockerfile "$SSH_USER@$SSH_HOST:$REMOTE_DIR/"
if [[ -n "${DRY_RUN:-}" ]]; then echo "DRY_RUN：以上为将要传输的文件，未构建、未重启。"; exit 0; fi
ssh $SSH_OPTS "$SSH_USER@$SSH_HOST" bash -s "$REMOTE_DIR" <<'REMOTE'
set -euo pipefail; cd "$1"
sudo docker compose build gateway 2>&1 | tail -1
sudo docker compose up -d gateway 2>&1 | tail -1
for i in $(seq 1 30); do s=$(sudo docker compose ps --format "{{.Service}} {{.Status}}" | grep gateway); echo "$s" | grep -q healthy && break; sleep 3; done; echo "$s"
echo "$s" | grep -q healthy || { echo "网关不健康"; sudo docker compose logs gateway --tail 30; exit 1; }
echo "== 目录拉取 =="
sudo docker compose logs gateway --since 2m 2>&1 | grep -i "catalog_refresh_failed" && { echo "目录拉取失败"; exit 1; } || echo "无失败日志"
sudo docker compose exec -T gateway node -e 'fetch("http://lanehub:3000/api/catalog").then(r=>r.json()).then(d=>console.log("catalog models:",d.data.models.length))'
REMOTE
