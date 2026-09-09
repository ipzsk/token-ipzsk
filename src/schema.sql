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
ALTER TABLE upstream_accounts ADD CONSTRAINT upstream_accounts_base_url_https CHECK (base_url LIKE 'https://%');
INSERT INTO schema_version(version) VALUES(14) ON CONFLICT DO NOTHING;

-- 媒体按 USD 报价，钱包记 CNY。汇率是管理员维护的账本参数，不在请求时联网取值，
-- 保证迁移与历史计费可复现；每笔冻结把当时的汇率写进 price_snapshot。
ALTER TABLE billing_policy ADD COLUMN IF NOT EXISTS usd_cny numeric(12,4) NOT NULL DEFAULT 7.3 CHECK(usd_cny>0);
INSERT INTO schema_version(version) VALUES(15) ON CONFLICT DO NOTHING;
