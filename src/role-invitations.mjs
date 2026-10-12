import { hash, token, httpError, RateLimiter } from './security.mjs';
import { uuid } from './validation.mjs';
import { customerOrigin } from './customer-auth.mjs';
import { login, note, admin, audit } from './commissions.mjs';

// BD and plugin developer identities are granted only when the invited account accepts an administrator invitation.
// The plaintext token exists once, in the create/resend response; the database keeps its SHA-256 only.
// The link carries it in the URL fragment, which browsers never send to a server or a Referer header.
export const INVITATION_DAYS = 7;
const ROLES = ['bd', 'developer'];
const role = value => {
  if (!ROLES.includes(value)) throw httpError(400, 'invalid_invitation_role');
  return value;
};
const displayName = value => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 100) throw httpError(400, 'invalid_display_name');
  return value.trim();
};
// Effective state: a pending row past its expiry is expired even before a write materialises it.
const STATE = "CASE WHEN i.state='pending' AND i.expires_at<=now() THEN 'expired' ELSE i.state END";

async function target(c, value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 254) throw httpError(400, 'invalid_invitation_target');
  const key = value.trim();
  const byId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key);
  if (!byId && !/^[^\s@]+@[^\s@]+$/.test(key)) throw httpError(400, 'invalid_invitation_target');
  // Accepting requires a website login, so the target must be an enabled, verified customer account.
  const row = (await c.query(`SELECT id,name,lower(email) AS email FROM users
    WHERE ${byId ? 'id=$1::uuid' : 'lower(email)=lower($1)'} AND auth_user_id IS NOT NULL AND email_verified AND enabled`,
  [byId ? key.toLowerCase() : key])).rows[0];
  if (!row) throw httpError(404, 'invitation_target_not_found');
  return row;
}

async function holdsRole(c, userId, kind) {
  return kind === 'bd'
    ? (await c.query('SELECT 1 FROM referral_profiles WHERE user_id=$1 AND bd_active', [userId])).rowCount > 0
    : (await c.query("SELECT 1 FROM developer_profiles WHERE user_id=$1 AND state='approved'", [userId])).rowCount > 0;
}

async function issue(c, req, { user, kind, name, reason, previousId = null }) {
  if (await holdsRole(c, user.id, kind)) throw httpError(409, 'role_already_active');
  await c.query("UPDATE role_invitations SET state='expired' WHERE user_id=$1 AND role=$2 AND state='pending' AND expires_at<=now()", [user.id, kind]);
  // A concurrent create for the same user and role loses on role_invitations_one_pending (409 already_exists).
  if ((await c.query("SELECT 1 FROM role_invitations WHERE user_id=$1 AND role=$2 AND state='pending'", [user.id, kind])).rowCount)
    throw httpError(409, 'invitation_already_pending');
  const secret = token();
  const row = (await c.query(`INSERT INTO role_invitations(role,user_id,email,display_name,token_hash,reason,created_by,expires_at,previous_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,now()+make_interval(days=>$8),$9)
    RETURNING id,role,user_id,email,display_name,state,created_at,expires_at,previous_id`,
  [kind, user.id, user.email, name, hash(secret), reason, req.administrator.id, INVITATION_DAYS, previousId])).rows[0];
  await audit(c, req, 'role_invitation.create', row.id, { role: kind, user_id: user.id, email: user.email,
    expires_at: row.expires_at, previous_id: previousId, reason });
  return { invitation: row, invitation_url: `${customerOrigin}/account#invite=${secret}` };
}

export function roleInvitationRoutes(app, { db }) {
  const limiter = new RateLimiter();
  app.get('/admin/api/commissions/invitations', async req => {
    admin(req);
    return { rows: (await db.query(`SELECT i.id,i.role,i.user_id,i.email,i.display_name,${STATE} AS state,i.reason,i.created_at,i.expires_at,
      i.accepted_at,i.revoked_at,i.previous_id,u.name,a.username AS created_by,r.username AS revoked_by
      FROM role_invitations i JOIN users u ON u.id=i.user_id JOIN administrators a ON a.id=i.created_by
      LEFT JOIN administrators r ON r.id=i.revoked_by ORDER BY i.created_at DESC LIMIT 200`)).rows };
  });
  app.post('/admin/api/commissions/invitations', async req => {
    admin(req);
    const kind = role(req.body?.role), reason = note(req.body?.reason), name = displayName(req.body?.display_name);
    return db.tx(async c => issue(c, req, { user: await target(c, req.body?.target), kind, name, reason }));
  });
  app.post('/admin/api/commissions/invitations/:id/revoke', async req => {
    admin(req);
    const id = uuid(req.params.id), reason = note(req.body?.reason);
    return db.tx(async c => {
      const row = (await c.query(`UPDATE role_invitations SET state='revoked',revoked_at=now(),revoked_by=$2
        WHERE id=$1 AND state='pending' RETURNING id,role,user_id`, [id, req.administrator.id])).rows[0];
      if (!row) {
        if (!(await c.query('SELECT 1 FROM role_invitations WHERE id=$1', [id])).rowCount) throw httpError(404, 'invitation_not_found');
        throw httpError(409, 'invitation_not_pending');
      }
      await audit(c, req, 'role_invitation.revoke', id, { role: row.role, user_id: row.user_id, reason });
      return { ok: true };
    });
  });
  // Resending replaces the old link: a still-valid one is revoked, then a fresh token is issued under the same binding.
  app.post('/admin/api/commissions/invitations/:id/resend', async req => {
    admin(req);
    const id = uuid(req.params.id), reason = note(req.body?.reason);
    return db.tx(async c => {
      const old = (await c.query(`SELECT i.*,${STATE} AS effective FROM role_invitations i WHERE id=$1 FOR UPDATE`, [id])).rows[0];
      if (!old) throw httpError(404, 'invitation_not_found');
      if (old.state === 'accepted') throw httpError(409, 'invitation_already_used');
      if (old.effective === 'pending') {
        await c.query("UPDATE role_invitations SET state='revoked',revoked_at=now(),revoked_by=$2 WHERE id=$1", [id, req.administrator.id]);
        await audit(c, req, 'role_invitation.revoke', id, { role: old.role, user_id: old.user_id, reason, resend: true });
      } else if (old.state === 'pending') await c.query("UPDATE role_invitations SET state='expired' WHERE id=$1", [id]);
      return issue(c, req, { user: await target(c, old.user_id), kind: old.role, name: old.display_name, reason, previousId: id });
    });
  });

  app.post('/api/me/role-invitations/accept', async req => {
    const userId = login(req), secret = req.body?.token;
    limiter.take('role-invitation:' + userId, 10, 600_000);
    if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(secret)) throw httpError(400, 'invalid_invitation_token');
    return db.tx(async c => {
      // One conditional UPDATE decides accept vs revoke vs expiry: the row lock serialises them and the loser matches nothing.
      const row = (await c.query(`UPDATE role_invitations SET state='accepted',accepted_at=now()
        WHERE token_hash=$1 AND user_id=$2 AND state='pending' AND expires_at>now()
        RETURNING id,role,user_id,display_name,created_by`, [hash(secret), userId])).rows[0];
      if (!row) {
        const found = (await c.query(`SELECT i.user_id,${STATE} AS state FROM role_invitations i WHERE token_hash=$1`, [hash(secret)])).rows[0];
        if (!found) throw httpError(404, 'invitation_not_found');
        if (found.user_id !== userId) throw httpError(403, 'invitation_account_mismatch');
        if (found.state === 'accepted') throw httpError(409, 'invitation_already_used');
        if (found.state === 'revoked') throw httpError(410, 'invitation_revoked');
        throw httpError(410, 'invitation_expired');
      }
      let previous;
      if (row.role === 'bd') {
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,1))', [userId]);
        previous = (await c.query('SELECT bd_active,frozen FROM referral_profiles WHERE user_id=$1', [userId])).rows[0] ?? null;
        await c.query(`INSERT INTO referral_profiles(user_id,bd_active) VALUES($1,true)
          ON CONFLICT(user_id) DO UPDATE SET bd_active=true`, [userId]);
      } else {
        previous = (await c.query('SELECT state,display_name FROM developer_profiles WHERE user_id=$1 FOR UPDATE', [userId])).rows[0] ?? null;
        // An existing profile keeps its display name (plugins snapshot it) unless the administrator set one on the invitation.
        await c.query(`INSERT INTO developer_profiles(user_id,display_name,state,reviewed_by,reviewed_at)
          VALUES($1,coalesce($2,(SELECT name FROM users WHERE id=$1)),'approved',$3,now())
          ON CONFLICT(user_id) DO UPDATE SET state='approved',review_note='',display_name=coalesce($2,developer_profiles.display_name),
            reviewed_by=EXCLUDED.reviewed_by,reviewed_at=now()`, [userId, row.display_name, row.created_by]);
      }
      await audit(c, req, 'role_invitation.accept', row.id, { role: row.role, user_id: userId, invited_by: row.created_by, previous });
      return { role: row.role, state: 'accepted' };
    });
  });
  app.get('/api/me/role-invitations', async req => {
    const userId = login(req);
    return {
      bd_active: (await db.query('SELECT 1 FROM referral_profiles WHERE user_id=$1 AND bd_active', [userId])).rowCount > 0,
      developer_state: (await db.query('SELECT state FROM developer_profiles WHERE user_id=$1', [userId])).rows[0]?.state ?? null,
      pending: (await db.query(`SELECT id,role,created_at,expires_at FROM role_invitations
        WHERE user_id=$1 AND state='pending' AND expires_at>now() ORDER BY created_at DESC`, [userId])).rows,
    };
  });
}

// 契约登记，见 src/studio.mjs routeMeta。
export const routeMeta = {
  'POST /api/me/role-invitations/accept': { body: 'RoleInvitationAccept', response: 'RoleInvitationAccepted' },
  'GET /api/me/role-invitations': { response: 'MyRoleInvitations' },
};
