import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { database } from '../src/database.mjs';
import { createApp } from '../src/app.mjs';
import { receivePayment, deliverPayments } from '../src/payments.mjs';
import { PAYMENT_PACKS } from '../src/waffo.mjs';

test('payment ownership, verification, durable delivery, retries and test isolation in gateway_test', async t => {
  assert.equal(process.env.TEST_DB_HOST, '127.0.0.1', 'Use the isolated local gateway_test database.');
  const config={host:process.env.TEST_DB_HOST,port:Number(process.env.TEST_DB_PORT),database:'gateway_test',user:'gateway',password:process.env.TEST_DB_PASSWORD};
  const setup=database(config),schema='payments_'+randomUUID().replaceAll('-','');
  await setup.query(`CREATE SCHEMA ${schema}`);
  const db=database({...config,options:`-c search_path=${schema}`});
  let app,calls=0,remoteReads=0,checkoutInput;
  const alice=randomUUID(),bob=randomUUID(),remoteOrders=new Map();
  const provider={mode:'prod',storeId:'STO_test',products:PAYMENT_PACKS.map(p=>({...p,productId:'PROD_'+p.key.replaceAll('_','')})),
    verify:(raw,sig)=>{if(sig!=='valid')throw new Error('invalid');return JSON.parse(raw);},
    createCheckout:async input=>{checkoutInput=input;calls++;return {sessionId:'session_'+calls,checkoutUrl:'https://pancake.waffo.ai/store/ipzsk/checkout/'+calls+'#token=test-token'};},
    readOrder:async id=>{remoteReads++;return remoteOrders.get(id);},
  };
  const makeOrder=async({mode='prod',target='local',owner=alice,amount=10}={})=>{
    const id=randomUUID(),pack=provider.products.find(p=>Number(p.amount_cny)===amount);
    await db.query(`INSERT INTO payment_orders(id,user_id,mode,pack_key,product_id,amount_cny,currency,idempotency_key,target,lanehub_user_id,quota)
      VALUES($1,$2,$3,$4,$5,$6,'CNY',$7,$8,$9,$10)`,[id,owner,mode,pack.key,pack.productId,pack.amount_cny,randomUUID(),target,target==='lanehub'?42:null,target==='lanehub'?500000:null]);
    return (await db.query('SELECT * FROM payment_orders WHERE id=$1',[id])).rows[0];
  };
  const eventFor=(row,type='order.completed')=>{
    const orderId='ORDER_'+row.id;
    const event={id:randomUUID(),eventId:randomUUID(),mode:row.mode,storeId:provider.storeId,eventType:type,
      data:{orderId,orderMerchantExternalId:row.id,merchantProvidedBuyerIdentity:row.user_id,
        orderStatus:'completed',paymentStatus:'succeeded',currency:'CNY',amount:row.amount_cny,total:row.amount_cny}};
    remoteOrders.set(orderId,{id:orderId,status:'completed',testMode:row.mode==='test',orderMerchantExternalId:row.id,
      merchantProvidedBuyerIdentity:row.user_id,store:{id:provider.storeId},onetimeProduct:{id:row.product_id},priceSnapshot:{currency:'CNY',subtotal:row.amount_cny,total:row.amount_cny}});
    return event;
  };
  const receive=(e,p=provider)=>receivePayment(db,p,JSON.stringify(e),'valid');
  const state=async id=>(await db.query('SELECT state FROM payment_orders WHERE id=$1',[id])).rows[0].state;
  const count=async id=>Number((await db.query('SELECT count(*) AS n FROM wallet_entries WHERE payment_order_id=$1',[id])).rows[0].n);
  try {
    await db.migrate(); await db.migrate();
    await db.query("INSERT INTO users(id,name,email,email_verified) VALUES($1,'Alice','alice@example.test',true),($2,'Bob','bob@example.test',true)",[alice,bob]);
    const customerAuth={identify:async headers=>{
      const user=(await db.query('SELECT * FROM users WHERE id=$1',[headers.cookie==='bob'?bob:alice])).rows[0];
      return {...user,session_id:randomUUID()};
    }};
    app=await createApp({db,waffo:provider,customerAuth,upstream:{},scheduler:{keys:new Map(),accounts:new Map()},origin:'https://api.ipzsk.com'});
    const checkout=(body,key=randomUUID(),cookie='alice')=>app.inject({method:'POST',url:'/api/me/payments/checkout',payload:body,
      headers:{origin:'https://www.ipzsk.com',cookie,'idempotency-key':key}});
    await t.test('checkout takes identity and price from the server and rejects invalid packs and repeated submissions',async()=>{
      const key=randomUUID();
      const r=await checkout({pack:'cny_10',user_id:bob,amount_cny:10000,buyerEmail:'other@example.test',billingDetail:{country:'US'},includePaymentMethods:['alipay']},key);assert.equal(r.statusCode,200,r.body);
      assert.equal(checkoutInput.buyerIdentity,alice);assert.equal(checkoutInput.productId,provider.products[0].productId);
      assert.equal(checkoutInput.buyerEmail,'alice@example.test');
      assert.deepEqual(checkoutInput.billingDetail,{country:'CN',isBusiness:false});
      assert.equal(checkoutInput.language,'zh-Hans');
      assert.equal(checkoutInput.successUrl,'https://www.ipzsk.com/?payment=return#wallet');
      assert.equal(checkoutInput.includePaymentMethods,undefined);
      assert.equal(checkoutInput.priceSnapshot,undefined);
      assert.equal((await checkout({pack:'cny_10'},key)).statusCode,409);assert.equal(calls,1);
      assert.equal((await checkout({pack:'cny_999'})).statusCode,400);
      const order=(await db.query('SELECT * FROM payment_orders WHERE id=$1',[r.json().order_id])).rows[0];
      assert.equal(Number(order.amount_cny),10);assert.equal(order.user_id,alice);
      const own=await app.inject({url:'/api/me/payments/orders',headers:{cookie:'bob'}});
      assert.equal(own.json().rows.length,0);
      assert.ok(!JSON.stringify(order).includes('test-token'));
    });
    await t.test('missing checkout email cannot create an order or invoke the provider',async()=>{
      const before=calls;
      await db.query('UPDATE users SET email=NULL WHERE id=$1',[bob]);
      try {
        const r=await checkout({pack:'cny_10',buyerEmail:'spoof@example.test'},randomUUID(),'bob');
        assert.equal(r.statusCode,409);assert.match(r.body,/payment_email_unavailable/);
        assert.equal(calls,before);
        assert.equal((await db.query('SELECT id FROM payment_orders WHERE user_id=$1',[bob])).rowCount,0);
      } finally { await db.query("UPDATE users SET email='bob@example.test' WHERE id=$1",[bob]); }
    });
    await t.test('failed signature, wrong owner/product/currency, and cross-environment events cannot pay orders',async()=>{
      const order=await makeOrder(),e=eventFor(order);
      await assert.rejects(receivePayment(db,provider,JSON.stringify(e),'wrong'));
      await assert.rejects(receive({...e,mode:'test'}));
      await assert.rejects(receive({...e,data:{...e.data,currency:'USD'}}));
      await assert.rejects(receive({...e,data:{...e.data,merchantProvidedBuyerIdentity:bob}}));
      remoteOrders.get(e.data.orderId).onetimeProduct.id='PROD_wrong';await assert.rejects(receive(e));
      assert.equal(await state(order.id),'creating');assert.equal(await count(order.id),0);
    });
    await t.test('concurrent webhook retries and distinct delivery IDs credit only once',async()=>{
      const order=await makeOrder(),e=eventFor(order);
      await Promise.all([receive(e),receive(e)]);
      await receive({...e,id:randomUUID()});
      await Promise.all([deliverPayments(db,null),deliverPayments(db,null)]);
      assert.equal(await state(order.id),'credited');assert.equal(await count(order.id),1);
      const reads=remoteReads;await receive(e);assert.equal(remoteReads,reads);
      await assert.rejects(receive({...e,data:{...e.data,total:'20.00'}}));
      assert.equal(await count(order.id),1);
    });
    await t.test('durable webhook transaction rolls back on storage failure, so retry can finish',async()=>{
      const order=await makeOrder(),e=eventFor(order);
      await db.query(`CREATE FUNCTION reject_payment_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action LIKE 'payment.%' THEN RAISE EXCEPTION 'test failure'; END IF; RETURN NEW; END $$`);
      await db.query('CREATE TRIGGER reject_payment_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_payment_audit()');
      await assert.rejects(receive(e));assert.equal(await state(order.id),'creating');
      assert.equal((await db.query('SELECT * FROM payment_events WHERE event_id=$1',[e.id])).rowCount,0);
      await db.query('DROP TRIGGER reject_payment_audit ON audit_events');await receive(e);
      await deliverPayments(db,null);assert.equal(await count(order.id),1);
    });
    await t.test('test payments never call LaneHub or produce spendable credits',async()=>{
      const order=await makeOrder({mode:'test',target:'test'}),e=eventFor(order);
      await receive(e,{...provider,mode:'test'});
      let quotaCalls=0;await deliverPayments(db,{addQuota:async()=>{quotaCalls++;}});
      assert.equal(await state(order.id),'test_completed');assert.equal(await count(order.id),0);assert.equal(quotaCalls,0);
    });
    await t.test('LaneHub delivery is single-claim; ambiguous outcome is held for review without repeating credit',async()=>{
      const order=await makeOrder({target:'lanehub'}),e=eventFor(order);await receive(e);
      let quotaCalls=0;
      const hub={addQuota:async(id,quota)=>{quotaCalls++;assert.equal(id,42);assert.equal(quota,500000);throw new Error('response_lost_after_applied');}};
      await Promise.all([deliverPayments(db,hub),deliverPayments(db,hub)]);await receive(e);await deliverPayments(db,hub);
      assert.equal(quotaCalls,1);assert.equal(await state(order.id),'review_required');assert.equal(await count(order.id),0);
    });
    await t.test('confirmed LaneHub delivery records one ledger entry',async()=>{
      const order=await makeOrder({target:'lanehub'});await receive(eventFor(order));let n=0;
      const hub={addQuota:async()=>{n++;}};
      await Promise.all([deliverPayments(db,hub),deliverPayments(db,hub)]);await deliverPayments(db,hub);
      assert.equal(n,1);assert.equal(await count(order.id),1);assert.equal(await state(order.id),'credited');
    });
    await t.test('refund arriving before completion blocks later credit, refund after credit preserves history',async()=>{
      const first=await makeOrder();await receive(eventFor(first,'refund.succeeded'));await receive(eventFor(first));
      await deliverPayments(db,null);assert.equal(await state(first.id),'refund_review');assert.equal(await count(first.id),0);
      const second=await makeOrder();await receive(eventFor(second));await deliverPayments(db,null);
      await receive(eventFor(second,'refund.succeeded'));await deliverPayments(db,null);
      assert.equal(await state(second.id),'refund_review');assert.equal(await count(second.id),1);
    });
    await t.test('a second paid provider order for the same internal order is flagged, never credited again',async()=>{
      const row=await makeOrder(),e=eventFor(row);await receive(e);await deliverPayments(db,null);
      const other=structuredClone(e);other.id=randomUUID();other.data.orderId+='duplicate';
      remoteOrders.set(other.data.orderId,{...remoteOrders.get(e.data.orderId),id:other.data.orderId});
      await receive(other);await deliverPayments(db,null);assert.equal(await count(row.id),1);assert.equal(await state(row.id),'review_required');
    });
    await t.test('test checkout is restricted to administrator sessions',async()=>{
      provider.mode='test';
      const r=await app.inject({url:'/api/me/payments/options',headers:{cookie:'bob'}});assert.equal(r.json().enabled,false);
      assert.equal((await checkout({pack:'cny_10'},randomUUID(),'bob')).statusCode,503);
      await db.query("INSERT INTO user_roles(user_id,role) VALUES($1,'admin')",[alice]);
      assert.equal((await checkout({pack:'cny_50'})).statusCode,200);
    });
    await db.migrate();
  } finally { await app?.close();await db.close();await setup.query(`DROP SCHEMA ${schema} CASCADE`);await setup.close(); }
});
