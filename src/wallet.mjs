import { wallet } from './billing.mjs';
import * as v from './validation.mjs';
import { provisionIfEnabled } from './lanehub.mjs';
import { lanehubBalance } from './lanehub-charges.mjs';

const points = (cny) => (Number(cny ?? 0) * 100).toFixed(2);

export function walletRoutes(app, options) {
  const { db, lanehub = null, lanehubUsdCny = 0, lanehubQuotaPerUnit = 500000 } = options;
  app.get('/admin/api/wallet/entries', async (req) => {
    const page = v.integer(Number(req.query.page ?? 1), 1, 100000);
    const userId = req.query.user_id ? v.uuid(req.query.user_id) : null;
    const rows = (await db.query(`SELECT l.id,l.user_id,l.amount_cny,l.balance_after_cny,l.source,l.payment_order_id,l.created_at,u.name AS user_name
      FROM wallet_entries l JOIN users u ON u.id=l.user_id
      WHERE ($1::uuid IS NULL OR l.user_id=$1) ORDER BY l.created_at DESC,l.id LIMIT 30 OFFSET $2`, [userId, (page - 1) * 30])).rows;
    const count = Number((await db.query('SELECT count(*) FROM wallet_entries WHERE ($1::uuid IS NULL OR user_id=$1)', [userId])).rows[0].count);
    return { rows, page, count, page_size: 30 };
  });
  app.get('/api/me/wallet', async (req) => {
    // LaneHub 模式保留其权威余额，本地账本保留历史入账与消费记录。
    const account = lanehub ? await provisionIfEnabled(db, options, { userId: req.apiUser.id, name: req.apiUser.name }).catch(() => null) : null;
    const balances = account
      ? await lanehubBalance(lanehub, account, { usdCnyRate: lanehubUsdCny, quotaPerUnit: lanehubQuotaPerUnit })
      : await wallet(db, req.apiUser.id);
    const rows = (await db.query(`SELECT id,amount_cny,balance_after_cny,created_at,
      CASE WHEN source IN ('signup_bonus','admin_grant') THEN source ELSE 'recharge' END AS kind
      FROM wallet_entries WHERE user_id=$1 UNION ALL SELECT id,-amount_cny,balance_after_cny,created_at,'consumption' AS kind
      FROM wallet_debits WHERE user_id=$1 ORDER BY created_at DESC,id LIMIT 30`, [req.apiUser.id])).rows;
    return { user: { id: req.apiUser.id, name: req.apiUser.name }, ...balances,
      balance_points: points(balances.balance_cny), frozen_points: points(balances.frozen_cny), available_points: points(balances.available_cny),
      currency: 'CNY', source: account ? 'lanehub' : 'local',
      entries: rows.map(row => ({ ...row, amount_points: points(row.amount_cny), balance_after_points: points(row.balance_after_cny) })) };
  });
}
