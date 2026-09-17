import { httpError } from './security.mjs';

export const ROLES = ['admin', 'operator', 'viewer'];
const ADMIN_SESSION_MAX_MS = 12 * 3600_000;
// ponytail: per-process 30s cache; a grant/revoke in another process (none today, single gateway) waits up to 30s.
const cache = new Map();

export async function loadRoles(db, userId) {
  const hit = cache.get(userId);
  if (hit && hit.until > Date.now()) return hit.roles;
  const roles = (await db.query('SELECT role FROM user_roles WHERE user_id=$1 ORDER BY role', [userId])).rows.map(r => r.role);
  if (cache.size > 10_000) cache.clear();
  cache.set(userId, { roles, until: Date.now() + 30_000 });
  return roles;
}

// Server-side role gate for customer (better-auth) sessions. Every role here is an admin role,
// so the session must also be younger than 12h even though customer sessions last 7 days.
export async function requireRole(req, ...roles) {
  const user = req.apiUser;
  if (!user?.session_id) throw httpError(401, 'customer_login_required');
  const granted = await loadRoles(req.server.roleDb, user.id);
  if (!roles.some(role => granted.includes(role))) throw httpError(403, 'forbidden_role');
  const created = Date.parse(user.session_created_at);
  if (!Number.isFinite(created) || Date.now() - created > ADMIN_SESSION_MAX_MS) throw httpError(401, 'admin_session_expired');
  return granted;
}

async function audit(db, action, userId, role, actor) {
  await db.query('INSERT INTO audit_events(action,target_id,details,actor_user_id) VALUES($1,$2,$3,$4)',
    [action, userId, JSON.stringify({ role }), actor ?? null]);
}

// Idempotent: returns false (and writes no audit row) when the role was already held.
export async function grantRole(db, userId, role, grantedBy = null) {
  if (!ROLES.includes(role)) throw httpError(400, 'invalid_role');
  const changed = await db.tx(async c => {
    const r = await c.query('INSERT INTO user_roles(user_id,role,granted_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [userId, role, grantedBy]);
    if (r.rowCount) await audit(c, 'role.grant', userId, role, grantedBy);
    return r.rowCount > 0;
  });
  cache.delete(userId);
  return changed;
}

// Idempotent. Never leaves zero admins: admin rows are locked so two admins revoking each other serialize.
export async function revokeRole(db, userId, role, revokedBy = null) {
  if (!ROLES.includes(role)) throw httpError(400, 'invalid_role');
  if (role === 'admin' && revokedBy && revokedBy === userId) throw httpError(409, 'cannot_revoke_own_admin');
  const changed = await db.tx(async c => {
    if (role === 'admin') {
      const admins = (await c.query("SELECT user_id FROM user_roles WHERE role='admin' FOR UPDATE")).rows;
      if (admins.length <= 1 && admins.some(a => a.user_id === userId)) throw httpError(409, 'last_admin');
    }
    const r = await c.query('DELETE FROM user_roles WHERE user_id=$1 AND role=$2', [userId, role]);
    if (r.rowCount) await audit(c, 'role.revoke', userId, role, revokedBy);
    return r.rowCount > 0;
  });
  cache.delete(userId);
  return changed;
}

export function roleRoutes(app, { db }) {
  app.decorate('roleDb', db);
  app.get('/api/me/roles', async req => ({ roles: await loadRoles(db, req.apiUser.id) }));
}

// 契约登记，见 src/studio.mjs routeMeta。
export const routeMeta = {
  'GET /api/me/roles': { response: 'RolesResponse' },
};
