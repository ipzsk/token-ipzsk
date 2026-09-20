import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { database } from '../src/database.mjs';
import { createApp } from '../src/app.mjs';
import { hash, httpError } from '../src/security.mjs';

test('wallet survives retirement of all code routes and preserves historical credits', async t => {
  assert.ok(process.env.TEST_DB_HOST);
  const config = { host: process.env.TEST_DB_HOST, port: Number(process.env.TEST_DB_PORT || 5432),
    database: 'gateway_test', user: 'gateway', password: process.env.TEST_DB_PASSWORD };
  const setup = database(config), schema = 'wallet_' + randomUUID().replaceAll('-', '');
  await setup.query(`CREATE SCHEMA ${schema}`);
  const db = database({ ...config, options: `-c search_path=${schema}` });
  const alice = randomUUID(), bob = randomUUID(), batch = randomUUID(), code = randomUUID();
  const registered = [];
  let app;
  try {
    await db.migrate();
    await db.query("INSERT INTO users(id,name,email_verified) VALUES($1,'Alice',true),($2,'Bob',true)", [alice,bob]);
    // Historical fixture only: application code no longer issues or redeems codes.
    await db.query("INSERT INTO voucher_batches(id,name,amount_cny,quantity) VALUES($1,'Historical fixture',10,1)", [batch]);
    await db.query("INSERT INTO voucher_codes(id,batch_id,code_hash,code_suffix,ciphertext,state,redeemed_by,redeemed_at) VALUES($1,$2,'fixture','fixture','fixture','redeemed',$3,now())", [code,batch,alice]);
    await db.query("INSERT INTO wallet_entries(id,user_id,voucher_id,amount_cny,balance_after_cny,source) VALUES($1,$2,$3,10,10,'voucher')", [randomUUID(),alice,code]);
    await db.query("INSERT INTO wallet_entries(id,user_id,amount_cny,balance_after_cny,source) VALUES($1,$2,5,15,'signup_bonus')", [randomUUID(),alice]);
    await db.migrate();
    await db.query("INSERT INTO administrators(id,password_hash) VALUES(1,'fixture')");
    await db.query("INSERT INTO admin_sessions(token_hash,expires_at,administrator_id) VALUES($1,now()+interval '1 hour',1)", [hash('wallet-fixture')]);
    const customerAuth = { identify: async headers => {
      if (!['alice','bob'].includes(headers.cookie)) throw httpError(401,'customer_login_required');
      return { id: headers.cookie === 'alice' ? alice : bob, name: headers.cookie, session_id: randomUUID() };
    } };
    app = await createApp({ db, customerAuth, upstream: {}, scheduler: {}, origin: 'https://api.ipzsk.com',
      onRoute: route => registered.push(route.url) });
    await t.test('own balance, points and history remain intact; another user cannot select the owner', async () => {
      const result = await app.inject({ url:'/api/me/wallet', headers:{cookie:'alice'} });
      assert.equal(result.statusCode,200,result.body);
      assert.equal(result.json().balance_cny,'15.00000000');
      assert.equal(result.json().balance_points,'1500.00');
      assert.deepEqual(result.json().entries.map(e => e.kind).sort(),['recharge','signup_bonus']);
      const other = await app.inject({url:'/api/me/wallet?user_id='+alice,headers:{cookie:'bob'}});
      assert.equal(other.json().user.id,bob); assert.equal(Number(other.json().balance_cny),0);
      assert.equal((await app.inject({url:'/api/me/wallet'})).statusCode,401);
    });
    await t.test('admin retains the read-only ledger without code inventory fields', async () => {
      const result = await app.inject({url:'/admin/api/wallet/entries',headers:{cookie:'gateway_session=wallet-fixture'}});
      assert.equal(result.statusCode,200,result.body); assert.equal(result.json().count,2);
      assert.ok(result.json().rows.every(row => !('voucher_id' in row) && !('code_suffix' in row)));
    });
    await t.test('code pages, issuance, export, assignment, revocation and redemption no longer exist', async () => {
      assert.ok(!registered.some(url => /voucher|redeem/.test(url)));
      for (const [method,url] of [
        ['GET','/redeem'],['GET','/redeem.js'],['GET','/admin/vouchers.js'],
        ['GET','/admin/api/vouchers/summary'],['GET','/admin/api/vouchers/batches'],['GET','/admin/api/vouchers/codes'],
        ['POST','/admin/api/vouchers/batches'],['POST',`/admin/api/vouchers/batches/${batch}/export`],
        ['POST',`/admin/api/vouchers/batches/${batch}/assign`],['POST',`/admin/api/vouchers/batches/${batch}/revoke`],
        ['POST',`/admin/api/vouchers/codes/${code}/revoke`],['POST','/api/me/vouchers/redeem'],
      ]) {
        const result = await app.inject({method,url,headers:{origin:'https://api.ipzsk.com',cookie:url.startsWith('/admin/')?'gateway_session=wallet-fixture':'alice'},
          ...(method==='POST'?{payload:{code:'obsolete'}}:{})});
        assert.equal(result.statusCode,404,method+' '+url+' '+result.body);
      }
      assert.equal((await db.query('SELECT count(*) FROM wallet_entries')).rows[0].count,'2');
    });
  } finally {
    await app?.close(); await db.close();
    await setup.query(`DROP SCHEMA ${schema} CASCADE`); await setup.close();
  }
});
