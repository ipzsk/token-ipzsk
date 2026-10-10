-- Profit commission v1. Historical requests/earnings stay in the legacy ledger.
CREATE TABLE IF NOT EXISTS commission_policy (
  id integer PRIMARY KEY CHECK(id=1), enabled boolean NOT NULL DEFAULT false
);
INSERT INTO commission_policy(id) VALUES(1) ON CONFLICT DO NOTHING;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS skill_calls jsonb NOT NULL DEFAULT '[]';
ALTER TABLE requests ADD COLUMN IF NOT EXISTS skill_attribution_state text NOT NULL DEFAULT 'none';
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
  bd_cny numeric(20,8) NOT NULL DEFAULT 0, developer_cny numeric(20,8) NOT NULL DEFAULT 0,
  revision integer NOT NULL DEFAULT 0,
  state text NOT NULL DEFAULT 'pending_billing' CHECK(state IN ('pending_billing','pending_sources','pending_cost','accrued','disputed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE commission_requests ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT false;
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
    INSERT INTO commission_requests(request_id,enabled,bd_user_id,developer_user_id)
      SELECT NEW.id,(SELECT enabled FROM commission_policy WHERE id=1),
        (SELECT f.referrer_id FROM referrals f JOIN referral_profiles p ON p.user_id=f.referrer_id
          WHERE f.user_id=NEW.user_id AND p.bd_active AND f.referrer_id<>NEW.user_id),
        CASE WHEN NEW.plugin_owner_user_id<>NEW.user_id AND EXISTS(
          SELECT 1 FROM developer_profiles WHERE user_id=NEW.plugin_owner_user_id AND state='approved')
          THEN NEW.plugin_owner_user_id END;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS commission_snapshot ON requests;
CREATE TRIGGER commission_snapshot AFTER INSERT ON requests FOR EACH ROW EXECUTE FUNCTION commission_snapshot();

CREATE OR REPLACE FUNCTION commission_reconcile(rid uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  r requests%ROWTYPE; b request_billing%ROWTYPE; s commission_requests%ROWTYPE; f commission_funds%ROWTYPE;
  a record; need numeric(20,8); take numeric(20,8); refund_remaining numeric(20,8);
  net_paid numeric(20,8); profit numeric(20,8); bd numeric(20,8); dev numeric(20,8);
BEGIN
  -- All source allocation and refunds serialize on the consumer, including parallel model requests.
  SELECT * INTO r FROM requests WHERE id=rid;
  PERFORM 1 FROM users WHERE id=r.user_id FOR NO KEY UPDATE;
  SELECT * INTO s FROM commission_requests WHERE request_id=rid FOR UPDATE;
  IF NOT FOUND OR s.state='disputed' THEN RETURN; END IF;
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
  IF r.cost_cny IS NULL AND s.charged_cny>b.refunded_cny AND s.paid_cny>0 THEN
    UPDATE commission_requests SET state='pending_cost' WHERE request_id=rid; RETURN;
  END IF;
  SELECT coalesce(sum(allocation.amount_cny-allocation.returned_cny-allocation.chargeback_cny) FILTER(WHERE fund.paid),0) INTO net_paid
    FROM commission_allocations allocation JOIN commission_funds fund ON fund.id=allocation.fund_id WHERE allocation.request_id=rid;
  profit:=greatest(net_paid-coalesce(r.cost_cny,0)*CASE WHEN s.charged_cny>0 THEN s.paid_cny/s.charged_cny ELSE 0 END,0);
  bd:=CASE WHEN s.bd_user_id IS NOT NULL THEN trunc(profit*0.2,8) ELSE 0 END;
  dev:=CASE WHEN s.developer_user_id IS NOT NULL THEN trunc((profit-bd)*0.4,8) ELSE 0 END;
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
  UPDATE commission_requests SET bd_cny=bd,developer_cny=dev,revision=revision+1,state='accrued' WHERE request_id=rid;
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
