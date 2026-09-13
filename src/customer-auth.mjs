import { issueKey } from './account-keys.mjs';
import { provisionIfEnabled } from './lanehub.mjs';
import { betterAuth } from 'better-auth';
import { emailOTP } from 'better-auth/plugins/email-otp';
import { fromNodeHeaders } from 'better-auth/node';
import { getMigrations } from 'better-auth/db/migration';
import { randomUUID } from 'node:crypto';
import { hash, httpError, token, RateLimiter } from './security.mjs';
import { unavailableCaptcha } from './captcha.mjs';
import { takeAuthLimit, verifyAuthCaptcha } from './auth-abuse.mjs';

export const customerOrigin = 'https://www.ipzsk.com';
export function createCustomerAuth({db,secret,origin,mailer,captcha=unavailableCaptcha(),localSignupBonus=true}) {
  const auth=betterAuth({
    appName:'IPZSK',baseURL:origin,basePath:'/api/auth',secret,database:db.pool,
    trustedOrigins:[origin,customerOrigin],telemetry:{enabled:false},logger:{disabled:true},
    emailAndPassword:{enabled:true,requireEmailVerification:true,autoSignIn:false,minPasswordLength:12,maxPasswordLength:128,revokeSessionsOnPasswordReset:true},
    emailVerification:{sendOnSignUp:true,sendOnSignIn:false,autoSignInAfterVerification:false},
    user:{modelName:'auth_users'},account:{modelName:'auth_accounts'},
    session:{modelName:'auth_sessions',expiresIn:7*86400,updateAge:86400,cookieCache:{enabled:false}},
    verification:{modelName:'auth_verifications',storeIdentifier:'hashed'},
    // secure cookie 跟着 origin 走：线上是 https，恒为 true；本机联调用 http://127.0.0.1
    // 时浏览器和 Electron 都会把 secure cookie 丢掉，登录永远不成立，于是只能改成
    // 按协议判。**判据是 origin 的协议，不是某个开关**——没人能靠环境变量把线上的
    // secure 关掉。
    advanced:{cookiePrefix:'ipzsk_customer',useSecureCookies:origin.startsWith('https://'),database:{generateId:()=>randomUUID()},
      defaultCookieAttributes:{httpOnly:true,secure:origin.startsWith('https://'),sameSite:'lax'},ipAddress:{ipAddressHeaders:['x-forwarded-for']}},
    rateLimit:{enabled:true,storage:'database',modelName:'auth_rate_limits',window:60,max:100},
    plugins:[emailOTP({overrideDefaultEmailVerification:true,disableSignUp:true,otpLength:6,expiresIn:300,allowedAttempts:5,storeOTP:'hashed',
      async sendVerificationOTP({email,otp,type}) {
        if(!['email-verification','forget-password'].includes(type))throw httpError(400,'unsupported_auth_operation');
        await mailer.send({email,otp});
      }})],
  });
  async function ensureCustomer(user) {
    if(!user?.emailVerified)throw httpError(403,'email_verification_required');
    return db.tx(async(c)=>{
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[user.id]);
      const existing=(await c.query('SELECT id FROM users WHERE auth_user_id=$1',[user.id])).rows[0];
      if(!existing){
        const manual=await c.query('SELECT id FROM users WHERE auth_user_id IS NULL AND lower(email)=$1 FOR UPDATE',[user.email.toLowerCase()]);
        if(manual.rowCount>1)throw httpError(409,'email_account_link_ambiguous');
        if(manual.rowCount===1){
          await c.query('UPDATE users SET auth_user_id=$2,email_verified=true WHERE id=$1',[manual.rows[0].id,user.id]);
          await c.query('INSERT INTO audit_events(action,target_id) VALUES($1,$2)',['customer.email.link',manual.rows[0].id]);
        }
      }
      const result=await c.query(`INSERT INTO users(id,name,auth_user_id,email,email_verified)
        VALUES($1,$2,$3,$4,true) ON CONFLICT(auth_user_id) DO NOTHING RETURNING id`,
        [randomUUID(),(user.name||user.email).slice(0,100),user.id,user.email.toLowerCase()]);
      const row=(await c.query('SELECT id,name,rpm,enabled,auth_user_id,email FROM users WHERE auth_user_id=$1',[user.id])).rows[0];
      // 新人赠额：lanehub 模式下由 provisionCustomer 在对面发（¥5 → quota），这里不再发本地的，
      // 否则同一个新用户拿两份。没接 lanehub 时照旧发本地钱包。
      if(result.rowCount&&!localSignupBonus){
        await c.query('INSERT INTO audit_events(action,target_id) VALUES($1,$2)',['customer.register',row.id]);
      }else if(result.rowCount){
        const amount='5.00000000',ledgerId=randomUUID();
        const balance=(await c.query(`SELECT coalesce(sum(amount_cny),0)+$2::numeric-
          coalesce((SELECT sum(amount_cny) FROM wallet_debits WHERE user_id=$1),0) AS amount
          FROM wallet_entries WHERE user_id=$1`,[row.id,amount])).rows[0].amount;
        await c.query(`INSERT INTO wallet_entries(id,user_id,voucher_id,amount_cny,balance_after_cny,source)
          VALUES($1,$2,NULL,$3,$4,'signup_bonus') ON CONFLICT DO NOTHING`,[ledgerId,row.id,amount,balance]);
        await c.query('INSERT INTO audit_events(action,target_id,details) VALUES($1,$2,$3)',
          ['customer.register',row.id,JSON.stringify({signup_bonus_cny:amount,ledger_id:ledgerId})]);
      }
      if(!row.enabled)throw httpError(403,'account_disabled');
      return row;
    });
  }
  return {auth,mailer,captcha,ensureCustomer,
    async migrate(){
      const plan=await getMigrations(auth.options);
      const names=[...plan.toBeCreated,...plan.toBeAdded,...plan.toBeAddedIndexes].map(x=>x.table);
      if(names.some(name=>!name.startsWith('auth_')))throw new Error('unexpected_auth_migration');
      await plan.runMigrations();
    },
    async identify(headers){
      const session=await auth.api.getSession({headers:fromNodeHeaders(headers)});
      if(!session)throw httpError(401,'customer_login_required');
      const row=await ensureCustomer(session.user);
      return {...row,token_id:null,session_id:session.session.id};
    },
  };
}

export function customerAuthRoutes(app,options) {
  const {db,customerAuth,origin}=options;
  const limiter=new RateLimiter();
  app.get('/api/account/status',async()=>({password_login_ready:!!customerAuth,registration_ready:!!customerAuth?.mailer.ready&&!!customerAuth?.captcha.ready,email_login_ready:false,
    captcha_ready:!!customerAuth?.captcha.ready,captcha_provider:'captcha-canvas'}));
  for(const [path,operation] of [['/api/account/captcha','issue'],['/api/account/captcha/verify','solve']])app.post(path,async(req,reply)=>{
    if(![origin,customerOrigin].includes(req.headers.origin))throw httpError(403,'origin_denied');
    if(!customerAuth?.captcha.ready)throw httpError(503,'captcha_unavailable');
    await takeAuthLimit(db,'image-captcha-'+operation+':'+req.ip,operation==='issue'?30:60,600);
    if(operation==='issue')await takeAuthLimit(db,'image-captcha-global',300,60);
    reply.header('Cache-Control','no-store');
    return customerAuth.captcha[operation]({...req.body,ip:req.ip});
  });
  app.get('/admin/api/email/status',async()=>({ready:!!customerAuth?.mailer.ready,provider:customerAuth?.mailer.provider??null}));
  app.route({method:['GET','POST'],url:'/api/auth/*',async handler(req,reply){
    if(!customerAuth)throw httpError(503,'email_service_unavailable');
    const path=req.url.split('?')[0].slice('/api/auth'.length);
    if(!['GET /get-session','POST /sign-out','POST /sign-in/email','POST /sign-up/email','POST /email-otp/send-verification-otp','POST /email-otp/verify-email','POST /email-otp/request-password-reset','POST /email-otp/reset-password'].includes(req.method+' '+path))throw httpError(404,'not_found');
    if(req.method==='POST'&&![origin,customerOrigin].includes(req.headers.origin))throw httpError(403,'origin_denied');
    if(req.method==='POST'&&typeof req.body?.email==='string')req.body.email=req.body.email.trim().toLowerCase();
    if(path==='/sign-in/email'){
      const ipCount=await takeAuthLimit(db,'password-ip:'+req.ip,20,600);
      const emailCount=await takeAuthLimit(db,'password-email:'+String(req.body?.email),20,600);
      if(ipCount>3||emailCount>3)await verifyAuthCaptcha(db,customerAuth.captcha,req.body,req.ip,'login');
    }
    if(['/sign-up/email','/email-otp/send-verification-otp','/email-otp/request-password-reset'].includes(path)){
      if(!customerAuth.mailer.ready)throw httpError(503,'email_service_unavailable');
      const email=req.body?.email;
      if(typeof email!=='string'||email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||(path==='/email-otp/send-verification-otp'&&req.body.type!=='email-verification'))throw httpError(400,'invalid_email');
      await takeAuthLimit(db,'captcha-attempt-ip:'+req.ip,30,600);
      await verifyAuthCaptcha(db,customerAuth.captcha,req.body,req.ip,path==='/sign-up/email'?'register':path==='/email-otp/send-verification-otp'?'resend':'reset');
      await takeAuthLimit(db,'send-ip:'+req.ip,10,600);
      await takeAuthLimit(db,'send-global',100,3600);
      const normalized=email.trim().toLowerCase();
      const quota=await db.query(`INSERT INTO auth_email_limits(email_hash,next_allowed,day,count) VALUES($1,now()+interval '60 seconds',current_date,1)
        ON CONFLICT(email_hash) DO UPDATE SET next_allowed=EXCLUDED.next_allowed,day=current_date,
        count=CASE WHEN auth_email_limits.day=current_date THEN auth_email_limits.count+1 ELSE 1 END
        WHERE auth_email_limits.next_allowed<=now() AND (auth_email_limits.day<>current_date OR auth_email_limits.count<20)
        RETURNING email_hash`,[hash(normalized)]);
      if(!quota.rowCount)throw httpError(429,'rate_limited');
      req.body.email=normalized;
    }
    if(req.body&&typeof req.body==='object')delete req.body.captcha;
    const headers=fromNodeHeaders(req.headers);
    headers.delete('x-real-ip');headers.delete('cf-connecting-ip');headers.set('x-forwarded-for',req.ip);
    const result=await customerAuth.auth.handler(new Request(origin+req.url,{method:req.method,headers,
      ...(req.body?{body:JSON.stringify(req.body)}:{})}));
    const body=await result.text();
    if(['/sign-in/email','/email-otp/verify-email'].includes(path)&&result.ok){
      const data=JSON.parse(body);
      const customer=await customerAuth.ensureCustomer(data.user);
      // 注册/登录当场就把 lanehub 的账号、密钥和新人额度备好。放在这里而不是等第一次
      // 发请求：不然新用户在后台查不到、余额显示 0，而「送了 5 块」是注册页答应过的。
      // 失败不挡登录——网关和桌面端 bootstrap 还会各补一次。
      await provisionIfEnabled(db,options,{userId:customer.id,name:customer.name}).catch(()=>{});
    }
    reply.code(result.status);
    for(const [key,value] of result.headers)if(key!=='set-cookie')reply.header(key,value);
    const cookies=result.headers.getSetCookie();if(cookies.length)reply.header('Set-Cookie',cookies);
    return reply.send(body);
  }});
  app.get('/api/me/profile',async(req)=>{
    const user=(await db.query('SELECT id,name,email,email_verified,created_at FROM users WHERE id=$1',[req.apiUser.id])).rows[0];
    const credential=(await db.query('SELECT prefix,created_at FROM access_tokens WHERE user_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1',[user.id])).rows[0]??null;
    return {user,credential};
  });
  // 网页端要打 /v1/*（生图、对话），而那条路只认 Bearer 令牌，不认登录 cookie。
  // 这里按**登录会话**签一把令牌：一个会话一行（唯一索引 desktop_session_token），
  // 刷新页面只是轮换同一行的密钥，不会攒出一堆永久 Key；退出登录会话失效，令牌跟着失效。
  // 桌面端 bootstrap 用的是同一个模式和同一张索引——两边是不同的登录会话，互不影响。
  app.post('/api/me/web/session-key',async(req)=>{
    if(!req.apiUser.session_id)throw httpError(403,'customer_login_required');
    limiter.take('web-key:'+req.apiUser.id,30,600000);
    // 网页登录后也要把 lanehub 的账号、密钥和新人额度备好（和注册/登录那条路同一个函数）。
    await provisionIfEnabled(db,options,{userId:req.apiUser.id,name:req.apiUser.name}).catch(()=>{});
    return db.tx(async(c)=>{
      const user=(await c.query('SELECT enabled FROM users WHERE id=$1 FOR UPDATE',[req.apiUser.id])).rows[0];
      if(!user?.enabled)throw httpError(403,'account_disabled');
      const session=(await c.query('SELECT "expiresAt" FROM auth_sessions WHERE id=$1 AND "userId"=$2 AND "expiresAt">now()',
        [req.apiUser.session_id,req.apiUser.auth_user_id])).rows[0];
      if(!session)throw httpError(401,'customer_login_required');
      const value=token('ipz_');
      const result=await c.query(`INSERT INTO access_tokens(id,user_id,token_hash,prefix,name,expires_at,auth_session_id)
        VALUES($1,$2,$3,$4,'IPZSK 网页',$5,$6)
        ON CONFLICT(auth_session_id) WHERE plugin_id IS NULL DO UPDATE SET token_hash=EXCLUDED.token_hash,prefix=EXCLUDED.prefix,
        expires_at=EXCLUDED.expires_at WHERE access_tokens.revoked_at IS NULL RETURNING id`,
        [randomUUID(),req.apiUser.id,hash(value),value.slice(0,12),session.expiresAt,req.apiUser.session_id]);
      if(!result.rowCount)throw httpError(403,'web_access_revoked');
      await c.query('INSERT INTO audit_events(action,target_id) VALUES($1,$2)',['web.session_key',result.rows[0].id]);
      return {token:value,expires_at:session.expiresAt};
    });
  });
  app.post('/api/me/token',async(req)=>{
    if(!req.apiUser.session_id)throw httpError(403,'email_login_required');
    limiter.take('token:'+req.apiUser.id,5,600000);
    return db.tx(async(c)=>{
      const user=(await c.query('SELECT enabled FROM users WHERE id=$1 FOR UPDATE',[req.apiUser.id])).rows[0];
      if(!user?.enabled)throw httpError(403,'account_disabled');
      const session=await c.query('SELECT id FROM auth_sessions WHERE id=$1 AND "userId"=$2 AND "expiresAt">now()',
        [req.apiUser.session_id,req.apiUser.auth_user_id]);
      if(!session.rowCount)throw httpError(401,'customer_login_required');
      return issueKey(c,req.apiUser.id,req.body);
    });
  });
}
