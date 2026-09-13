# lanehub 上生产：顺序、闸门与回滚

这套东西动的是钱，顺序错了不是报错，是账错。下面每一步都写清楚**为什么在这个位置**。

## 先看清楚现场

```sh
ssh ubuntu@43.135.34.238
cd /home/ubuntu/api-gateway
sudo docker compose ps
sudo docker compose exec -T db psql -U gateway -d gateway -tAc "
SELECT 'schema: '||(SELECT max(version) FROM schema_version)
UNION ALL SELECT '预扣开关: '||(SELECT enabled::text FROM billing_policy WHERE id=1)
UNION ALL SELECT '未结算预扣: '||(SELECT count(*)::text FROM request_billing WHERE state IN ('reserved','pending'))
UNION ALL SELECT '有余额用户: '||(SELECT count(*)::text FROM (SELECT user_id,sum(amount_cny) c FROM wallet_entries GROUP BY user_id) x WHERE c>0)"
```

2026-09-13 首次上线时的现场：schema 17、**预扣开着**、未结算预扣 0、3 个用户有余额、
6 笔充值共 ¥135、197 次历史调用。有真实用户和真实钱，按真生产对待。

## 0. 备份（每次都做）

```sh
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
sudo docker compose exec -T db pg_dump -U gateway -d gateway -Fc | sudo tee backups/gateway-pre-lanehub-$STAMP.dump > /dev/null
sudo tar czf backups/src-before-lanehub-$STAMP.tgz src public ops package.json package-lock.json Dockerfile compose.yaml
```

## 1. lanehub 镜像：**在本地构建，不在服务器上**

服务器是 2 核 1.9G。lanehub 要编译前端（vite）和后端（Go），在那上面构建会 OOM。

```sh
# 本机（Apple Silicon 也能交叉编译）
cd ~/Code/github/icycat/lanehub
docker buildx build --platform linux/amd64 -t lanehub:prod --load .
docker save lanehub:prod | gzip | ssh ubuntu@43.135.34.238 'gunzip | sudo docker load'
```

构建踩过的两个坑，都已经修进仓库：

- `Dockerfile` 的 `golang:1.25.0` 落后于 `go.mod` 要求的 `1.25.5`，`go mod download` 直接失败。
- 没有 `.dockerignore`，`COPY ./web .` 把本地 `web/build` 带进镜像，容器里的 vite 把它当成
  输入源，报 `Failed to resolve /assets/index-xxx.js`。

## 2. 密钥与 compose

三个密钥（`SESSION_SECRET` / `USER_TOKEN_SECRET` / `HASHIDS_SALT`）写进 `secrets/lanehub.env`，
权限 600。done-hub 不认 `*_FILE` 约定，只能给值，所以明文只存在这个文件里、不进 compose.yaml。

lanehub 服务用 SQLite（省掉 MySQL 和 Redis 两个容器），只绑回环 `127.0.0.1:3001`，
后台管理走 SSH 隧道，不对公网开。

```sh
ssh -L 3001:127.0.0.1:3001 ubuntu@43.135.34.238    # 本机浏览器开 http://127.0.0.1:3001
```

## 3. lanehub 初始化

1. 隧道进后台，root 首次登录后**立刻改密码**
2. 建 APIMart 渠道：类型 63，key 用 `secrets/upstream/apimart-primary.key` 里那把，
   分组 `official`，models 填要开放的型号
3. **两个后台表单里没有的字段**，必须用 API 单独 PATCH，否则上游真实成本记不下来、
   毛利只能靠估算：

   ```
   upstream_cost_unit = credits
   upstream_cost_quota_per_unit = 50000
   ```

   ⚠️ `PUT /api/channel/` 只要带了 `models` 字段就是**覆盖式保存**，请求体里没带的字段会被
   写成零值。要么在后台页面改，要么把完整字段都带上。这个坑在本地踩过一次，
   渠道的 name / type / key / group / proxy 一起被清空。
4. 生成管理员 access token（`GET /api/user/token`），存进 `secrets/lanehub-admin-token`（600）

## 4. 网关接上 lanehub

compose 的 gateway 段加：

```yaml
      LANEHUB_BASE_URL: http://lanehub:3000
      LANEHUB_ADMIN_TOKEN_FILE: /run/secrets/lanehub-admin-token
      LANEHUB_ACCOUNT_ID: <第 5 步建好后填>
      LANEHUB_USD_CNY: <lanehub 现行 PaymentUSDRate>
```

并挂 `./secrets/lanehub-admin-token:/run/secrets/lanehub-admin-token:ro`。

## 5. 网关侧建上游账户

后台建一个 `provider_type=lanehub` 的上游账户，地址 `http://lanehub:3000`，
把它的 id 填回 `LANEHUB_ACCOUNT_ID`。

## 6. 迁余额（切换前必须做）

```sh
node scripts/lanehub-migrate.mjs --batch 2026-09-13            # dry-run，什么都不写
node scripts/lanehub-migrate.mjs --batch 2026-09-13 --apply
```

幂等键是 `migrate:<批次>:<客户 id>`，同一批次重跑不会重复加钱，**换批次号会**。
汇率必须显式给：用请求时抓到的实时汇率迁移历史余额，会让同一批客户按不同汇率折算。

## 7. 关预扣，再开开关

```sh
# 先关 billing_policy——两边都预扣等于同一笔钱冻两次
sudo docker compose exec -T db psql -U gateway -d gateway -c "UPDATE billing_policy SET enabled=false WHERE id=1"

node scripts/lanehub-switch.mjs status     # 四项前置检查
node scripts/lanehub-switch.mjs on
```

四项检查挡的都是「跑起来才发现、而发现时钱已经错了」的：lanehub 账户不存在或停用、
**还有余额没迁走的客户**、`billing_policy` 仍开着、还有未结算的预扣。

## 回滚

```sh
node scripts/lanehub-switch.mjs off        # 立刻回到本地钱包，不做检查
```

开关关掉之后，网关回到原来的多上游池与本地钱包。已经迁到 lanehub 的额度不会自动退回来——
那是一笔真实的转账，要退得人工做。所以第 6 步之前先想清楚。

## 已知的行为变更

lanehub 这次带了 `canonical.Caps.Required`：**不带 `resolution` / `duration` 的
Wan 系列调用会开始 400**。上线前确认没有调用方依赖旧的宽松行为。
