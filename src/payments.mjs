import { randomUUID, createHash } from 'node:crypto';
import { httpError, RateLimiter } from './security.mjs';
import { uuid } from './validation.mjs';
import { loadRoles, requireRole } from './roles.mjs';
import { units, decimal, wallet } from './billing.mjs';
import { customerOrigin } from './customer-auth.mjs';
import { checkoutUrl } from './waffo.mjs';
import { lanehubMode } from './lanehub.mjs';

const orderFields = 'id,mode,pack_key,amount_cny,currency,state,created_at,paid_at,credited_at';
const monetary = value => {
  if (!/^\d{1,12}(\.\d{1,8})?$/.test(String(value ?? ''))) throw httpError(400, 'invalid_payment_amount');
  return units(value);
};
const digest = text => createHash('sha256').update(text).digest('hex');

export function validatePayment(event, order, provider, remote) {
  const data = event.data;
  if (event.mode !== provider.mode || event.storeId !== provider.storeId || order.mode !== provider.mode ||
      data.orderMerchantExternalId !== order.id || remote.orderMerchantExternalId !== order.id ||
      data.merchantProvidedBuyerIdentity !== order.user_id || remote.merchantProvidedBuyerIdentity !== order.user_id || remote.id !== data.orderId ||
      remote.store?.id !== provider.storeId || remote.onetimeProduct?.id !== order.product_id ||
      remote.testMode !== (order.mode === 'test') || remote.status !== 'completed' ||
      data.orderStatus !== 'completed' || data.paymentStatus !== 'succeeded' ||
      data.currency !== order.currency || remote.priceSnapshot?.currency !== order.currency ||
      monetary(remote.priceSnapshot.subtotal) !== monetary(order.amount_cny) ||
      monetary(remote.priceSnapshot.total) !== monetary(data.total) ||
      monetary(data.total) < monetary(order.amount_cny)) throw httpError(409, 'payment_mismatch');
}

// Persist the verified event and paid state before acknowledging it. Network quota calls run later.
export async function receivePayment(db, provider, raw, signature) {
  let event;
  try { event = provider.verify(raw, signature); } catch { throw httpError(401, 'invalid_payment_signature'); }
  if (event.mode !== provider.mode || event.storeId !== provider.storeId) throw httpError(400, 'payment_environment_mismatch');
  if (!['order.completed', 'refund.succeeded', 'refund.failed'].includes(event.eventType)) return { received: true };
  const data = event.data;
  if (typeof event.id !== 'string' || event.id.length > 150 || typeof data?.orderId !== 'string' || data.orderId.length > 150)
    throw httpError(400, 'invalid_payment_event');
  const previous = (await db.query('SELECT payload_hash FROM payment_events WHERE mode=$1 AND event_id=$2', [event.mode, event.id])).rows[0];
  if (previous) {
    if (previous.payload_hash !== digest(raw)) throw httpError(409, 'payment_event_conflict');
    return { received: true, replayed: true };
  }
  const id = data.orderMerchantExternalId;
  // Purchases made outside IPZSK's authenticated checkout have no internal order to fulfil.
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw httpError(409, 'payment_order_unmatched');
  const order = (await db.query('SELECT * FROM payment_orders WHERE id=$1 AND mode=$2', [uuid(id), event.mode])).rows[0];
  if (!order) throw httpError(409, 'payment_order_unmatched');
  if (event.eventType === 'order.completed') validatePayment(event, order, provider, await provider.readOrder(data.orderId));
  else if (data.currency !== order.currency || data.merchantProvidedBuyerIdentity !== order.user_id)
    throw httpError(409, 'payment_mismatch');
  return db.tx(async c => {
    const row = (await c.query('SELECT * FROM payment_orders WHERE id=$1 FOR UPDATE', [id])).rows[0];
    const inserted = await c.query(`INSERT INTO payment_events(mode,event_id,event_type,provider_order_id,order_id,payload_hash)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING event_id`,
    [event.mode, event.id, event.eventType, data.orderId, id, digest(raw)]);
    if (!inserted.rowCount) {
      const existing = (await c.query('SELECT payload_hash FROM payment_events WHERE mode=$1 AND event_id=$2', [event.mode, event.id])).rows[0];
      if (existing?.payload_hash !== digest(raw)) throw httpError(409, 'payment_event_conflict');
      return { received: true, replayed: true };
    }
    if (row.provider_order_id && row.provider_order_id !== data.orderId) {
      await c.query("UPDATE payment_orders SET state='review_required',review_reason='multiple_provider_orders',updated_at=now() WHERE id=$1", [id]);
    } else if (event.eventType === 'refund.succeeded') {
      // A refund can race credit delivery. Stop pending delivery; flag credited orders for reconciliation.
      await c.query(`UPDATE payment_orders SET provider_order_id=$2,state='refund_review',review_reason='refund_succeeded',updated_at=now() WHERE id=$1`, [id, data.orderId]);
    } else if (event.eventType === 'order.completed' && !['credited', 'test_completed', 'crediting', 'refund_review', 'review_required'].includes(row.state)) {
      await c.query(`UPDATE payment_orders SET provider_order_id=$2,state=$3,paid_at=now(),updated_at=now() WHERE id=$1`,
        [id, data.orderId, row.mode === 'test' ? 'test_completed' : 'paid']);
    }
    await c.query('INSERT INTO audit_events(action,target_id,details) VALUES($1,$2,$3)',
      ['payment.' + event.eventType, id, JSON.stringify({ mode: event.mode, provider_order_id: data.orderId, event_id: event.id })]);
    return { received: true };
  });
}

async function appendCredit(c, row) {
  await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [row.user_id]);
  const balance = decimal(units((await wallet(c, row.user_id)).balance_cny) + units(row.amount_cny));
  await c.query(`INSERT INTO wallet_entries(id,user_id,amount_cny,balance_after_cny,source,payment_order_id)
    VALUES($1,$2,$3,$4,'payment',$5) ON CONFLICT(payment_order_id) DO NOTHING`,
  [randomUUID(), row.user_id, row.amount_cny, balance, row.id]);
  await c.query(`UPDATE payment_orders SET state=CASE WHEN state='refund_review' THEN state ELSE 'credited' END,
    credited_at=now(),updated_at=now() WHERE id=$1`, [row.id]);
}

// LaneHub's addQuota API has no provider idempotency key. Once a call starts, an ambiguous
// failure must be reviewed; automatically retrying after a lost response can double-credit.
export async function deliverPayments(db, lanehub) {
  await db.query(`UPDATE payment_orders SET state='review_required',review_reason='credit_interrupted',updated_at=now()
    WHERE state='crediting' AND updated_at<now()-interval '5 minutes'`);
  const ids = (await db.query("SELECT id FROM payment_orders WHERE state='paid' AND mode='prod' ORDER BY created_at LIMIT 20")).rows;
  for (const { id } of ids) {
    const claimed = await db.tx(async c => {
      const row = (await c.query("SELECT * FROM payment_orders WHERE id=$1 AND state='paid' FOR UPDATE SKIP LOCKED", [id])).rows[0];
      if (!row) return null;
      if (row.target === 'local') { await appendCredit(c, row); return null; }
      if (!lanehub || !row.lanehub_user_id || !row.quota) return null;
      await c.query("UPDATE payment_orders SET state='crediting',updated_at=now() WHERE id=$1", [id]);
      return row;
    });
    if (!claimed) continue;
    try {
      await lanehub.addQuota(claimed.lanehub_user_id, Number(claimed.quota), 'Waffo 充值 ' + claimed.id);
      await db.tx(async c => {
        const row = (await c.query('SELECT * FROM payment_orders WHERE id=$1 FOR UPDATE', [id])).rows[0];
        await appendCredit(c, row);
      });
    } catch {
      await db.query(`UPDATE payment_orders SET state=CASE WHEN state='refund_review' THEN state ELSE 'review_required' END,
        review_reason='credit_result_unknown',updated_at=now() WHERE id=$1`, [id]);
    }
  }
}

export function paymentRoutes(app, { db, waffo = null, lanehub = null, lanehubQuotaPerUnit = 500000 }) {
  const limiter = new RateLimiter();
  async function allowed(req) {
    if (!req.apiUser?.session_id) throw httpError(401, 'customer_login_required');
    return Boolean(waffo) && (waffo.mode === 'prod' || (await loadRoles(db, req.apiUser.id)).includes('admin'));
  }
  app.get('/api/me/payments/options', async req => {
    const enabled = await allowed(req);
    return { enabled, mode: enabled ? waffo.mode : null,
      packs: enabled ? waffo.products.map(({ productId, ...pack }) => pack) : [] };
  });
  app.get('/api/me/payments/orders', async req => {
    if (!req.apiUser?.session_id) throw httpError(401, 'customer_login_required');
    return { rows: (await db.query(`SELECT ${orderFields} FROM payment_orders WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30`, [req.apiUser.id])).rows };
  });
  app.post('/api/me/payments/checkout', async req => {
    if (!await allowed(req)) throw httpError(503, 'online_payment_unavailable');
    limiter.take('payment:' + req.apiUser.id, 6);
    const pack = waffo.products.find(p => p.key === req.body?.pack);
    if (!pack) throw httpError(400, 'invalid_payment_pack');
    // The checkout email must come from the verified login, never from the browser.
    const buyerEmail = req.apiUser.email?.trim().toLowerCase();
    if (!buyerEmail || buyerEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyerEmail))
      throw httpError(409, 'payment_email_unavailable');
    const key = uuid(req.headers['idempotency-key']);
    const id = randomUUID();
    // 入账目标必须跟着**当前的额度真源**走，不能只看 lanehub 客户端是否存在：
    // 回滚（lanehub_mode=off）后网站/后台读本地钱包，充值却还加在对面，用户会充了看不到。
    const useLanehub = Boolean(lanehub) && await lanehubMode(db);
    let target = waffo.mode === 'test' ? 'test' : useLanehub ? 'lanehub' : 'local', mapping, quota = null;
    if (target === 'lanehub') {
      mapping = (await db.query('SELECT lanehub_user_id FROM lanehub_accounts WHERE user_id=$1', [req.apiUser.id])).rows[0];
      if (!mapping) throw httpError(503, 'payment_wallet_unavailable');
      const rate = await lanehub.usdRate();
      quota = Math.round(Number(pack.amount_cny) / rate * lanehubQuotaPerUnit);
      if (!(rate > 0) || !Number.isSafeInteger(quota) || quota <= 0) throw httpError(503, 'payment_wallet_unavailable');
    }
    const inserted = await db.query(`INSERT INTO payment_orders(id,user_id,mode,pack_key,product_id,amount_cny,currency,
      idempotency_key,target,lanehub_user_id,quota) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT(user_id,idempotency_key) DO NOTHING RETURNING id`,
    [id, req.apiUser.id, waffo.mode, pack.key, pack.productId, pack.amount_cny, pack.currency, key, target, mapping?.lanehub_user_id ?? null, quota]);
    if (!inserted.rowCount) throw httpError(409, 'payment_checkout_already_requested');
    try {
      const session = await waffo.createCheckout({ productId: pack.productId, currency: pack.currency,
        buyerIdentity: req.apiUser.id, buyerEmail,
        billingDetail: { country: 'CN', isBusiness: false },
        orderMerchantExternalId: id, metadata: { ipzsk_order_id: id }, language: 'zh-Hans',
        successUrl: customerOrigin + '/?payment=return#wallet', expiresInSeconds: 1800 });
      const url = checkoutUrl(session.checkoutUrl);
      await db.query(`UPDATE payment_orders SET checkout_session_id=$2,state=CASE WHEN state='creating' THEN 'checkout_ready' ELSE state END,
        updated_at=now() WHERE id=$1`, [id, session.sessionId]);
      return { order_id: id, checkout_url: url, mode: waffo.mode };
    } catch {
      await db.query("UPDATE payment_orders SET state='checkout_failed',updated_at=now() WHERE id=$1 AND state='creating'", [id]);
      throw httpError(502, 'payment_checkout_failed');
    }
  });
  app.get('/api/admin/payments', async req => {
    await requireRole(req, 'admin', 'operator', 'viewer');
    return { rows: (await db.query(`SELECT ${orderFields},user_id,provider_order_id,target,review_reason
      FROM payment_orders ORDER BY created_at DESC LIMIT 100`)).rows };
  });
  app.register(async webhook => {
    webhook.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));
    webhook.post('/api/payments/waffo/webhook', { bodyLimit: 128000 }, async req => {
      if (!waffo) throw httpError(503, 'online_payment_unavailable');
      return receivePayment(db, waffo, req.body, req.headers['x-waffo-signature']);
    });
  });
}
