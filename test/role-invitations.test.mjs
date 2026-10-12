import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { database } from '../src/database.mjs';
import { createApp } from '../src/app.mjs';
import { passwordHash, hash, httpError } from '../src/security.mjs';

test('BD and developer identities only come from a bound, single-use administrator invitation', async t => {
  assert.ok(process.env.TEST_DB_HOST, 'TEST_DB_HOST must select the isolated gateway_test database');
  const config = { host: process.env.TEST_DB_HOST, port: Number(process.env.TEST_DB_PORT ?? 5432), database: 'gateway_test', user: 'gateway', password: process.env.TEST_DB_PASSWORD };
  const setup = database(config), schema = 'invitations_' + randomUUID().replaceAll('-', '');
  await setup.query(`CREATE SCHEMA ${schema}`);
  const db = database({ ...config, options: `-c search_path=${schema}` });
  const target = randomUUID(), other = randomUUID(), racer = randomUUID(), manual = randomUUID(), unverified = randomUUID();
  let app;
  try {
    await db.migrate(); await db.migrate();
    assert.equal((await db.query('SELECT 1 FROM schema_version WHERE version=33')).rowCount, 1);
    for (const [id, email, verified, auth] of [[target, 'Mixed.Case@Example.com', true, true], [other, 'other@example.com', true, true],
      [racer, 'racer@example.com', true, true], [manual, null, false, false], [unverified, 'new@example.com', false, true]])
      await db.query('INSERT INTO users(id,name,email,email_verified,auth_user_id) VALUES($1,$2,$3,$4,$5)', [id, 'User ' + id.slice(0, 4), email, verified, auth ? 'auth-' + id : null]);
    for (const [id, role] of [[1, 'superadmin'], [2, 'operator']])
      await db.query('INSERT INTO administrators(id,username,role,password_hash) VALUES($1,$2,$3,$4)', [id, role, role, await passwordHash('fixture-role-password')]);
    app = await createApp({ db, upstream: {}, scheduler: { keys: new Map(), accounts: new Map() }, origin: 'https://api.ipzsk.com', secureCookies: true,
      customerAuth: { async identify(headers) {
        const id = headers.cookie?.replace('fixture=', '');
        if (![target, other, racer].includes(id)) throw httpError(401, 'customer_login_required');
        return { id, session_id: 'fixture-session' };
      } } });
    const cookies = {};
    for (const role of ['superadmin', 'operator']) {
      const r = await app.inject({ url: '/admin/api/login', method: 'POST', payload: { username: role, password: 'fixture-role-password' }, headers: { origin: 'https://api.ipzsk.com' } });
      cookies[role] = [].concat(r.headers['set-cookie']).map(v => v.split(';')[0]).join('; ');
    }
    const admin = (path, payload, role = 'superadmin') => app.inject({ url: '/admin/api/commissions' + path, method: payload ? 'POST' : 'GET', payload, headers: { cookie: cookies[role], origin: 'https://api.ipzsk.com' } });
    const me = (user, path, payload) => app.inject({ url: '/api/me' + path, method: payload ? 'POST' : 'GET', payload, headers: { cookie: 'fixture=' + user, origin: 'https://www.ipzsk.com' } });
    const secretOf = response => new URL(response.json().invitation_url).hash.slice('#invite='.length);
    const accept = (user, token) => me(user, '/role-invitations/accept', { token });
    const code = response => response.json().error?.code;
    const tokens = {};

    await t.test('superadmin invites by case-insensitive email or user ID; the plaintext token exists only in the response', async () => {
      assert.equal((await admin('/invitations', { role: 'bd', target: 'mixed.case@example.com', reason: 'operator attempt' }, 'operator')).statusCode, 403);
      const bd = await admin('/invitations', { role: 'bd', target: '  MIXED.case@example.COM ', reason: 'invite fixture BD' });
      assert.equal(bd.statusCode, 200, bd.body);
      assert.equal(bd.json().invitation.email, 'mixed.case@example.com');
      assert.match(bd.json().invitation_url, /^https:\/\/www\.ipzsk\.com\/account#invite=[A-Za-z0-9_-]{43}$/);
      tokens.bd = secretOf(bd);
      const stored = (await db.query('SELECT row_to_json(i)::text AS row,token_hash FROM role_invitations i')).rows[0];
      assert.equal(stored.token_hash, hash(tokens.bd));
      assert.ok(!stored.row.includes(tokens.bd));
      const list = await admin('/invitations');
      assert.equal(list.json().rows[0].state, 'pending');
      assert.doesNotMatch(list.body, new RegExp(tokens.bd + '|token'));
      assert.doesNotMatch((await db.query("SELECT coalesce(string_agg(details::text,''),'') AS d FROM audit_events")).rows[0].d, new RegExp(tokens.bd));
      assert.equal(code(await admin('/invitations', { role: 'bd', target: target, reason: 'duplicate pending' })), 'invitation_already_pending');
      const dev = await admin('/invitations', { role: 'developer', target: target.toUpperCase(), reason: 'invite fixture developer' });
      assert.equal(dev.statusCode, 200, dev.body);
      tokens.dev = secretOf(dev);
      for (const [body, expected] of [[{ role: 'bd', target: manual, reason: 'no website login' }, 'invitation_target_not_found'],
        [{ role: 'bd', target: 'new@example.com', reason: 'email not verified' }, 'invitation_target_not_found'],
        [{ role: 'admin', target: other, reason: 'invalid role' }, 'invalid_invitation_role'],
        [{ role: 'bd', target: 'not-an-email', reason: 'invalid target' }, 'invalid_invitation_target'],
        [{ role: 'bd', target: other, reason: 'no' }, 'invalid_reason']])
        assert.equal(code(await admin('/invitations', body)), expected);
      assert.equal((await db.query("SELECT count(*) FROM audit_events WHERE action='role_invitation.create'")).rows[0].count, '2');
    });

    await t.test('only the bound account can accept, exactly once, and acceptance activates BD with an audit row', async () => {
      assert.equal(code(await accept(other, tokens.bd)), 'invitation_account_mismatch');
      assert.equal(code(await accept(target, 'short')), 'invalid_invitation_token');
      assert.equal(code(await accept(target, 'a'.repeat(43))), 'invitation_not_found');
      assert.equal((await app.inject({ url: '/api/me/role-invitations/accept', method: 'POST', payload: { token: tokens.bd }, headers: { cookie: 'fixture=' + target, origin: 'https://evil.example' } })).statusCode, 403);
      assert.equal((await db.query('SELECT 1 FROM referral_profiles WHERE user_id=$1 AND bd_active', [target])).rowCount, 0);
      const ok = await accept(target, tokens.bd);
      assert.deepEqual(ok.json(), { role: 'bd', state: 'accepted' });
      assert.equal((await db.query('SELECT 1 FROM referral_profiles WHERE user_id=$1 AND bd_active', [target])).rowCount, 1);
      assert.equal(code(await accept(target, tokens.bd)), 'invitation_already_used');
      assert.equal(code(await admin('/invitations', { role: 'bd', target, reason: 'already a BD' })), 'role_already_active');
      const audit = (await db.query("SELECT actor_user_id,details FROM audit_events WHERE action='role_invitation.accept'")).rows;
      assert.equal(audit.length, 1);
      assert.equal(audit[0].actor_user_id, target);
      assert.equal(audit[0].details.role, 'bd');
      const mine = (await me(target, '/commissions')).json();
      assert.equal(mine.profile.bd_active, true);
      assert.equal(mine.developer, null);
    });

    await t.test('revoked and expired links stop working; resend issues a fresh link bound to the same account', async () => {
      const devId = (await db.query("SELECT id FROM role_invitations WHERE role='developer' AND user_id=$1", [target])).rows[0].id;
      assert.equal((await admin('/invitations/' + devId + '/revoke', { reason: 'revoke fixture' })).statusCode, 200);
      assert.equal(code(await accept(target, tokens.dev)), 'invitation_revoked');
      assert.equal(code(await admin('/invitations/' + devId + '/revoke', { reason: 'revoke twice' })), 'invitation_not_pending');
      const resent = await admin('/invitations/' + devId + '/resend', { reason: 'resend fixture' });
      assert.equal(resent.statusCode, 200, resent.body);
      assert.equal(resent.json().invitation.previous_id, devId);
      assert.equal(code(await accept(target, tokens.dev)), 'invitation_revoked', 'the old link stays dead');
      // Expire the fresh link, then resend it: the old row materialises as expired and the new one works.
      await db.query("UPDATE role_invitations SET created_at=now()-interval '8 days',expires_at=now()-interval '1 day' WHERE id=$1", [resent.json().invitation.id]);
      assert.equal(code(await accept(target, secretOf(resent))), 'invitation_expired');
      assert.equal((await admin('/invitations')).json().rows.find(row => row.id === resent.json().invitation.id).state, 'expired');
      const fresh = await admin('/invitations/' + resent.json().invitation.id + '/resend', { reason: 'resend after expiry' });
      assert.equal(fresh.statusCode, 200, fresh.body);
      assert.equal((await db.query('SELECT state FROM role_invitations WHERE id=$1', [resent.json().invitation.id])).rows[0].state, 'expired');
      assert.equal((await accept(target, secretOf(fresh))).statusCode, 200);
      const profile = (await db.query('SELECT state,display_name,reviewed_by FROM developer_profiles WHERE user_id=$1', [target])).rows[0];
      assert.deepEqual(profile, { state: 'approved', display_name: 'User ' + target.slice(0, 4), reviewed_by: 1 });
      assert.equal(code(await admin('/invitations/' + fresh.json().invitation.id + '/resend', { reason: 'resend accepted' })), 'invitation_already_used');
      assert.equal((await me(target, '/commissions')).json().developer.state, 'approved');
    });

    await t.test('accept races against revoke and against itself: exactly one outcome is committed', async () => {
      const first = await admin('/invitations', { role: 'bd', target: racer, reason: 'race fixture' });
      const [accepted, revoked] = await Promise.all([accept(racer, secretOf(first)), admin('/invitations/' + first.json().invitation.id + '/revoke', { reason: 'race revoke' })]);
      assert.equal([accepted.statusCode, revoked.statusCode].filter(s => s === 200).length, 1, accepted.body + revoked.body);
      const state = (await db.query('SELECT state FROM role_invitations WHERE id=$1', [first.json().invitation.id])).rows[0].state;
      const active = (await db.query('SELECT 1 FROM referral_profiles WHERE user_id=$1 AND bd_active', [racer])).rowCount === 1;
      assert.equal(active, state === 'accepted');
      const second = await admin('/invitations', { role: 'developer', target: racer, reason: 'double accept fixture' });
      const both = await Promise.all([accept(racer, secretOf(second)), accept(racer, secretOf(second))]);
      assert.deepEqual(both.map(r => r.statusCode).sort(), [200, 409]);
    });

    await t.test('BD cannot be granted directly by user ID, and each account sees only its own earnings and invitations', async () => {
      assert.equal(code(await admin('/profiles/' + other, { bd_active: true, frozen: false, reason: 'direct grant attempt' })), 'bd_invitation_required');
      assert.equal(code(await admin('/profiles/' + randomUUID(), { bd_active: false, frozen: true, reason: 'unknown user' })), 'user_not_found');
      assert.equal((await db.query('SELECT 1 FROM referral_profiles WHERE user_id=$1 AND bd_active', [other])).rowCount, 0);
      assert.equal((await admin('/profiles/' + target, { bd_active: false, frozen: false, reason: 'end BD for fixture' })).statusCode, 200);
      assert.equal((await admin('/invitations', { role: 'bd', target: other, reason: 'invite other as BD' })).statusCode, 200);
      await db.query(`INSERT INTO commission_ledger(user_id,kind,amount_cny,available_at,reference) VALUES
        ($1,'invitation',5,now(),'fixture-target'),($2,'invitation',7,now(),'fixture-other')`, [target, other]);
      const mine = (await me(target, '/commissions')).json();
      assert.deepEqual(mine.ledger.map(row => row.amount_cny), ['5.00000000']);
      assert.deepEqual(mine.earned, { invitation: '5.00000000' });
      const pending = (await me(other, '/role-invitations')).json();
      assert.deepEqual(pending.pending.map(row => row.role), ['bd']);
      assert.equal(pending.bd_active, false);
      assert.doesNotMatch(JSON.stringify(pending), /token/);
      assert.deepEqual((await me(target, '/role-invitations')).json().pending, []);
    });
  } finally { await app?.close(); await db.close(); await setup.query(`DROP SCHEMA ${schema} CASCADE`); await setup.close(); }
});
