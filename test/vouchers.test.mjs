import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {database} from '../src/database.mjs';
import {createApp} from '../src/app.mjs';
import {passwordHash} from '../src/security.mjs';
import {voucherVault,normalizeVoucher} from '../src/vouchers.mjs';

test('voucher encryption authenticates ciphertext and its row identity',()=>{
  const vault=voucherVault(randomBytes(32)),code='IPZ'+'A'.repeat(32),sealed=vault.seal(code,'row-a');
  assert.equal(vault.open(sealed,'row-a'),code);assert.ok(!sealed.includes(code));
  assert.throws(()=>vault.open(sealed,'row-b'));assert.throws(()=>voucherVault(randomBytes(32)).open(sealed,'row-a'));
  assert.equal(normalizeVoucher('ipz-aaaaaaaa-aaaaaaaa-aaaaaaaa-aaaaaaaa'),code);
});

test('voucher and wallet lifecycle in an isolated database schema',async(t)=>{
  assert.ok(process.env.TEST_DB_HOST);
  const schema='voucher_test_'+randomUUID().replaceAll('-','');
  const config={host:process.env.TEST_DB_HOST,database:'gateway_test',user:'gateway',password:process.env.TEST_DB_PASSWORD};
  const setup=database(config);await setup.query(`CREATE SCHEMA ${schema}`);
  const db=database({...config,options:`-c search_path=${schema}`});let app,cookie='';
  try{
    await db.migrate();await db.query('INSERT INTO administrators(id,password_hash) VALUES(1,$1)',[await passwordHash('voucher-admin-test-password')]);
    app=await createApp({db,voucherKey:randomBytes(32),upstream:{},scheduler:{keys:new Map(),accounts:new Map()},origin:'https://api.ipzsk.com',secureCookies:true});
    const admin=(path,method='GET',payload)=>app.inject({url:'/admin/api'+path,method,payload,headers:{origin:'https://api.ipzsk.com',cookie}});
    const own=(who,path,body)=>app.inject({url:'/api/me/'+path,method:body?'POST':'GET',payload:body,headers:{authorization:'Bearer '+who.token}});
    const redeem=(who,code,extra={})=>own(who,'vouchers/redeem',{code,...extra});
    cookie=(await admin('/login','POST',{password:'voucher-admin-test-password'})).headers['set-cookie'].split(';')[0];
    const alice=(await admin('/users','POST',{name:'Voucher Alice',rpm:100})).json();
    const bob=(await admin('/users','POST',{name:'Voucher Bob',rpm:100})).json();
    const batches=[];let codes=[];
    await t.test('generation is authenticated, bounded and idempotent across retries',async()=>{
      assert.equal((await app.inject('/admin/api/vouchers/batches')).statusCode,401);
      assert.equal((await app.inject({url:'/admin/api/vouchers/batches',method:'POST',payload:{}})).statusCode,403);
      const invalid=await admin('/vouchers/batches','POST',{id:randomUUID(),name:'bad',amount_cny:20,quantity:1});assert.equal(invalid.statusCode,400);
      for(const amount of [10,50,100]){
        const b={id:randomUUID(),name:`Test ${amount}`,amount_cny:amount,quantity:amount===10?8:2};batches.push(b);
        assert.equal((await admin('/vouchers/batches','POST',b)).statusCode,200);
      }
      assert.equal((await admin('/vouchers/batches','POST',batches[0])).json().replayed,true);
      assert.equal((await admin('/vouchers/batches','POST',{...batches[0],quantity:3})).statusCode,409);
      assert.equal((await db.query('SELECT count(*) FROM voucher_codes')).rows[0].count,'12');
      const meta=(await admin('/vouchers/codes')).body;assert.ok(!meta.includes('ciphertext'));assert.ok(!meta.includes('code_hash'));
    });
    await t.test('export audits access and allocation cannot move to a second channel',async()=>{
      assert.equal((await admin('/vouchers/batches/'+batches[0].id+'/assign','POST',{channel:'Store A'})).statusCode,409);
      const exported=await admin('/vouchers/batches/'+batches[0].id+'/export','POST',{format:'txt'});assert.equal(exported.statusCode,200,exported.body);
      codes=exported.body.trim().split(/\r?\n/);assert.equal(codes.length,8);
      assert.equal((await redeem(bob,codes[0])).statusCode,400);
      const csv=await admin('/vouchers/batches/'+batches[0].id+'/export','POST',{format:'csv'});assert.ok(csv.body.includes(codes[0]));assert.match(csv.body,/amount_cny/);
      const row=(await db.query('SELECT ciphertext FROM voucher_codes LIMIT 1')).rows[0];assert.ok(!row.ciphertext.includes(normalizeVoucher(codes[0])));
      const audit=(await db.query("SELECT details FROM audit_events WHERE action='voucher.batch.export'")).rows;assert.equal(audit.length,2);assert.ok(!JSON.stringify(audit).includes(codes[0]));
      assert.equal((await admin('/vouchers/batches/'+batches[0].id+'/assign','POST',{channel:'Store A'})).statusCode,200);
      assert.equal((await admin('/vouchers/batches/'+batches[0].id+'/assign','POST',{channel:'Store B'})).statusCode,409);
    });
    await t.test('concurrent redemption credits exactly one user once, ignoring client amount and identity',async()=>{
      const race=await Promise.all([redeem(alice,codes[0],{amount_cny:10000,user_id:bob.id}),redeem(bob,codes[0])]);
      assert.deepEqual(race.map(x=>x.statusCode).sort(),[200,400]);
      const winner=race[0].statusCode===200?alice:bob;
      const repeat=await redeem(winner,codes[0]);assert.equal(repeat.statusCode,200);assert.equal(repeat.json().replayed,true);
      assert.equal(Number(repeat.json().amount_cny),10);
      // 官网只认「点」：10 元 = 1,000 点。这几个字段缺一个，页面就只剩「点数暂时无法读取」。
      assert.equal(repeat.json().amount_points,'1000.00');
      assert.equal((await db.query('SELECT count(*) FROM wallet_entries')).rows[0].count,'1');
      const wallet=(await own(alice,'wallet')).json();assert.equal(wallet.user.id,alice.id);assert.equal(wallet.user.name,'Voucher Alice');
      assert.equal(wallet.available_points,(Number(wallet.available_cny)*100).toFixed(2));
      assert.equal(typeof wallet.frozen_points,'string');
      const before=Number(wallet.balance_cny);
      const two=await Promise.all([redeem(alice,codes[1]),redeem(alice,codes[2])]);assert.ok(two.every(r=>r.statusCode===200));
      assert.equal(Number((await own(alice,'wallet?user_id='+bob.id)).json().balance_cny),before+20);
      const detail=(await admin('/vouchers/codes?batch_id='+batches[0].id+'&state=redeemed')).json();assert.equal(detail.count,3);assert.ok(detail.rows.every(r=>r.ledger_id&&r.user_name));
      const sums=(await db.query('SELECT user_id,sum(amount_cny) AS balance FROM wallet_entries GROUP BY user_id')).rows;
      assert.equal(sums.reduce((a,r)=>a+Number(r.balance),0),30);
    });
    await t.test('audit failure rolls back both redemption state and money',async()=>{
      await db.query(`CREATE FUNCTION reject_voucher_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='voucher.redeem' THEN RAISE EXCEPTION 'test rollback'; END IF; RETURN NEW; END $$`);
      await db.query('CREATE TRIGGER reject_voucher_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_voucher_audit()');
      const before=(await db.query('SELECT count(*) FROM wallet_entries')).rows[0].count;
      assert.equal((await redeem(bob,codes[3])).statusCode,500);
      assert.equal((await db.query('SELECT count(*) FROM wallet_entries')).rows[0].count,before);
      await db.query('DROP TRIGGER reject_voucher_audit ON audit_events');
      assert.equal((await redeem(bob,codes[3])).statusCode,200);
    });
    await t.test('revocation preserves redeemed funds and expired codes cannot credit wallets',async()=>{
      const unused=(await admin('/vouchers/codes?batch_id='+batches[0].id+'&state=unused')).json().rows;
      assert.equal((await admin('/vouchers/codes/'+unused[0].id+'/revoke','POST',{reason:'Test withdrawal'})).statusCode,200);
      assert.equal((await admin('/vouchers/batches/'+batches[0].id+'/revoke','POST',{reason:'Test batch withdrawal'})).statusCode,200);
      assert.equal((await redeem(alice,codes[7])).statusCode,400);
      const records=(await db.query('SELECT count(*) FROM wallet_entries')).rows[0].count;assert.equal(records,'4');
      const expBatch=batches[1];const expCode=(await admin('/vouchers/batches/'+expBatch.id+'/export','POST',{format:'txt'})).body.trim().split(/\r?\n/)[0];
      await admin('/vouchers/batches/'+expBatch.id+'/assign','POST',{channel:'Test expiry'});
      await db.query("UPDATE voucher_batches SET expires_at=now()-interval '1 second' WHERE id=$1",[expBatch.id]);
      assert.equal((await redeem(bob,expCode)).statusCode,400);
      assert.equal((await admin('/vouchers/batches/'+expBatch.id+'/export','POST',{format:'txt'})).statusCode,409);
      const summary=(await admin('/vouchers/summary')).json().rows;assert.equal(summary.find(r=>Number(r.amount_cny)===50).expired,'2');
      await admin('/users/'+bob.id,'PATCH',{enabled:false});assert.equal((await own(bob,'wallet')).statusCode,401);
      await db.migrate();assert.equal((await admin('/wallet/entries')).json().count,4);
    });
  }finally{await app?.close();await db.close();await setup.query(`DROP SCHEMA ${schema} CASCADE`);await setup.close();}
});
