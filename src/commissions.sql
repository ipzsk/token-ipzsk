-- Permanent API consumption commission. Historical requests/earnings stay in the legacy ledger.
-- bd_share_bps applies to net paid consumption; developer_share_bps applies to the remaining profit
-- after the paid share of actual upstream cost and the BD commission. enabled is the only switch.
CREATE TABLE IF NOT EXISTS commission_policy (
  id integer PRIMARY KEY CHECK(id=1), enabled boolean NOT NULL DEFAULT false,
  bd_share_bps integer NOT NULL DEFAULT 2000 CHECK(bd_share_bps BETWEEN 0 AND 10000),
  developer_share_bps integer NOT NULL DEFAULT 4000 CHECK(developer_share_bps BETWEEN 0 AND 10000)
);
INSERT INTO commission_policy(id) VALUES(1) ON CONFLICT DO NOTHING;
ALTER TABLE commission_policy ADD COLUMN IF NOT EXISTS bd_share_bps integer NOT NULL DEFAULT 2000 CHECK(bd_share_bps BETWEEN 0 AND 10000);
ALTER TABLE commission_policy ADD COLUMN IF NOT EXISTS developer_share_bps integer NOT NULL DEFAULT 4000 CHECK(developer_share_bps BETWEEN 0 AND 10000);
ALTER TABLE commission_policy ALTER COLUMN developer_share_bps SET DEFAULT 4000;
ALTER TABLE commission_policy DROP COLUMN IF EXISTS started_at, DROP COLUMN IF EXISTS ends_at;
UPDATE commission_policy SET bd_share_bps=2000,developer_share_bps=4000 WHERE id=1;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS skill_calls jsonb NOT NULL DEFAULT '[]';
ALTER TABLE requests ADD COLUMN IF NOT EXISTS skill_attribution_state text NOT NULL DEFAULT 'none';
ALTER TABLE requests ADD COLUMN IF NOT EXISTS lanehub_reconciled_at timestamptz;
CREATE TABLE IF NOT EXISTS commission_skill_versions (
  skill_ref text NOT NULL REFERENCES plugin_skills(skill_ref),
  content_sha256 text NOT NULL CHECK(content_sha256 ~ '^[a-f0-9]{64}$'),
  enabled boolean NOT NULL DEFAULT true, PRIMARY KEY(skill_ref,content_sha256)
);
CREATE TABLE IF NOT EXISTS referral_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  code text UNIQUE NOT NULL DEFAULT replace(gen_random_uuid()::text,'-',''),
  bd_active boolean NOT NULL DEFAULT false, frozen boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS referral_registrations (
  auth_user_id text PRIMARY KEY, referrer_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS referrals (
  user_id uuid PRIMARY KEY REFERENCES users(id), referrer_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(), CHECK(user_id<>referrer_id)
);
CREATE TABLE IF NOT EXISTS commission_payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id),
  idempotency_key uuid NOT NULL, amount_cny numeric(20,8) NOT NULL CHECK(amount_cny>=100),
  state text NOT NULL DEFAULT 'requested' CHECK(state IN ('requested','approved','paid','cancelled')),
  payment_reference text, created_at timestamptz NOT NULL DEFAULT now(), paid_at timestamptz,
  UNIQUE(user_id,idempotency_key)
);
CREATE TABLE IF NOT EXISTS commission_ledger (
  id bigserial PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
  request_id uuid REFERENCES requests(id), referred_user_id uuid REFERENCES users(id),
  kind text NOT NULL CHECK(kind IN ('bd','developer','invitation','conversion','payout')),
  amount_cny numeric(20,8) NOT NULL, available_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), reference text NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS commission_ledger_user ON commission_ledger(user_id,available_at);
CREATE TABLE IF NOT EXISTS commission_conversions (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), amount_cny numeric(20,8) NOT NULL CHECK(amount_cny>=0.01),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','applying','applied','review','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS commission_funds (
  id text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), payment_order_id uuid REFERENCES payment_orders(id),
  paid boolean NOT NULL, amount_cny numeric(20,8) NOT NULL CHECK(amount_cny>0),
  remaining_cny numeric(20,8) NOT NULL CHECK(remaining_cny>=0),
  created_at timestamptz NOT NULL DEFAULT now(), CHECK(remaining_cny<=amount_cny)
);
CREATE INDEX IF NOT EXISTS commission_funds_user ON commission_funds(user_id,created_at,id);
CREATE TABLE IF NOT EXISTS commission_allocations (
  request_id uuid NOT NULL REFERENCES requests(id), fund_id text NOT NULL REFERENCES commission_funds(id),
  amount_cny numeric(20,8) NOT NULL CHECK(amount_cny>0), returned_cny numeric(20,8) NOT NULL DEFAULT 0,
  PRIMARY KEY(request_id,fund_id), CHECK(returned_cny>=0 AND returned_cny<=amount_cny)
);
ALTER TABLE commission_allocations ADD COLUMN IF NOT EXISTS chargeback_cny numeric(20,8) NOT NULL DEFAULT 0 CHECK(chargeback_cny>=0);
CREATE TABLE IF NOT EXISTS commission_requests (
  request_id uuid PRIMARY KEY REFERENCES requests(id), bd_user_id uuid REFERENCES users(id),
  enabled boolean NOT NULL DEFAULT false,
  developer_user_id uuid REFERENCES users(id), charged_cny numeric(20,8),
  paid_cny numeric(20,8), refunded_cny numeric(20,8) NOT NULL DEFAULT 0,
  bd_share_bps integer NOT NULL DEFAULT 2000 CHECK(bd_share_bps BETWEEN 0 AND 10000),
  developer_share_bps integer NOT NULL DEFAULT 4000 CHECK(developer_share_bps BETWEEN 0 AND 10000),
  -- Formula snapshot: profit (current rule), consumption (schema 31, 35% of paid consumption),
  -- legacy_profit (schema 30, BD and developer both from profit after cost).
  developer_basis text NOT NULL DEFAULT 'profit' CHECK(developer_basis IN ('legacy_profit','consumption','profit')),
  bd_cny numeric(20,8) NOT NULL DEFAULT 0, developer_cny numeric(20,8) NOT NULL DEFAULT 0,
  revision integer NOT NULL DEFAULT 0,
  state text NOT NULL DEFAULT 'pending_billing' CHECK(state IN ('pending_billing','pending_sources','pending_cost','accrued','disputed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE commission_requests ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT false;
ALTER TABLE commission_requests ADD COLUMN IF NOT EXISTS bd_share_bps integer NOT NULL DEFAULT 2000 CHECK(bd_share_bps BETWEEN 0 AND 10000);
ALTER TABLE commission_requests ADD COLUMN IF NOT EXISTS developer_share_bps integer NOT NULL DEFAULT 4000 CHECK(developer_share_bps BETWEEN 0 AND 10000);
ALTER TABLE commission_requests ALTER COLUMN developer_share_bps SET DEFAULT 4000;
-- Existing rows keep the formula they were created under; schema 31 already stamped its 20%/35% rates.
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema()
      AND table_name='commission_requests' AND column_name='developer_basis') THEN
    ALTER TABLE commission_requests ADD COLUMN developer_basis text NOT NULL DEFAULT 'legacy_profit'
      CHECK(developer_basis IN ('legacy_profit','consumption','profit'));
    IF EXISTS(SELECT 1 FROM schema_version WHERE version=31) THEN
      UPDATE commission_requests SET developer_basis='consumption';
    END IF;
    ALTER TABLE commission_requests ALTER COLUMN developer_basis SET DEFAULT 'profit';
  END IF;
END $$;
ALTER TABLE commission_requests DROP COLUMN IF EXISTS campaign_ends_at;
ALTER TABLE commission_requests DROP CONSTRAINT commission_requests_state_check;
ALTER TABLE commission_requests ADD CONSTRAINT commission_requests_state_check
  CHECK(state IN ('pending_billing','pending_sources','pending_cost','accrued','disputed','historical_sources_review'));
CREATE TABLE IF NOT EXISTS commission_accounts (
  user_id uuid PRIMARY KEY REFERENCES users(id), sources_confirmed boolean NOT NULL DEFAULT false
);
INSERT INTO commission_accounts(user_id) SELECT id FROM users ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION commission_new_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO commission_accounts(user_id,sources_confirmed) VALUES(NEW.id,true); RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS commission_new_account ON users;
CREATE TRIGGER commission_new_account AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION commission_new_account();
CREATE TABLE IF NOT EXISTS commission_payment_refunds (
  reference text PRIMARY KEY, payment_order_id uuid NOT NULL REFERENCES payment_orders(id),
  amount_cny numeric(20,8) NOT NULL CHECK(amount_cny>0),
  chargeback boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE commission_payment_refunds ADD COLUMN IF NOT EXISTS balance_deduction_cny numeric(20,8) NOT NULL DEFAULT 0 CHECK(balance_deduction_cny>=0);

-- Only newly observed credits acquire a source. Never guess that an old balance was paid.
CREATE OR REPLACE FUNCTION commission_credit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source='service_refund' THEN RETURN NEW; END IF;
  INSERT INTO commission_funds(id,user_id,payment_order_id,paid,amount_cny,remaining_cny,created_at)
    VALUES('wallet:'||NEW.id,NEW.user_id,NEW.payment_order_id,NEW.source='payment' AND EXISTS(SELECT 1 FROM payment_orders WHERE id=NEW.payment_order_id AND mode='prod'),NEW.amount_cny,NEW.amount_cny,NEW.created_at)
    ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS commission_credit ON wallet_entries;
CREATE TRIGGER commission_credit AFTER INSERT ON wallet_entries FOR EACH ROW EXECUTE FUNCTION commission_credit();
CREATE OR REPLACE FUNCTION commission_signup_credit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.applied_at IS NOT NULL AND NEW.reference LIKE 'signup:%' THEN
    INSERT INTO commission_funds(id,user_id,paid,amount_cny,remaining_cny)
      VALUES('lanehub:'||NEW.reference,NEW.user_id,false,NEW.amount_cny,NEW.amount_cny) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS commission_signup_credit ON lanehub_credits;
CREATE TRIGGER commission_signup_credit AFTER INSERT OR UPDATE OF applied_at ON lanehub_credits
  FOR EACH ROW EXECUTE FUNCTION commission_signup_credit();

CREATE OR REPLACE FUNCTION commission_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM 1 FROM users WHERE id=NEW.user_id FOR NO KEY UPDATE;
    INSERT INTO commission_requests(request_id,enabled,bd_user_id,developer_user_id,bd_share_bps,developer_share_bps,developer_basis)
      SELECT NEW.id,p.enabled,
        (SELECT f.referrer_id FROM referrals f JOIN referral_profiles profile ON profile.user_id=f.referrer_id
          WHERE f.user_id=NEW.user_id AND profile.bd_active AND f.referrer_id<>NEW.user_id),
        -- Unverified plugin attribution (bootstrap credential, see v34) never creates a payable developer share.
        CASE WHEN NEW.plugin_owner_user_id<>NEW.user_id AND NEW.plugin_attribution_state<>'credential_unverified' AND EXISTS(
          SELECT 1 FROM developer_profiles WHERE user_id=NEW.plugin_owner_user_id AND state='approved')
          THEN NEW.plugin_owner_user_id END,
        p.bd_share_bps,p.developer_share_bps,'profit'
      FROM commission_policy p WHERE p.id=1;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS commission_snapshot ON requests;
CREATE TRIGGER commission_snapshot AFTER INSERT ON requests FOR EACH ROW EXECUTE FUNCTION commission_snapshot();

CREATE OR REPLACE FUNCTION commission_reconcile(rid uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  r requests%ROWTYPE; b request_billing%ROWTYPE; s commission_requests%ROWTYPE; f commission_funds%ROWTYPE;
  a record; need numeric(20,8); take numeric(20,8); refund_remaining numeric(20,8);
  net_paid numeric(20,8); paid_cost numeric; profit numeric; waiting boolean;
  bd numeric(20,8); dev numeric(20,8);
BEGIN
  -- All source allocation and refunds serialize on the consumer, including parallel model requests.
  SELECT * INTO r FROM requests WHERE id=rid;
  PERFORM 1 FROM users WHERE id=r.user_id FOR NO KEY UPDATE;
  SELECT * INTO s FROM commission_requests WHERE request_id=rid FOR UPDATE;
  IF NOT FOUND OR s.state IN ('disputed','historical_sources_review') THEN RETURN; END IF;
  SELECT * INTO b FROM request_billing WHERE request_id=rid;
  IF NOT FOUND OR b.state NOT IN ('settled','released') THEN RETURN; END IF;
  IF NOT (SELECT sources_confirmed FROM commission_accounts WHERE user_id=r.user_id) THEN
    UPDATE commission_requests SET state='pending_sources' WHERE request_id=rid; RETURN;
  END IF;
  IF s.charged_cny IS NULL THEN
    need:=coalesce(b.charged_cny,0);
    IF (SELECT coalesce(sum(remaining_cny),0) FROM commission_funds WHERE user_id=r.user_id)<need THEN
      UPDATE commission_requests SET state='pending_sources' WHERE request_id=rid; RETURN;
    END IF;
    FOR f IN SELECT * FROM commission_funds WHERE user_id=r.user_id AND remaining_cny>0 ORDER BY created_at,id FOR UPDATE LOOP
      EXIT WHEN need=0;
      take:=least(f.remaining_cny,need);
      INSERT INTO commission_allocations(request_id,fund_id,amount_cny) VALUES(rid,f.id,take);
      UPDATE commission_funds SET remaining_cny=remaining_cny-take WHERE id=f.id;
      need:=need-take;
    END LOOP;
    SELECT coalesce(sum(allocation.amount_cny) FILTER(WHERE fund.paid),0) INTO s.paid_cny
      FROM commission_allocations allocation JOIN commission_funds fund ON fund.id=allocation.fund_id WHERE allocation.request_id=rid;
    s.charged_cny:=coalesce(b.charged_cny,0);
    UPDATE commission_requests SET charged_cny=s.charged_cny,paid_cny=s.paid_cny WHERE request_id=rid;
  END IF;
  -- Restore only new refunds: an earlier rounding unit may already have been spent again.
  IF b.refunded_cny>s.refunded_cny AND s.charged_cny>0 THEN
    refund_remaining:=b.refunded_cny-s.refunded_cny;
    FOR a IN SELECT * FROM commission_allocations WHERE request_id=rid ORDER BY fund_id FOR UPDATE LOOP
      take:=least(refund_remaining,greatest(round(a.amount_cny*b.refunded_cny/s.charged_cny,8)-a.returned_cny,0));
      UPDATE commission_funds SET remaining_cny=remaining_cny+take WHERE id=a.fund_id;
      UPDATE commission_allocations SET returned_cny=returned_cny+take WHERE request_id=rid AND fund_id=a.fund_id;
      refund_remaining:=refund_remaining-take;
    END LOOP;
    FOR a IN SELECT * FROM commission_allocations WHERE request_id=rid ORDER BY fund_id DESC FOR UPDATE LOOP
      EXIT WHEN refund_remaining=0;
      take:=least(refund_remaining,a.amount_cny-a.returned_cny);
      UPDATE commission_funds SET remaining_cny=remaining_cny+take WHERE id=a.fund_id;
      UPDATE commission_allocations SET returned_cny=returned_cny+take WHERE request_id=rid AND fund_id=a.fund_id;
      refund_remaining:=refund_remaining-take;
    END LOOP;
    UPDATE commission_requests SET refunded_cny=b.refunded_cny WHERE request_id=rid;
  END IF;
  IF s.enabled AND EXISTS(SELECT 1 FROM commission_allocations allocation JOIN commission_funds fund ON fund.id=allocation.fund_id
    JOIN payment_orders payment ON payment.id=fund.payment_order_id WHERE allocation.request_id=rid AND payment.state='refund_review') THEN
    UPDATE commission_requests SET state='disputed' WHERE request_id=rid; RETURN;
  END IF;
  IF NOT s.enabled THEN
    UPDATE commission_requests SET state='accrued' WHERE request_id=rid; RETURN;
  END IF;
  SELECT coalesce(sum(allocation.amount_cny-allocation.returned_cny-allocation.chargeback_cny) FILTER(WHERE fund.paid),0) INTO net_paid
    FROM commission_allocations allocation JOIN commission_funds fund ON fund.id=allocation.fund_id WHERE allocation.request_id=rid;
  -- The paid ratio is fixed at allocation; refunds do not return upstream cost. NULL means cost unknown.
  paid_cost:=CASE WHEN s.charged_cny>0 THEN r.cost_cny*s.paid_cny/s.charged_cny ELSE 0 END;
  waiting:=paid_cost IS NULL AND net_paid>0;
  IF s.developer_basis='legacy_profit' THEN
    waiting:=waiting AND (s.bd_user_id IS NOT NULL OR s.developer_user_id IS NOT NULL);
    profit:=greatest(net_paid-coalesce(paid_cost,0),0);
    bd:=CASE WHEN waiting THEN s.bd_cny WHEN s.bd_user_id IS NOT NULL THEN trunc(profit*s.bd_share_bps/10000,8) ELSE 0 END;
    dev:=CASE WHEN waiting THEN s.developer_cny WHEN s.developer_user_id IS NOT NULL THEN trunc((profit-bd)*s.developer_share_bps/10000,8) ELSE 0 END;
  ELSE
    -- BD never waits for cost. The developer share waits for trusted actual cost and absorbs later cost corrections.
    bd:=CASE WHEN s.bd_user_id IS NOT NULL THEN trunc(net_paid*s.bd_share_bps/10000,8) ELSE 0 END;
    waiting:=waiting AND s.developer_basis='profit' AND s.developer_user_id IS NOT NULL;
    profit:=CASE WHEN s.developer_basis='consumption' THEN net_paid ELSE greatest(net_paid-coalesce(paid_cost,0)-bd,0) END;
    dev:=CASE WHEN waiting THEN s.developer_cny WHEN s.developer_user_id IS NOT NULL THEN trunc(profit*s.developer_share_bps/10000,8) ELSE 0 END;
  END IF;
  IF bd<>s.bd_cny THEN
    INSERT INTO commission_ledger(user_id,request_id,kind,amount_cny,available_at,reference)
      VALUES(s.bd_user_id,rid,'bd',bd-s.bd_cny,CASE WHEN bd<s.bd_cny THEN greatest(now(),coalesce((SELECT min(available_at) FROM commission_ledger WHERE request_id=rid AND kind='bd'),now())) ELSE now()+interval '30 days' END,
        'bd:'||rid||':'||(s.revision+1));
  END IF;
  IF dev<>s.developer_cny THEN
    INSERT INTO commission_ledger(user_id,request_id,kind,amount_cny,available_at,reference)
      VALUES(s.developer_user_id,rid,'developer',dev-s.developer_cny,CASE WHEN dev<s.developer_cny THEN greatest(now(),coalesce((SELECT min(available_at) FROM commission_ledger WHERE request_id=rid AND kind='developer'),now())) ELSE now()+interval '30 days' END,
        'developer:'||rid||':'||(s.revision+1));
  END IF;
  UPDATE commission_requests SET bd_cny=bd,developer_cny=dev,
    revision=revision+CASE WHEN bd<>s.bd_cny OR dev<>s.developer_cny THEN 1 ELSE 0 END,
    state=CASE WHEN waiting THEN 'pending_cost' ELSE 'accrued' END WHERE request_id=rid;
END $$;
CREATE OR REPLACE FUNCTION commission_bill_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM commission_reconcile(NEW.request_id); RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS commission_bill_changed ON request_billing;
CREATE TRIGGER commission_bill_changed AFTER INSERT OR UPDATE OF state,charged_cny,refunded_cny ON request_billing
  FOR EACH ROW EXECUTE FUNCTION commission_bill_changed();
CREATE OR REPLACE FUNCTION commission_cost_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM commission_reconcile(NEW.id); RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS commission_cost_changed ON requests;
CREATE TRIGGER commission_cost_changed AFTER UPDATE OF cost_cny ON requests FOR EACH ROW EXECUTE FUNCTION commission_cost_changed();
CREATE OR REPLACE FUNCTION commission_payment_disputed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state='refund_review' THEN
    PERFORM 1 FROM users WHERE id=NEW.user_id FOR NO KEY UPDATE;
    UPDATE commission_requests s SET state='disputed' WHERE EXISTS(
      SELECT 1 FROM commission_allocations a JOIN commission_funds f ON f.id=a.fund_id
      WHERE a.request_id=s.request_id AND f.payment_order_id=NEW.id);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS commission_payment_disputed ON payment_orders;
CREATE TRIGGER commission_payment_disputed AFTER UPDATE OF state ON payment_orders FOR EACH ROW EXECUTE FUNCTION commission_payment_disputed();
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM schema_version WHERE version=29) THEN
    ALTER TABLE wallet_entries DROP CONSTRAINT wallet_entries_source_check;
    ALTER TABLE wallet_entries ADD CONSTRAINT wallet_entries_source_check CHECK (
      (source='voucher' AND voucher_id IS NOT NULL AND payment_order_id IS NULL) OR
      (source IN ('signup_bonus','earnings_conversion','service_refund') AND voucher_id IS NULL AND payment_order_id IS NULL) OR
      (source='payment' AND voucher_id IS NULL AND payment_order_id IS NOT NULL) OR
      (source='admin_grant' AND voucher_id IS NULL AND payment_order_id IS NULL AND granted_by IS NOT NULL AND char_length(btrim(coalesce(note,'')))>=2));
  END IF;
END $$;
INSERT INTO schema_version(version) VALUES(29) ON CONFLICT DO NOTHING;
INSERT INTO schema_version(version) VALUES(30) ON CONFLICT DO NOTHING;
INSERT INTO schema_version(version) VALUES(31) ON CONFLICT DO NOTHING;
INSERT INTO schema_version(version) VALUES(32) ON CONFLICT DO NOTHING;

-- v33: BD and plugin developer identities come only from an administrator invitation accepted by the bound account.
-- token_hash is SHA-256 of a 256-bit single-use token; the plaintext is never stored. Existing BD and approved
-- developer rows stay valid. A pending row past expires_at is treated as expired and materialised on the next write.
-- Audit events reference the invitation through audit_events.target_id = id.
CREATE TABLE IF NOT EXISTS role_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role text NOT NULL CHECK(role IN ('bd','developer')),
  user_id uuid NOT NULL REFERENCES users(id),
  email text NOT NULL CHECK(email=lower(email)),
  display_name text CHECK(display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 100),
  token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
  reason text NOT NULL CHECK(char_length(reason) BETWEEN 5 AND 500),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','accepted','revoked','expired')),
  created_by integer NOT NULL REFERENCES administrators(id),
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  accepted_at timestamptz, revoked_at timestamptz, revoked_by integer REFERENCES administrators(id),
  previous_id uuid REFERENCES role_invitations(id),
  CHECK(expires_at>created_at),
  CHECK((state='accepted')=(accepted_at IS NOT NULL) AND (accepted_at IS NULL OR accepted_at<expires_at)),
  CHECK((state='revoked')=(revoked_at IS NOT NULL AND revoked_by IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS role_invitations_one_pending ON role_invitations(user_id,role) WHERE state='pending';
CREATE INDEX IF NOT EXISTS role_invitations_recent ON role_invitations(created_at DESC);
INSERT INTO schema_version(version) VALUES(33) ON CONFLICT DO NOTHING;

-- v34: LaneHub quota adjustments (credit / debit) form an auditable state machine; see src/lanehub.mjs.
-- Legacy rows: applied_at proves delivery and those rows were booked in the same step. A legacy row without
-- applied_at survived an interrupted remote call, so its result is unknown and it goes to manual review.
ALTER TABLE lanehub_credits ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'credit';
ALTER TABLE lanehub_credits ADD COLUMN IF NOT EXISTS state text;
ALTER TABLE lanehub_credits ADD COLUMN IF NOT EXISTS lanehub_user_id integer;
ALTER TABLE lanehub_credits ADD COLUMN IF NOT EXISTS remark text;
ALTER TABLE lanehub_credits ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}';
ALTER TABLE lanehub_credits ADD COLUMN IF NOT EXISTS review_reason text;
ALTER TABLE lanehub_credits ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE lanehub_credits ADD COLUMN IF NOT EXISTS booked_at timestamptz;
UPDATE lanehub_credits SET state=CASE WHEN applied_at IS NOT NULL THEN 'applied' ELSE 'review' END,
  review_reason=CASE WHEN applied_at IS NULL THEN 'legacy_unconfirmed' END, booked_at=applied_at WHERE state IS NULL;
ALTER TABLE lanehub_credits ALTER COLUMN state SET DEFAULT 'pending', ALTER COLUMN state SET NOT NULL;
CREATE INDEX IF NOT EXISTS lanehub_credits_open ON lanehub_credits(state,updated_at) WHERE state<>'applied' OR booked_at IS NULL;
-- Plugin credentials from desktop bootstrap do not prove the plugin is installed; such attribution is kept
-- for usage statistics but never becomes payable. Existing rows keep 'none' so settled history is unchanged.
ALTER TABLE requests ADD COLUMN IF NOT EXISTS plugin_attribution_state text NOT NULL DEFAULT 'none';
-- Financial invariants. NOT VALID keeps startup working on legacy rows while every new write is checked;
-- the constraint is validated as soon as the existing data allows it.
-- Each constraint is added only if missing (not keyed on schema_version): migrate() re-runs this file, and a
-- schema_version row can be removed to replay older steps without re-adding existing constraints.
DO $$ DECLARE item record; BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('lanehub_credits','lanehub_credits_kind_check',$c$CHECK(kind IN ('credit','debit'))$c$),
    ('lanehub_credits','lanehub_credits_state_check',$c$CHECK(state IN ('pending','applying','applied','review','cancelled'))$c$),
    ('lanehub_credits','lanehub_credits_applied_check',$c$CHECK((state='applied')=(applied_at IS NOT NULL))$c$),
    ('requests','requests_plugin_attribution_state_check',$c$CHECK(plugin_attribution_state IN ('none','credential_unverified','skill_marker'))$c$),
    ('request_billing','request_billing_refund_within_charge',$c$CHECK(refunded_cny<=coalesce(charged_cny,0)) NOT VALID$c$),
    ('commission_allocations','commission_allocations_reversal_within_amount',$c$CHECK(returned_cny+chargeback_cny<=amount_cny) NOT VALID$c$)
  ) AS t(tbl,name,definition) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname=item.name AND connamespace=current_schema()::regnamespace) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I %s', item.tbl, item.name, item.definition);
    END IF;
  END LOOP;
END $$;
DO $$ DECLARE item record; BEGIN
  FOR item IN SELECT conrelid::regclass::text AS tbl,conname FROM pg_constraint WHERE NOT convalidated
    AND conname IN ('request_billing_refund_within_charge','commission_allocations_reversal_within_amount')
    AND connamespace=current_schema()::regnamespace LOOP
    BEGIN
      EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT %I', item.tbl, item.conname);
    EXCEPTION WHEN check_violation THEN
      RAISE WARNING 'legacy rows violate %; new writes are still checked', item.conname;
    END;
  END LOOP;
END $$;
-- Wallet-grant idempotency keys are permanent and live under the `wallet-grant:` prefix (src/grant-idempotency.mjs).
-- Copy legacy grant rows (identified by their grant id in wallet_entries or lanehub_credits) so an old key keeps
-- resolving to its original grant even if the shared row is later rotated by case creation.
INSERT INTO admin_idempotency(user_id,key,fingerprint,case_id,created_at)
  SELECT i.user_id,'wallet-grant:'||i.key,i.fingerprint,i.case_id,i.created_at FROM admin_idempotency i
  WHERE i.key NOT LIKE 'wallet-grant:%' AND (
    EXISTS(SELECT 1 FROM wallet_entries w WHERE w.id::text=i.case_id AND w.source='admin_grant')
    OR EXISTS(SELECT 1 FROM lanehub_credits l WHERE l.reference='admin_grant:'||i.case_id))
  ON CONFLICT (user_id,key) DO NOTHING;
INSERT INTO schema_version(version) VALUES(34) ON CONFLICT DO NOTHING;
