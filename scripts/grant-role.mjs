// Usage: DATABASE_URL=postgres://... node scripts/grant-role.mjs <email> <admin|operator|viewer> [--revoke]
// Deliberately requires an explicit DATABASE_URL: no fallback to the production container defaults.
import { database } from '../src/database.mjs';
import { grantRole, revokeRole, ROLES } from '../src/roles.mjs';

const [email, role, flag] = process.argv.slice(2);
if (!process.env.DATABASE_URL || !email || !ROLES.includes(role) || (flag && flag !== '--revoke')) {
  console.error('usage: DATABASE_URL=... node scripts/grant-role.mjs <email> <admin|operator|viewer> [--revoke]');
  process.exit(2);
}
const db = database({ connectionString: process.env.DATABASE_URL });
try {
  const users = (await db.query('SELECT id FROM users WHERE lower(email)=lower($1)', [email])).rows;
  if (users.length !== 1) { console.error(users.length ? 'email_ambiguous' : 'user_not_found'); process.exitCode = 1; }
  else {
    await (flag ? revokeRole : grantRole)(db, users[0].id, role);
    console.log(`${flag ? 'revoked' : 'granted'} ${role}`);
  }
} finally { await db.close(); }
