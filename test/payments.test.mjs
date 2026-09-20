import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import Fastify from 'fastify';
import { WaffoPancake, verifyWebhook } from '@waffo/pancake-ts';
import { paymentRoutes, validatePayment } from '../src/payments.mjs';
import { checkoutUrl, PAYMENT_PACKS } from '../src/waffo.mjs';

test('installed SDK forwards email and CN billing to the checkout session, preserving internal buyer identity', async () => {
  const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const requests=[];
  const client=new WaffoPancake({merchantId:'MER_0123456789012345678901',environment:'test',
    privateKey:privateKey.export({type:'pkcs8',format:'pem'}),
    fetch:async(url,init)=>{
      const path=new URL(url).pathname;requests.push({path,body:JSON.parse(init.body)});
      return Response.json({data:path.endsWith('issue-session-token')?{token:'test-fixture'}
        :{sessionId:'fixture',checkoutUrl:'https://pancake.waffo.ai/store/test/checkout/fixture'}});
    },
  });
  const result=await client.checkout.authenticated.create({productId:'PROD_0123456789012345678901',currency:'CNY',
    buyerIdentity:'internal-user-id',buyerEmail:'buyer@example.test',billingDetail:{country:'CN',isBusiness:false},language:'zh-Hans'});
  const session=requests.find(r=>r.path.endsWith('create-session')).body;
  const identity=requests.find(r=>r.path.endsWith('issue-session-token')).body;
  assert.equal(session.buyerEmail,'buyer@example.test');
  assert.deepEqual(session.billingDetail,{country:'CN',isBusiness:false});
  assert.equal(session.language,'zh-Hans');assert.equal(session.buyerIdentity,undefined);
  assert.equal(identity.buyerIdentity,'internal-user-id');assert.equal(identity.buyerEmail,undefined);
  assert.equal(new URL(result.checkoutUrl).hash,'#token=test-fixture');
});

test('checkout destination never accepts lookalike hosts or non-HTTPS URLs', () => {
  assert.equal(checkoutUrl('https://pancake.waffo.ai/store/ipzsk#token=example'), 'https://pancake.waffo.ai/store/ipzsk#token=example');
  for (const url of ['javascript:alert(1)','https://pancake.waffo.ai.evil.example/', 'http://pancake.waffo.ai/', 'https://user@pancake.waffo.ai/'])
    assert.throws(() => checkoutUrl(url));
  assert.deepEqual(PAYMENT_PACKS.map(p => p.amount_cny), ['10.00','50.00','100.00']);
});

test('signed payment must match server order, owner, product, environment and exact amount', () => {
  const order = { id:'internal', user_id:'alice', mode:'prod', product_id:'PROD_a', currency:'CNY', amount_cny:'10.00000000' };
  const provider = { mode:'prod',storeId:'STO_a' };
  const event = { mode:'prod',storeId:'STO_a',data:{ orderId:'provider',orderMerchantExternalId:'internal',
    merchantProvidedBuyerIdentity:'alice',orderStatus:'completed',paymentStatus:'succeeded',currency:'CNY',total:'10.00' } };
  const remote = { id:'provider',status:'completed',testMode:false,orderMerchantExternalId:'internal',merchantProvidedBuyerIdentity:'alice',
    store:{id:'STO_a'},onetimeProduct:{id:'PROD_a'},priceSnapshot:{currency:'CNY',subtotal:'10.00',total:'10.00'} };
  validatePayment(event,order,provider,remote);
  for (const changed of [{currency:'USD'},{total:'0.01'},{merchantProvidedBuyerIdentity:'bob'},{orderMerchantExternalId:'other'},{paymentStatus:'failed'}])
    assert.throws(() => validatePayment({...event,data:{...event.data,...changed}},order,provider,remote));
  for (const changed of [{testMode:true},{onetimeProduct:{id:'PROD_other'}},{priceSnapshot:{currency:'CNY',subtotal:'100.00',total:'100.00'}}])
    assert.throws(() => validatePayment(event,order,provider,{...remote,...changed}));
});

test('webhook route preserves signed raw bytes while ordinary JSON routes keep object parsing', async () => {
  const {publicKey,privateKey} = generateKeyPairSync('rsa',{modulusLength:2048});
  const publicPem = publicKey.export({type:'spki',format:'pem'});
  const app=Fastify();
  app.setErrorHandler((error,_req,reply)=>reply.code(error.statusCode??500).send({code:error.code}));
  paymentRoutes(app,{db:{},waffo:{ mode:'test',storeId:'STO_a',verify:(raw,sig)=>verifyWebhook(raw,sig,{publicKey:publicPem}) }});
  app.post('/ordinary-json',async req=>({value:req.body.a}));
  const raw='{ "mode": "test", "storeId": "STO_a", "eventType": "unsubscribed.event" }\n';
  const time=String(Date.now());
  const signature=`t=${time},v1=${sign('RSA-SHA256',Buffer.from(time+'.'+raw),privateKey).toString('base64')}`;
  try {
    assert.equal((await app.inject({method:'POST',url:'/api/payments/waffo/webhook',payload:raw,headers:{'content-type':'application/json','x-waffo-signature':signature}})).statusCode,200);
    assert.equal((await app.inject({method:'POST',url:'/api/payments/waffo/webhook',payload:raw.trim(),headers:{'content-type':'application/json','x-waffo-signature':signature}})).statusCode,401);
    assert.deepEqual((await app.inject({method:'POST',url:'/ordinary-json',payload:{a:1}})).json(),{value:1});
  } finally { await app.close(); }
});
