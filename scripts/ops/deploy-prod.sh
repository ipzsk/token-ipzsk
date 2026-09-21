#!/usr/bin/env bash
# 生产部署：服务器用只读 deploy key 自己 git fetch，不再从本机 rsync。
#   secretctl secret run ipzsk-prod-server --map password=SSHPASS --map username=SSH_USER -- scripts/ops/deploy-prod.sh
#
# REF=<分支或提交>  部署别的 ref（默认 origin/main）。回滚就是 REF=<旧提交> 重跑。
# DRY_RUN=1         只打印服务器当前提交、将要部署的提交和两者的差异，不切换、不构建、不重启。
# FORCE=1           服务器上有人改过被跟踪的文件时照样覆盖（会丢掉那些改动，先看清楚再用）。
#
# 服务器上的 compose.yaml / Caddyfile / downloads / secrets 都不在仓库里（见 .gitignore），
# git reset 只动被跟踪的文件，不会碰它们——这正是换掉 rsync --delete 的原因。
set -euo pipefail
: "${SSHPASS:?需要 SSHPASS（用 secretctl secret run 注入）}"
SSH_USER="${SSH_USER:-ubuntu}"; SSH_HOST="${SSH_HOST:-43.135.34.238}"; REMOTE_DIR="${REMOTE_DIR:-/home/ubuntu/api-gateway}"
REF="${REF:-origin/main}"
# 一条 SSH 主连接复用到底：只认证一次。连着多次 sshpass 登录会被 sshd 间歇拒掉。
SSH_OPTS="-o StrictHostKeyChecking=accept-new -o ControlMaster=auto -o ControlPath=/tmp/ipzsk-cm-%r@%h:%p -o ControlPersist=300"
sshpass -e ssh $SSH_OPTS -fN "$SSH_USER@$SSH_HOST"

# compose 仍然只在服务器上（仓库里是 compose.example.yaml）。拉回来核对 gateway 服务块需要的键，
# 缺了就停——代码发上去而环境变量没配，只会换成一个更难查的运行时错误。FORCE_COMPOSE=1 跳过。
TMP=$(mktemp -d); trap 'rm -rf "$TMP"; ssh $SSH_OPTS -O exit "$SSH_USER@$SSH_HOST" 2>/dev/null || true' EXIT
ssh $SSH_OPTS "$SSH_USER@$SSH_HOST" "cat $REMOTE_DIR/compose.yaml" > "$TMP/compose.yaml"
if ! node scripts/ops/check-compose.mjs "$TMP/compose.yaml"; then
  [ -n "${FORCE_COMPOSE:-}" ] || { echo "服务器 compose 副本在 $TMP/compose.yaml"; exit 1; }
  echo "FORCE_COMPOSE=1：忽略 compose 核对继续。"
fi

ssh $SSH_OPTS "$SSH_USER@$SSH_HOST" bash -s "$REMOTE_DIR" "$REF" "${DRY_RUN:-}" "${FORCE:-}" <<'REMOTE'
# ssh 把参数拼成一条命令行再交给远端 shell 解析，空参数会整个消失，所以这里用 ${n:-} 取默认。
set -euo pipefail; cd "$1"; REF="$2"; DRY_RUN="${3:-}"; FORCE="${4:-}"
[ -d .git ] || { echo "❌ $PWD 还不是 git 仓库，先做一次初始化（见 DEPLOYMENT.md）"; exit 1; }
git fetch --prune origin
echo "== 当前 $(git rev-parse --short HEAD)  →  目标 $(git rev-parse --short "$REF") =="
# 被跟踪的文件被人改过就停：这是漂移检测，git 自己说了算，不用再靠文本文件记账。
DIRTY=$(git status --porcelain --untracked-files=no)
if [ -n "$DIRTY" ]; then
  echo "⚠️ 服务器上有人改过被跟踪的文件："; echo "$DIRTY"
  git --no-pager diff --stat
  [ -n "$FORCE" ] || { echo "先把这些改动提交进仓库，或确认要丢弃就 FORCE=1 重跑。"; exit 1; }
  echo "FORCE=1：丢弃以上改动继续。"
fi
echo "== 将要生效的改动 =="
git --no-pager diff --stat HEAD "$REF" || true
[ -z "$DRY_RUN" ] || { echo "DRY_RUN：未切换、未构建、未重启。"; exit 0; }
git reset --hard "$REF"
sudo docker compose build gateway 2>&1 | tail -1
sudo docker compose up -d gateway 2>&1 | tail -1
for i in $(seq 1 30); do s=$(sudo docker compose ps --format "{{.Service}} {{.Status}}" | grep gateway); echo "$s" | grep -q healthy && break; sleep 3; done; echo "$s"
echo "$s" | grep -q healthy || { echo "网关不健康"; sudo docker compose logs gateway --tail 30; exit 1; }
echo "== 目录拉取 =="
sudo docker compose logs gateway --since 2m 2>&1 | grep -i "catalog_refresh_failed" && { echo "目录拉取失败"; exit 1; } || echo "无失败日志"
sudo docker compose exec -T gateway node -e 'fetch("http://lanehub:3000/api/catalog").then(r=>r.json()).then(d=>console.log("catalog models:",d.data.models.length))'
echo "== 已部署 $(git rev-parse --short HEAD) =="
REMOTE
