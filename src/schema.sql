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
      OR base_url LIKE 'http://127.0.0.1%' OR base_url LIKE 'http://[::1]%');
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
