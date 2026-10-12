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

    await t.test('skill 型插件：主令牌 + 插件凭据声明归属，token 消耗记到插件头上', async () => {
      // skill 装成插件之后，提示词是它给的，模型请求却由 agent 主循环用**主令牌**发出。
      // 这条路让它出示插件凭据来声明归属——只带一个 plugin_id 是不行的，
      // 那样谁都能把消费记到任意插件头上，而作者按这个数分钱。
      const personal=token('ipz_');
      await db.query(`INSERT INTO access_tokens (id,user_id,token_hash,prefix,name) VALUES ($1,$2,$3,$4,'主令牌')`,
        [randomUUID(),userId,hash(personal),personal.slice(0,12)]);
      const pluginCredential=token('ipz_');
      await db.query(`INSERT INTO access_tokens (id,user_id,token_hash,prefix,name,plugin_id) VALUES ($1,$2,$3,$4,'skill 凭据',$5)`,
        [randomUUID(),userId,hash(pluginCredential),pluginCredential.slice(0,12),PLUGIN_ID]);
      const ask=(extra)=>app.inject({url:'/v1/chat/completions',method:'POST',
        payload:{model:'test-model',messages:[{role:'user',content:'skill'}]},
        headers:{authorization:'Bearer '+personal,...extra}});

      const attributed=await ask({'x-ipzsk-plugin-token':pluginCredential});
      assert.equal(attributed.statusCode,200,attributed.body);
      const row=(await db.query(`SELECT plugin_id,plugin_owner_user_id,plugin_share_bps,total_tokens FROM requests
        WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`,[userId])).rows[0];
      assert.equal(row.plugin_id,PLUGIN_ID,'归属要落到插件上');
      assert.equal(row.plugin_owner_user_id,ownerId);
      assert.equal(row.plugin_share_bps,3000);
      assert.equal(Number(row.total_tokens),20,'token 消耗照常记下来');

      // 不带头就是普通调用，不归属任何插件。
      assert.equal((await ask({})).statusCode,200);
      assert.equal((await db.query(`SELECT plugin_id FROM requests WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`,[userId])).rows[0].plugin_id,null);

      // 别人的插件凭据不认（否则等于给伪造者选一个收款人）。
      const stranger=randomUUID();
      await db.query(`INSERT INTO users (id,name,rpm) VALUES ($1,'别人',60)`,[stranger]);
      const otherCredential=token('ipz_');
      await db.query(`INSERT INTO access_tokens (id,user_id,token_hash,prefix,name,plugin_id) VALUES ($1,$2,$3,$4,'别人的',$5)`,
        [randomUUID(),stranger,hash(otherCredential),otherCredential.slice(0,12),PLUGIN_ID]);
      assert.equal((await ask({'x-ipzsk-plugin-token':otherCredential})).json().error.code,'plugin_token_denied');
      assert.equal((await ask({'x-ipzsk-plugin-token':'ipz_'+'z'.repeat(43)})).json().error.code,'plugin_token_denied');
      assert.equal((await ask({'x-ipzsk-plugin-token':'not-a-token'})).json().error.code,'invalid_plugin_token');
    });

    await t.test('skill 按调用次数计提：普通对话不计，用了 skill 才计', async () => {
      const SKILL = 'ip-workbench-ppt';
      await db.query(`INSERT INTO plugin_skills (skill_ref,plugin_id,display_name) VALUES ($1,$2,'PPT skill')
        ON CONFLICT (skill_ref) DO NOTHING`, [SKILL, PLUGIN_ID]);
      await db.query(`UPDATE plugins SET price_per_call_cny='0.05' WHERE id=$1`, [PLUGIN_ID]);
      const personal = token('ipz_');
      await db.query(`INSERT INTO access_tokens (id,user_id,token_hash,prefix,name) VALUES ($1,$2,$3,$4,'普通令牌')`,
        [randomUUID(), userId, hash(personal), personal.slice(0, 12)]);
      const ask = (content) => app.inject({ url: '/v1/chat/completions', method: 'POST',
        headers: { authorization: 'Bearer ' + personal },
        payload: { model: 'test-model', messages: [{ role: 'user', content }] } });
      const invocations = async () => (await db.query(
        `SELECT e.* FROM plugin_earnings e JOIN requests r ON r.id=e.request_id
         WHERE e.kind='invocation' AND r.user_id=$1 ORDER BY e.created_at DESC`, [userId])).rows;

      // 普通对话：上下文里没有 skill 内容，一分钱都不该计给作者。
      await ask('今天天气怎么样');
      assert.equal((await invocations()).length, 0, '普通对话不能产生计提');

      // 用了 skill：请求体里带着 dsh-skill 渲染的 <skill_content>，这是可证实的事实。
      await ask(`做个 PPT\n<skill_content name="${SKILL}">\n<skill_instructions>按大纲出片</skill_instructions>\n</skill_content>`);
      const rows = await invocations();
      assert.equal(rows.length, 1, '用了 skill 要计一次');
      assert.equal(rows[0].skill_ref, SKILL);
      assert.equal(Number(rows[0].amount_cny), 0.05, '按次数计价，与烧了多少 token 无关');
      assert.equal(rows[0].owner_user_id, ownerId);

      // 没登记过的 skill 当没报过：skills 是本地文件，谁都能往目录里扔一个。
      await ask('随便写点\n<skill_content name="someone-elses-local-skill">\n</skill_content>');
      assert.equal((await invocations()).length, 1, '未登记的 skill 不能计提');
      // 但要**看得见**：有人在大量用一个还没上架的 skill，那是该去谈合作的线索。
      const sighting = (await db.query(`SELECT * FROM skill_sightings WHERE skill_ref=$1`, ['someone-elses-local-skill'])).rows[0];
      assert.ok(sighting && Number(sighting.sightings) >= 1, '未登记的 skill 要记一笔观测');
      assert.equal((await db.query(`SELECT count(*)::int AS n FROM skill_sightings WHERE skill_ref=$1`, [SKILL])).rows[0].n,
        0, '已登记的不该出现在线索表里');

      // agent 跑一轮会发好几次请求，skill 内容一旦加载就留在后续每一次的上下文里。
      // 不去重的话用户说一句话会被计五六次——实测一轮 6 步计了 5 次，金额翻五倍。
      for (let step = 0; step < 4; step++) await ask(`第 ${step} 步\n<skill_content name="${SKILL}">\n</skill_content>`);
      assert.equal((await invocations()).length, 1, '同一轮的后续每一步都不该再计一次');

      // 窗口之外就是新的一次调用：把上一条计提的时间往前挪，模拟十分钟后再用。
      await db.query(`UPDATE plugin_earnings SET created_at=now()-interval '2 hours' WHERE kind='invocation'`);
      await ask(`过了很久再来\n<skill_content name="${SKILL}">\n</skill_content>`);
      assert.equal((await invocations()).length, 2, '窗口之外要算新的一次');

      // 单价为 0 时仍然记一行：「这次用了哪个 skill」本身就是要统计的事实。
      await db.query(`UPDATE plugins SET price_per_call_cny=0 WHERE id=$1`, [PLUGIN_ID]);
      await db.query(`UPDATE plugin_earnings SET created_at=now()-interval '2 hours' WHERE kind='invocation'`);
      await ask(`再来一次\n<skill_content name="${SKILL}">\n</skill_content>`);
      const zero = (await invocations())[0];
      assert.equal(Number(zero.amount_cny), 0);
      assert.equal(zero.skill_ref, SKILL);
    });

    await t.test('人工退款：钱回到用户额度，作者的计提同额冲掉', async () => {
      const login=await app.inject({url:'/admin/api/login',method:'POST',payload:{password:'test-administrator-password'},
        headers:{origin:'https://api.ipzsk.com'}});
      const cookie=login.headers['set-cookie'].split(';')[0];
      const bill=(await db.query(`SELECT request_id,charged_cny FROM request_billing WHERE state='settled'`)).rows[0];
      const accrued=Number((await db.query(`SELECT sum(amount_cny) AS n FROM plugin_earnings WHERE owner_user_id=$1`,[ownerId])).rows[0].n);
      assert.ok(accrued>0,'先得有计提，才谈得上冲销');

      const before=quotaAdded.length;
      const refund=await app.inject({url:'/admin/api/billing/'+bill.request_id+'/refund',method:'POST',
        headers:{cookie,origin:'https://api.ipzsk.com'},payload:{amount_cny:'0.02000000',reason:'用户反馈图片不可用'}});
      assert.equal(refund.statusCode,200,refund.body);
      assert.equal(quotaAdded.length,before+1,'钱必须真的回到用户的 lanehub 额度');

      const after=Number((await db.query(`SELECT sum(amount_cny) AS n FROM plugin_earnings WHERE owner_user_id=$1`,[ownerId])).rows[0].n);
      assert.equal(Number((after-accrued).toFixed(8)),-0.006,'作者按同样比例被冲回 30%');
      assert.equal(Number((await db.query('SELECT refunded_cny FROM request_billing WHERE request_id=$1',[bill.request_id])).rows[0].refunded_cny),0.02);
      // charged_cny 是「当时收了多少」的事实，不能被退款改掉。
      assert.equal((await db.query('SELECT charged_cny FROM request_billing WHERE request_id=$1',[bill.request_id])).rows[0].charged_cny,bill.charged_cny);

      // 退不出比收的还多。
      const over=await app.inject({url:'/admin/api/billing/'+bill.request_id+'/refund',method:'POST',
        headers:{cookie,origin:'https://api.ipzsk.com'},payload:{amount_cny:'99',reason:'超额退款应当被拒'}});
      assert.equal(over.statusCode,409,over.body);
    });

    await t.test('无插件归属的请求：多次部分退款都必须真的回到 lanehub', async () => {
      // 回归：退款幂等键曾经用「refund 计提行数」当序号。没有插件归属的请求永远没有计提行，
      // 第二次部分退款会撞上第一次的 reference `refund:<id>:0`，被 creditAccount 静默吞掉——
      // 账面记了退款、用户没拿到钱。绝大多数普通用户的请求都没有插件归属。
      const login=await app.inject({url:'/admin/api/login',method:'POST',payload:{password:'test-administrator-password'},
        headers:{origin:'https://api.ipzsk.com'}});
      const cookie=login.headers['set-cookie'].split(';')[0];
      const requestId=randomUUID();
      await db.query(`INSERT INTO requests(id,user_id,model,status,fingerprint,stream) VALUES($1,$2,'test-model','succeeded','fp-refund',false)`,[requestId,userId]);
      await db.query(`INSERT INTO request_billing(request_id,user_id,state,reserved_cny,charged_cny,price_snapshot)
        VALUES($1,$2,'settled',1,1,'{}')`,[requestId,userId]);
      const before=quotaAdded.length;
      const refund=(amount)=>app.inject({url:'/admin/api/billing/'+requestId+'/refund',method:'POST',
        headers:{cookie,origin:'https://api.ipzsk.com'},payload:{amount_cny:amount,reason:'测试多次部分退款'}});
      assert.equal((await refund('0.20000000')).statusCode,200);
      assert.equal((await refund('0.30000000')).statusCode,200);
      assert.equal(quotaAdded.length,before+2,'两次退款各自要加一次 lanehub 额度');
      assert.equal(Number((await db.query('SELECT refunded_cny FROM request_billing WHERE request_id=$1',[requestId])).rows[0].refunded_cny),0.5);
    });

    await t.test('结算单：起草 → 冻结 → 打款；冻结之后的退款落到下一张单', async () => {
      const login=await app.inject({url:'/admin/api/login',method:'POST',payload:{password:'test-administrator-password'},
        headers:{origin:'https://api.ipzsk.com'}});
      const cookie=login.headers['set-cookie'].split(';')[0];
      const admin=(url,method='GET',payload)=>app.inject({url:'/admin/api'+url,method,payload,headers:{cookie,origin:'https://api.ipzsk.com'}});

      const open=(await admin('/settlements')).json().pending.find(p=>p.owner_user_id===ownerId);
      assert.ok(Number(open.amount_cny)>0,'先看得到还没出单的计提');

      const draft=(await admin('/settlements','POST',{owner_user_id:ownerId,from:'2000-01-01',to:'2099-12-31'})).json();
      assert.equal(Number(draft.amount_cny),Number(open.amount_cny),'出单金额 = 未归属的计提合计');
      assert.equal((await admin('/settlements')).json().pending.length,0,'圈进去之后就不再是待出单');

      // 同一条明细不能进两张单：紧接着再出一张，只能是空的。
      const second=(await admin('/settlements','POST',{owner_user_id:ownerId,from:'2000-01-01',to:'2099-12-31'})).json();
      assert.equal(Number(second.amount_cny),0);
      assert.equal((await admin('/settlements/'+second.id+'/void','POST',{reason:'重复出单，作废'})).statusCode,200);

      assert.equal((await admin('/settlements/'+draft.id+'/pay','POST',{paid_note:'未冻结不能打款'})).statusCode,409);
      const frozen=(await admin('/settlements/'+draft.id+'/freeze','POST',{})).json();
      assert.equal(Number(frozen.amount_cny),Number(draft.amount_cny));

      // 冻结之后再退款：不回溯改这张单，作为一条负数计提等下一张单。
      const bill=(await db.query(`SELECT request_id FROM request_billing WHERE state='settled'`)).rows[0];
      assert.equal((await admin('/billing/'+bill.request_id+'/refund','POST',{amount_cny:'0.01000000',reason:'第二次部分退款'})).statusCode,200);
      const after=(await admin('/settlements/'+draft.id)).json().settlement;
      assert.equal(Number(after.amount_cny),Number(frozen.amount_cny),'已冻结的金额不能被事后改掉');
      const nextPending=(await admin('/settlements')).json().pending.find(p=>p.owner_user_id===ownerId);
      assert.equal(Number(nextPending.amount_cny),-0.003,'冲销落到下一张单里');

      assert.equal((await admin('/settlements/'+draft.id+'/pay','POST',{paid_note:'微信转账 2026-09-12 单号 X1'})).statusCode,200);
      assert.equal((await admin('/settlements/'+draft.id+'/void','POST',{reason:'已打款的单不能作废'})).statusCode,409);

      // 作者视角那条路要浏览器登录态，API 令牌打不开（开发者后台的既有约束）。
      const plain=token('ipz_');
      await db.query(`INSERT INTO access_tokens (id,user_id,token_hash,prefix,name) VALUES ($1,$2,$3,$4,'作者凭证')`,
        [randomUUID(),ownerId,hash(plain),plain.slice(0,12)]);
      const mine=await app.inject({url:'/api/me/developer/settlements',headers:{authorization:'Bearer '+plain}});
      assert.equal(mine.statusCode,403,'开发者后台只认登录会话');

      const paid=(await admin('/settlements?owner_user_id='+ownerId)).json();
      const one=paid.rows.find(r=>r.id===draft.id);
      assert.equal(one.state,'paid');
      // 区间是 DATE 列，驱动会把它变成带时区的 Date（页面上会差一天）——必须原样是日期串。
      assert.equal(one.period_from,'2000-01-01');
      assert.equal(one.period_to,'2099-12-31');
      assert.ok(one.paid_note.includes('X1'),'打款凭据要留痕');
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
    await t.test('paid-consumption commission: authenticated plugin and Skill credentials credit BD and author; forged tags cannot select an author', async () => {
      const remaining=(await db.query('SELECT coalesce(sum(remaining_cny),0)::numeric(20,8) AS amount FROM commission_funds WHERE user_id=$1',[userId])).rows[0].amount;
      const drain=randomUUID();
      await db.query("INSERT INTO requests(id,user_id,model,fingerprint,stream,status) VALUES($1,$2,'test-model','drain fixture',false,'succeeded')",[drain,userId]);
      await db.query("INSERT INTO request_billing(request_id,user_id,state,reserved_cny,charged_cny,price_snapshot) VALUES($1,$2,'settled',$3,$3,'{}')",[drain,userId,remaining]);
      const bd=randomUUID(),personal=token('ipz_');
      await db.query("INSERT INTO users(id,name) VALUES($1,'BD fixture')",[bd]);
      await db.query('INSERT INTO referral_profiles(user_id,bd_active) VALUES($1,true)',[bd]);
      await db.query('INSERT INTO referrals(user_id,referrer_id) VALUES($1,$2)',[userId,bd]);
      await db.query('INSERT INTO access_tokens(id,user_id,token_hash,prefix) VALUES($1,$2,$3,$4)',[randomUUID(),userId,hash(personal),personal.slice(0,12)]);
      for(let i=0;i<3;i++) {
        const payment=randomUUID();
        await db.query("INSERT INTO payment_orders(id,user_id,mode,pack_key,product_id,amount_cny,currency,idempotency_key,target,state,credited_at) VALUES($1,$2,'prod','cny_100','fixture',100,'CNY',$1,'local','credited',now())",[payment,userId]);
        await db.query("INSERT INTO wallet_entries(id,user_id,amount_cny,balance_after_cny,source,payment_order_id) VALUES($1,$2,100,100,'payment',$3)",[randomUUID(),userId,payment]);
      }
      await db.query("UPDATE commission_policy SET enabled=true,started_at=coalesce(started_at,now()),ends_at=coalesce(ends_at,now()+interval '1 year')");
      for(const method of ['plugin','skill','forged']) {
        const response=await app.inject({url:'/v1/chat/completions',method:'POST',
          payload:{model:'test-model',messages:[{role:'user',content:'fixture'}]},
          headers:{authorization:'Bearer '+(method==='plugin'?pluginToken:personal),
            ...(method==='skill'?{'x-ipzsk-plugin-token':pluginToken}:{}),
            ...(method==='forged'?{'x-plugin-id':PLUGIN_ID,'x-ipzsk-skill':'ip-workbench-ppt'}:{})}});
        assert.equal(response.statusCode,200,response.body);
        const id=response.headers['x-request-id'];
        assert.ok(id);
        await db.query('UPDATE requests SET cost_cny=40 WHERE id=$1',[id]);
        await db.query("INSERT INTO request_billing(request_id,user_id,state,reserved_cny,charged_cny,price_snapshot) VALUES($1,$2,'settled',100,100,'{}')",[id,userId]);
        const row=(await db.query('SELECT * FROM commission_requests WHERE request_id=$1',[id])).rows[0];
        assert.equal(row.bd_user_id,bd); assert.equal(row.bd_cny,'20.00000000');
        assert.equal(row.developer_user_id,method==='forged'?null:ownerId);
        assert.equal(row.developer_cny,method==='forged'?'0.00000000':'35.00000000');
        assert.equal((await db.query('SELECT count(*) FROM plugin_earnings WHERE request_id=$1',[id])).rows[0].count,'0');
      }
    });
  } finally {
    await app?.close();
    await db.close();
    await setup.query(`DROP SCHEMA ${schema} CASCADE`);
    await setup.close();
    await rm(dir,{recursive:true,force:true});
  }
});
