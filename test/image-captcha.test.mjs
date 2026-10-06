import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {database} from '../src/database.mjs';
import {createImageCaptcha} from '../src/captcha.mjs';
import {createCustomerAuth} from '../src/customer-auth.mjs';
import {createApp} from '../src/app.mjs';

test('real database: guesses, expiry, action/email/IP binding, one-time proof and protected email routes',async t=>{
  assert.ok(process.env.TEST_DB_HOST);
  const config={host:process.env.TEST_DB_HOST,port:Number(process.env.TEST_DB_PORT??5432),database:'gateway_test',user:'gateway',password:process.env.TEST_DB_PASSWORD};
  const setup=database(config),schema='captcha_test_'+randomUUID().replaceAll('-','');
  await setup.query(`CREATE SCHEMA ${schema}`);
  const db=database({...config,options:`-c search_path=${schema}`});let app;
  const secret='image-captcha-integration-secret-12345';let answer;
  const captcha=createImageCaptcha({db,secret,render(w,h,options){answer=options.captcha.text;return {image:Promise.resolve(Buffer.from('test fixture PNG'))};}});
  const ctx={email:'fixture@example.com',ip:'192.0.2.1',action:'register'};
  const issue=async(context=ctx)=>{const c=await captcha.issue(context);return {...context,id:c.id,answer};};
  try{
    await db.migrate();
    await t.test('incorrect answers do not authorize; correct answer ignores case',async()=>{
      const c=await issue();await assert.rejects(()=>captcha.solve({...c,answer:'ZZZZZ'===c.answer?'YYYYY':'ZZZZZ'}),{code:'captcha_invalid'});
      assert.equal((await db.query('SELECT attempts FROM image_captchas WHERE id=$1',[c.id])).rows[0].attempts,1);
      const proof=await captcha.solve({...c,answer:c.answer.toLowerCase()});await captcha.verify({...ctx,...proof});
      await assert.rejects(()=>captcha.verify({...ctx,...proof}),{code:'captcha_invalid'});
    });
    await t.test('five concurrent wrong guesses exhaust the challenge',async()=>{
      const c=await issue();const results=await Promise.allSettled(Array.from({length:8},()=>captcha.solve({...c,answer:c.answer==='ZZZZZ'?'YYYYY':'ZZZZZ'})));
      assert.ok(results.every(r=>r.status==='rejected'));assert.equal((await db.query('SELECT attempts FROM image_captchas WHERE id=$1',[c.id])).rows[0].attempts,5);
      await assert.rejects(()=>captcha.solve(c),{code:'captcha_invalid'});
    });
    await t.test('expired image and expired proof fail closed',async()=>{
      const c=await issue();await db.query("UPDATE image_captchas SET expires_at=now()-interval '1 second' WHERE id=$1",[c.id]);await assert.rejects(()=>captcha.solve(c),{code:'captcha_invalid'});
      const d=await issue(),proof=await captcha.solve(d);await db.query("UPDATE image_captchas SET expires_at=now()-interval '1 second' WHERE id=$1",[d.id]);await assert.rejects(()=>captcha.verify({...ctx,...proof}),{code:'captcha_invalid'});
    });
    await t.test('proof cannot move across emails, IPs or actions; concurrency consumes it once',async()=>{
      const c=await issue();for(const diff of [{email:'other@example.com'},{ip:'192.0.2.2'},{action:'reset'}])await assert.rejects(()=>captcha.solve({...c,...diff}),{code:'captcha_invalid'});
      const solved=await Promise.allSettled([captcha.solve(c),captcha.solve(c)]);assert.equal(solved.filter(r=>r.status==='fulfilled').length,1);
      const proof=solved.find(r=>r.status==='fulfilled').value;
      for(const diff of [{email:'other@example.com'},{ip:'192.0.2.2'},{action:'reset'}])await assert.rejects(()=>captcha.verify({...ctx,...proof,...diff}),{code:'captcha_invalid'});
      const outcomes=await Promise.allSettled([captcha.verify({...ctx,...proof}),captcha.verify({...ctx,...proof})]);assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
    });
    await t.test('actual HTTP auth route rejects missing/bogus proofs and sends only after successful image verification',async()=>{
      let sent=0;const customerAuth=createCustomerAuth({db,secret,origin:'https://api.ipzsk.com',captcha,mailer:{ready:true,async send(){sent++;}}});await customerAuth.migrate();
      app=await createApp({db,customerAuth,upstream:{},scheduler:{keys:new Map(),accounts:new Map()},origin:'https://api.ipzsk.com',secureCookies:true});
      const post=(url,payload,origin='https://www.ipzsk.com')=>app.inject({method:'POST',url,payload,remoteAddress:ctx.ip,headers:{origin}});
      const body={email:ctx.email,password:'test-password-fixture-123',name:'Fixture'};
      assert.equal((await post('/api/auth/sign-up/email',body)).statusCode,403);
      assert.equal((await post('/api/auth/sign-up/email',{...body,captcha:{token:'invalid'}})).statusCode,403);assert.equal(sent,0);
      assert.equal((await post('/api/account/captcha',ctx,'https://evil.example')).statusCode,403);
      const issued=await post('/api/account/captcha',ctx);assert.equal(issued.statusCode,200);assert.equal(issued.json().answer,undefined);
      const solved=await post('/api/account/captcha/verify',{...ctx,id:issued.json().id,answer});assert.equal(solved.statusCode,200);
      assert.equal((await post('/api/auth/sign-up/email',{...body,captcha:solved.json()})).statusCode,200);assert.equal(sent,1);
      assert.equal((await post('/api/auth/sign-up/email',{...body,captcha:solved.json()})).statusCode,403);assert.equal(sent,1);
    });
  }finally{await app?.close();await db.close();await setup.query(`DROP SCHEMA ${schema} CASCADE`);await setup.close();}
});
