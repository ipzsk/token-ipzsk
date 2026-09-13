import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {database} from '../src/database.mjs';
import {createApp} from '../src/app.mjs';
import {createCustomerAuth} from '../src/customer-auth.mjs';
import {passwordHash,httpError,hash} from '../src/security.mjs';
import {takeAuthLimit} from '../src/auth-abuse.mjs';
import {sesRequest} from '../src/email.mjs';

test('SES request uses a single recipient and an approved template, with UTC scoped signing',()=>{
  const request=sesRequest({from:'noreply@mail.example.com',region:'ap-hongkong',templateId:123,
    secretId:'AKIDEXAMPLE12345678',secretKey:'example-secret-key-only-for-unit-tests'},
    {email:'alice@example.com',otp:'123456'},1788566400);
  const body=JSON.parse(request.body);assert.deepEqual(body.Destination,['alice@example.com']);
  assert.equal(body.Template.TemplateID,123);assert.equal(JSON.parse(body.Template.TemplateData).code,'123456');
  assert.equal(body.TriggerType,1);assert.equal(body.Simple,undefined);
  assert.match(request.headers.Authorization,/\/2026-09-05\/ses\/tc3_request/);
  assert.equal(request.headers['X-TC-Action'],'SendEmail');
});

test('password login, verified registration and recovery',async t=>{
  assert.ok(process.env.TEST_DB_HOST);const schema='password_test_'+randomUUID().replaceAll('-','');
  const config={host:process.env.TEST_DB_HOST,database:'gateway_test',user:'gateway',password:process.env.TEST_DB_PASSWORD};
  const setup=database(config);await setup.query(`CREATE SCHEMA ${schema}`);
  const db=database({...config,options:`-c search_path=${schema}`});let app,ip=1;
  const usedProofs=new Set(),checkedProofs=[];const captcha={ready:true,async verify(proof){checkedProofs.push(proof);if(!proof.token.startsWith('test-valid-')||usedProofs.has(proof.token))throw httpError(403,'captcha_invalid');usedProofs.add(proof.token);}};
  const mailbox=new Map(),password='fixture-password-12345';
  const mailer={ready:true,provider:'test',async send({email,otp}){mailbox.set(email,otp);}};
  try{
    await db.migrate();const customerAuth=createCustomerAuth({db,secret:randomBytes(32).toString('base64url'),origin:'https://api.ipzsk.com',mailer,captcha});
    await customerAuth.migrate();await customerAuth.migrate();
    await db.query('INSERT INTO administrators(id,password_hash) VALUES(1,$1)',[await passwordHash('auth-test-admin-password')]);
    app=await createApp({db,customerAuth,voucherKey:randomBytes(32),upstream:{},scheduler:{keys:new Map(),accounts:new Map()},origin:'https://api.ipzsk.com',secureCookies:true});
    const send=(path,body,cookie='',origin='https://www.ipzsk.com')=>app.inject({url:path,method:body?'POST':'GET',payload:body?{captcha:{token:'test-valid-'+randomUUID()},...body}:body,remoteAddress:'192.0.2.'+(ip++),headers:{origin,cookie,'x-forwarded-for':'198.51.100.99'}});
    const auth=(path,body,cookie)=>send('/api/auth'+path,body,cookie);
    const cookies=r=>[].concat(r.headers['set-cookie']??[]).map(x=>x.split(';')[0]).join('; ');
    const signup=email=>auth('/sign-up/email',{email,name:email,password});
    const verify=email=>auth('/email-otp/verify-email',{email,otp:mailbox.get(email)});
    const login=(email,p=password)=>auth('/sign-in/email',{email,password:p});
    const register=async email=>{const r=await signup(email);assert.equal(r.statusCode,200,r.body);assert.equal((await verify(email)).statusCode,200);return cookies(await login(email));};
    let aliceCookie,bobCookie,aliceId,bobId;
    await t.test('all sending endpoints require server proof before creating accounts or mail',async()=>{
      for(const path of ['/sign-up/email','/email-otp/send-verification-otp','/email-otp/request-password-reset']){
        const body={email:'protected@example.com',name:'Protected',password,type:'email-verification',captcha:null};
        assert.equal((await auth(path,body)).statusCode,403);
        assert.equal((await auth(path,{...body,captcha:{token:'invalid-token-'+randomUUID()}})).statusCode,403);
        assert.equal((await auth(path,{...body,captcha:{token:''}})).statusCode,403);
      }
      assert.equal(mailbox.size,0);assert.equal((await db.query('SELECT count(*) FROM auth_users')).rows[0].count,'0');
      captcha.ready=false;assert.equal((await signup('protected@example.com')).statusCode,503);
      const status=(await send('/api/account/status')).json();assert.equal(status.registration_ready,false);assert.equal(status.captcha_provider,'captcha-canvas');captcha.ready=true;
    });
    await t.test('proofs cannot be reused concurrently or on a different endpoint; IP is server-derived',async()=>{
      const proof={token:'test-valid-'+randomUUID()};
      const r=await Promise.all([auth('/sign-up/email',{email:'proof-a@example.com',name:'A',password,captcha:proof}),auth('/sign-up/email',{email:'proof-b@example.com',name:'B',password,captcha:proof})]);
      assert.equal(r.filter(x=>x.statusCode===200).length,1);assert.equal(r.filter(x=>x.statusCode===403).length,1);
      assert.equal((await auth('/email-otp/request-password-reset',{email:'proof-a@example.com',captcha:proof})).statusCode,403);
      assert.ok(checkedProofs.every(p=>p.ip.startsWith('192.0.2.')));
      // Remove only isolated fixture accounts, preserving the original scenario's count assertions.
      await db.query('DELETE FROM auth_accounts');await db.query('DELETE FROM auth_users');await db.query('DELETE FROM auth_verifications');mailbox.clear();
    });
    await t.test('persistent limits are atomic and survive a new limiter caller',async()=>{
      const key='concurrent-fixture';const results=await Promise.allSettled(Array.from({length:8},()=>takeAuthLimit(db,key,3,600)));
      assert.equal(results.filter(r=>r.status==='fulfilled').length,3);assert.equal((await db.query('SELECT count FROM auth_abuse_limits WHERE key_hash=$1',[hash(key)])).rows[0].count,3);
      await assert.rejects(()=>takeAuthLimit(db,key,3,600),{code:'rate_limited'});
      await db.query(`UPDATE auth_abuse_limits SET expires_at=now()-interval '1 second' WHERE key_hash=$1`,[hash(key)]);
      assert.equal(await takeAuthLimit(db,key,3,600),1);
    });
    await t.test('frequent password attempts require proof but the first three do not',async()=>{
      const body={email:'frequent@example.com',password,captcha:null};
      for(let i=0;i<3;i++)assert.equal((await auth('/sign-in/email',body)).statusCode,401);
      const r=await auth('/sign-in/email',body);assert.equal(r.statusCode,403);assert.equal(r.json().error.code,'captcha_required');
      assert.equal((await login(body.email)).statusCode,401);
    });
    await t.test('signup requires verification and does not sign in or create business records early',async()=>{
      const r=await signup('alice@example.com');assert.equal(r.statusCode,200,r.body);assert.equal(r.json().token,null);assert.equal(cookies(r),'');
      assert.equal((await db.query('SELECT count(*) FROM users')).rows[0].count,'0');assert.equal((await login('alice@example.com')).statusCode,403);
      assert.ok((await auth('/email-otp/verify-email',{email:'alice@example.com',otp:'invalid'})).statusCode>=400);
      const stored=(await db.query('SELECT value FROM auth_verifications')).rows[0].value;assert.ok(!stored.includes(mailbox.get('alice@example.com')));
      const verified=await verify('alice@example.com');assert.equal(verified.statusCode,200,verified.body);assert.equal(cookies(verified),'');
      const signedIn=await login('alice@example.com');assert.equal(signedIn.statusCode,200,signedIn.body);aliceCookie=cookies(signedIn);
      assert.match(aliceCookie,/ipzsk_customer/);assert.match([].concat(signedIn.headers['set-cookie']).join(' '),/HttpOnly/);
      aliceId=(await send('/api/me/profile',undefined,aliceCookie)).json().user.id;
    });
    await t.test('login never registers and remains available without mail service',async()=>{
      assert.equal((await login('missing@example.com')).statusCode,401);assert.equal((await login('alice@example.com','wrong-password')).statusCode,401);
      assert.equal((await db.query('SELECT count(*) FROM auth_users')).rows[0].count,'1');mailer.ready=false;
      assert.equal((await login('alice@example.com')).statusCode,200);assert.equal((await signup('blocked@example.com')).statusCode,503);
      assert.equal((await auth('/email-otp/request-password-reset',{email:'alice@example.com'})).statusCode,503);
      const status=(await send('/api/account/status')).json();assert.equal(status.password_login_ready,true);assert.equal(status.registration_ready,false);mailer.ready=true;
    });
    await t.test('old OTP login is closed, verification is throttled and sessions remain isolated',async()=>{
      assert.equal((await auth('/sign-in/email-otp',{email:'alice@example.com',otp:'123456'})).statusCode,404);
      assert.equal((await auth('/email-otp/send-verification-otp',{email:'alice@example.com',type:'sign-in'})).statusCode,400);
      assert.equal((await auth('/email-otp/send-verification-otp',{email:'alice@example.com',type:'email-verification'})).statusCode,429);
      assert.equal((await send('/api/me/tokens',{},aliceCookie,'https://evil.example')).statusCode,403);
      assert.equal((await send('/admin/api/users',undefined,aliceCookie)).statusCode,401);
      const admin=await send('/admin/api/login',{password:'auth-test-admin-password'},'','https://api.ipzsk.com');assert.equal(admin.statusCode,200);
      assert.equal((await send('/api/me/profile',undefined,cookies(admin))).statusCode,401);
      assert.equal((await app.inject({url:'/api/auth/sign-in/email',method:'OPTIONS',headers:{origin:'https://www.ipzsk.com'}})).statusCode,204);
    });
    await t.test('verified mailbox links original manual account and preserves key isolation',async()=>{
      bobId=randomUUID();await db.query('INSERT INTO users(id,name,email) VALUES($1,$2,$3)',[bobId,'Original account','bob@example.com']);
      bobCookie=await register('bob@example.com');assert.equal((await send('/api/me/profile',undefined,bobCookie)).json().user.id,bobId);
      const a=await send('/api/me/tokens',{name:'Alice'},aliceCookie);assert.equal(a.statusCode,200);
      assert.equal((await send('/api/me/tokens/'+a.json().id+'/revoke',{},bobCookie)).statusCode,404);
      assert.equal((await send('/api/me/wallet?user_id='+aliceId,undefined,bobCookie)).json().user.id,bobId);
    });
    await t.test('网页会话密钥：一个登录会话一把，退出即失效',async()=>{
      // 官网要打 /v1/*（生图、对话），那条路只认 Bearer 令牌不认 cookie。
      assert.equal((await send('/api/me/web/session-key',{})).statusCode,401,'没登录不给');
      assert.equal((await send('/api/me/web/session-key',{},aliceCookie,'https://evil.example')).statusCode,403,'跨站不给');
      const call=t=>app.inject({url:'/v1/models',headers:{authorization:'Bearer '+t}});
      const first=(await send('/api/me/web/session-key',{},aliceCookie)).json();
      assert.match(first.token,/^ipz_/);
      assert.equal((await call(first.token)).statusCode,200);
      // 刷新页面只是轮换同一行，不能攒出第二把永久 Key。
      const second=(await send('/api/me/web/session-key',{},aliceCookie)).json();
      assert.equal((await call(first.token)).statusCode,401,'旧密钥必须作废');
      assert.equal((await call(second.token)).statusCode,200);
      assert.equal((await db.query('SELECT count(*) FROM access_tokens WHERE user_id=$1 AND auth_session_id IS NOT NULL AND plugin_id IS NULL',[aliceId])).rows[0].count,'1');
      // 退出登录，这把密钥跟着失效——浏览器里存着的那份不该还能花钱。
      const other=cookies(await login('alice@example.com'));
      const third=(await send('/api/me/web/session-key',{},other)).json().token;
      await auth('/sign-out',{},other);
      assert.equal((await call(third)).statusCode,401);
      // 这把是本测试自己造的第二个会话，清掉——后面那个测试要数「一个会话一行」。
      await db.query('DELETE FROM access_tokens WHERE prefix=$1',[third.slice(0,12)]);
    });
    let desktopAliceToken;
    await t.test('desktop bootstrap binds credentials to the session and preserves other devices and API Keys',async()=>{
      assert.equal((await send('/api/me/desktop/bootstrap',{})).statusCode,401);
      assert.equal((await send('/api/me/desktop/bootstrap',{},aliceCookie,'https://evil.example')).statusCode,403);
      assert.equal((await send('/api/me/desktop/bootstrap',{},aliceCookie)).statusCode,503);
      const account=randomUUID(),key=randomUUID();
      await db.query('INSERT INTO upstream_accounts(id,name) VALUES($1,$2)',[account,'Desktop fixture']);
      await db.query("INSERT INTO upstream_keys(id,account_id,name,fingerprint,suffix,secret_ref,models) VALUES($1,$2,'fixture','fixture','test','fixture',$3)",
        [key,account,['gpt-image-2','whisper-1','gpt-4o-mini','gpt-5.6-sol']]);
      const call=token=>app.inject({url:'/v1/models',headers:{authorization:'Bearer '+token}});
      const first=await send('/api/me/desktop/bootstrap',{},aliceCookie);
      assert.equal(first.statusCode,200);assert.equal(first.json().default_model,'gpt-5.6-sol');
      assert.deepEqual(first.json().models.map(m=>m.id),['gpt-5.6-sol']);
      assert.deepEqual(first.json().image_models.map(m=>m.id),['gpt-image-2']);
      assert.equal((await call(first.json().token)).statusCode,200);
      // 按 id 取，不按下标：插件表里不止一个插件，顺序按 slug 排，加一个新插件就会串位。
      const pluginOf=(response,id)=>response.json().plugin_configs.find(p=>p.plugin_id===id);
      const firstPlugin=pluginOf(first,'7d8b7d87-b85f-49f1-bde7-a0b1a2f33401');
      assert.ok(firstPlugin,'生图插件的凭据要下发');
      assert.notEqual(firstPlugin.credential,first.json().token);
      assert.equal((await call(firstPlugin.credential)).statusCode,200);
      const second=await send('/api/me/desktop/bootstrap',{},aliceCookie);desktopAliceToken=second.json().token;
      assert.equal((await call(firstPlugin.credential)).statusCode,401);
      assert.equal((await call(pluginOf(second,'7d8b7d87-b85f-49f1-bde7-a0b1a2f33401').credential)).statusCode,200);
      // 走 Host llm 服务的插件（credential_paths 为空）同样要拿到自己的凭据——
      // 桌面端据此给它单独注册一条 provider，否则它花的钱归属不到它头上。
      const docToExcel=pluginOf(second,'7d8b7d87-b85f-49f1-bde7-a0b1a2f33402');
      assert.ok(docToExcel,'自己不发请求的插件也要有凭据');
      assert.deepEqual(docToExcel.credential_paths,[]);
      assert.notEqual(docToExcel.credential,second.json().token);
      assert.equal((await call(docToExcel.credential)).statusCode,200);
      assert.equal((await call(first.json().token)).statusCode,401);
      assert.equal((await call(desktopAliceToken)).statusCode,200);
      assert.equal((await db.query('SELECT count(*) FROM access_tokens WHERE user_id=$1 AND auth_session_id IS NOT NULL AND plugin_id IS NULL',[aliceId])).rows[0].count,'1');
      const c=cookies(await login('alice@example.com'));
      const another=(await send('/api/me/desktop/bootstrap',{},c)).json().token;
      await auth('/sign-out',{},c);
      assert.equal((await call(another)).statusCode,401);
      assert.equal((await call(desktopAliceToken)).statusCode,200);
      const bob=(await send('/api/me/desktop/bootstrap',{},bobCookie)).json().token;
      assert.equal((await app.inject({url:'/api/me/profile',headers:{authorization:'Bearer '+bob}})).json().user.id,bobId);
      assert.equal((await app.inject({url:'/api/me/desktop/bootstrap',method:'POST',payload:{},headers:{authorization:'Bearer '+bob}})).statusCode,403);
    });
    await t.test('password recovery validates OTP and invalidates previous sessions and password',async()=>{
      await db.query('UPDATE auth_email_limits SET next_allowed=now()');
      assert.equal((await auth('/email-otp/request-password-reset',{email:'alice@example.com'})).statusCode,200);
      const otp=mailbox.get('alice@example.com'),next='updated-fixture-password';
      assert.ok((await auth('/email-otp/reset-password',{email:'alice@example.com',otp:'invalid',password:next})).statusCode>=400);
      const r=await auth('/email-otp/reset-password',{email:'alice@example.com',otp,password:next});assert.equal(r.statusCode,200,r.body);
      assert.equal((await send('/api/me/profile',undefined,aliceCookie)).statusCode,401);
      assert.equal((await app.inject({url:'/v1/models',headers:{authorization:'Bearer '+desktopAliceToken}})).statusCode,401);
      assert.equal((await login('alice@example.com')).statusCode,401);assert.equal((await login('alice@example.com',next)).statusCode,200);
      assert.ok((await auth('/email-otp/reset-password',{email:'alice@example.com',otp,password})).statusCode>=400);
    });
    await t.test('expired codes and concurrent OTP reuse fail safely',async()=>{
      await signup('expired@example.com');await db.query(`UPDATE auth_verifications SET "expiresAt"=now()-interval '1 minute'`);assert.ok((await verify('expired@example.com')).statusCode>=400);
      await signup('race@example.com');const r=await Promise.all([verify('race@example.com'),verify('race@example.com')]);assert.equal(r.filter(x=>x.statusCode===200).length,1);
    });
    await t.test('disabled accounts cannot login and signout invalidates sessions',async()=>{
      await db.query('UPDATE users SET enabled=false WHERE id=$1',[bobId]);assert.equal((await login('bob@example.com')).statusCode,403);
      assert.equal((await send('/api/me/profile',undefined,bobCookie)).statusCode,403);
      const c=await register('logout@example.com');assert.equal((await auth('/sign-out',{},c)).statusCode,200);assert.equal((await send('/api/me/profile',undefined,c)).statusCode,401);
    });
  }finally{await app?.close();await db.close();await setup.query(`DROP SCHEMA ${schema} CASCADE`);await setup.close();}
});
