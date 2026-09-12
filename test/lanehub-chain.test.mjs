import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { database } from '../src/database.mjs';
import { createApp } from '../src/app.mjs';
import { Upstream } from '../src/upstream.mjs';
import { Scheduler } from '../src/scheduler.mjs';
import { Lanehub } from '../src/lanehub.mjs';
import { reconcileLanehubCharges } from '../src/lanehub-charges.mjs';
import { hash, passwordHash, token } from '../src/security.mjs';

// lanehub 模式下的**整条链**：插件带着自己的令牌发请求 → 自动在 lanehub 建号发新人额度
// → 记下这一单属于哪个插件、烧了多少 token → 扣费从 lanehub 的消费日志补回来
// → 插件作者的分成算得出来。
//
// 这条链断在中间任何一处，表面都看不出来：请求照样成功，只是作者的收益永远是 0。
// 所以这个测试从 HTTP 入口一路验到分成报表的那个数字。
test('lanehub 模式下插件请求的 token 与分成链路', async (t) => {
  assert.ok(process.env.TEST_DB_HOST,'Set TEST_DB_HOST explicitly; tests only use gateway_test database.');
  const schema='chain_'+randomUUID().replaceAll('-','');
  const config={host:process.env.TEST_DB_HOST,port:Number(process.env.TEST_DB_PORT??5432),
    database:'gateway_test',user:process.env.TEST_DB_USER??'gateway',password:process.env.TEST_DB_PASSWORD};
  const setup=database(config);
  await setup.query(`CREATE SCHEMA ${schema}`);
  const db=database({...config,options:`-c search_path=${schema}`});
  const dir=await mkdtemp(join(tmpdir(),'ipzsk-chain-'));

  const PLUGIN_ID='7d8b7d87-b85f-49f1-bde7-a0b1a2f33401';   // schema.sql 里种下的「IPZSK 生图」
  const LANE_BASE='https://lane.test';
  const USD_CNY=6.7078, QUOTA_PER_UNIT=500000, QUOTA_USED=4250;
  let lanehubRequestId=null, quotaAdded=[], relayCalls=0;

  // 假 lanehub：只认这条链真的会打的那几个接口。
  const lanehubFetch=async(url,options={})=>{
    const path=url.slice(LANE_BASE.length);
    const body=options.body?JSON.parse(options.body):null;
    if(path.startsWith('/api/user/?keyword='))
      return Response.json({success:true,data:{data:created?[{id:42,username:created}]:[]}});
    if(path==='/api/user/'){created=body.username;return Response.json({success:true});}
    if(path==='/api/token/for_user')return Response.json({success:true,data:{key:'a'.repeat(48)}});
    if(path.startsWith('/api/user/quota/')){quotaAdded.push(body.quota);return Response.json({success:true});}
    if(path==='/api/user/42')return Response.json({success:true,data:{id:42,quota:357142}});
    if(path==='/api/option/')return Response.json({success:true,data:[{key:'PaymentUSDRate',value:String(USD_CNY)}]});
    if(path.startsWith('/api/log/'))return Response.json({success:true,
      data:{data:new URL(url).searchParams.get('request_id')===lanehubRequestId?[{type:2,quota:QUOTA_USED}]:[]}});
    // 剩下的就是真正的转发：lanehub 当中转，回包形状是 OpenAI 的。
    if(path==='/v1/chat/completions'){
      relayCalls++;
      lanehubRequestId='2026091210'+relayCalls+'xyz';
      return Response.json({id:'chatcmpl-1',object:'chat.completion',choices:[{message:{role:'assistant',content:'ok'}}],
        usage:{prompt_tokens:12,completion_tokens:8,total_tokens:20}},{headers:{'X-Oneapi-Request-Id':lanehubRequestId}});
    }
    throw new Error('unexpected_lanehub_call '+path);
  };
  let created=null;
  const upstream=new Upstream(db,dir,lanehubFetch);
  const lanehub=new Lanehub({baseUrl:LANE_BASE,adminToken:'sk-admin',fetcher:lanehubFetch});
  let app;
  try{
    await db.migrate();
    await db.query('INSERT INTO administrators(id,password_hash) VALUES (1,$1)',[await passwordHash('test-administrator-password')]);

    // 上游账户（lanehub 那条线）、一个客户、一个**插件令牌**、插件的归属与分成比例。
    const accountId=randomUUID();
    await db.query(`INSERT INTO upstream_accounts (id,name,concurrency,base_url,provider_type)
      VALUES ($1,'lanehub',10,$2,'lanehub')`,[accountId,LANE_BASE]);
    const userId=randomUUID(),ownerId=randomUUID();
    await db.query(`INSERT INTO users (id,name,rpm) VALUES ($1,'alice',60),($2,'punk',60)`,[userId,ownerId]);
    await db.query(`INSERT INTO developer_profiles (user_id,display_name,state) VALUES ($1,'Punk','approved')`,[ownerId]);
    await db.query(`UPDATE plugins SET owner_user_id=$1,revenue_share_bps=3000,allowed_models=ARRAY['test-model'] WHERE id=$2`,[ownerId,PLUGIN_ID]);
    const pluginToken=token('ipz_');
    await db.query(`INSERT INTO access_tokens (id,user_id,token_hash,prefix,name,plugin_id)
      VALUES ($1,$2,$3,$4,'插件令牌',$5)`,[randomUUID(),userId,hash(pluginToken),pluginToken.slice(0,12),PLUGIN_ID]);
    await db.query(`INSERT INTO app_settings (key,value) VALUES ('lanehub_mode','on')`);

    app=await createApp({db,upstream,scheduler:new Scheduler({waitMs:10}),origin:'https://api.ipzsk.com',secureCookies:true,
      lanehub,lanehubAccountId:accountId,lanehubSignupCny:5,lanehubUsdCny:USD_CNY,lanehubQuotaPerUnit:QUOTA_PER_UNIT});

    await t.test('插件第一次发请求就建号、发新人额度，并记下这一单属于哪个插件', async () => {
      const response=await app.inject({url:'/v1/chat/completions',method:'POST',
        payload:{model:'test-model',messages:[{role:'user',content:'hi'}]},
        headers:{authorization:'Bearer '+pluginToken}});
      assert.equal(response.statusCode,200,response.body);

      const mapping=(await db.query('SELECT * FROM lanehub_accounts WHERE user_id=$1',[userId])).rows[0];
      assert.equal(mapping?.lanehub_user_id,42,'必须在 lanehub 建出账号');
      const signup=(await db.query(`SELECT quota FROM lanehub_credits WHERE reference=$1`,['signup:'+userId])).rows[0];
      assert.equal(Number(signup?.quota),Math.round((5/USD_CNY)*QUOTA_PER_UNIT),'新人额度按对面汇率折算');

      const request=(await db.query('SELECT * FROM requests WHERE user_id=$1',[userId])).rows[0];
      assert.equal(request.plugin_id,PLUGIN_ID);
      assert.equal(request.plugin_owner_user_id,ownerId,'作者归属要落在请求上，之后改归属不影响历史账');
      assert.equal(request.plugin_share_bps,3000,'分成比例按发生时快照，不读当前值');
      assert.equal(Number(request.total_tokens),20,'token 消耗必须记下来——记账口径就是它');
      assert.equal(request.usage_state,'reported');
    });

    await t.test('重复请求不会重复建号，也不会重复发新人额度', async () => {
      await app.inject({url:'/v1/chat/completions',method:'POST',
        payload:{model:'test-model',messages:[{role:'user',content:'hi again'}]},
        headers:{authorization:'Bearer '+pluginToken}});
      assert.equal(quotaAdded.length,1,'新人额度只能发一次');
      assert.equal((await db.query('SELECT count(*)::int AS n FROM lanehub_accounts')).rows[0].n,1);
    });

    await t.test('扣费从 lanehub 的消费日志补回来，金额按对面汇率折算', async () => {
      // 扫描刻意跳过刚完成 30 秒内的请求（对面的日志可能还没落库），这里把时间往前挪。
      await db.query("UPDATE requests SET completed_at=now()-interval '2 minutes'");
      const result=await reconcileLanehubCharges(db,lanehub,{usdCnyRate:999,quotaPerUnit:QUOTA_PER_UNIT});
      assert.equal(result.settled,1,'只有最后那一单能在日志里查到，另一单等超时后作废');

      const bill=(await db.query(`SELECT * FROM request_billing WHERE state='settled'`)).rows[0];
      const expected=(QUOTA_USED/QUOTA_PER_UNIT*USD_CNY).toFixed(8);
      assert.equal(Number(bill.charged_cny).toFixed(8),expected,'用配的 999 折算就会差几百倍——必须取对面的汇率');
      assert.equal(bill.price_snapshot.quota,QUOTA_USED);

      await reconcileLanehubCharges(db,lanehub,{usdCnyRate:USD_CNY,quotaPerUnit:QUOTA_PER_UNIT});
      assert.equal((await db.query(`SELECT count(*)::int AS n FROM request_billing WHERE state='settled'`)).rows[0].n,1,'重复补记不能多出账单');
    });

    await t.test('插件作者的分成算得出来（这条链的终点）', async () => {
      const login=await app.inject({url:'/admin/api/login',method:'POST',payload:{password:'test-administrator-password'},
        headers:{origin:'https://api.ipzsk.com'}});
      const cookie=login.headers['set-cookie'].split(';')[0];
      const usage=await app.inject({url:'/admin/api/plugin-usage',headers:{cookie,origin:'https://api.ipzsk.com'}});
      assert.equal(usage.statusCode,200,usage.body);
      const row=usage.json().rows.find(r=>r.plugin_id===PLUGIN_ID);
      assert.ok(row,'插件维度要能查到');
      assert.equal(Number(row.total_tokens),40,'两次请求的 token 要汇总');
      const charged=Number((await db.query(`SELECT charged_cny FROM request_billing WHERE state='settled'`)).rows[0].charged_cny);
      assert.equal(Number(row.developer_earnings_cny).toFixed(8),(charged*0.3).toFixed(8),'作者分成 = 实扣 × 30%');
    });

    await t.test('余额读的是 lanehub，不是本地那张只剩充值流水的表', async () => {
      const wallet=await app.inject({url:'/api/me/wallet',headers:{authorization:'Bearer '+pluginToken}});
      // 插件令牌不许碰 /api/me（这条本身也是要守住的边界）
      assert.equal(wallet.statusCode,403,wallet.body);
      const plain=token('ipz_');
      await db.query(`INSERT INTO access_tokens (id,user_id,token_hash,prefix,name) VALUES ($1,$2,$3,$4,'个人凭证')`,
        [randomUUID(),userId,hash(plain),plain.slice(0,12)]);
      const mine=await app.inject({url:'/api/me/wallet',headers:{authorization:'Bearer '+plain}});
      assert.equal(mine.statusCode,200,mine.body);
      assert.equal(mine.json().source,'lanehub');
      assert.equal(mine.json().balance_cny,(357142/QUOTA_PER_UNIT*USD_CNY).toFixed(8));
    });
  } finally {
    await app?.close();
    await db.close();
    await setup.query(`DROP SCHEMA ${schema} CASCADE`);
    await setup.close();
    await rm(dir,{recursive:true,force:true});
  }
});
