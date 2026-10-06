# 计价链路怎么测

这条链是「注册 → 支付 → 发额度 → 调用 → lanehub 实扣 → 账单回写 → 后台/分成」。
下面按「花不花钱、打的是哪一层」分成三层，测试时对号入座，不要用上层代替下层。

| 层 | 命令 | 花真钱 | 打的是 |
| --- | --- | --- | --- |
| 单元 | `npm test` | 否 | 折算、幂等、分支逻辑（mock） |
| 整链（真库+假 lanehub） | `npm run test:integration` | 否 | 建号→归属→token→回写→分成→余额 |
| lanehub 直连自检 | `node scripts/lanehub-e2e.mjs [--spend]` | `--spend` 才花 | 真 lanehub：建号/报价/提交/轮询/回写（**绕过网关**） |
| **网关入口实测** | `node scripts/chain-live.mjs` | **是** | 用户在网站上走的那条路（登录→生成→余额→流水→账单） |

## 网关入口实测：`scripts/chain-live.mjs`

### 真跑一笔（会花真钱）

凭据只从环境变量来，脚本不落任何 token。用 secretctl 注入测试账号：

```sh
secretctl run -k ipzsk-site/lengkuxiaomao -- node scripts/chain-live.mjs
# 等价于 IPZSK_LOGIN_EMAIL=... IPZSK_LOGIN_PASSWORD=... node scripts/chain-live.mjs
```

它做这一串，并逐条断言：

1. 登录 → `POST /api/me/web/session-key`
2. 记下调用前余额（`/api/me/wallet`，lanehub 权威）
3. `POST /api/me/{images,videos}/generations`（**网站入口**，`Idempotency-Key: q:<uuid>`）
4. 轮询 `/api/me/tasks/:id` 到终态
5. 等账单落定（补记定时器 120s 一轮），断言 **余额下降 = 本次扣点**
6. 断言 `/api/me/generations` 的 `charged_points`、`/api/me/wallet` 里出现消费行
7. 若配了库与 lanehub 管理令牌，再跑一遍深度核对（见下），打印实扣、上游成本、实际加价

可调项（环境变量）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `GATEWAY_BASE` | `https://api.ipzsk.com` | 网关地址 |
| `CHAIN_KIND` | `image` | `image` / `video` |
| `CHAIN_MODEL` | `gpt-image-2.5-flare` | 型号 |
| `CHAIN_PARAMS` | `{"aspect_ratio":"1:1","resolution":"1k","quality":"low"}` | 计价档位参数（JSON） |
| `CHAIN_PROMPT` | 固定示例 | 提示词 |
| `CHAIN_POLL_SECONDS` | `240` | 任务轮询上限 |
| `CHAIN_ORIGIN` | `https://www.ipzsk.com` | 写操作来源校验用 |

### 只查一笔已发生的请求（不花钱）

`inspect` 不提交任何请求，只读服务端数据，最适合排查「用户说扣了但后台没记」：

```sh
# 在服务器上（容器里有库和 lanehub 管理令牌）
sudo docker compose exec -T gateway node scripts/chain-live.mjs inspect <request_id>

# 或在本地（需要 tunnel / 可达的库与 lanehub）
DATABASE_URL=... LANEHUB_BASE_URL=... LANEHUB_ADMIN_TOKEN=... npm run chain-inspect -- <request_id>
```

它输出并核对：

```
受理        provider=lanehub status=succeeded upstream_id=...
lanehub 实扣 quota=12750  cost_quota=2408  group=official group_ratio=3 price_type=times
账单        state=settled charged_cny=0.17105910 ... snapshot={"quota":12750,"usd_cny":"6.7082",...}
生成记录    status=succeeded charged_points=17.10591000
配置        汇率=6.7082 每单位quota=500000 分组倍率(official)=3
折算        实扣=¥0.17105910  上游成本=¥0.03230998  实际加价=5.29×
```

## 计价的倍率在哪

**用户售价 = 模型基准价(ratio) × 分组倍率，两者都在 lanehub，网关不参与。**
网关这一侧只有钱包动作，旧后台「计费与核对」里的 `billing_policy.multiplier` 是
本地模式的遗留项，lanehub 模式下**已停用、不参与扣费**（切换脚本会要求它关着）。

- **分组倍率**：lanehub `/api/group/`，`official=3`、`cheap=1`。客户令牌按档位签发
  （见 `lanehub.mjs` 的 `lane`），倍率直接决定这一单的售价。
- **模型 ratio**：lanehub 的价目表（`input_ratio` 等），按型号 × 档位。
- 本次实测：`quota = input_ratio(4.25) × group_ratio(3) × 1000 = 12750`。
- **上游真实成本**是另一条线：lanehub 消费日志里的 `cost_quota`，只用于对账/毛利，
  **不参与用户扣费**。实际加价 = `quota / cost_quota`（本次 12750/2408 ≈ 5.29×）。

所以「成本 × 2.5 倍」这种 cost-plus 计费当前**没有**——lanehub 是按模型价目收，
成本随渠道浮动；要按成本加价得改 lanehub 的计价（或在网关引入用户级倍率，属新特性）。

## 一条实测基线（2026-10-06）

| 项 | 值 |
| --- | --- |
| request/任务 id | `2ae11a36-b3fb-40ed-9ca3-31560168bc8e` |
| 型号 / 档位 | `gpt-image-2.5-flare` / 1:1 · 1k · low |
| lanehub 实扣 | `quota=12750`，`cost_quota=2408`，`group_ratio=3`，`input_ratio=4.25` |
| 账单 | `settled`，`charged_cny=0.17105910`，snapshot `{quota:12750, usd_cny:"6.7082"}` |
| 生成记录 | `charged_points=17.10591000` |
| 用户余额 | 2036.71 → 2019.61 点（差 `0.17105910` 元） |

拿它当回归基线：任何一次改动后重跑，这几个数应当自洽（金额随汇率/价目变动，但
`余额下降 = 扣点 = 账单 × 100 = lanehub 实扣折算` 必须恒成立）。
