import { randomUUID } from 'node:crypto';
import { httpError, RateLimiter } from './security.mjs';
import { uuid } from './validation.mjs';
import { units, decimal, wallet } from './billing.mjs';
import { lanehubMode, provisionIfEnabled } from './lanehub.mjs';
import { lanehubBalance } from './lanehub-charges.mjs';

const amount = value => {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,8})(\.\d{1,8})?$/.test(value) || units(value) <= 0n)
    throw httpError(400, 'invalid_amount');
  return value;
};
export const note = value => {
  if (typeof value !== 'string' || value.trim().length < 5 || value.length > 500) throw httpError(400, 'invalid_reason');
  return value.trim();
};
export const login = req => {
  if (!req.apiUser?.session_id) throw httpError(401, 'customer_login_required');
  return req.apiUser.id;
};
export const admin = req => {
  if (req.administrator?.role !== 'superadmin') throw httpError(403, 'admin_permission_denied');
};
export const audit = (c, req, action, id, details) => c.query(
  'INSERT INTO audit_events(action,target_id,administrator_id,actor_user_id,details) VALUES($1,$2,$3,$4,$5)',
  [action, id, req.administrator?.id ?? null, req.apiUser?.id ?? null, JSON.stringify(details)]);

async function profile(c, id) {
  await c.query('INSERT INTO referral_profiles(user_id) VALUES($1) ON CONFLICT DO NOTHING', [id]);
  return (await c.query('SELECT * FROM referral_profiles WHERE user_id=$1', [id])).rows[0];
}

export async function commissionBalance(c, id) {
  const sums = (await c.query(`SELECT coalesce(sum(amount_cny),0)::numeric(20,8) AS total_cny,
    least(coalesce(sum(amount_cny),0),coalesce(sum(amount_cny) FILTER(WHERE available_at<=now()),0))::numeric(20,8) AS available_cny,
    least(coalesce(sum(amount_cny),0),coalesce(sum(amount_cny) FILTER(WHERE available_at<=now() AND
      (amount_cny<0 OR kind IN ('payout','conversion') OR created_at < date_trunc('month',now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')),0))::numeric(20,8) AS withdrawable_cny
    FROM commission_ledger WHERE user_id=$1`, [id])).rows[0];
  const blocked = (await c.query(`SELECT 1 FROM referral_profiles WHERE user_id=$1 AND frozen
    UNION ALL SELECT 1 FROM commission_requests WHERE state='disputed' AND (bd_user_id=$1 OR developer_user_id=$1)
    UNION ALL SELECT 1 FROM commission_ledger l JOIN referrals f ON f.user_id=l.referred_user_id
      JOIN payment_orders p ON p.user_id=f.user_id WHERE l.user_id=$1 AND p.state='refund_review' LIMIT 1`, [id])).rowCount > 0;
  return { ...sums, frozen: blocked };
}

async function earningsLock(c, id) {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,1))', [id]);
  const balance = await commissionBalance(c, id);
  if (balance.frozen) throw httpError(409, 'earnings_frozen');
  return balance;
}

export async function reconcileInvitation(c, userId) {
  const referral = (await c.query('SELECT * FROM referrals WHERE user_id=$1', [userId])).rows[0];
  if (!referral) return;
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,2))', [userId]);
  const earned = (await c.query(`SELECT coalesce(sum(amount_cny),0)::numeric(20,8) AS amount,count(*)::integer AS revision
    FROM commission_ledger WHERE referred_user_id=$1 AND kind='invitation'`, [userId])).rows[0];
  const net = (await c.query(`SELECT coalesce(sum(amount_cny),0)-coalesce((SELECT sum(f.amount_cny)
    FROM commission_payment_refunds f JOIN payment_orders p ON p.id=f.payment_order_id WHERE p.user_id=$1),0) AS amount
    FROM payment_orders WHERE user_id=$1 AND mode='prod' AND credited_at IS NOT NULL`, [userId])).rows[0].amount;
  const target = units(net) > units('10') ? units('5') : 0n;
  const delta = target - units(earned.amount);
  if (delta === 0n) return;
  await c.query(`INSERT INTO commission_ledger(user_id,referred_user_id,kind,amount_cny,available_at,reference)
    VALUES($1,$2,'invitation',$3,CASE WHEN $3::numeric<0 THEN greatest(now(),coalesce((SELECT min(available_at) FROM commission_ledger WHERE referred_user_id=$2 AND kind='invitation'),now())) ELSE now()+interval '30 days' END,$4)`,
  [referral.referrer_id, userId, decimal(delta), `invitation:${userId}:${earned.revision + 1}`]);
}

export async function reconcileCommissions(db) {
  const rows = (await db.query(`SELECT s.request_id FROM commission_requests s JOIN requests r ON r.id=s.request_id
    JOIN commission_accounts a ON a.user_id=r.user_id JOIN request_billing b ON b.request_id=r.id
    WHERE s.state NOT IN ('disputed','accrued','historical_sources_review') AND a.sources_confirmed AND b.state IN ('settled','released')
      AND (s.state<>'pending_cost' OR r.cost_cny IS NOT NULL)
      AND (s.state<>'pending_sources' OR (SELECT coalesce(sum(remaining_cny),0) FROM commission_funds WHERE user_id=r.user_id)>=b.charged_cny)
    ORDER BY s.created_at LIMIT 200`)).rows;
  for (const row of rows) await db.tx(c => c.query('SELECT commission_reconcile($1)', [row.request_id]));
  const policy = (await db.query('SELECT enabled FROM commission_policy WHERE id=1')).rows[0];
  if (!policy?.enabled) return;
  const users = (await db.query(`SELECT f.user_id FROM referrals f WHERE
    (CASE WHEN coalesce((SELECT sum(p.amount_cny) FROM payment_orders p WHERE p.user_id=f.user_id AND p.mode='prod' AND p.credited_at IS NOT NULL),0)
      -coalesce((SELECT sum(x.amount_cny) FROM commission_payment_refunds x JOIN payment_orders p ON p.id=x.payment_order_id WHERE p.user_id=f.user_id),0)>10 THEN 5 ELSE 0 END)
    <>coalesce((SELECT sum(l.amount_cny) FROM commission_ledger l WHERE l.kind='invitation' AND l.referred_user_id=f.user_id),0)
    ORDER BY f.user_id LIMIT 200`)).rows;
  for (const row of users) await db.tx(c => reconcileInvitation(c, row.user_id));
}

export async function bindReferral(c, authUserId, userId) {
  await c.query(`INSERT INTO referrals(user_id,referrer_id)
    SELECT $2,referrer_id FROM referral_registrations WHERE auth_user_id=$1 AND referrer_id<>$2 ON CONFLICT DO NOTHING`, [authUserId, userId]);
}

async function appendConversionCredit(c, conversion) {
  await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [conversion.user_id]);
  const balance = decimal(units((await wallet(c, conversion.user_id)).balance_cny) + units(conversion.amount_cny));
  await c.query(`INSERT INTO wallet_entries(id,user_id,amount_cny,balance_after_cny,source,note)
    VALUES($1,$2,$3,$4,'earnings_conversion','收益转使用余额') ON CONFLICT(id) DO NOTHING`,
  [conversion.id, conversion.user_id, conversion.amount_cny, balance]);
  await c.query("UPDATE commission_conversions SET state='applied',updated_at=now() WHERE id=$1", [conversion.id]);
}

export async function deliverConversions(db, options) {
  if (!options.lanehub || !await lanehubMode(db)) return;
  await db.query("UPDATE commission_conversions SET state='review',updated_at=now() WHERE state='applying' AND updated_at<now()-interval '5 minutes'");
  const pending = (await db.query("SELECT * FROM commission_conversions WHERE state='pending' ORDER BY updated_at,id LIMIT 20")).rows;
  for (const item of pending) {
    const account = await provisionIfEnabled(db, options, { userId: item.user_id });
    if (!account) continue;
    const rate = await options.lanehub.usdRate();
    const perUnit = options.lanehubQuotaPerUnit ?? 500000;
    if (!Number.isSafeInteger(perUnit) || perUnit <= 0 || !/^(0|[1-9]\d*)(\.\d{1,8})?$/.test(String(rate))) continue;
    const rateUnits = units(String(rate));
    if (rateUnits <= 0n) continue;
    const exactQuota = (units(item.amount_cny) * BigInt(perUnit) + rateUnits - 1n) / rateUnits;
    if (exactQuota <= 0n || exactQuota > BigInt(Number.MAX_SAFE_INTEGER)) continue;
    const quota = Number(exactQuota);
    const claim = await db.tx(async c => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,1))', [item.user_id]);
      const balance = await commissionBalance(c, item.user_id);
      // The reservation already debited earnings; a reversal must not release an unfunded credit.
      if (balance.frozen || units(balance.available_cny) < 0n) {
        await c.query("UPDATE commission_conversions SET updated_at=now() WHERE id=$1 AND state='pending'", [item.id]);
        return { rowCount: 0 };
      }
      return c.query("UPDATE commission_conversions SET state='applying',updated_at=now() WHERE id=$1 AND state='pending' RETURNING id", [item.id]);
    });
    if (!claim.rowCount) continue;
    try {
      await options.lanehub.addQuota(account.lanehub_user_id, quota, '收益转余额 ' + item.id);
      await db.tx(c => appendConversionCredit(c, item));
    } catch {
      // A lost quota response cannot be retried safely; an operator must verify the upstream receipt.
      await db.query("UPDATE commission_conversions SET state='review',updated_at=now() WHERE id=$1", [item.id]);
    }
  }
}

export function commissionRoutes(app, options) {
  const { db } = options;
  const limiter = new RateLimiter();
  app.get('/api/account/referral/:code', async (req, reply) => {
    limiter.take('referral:' + req.ip, 60, 60000);
    const code = req.params.code;
    if (!/^[a-f0-9]{32}$/.test(code) || !(await db.query('SELECT 1 FROM referral_profiles WHERE code=$1', [code])).rowCount)
      throw httpError(404, 'referral_not_found');
    reply.header('Set-Cookie', `ipzsk_referral=${code}; Path=/api; HttpOnly; SameSite=Lax; Max-Age=2592000${options.origin.startsWith('https:') ? '; Secure' : ''}`);
    return reply.redirect('https://www.ipzsk.com/account?mode=register');
  });
  app.get('/api/me/commissions', async req => {
    const id = login(req), p = await profile(db, id), policy = (await db.query(`SELECT bd_share_bps,developer_share_bps,
      'remaining_profit' AS developer_basis,enabled AS active FROM commission_policy WHERE id=1`)).rows[0];
    const developer = (await db.query('SELECT state,display_name FROM developer_profiles WHERE user_id=$1', [id])).rows[0] ?? null;
    return { profile: p, developer, policy, invitation_url: `${options.origin}/api/account/referral/${p.code}`, balance: await commissionBalance(db, id),
      earned: Object.fromEntries((await db.query(`SELECT kind,sum(amount_cny)::numeric(20,8) AS amount_cny FROM commission_ledger
        WHERE user_id=$1 AND kind IN ('bd','developer','invitation') GROUP BY kind`, [id])).rows.map(row => [row.kind, row.amount_cny])),
      // Plugin names only on the caller's own developer rows; BD rows stay at request level.
      ledger: (await db.query(`SELECT l.kind,l.amount_cny,l.available_at,l.created_at,l.request_id,p.name AS plugin_name FROM commission_ledger l
        LEFT JOIN requests r ON r.id=l.request_id AND l.kind='developer' AND r.plugin_owner_user_id=l.user_id
        LEFT JOIN plugins p ON p.id=r.plugin_id WHERE l.user_id=$1 ORDER BY l.id DESC LIMIT 100`, [id])).rows,
      referrals: (await db.query('SELECT count(*)::integer AS count FROM referrals WHERE referrer_id=$1', [id])).rows[0].count,
      payouts: (await db.query('SELECT * FROM commission_payouts WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50', [id])).rows,
      conversions: (await db.query('SELECT * FROM commission_conversions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50', [id])).rows };
  });
  app.post('/api/me/commissions/convert', async req => {
    const userId = login(req), id = uuid(req.body?.idempotency_key), value = amount(req.body?.amount_cny);
    if (units(value) < units('0.01')) throw httpError(400, 'conversion_minimum');
    const remote = await lanehubMode(db);
    return db.tx(async c => {
      const balance = await earningsLock(c, userId);
      const old = (await c.query('SELECT * FROM commission_conversions WHERE id=$1', [id])).rows[0];
      if (old) {
        if (old.user_id !== userId || units(old.amount_cny) !== units(value)) throw httpError(409, 'idempotency_conflict');
        return old;
      }
      if (units(balance.available_cny) < units(value)) throw httpError(409, 'insufficient_earnings');
      const row = (await c.query('INSERT INTO commission_conversions(id,user_id,amount_cny) VALUES($1,$2,$3) RETURNING *', [id, userId, value])).rows[0];
      await c.query(`INSERT INTO commission_ledger(user_id,kind,amount_cny,available_at,reference)
        VALUES($1,'conversion',-$2::numeric,now(),$3)`, [userId, value, 'convert:' + id]);
      if (!remote) await appendConversionCredit(c, row);
      await audit(c, req, 'commission.convert', id, { amount_cny: value, remote });
      return { ...row, state: remote ? 'pending' : 'applied' };
    });
  });
  app.post('/api/me/commissions/payouts', async req => {
    const userId = login(req), key = uuid(req.body?.idempotency_key), value = amount(req.body?.amount_cny);
    if (units(value) < units('100') || units(value) % units('0.01') !== 0n) throw httpError(400, 'payout_minimum_or_precision');
    return db.tx(async c => {
      const balance = await earningsLock(c, userId);
      const old = (await c.query('SELECT * FROM commission_payouts WHERE user_id=$1 AND idempotency_key=$2', [userId, key])).rows[0];
      if (old) {
        if (units(old.amount_cny) !== units(value)) throw httpError(409, 'idempotency_conflict');
        return old;
      }
      if (units(balance.withdrawable_cny) < units(value)) throw httpError(409, 'insufficient_earnings');
      const row = (await c.query('INSERT INTO commission_payouts(user_id,idempotency_key,amount_cny) VALUES($1,$2,$3) RETURNING *', [userId, key, value])).rows[0];
      await c.query(`INSERT INTO commission_ledger(user_id,kind,amount_cny,available_at,reference)
        VALUES($1,'payout',-$2::numeric,now(),$3)`, [userId, value, 'payout:' + row.id]);
      await audit(c, req, 'commission.payout.request', row.id, { amount_cny: value });
      return row;
    });
  });
  app.get('/admin/api/commissions', async req => {
    admin(req);
    return { policy: (await db.query('SELECT * FROM commission_policy WHERE id=1')).rows[0],
      profiles: (await db.query('SELECT p.*,u.name FROM referral_profiles p JOIN users u ON u.id=p.user_id ORDER BY u.created_at DESC LIMIT 200')).rows,
      requests: (await db.query('SELECT * FROM commission_requests WHERE enabled ORDER BY created_at DESC LIMIT 100')).rows,
      accounts: (await db.query('SELECT a.*,u.name FROM commission_accounts a JOIN users u ON u.id=a.user_id ORDER BY sources_confirmed,u.created_at DESC LIMIT 200')).rows,
      payouts: (await db.query('SELECT p.*,u.name FROM commission_payouts p JOIN users u ON u.id=p.user_id ORDER BY p.created_at DESC LIMIT 100')).rows,
      conversions: (await db.query("SELECT * FROM commission_conversions WHERE state IN ('pending','applying','review') ORDER BY created_at LIMIT 100")).rows };
  });
  app.post('/admin/api/commissions/policy', async req => {
    admin(req);
    if (typeof req.body?.enabled !== 'boolean') throw httpError(400, 'invalid_policy');
    const why = note(req.body.reason);
    await db.tx(async c => {
      await c.query('SELECT id FROM commission_policy WHERE id=1 FOR UPDATE');
      if (req.body.enabled && (await c.query('SELECT 1 FROM commission_accounts WHERE NOT sources_confirmed LIMIT 1')).rowCount)
        throw httpError(409, 'commission_sources_migration_required');
      const saved = (await c.query('UPDATE commission_policy SET enabled=$1 WHERE id=1 RETURNING *', [req.body.enabled])).rows[0];
      await audit(c, req, 'commission.policy', null, { enabled: req.body.enabled, reason: why,
        bd_share_bps: saved.bd_share_bps, developer_share_bps: saved.developer_share_bps });
    });
    return { ok: true };
  });
  app.post('/admin/api/commissions/profiles/:id', async req => {
    admin(req);
    const id = uuid(req.params.id), why = note(req.body?.reason);
    if (typeof req.body.bd_active !== 'boolean' || typeof req.body.frozen !== 'boolean') throw httpError(400, 'invalid_profile');
    await db.tx(async c => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,1))', [id]);
      if (!(await c.query('SELECT 1 FROM users WHERE id=$1', [id])).rowCount) throw httpError(404, 'user_not_found');
      const previous = await profile(c, id);
      // BD is granted only by the user accepting an administrator invitation (role-invitations.mjs).
      if (req.body.bd_active && !previous.bd_active) throw httpError(409, 'bd_invitation_required');
      await c.query('UPDATE referral_profiles SET bd_active=$2,frozen=$3 WHERE user_id=$1', [id, req.body.bd_active, req.body.frozen]);
      await audit(c, req, 'commission.profile', id, { bd_active: req.body.bd_active, frozen: req.body.frozen, reason: why,
        previous: { bd_active: previous.bd_active, frozen: previous.frozen } });
    });
    return { ok: true };
  });
  app.post('/admin/api/commissions/reconcile', async req => {
    admin(req); await reconcileCommissions(db); return { ok: true };
  });
  app.post('/admin/api/commissions/opening-balance/:id', async req => {
    admin(req);
    const id = uuid(req.params.id), why = note(req.body?.reference), lots = req.body?.paid_lots;
    if (!Array.isArray(lots) || lots.length > 100) throw httpError(400, 'invalid_opening_sources');
    const paidLots = lots.map(lot => ({ id: uuid(lot?.payment_order_id), amount: amount(lot?.amount_cny) }));
    if (new Set(paidLots.map(lot => lot.id)).size !== paidLots.length) throw httpError(400, 'duplicate_payment_source');
    const remote = await lanehubMode(db);
    const account = remote ? (await db.query('SELECT * FROM lanehub_accounts WHERE user_id=$1', [id])).rows[0] : null;
    if (remote && (!options.lanehub || !account)) throw httpError(409, 'lanehub_account_missing');
    return db.tx(async c => {
      await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [id]);
      if ((await c.query('SELECT enabled FROM commission_policy WHERE id=1 FOR UPDATE')).rows[0].enabled) throw httpError(409, 'pause_commissions_before_source_migration');
      if ((await c.query(`SELECT 1 FROM requests WHERE user_id=$1 AND status IN ('queued','running')
        UNION ALL SELECT 1 FROM request_billing WHERE user_id=$1 AND state IN ('reserved','pending')
        UNION ALL SELECT 1 FROM commission_requests s JOIN requests r ON r.id=s.request_id
          LEFT JOIN request_billing b ON b.request_id=r.id WHERE r.user_id=$1 AND
          (b.request_id IS NULL OR s.charged_cny IS NOT NULL OR EXISTS(SELECT 1 FROM commission_allocations WHERE request_id=r.id)
            OR EXISTS(SELECT 1 FROM commission_ledger WHERE request_id=r.id)) LIMIT 1`, [id])).rowCount)
        throw httpError(409, 'opening_balance_requires_idle_account');
      const actual = remote ? await lanehubBalance(options.lanehub, account, { usdCnyRate: options.lanehubUsdCny, quotaPerUnit: options.lanehubQuotaPerUnit ?? 500000 }) : await wallet(c, id);
      const available = units(actual.balance_cny);
      const paidTotal = paidLots.reduce((sum, lot) => sum + units(lot.amount), 0n);
      if (paidTotal > available || available < 0n) throw httpError(409, 'opening_sources_exceed_balance');
      for (const lot of paidLots) {
        const payment = (await c.query(`SELECT p.amount_cny-coalesce((SELECT sum(amount_cny) FROM commission_payment_refunds WHERE payment_order_id=p.id),0)
          -coalesce((SELECT sum(a.amount_cny-a.returned_cny) FROM commission_allocations a JOIN commission_funds f ON f.id=a.fund_id WHERE f.payment_order_id=p.id),0) AS remaining
          FROM payment_orders p WHERE p.id=$1 AND p.user_id=$2 AND p.mode='prod' AND p.credited_at IS NOT NULL`, [lot.id, id])).rows[0];
        if (!payment || units(payment.remaining) < units(lot.amount)) throw httpError(409, 'unverified_payment_source');
      }
      // Current remaining balance cannot prove the funding sources of earlier consumption.
      const held = await c.query(`UPDATE commission_requests s SET state='historical_sources_review'
        FROM requests r WHERE r.id=s.request_id AND r.user_id=$1 AND s.charged_cny IS NULL
        AND s.state<>'historical_sources_review' RETURNING s.request_id`, [id]);
      await c.query('UPDATE commission_funds SET remaining_cny=0 WHERE user_id=$1', [id]);
      const checkpoint = randomUUID();
      for (const lot of paidLots) await c.query(`INSERT INTO commission_funds(id,user_id,payment_order_id,paid,amount_cny,remaining_cny)
        VALUES($1,$2,$3,true,$4,$4)`, ['opening:' + checkpoint + ':' + lot.id, id, lot.id, lot.amount]);
      if (available > paidTotal) await c.query(`INSERT INTO commission_funds(id,user_id,paid,amount_cny,remaining_cny)
        VALUES($1,$2,false,$3,$3)`, ['opening:' + checkpoint, id, decimal(available - paidTotal)]);
      await c.query('UPDATE commission_accounts SET sources_confirmed=true WHERE user_id=$1', [id]);
      await audit(c, req, 'commission.opening_balance', id, { balance_cny: decimal(available), paid_lots: paidLots, historical_requests: held.rows.map(row => row.request_id), reference: why });
      return { ok: true, balance_cny: decimal(available), historical_review_count: held.rowCount };
    });
  });
  app.post('/admin/api/commissions/payment-refunds/:id', async req => {
    admin(req);
    const id = uuid(req.params.id), value = amount(req.body?.amount_cny), reference = note(req.body?.reference);
    if (typeof req.body.chargeback !== 'boolean') throw httpError(400, 'invalid_refund_type');
    return db.tx(async c => {
      const order = (await c.query("SELECT * FROM payment_orders WHERE id=$1 AND mode='prod' AND credited_at IS NOT NULL FOR UPDATE", [id])).rows[0];
      if (!order) throw httpError(404, 'not_found');
      await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [order.user_id]);
      if (!req.body.chargeback && (await c.query(`SELECT 1 FROM requests WHERE user_id=$1 AND status IN ('queued','running')
        UNION ALL SELECT 1 FROM request_billing WHERE user_id=$1 AND state IN ('reserved','pending') LIMIT 1`, [order.user_id])).rowCount)
        throw httpError(409, 'refund_pending_usage');
      const old = (await c.query('SELECT * FROM commission_payment_refunds WHERE reference=$1', [reference])).rows[0];
      if (old) {
        if (old.payment_order_id !== id || units(old.amount_cny) !== units(value) || old.chargeback !== req.body.chargeback) throw httpError(409, 'idempotency_conflict');
        return { ok: true };
      }
      const refunded = (await c.query('SELECT coalesce(sum(amount_cny),0) AS amount FROM commission_payment_refunds WHERE payment_order_id=$1', [id])).rows[0].amount;
      if (units(refunded) + units(value) > units(order.amount_cny)) throw httpError(409, 'refund_exceeds_payment');
      let remaining = units(value);
      const funds = (await c.query('SELECT * FROM commission_funds WHERE payment_order_id=$1 ORDER BY id FOR UPDATE', [id])).rows;
      for (const fund of funds) {
        const take = remaining < units(fund.remaining_cny) ? remaining : units(fund.remaining_cny);
        await c.query('UPDATE commission_funds SET remaining_cny=remaining_cny-$2 WHERE id=$1', [fund.id, decimal(take)]);
        remaining -= take;
      }
      const balanceDeduction = decimal(units(value) - remaining);
      if (remaining > 0n && !req.body.chargeback) throw httpError(409, 'refund_exceeds_unused_principal');
      const affected = new Set();
      if (remaining > 0n) {
        const allocations = (await c.query(`SELECT a.* FROM commission_allocations a JOIN commission_funds f ON f.id=a.fund_id
          WHERE f.payment_order_id=$1 ORDER BY a.request_id,a.fund_id FOR UPDATE OF a`, [id])).rows;
        for (const allocation of allocations) {
          const available = units(allocation.amount_cny) - units(allocation.returned_cny) - units(allocation.chargeback_cny);
          const take = remaining < available ? remaining : available;
          if (take <= 0n) continue;
          await c.query('UPDATE commission_allocations SET chargeback_cny=chargeback_cny+$3 WHERE request_id=$1 AND fund_id=$2', [allocation.request_id, allocation.fund_id, decimal(take)]);
          affected.add(allocation.request_id); remaining -= take;
          if (remaining === 0n) break;
        }
      }
      if (remaining > 0n) throw httpError(409, 'payment_sources_unresolved');
      await c.query('INSERT INTO commission_payment_refunds(reference,payment_order_id,amount_cny,chargeback,balance_deduction_cny) VALUES($1,$2,$3,$4,$5)', [reference, id, value, req.body.chargeback, balanceDeduction]);
      await c.query("UPDATE payment_orders SET state='credited',review_reason=NULL,updated_at=now() WHERE id=$1", [id]);
      const disputed = (await c.query(`SELECT DISTINCT a.request_id FROM commission_allocations a JOIN commission_funds f ON f.id=a.fund_id
        WHERE f.payment_order_id=$1`, [id])).rows;
      for (const row of disputed) affected.add(row.request_id);
      for (const rid of affected) {
        if ((await c.query(`SELECT 1 FROM commission_allocations a JOIN commission_funds f ON f.id=a.fund_id
          JOIN payment_orders p ON p.id=f.payment_order_id WHERE a.request_id=$1 AND p.state='refund_review' LIMIT 1`, [rid])).rowCount) continue;
        await c.query("UPDATE commission_requests SET state='pending_billing' WHERE request_id=$1 AND state='disputed'", [rid]);
        await c.query('SELECT commission_reconcile($1)', [rid]);
      }
      await reconcileInvitation(c, order.user_id);
      await audit(c, req, 'commission.payment_refund.confirm', id, { amount_cny: value, chargeback: req.body.chargeback, reference });
      return { ok: true };
    });
  });
  app.post('/admin/api/commissions/payouts/:id', async req => {
    admin(req);
    const id = uuid(req.params.id), state = req.body?.state, reference = note(req.body?.reference);
    if (!['approved', 'paid', 'cancelled'].includes(state)) throw httpError(400, 'invalid_payout_state');
    return db.tx(async c => {
      const found = (await c.query('SELECT user_id FROM commission_payouts WHERE id=$1', [id])).rows[0];
      if (!found) throw httpError(404, 'not_found');
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,1))', [found.user_id]);
      const row = (await c.query('SELECT * FROM commission_payouts WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (row.state === state) return row;
      if (row.state === 'paid' || row.state === 'cancelled' || (state === 'paid' && row.state !== 'approved')) throw httpError(409, 'invalid_payout_transition');
      if (state !== 'cancelled') {
        const balance = await commissionBalance(c, row.user_id);
        if (balance.frozen || units(balance.withdrawable_cny) < 0n) throw httpError(409, 'earnings_frozen_or_reversed');
      } else {
        await c.query(`INSERT INTO commission_ledger(user_id,kind,amount_cny,available_at,reference)
          VALUES($1,'payout',$2,now(),$3)`, [row.user_id, row.amount_cny, 'payout-cancel:' + id]);
      }
      await c.query(`UPDATE commission_payouts SET state=$2,payment_reference=$3,paid_at=CASE WHEN $2='paid' THEN now() ELSE NULL END WHERE id=$1`, [id, state, reference]);
      await audit(c, req, 'commission.payout.' + state, id, { reference });
      return { ok: true };
    });
  });
  app.post('/admin/api/commissions/conversions/:id/resolve', async req => {
    admin(req);
    const id = uuid(req.params.id), result = req.body?.result, why = note(req.body?.reference);
    if (!['applied', 'not_applied'].includes(result)) throw httpError(400, 'invalid_conversion_resolution');
    return db.tx(async c => {
      const row = (await c.query('SELECT * FROM commission_conversions WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!row) throw httpError(404, 'not_found');
      if (row.state !== 'review') throw httpError(409, 'conversion_not_in_review');
      if (result === 'applied') await appendConversionCredit(c, row);
      else {
        await c.query("UPDATE commission_conversions SET state='cancelled',updated_at=now() WHERE id=$1", [id]);
        await c.query(`INSERT INTO commission_ledger(user_id,kind,amount_cny,available_at,reference)
          VALUES($1,'conversion',$2,now(),$3)`, [row.user_id, row.amount_cny, 'convert-cancel:' + id]);
      }
      await audit(c, req, 'commission.conversion.resolve', id, { result, reference: why });
      return { ok: true };
    });
  });
}
