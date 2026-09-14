import { refreshMediaTask } from './media-task-sync.mjs';
import { publicImageTask, imageUrls, fetchResultImage } from './image-results.mjs';
import { adaptModelRequest } from './model-catalog.mjs';
import { lanehubMode, provisionCustomer } from './lanehub.mjs';
import { reserveRequest, settleRequest, requestCharge, points, units, decimal } from './billing.mjs';
import { uploadImageReferences } from './image-references.mjs';
import { workspaceChat } from './workspace.mjs';
import { ownedArchivedImage } from './image-archive.mjs';
import { recordSkillInvocations, skillsInRequest } from './earnings.mjs';
import { customerOrigin } from './customer-auth.mjs';
import { randomUUID } from 'node:crypto';
import { checkDesktopSession } from './desktop.mjs';
import { Readable } from 'node:stream';
import { hash, httpError, RateLimiter } from './security.mjs';
import { UsageReader, extractUsage, extractBillingUsage } from './usage.mjs';
import { estimateTextCost, prices } from './text-pricing.mjs';
import { agentRequest, agentResponse, agentHeaders } from './agent-protocols.mjs';
import { uuid } from './validation.mjs';
import { listRequests } from './admin.mjs';
import { audioRequest } from './audio.mjs';
import { imageUpload } from './image-upload.mjs';

async function boundedJson(response, max = 8_000_000) {
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > max) throw new Error('upstream_response_too_large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, stable(value[k])]));
  return value;
}
// 只有上游明确拒绝执行才换渠道：429 限流、401/403 鉴权、402 余额。
// 5xx 说明请求已经到过上游，可能已经建了媒体任务只是回包失败，重发就是第二笔计费。
const retryableStatus = (status) => [401,402,403,429].includes(status);
// 连接阶段就失败，说明请求没有到达上游。ECONNRESET 等中途错误不在其列。
const connectFailed = (error) => ['ECONNREFUSED','ENOTFOUND','EAI_AGAIN'].includes(error?.cause?.code);
export function gatewayRoutes(app, { db, upstream, scheduler, customerAuth, origin, imageStorage = null, lanehub = null, lanehubAccountId = null,
  lanehubSignupCny = 0, lanehubUsdCny = 0, lanehubQuotaPerUnit = 500_000, requestTimeoutMs = 180_000, maxAttempts = 3 }) {
  const limiter = new RateLimiter();
  app.decorateRequest('apiUser', null);
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/v1/') && !req.url.startsWith('/api/me/')) return;
    if(req.url.startsWith('/api/me/')&&!req.headers.authorization&&customerAuth){
      if(!['GET','HEAD'].includes(req.method)&&![origin,customerOrigin].includes(req.headers.origin))throw httpError(403,'origin_denied');
      req.apiUser=await customerAuth.identify(req.headers);
      limiter.take('all:'+req.apiUser.id,120);
      return;
    }
    const header = req.headers.authorization ?? (req.url.startsWith('/v1/messages')&&typeof req.headers['x-api-key']==='string' ? 'Bearer '+req.headers['x-api-key'] : undefined);
    if (typeof header !== 'string' || !/^Bearer ipz_[A-Za-z0-9_-]{43}$/.test(header)) throw httpError(401,'invalid_api_token');
    const tokenHash = hash(header.slice(7));
    const { rows } = await db.query(`SELECT u.id,u.name,u.rpm,t.rpm AS token_rpm,t.id AS token_id,t.auth_session_id,t.plugin_id FROM access_tokens t
      JOIN users u ON u.id=t.user_id WHERE t.token_hash=$1 AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at>now()) AND u.enabled`, [tokenHash]);
    if (!rows.length) throw httpError(401,'invalid_api_token');
    await checkDesktopSession(db,rows[0]);
    if(rows[0].plugin_id && req.url.startsWith('/api/me/'))throw httpError(403,'plugin_scope_denied');
    req.apiUser = rows[0];
    limiter.take('all:' + rows[0].id, 120);
    if (req.method === 'POST') {limiter.take('chat:' + rows[0].id, rows[0].rpm);if(rows[0].token_rpm)limiter.take('key:'+rows[0].token_id,rows[0].token_rpm);}
  });
  app.get('/v1/models', async () => {
    const { rows } = await db.query(`SELECT DISTINCT unnest(k.models) AS model FROM upstream_keys k
      JOIN upstream_accounts a ON a.id=k.account_id WHERE k.enabled AND a.enabled ORDER BY model`);
    return { object: 'list', data: rows.map((r) => ({ id:r.model, object:'model', owned_by:'ipzsk' })) };
  });
  app.get('/api/me/usage', async (req) => {
    const records = await listRequests(db, req.query, req.apiUser.id);
    // Public user responses do not expose the upstream pool's identity.
    records.rows = records.rows.map(({ key_name, upstream_id, cost_cny, cost_reference, cost_recorded_at, estimated_cost_cny, pricing_details, ...row }) => ({...row,charged_points:points(row.charged_cny)}));
    const summary = (await db.query(`SELECT count(*) AS requests,coalesce(sum(input_tokens),0) AS input_tokens,
      coalesce(sum(output_tokens),0) AS output_tokens,coalesce(sum(total_tokens),0) AS total_tokens,
      count(*) FILTER(WHERE usage_state='unknown') AS unknown FROM requests WHERE user_id=$1`, [req.apiUser.id])).rows[0];
    return { ...records, summary };
  });
  // ── 网页（官网）专用接口：按 upstream_id 查一组回复的账、按请求查账 ──
  app.post('/api/me/message-billing',async req=>{
    const ids=req.body?.response_ids;
    if(!Array.isArray(ids)||!ids.length||ids.length>128||ids.some(id=>typeof id!=='string'||!id.length||id.length>200))throw httpError(400,'invalid_response_ids');
    const unique=[...new Set(ids)];
    const rows=(await db.query(`SELECT r.id AS request_id,r.upstream_id,r.model,r.input_tokens,r.output_tokens,b.state AS billing_state,b.charged_cny
      FROM requests r LEFT JOIN request_billing b ON b.request_id=r.id WHERE r.user_id=$1 AND r.upstream_id=ANY($2::text[])`,[req.apiUser.id,unique])).rows;
    const complete=rows.length===unique.length&&unique.every(id=>rows.filter(r=>r.upstream_id===id).length===1)&&rows.every(r=>r.charged_cny!==null&&['settled','released'].includes(r.billing_state));
    const amount=complete?decimal(rows.reduce((sum,r)=>sum+units(r.charged_cny),0n)):null;
    return {billing_state:complete?'settled':'pending',charged_points:points(amount),rows:rows.map(({upstream_id,charged_cny,...r})=>({...r,charged_points:points(charged_cny)}))};
  });
  app.get('/api/me/requests/:id',async req=>requestCharge(db,uuid(req.params.id),req.apiUser.id));
  for(const imagePath of ['/v1/tasks/:id/image/:index','/api/me/tasks/:id/image/:index'])app.get(imagePath, async (req,reply) => {
    const id=uuid(req.params.id);
    if (imageStorage) {
      const archived = await ownedArchivedImage(db,req.apiUser,id,Number(req.params.index));
      if (archived) {
        if(req.url.startsWith('/api/me/')){const image=await fetchResultImage(imageStorage.getUrl(archived.object_key));return reply.type(image.type).send(image.body);}
        return reply.redirect(imageStorage.getUrl(archived.object_key));
      }
    }
    if(!/^[0-9]{1,2}$/.test(req.params.index))throw httpError(404,'image_not_found');
    const task=(await db.query(`SELECT t.result FROM media_tasks t JOIN requests r ON r.id=t.id
      WHERE t.id=$1 AND r.user_id=$2 AND t.status='completed' AND ($3::uuid IS NULL OR r.plugin_id=$3)`,[id,req.apiUser.id,req.apiUser.plugin_id??null])).rows[0];
    const url=imageUrls(task?.result)[Number(req.params.index)];
    if(!url)throw httpError(404,'image_not_found');
    const image=await fetchResultImage(url);
    return reply.type(image.type).send(image.body);
  });
  // /api/videos/tasks?task_id= 是官网视频页的轮询入口（同一份任务，只是用 query 传 id）。
  for(const taskPath of ['/v1/tasks/:id','/api/me/tasks/:id','/api/videos/tasks'])app.get(taskPath, async (req) => {
    const id=uuid(req.params.id ?? req.query?.task_id);
    const task=(await db.query(`SELECT t.*,k.secret_ref FROM media_tasks t
      JOIN requests r ON r.id=t.id JOIN upstream_keys k ON k.id=r.key_id
      WHERE t.id=$1 AND r.user_id=$2 AND ($3::uuid IS NULL OR r.plugin_id=$3)`,[id,req.apiUser.id,req.apiUser.plugin_id??null])).rows[0];
    if(!task)throw httpError(404,'task_not_found');
    await refreshMediaTask(db,upstream,id).catch(()=>{});
    const saved=(await db.query('SELECT status,result FROM media_tasks WHERE id=$1',[id])).rows[0];
    return {code:200,data:publicImageTask(saved.result??{id,status:saved.status,progress:0,result:null},origin),billing:await requestCharge(db,id,req.apiUser.id)};
  });
  app.addContentTypeParser(/^multipart\/form-data(?:;|$)/i,{parseAs:'buffer'},(req,body,done)=>{
    if(!['/v1/audio/transcriptions','/v1/images/edits','/v1/images/generations','/api/me/images/generations'].includes(req.url.split('?')[0]))return done(httpError(415,'unsupported_content_type'));
    done(null,body);
  });
  for (const routePath of ['/api/me/workspace/chat','/api/me/chat/completions','/api/me/image-prompt','/api/me/images/generations','/api/videos/generations','/v1/chat/completions','/v1/responses','/v1/messages','/v1/images/generations','/v1/images/edits','/v1/videos/generations','/v1/audio/transcriptions']) app.post(routePath, {bodyLimit:routePath==='/v1/audio/transcriptions'?26_000_000:32_000_000}, async (req, reply) => {
    // /api/me/* 是官网走 cookie 会话的入口；形状与 /v1/* 相同，只是多了几步网页专属的预处理。
    const webPrompt=routePath==='/api/me/image-prompt';
    if(webPrompt){
      const prompt=req.body?.prompt;
      if(typeof prompt!=='string'||!prompt.trim()||prompt.length>16000)throw httpError(400,'invalid_prompt');
      req.body={model:'gpt-5',stream:false,max_completion_tokens:4000,reasoning_effort:'minimal',messages:[{role:'system',content:'你是生图提示词编辑。将用户需求扩展为准确、可执行的简体中文生图提示词，保留主体、画幅、文字和限制。只输出最终提示词。'},{role:'user',content:prompt}]};
    }
    const workspace=routePath==='/api/me/workspace/chat';
    let workspaceId;
    if(workspace){
      if(!req.apiUser.session_id)throw httpError(403,'email_login_required');
      workspaceId=req.body?.request_id;uuid(workspaceId);
      // 报价版本/预算由页面带来；lanehub 模式下对面扣费，这里只校验形状不拿它预扣。
      const {budget_cny,policy_version}=req.body;
      if(!Number.isSafeInteger(policy_version)||(budget_cny!==null&&(typeof budget_cny!=='string'||!/^\d{1,10}\.\d{8}$/.test(budget_cny))))throw httpError(400,'workspace_quote_required');
      req.body=workspaceChat(req.body);
    }
    const path=workspace||webPrompt||routePath==='/api/me/chat/completions'?'/v1/chat/completions':['/v1/images/edits','/api/me/images/generations'].includes(routePath)?'/v1/images/generations':routePath==='/api/videos/generations'?'/v1/videos/generations':routePath;
    const image=path==='/v1/images/generations'&&Buffer.isBuffer(req.body)?await imageUpload(req.body,req.headers['content-type']):null;
    if(routePath==='/v1/images/edits'&&!image)throw httpError(400,'invalid_image_upload');
    const audio=path==='/v1/audio/transcriptions'?await audioRequest(req.body,req.headers['content-type']):null;
    // requested 是归一后、尚未按上游参数名改写的 body。计价档位只能从它解析：
    // adaptModelRequest 之后键名已经是上游的，resolveTier 认的是内部名，
    // 拿上游 body 去解析档位会在第一个真正改名的型号上静默回落到最便宜档。
    const requested = audio?.metadata??agentRequest(path,image??req.body);
    // lanehub 模式下**不做字段适配**：canonical 契约本来就是干这件事的，
    // 两层都改名等于改两次，而第二次改的是它不认识的键。
    const viaLanehub = Boolean(lanehub) && await lanehubMode(db);
    const body = audio?.metadata??(viaLanehub?requested:adaptModelRequest(path,requested));
    // 这一轮用到了哪些 skill。客户端只报**事实**（用了什么），算给谁、算多少
    // 全在服务端：登记表里查不到的 skill 当没报过，不报错也不计提。
    // 这样客户端不需要知道插件 id、分成比例，改归属和改价钱也不用发版。
    // 主路径是**扫请求体**：skill 内容以 <skill_content name="..."> 出现在上下文里，
    // 那是可证实的事实。请求头是备用，给不经过 harness 的客户端显式上报用。
    const declaredSkills = String(req.headers['x-ipzsk-skill'] ?? '')
      .split(',').map((ref) => ref.trim()).filter((ref) => /^[A-Za-z0-9._-]{1,200}$/.test(ref));
    const skillRefs = [...new Set([...skillsInRequest(requested), ...declaredSkills])].slice(0, 8);

    // 归属到哪个插件。两条来源：
    //   1. 用插件自己的凭据发请求（生图这类插件自己发请求，天然归属）
    //   2. 主令牌 + X-IPZSK-Plugin-Token 头（skill 型插件：提示词是它给的，
    //      模型请求却由 agent 主循环发出，用的是主令牌）
    //
    // 第 2 条为什么不是「头里带个 plugin_id 就认」：那样任何人都能把自己的消费
    // 记到任意插件头上，而插件作者按这个数分钱——等于给伪造者选一个收款人。
    // 所以声明归属必须**出示那个插件的凭据**，而且凭据必须属于同一个用户。
    const declared=req.headers['x-ipzsk-plugin-token'];
    let pluginId=req.apiUser.plugin_id;
    if(!pluginId&&typeof declared==='string'){
      if(!/^ipz_[A-Za-z0-9_-]{43}$/.test(declared))throw httpError(400,'invalid_plugin_token');
      const claim=(await db.query(`SELECT plugin_id FROM access_tokens WHERE token_hash=$1 AND user_id=$2
        AND plugin_id IS NOT NULL AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())`,
      [hash(declared),req.apiUser.id])).rows[0];
      if(!claim)throw httpError(403,'plugin_token_denied');
      pluginId=claim.plugin_id;
    }
    let plugin;
    if(pluginId){
      plugin=(await db.query('SELECT id,publisher_ref,allowed_models,owner_user_id,revenue_share_bps FROM plugins WHERE id=$1 AND enabled',[pluginId])).rows[0];
      if(!plugin || !plugin.allowed_models.includes(body.model))throw httpError(403,'plugin_model_denied');
    }
    const protocolHeaders=agentHeaders(path,req.headers);
    if(audio)protocolHeaders['Content-Type']=audio.contentType;
    const id = randomUUID(), started = Date.now();
    const idempotency = workspace ? 'workspace:'+workspaceId : req.headers['idempotency-key'] ?? null;
    if (idempotency !== null && (typeof idempotency !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(idempotency))) {
      throw httpError(400,'invalid_idempotency_key');
    }
    const fingerprint = hash(JSON.stringify(stable({path,body,...(plugin?{plugin_id:plugin.id}:{})})));
    const inserted = await db.query(`INSERT INTO requests (id,user_id,model,idempotency_key,fingerprint,stream,access_token_id,plugin_id,plugin_publisher_ref,plugin_owner_user_id,plugin_share_bps)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(user_id,idempotency_key) DO NOTHING RETURNING id`,
    [id,req.apiUser.id,body.model,idempotency,fingerprint,body.stream,req.apiUser.token_id,plugin?.id??null,plugin?.publisher_ref??null,plugin?.owner_user_id??null,plugin?.revenue_share_bps??null]);
    if (!inserted.rowCount) {
      const old = (await db.query('SELECT id,fingerprint,status FROM requests WHERE user_id=$1 AND idempotency_key=$2',
        [req.apiUser.id,idempotency])).rows[0];
      reply.header('X-Request-Id', old.id);
      return reply.code(409).send({ error: { code:old.fingerprint === fingerprint ? 'request_already_received' : 'idempotency_conflict',
        message:'Request already recorded; inspect its status before retrying.', request_id:old.id, status:old.status } });
    }
    reply.header('X-Request-Id',id);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('request_timeout')), requestTimeoutMs);
    const disconnect = () => { if (!reply.raw.writableFinished) controller.abort(new Error('client_disconnected')); };
    reply.raw.on('close', disconnect);
    let lease, attemptId, submitted = false, finalized = false;
    let upstreamId, httpStatus, observedUsage,billingUsage,responseTier;
    const cleanup = () => { clearTimeout(timeout); reply.raw.off('close',disconnect); lease?.release(); if (submitted) upstream.refreshSoon(); };
    const finalize = async (status, usage, errorCode = null) => {
      if (finalized) return;
      const estimate=estimateTextCost(body.model,billingUsage,{status,serviceTier:responseTier??body.service_tier,
        billableTools:body.tools?.some(t=>typeof t.type==='string'&&t.type!=='function')});
      // Commit before setting finalized, so an uncertain result remains visible on failure.
      await db.tx(async (c) => {
        await c.query(`UPDATE requests SET status=$2,usage_state=$3,input_tokens=$4,output_tokens=$5,total_tokens=$6,
          upstream_id=$7,upstream_http=$8,error_code=$9,duration_ms=$10,completed_at=now(),
          estimated_cost_cny=$11,pricing_details=$12 WHERE id=$1`,
        [id,status,usage ? 'reported' : (submitted ? 'unknown' : 'not_executed'),usage?.input ?? null,
          usage?.output ?? null,usage?.total ?? null,upstreamId ?? null,httpStatus ?? null,errorCode,Date.now()-started,
          estimate.amount,JSON.stringify(estimate.details)]);
        await settleRequest(c,id,{status,submitted,errorCode,usage:billingUsage,serviceTier:responseTier??body.service_tier,billableTools:body.tools?.some(t=>t.type!=='function')});
        // skill 计提只认**真正跑成**的请求：没发出去的（参数错、余额不足）和中途断流的
        // 都不算一次调用——断流那次用户什么都没拿到，不该给作者记一笔。
        if(status==='succeeded')await recordSkillInvocations(c,id,skillRefs);
        if (attemptId) await c.query(`UPDATE request_attempts SET upstream_id=$2,http_status=$3,error_code=$4,
          usage=$5,completed_at=now() WHERE id=$1`, [attemptId,upstreamId ?? null,httpStatus ?? null,errorCode,usage ? JSON.stringify(usage) : null]);
      });
      finalized = true;
    };
    try {
      // lanehub 模式下**不预扣**：额度真源在对面，它自己会扣。两边都冻的结果是
      // 同一笔钱冻两次，而用户看到的是这边那份余额——他会觉得钱少了却不知道为什么。
      if(!viaLanehub)await reserveRequest(db,id,req.apiUser.id,body,path,requested);
      const payload = { ...body };
      const media=path==='/v1/images/generations'||path==='/v1/videos/generations';
      if(media)delete payload.stream;
      // Require usage for SSE. Models that omit it remain explicitly unverified.
      if (payload.stream && path==='/v1/chat/completions') payload.stream_options = { ...payload.stream_options, include_usage:true };
      // lanehub 模式：这个客户自己的令牌就是唯一的候选，且**只打一次**。
      // 不换线是对面的硬约束（换线会改变这一单的价钱），这边再换一层等于把它破掉。
      const lanehubRow = viaLanehub
        ? (await provisionCustomer(db, lanehub, upstream, { userId: req.apiUser.id, name: req.apiUser.name,
            accountId: lanehubAccountId, signupCny: lanehubSignupCny, usdCnyRate: lanehubUsdCny, quotaPerUnit: lanehubQuotaPerUnit }))
        : null;
      const attempts = viaLanehub ? 1 : maxAttempts;
      const skip = []; let response = null, failure = null;
      for (let attempt = 0; attempt < attempts; attempt++) {
        // 只有第一次没渠道才是 503；换渠道时拿不到别的 key 就沿用上一次的失败结果。
        const next = lanehubRow
          ? await scheduler.acquire(async () => [{ id: lanehubRow.key_id, account_id: lanehubAccountId, secret_ref: lanehubRow.secret_ref,
              concurrency: 3, account_concurrency: 50, base_url: lanehub.baseUrl, provider_type: 'lanehub' }], controller.signal)
          : await scheduler.acquire(() => upstream.candidates(body.model,skip), controller.signal)
            .catch((error) => { if (attempt === 0 || controller.signal.aborted) throw error; return null; });
        if (!next) break;
        lease?.release(); lease = next;
        controller.signal.throwIfAborted();
        if(req.apiUser.session_id){
          // 网页会话（cookie）：没有 access_token 行可查，重新识别一次会话还活着即可。
          const current=await customerAuth.identify(req.headers);
          if(current.id!==req.apiUser.id||current.session_id!==req.apiUser.session_id)throw httpError(401,'customer_login_required');
        }else{
          const stillValid = await db.query(`SELECT t.id,t.user_id,t.auth_session_id,t.plugin_id FROM access_tokens t JOIN users u ON u.id=t.user_id
            WHERE t.id=$1 AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at>now()) AND u.enabled`, [req.apiUser.token_id]);
          if (!stillValid.rowCount) throw httpError(401,'invalid_api_token');
          await checkDesktopSession(db,stillValid.rows[0]);
        }
        attemptId = randomUUID();
        await db.tx(async (c) => {
          await c.query('UPDATE access_tokens SET last_used_at=now() WHERE id=$1',[req.apiUser.token_id]);
          await c.query("UPDATE requests SET status='running',key_id=$2 WHERE id=$1", [id,lease.row.id]);
          await c.query('INSERT INTO request_attempts (id,request_id,key_id) VALUES ($1,$2,$3)', [attemptId,id,lease.row.id]);
        });
        // 网页生图带 data:URL 参考图时先传到上游的上传接口换成 URL（标准版只收 URL）。
        // 官网对**所有**生图型号都用 image_urls 带参考图（data: URL），上游只收 https URL：
        // 只要带了 data: 就先经 APIMart 的上传接口换成 URL，与型号无关。
        if(path==='/v1/images/generations' && Array.isArray(payload.image_urls) && payload.image_urls.some((u)=>typeof u==='string'&&u.startsWith('data:'))){
          // lanehub 模式下 lease.row 是 lanehub 的令牌，而 lanehub 没有 /v1/uploads/images；
          // 上传这一步直接用网关自己留着的 APIMart key（只传图不计费，计费仍在 lanehub 那一单）。
          const uploadRow = viaLanehub
            ? (await upstream.candidates(payload.model)).find((r) => r.provider_type === 'apimart')
            : lease.row;
          if (!uploadRow) throw httpError(503, 'reference_upload_unavailable');
          payload.image_urls=await uploadImageReferences(upstream,uploadRow,payload.image_urls,controller.signal);
        }
        submitted = true;
        response = await upstream.request(lease.row, path, {
          method:'POST', body:audio?.payload??JSON.stringify(payload), headers:protocolHeaders, signal:controller.signal,
        }).catch((error) => {
          // 连接根本没建立时上游不可能执行过；其他错误一律当作已提交，绝不重放。
          if (controller.signal.aborted || !connectFailed(error)) throw error;
          submitted = false; return null;
        });
        httpStatus = response?.status ?? null;
        upstreamId = response?.headers.get('x-oneapi-request-id')?.slice(0,200) ?? null;
        // lanehub 模式下这个头就是**对面的** request id，而扣费正是按它反查回来的
        // （lanehub-charges.mjs）。下面几处会用响应体里的 id 覆盖它——那是上游的上游的
        // id，查不到任何账。所以 lanehub 模式下一律不覆盖。
        const keepUpstreamId = viaLanehub;
        if (response?.ok) { failure = null; break; }
        if (response) {
          await response.body?.cancel();
          await upstream.markFailure(lease.row,response.status,response.headers.get('retry-after'));
        }
        failure = response ? `upstream_http_${response.status}` : 'upstream_connect_failed';
        // lanehub 那条线一律不换（上面 attempts=1 已经保证，这里是第二道闸）
        if (viaLanehub || (response && !retryableStatus(response.status))) break;
        skip.push(lease.row.id);
        await db.query('UPDATE request_attempts SET upstream_id=$2,http_status=$3,error_code=$4,completed_at=now() WHERE id=$1',
          [attemptId,upstreamId,httpStatus,failure]);
      }
      if (failure) {
        await finalize('failed',null,failure);
        cleanup();
        return reply.code(httpStatus === 429 ? 429 : 502).send({ error: { code:failure,message:'Upstream request failed.',request_id:id } });
      }
      if (body.stream) {
        if (!response.headers.get('content-type')?.includes('text/event-stream')) {
          await response.body?.cancel(); throw new Error('invalid_stream_response');
        }
        const parser = new UsageReader(path==='/v1/messages'?'messages':path==='/v1/responses'?'responses':'chat');
        reply.type('text/event-stream').header('Cache-Control','no-store').header('X-Accel-Buffering','no');
        async function* relay() {
          let totalBytes = 0;
          try {
            for await (const chunk of response.body) {
              totalBytes += chunk.length;
              if (totalBytes > 16_000_000) throw new Error('upstream_response_too_large');
              parser.push(chunk);
              billingUsage=parser.billingUsage;responseTier=parser.serviceTier;
              // The source and destination both use backpressure through Readable.from.
              yield chunk;
            }
            parser.finish();
            billingUsage=parser.billingUsage;responseTier=parser.serviceTier;
            observedUsage = parser.usage;
            if(!viaLanehub)upstreamId = parser.upstreamId ?? upstreamId;
            const complete = parser.done && !parser.failed;
            await finalize(complete ? 'succeeded' : 'uncertain',parser.usage,complete ? null : 'stream_incomplete');
          } catch {
            if(!viaLanehub)upstreamId = parser.upstreamId ?? upstreamId;
            await finalize('uncertain',parser.usage,'stream_interrupted');
          } finally {
            if (!finalized) await finalize('uncertain',parser.usage,'stream_interrupted').catch(() => app.log.error({request_id:id},'accounting_failed'));
            controller.abort(); cleanup();
          }
        }
        const output = Readable.from(relay());
        output.once('close', () => {
          controller.abort();
          if (!finalized) finalize('uncertain',parser.usage,'stream_interrupted')
            .catch(() => app.log.error({request_id:id},'accounting_failed')).finally(cleanup);
          else cleanup();
        });
        return reply.send(output);
      }
      if(audio&&!['json','verbose_json'].includes(body.response_format)){
        const chunks=[];let size=0;
        for await(const chunk of response.body){size+=chunk.length;if(size>8_000_000)throw new Error('upstream_response_too_large');chunks.push(chunk);}
        await finalize('succeeded',null);cleanup();
        return reply.type(body.response_format==='vtt'?'text/vtt; charset=utf-8':'text/plain; charset=utf-8').send(Buffer.concat(chunks).toString('utf8'));
      }
      const raw = await boundedJson(response);
      const value = agentResponse(path,raw);
      if(media) {
        const taskId=value.data[0].task_id;
        // 任务 id 另有 media_tasks.upstream_task_id 存着，这里不会丢。
        if(!viaLanehub)upstreamId=taskId;
        await db.query('INSERT INTO media_tasks(id,upstream_task_id,kind) VALUES($1,$2,$3)',[id,taskId,path.includes('/images/')?'image':'video']);
        await finalize('succeeded',null);
        cleanup();
        return reply.send({code:200,data:[{status:'submitted',task_id:id}]});
      }
      observedUsage = extractUsage(value);
      billingUsage = extractBillingUsage(value);responseTier=value.service_tier;
      if(!viaLanehub&&typeof value.id === 'string')upstreamId = value.id.slice(0,200);
      await finalize('succeeded',observedUsage);
      cleanup();
      // 网页入口把这一单的账一起带回去（点数在回复旁显示）；/v1/* 保持 OpenAI 原样。
      if(routePath.startsWith('/api/me/')){
        const billing=await requestCharge(db,id,req.apiUser.id);
        return reply.send(webPrompt?{prompt:value.choices?.[0]?.message?.content,billing}:{...value,billing});
      }
      return reply.send(value);
    } catch (error) {
      await finalize(submitted ? 'uncertain' : 'failed',observedUsage,
        submitted ? 'upstream_result_uncertain' : (error.statusCode ? error.code : 'request_cancelled'))
        .catch(() => app.log.error({request_id:id},'accounting_failed'));
      controller.abort(); cleanup();
      throw httpError(submitted ? 502 : (error.statusCode ?? 408),submitted ? 'upstream_result_uncertain' : (error.code ?? 'request_cancelled'));
    }
  });
}
