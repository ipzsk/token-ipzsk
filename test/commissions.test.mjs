import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { database } from '../src/database.mjs';
import { createApp } from '../src/app.mjs';
import { accrueEarning, recordSkillInvocations } from '../src/earnings.mjs';
import { bindReferral, reconcileInvitation, commissionBalance, reconcileCommissions, deliverConversions } from '../src/commissions.mjs';
import { units, decimal, wallet } from '../src/billing.mjs';
import { hash, httpError } from '../src/security.mjs';
import { recordLanehubCharge, reconcileLanehubCharges } from '../src/lanehub-charges.mjs';

test('signed financial amounts round-trip without changing fractional sign', () => {
  for (const value of ['-0.00000001', '-5.50000000', '0.00000000', '35.00000000']) assert.equal(decimal(units(value)), value);
});

test('paid API consumption commission lifecycle in isolated PostgreSQL', async t => {
  assert.ok(process.env.TEST_DB_HOST, 'TEST_DB_HOST must select the isolated gateway_test database');
  const config = { host: process.env.TEST_DB_HOST, port: Number(process.env.TEST_DB_PORT ?? 5432), database: 'gateway_test', user: 'gateway', password: process.env.TEST_DB_PASSWORD };
  const setup = database(config), schema = 'commissions_' + randomUUID().replaceAll('-', '');
  await setup.query(`CREATE SCHEMA ${schema}`);
  const db = database({ ...config, options: `-c search_path=${schema}` });
  let app;
  const consumer = randomUUID(), bd = randomUUID(), developer = randomUUID(), plugin = randomUUID();
  async function user() {
    const id = randomUUID();
    await db.query("INSERT INTO users(id,name) VALUES($1,'Fixture')", [id]);
    return id;
  }
  async function credit(userId, value, paid = true) {
    const id = randomUUID();
    if (paid) await db.query(`INSERT INTO payment_orders(id,user_id,mode,pack_key,product_id,amount_cny,currency,idempotency_key,target,state,credited_at)
      VALUES($1,$2,'prod',$4,'test',$3,'CNY',$1,'local','credited',now())`, [id, userId, value, 'cny_' + value]);
    await db.query(`INSERT INTO wallet_entries(id,user_id,amount_cny,balance_after_cny,source,payment_order_id)
      VALUES($1,$2,$3,$3,$4,$5)`, [randomUUID(), userId, value, paid ? 'payment' : 'signup_bonus', paid ? id : null]);
    return id;
  }
  async function request(userId, charge, cost, owner = developer) {
    const id = randomUUID();
    await db.query(`INSERT INTO requests(id,user_id,model,fingerprint,status,stream,plugin_id,plugin_owner_user_id,plugin_share_bps,cost_cny)
      VALUES($1,$2,'test','fixture','succeeded',false,$3,$4,3000,$5)`, [id, userId, owner ? plugin : null, owner, cost]);
    await db.query(`INSERT INTO request_billing(request_id,user_id,state,reserved_cny,charged_cny,price_snapshot)
      VALUES($1,$2,'settled',$3,$3,'{}')`, [id, userId, charge]);
    return id;
  }
  const snapshot = async id => (await db.query('SELECT * FROM commission_requests WHERE request_id=$1', [id])).rows[0];
  try {
    await db.migrate(); await db.migrate();
    await db.query("INSERT INTO users(id,name) VALUES($1,'Consumer'),($2,'BD'),($3,'Author')", [consumer, bd, developer]);
    await db.query("INSERT INTO developer_profiles(user_id,display_name,state) VALUES($1,'Author','approved')", [developer]);
    await db.query("INSERT INTO plugins(id,slug,name,repository,package_name,publisher_ref,owner_user_id,price_per_call_cny) VALUES($1,'fixture','Fixture','test/test','fixture','fixture',$2,9)", [plugin, developer]);
    await db.query('INSERT INTO referral_profiles(user_id,bd_active) VALUES($1,true)', [bd]);
    await db.query('INSERT INTO referrals(user_id,referrer_id) VALUES($1,$2)', [consumer, bd]);
    await db.query("INSERT INTO administrators(id,password_hash) VALUES(1,'fixture')");
    await db.query("INSERT INTO admin_sessions(token_hash,expires_at,administrator_id) VALUES($1,now()+interval '1 hour',1)", [hash('commission-fixture')]);
    app = await createApp({ db, origin: 'https://api.ipzsk.com', upstream: {}, scheduler: {}, customerAuth: {
      identify: async headers => {
        if (!['consumer', 'bd', 'developer'].includes(headers.cookie)) throw httpError(401, 'customer_login_required');
        return { id: { consumer, bd, developer }[headers.cookie], session_id: 'fixture' };
      },
    } });
    const post = (url, payload, cookie = 'bd') => app.inject({ method: 'POST', url, payload, headers: { cookie, origin: 'https://api.ipzsk.com' } });
    const adminPost = (url, payload) => post('/admin/api/commissions/' + url, payload, 'gateway_session=commission-fixture');
    await t.test('first enable starts one calendar year with fixed 20% BD and 35% developer rates', async () => {
      const response = await adminPost('policy', { enabled: true, reason: 'start one year fixture campaign' });
      assert.equal(response.statusCode, 200, response.body);
      const policy = (await db.query(`SELECT enabled,bd_share_bps,developer_share_bps,started_at,ends_at,
        ends_at=started_at+interval '1 year' AS one_year FROM commission_policy WHERE id=1`)).rows[0];
      assert.deepEqual({ enabled: policy.enabled, bd: policy.bd_share_bps, developer: policy.developer_share_bps, oneYear: policy.one_year },
        { enabled: true, bd: 2000, developer: 3500, oneYear: true });
      assert.ok(policy.started_at); assert.ok(policy.ends_at);
    });
    await t.test('paid API consumption gives BD 20% and plugin developer 35%; idempotent and no fixed Skill fee', async () => {
      await credit(consumer, '100');
      const id = await request(consumer, '100', '40');
      assert.equal((await snapshot(id)).bd_cny, '20.00000000');
      assert.equal((await snapshot(id)).developer_cny, '35.00000000');
      await db.tx(c => accrueEarning(c, id));
      await db.query("INSERT INTO plugin_skills(skill_ref,plugin_id,display_name) VALUES('fixture',$1,'Fixture')", [plugin]);
      await db.tx(c => recordSkillInvocations(c, id, ['fixture']));
      await db.tx(c => c.query('SELECT commission_reconcile($1)', [id]));
      assert.equal((await db.query('SELECT count(*) FROM plugin_earnings WHERE request_id=$1', [id])).rows[0].count, '0');
      assert.equal((await db.query('SELECT count(*) FROM commission_ledger WHERE request_id=$1', [id])).rows[0].count, '2');
      await db.query('UPDATE requests SET cost_cny=50 WHERE id=$1', [id]);
      assert.equal((await snapshot(id)).bd_cny, '20.00000000');
      await db.query('UPDATE request_billing SET refunded_cny=20 WHERE request_id=$1', [id]);
      assert.equal((await snapshot(id)).bd_cny, '16.00000000');
      assert.equal((await snapshot(id)).developer_cny, '28.00000000');
      await db.query('UPDATE request_billing SET refunded_cny=100 WHERE request_id=$1', [id]);
      assert.equal((await snapshot(id)).bd_cny, '0.00000000');
      assert.equal((await snapshot(id)).developer_cny, '0.00000000');
      assert.equal((await db.query('SELECT sum(remaining_cny)::numeric(20,8) AS amount FROM commission_funds WHERE user_id=$1', [consumer])).rows[0].amount, '100.00000000');
    });
    await t.test('mixed bonus and paid balance commissions only the paid ratio; partial refunds preserve sources', async () => {
      const id = await user(); await credit(id, '100'); await request(id, '20', '0', null); await credit(id, '20', false);
      await db.query('INSERT INTO referrals(user_id,referrer_id) VALUES($1,$2)', [id, bd]);
      const rid = await request(id, '100', '40');
      assert.equal((await snapshot(rid)).paid_cny, '80.00000000');
      assert.equal((await snapshot(rid)).bd_cny, '16.00000000');
      assert.equal((await snapshot(rid)).developer_cny, '28.00000000');
      await db.query('UPDATE request_billing SET refunded_cny=50 WHERE request_id=$1', [rid]);
      assert.equal((await snapshot(rid)).bd_cny, '8.00000000');
      assert.equal((await snapshot(rid)).developer_cny, '14.00000000');
      const sources = (await db.query('SELECT paid,sum(remaining_cny)::numeric(20,8) AS amount FROM commission_funds WHERE user_id=$1 GROUP BY paid ORDER BY paid', [id])).rows;
      assert.deepEqual(sources.map(r => r.amount), ['10.00000000', '40.00000000']);
    });
    await t.test('actual upstream cost does not change consumption shares; bonus and self consumption earn zero', async () => {
      const id = await user(); await credit(id, '100');
      const rid = await request(id, '100', null);
      assert.equal((await snapshot(rid)).state, 'accrued');
      assert.equal((await snapshot(rid)).developer_cny, '35.00000000');
      await db.query('UPDATE requests SET cost_cny=0 WHERE id=$1', [rid]);
      assert.equal((await snapshot(rid)).developer_cny, '35.00000000');
      const bonus = await user(); await credit(bonus, '100', false);
      assert.equal((await snapshot(await request(bonus, '100', null))).developer_cny, '0.00000000');
      await credit(developer, '100');
      assert.equal((await snapshot(await request(developer, '100', '40'))).developer_cny, '0.00000000');
    });
    await t.test('invitation threshold is strictly >10, once effectively; refund and requalification append corrections', async () => {
      const id = await user(), auth = randomUUID();
      await db.query('INSERT INTO referral_registrations(auth_user_id,referrer_id) VALUES($1,$2)', [auth, bd]);
      await db.tx(c => bindReferral(c, auth, id)); await db.tx(c => bindReferral(c, auth, id));
      const payment = await credit(id, '10'); await db.tx(c => reconcileInvitation(c, id));
      assert.equal((await db.query("SELECT count(*) FROM commission_ledger WHERE referred_user_id=$1", [id])).rows[0].count, '0');
      await credit(id, '10');
      await Promise.all([db.tx(c => reconcileInvitation(c, id)), db.tx(c => reconcileInvitation(c, id))]);
      assert.equal((await db.query("SELECT sum(amount_cny)::numeric(20,8) AS amount FROM commission_ledger WHERE referred_user_id=$1", [id])).rows[0].amount, '5.00000000');
      await db.query('INSERT INTO commission_payment_refunds(reference,payment_order_id,amount_cny) VALUES($1,$2,10)', ['refund-fixture', payment]);
      await db.tx(c => reconcileInvitation(c, id));
      assert.equal((await db.query("SELECT sum(amount_cny)::numeric(20,8) AS amount FROM commission_ledger WHERE referred_user_id=$1", [id])).rows[0].amount, '0.00000000');
      await credit(id, '10'); await db.tx(c => reconcileInvitation(c, id));
      assert.equal((await db.query("SELECT sum(amount_cny)::numeric(20,8) AS amount FROM commission_ledger WHERE referred_user_id=$1", [id])).rows[0].amount, '5.00000000');
    });
    await t.test('observation period, conversion idempotency, concurrent withdrawal and cancellation', async () => {
      assert.equal((await post('/api/me/commissions/convert', { idempotency_key: randomUUID(), amount_cny: '1' })).statusCode, 409);
      await db.query("INSERT INTO commission_ledger(user_id,kind,amount_cny,available_at,created_at,reference) VALUES($1,'bd',200,now()-interval '1 day',now()-interval '60 days','mature-fixture')", [bd]);
      const key = randomUUID();
      const conversion = await post('/api/me/commissions/convert', { idempotency_key: key, amount_cny: '20' });
      assert.equal(conversion.statusCode, 200, conversion.body);
      assert.equal(conversion.json().state, 'applied');
      assert.equal((await post('/api/me/commissions/convert', { idempotency_key: key, amount_cny: '20' })).statusCode, 200);
      assert.equal((await db.query('SELECT count(*) FROM wallet_entries WHERE id=$1', [key])).rows[0].count, '1');
      assert.equal((await db.query('SELECT paid FROM commission_funds WHERE id=$1', ['wallet:' + key])).rows[0].paid, false);
      const beforePayout = (await commissionBalance(db, bd)).available_cny;
      const results = await Promise.all([post('/api/me/commissions/payouts', { idempotency_key: randomUUID(), amount_cny: '100' }), post('/api/me/commissions/payouts', { idempotency_key: randomUUID(), amount_cny: '100' })]);
      assert.deepEqual(results.map(r => r.statusCode).sort(), [200, 409]);
      const payout = results.find(r => r.statusCode === 200).json();
      assert.equal((await adminPost('payouts/' + payout.id, { state: 'paid', reference: 'fixture-bank-receipt' })).statusCode, 409);
      assert.equal((await adminPost('payouts/' + payout.id, { state: 'approved', reference: 'fixture-audit' })).statusCode, 200);
      assert.equal((await adminPost('payouts/' + payout.id, { state: 'cancelled', reference: 'fixture-cancel' })).statusCode, 200);
      assert.equal((await commissionBalance(db, bd)).available_cny, beforePayout);
    });
    await t.test('no cross-user access or bearer earnings writes; valid referral cookie landing', async () => {
      assert.equal((await app.inject({ url: '/api/me/commissions' })).statusCode, 401);
      const own = await app.inject({ url: '/api/me/commissions?user_id=' + developer, headers: { cookie: 'bd' } });
      assert.equal(own.json().profile.user_id, bd);
      const code = own.json().profile.code;
      const landing = await app.inject({ url: '/api/account/referral/' + code });
      assert.equal(landing.statusCode, 302); assert.match(landing.headers['set-cookie'], /HttpOnly/);
      assert.equal((await post('/api/me/commissions/payouts', { idempotency_key: randomUUID(), amount_cny: '99' })).statusCode, 400);
    });
    await t.test('confirmed unused recharge refund deducts wallet once, reverses invitation; consumed chargeback reverses commission', async () => {
      const buyer = await user();
      await db.query('INSERT INTO referrals(user_id,referrer_id) VALUES($1,$2)', [buyer, bd]);
      const payment = await credit(buyer, '100');
      await db.tx(c => reconcileInvitation(c, buyer));
      const unused = { amount_cny: '10', chargeback: false, reference: 'bank-unused-refund-fixture' };
      const first = await adminPost('payment-refunds/' + payment, unused);
      assert.equal(first.statusCode, 200, first.body);
      assert.equal((await wallet(db, buyer)).balance_cny, '90.00000000');
      assert.equal((await adminPost('payment-refunds/' + payment, unused)).statusCode, 200);
      assert.equal((await wallet(db, buyer)).balance_cny, '90.00000000');
      const rid = await request(buyer, '90', '36');
      assert.equal((await snapshot(rid)).bd_cny, '18.00000000');
      await db.query("UPDATE payment_orders SET state='refund_review' WHERE id=$1", [payment]);
      assert.equal((await snapshot(rid)).state, 'disputed');
      assert.equal((await commissionBalance(db, bd)).frozen, true);
      const chargeback = await adminPost('payment-refunds/' + payment, { amount_cny: '90', chargeback: true, reference: 'bank-chargeback-fixture' });
      assert.equal(chargeback.statusCode, 200, chargeback.body);
      assert.equal((await snapshot(rid)).bd_cny, '0.00000000');
      assert.equal((await snapshot(rid)).developer_cny, '0.00000000');
      assert.equal((await db.query("SELECT sum(amount_cny)::numeric(20,8) AS amount FROM commission_ledger WHERE referred_user_id=$1", [buyer])).rows[0].amount, '0.00000000');
      const repeatedRefund = await post('/admin/api/billing/' + rid + '/refund', { amount_cny: '1', reason: 'fixture chargeback' }, 'gateway_session=commission-fixture');
      assert.equal(repeatedRefund.statusCode, 409);
    });
    await t.test('BD promotion only affects future requests; historical policy and self attribution remain isolated', async () => {
      const buyer = await user(), inviter = await user();
      await db.query('INSERT INTO referral_profiles(user_id) VALUES($1)', [inviter]);
      await db.query('INSERT INTO referrals(user_id,referrer_id) VALUES($1,$2)', [buyer, inviter]);
      await credit(buyer, '100');
      const before = await request(buyer, '50', '20');
      assert.equal((await snapshot(before)).bd_cny, '0.00000000');
      assert.equal((await snapshot(before)).developer_cny, '17.50000000');
      await db.query('UPDATE referral_profiles SET bd_active=true WHERE user_id=$1', [inviter]);
      const after = await request(buyer, '50', '20');
      assert.equal((await snapshot(after)).bd_cny, '10.00000000');
      assert.equal((await snapshot(before)).bd_user_id, null);
      await db.query('UPDATE commission_policy SET enabled=false');
      const oldBuyer = await user(); await credit(oldBuyer, '100');
      const legacy = await request(oldBuyer, '100', '40');
      await db.tx(c => accrueEarning(c, legacy));
      assert.equal((await snapshot(legacy)).enabled, false);
      assert.equal((await db.query('SELECT amount_cny FROM plugin_earnings WHERE request_id=$1', [legacy])).rows[0].amount_cny, '9.00000000');
      await db.query("UPDATE commission_policy SET enabled=true,started_at=coalesce(started_at,now()),ends_at=coalesce(ends_at,now()+interval '1 year')");
    });
    await t.test('historical opening balance requires verified paid sources and an idle account', async () => {
      await db.query('UPDATE commission_policy SET enabled=false');
      const buyer = await user(); await credit(buyer, '100'); await credit(buyer, '5', false);
      await db.query('UPDATE commission_accounts SET sources_confirmed=false WHERE user_id=$1', [buyer]);
      const payment = (await db.query('SELECT id FROM payment_orders WHERE user_id=$1', [buyer])).rows[0].id;
      const body = { reference: 'verified-opening-balance', paid_lots: [{ payment_order_id: payment, amount_cny: '100' }] };
      const result = await adminPost('opening-balance/' + buyer, body);
      assert.equal(result.statusCode, 200, result.body);
      assert.equal(result.json().balance_cny, '105.00000000');
      assert.equal((await db.query('SELECT sum(remaining_cny)::numeric(20,8) AS amount FROM commission_funds WHERE user_id=$1', [buyer])).rows[0].amount, '105.00000000');
      await db.query("UPDATE commission_policy SET enabled=true,started_at=coalesce(started_at,now()),ends_at=coalesce(ends_at,now()+interval '1 year')");
      const rid = await request(buyer, '105', '42');
      assert.equal((await snapshot(rid)).paid_cny, '100.00000000');
      assert.equal((await snapshot(rid)).developer_cny, '35.00000000');
      assert.equal((await adminPost('opening-balance/' + buyer, body)).statusCode, 409);
    });
    await t.test('unconfirmed historical consumption is isolated from a new checkpoint, including disabled-policy usage', async () => {
      const buyer = await user(), payment = await credit(buyer, '100');
      await db.query('UPDATE commission_accounts SET sources_confirmed=false WHERE user_id=$1', [buyer]);
      const old = await request(buyer, '20', '8');
      assert.equal((await snapshot(old)).state, 'pending_sources');
      await db.query('UPDATE commission_policy SET enabled=false');
      const disabled = await request(buyer, '10', '4');
      await db.query(`INSERT INTO wallet_debits(id,user_id,request_id,amount_cny,balance_after_cny) VALUES($4,$1,$2,20,80),($5,$1,$3,10,70)`, [buyer,old,disabled,randomUUID(),randomUUID()]);
      const enable = await adminPost('policy', { enabled: true, reason: 'must confirm historical sources' });
      assert.equal(enable.statusCode, 409, enable.body);
      assert.equal(enable.json().error.code, 'commission_sources_migration_required');
      const body = { reference: 'verified remaining historical balance', paid_lots: [{ payment_order_id: payment, amount_cny: '70' }] };
      const invalid = await adminPost('opening-balance/' + buyer, { ...body, paid_lots: [{ payment_order_id: payment, amount_cny: '100' }] });
      assert.equal(invalid.statusCode, 409);
      assert.equal((await snapshot(old)).state, 'pending_sources', 'failed migration rolls back');
      const migrated = await adminPost('opening-balance/' + buyer, body);
      assert.equal(migrated.statusCode, 200, migrated.body);
      assert.equal(migrated.json().historical_review_count, 2);
      for (const rid of [old,disabled]) {
        assert.equal((await snapshot(rid)).state, 'historical_sources_review');
        await db.query('UPDATE requests SET cost_cny=0 WHERE id=$1', [rid]);
        await db.query('SELECT commission_reconcile($1)', [rid]);
        assert.equal((await snapshot(rid)).state, 'historical_sources_review');
      }
      await reconcileCommissions(db);
      assert.equal((await db.query('SELECT sum(remaining_cny)::numeric(20,8) AS amount FROM commission_funds WHERE user_id=$1', [buyer])).rows[0].amount, '70.00000000');
      assert.equal((await adminPost('policy', { enabled: true, reason: 'all sources now confirmed' })).statusCode, 200);
      const fresh = await request(buyer, '70', '28');
      assert.equal((await snapshot(fresh)).developer_cny, '24.50000000');
      assert.equal((await db.query('SELECT count(*) FROM commission_allocations WHERE request_id=ANY($1::uuid[])', [[old,disabled]])).rows[0].count, '0');
      await db.query('UPDATE commission_policy SET enabled=false');
      assert.equal((await adminPost('opening-balance/' + buyer, body)).statusCode, 409, 'cannot erase real allocations');
      const missing = await user();
      await db.query(`INSERT INTO requests(id,user_id,model,fingerprint,status,stream) VALUES($1,$2,'test','no bill','queued',false)`, [randomUUID(), missing]);
      assert.equal((await adminPost('opening-balance/' + missing, { reference: 'inflight request must remain blocked', paid_lots: [] })).statusCode, 409);
      await db.query("UPDATE requests SET status='succeeded' WHERE user_id=$1",[missing]);
      assert.equal((await adminPost('opening-balance/' + missing, { reference: 'no bill must remain blocked', paid_lots: [] })).statusCode, 409);
      await db.query("UPDATE commission_policy SET enabled=true,started_at=coalesce(started_at,now()),ends_at=coalesce(ends_at,now()+interval '1 year')");
    });
    await t.test('LaneHub receipts backfill delayed real cost exactly once, preserve FX and reject unsafe attribution', async () => {
      const account = randomUUID(), key = randomUUID();
      await db.query("INSERT INTO upstream_accounts(id,name,provider_type) VALUES($1,'Cost fixture','lanehub')", [account]);
      await db.query("INSERT INTO upstream_keys(id,account_id,name,fingerprint,suffix,secret_ref) VALUES($1,$2,'Cost','cost-fixture','fixture','cost-fixture')", [key, account]);
      let upstreamUser = 20000;
      async function laneRequest() {
        const buyer = await user(), rid = randomUUID(); await credit(buyer, '100');
        const laneUser = ++upstreamUser;
        await db.query('INSERT INTO lanehub_accounts(user_id,lanehub_user_id,key_id) VALUES($1,$2,$3)', [buyer,laneUser,key]);
        await db.query('INSERT INTO referrals(user_id,referrer_id) VALUES($1,$2)', [buyer,bd]);
        return (await db.query(`INSERT INTO requests(id,user_id,key_id,model,fingerprint,status,stream,upstream_id,completed_at,plugin_id,plugin_owner_user_id)
          VALUES($1,$2,$3,'test','receipt','succeeded',false,$4,now()-interval '1 hour',$5,$6) RETURNING *`, [rid,buyer,key,'receipt-'+rid,plugin,developer])).rows[0];
      }
      const row = await laneRequest(), laneUser = upstreamUser;
      const log = { id: 101, type: 2, quota: 100, cost_quota: 40, cost_source: 'estimated', request_id: row.upstream_id, user_id: laneUser };
      let current = [log], fx = 1;
      const lanehub = { call: async () => ({ data: current, total_count: current.length }), usdRate: async () => fx };
      const options = { usdCnyRate: 1, quotaPerUnit: 1 };
      await recordLanehubCharge(db,lanehub,row,options);
      assert.equal((await snapshot(row.id)).state, 'accrued');
      current = [{ ...log, cost_source: 'real' }]; fx = 7;
      const result = await reconcileLanehubCharges(db,lanehub,options);
      assert.equal(result.failed, 0);
      assert.equal((await db.query('SELECT cost_cny FROM requests WHERE id=$1', [row.id])).rows[0].cost_cny, '40.00000000', 'delayed receipt retains original FX');
      assert.equal((await snapshot(row.id)).bd_cny, '20.00000000');
      assert.equal((await snapshot(row.id)).developer_cny, '35.00000000');
      await Promise.all(Array.from({ length: 8 }, () => recordLanehubCharge(db,lanehub,row,options)));
      assert.equal((await db.query('SELECT count(*) FROM commission_ledger WHERE request_id=$1', [row.id])).rows[0].count, '2');
      assert.equal((await db.query("SELECT count(*) FROM audit_events WHERE target_id=$1 AND action='request.cost.sync'", [row.id])).rows[0].count, '1');
      for (const bad of [ { cost_source: 'estimated' }, { cost_quota: -1 }, { cost_quota: null }, { cost_quota: 0.1 }, { cost_quota: Number.MAX_SAFE_INTEGER+1 }, { user_id: -1 }, { request_id: 'wrong' } ]) {
        const candidate = await laneRequest(); fx = 1;
        current = [{ ...log, cost_source: 'real', request_id: candidate.upstream_id, user_id: upstreamUser, ...bad }];
        try { await recordLanehubCharge(db,lanehub,candidate,options); } catch (error) { assert.match(error.message, /receipt/); }
        assert.equal((await db.query('SELECT cost_cny FROM requests WHERE id=$1', [candidate.id])).rows[0].cost_cny, null);
        const billed = (await db.query('SELECT 1 FROM request_billing WHERE request_id=$1 AND charged_cny>0', [candidate.id])).rowCount > 0;
        assert.equal((await snapshot(candidate.id)).developer_cny, billed ? '35.00000000' : '0.00000000');
      }
      const mixed = await laneRequest();
      current = [{ ...log, id: 201, quota: 50, cost_source: 'real', request_id: mixed.upstream_id, user_id: upstreamUser },
        { ...log, id: 202, quota: 50, request_id: mixed.upstream_id, user_id: upstreamUser }];
      await recordLanehubCharge(db,lanehub,mixed,options);
      assert.equal((await snapshot(mixed.id)).state, 'accrued', 'partial actual cost does not block consumption commission');
      current = current.map(item => ({ ...item, quota: 60, cost_source: 'real' }));
      await recordLanehubCharge(db,lanehub,mixed,options);
      assert.equal((await snapshot(mixed.id)).state, 'accrued', 'changed sales receipt does not change consumption commission');
      assert.equal((await db.query('SELECT reason,charged_cny FROM request_billing WHERE request_id=$1', [mixed.id])).rows[0].reason, 'lanehub_receipt_changed');
      const zero = await laneRequest();
      current = [{ ...log, request_id: zero.upstream_id, user_id: upstreamUser, cost_source: 'real', cost_quota: 0 }];
      await recordLanehubCharge(db,lanehub,zero,options);
      assert.equal((await snapshot(zero.id)).bd_cny, '20.00000000');
      assert.equal((await snapshot(zero.id)).developer_cny, '35.00000000');
      const stale = await laneRequest();
      current = [];
      assert.equal(await recordLanehubCharge(db,lanehub,stale,options), 'pending');
      await db.query(`INSERT INTO request_billing(request_id,user_id,state,reserved_cny,charged_cny,price_snapshot,reason)
        VALUES($1,$2,'released',0,0,'{}','lanehub_no_charge')`, [stale.id,stale.user_id]);
      await db.query(`INSERT INTO generation_records(user_id,request_id,kind,model,prompt,status,charged_points)
        VALUES($1,$2,'image','test','fixture','succeeded',0)`,[stale.user_id,stale.id]);
      current = [{ ...log, request_id: stale.upstream_id, user_id: upstreamUser, cost_source: 'real' }];
      await recordLanehubCharge(db,lanehub,stale,options);
      assert.equal((await snapshot(stale.id)).bd_cny, '20.00000000', 'recover historical timeout releases without double allocation');
      assert.equal((await snapshot(stale.id)).developer_cny, '35.00000000');
      assert.equal((await db.query('SELECT charged_points FROM generation_records WHERE request_id=$1',[stale.id])).rows[0].charged_points,'10000.00000000','late charge replaces the historical zero shown in Studio');
      const scanned=[];
      const waiting={call:async path=>{scanned.push(new URL(path,'http://fixture.invalid').searchParams.get('request_id'));return {data:[]};},usdRate:async()=>1};
      for(let i=0;i<3;i++) {
        const batch=await reconcileLanehubCharges(db,waiting,options,{batchSize:100,maxRows:1});
        assert.equal(batch.scanned,1,'configured scan budget is a hard limit');
      }
      assert.equal(new Set(scanned).size,3,'unknown receipts rotate instead of starving the backlog');
    });
    await t.test('parallel LaneHub billing imports allocate each principal unit once without a foreign-key lock deadlock', async () => {
      const buyer = await user(); await credit(buyer, '100');
      const ids = Array.from({ length: 10 }, () => randomUUID());
      await Promise.all(ids.map(id => db.query(`INSERT INTO requests(id,user_id,model,fingerprint,stream,status,cost_cny,plugin_id,plugin_owner_user_id)
        VALUES($1,$2,'test','parallel-fixture',false,'succeeded',4,$3,$4)`, [id, buyer, plugin, developer])));
      await Promise.all(ids.map(id => db.query(`INSERT INTO request_billing(request_id,user_id,state,reserved_cny,charged_cny,price_snapshot)
        VALUES($1,$2,'settled',10,10,'{}')`, [id, buyer])));
      assert.equal((await db.query('SELECT sum(remaining_cny)::numeric(20,8) AS amount FROM commission_funds WHERE user_id=$1', [buyer])).rows[0].amount, '0.00000000');
      assert.equal((await db.query('SELECT sum(developer_cny)::numeric(20,8) AS amount FROM commission_requests WHERE request_id=ANY($1::uuid[])', [ids])).rows[0].amount, '35.00000000');
    });
    await t.test('simulation matrix: BD and author identities receive only their own eligible paid-consumption share', async matrix => {
      const cases = [
        { name: 'paid with both identities', paid: '100', bonus: '0', cost: '40', bd: true, author: developer, expectedBd: '20', expectedDev: '35' },
        { name: 'author without BD', paid: '100', bonus: '0', cost: '40', bd: false, author: developer, expectedBd: '0', expectedDev: '35' },
        { name: 'BD without author', paid: '100', bonus: '0', cost: '40', bd: true, author: null, expectedBd: '20', expectedDev: '0' },
        { name: 'mixed principal and grant', paid: '80', bonus: '20', cost: '40', bd: true, author: developer, expectedBd: '16', expectedDev: '28' },
        { name: 'grant only', paid: '0', bonus: '100', cost: '40', bd: true, author: developer, expectedBd: '0', expectedDev: '0' },
        { name: 'upstream loss', paid: '100', bonus: '0', cost: '120', bd: true, author: developer, expectedBd: '20', expectedDev: '35' },
        { name: 'known free upstream', paid: '100', bonus: '0', cost: '0', bd: true, author: developer, expectedBd: '20', expectedDev: '35' },
        { name: 'one unit rounding tail', paid: '0.00000005', bonus: '0', cost: '0.00000001', bd: true, author: developer, expectedBd: '0.00000001', expectedDev: '0.00000001' },
      ];
      for (const fixture of cases) await matrix.test(fixture.name, async () => {
        const buyer = await user();
        if (units(fixture.paid)>0n) {
          await credit(buyer, '100');
          if (units(fixture.paid)<units('100')) await request(buyer, decimal(units('100')-units(fixture.paid)), '0', null);
        }
        if (units(fixture.bonus)>0n) await credit(buyer, fixture.bonus, false);
        if (fixture.bd) await db.query('INSERT INTO referrals(user_id,referrer_id) VALUES($1,$2)', [buyer, bd]);
        const charge = decimal(units(fixture.paid)+units(fixture.bonus));
        const rid = await request(buyer, charge, fixture.cost, fixture.author);
        const result = await snapshot(rid);
        assert.equal(result.bd_cny, decimal(units(fixture.expectedBd)));
        assert.equal(result.developer_cny, decimal(units(fixture.expectedDev)));
        const rows = (await db.query('SELECT user_id,kind,amount_cny FROM commission_ledger WHERE request_id=$1 ORDER BY kind', [rid])).rows;
        assert.deepEqual(rows, [
          ...(units(fixture.expectedBd)>0n ? [{ user_id: bd, kind: 'bd', amount_cny: decimal(units(fixture.expectedBd)) }] : []),
          ...(units(fixture.expectedDev)>0n ? [{ user_id: developer, kind: 'developer', amount_cny: decimal(units(fixture.expectedDev)) }] : []),
        ]);
      });
    });
    await t.test('income API isolates recipient identity and exposes results without cost or principal calculations', async () => {
      const buyer = await user(); await credit(buyer, '100');
      await db.query('INSERT INTO referrals(user_id,referrer_id) VALUES($1,$2)', [buyer, bd]);
      const rid = await request(buyer, '100', '40');
      for (const [cookie, kind, expected] of [['bd', 'bd', '20.00000000'], ['developer', 'developer', '35.00000000']]) {
        const response = await app.inject({ url: '/api/me/commissions?user_id=' + buyer, headers: { cookie } });
        assert.equal(response.statusCode, 200, response.body);
        const data = response.json();
        assert.equal(Object.hasOwn(data, 'calculations'), false);
        const rows = data.ledger.filter(row => row.request_id===rid);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].kind, kind); assert.equal(rows[0].amount_cny, expected);
        assert.deepEqual(Object.keys(rows[0]).sort(), ['amount_cny','available_at','created_at','kind','request_id']);
        assert.equal(new Date(rows[0].available_at)>new Date(rows[0].created_at), true);
      }
      const unrelated = await app.inject({ url: '/api/me/commissions?user_id=' + bd, headers: { cookie: 'consumer' } });
      assert.equal(unrelated.json().ledger.some(row => row.request_id===rid), false);
    });
    await t.test('plugin transfer and BD revocation preserve old snapshots; dual identity gets two distinct shares', async () => {
      const buyer = await user(), successor = await user();
      for (let i=0;i<3;i++) await credit(buyer, '100');
      await db.query("INSERT INTO developer_profiles(user_id,display_name,state) VALUES($1,'Successor','approved'),($2,'BD author','approved')", [successor, bd]);
      await db.query('INSERT INTO referrals(user_id,referrer_id) VALUES($1,$2)', [buyer, bd]);
      const before = await request(buyer, '100', '40');
      await db.query('UPDATE plugins SET owner_user_id=$1 WHERE id=$2', [successor, plugin]);
      await db.query('UPDATE referral_profiles SET bd_active=false WHERE user_id=$1', [bd]);
      const after = await request(buyer, '100', '40', successor);
      await db.query('UPDATE requests SET cost_cny=50 WHERE id=$1', [before]);
      assert.equal((await snapshot(before)).developer_user_id, developer);
      assert.equal((await snapshot(before)).bd_cny, '20.00000000');
      assert.equal((await snapshot(after)).developer_user_id, successor);
      assert.equal((await snapshot(after)).bd_cny, '0.00000000');
      assert.equal((await snapshot(after)).developer_cny, '35.00000000');
      await db.query('UPDATE referral_profiles SET bd_active=true WHERE user_id=$1', [bd]);
      const dual = await request(buyer, '100', '40', bd);
      assert.equal((await snapshot(dual)).bd_cny, '20.00000000');
      assert.equal((await snapshot(dual)).developer_cny, '35.00000000');
      assert.equal((await db.query('SELECT sum(amount_cny)::numeric(20,8) AS amount FROM commission_ledger WHERE request_id=$1 AND user_id=$2', [dual, bd])).rows[0].amount, '55.00000000');
      await db.query('UPDATE plugins SET owner_user_id=$1 WHERE id=$2', [developer, plugin]);
    });
    await t.test('micro-refunds never reclaim a previously returned and spent source unit', async () => {
      const buyer = await user();
      for (let i = 0; i < 3; i++) await db.query(`INSERT INTO wallet_entries(id,user_id,amount_cny,balance_after_cny,source,granted_by,note)
        VALUES($1,$2,0.00000001,0.00000001,'admin_grant',$3,'micro refund fixture')`, [randomUUID(), buyer, bd]);
      const rid = await request(buyer, '0.00000003', '0');
      await db.query('UPDATE request_billing SET refunded_cny=0.00000001 WHERE request_id=$1', [rid]);
      await request(buyer, '0.00000001', '0');
      const before = (await db.query('SELECT fund_id,returned_cny FROM commission_allocations WHERE request_id=$1 ORDER BY fund_id', [rid])).rows;
      await db.query('UPDATE request_billing SET refunded_cny=0.00000002 WHERE request_id=$1', [rid]);
      const after = (await db.query('SELECT fund_id,returned_cny FROM commission_allocations WHERE request_id=$1 ORDER BY fund_id', [rid])).rows;
      after.forEach((row, i) => assert.ok(units(row.returned_cny) >= units(before[i].returned_cny)));
      assert.equal((await db.query('SELECT sum(remaining_cny)::numeric(20,8) AS amount FROM commission_funds WHERE user_id=$1', [buyer])).rows[0].amount, '0.00000001');
      await db.query('UPDATE request_billing SET refunded_cny=0.00000003 WHERE request_id=$1', [rid]);
      assert.equal((await db.query('SELECT sum(remaining_cny)::numeric(20,8) AS amount FROM commission_funds WHERE user_id=$1', [buyer])).rows[0].amount, '0.00000002');
    });
    await t.test('a dispute before settlement freezes newly allocated earnings until confirmed resolution', async () => {
      const buyer = await user(), payment = await credit(buyer, '100');
      await db.query("UPDATE payment_orders SET state='refund_review' WHERE id=$1", [payment]);
      const rid = await request(buyer, '100', '40');
      assert.equal((await snapshot(rid)).state, 'disputed');
      assert.equal((await commissionBalance(db, developer)).frozen, true);
      assert.equal((await db.query('SELECT count(*) FROM commission_ledger WHERE request_id=$1', [rid])).rows[0].count, '0');
      const resolved = await adminPost('payment-refunds/' + payment, { amount_cny: '1', chargeback: true, reference: 'dispute-before-settlement-fixture' });
      assert.equal(resolved.statusCode, 200, resolved.body);
      assert.equal((await snapshot(rid)).state, 'accrued');
      assert.equal((await snapshot(rid)).developer_cny, '34.65000000');
    });
    await t.test('concurrent payment disputes and settlement serialize on the consumer in either order', async () => {
      for (const disputeFirst of [true, false]) {
        const buyer = await user(), payment = await credit(buyer, '100'), rid = randomUUID();
        await db.query(`INSERT INTO requests(id,user_id,model,fingerprint,status,stream,plugin_id,plugin_owner_user_id,cost_cny)
          VALUES($1,$2,'test','concurrent-dispute','succeeded',false,$3,$4,40)`, [rid, buyer, plugin, developer]);
        const a = await db.pool.connect(), b = await db.pool.connect();
        const settle = c => c.query(`INSERT INTO request_billing(request_id,user_id,state,reserved_cny,charged_cny,price_snapshot)
          VALUES($1,$2,'settled',100,100,'{}')`, [rid, buyer]);
        const dispute = c => c.query("UPDATE payment_orders SET state='refund_review' WHERE id=$1", [payment]);
        let pending;
        try {
          const aPid = (await a.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          const bPid = (await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          await a.query('BEGIN'); await b.query('BEGIN');
          await (disputeFirst ? dispute(a) : settle(a));
          let finished = false;
          pending = disputeFirst ? settle(b) : dispute(b);
          pending.then(() => { finished = true; }, () => { finished = true; });
          const deadline = Date.now() + 2000;
          while (!finished && Date.now() < deadline) {
            if ((await db.query('SELECT $1::integer=ANY(pg_blocking_pids($2)) AS blocked', [aPid, bPid])).rows[0].blocked) break;
          }
          await a.query('COMMIT'); await pending; await b.query('COMMIT');
          assert.equal((await snapshot(rid)).state, 'disputed');
          assert.equal((await commissionBalance(db, developer)).frozen, true);
          assert.equal((await db.query('SELECT count(*) FROM commission_ledger WHERE request_id=$1', [rid])).rows[0].count, disputeFirst ? '0' : '1');
        } finally {
          await a.query('ROLLBACK'); await pending?.catch(() => {}); await b.query('ROLLBACK');
          a.release(); b.release();
        }
        const resolved = await adminPost('payment-refunds/' + payment, { amount_cny: '1', chargeback: true, reference: 'concurrent-dispute-' + payment });
        assert.equal(resolved.statusCode, 200, resolved.body);
        assert.equal((await snapshot(rid)).state, 'accrued');
      }
    });
    await t.test('cumulative micro-refunds conserve every source unit and never duplicate adjustments', async () => {
      const buyer = await user();
      await credit(buyer, '0.00000001', false);
      for (let i=0;i<2;i++) await db.query(`INSERT INTO wallet_entries(id,user_id,amount_cny,balance_after_cny,source,granted_by,note)
        VALUES($1,$2,0.00000001,0.00000001,'admin_grant',$3,'micro refund fixture')`, [randomUUID(), buyer, bd]);
      const rid = await request(buyer, '0.00000003', '0');
      for (const refunded of ['0.00000001','0.00000002','0.00000003']) {
        await db.query('UPDATE request_billing SET refunded_cny=$1 WHERE request_id=$2', [refunded, rid]);
        await db.query('SELECT commission_reconcile($1)', [rid]);
        const sums = (await db.query(`SELECT sum(returned_cny)::numeric(20,8) AS amount FROM commission_allocations WHERE request_id=$1`, [rid])).rows[0];
        assert.equal(sums.amount, refunded);
        assert.equal((await db.query('SELECT sum(remaining_cny)::numeric(20,8) AS amount FROM commission_funds WHERE user_id=$1', [buyer])).rows[0].amount, refunded);
      }
      assert.equal((await snapshot(rid)).developer_cny, '0.00000000');
    });
    await t.test('100 parallel settlements, 50 refunds and loss corrections conserve funds and recipient earnings', async () => {
      const buyer=await user(); await credit(buyer,'100');
      await db.query('INSERT INTO referrals(user_id,referrer_id) VALUES($1,$2)',[buyer,bd]);
      const ids=Array.from({length:100},()=>randomUUID());
      await Promise.all(ids.map(id=>db.query(`INSERT INTO requests(id,user_id,model,fingerprint,status,stream,plugin_id,plugin_owner_user_id,cost_cny)
        VALUES($1,$2,'test','100-parallel','succeeded',false,$3,$4,0.4)`,[id,buyer,plugin,developer])));
      await Promise.all(ids.map(id=>db.query(`INSERT INTO request_billing(request_id,user_id,state,reserved_cny,charged_cny,price_snapshot)
        VALUES($1,$2,'settled',1,1,'{}')`,[id,buyer])));
      const total=async()=> (await db.query('SELECT sum(bd_cny)::numeric(20,8) AS bd,sum(developer_cny)::numeric(20,8) AS dev FROM commission_requests WHERE request_id=ANY($1::uuid[])',[ids])).rows[0];
      assert.deepEqual(await total(),{bd:'20.00000000',dev:'35.00000000'});
      await Promise.all(ids.slice(0,50).map(id=>db.query('UPDATE request_billing SET refunded_cny=1 WHERE request_id=$1',[id])));
      assert.deepEqual(await total(),{bd:'10.00000000',dev:'17.50000000'});
      await Promise.all(ids.slice(50).map(id=>db.query('UPDATE requests SET cost_cny=2 WHERE id=$1',[id])));
      assert.deepEqual(await total(),{bd:'10.00000000',dev:'17.50000000'});
      assert.equal((await db.query('SELECT sum(remaining_cny)::numeric(20,8) AS amount FROM commission_funds WHERE user_id=$1',[buyer])).rows[0].amount,'50.00000000');
      await Promise.all(ids.map(id=>db.query('SELECT commission_reconcile($1)',[id])));
      assert.deepEqual(await total(),{bd:'10.00000000',dev:'17.50000000'});
    });
    await t.test('deterministic mixed-source refund simulations match an independent integer oracle', async () => {
      let seed=20261011;
      for(let trial=0;trial<16;trial++) {
        seed=(seed*1664525+1013904223)>>>0;
        const cost=seed%121, buyer=await user();
        await credit(buyer,'100'); await request(buyer,'20','0',null); await credit(buyer,'20',false);
        await db.query('INSERT INTO referrals(user_id,referrer_id) VALUES($1,$2)',[buyer,bd]);
        const rid=await request(buyer,'100',String(cost));
        for(const refund of [0,1,17,49,83,99,100]) {
          await db.query('UPDATE request_billing SET refunded_cny=$2 WHERE request_id=$1',[rid,refund]);
          const netPaid=BigInt(100-refund)*80000000n;
          const expectedBd=netPaid*2000n/10000n, expectedDev=netPaid*3500n/10000n;
          const actual=await snapshot(rid);
          assert.equal(actual.bd_cny,decimal(expectedBd),`trial ${trial}, refund ${refund}`);
          assert.equal(actual.developer_cny,decimal(expectedDev),`trial ${trial}, refund ${refund}`);
          const remaining=(await db.query('SELECT sum(remaining_cny)::numeric(20,8) AS amount FROM commission_funds WHERE user_id=$1',[buyer])).rows[0].amount;
          assert.equal(remaining,decimal(units(String(refund))));
        }
      }
    });
    await t.test('pending remote conversion respects later freeze, debt and concurrent workers', async () => {
      const recipient = await user(), account = randomUUID(), key = randomUUID(), conversion = randomUUID();
      await db.query("INSERT INTO upstream_accounts(id,name) VALUES($1,'Freeze fixture')", [account]);
      await db.query("INSERT INTO upstream_keys(id,account_id,name,fingerprint,suffix,secret_ref) VALUES($1,$2,'Freeze','freeze-fixture','fixture','freeze-fixture')", [key,account]);
      await db.query('INSERT INTO lanehub_accounts(user_id,lanehub_user_id,key_id) VALUES($1,30000,$2)', [recipient,key]);
      await db.query('INSERT INTO referral_profiles(user_id,frozen) VALUES($1,true)', [recipient]);
      await db.query(`INSERT INTO commission_ledger(user_id,kind,amount_cny,available_at,reference) VALUES
        ($1,'bd',100,now()-interval '40 days',$2),($1,'conversion',-10,now(),$3)`, [recipient,'seed:'+conversion,'convert:'+conversion]);
      await db.query('INSERT INTO commission_conversions(id,user_id,amount_cny) VALUES($1,$2,10)', [conversion,recipient]);
      await db.query("INSERT INTO app_settings(key,value) VALUES('lanehub_mode','on') ON CONFLICT(key) DO UPDATE SET value='on'");
      let calls = 0, unblock, started;
      const gate = new Promise(resolve => { unblock = resolve; }), begun = new Promise(resolve => { started = resolve; });
      const options = { lanehub: { usdRate: async () => 7, addQuota: async () => { calls++; started(); await gate; } }, lanehubQuotaPerUnit: 500000 };
      await deliverConversions(db,options);
      assert.equal(calls,0); assert.equal((await db.query('SELECT state FROM commission_conversions WHERE id=$1',[conversion])).rows[0].state,'pending');
      assert.equal((await adminPost('profiles/'+recipient,{bd_active:false,frozen:false,reason:'verified release from review'})).statusCode,200);
      await db.query("INSERT INTO commission_ledger(user_id,kind,amount_cny,available_at,reference) VALUES($1,'bd',-100,now(),$2)",[recipient,'debt:'+conversion]);
      await deliverConversions(db,options); assert.equal(calls,0);
      await db.query("INSERT INTO commission_ledger(user_id,kind,amount_cny,available_at,reference) VALUES($1,'bd',100,now(),$2)",[recipient,'restore:'+conversion]);
      let ready, releaseRate;
      const rateReady=new Promise(resolve=>{ready=resolve;}), rateGate=new Promise(resolve=>{releaseRate=resolve;});
      options.lanehub.usdRate=async()=>{ready();await rateGate;return 7;};
      const racing=deliverConversions(db,options);
      await rateReady;
      try {
        assert.equal((await adminPost('profiles/'+recipient,{bd_active:false,frozen:true,reason:'freeze while worker prepares credit'})).statusCode,200);
      } finally {releaseRate();await racing;}
      assert.equal(calls,0,'freeze committed before claim prevents the external credit');
      assert.equal((await adminPost('profiles/'+recipient,{bd_active:false,frozen:false,reason:'verified unfreeze after race'})).statusCode,200);
      options.lanehub.usdRate=async()=>7;
      const worker = deliverConversions(db,options);
      await begun;
      try {
        await deliverConversions(db,options);
        assert.equal(calls,1,'only the worker that claims pending may call upstream');
      } finally { unblock(); await worker; }
      assert.equal((await db.query('SELECT state FROM commission_conversions WHERE id=$1',[conversion])).rows[0].state,'applied');
      assert.equal((await db.query('SELECT count(*) FROM wallet_entries WHERE id=$1',[conversion])).rows[0].count,'1');
      assert.equal((await db.query('SELECT paid FROM commission_funds WHERE id=$1',['wallet:'+conversion])).rows[0].paid,false);
      await db.query("UPDATE app_settings SET value='off' WHERE key='lanehub_mode'");
    });
    await t.test('extreme conversion amount rounds upward exactly without floating-point loss', async () => {
      const recipient=await user(),account=randomUUID(),key=randomUUID(),conversion=randomUUID(),value='99999999.99999801';
      await db.query("INSERT INTO upstream_accounts(id,name) VALUES($1,'Extreme fixture')",[account]);
      await db.query("INSERT INTO upstream_keys(id,account_id,name,fingerprint,suffix,secret_ref) VALUES($1,$2,'Extreme','extreme-fixture','fixture','extreme-fixture')",[key,account]);
      await db.query('INSERT INTO lanehub_accounts(user_id,lanehub_user_id,key_id) VALUES($1,30001,$2)',[recipient,key]);
      await db.query("INSERT INTO commission_ledger(user_id,kind,amount_cny,available_at,reference) VALUES($1,'bd',$2,now()-interval '40 days',$3),($1,'conversion',-$2::numeric,now(),$4)",[recipient,value,'seed:'+conversion,'convert:'+conversion]);
      await db.query('INSERT INTO commission_conversions(id,user_id,amount_cny) VALUES($1,$2,$3)',[conversion,recipient,value]);
      await db.query("UPDATE app_settings SET value='on' WHERE key='lanehub_mode'");
      const credits=[];
      const options={lanehub:{usdRate:async()=>7,addQuota:async(id,quota)=>{credits.push({id,quota});}},lanehubQuotaPerUnit:500000};
      await deliverConversions(db,options);
      assert.deepEqual(credits,[{id:30001,quota:7142857142858}]);
      assert.equal((await wallet(db,recipient)).balance_cny,value);
      assert.equal((await commissionBalance(db,recipient)).available_cny,'0.00000000');
      await db.query("UPDATE app_settings SET value='off' WHERE key='lanehub_mode'");
    });
    await t.test('a queue of frozen conversions does not starve another recipient', async () => {
      const account = randomUUID(), key = randomUUID();
      await db.query("INSERT INTO upstream_accounts(id,name) VALUES($1,'Queue fixture')",[account]);
      await db.query("INSERT INTO upstream_keys(id,account_id,name,fingerprint,suffix,secret_ref) VALUES($1,$2,'Queue','queue-fixture','fixture','queue-fixture')",[key,account]);
      let active;
      for(let i=0;i<21;i++) {
        const recipient = await user(), conversion = randomUUID();
        if(i===20) active=conversion;
        await db.query('INSERT INTO lanehub_accounts(user_id,lanehub_user_id,key_id) VALUES($1,$2,$3)',[recipient,31000+i,key]);
        await db.query('INSERT INTO referral_profiles(user_id,frozen) VALUES($1,$2)',[recipient,i<20]);
        await db.query("INSERT INTO commission_ledger(user_id,kind,amount_cny,available_at,reference) VALUES($1,'bd',1,now()-interval '40 days',$2),($1,'conversion',-1,now(),$3)",[recipient,'seed:'+conversion,'convert:'+conversion]);
        await db.query("INSERT INTO commission_conversions(id,user_id,amount_cny,updated_at) VALUES($1,$2,1,now()-interval '1 day'+$3*interval '1 second')",[conversion,recipient,i]);
      }
      await db.query("UPDATE app_settings SET value='on' WHERE key='lanehub_mode'");
      let calls=0;
      const options={lanehub:{usdRate:async()=>7,addQuota:async()=>{calls++;}},lanehubQuotaPerUnit:500000};
      await deliverConversions(db,options); await deliverConversions(db,options);
      assert.equal(calls,1);
      assert.equal((await db.query('SELECT state FROM commission_conversions WHERE id=$1',[active])).rows[0].state,'applied');
      await db.query("UPDATE app_settings SET value='off' WHERE key='lanehub_mode'");
    });
    await t.test('ambiguous LaneHub conversion is held for review and never replayed', async () => {
      const account = randomUUID(), key = randomUUID(), conversion = randomUUID();
      await db.query("INSERT INTO upstream_accounts(id,name) VALUES($1,'Conversion fixture')", [account]);
      await db.query("INSERT INTO upstream_keys(id,account_id,name,fingerprint,suffix,secret_ref) VALUES($1,$2,'Fixture','conversion-fixture','fixture','fixture')", [key, account]);
      await db.query('INSERT INTO lanehub_accounts(user_id,lanehub_user_id,key_id) VALUES($1,12345,$2)', [bd, key]);
      await db.query("INSERT INTO app_settings(key,value) VALUES('lanehub_mode','on') ON CONFLICT(key) DO UPDATE SET value='on'");
      const created = await post('/api/me/commissions/convert', { idempotency_key: conversion, amount_cny: '10' });
      assert.equal(created.statusCode, 200, created.body); assert.equal(created.json().state, 'pending');
      let calls = 0;
      const options = { lanehub: { usdRate: async () => 7, addQuota: async () => { calls++; throw new Error('response_lost'); } }, lanehubQuotaPerUnit: 500000 };
      await deliverConversions(db, options); await deliverConversions(db, options);
      assert.equal(calls, 1);
      assert.equal((await db.query('SELECT state FROM commission_conversions WHERE id=$1', [conversion])).rows[0].state, 'review');
      const resolve = await adminPost('conversions/' + conversion + '/resolve', { result: 'not_applied', reference: 'verified-provider-no-credit' });
      assert.equal(resolve.statusCode, 200, resolve.body);
      assert.equal((await db.query('SELECT count(*) FROM wallet_entries WHERE id=$1', [conversion])).rows[0].count, '0');
      await db.query("UPDATE app_settings SET value='off' WHERE key='lanehub_mode'");
    });
    await reconcileCommissions(db);
    await db.migrate();
  } finally {
    await app?.close(); await db.close(); await setup.query(`DROP SCHEMA ${schema} CASCADE`); await setup.close();
  }
});
