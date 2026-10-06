CREATE TABLE IF NOT EXISTS schema_version (version integer PRIMARY KEY);

CREATE TABLE IF NOT EXISTS administrators (
  id integer PRIMARY KEY CHECK (id = 1), password_hash text NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash text PRIMARY KEY, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY, name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  enabled boolean NOT NULL DEFAULT true,
  rpm integer NOT NULL DEFAULT 30 CHECK (rpm BETWEEN 1 AND 600),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS access_tokens (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
  token_hash text UNIQUE NOT NULL, prefix text NOT NULL,
  revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS upstream_accounts (
  id uuid PRIMARY KEY, name text UNIQUE NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  concurrency integer NOT NULL DEFAULT 3 CHECK (concurrency BETWEEN 1 AND 50),
  balance numeric, used_balance numeric, balance_at timestamptz,
  balance_error text, blocked boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS upstream_keys (
  id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES upstream_accounts(id),
  name text NOT NULL, fingerprint text UNIQUE NOT NULL, suffix text NOT NULL,
  secret_ref text NOT NULL UNIQUE, enabled boolean NOT NULL DEFAULT true,
  models text[] NOT NULL DEFAULT '{}',
  concurrency integer NOT NULL DEFAULT 3 CHECK (concurrency BETWEEN 1 AND 50),
  balance numeric, used_balance numeric, unlimited boolean NOT NULL DEFAULT false,
  balance_at timestamptz, balance_error text, last_error text,
  cooldown_until timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS requests (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
  key_id uuid REFERENCES upstream_keys(id), model text NOT NULL,
  idempotency_key text, fingerprint text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','uncertain')),
  usage_state text NOT NULL DEFAULT 'pending' CHECK (usage_state IN ('pending','reported','unknown','not_executed')),
  input_tokens bigint CHECK (input_tokens >= 0), output_tokens bigint CHECK (output_tokens >= 0),
  total_tokens bigint CHECK (total_tokens >= 0), upstream_id text, upstream_http integer,
  error_code text, duration_ms integer, stream boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS requests_user_time ON requests (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS requests_time ON requests (created_at DESC);
CREATE TABLE IF NOT EXISTS request_attempts (
  id uuid PRIMARY KEY, request_id uuid NOT NULL REFERENCES requests(id),
  key_id uuid NOT NULL REFERENCES upstream_keys(id), upstream_id text,
  http_status integer, error_code text, usage jsonb,
  started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE TABLE IF NOT EXISTS balance_snapshots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES upstream_accounts(id),
  key_id uuid REFERENCES upstream_keys(id), balance numeric NOT NULL,
  used_balance numeric NOT NULL, unlimited boolean NOT NULL DEFAULT false,
  sampled_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS balance_snapshots_time ON balance_snapshots (sampled_at DESC);
CREATE TABLE IF NOT EXISTS audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action text NOT NULL, target_id text, created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO schema_version (version) VALUES (1) ON CONFLICT DO NOTHING;

-- APIMart credits are recorded as CNY (yuan), as confirmed by the account owner.
-- Preserve historical raw balances; unknown historical credits stay NULL.
ALTER TABLE upstream_accounts ADD COLUMN IF NOT EXISTS remain_credits numeric;
ALTER TABLE upstream_accounts ADD COLUMN IF NOT EXISTS used_credits numeric;
ALTER TABLE upstream_keys ADD COLUMN IF NOT EXISTS remain_credits numeric;
ALTER TABLE upstream_keys ADD COLUMN IF NOT EXISTS used_credits numeric;
ALTER TABLE balance_snapshots ADD COLUMN IF NOT EXISTS remain_credits numeric;
ALTER TABLE balance_snapshots ADD COLUMN IF NOT EXISTS used_credits numeric;
INSERT INTO schema_version (version) VALUES (2) ON CONFLICT DO NOTHING;

-- Per-request confirmed CNY charges; NULL means not yet verified.
ALTER TABLE requests ADD COLUMN IF NOT EXISTS cost_cny numeric CHECK (cost_cny >= 0);
ALTER TABLE requests ADD COLUMN IF NOT EXISTS cost_reference text;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS cost_recorded_at timestamptz;
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS details jsonb;
INSERT INTO schema_version (version) VALUES (3) ON CONFLICT DO NOTHING;

-- Legacy archive only: retained for historical wallet foreign keys and auditability.
-- No application routes or workers issue, redeem, export or reconcile these codes.
CREATE TABLE IF NOT EXISTS voucher_batches (
  id uuid PRIMARY KEY, name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
  amount_cny numeric(20,8) NOT NULL CHECK(amount_cny IN (10,50,100)),
  quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 1000),
  expires_at timestamptz, channel text, assigned_at timestamptz,
  exported_at timestamptz, export_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK((channel IS NULL)=(assigned_at IS NULL))
);
CREATE TABLE IF NOT EXISTS voucher_codes (
  id uuid PRIMARY KEY, batch_id uuid NOT NULL REFERENCES voucher_batches(id),
  code_hash text NOT NULL UNIQUE, code_suffix text NOT NULL, ciphertext text NOT NULL,
  state text NOT NULL DEFAULT 'unused' CHECK(state IN ('unused','redeemed','revoked')),
  redeemed_by uuid REFERENCES users(id), redeemed_at timestamptz,
  revoked_at timestamptz, revoke_reason text,
  CHECK((state='redeemed')=(redeemed_by IS NOT NULL AND redeemed_at IS NOT NULL)),
  CHECK((state='revoked')=(revoked_at IS NOT NULL AND revoke_reason IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS voucher_codes_batch_state ON voucher_codes(batch_id,state);
CREATE TABLE IF NOT EXISTS wallet_entries (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
  voucher_id uuid NOT NULL UNIQUE REFERENCES voucher_codes(id),
  amount_cny numeric(20,8) NOT NULL CHECK(amount_cny>0),
  balance_after_cny numeric(20,8) NOT NULL CHECK(balance_after_cny>=0),
  currency text NOT NULL DEFAULT 'CNY' CHECK(currency='CNY'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wallet_entries_user_time ON wallet_entries(user_id,created_at DESC);
INSERT INTO schema_version(version) VALUES(4) ON CONFLICT DO NOTHING;

ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_user_id text UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS users_verified_email ON users(lower(email)) WHERE email_verified;
CREATE TABLE IF NOT EXISTS auth_email_limits (
  email_hash text PRIMARY KEY, next_allowed timestamptz NOT NULL, day date NOT NULL, count integer NOT NULL
);
INSERT INTO schema_version(version) VALUES(5) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS media_tasks (
  id uuid PRIMARY KEY REFERENCES requests(id),
  upstream_task_id text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('image','video')),
  status text NOT NULL DEFAULT 'submitted',
  result jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO schema_version(version) VALUES(6) ON CONFLICT DO NOTHING;

-- Price-list estimates remain separate from confirmed upstream bills.
ALTER TABLE requests ADD COLUMN IF NOT EXISTS estimated_cost_cny numeric CHECK(estimated_cost_cny>=0);
ALTER TABLE requests ADD COLUMN IF NOT EXISTS pricing_details jsonb;
INSERT INTO schema_version(version) VALUES(7) ON CONFLICT DO NOTHING;

-- Account-owned credentials and an append-only debit ledger. Existing recharge rows stay intact.
ALTER TABLE access_tokens ADD COLUMN IF NOT EXISTS name text NOT NULL DEFAULT '默认凭证';
ALTER TABLE access_tokens ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE access_tokens ADD COLUMN IF NOT EXISTS rpm integer CHECK(rpm BETWEEN 1 AND 600);
ALTER TABLE access_tokens ADD COLUMN IF NOT EXISTS last_used_at timestamptz;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS access_token_id uuid REFERENCES access_tokens(id);
CREATE INDEX IF NOT EXISTS requests_access_token_time ON requests(access_token_id,created_at DESC);
CREATE TABLE IF NOT EXISTS billing_policy (
  id integer PRIMARY KEY CHECK(id=1), enabled boolean NOT NULL DEFAULT false,
  multiplier numeric(12,4) NOT NULL DEFAULT 1 CHECK(multiplier>0 AND multiplier<=100),
  version integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO billing_policy(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS request_billing (
  request_id uuid PRIMARY KEY REFERENCES requests(id), user_id uuid NOT NULL REFERENCES users(id),
  state text NOT NULL CHECK(state IN ('reserved','pending','settled','released')),
  reserved_cny numeric(20,8) NOT NULL CHECK(reserved_cny>=0),
  charged_cny numeric(20,8) CHECK(charged_cny>=0), price_snapshot jsonb NOT NULL,
  reason text, created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz,
  review_at timestamptz NOT NULL DEFAULT now()+interval '24 hours'
);
CREATE INDEX IF NOT EXISTS request_billing_user ON request_billing(user_id,state);
CREATE TABLE IF NOT EXISTS wallet_debits (
  id uuid PRIMARY KEY, request_id uuid NOT NULL UNIQUE REFERENCES requests(id),
  user_id uuid NOT NULL REFERENCES users(id), amount_cny numeric(20,8) NOT NULL CHECK(amount_cny>=0),
  balance_after_cny numeric(20,8) NOT NULL CHECK(balance_after_cny>=0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wallet_debits_user_time ON wallet_debits(user_id,created_at DESC);
ALTER TABLE administrators DROP CONSTRAINT IF EXISTS administrators_id_check;
ALTER TABLE administrators ADD COLUMN IF NOT EXISTS username text NOT NULL DEFAULT 'admin';
ALTER TABLE administrators ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'superadmin' CHECK(role IN ('superadmin','operator','viewer'));
ALTER TABLE administrators ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
CREATE UNIQUE INDEX IF NOT EXISTS administrators_username ON administrators(username);
ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS administrator_id integer NOT NULL DEFAULT 1 REFERENCES administrators(id);
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS administrator_id integer REFERENCES administrators(id);
INSERT INTO schema_version(version) VALUES(8) ON CONFLICT DO NOTHING;

-- Session-bound desktop credentials. No FK: auth tables are installed only
-- when customer authentication is configured; session deletion fails closed.
ALTER TABLE access_tokens ADD COLUMN IF NOT EXISTS auth_session_id text UNIQUE;
INSERT INTO schema_version(version) VALUES(9) ON CONFLICT DO NOTHING;

-- Stable plugin identity is independent of repository releases and runtime row IDs.
CREATE TABLE IF NOT EXISTS plugins (
  id uuid PRIMARY KEY, slug text NOT NULL UNIQUE, name text NOT NULL,
  repository text NOT NULL, package_name text NOT NULL UNIQUE,
  publisher_ref text NOT NULL, enabled boolean NOT NULL DEFAULT true,
  allowed_models text[] NOT NULL DEFAULT '{}',
  runtime_id text, runtime_config jsonb NOT NULL DEFAULT '{}',
  credential_paths jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS plugin_releases (
  id uuid PRIMARY KEY, plugin_id uuid NOT NULL REFERENCES plugins(id),
  version text NOT NULL, github_release_id bigint NOT NULL, github_asset_id bigint NOT NULL,
  release_url text NOT NULL, artifact_url text NOT NULL, sha256 text NOT NULL,
  size_bytes bigint NOT NULL, notes text NOT NULL DEFAULT '',
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','published','withdrawn')),
  imported_by integer NOT NULL REFERENCES administrators(id),
  published_by integer REFERENCES administrators(id), published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(plugin_id,version)
);
CREATE INDEX IF NOT EXISTS plugin_releases_catalog ON plugin_releases(plugin_id,published_at DESC) WHERE state='published';
ALTER TABLE access_tokens ADD COLUMN IF NOT EXISTS plugin_id uuid REFERENCES plugins(id);
ALTER TABLE access_tokens DROP CONSTRAINT IF EXISTS access_tokens_auth_session_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS desktop_session_token ON access_tokens(auth_session_id) WHERE plugin_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS desktop_plugin_token ON access_tokens(auth_session_id,plugin_id) WHERE plugin_id IS NOT NULL;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS plugin_id uuid REFERENCES plugins(id);
-- Snapshot the publisher at request acceptance, so future ownership edits cannot move historical revenue.
ALTER TABLE requests ADD COLUMN IF NOT EXISTS plugin_publisher_ref text;
CREATE INDEX IF NOT EXISTS requests_plugin_time ON requests(plugin_id,created_at DESC);
INSERT INTO plugins(id,slug,name,repository,package_name,publisher_ref,allowed_models,runtime_id,runtime_config,credential_paths)
VALUES('7d8b7d87-b85f-49f1-bde7-a0b1a2f33401','ipzsk-imagegen','IPZSK 生图','JayceHuang/dsh-imagegen','@dickpy/dsh-imagegen','JayceHuang',
 ARRAY['gpt-image-2'],'imagegen',
 '{"enabled":true,"allowAgentImageGeneration":true,"announceToAgent":true,"defaultChannelId":"ipzsk","channels":[{"id":"ipzsk","name":"IPZSK","preset":"","apiUrl":"https://api.ipzsk.com/v1","models":[{"id":"gpt-image-2","alias":"gpt-image-2"}]}]}',
 '[["channelSecrets","ipzsk"]]') ON CONFLICT DO NOTHING;
INSERT INTO schema_version(version) VALUES(10) ON CONFLICT DO NOTHING;

-- Developer identity belongs to the customer login; administrator sessions remain separate.
CREATE TABLE IF NOT EXISTS developer_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id), display_name text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','rejected','disabled')),
  review_note text NOT NULL DEFAULT '', reviewed_by integer REFERENCES administrators(id),
  created_at timestamptz NOT NULL DEFAULT now(), reviewed_at timestamptz
);
ALTER TABLE plugins ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES developer_profiles(user_id);
ALTER TABLE plugins ADD COLUMN IF NOT EXISTS revenue_share_bps integer CHECK(revenue_share_bps BETWEEN 0 AND 10000);
CREATE INDEX IF NOT EXISTS plugins_owner ON plugins(owner_user_id);
ALTER TABLE plugin_releases ALTER COLUMN imported_by DROP NOT NULL;
ALTER TABLE plugin_releases ADD COLUMN IF NOT EXISTS submitted_by uuid REFERENCES developer_profiles(user_id);
ALTER TABLE plugin_releases ADD COLUMN IF NOT EXISTS review_note text NOT NULL DEFAULT '';
ALTER TABLE plugin_releases ADD COLUMN IF NOT EXISTS withdrawal_requested boolean NOT NULL DEFAULT false;
ALTER TABLE plugin_releases DROP CONSTRAINT IF EXISTS plugin_releases_state_check;
ALTER TABLE plugin_releases ADD CONSTRAINT plugin_releases_state_check CHECK(state IN ('pending','published','withdrawn','rejected'));
ALTER TABLE requests ADD COLUMN IF NOT EXISTS plugin_owner_user_id uuid REFERENCES developer_profiles(user_id);
ALTER TABLE requests ADD COLUMN IF NOT EXISTS plugin_share_bps integer CHECK(plugin_share_bps BETWEEN 0 AND 10000);
CREATE INDEX IF NOT EXISTS requests_plugin_owner_time ON requests(plugin_owner_user_id,created_at DESC);
INSERT INTO schema_version(version) VALUES(11) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS auth_abuse_limits (
  key_hash text PRIMARY KEY, count integer NOT NULL CHECK(count>0), expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_abuse_limits_expiry ON auth_abuse_limits(expires_at);
INSERT INTO schema_version(version) VALUES(12) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS image_captchas (
  id text PRIMARY KEY, binding_hash text NOT NULL, answer_hash text,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
  proof_hash text UNIQUE, expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS image_captchas_expiry ON image_captchas(expires_at);
INSERT INTO schema_version(version) VALUES(13) ON CONFLICT DO NOTHING;

-- 多上游：渠道自带 base_url 与 provider_type。默认值保持现网单上游行为不变。
-- provider_type 不加 CHECK：未知类型由代码在注册表里 fail fast，不靠数据库枚举挡，
-- 也不静默回落到 apimart（那是扣费口径错且无声的事故）。
ALTER TABLE upstream_accounts ADD COLUMN IF NOT EXISTS base_url text NOT NULL DEFAULT 'https://api.apimart.ai';
ALTER TABLE upstream_accounts ADD COLUMN IF NOT EXISTS provider_type text NOT NULL DEFAULT 'apimart';
ALTER TABLE upstream_accounts DROP CONSTRAINT IF EXISTS upstream_accounts_base_url_https;
-- https 是硬要求，回环地址例外：本机自检要能把 lanehub 起在 http://localhost 上打一遍。
-- 回环流量不出网卡，密钥不会裸奔；理由同 src/admin.mjs 的 baseUrl()。
ALTER TABLE upstream_accounts ADD CONSTRAINT upstream_accounts_base_url_https
  CHECK (base_url LIKE 'https://%' OR base_url LIKE 'http://localhost%'
      OR base_url LIKE 'http://127.0.0.1%' OR base_url LIKE 'http://[::1]%'
      -- compose 内部网络里的服务名：流量走 docker 的 host-local 网桥，不出网卡。
      OR base_url LIKE 'http://lanehub:%');
INSERT INTO schema_version(version) VALUES(14) ON CONFLICT DO NOTHING;

-- 媒体按 USD 报价，钱包记 CNY。汇率是管理员维护的账本参数，不在请求时联网取值，
-- 保证迁移与历史计费可复现；每笔冻结把当时的汇率写进 price_snapshot。
ALTER TABLE billing_policy ADD COLUMN IF NOT EXISTS usd_cny numeric(12,4) NOT NULL DEFAULT 7.3 CHECK(usd_cny>0);
INSERT INTO schema_version(version) VALUES(15) ON CONFLICT DO NOTHING;

-- ── lanehub 接入：额度真源搬到 lanehub 之后，这一侧只留映射与入账幂等 ──────────
-- 设计说明见 src/lanehub.mjs 的文件头。
CREATE TABLE IF NOT EXISTS app_settings (
  key text PRIMARY KEY, value text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
-- 一个客户 = lanehub 的一个用户 + 一个令牌。令牌落成 upstream_keys 行，
-- 转发 / 并发闸 / requests.key_id 外键 / 尝试记录都能原样复用。
CREATE TABLE IF NOT EXISTS lanehub_accounts (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  lanehub_user_id integer NOT NULL,
  key_id uuid NOT NULL REFERENCES upstream_keys(id),
  lane text NOT NULL DEFAULT 'official',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS lanehub_accounts_lanehub_user ON lanehub_accounts(lanehub_user_id);
-- 充值入账的幂等表。reference = 支付单号 / 兑换码 id / 迁移批次+客户，
-- 支付回调重放和迁移脚本重跑都落在同一行上——否则每重放一次就是白送一次钱。
CREATE TABLE IF NOT EXISTS lanehub_credits (
  reference text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  amount_cny numeric NOT NULL CHECK (amount_cny > 0),
  quota bigint NOT NULL CHECK (quota > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz
);

-- 退款：已结算的账单可以被人工退掉一部分或全部。不改 charged_cny（它是「当时收了多少」
-- 的事实），另记 refunded_cny，净额 = charged - refunded。所有分成口径都按净额算。
ALTER TABLE request_billing ADD COLUMN IF NOT EXISTS refunded_cny numeric(20,8) NOT NULL DEFAULT 0 CHECK(refunded_cny>=0);

-- 结算单：给插件作者人工打款用的凭据。冻结之后金额锁死，之后发生的退款不回溯改它，
-- 而是作为一条负数计提落到下一张单里——已经打出去的钱不能被事后改账。
CREATE TABLE IF NOT EXISTS settlements (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES developer_profiles(user_id),
  period_from date NOT NULL, period_to date NOT NULL,
  state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','frozen','paid','void')),
  amount_cny numeric(20,8) NOT NULL DEFAULT 0, item_count integer NOT NULL DEFAULT 0,
  note text NOT NULL DEFAULT '', paid_note text NOT NULL DEFAULT '',
  created_by integer REFERENCES administrators(id),
  created_at timestamptz NOT NULL DEFAULT now(), frozen_at timestamptz, paid_at timestamptz
);
CREATE INDEX IF NOT EXISTS settlements_owner ON settlements(owner_user_id,created_at DESC);

-- 分成明细：**作者应得的唯一真源**。计提一行，退款再记一行负数——
-- 报表和结算单都从这里汇总，不各自再按 charged_cny 算一遍。
-- 两份口径只要差一点，打出去的钱就是错的。
CREATE TABLE IF NOT EXISTS plugin_earnings (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES requests(id),
  owner_user_id uuid NOT NULL REFERENCES developer_profiles(user_id),
  plugin_id uuid REFERENCES plugins(id),
  kind text NOT NULL CHECK(kind IN ('accrual','refund')),
  amount_cny numeric(20,8) NOT NULL,
  settlement_id uuid REFERENCES settlements(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
-- 一笔请求只能计提一次；退款可以多次（部分退）。
CREATE UNIQUE INDEX IF NOT EXISTS plugin_earnings_accrual ON plugin_earnings(request_id) WHERE kind='accrual';
CREATE INDEX IF NOT EXISTS plugin_earnings_open ON plugin_earnings(owner_user_id,created_at) WHERE settlement_id IS NULL;
CREATE INDEX IF NOT EXISTS plugin_earnings_settlement ON plugin_earnings(settlement_id);
-- 一次性回填：上线之前已经结算过的请求也要有计提，否则作者的第一张结算单会漏掉
-- 全部历史收益。挂在 schema_version 上，只跑一次（ON CONFLICT 也保证重跑无害）。
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_version WHERE version=11) THEN
    INSERT INTO plugin_earnings (id,request_id,owner_user_id,plugin_id,kind,amount_cny)
    SELECT gen_random_uuid(),r.id,r.plugin_owner_user_id,r.plugin_id,'accrual',
      round((b.charged_cny-b.refunded_cny)*r.plugin_share_bps/10000,8)
    FROM requests r JOIN request_billing b ON b.request_id=r.id
    WHERE r.plugin_owner_user_id IS NOT NULL AND coalesce(r.plugin_share_bps,0)>0
      AND b.state='settled' AND (b.charged_cny-b.refunded_cny)>0
    ON CONFLICT DO NOTHING;
    INSERT INTO schema_version(version) VALUES(11);
  END IF;
END $$;

-- 文档转 Excel：**自己不发模型请求**的插件，模型走 Host 的 llm 服务。
-- credential_paths 是空的，这不是漏了——它没有自己的密钥配置槽。桌面端据此为它
-- 单独注册一条 provider（凭据走环境变量，不落盘），请求因此带着这个插件的凭据，
-- 网关才归属得到它，作者的分成才算得出来。
INSERT INTO plugins(id,slug,name,repository,package_name,publisher_ref,allowed_models,runtime_id,runtime_config,credential_paths)
VALUES('7d8b7d87-b85f-49f1-bde7-a0b1a2f33402','ipzsk-doc-to-excel','文档转 Excel','JayceHuang/ipzsk-doc-to-excel','dsh-doc-to-excel','JayceHuang',
 ARRAY['gpt-5.6-sol'],'doc-to-excel','{}','[]') ON CONFLICT DO NOTHING;

-- ── 按调用次数给 skill 作者计提 ──────────────────────────────────────────
--
-- 用户侧按 token 收费（真实成本），作者侧按**调用次数**计提。两边的计量单位
-- 故意不同：用户为算力付费，作者为「他的方法论被用了一次」收费。
--
-- 为什么不按 token 分给作者：实测一次 agent 调用 17644 token，同样一句话裸调用
-- 只要 56——99% 的消耗是 harness 的系统提示词、工具定义和工作区上下文，跟 skill
-- 作者无关。按 token 分，等于让作者分走平台基础设施产生的消耗；还带出一串没有
-- 标准答案的问题（一轮加载两个 skill 怎么分、加载后第五轮还算不算、作者故意让
-- skill 常驻套利）。按次数计，这四个问题一次消失。
--
-- 市面上的成熟做法也支持这个判断：SKILL.md 类市场（Agensi 等）走一次性买断，
-- OpenRouter 做了完整的 app 归属却刻意不与收入挂钩，真正按用量分成的
-- （Apify、MCP server）都是「作者的代码在跑」，归属天然成立。
ALTER TABLE plugins ADD COLUMN IF NOT EXISTS price_per_call_cny numeric(20,8) NOT NULL DEFAULT 0
  CHECK(price_per_call_cny>=0);

-- skill 登记：**分成的前提是上架登记过**。skills 是本地文件，谁都能往
-- ~/.dsh/skills 里扔一个，所以只有登记在案、且归属到某个插件的 skill 才计提；
-- 本地随手放的 skill 照常能用，只是不产生任何计提。
--
-- 借 OpenRouter 那条做法：**首次登记时确权，之后请求头只做匹配、不改写归属**。
-- 请求里报的 skill 名对不上任何一行，就当没报过——不报错、不计提。
CREATE TABLE IF NOT EXISTS plugin_skills (
  skill_ref text PRIMARY KEY,
  plugin_id uuid NOT NULL REFERENCES plugins(id),
  display_name text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS plugin_skills_plugin ON plugin_skills(plugin_id);

ALTER TABLE plugin_earnings ADD COLUMN IF NOT EXISTS skill_ref text;
ALTER TABLE plugin_earnings DROP CONSTRAINT IF EXISTS plugin_earnings_kind_check;
ALTER TABLE plugin_earnings ADD CONSTRAINT plugin_earnings_kind_check
  CHECK(kind IN ('accrual','refund','invocation'));
-- 一次请求可以加载多个 skill，各记各的一条，所以唯一键要带上 skill_ref。
CREATE UNIQUE INDEX IF NOT EXISTS plugin_earnings_invocation
  ON plugin_earnings(request_id,skill_ref) WHERE kind='invocation';

-- 未登记 skill 的观测。
--
-- 没登记的 skill 不计提（分成的前提是上架确权），但**不该静默丢掉**：有人在大量
-- 使用某个还没上架的 skill，正是最该去谈合作的线索。实测就撞见过一次——用户机器上
-- 的 guizang-ppt-skill 被高频调用，而我方只看得到自己登记过的那个。
CREATE TABLE IF NOT EXISTS skill_sightings (
  skill_ref text PRIMARY KEY,
  sightings bigint NOT NULL DEFAULT 0,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now()
);

-- ── 2026-09-13 从生产孤本合回：内容工作台、R2 图片归档、新人赠额（见 git 分支 prod-uncommitted-20260913）──
-- R2 image archive: ownership remains authoritative in requests.user_id/plugin_id.
CREATE TABLE IF NOT EXISTS image_archives (
  task_id uuid PRIMARY KEY REFERENCES media_tasks(id),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','completed')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text, archived_at timestamptz
);
CREATE INDEX IF NOT EXISTS image_archives_pending ON image_archives(next_attempt_at) WHERE state='pending';
CREATE TABLE IF NOT EXISTS archived_images (
  task_id uuid NOT NULL REFERENCES image_archives(task_id),
  image_index integer NOT NULL CHECK(image_index>=0),
  object_key text NOT NULL UNIQUE,
  content_type text NOT NULL CHECK(content_type IN ('image/png','image/jpeg','image/webp')),
  bytes integer NOT NULL CHECK(bytes>0 AND bytes<=32000000),
  sha256 text NOT NULL CHECK(length(sha256)=64),
  PRIMARY KEY(task_id,image_index)
);
INSERT INTO schema_version(version) VALUES(14) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS content_workspaces (
 user_id uuid PRIMARY KEY REFERENCES users(id),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 payload jsonb NOT NULL CHECK(octet_length(payload::text)<=2500000),
 updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO schema_version(version) VALUES(15) ON CONFLICT DO NOTHING;

-- One-time switch to prepaid points. Existing credits and settled price snapshots remain intact.
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM schema_version WHERE version=16) THEN
    -- 原版在这里把本地预扣打开并设 2.5 倍率（预付点数）。lanehub 模式下额度真源在对面，
    -- 本地预扣必须关着（lanehub-switch 的前置检查会拦），所以这里只记版本号不翻开关。
    INSERT INTO schema_version(version) VALUES(16);
  END IF;
END $$;

-- A verified, newly created email account receives one 5 CNY (500 point) signup credit.
ALTER TABLE wallet_entries ALTER COLUMN voucher_id DROP NOT NULL;
ALTER TABLE wallet_entries ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'voucher';
DO $$ BEGIN
  -- conrelid scopes the check to this schema's table (tests run many schemas in one database).
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='wallet_entries_source_check' AND conrelid='wallet_entries'::regclass) THEN
    ALTER TABLE wallet_entries ADD CONSTRAINT wallet_entries_source_check
      CHECK((source='voucher' AND voucher_id IS NOT NULL) OR (source='signup_bonus' AND voucher_id IS NULL));
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS wallet_entries_signup_bonus ON wallet_entries(user_id) WHERE source='signup_bonus';
INSERT INTO schema_version(version) VALUES(17) ON CONFLICT DO NOTHING;

-- v18: unified roles on customer (better-auth) accounts. No row = ordinary user;
-- developer is still derived from developer_profiles.state='approved'.
CREATE TABLE IF NOT EXISTS user_roles (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('admin','operator','viewer')),
  granted_by uuid REFERENCES users(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role)
);
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS actor_user_id uuid REFERENCES users(id);
INSERT INTO schema_version(version) VALUES(18) ON CONFLICT DO NOTHING;

-- v19: media assets (private R2, keys u/{user_id}/{asset_id}/orig.{ext}), folders.
CREATE TABLE IF NOT EXISTS media_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('image','video')),
  source text NOT NULL CHECK (source IN ('upload','generation','case','poster')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready','failed','deleted')),
  object_key text NOT NULL UNIQUE,
  content_type text NOT NULL CHECK (content_type IN ('image/png','image/jpeg','image/webp','video/mp4')),
  bytes bigint CHECK (bytes > 0 AND bytes <= 209715200),
  sha256 text,
  width int, height int, duration_ms int,
  variants jsonb,
  poster_id uuid REFERENCES media_assets(id),
  task_id uuid REFERENCES media_tasks(id),
  result_index int,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  thumb_state text NOT NULL DEFAULT 'none' CHECK (thumb_state IN ('none','queued','running','done','skipped','failed')),
  thumb_attempts int NOT NULL DEFAULT 0,
  thumb_next_at timestamptz,
  thumb_error text
);
CREATE INDEX IF NOT EXISTS media_assets_user_recent ON media_assets (user_id, created_at DESC) WHERE status <> 'deleted';
CREATE INDEX IF NOT EXISTS media_assets_pending ON media_assets (created_at) WHERE status = 'pending';
-- running is included so a job lost to a crash/OOM is reclaimed once its lease (thumb_next_at) passes.
CREATE INDEX IF NOT EXISTS media_assets_thumb_due ON media_assets (thumb_next_at) WHERE thumb_state IN ('queued','failed','running');
CREATE TABLE IF NOT EXISTS asset_folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  position double precision NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);
CREATE TABLE IF NOT EXISTS asset_folder_items (
  folder_id uuid NOT NULL REFERENCES asset_folders(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  position double precision NOT NULL DEFAULT 0,
  PRIMARY KEY (folder_id, asset_id)
);
INSERT INTO schema_version(version) VALUES(19) ON CONFLICT DO NOTHING;

-- v20: studio records, threads, queue, templates, subjects, favorites. Threads before records (FK).
CREATE TABLE IF NOT EXISTS generation_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT '' CHECK (char_length(title) <= 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS generation_threads_user ON generation_threads (user_id, updated_at DESC) WHERE deleted_at IS NULL;
-- requests has no body column, so prompt/params live here (user-facing), billing stays in requests/request_billing.
CREATE TABLE IF NOT EXISTS generation_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id uuid UNIQUE REFERENCES requests(id),
  task_id uuid UNIQUE REFERENCES media_tasks(id),
  batch_id uuid,
  batch_position int CHECK (batch_position BETWEEN 0 AND 11),
  anchor_record_id uuid REFERENCES generation_records(id),
  parent_record_id uuid REFERENCES generation_records(id),
  kind text NOT NULL CHECK (kind IN ('image','video')),
  model text NOT NULL,
  prompt text NOT NULL,
  params jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  failure_code text,
  charged_points numeric(20,8),
  thread_id uuid REFERENCES generation_threads(id) ON DELETE SET NULL,
  source text NOT NULL DEFAULT 'studio' CHECK (source IN ('studio','template','canvas')),
  mentions jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(mentions) = 'array' AND jsonb_array_length(mentions) <= 20),
  prompt_doc jsonb CHECK (octet_length(prompt_doc::text) <= 100000), -- app caps JSON at 50KB; jsonb::text adds spaces
  source_case_id text,
  canvas_node jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS generation_records_user_recent ON generation_records (user_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS generation_records_thread ON generation_records (thread_id, created_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS generation_records_active ON generation_records (user_id) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS generation_records_batch ON generation_records (user_id, batch_id, batch_position);
CREATE TABLE IF NOT EXISTS generation_references (
  record_id uuid NOT NULL REFERENCES generation_records(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES media_assets(id),
  position int NOT NULL,
  PRIMARY KEY (record_id, position)
);
-- Results are media_assets rows found by task_id + result_index.
CREATE UNIQUE INDEX IF NOT EXISTS media_assets_task_result ON media_assets (task_id, result_index) WHERE task_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS favorites (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type text NOT NULL CHECK (target_type IN ('case','asset')),
  target_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, target_type, target_id)
);
CREATE TABLE IF NOT EXISTS composer_queues (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  items jsonb NOT NULL DEFAULT '[]',
  revision int NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_array_length(items) <= 12),
  CHECK (octet_length(items::text) <= 200000)
);
CREATE TABLE IF NOT EXISTS user_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  cover_id uuid REFERENCES media_assets(id),
  items jsonb NOT NULL,
  variables jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK (jsonb_array_length(items) BETWEEN 1 AND 12)
);
CREATE INDEX IF NOT EXISTS user_templates_user ON user_templates (user_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS subjects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 30),
  kind text NOT NULL DEFAULT 'person' CHECK (kind IN ('person','character','product','object','scene')),
  cover_id uuid REFERENCES media_assets(id),
  note text CHECK (char_length(note) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS subjects_user_name ON subjects (user_id, lower(name)) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS subject_assets (
  subject_id uuid NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES media_assets(id),
  position int NOT NULL,
  PRIMARY KEY (subject_id, asset_id)
);
INSERT INTO schema_version(version) VALUES(20) ON CONFLICT DO NOTHING;

-- v21: canvas projects, inspiration cases (case library).
CREATE TABLE IF NOT EXISTS canvas_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT '未命名画布' CHECK (char_length(title) <= 80),
  document jsonb NOT NULL, -- {version,nodes,edges,groups,viewport}; media only as media_assets ids
  revision int NOT NULL DEFAULT 1,
  thumb_id uuid REFERENCES media_assets(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK (octet_length(document::text) <= 2500000)
);
CREATE INDEX IF NOT EXISTS canvas_projects_user_recent ON canvas_projects (user_id, updated_at DESC) WHERE deleted_at IS NULL;
-- Search is ILIKE over title/prompt/tags plus category filter: fine at ~1k rows. Add pg_trgm GIN indexes when it grows.
CREATE TABLE IF NOT EXISTS inspiration_cases (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{1,100}$'),
  title text NOT NULL,
  prompt text NOT NULL,
  category text NOT NULL,
  category_zh text,
  tags text[] NOT NULL DEFAULT '{}',
  model text,
  params jsonb NOT NULL DEFAULT '{}',
  template jsonb CHECK (template IS NULL OR (jsonb_typeof(template->'items') = 'array' AND jsonb_array_length(template->'items') BETWEEN 1 AND 12)),
  cover_id uuid NOT NULL REFERENCES media_assets(id),
  cover_source text, -- import source URL/path; re-import skips the fetch when unchanged
  author text, author_url text, source_url text, source_repo text, license_note text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','hidden')),
  position double precision NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inspiration_cases_feed ON inspiration_cases (status, category, position);
CREATE INDEX IF NOT EXISTS inspiration_cases_all ON inspiration_cases (status, position, id);
CREATE TABLE IF NOT EXISTS inspiration_case_references (
  case_id text NOT NULL REFERENCES inspiration_cases(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES media_assets(id),
  position int NOT NULL,
  PRIMARY KEY (case_id, position)
);
CREATE INDEX IF NOT EXISTS asset_folder_items_asset ON asset_folder_items (asset_id);
INSERT INTO schema_version(version) VALUES(21) ON CONFLICT DO NOTHING;

-- v22: admin console (B5, docs/admin-api.md): list indexes for /api/admin/generations and /api/admin/audit,
-- Idempotency-Key replay for POST /api/admin/cases (24h; a stale row is overwritten by the next use of the key).
CREATE INDEX IF NOT EXISTS generation_records_recent ON generation_records (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS generation_records_model_recent ON generation_records (model, created_at DESC);
CREATE INDEX IF NOT EXISTS generation_records_status_recent ON generation_records (status, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_actor ON audit_events (actor_user_id, id DESC) WHERE actor_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_events_target ON audit_events (target_id, id DESC);
CREATE TABLE IF NOT EXISTS admin_idempotency (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key text NOT NULL,
  fingerprint text NOT NULL,
  case_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
INSERT INTO schema_version(version) VALUES(22) ON CONFLICT DO NOTHING;

-- v23: 数字人（HeyGen via lanehub）. Audio assets (mp3/wav, duration_ms measured server-side by ffprobe) and
-- avatar subjects (HeyGen library reference in external_ref, or photo assets). CHECKs are replaced only while they lack
-- the new values, so re-running does not rescan media_assets.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='media_assets'::regclass AND conname='media_assets_kind_check' AND pg_get_constraintdef(oid) LIKE '%audio%') THEN
    ALTER TABLE media_assets DROP CONSTRAINT IF EXISTS media_assets_kind_check;
    ALTER TABLE media_assets ADD CONSTRAINT media_assets_kind_check CHECK (kind IN ('image','video','audio'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='media_assets'::regclass AND conname='media_assets_content_type_check' AND pg_get_constraintdef(oid) LIKE '%audio/mpeg%') THEN
    ALTER TABLE media_assets DROP CONSTRAINT IF EXISTS media_assets_content_type_check;
    ALTER TABLE media_assets ADD CONSTRAINT media_assets_content_type_check
      CHECK (content_type IN ('image/png','image/jpeg','image/webp','video/mp4','audio/mpeg','audio/wav','audio/x-wav'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='subjects'::regclass AND conname='subjects_kind_check' AND pg_get_constraintdef(oid) LIKE '%avatar%') THEN
    ALTER TABLE subjects DROP CONSTRAINT IF EXISTS subjects_kind_check;
    ALTER TABLE subjects ADD CONSTRAINT subjects_kind_check CHECK (kind IN ('person','character','product','object','scene','avatar'));
  END IF;
END $$;
-- {provider:'heygen', avatar_id, name, preview_image_url, preview_video_url}; only for kind='avatar'.
ALTER TABLE subjects ADD COLUMN IF NOT EXISTS external_ref jsonb
  CHECK (external_ref IS NULL OR (jsonb_typeof(external_ref)='object' AND octet_length(external_ref::text) <= 8000));
INSERT INTO schema_version(version) VALUES(23) ON CONFLICT DO NOTHING;

-- v24: image archives give up permanently (state 'failed', last_error upstream_expired / attempts_exhausted) instead of retrying
-- expired upstream result URLs forever. The CHECK is replaced only while it lacks 'failed'.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='image_archives'::regclass AND conname='image_archives_state_check' AND pg_get_constraintdef(oid) LIKE '%failed%') THEN
    ALTER TABLE image_archives DROP CONSTRAINT IF EXISTS image_archives_state_check;
    ALTER TABLE image_archives ADD CONSTRAINT image_archives_state_check CHECK (state IN ('pending','completed','failed'));
  END IF;
END $$;
INSERT INTO schema_version(version) VALUES(24) ON CONFLICT DO NOTHING;

-- v25: Waffo checkout orders and durable verified webhook receipts. Test orders never enter wallets.
CREATE TABLE IF NOT EXISTS payment_orders (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  mode text NOT NULL CHECK(mode IN ('test','prod')),
  pack_key text NOT NULL CHECK(pack_key IN ('cny_10','cny_50','cny_100')),
  product_id text NOT NULL,
  amount_cny numeric(20,8) NOT NULL CHECK(amount_cny IN (10,50,100)),
  currency text NOT NULL CHECK(currency='CNY'),
  idempotency_key uuid NOT NULL,
  target text NOT NULL CHECK(target IN ('test','lanehub','local')),
  lanehub_user_id integer,
  quota bigint CHECK(quota>0),
  checkout_session_id text,
  provider_order_id text,
  state text NOT NULL DEFAULT 'creating' CHECK(state IN ('creating','checkout_ready','checkout_failed','paid','crediting','credited','test_completed','refund_review','review_required')),
  review_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  credited_at timestamptz,
  UNIQUE(user_id,idempotency_key), UNIQUE(mode,provider_order_id),
  CHECK((mode='test')=(target='test')),
  CHECK(target<>'lanehub' OR (lanehub_user_id IS NOT NULL AND quota IS NOT NULL)),
  CHECK(mode='prod' OR state NOT IN ('paid','crediting','credited'))
);
CREATE INDEX IF NOT EXISTS payment_orders_user ON payment_orders(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS payment_orders_delivery ON payment_orders(state,created_at) WHERE state IN ('paid','crediting','review_required','refund_review');
CREATE TABLE IF NOT EXISTS payment_events (
  mode text NOT NULL CHECK(mode IN ('test','prod')),
  event_id text NOT NULL,
  event_type text NOT NULL,
  provider_order_id text NOT NULL,
  order_id uuid NOT NULL REFERENCES payment_orders(id),
  payload_hash text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(mode,event_id)
);
ALTER TABLE wallet_entries ADD COLUMN IF NOT EXISTS payment_order_id uuid UNIQUE REFERENCES payment_orders(id);
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM schema_version WHERE version=25) THEN
    ALTER TABLE wallet_entries DROP CONSTRAINT wallet_entries_source_check;
    ALTER TABLE wallet_entries ADD CONSTRAINT wallet_entries_source_check CHECK (
      (source='voucher' AND voucher_id IS NOT NULL AND payment_order_id IS NULL) OR
      (source='signup_bonus' AND voucher_id IS NULL AND payment_order_id IS NULL) OR
      (source='payment' AND voucher_id IS NULL AND payment_order_id IS NOT NULL));
    INSERT INTO schema_version(version) VALUES(25);
  END IF;
END $$;

-- v26: video / 数字人 inspiration cases. Existing rows are image cases (kind DEFAULT 'image').
-- video_id: the example video (media_assets kind 'video'); a case without its own cover points cover_id at that video
-- and shows its ffmpeg poster. video_source: import source URL, re-import skips the fetch when unchanged (like cover_source).
-- license_tier: A = author's own prompt under the repo licence, B = curated repost (rights stay with the original author).
ALTER TABLE inspiration_cases ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'image' CHECK (kind IN ('image','video','avatar'));
ALTER TABLE inspiration_cases ADD COLUMN IF NOT EXISTS video_id uuid REFERENCES media_assets(id);
ALTER TABLE inspiration_cases ADD COLUMN IF NOT EXISTS video_source text;
ALTER TABLE inspiration_cases ADD COLUMN IF NOT EXISTS license_tier text CHECK (license_tier IN ('A','B'));
CREATE INDEX IF NOT EXISTS inspiration_cases_kind_feed ON inspiration_cases (status, kind, category, position);
CREATE INDEX IF NOT EXISTS inspiration_cases_kind_all ON inspiration_cases (status, kind, position, id);
INSERT INTO schema_version(version) VALUES(26) ON CONFLICT DO NOTHING;

-- v27: admin wallet grants (POST /api/admin/users/:id/wallet-grants). source='admin_grant' needs a reason (note) and the
-- granting admin; like 'payment', in lanehub mode the row is the local history of a quota credited on lanehub.
ALTER TABLE wallet_entries ADD COLUMN IF NOT EXISTS note text;
ALTER TABLE wallet_entries ADD COLUMN IF NOT EXISTS granted_by uuid REFERENCES users(id);
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM schema_version WHERE version=27) THEN
    ALTER TABLE wallet_entries DROP CONSTRAINT IF EXISTS wallet_entries_source_check;
    ALTER TABLE wallet_entries ADD CONSTRAINT wallet_entries_source_check CHECK (
      (source='voucher' AND voucher_id IS NOT NULL AND payment_order_id IS NULL) OR
      (source='signup_bonus' AND voucher_id IS NULL AND payment_order_id IS NULL) OR
      (source='payment' AND voucher_id IS NULL AND payment_order_id IS NOT NULL) OR
      (source='admin_grant' AND voucher_id IS NULL AND payment_order_id IS NULL AND granted_by IS NOT NULL
        AND char_length(btrim(coalesce(note,'')))>=2));
    INSERT INTO schema_version(version) VALUES(27);
  END IF;
END $$;

-- v28: 每笔退款一个自增序号，作为 lanehub 入账的幂等键（refund:<请求 id>:<序号>）。
-- 原来用「refund 计提行数」当序号：没有插件归属的请求永远不会写计提行，第二次部分退款
-- 会撞上同一个 reference `refund:<id>:0`，被 creditAccount 静默吞掉——账面记了退款，用户没拿到钱。
ALTER TABLE request_billing ADD COLUMN IF NOT EXISTS refund_seq integer NOT NULL DEFAULT 0 CHECK(refund_seq>=0);
INSERT INTO schema_version(version) VALUES(28) ON CONFLICT DO NOTHING;
