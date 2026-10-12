import { setupPlugins } from '/admin/plugins.js';
import { setupAccounts } from '/admin/accounts.js';
import { setupWallet } from '/admin/wallet.js';
import { setupCommissions } from '/admin/commissions.js';
const $ = (s) => document.querySelector(s);
const state = { page:'overview',accounts:[],keys:[],users:[],providerTypes:[],requestPage:1,filter:{},edit:null };
const titles = { plugins:['插件市场与用量','PLUGIN MARKET'], management:['账户与账单','ACCOUNTS & BILLING'], wallet:['入账流水','WALLET'], overview:['服务总览','OVERVIEW'],pool:['API 号池','UPSTREAM POOL'],users:['用户管理','USERS'],requests:['调用记录','REQUEST LOG'] };
titles.commissions=['分佣与提现','COMMISSIONS'];
const number = (v) => v === null || v === undefined ? '—' : Number(v).toLocaleString('zh-CN');
const money = (v) => v === null || v === undefined ? '未同步' : Number(v).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})+' 元';
const charge = (v) => v === null || v === undefined ? '待核实' : Number(v).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:8})+' 元';
const time = (v) => v ? new Date(v).toLocaleString('zh-CN',{hour12:false}) : '尚无记录';
const errors = {admin_login_required:'请重新登录。',invalid_password:'密码不正确。',invalid_charge:'请填写非负金额，最多 8 位小数。',charge_not_ready:'请求尚未完成或未发送上游，不能录入扣费。',invalid_api_token:'访问凭证无效。',rate_limited:'操作过于频繁，请稍后再试。',origin_denied:'请求来源不匹配，请使用正式管理台地址。',key_already_exists:'这把 Key 已在号池中。',already_exists:'名称或凭证已存在。',invalid_upstream_key:'请检查 APIMart Key 格式。',internal_error:'服务暂时不可用，请稍后再试。',invalid_models:'请填写至少一个有效模型名称。',invalid_base_url:'上游地址必须是合法的 https 地址，且不带查询参数。',invalid_provider_type:'不支持这个上游类型，请从下拉列表中选择。',
  invalid_reason:'请填写至少 5 个字的操作依据。',invalid_invitation_target:'请填写被邀请用户的邮箱或用户 ID。',invitation_target_not_found:'找不到这个已验证邮箱的网站账户，请让对方先注册并验证邮箱。',
  invitation_already_pending:'该用户已有同身份的待接受邀请，请撤销或重发。',role_already_active:'该用户已经拥有这个身份。',invitation_not_pending:'邀请已被接受、撤销或过期。',
  invitation_already_used:'邀请已被接受，不能重发。',bd_invitation_required:'BD 身份只能通过邀请开通。',invalid_display_name:'开发者名称最多 100 字。',
  invalid_review_transition:'当前状态不能这样处理，批准开发者请改用邀请。'};
function el(tag,text,cls) { const n=document.createElement(tag); if(text!==undefined)n.textContent=text; if(cls)n.className=cls;return n; }
function notice(message,error=false) { const n=$('#notice');n.textContent=message;n.hidden=false;n.className=error?'error':''; }
function loginView() { $('#login-view').hidden=false;$('#console-view').hidden=true;document.querySelectorAll('dialog[open]').forEach((d)=>d.close()); }
async function api(path,method='GET',body) {
  const response=await fetch('/admin/api'+path,{method,credentials:'same-origin',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
  const data=await response.json();
  if(!response.ok) {
    if(response.status===401 && path!=='/login')loginView();
    throw new Error(errors[data.error?.code]??'操作失败：'+(data.error?.code??response.status));
  }
  return data;
}
function action(fn) { return async(event)=>{try{await fn(event);}catch(e){notice(e.message,true);if(event?.target?.closest('dialog'))alert(e.message);}}; }
function button(label,fn,cls='text-button') { const b=el('button',label,cls);b.type='button';b.addEventListener('click',action(fn));return b; }
function cell(text,sub) {const d=el('div',text);if(sub)d.append(el('small',sub,'subtext'));return d;}
function badge(text,type='') {return el('span',text,'badge '+type);}
function table(target,headers,rows) {
  const box=typeof target==='string'?$(target):target;box.replaceChildren();
  if(!rows.length){box.append(el('div','这里还没有数据。','empty'));return;}
  const t=el('table'),head=el('thead'),hr=el('tr'),body=el('tbody');
  headers.forEach((h)=>hr.append(el('th',h)));head.append(hr);
  rows.forEach((row)=>{const tr=el('tr');row.forEach((value)=>{const td=el('td');td.append(value instanceof Node?value:document.createTextNode(String(value??'—')));tr.append(td);});body.append(tr);});
  t.append(head,body);box.append(t);
}
function rowActions(...buttons){const div=el('div',undefined,'row-actions');div.append(...buttons);return div;}
function stale(row){return !row.balance_at||Date.now()-new Date(row.balance_at)>600000||row.balance_error;}
function requestStatus(row){
  const labels={queued:'排队中',running:'处理中',succeeded:'成功',failed:'失败',uncertain:'待核实'};
  const node=cell('');node.append(badge(labels[row.status]??row.status,row.status==='failed'?'bad':row.status==='uncertain'?'warn':row.status==='succeeded'?'':'neutral'));
  if(row.usage_state==='unknown')node.append(el('small','用量待核实','subtext'));
  return node;
}
function renderRequests(target,rows,compact=false) {
  table(target,['时间','用户 / 模型','状态','用户扣款','详情'],rows.map(r=>[
    time(r.created_at),cell(r.user_name,r.model),requestStatus(r),r.charged_cny==null?'未扣款':charge(r.charged_cny),button('查看',()=>showRequest(r.id))
  ]));
}
async function showRequest(id){
  const detail=await api('/requests/'+id);state.detail=id;
  const r=detail.request;table('#request-summary',['项目','内容'],[['模型',r.model],['用户扣款',r.charged_cny==null?'未扣款':charge(r.charged_cny)],['上游实际费用',charge(r.cost_cny)],['上游估算费用',charge(r.estimated_cost_cny)],['输入 / 输出 token',`${number(r.input_tokens)} / ${number(r.output_tokens)}`]]);
  $('#request-detail').textContent=JSON.stringify(detail,null,2);
  const form=$('#charge-form');form.reset();form.elements.cost_cny.value=detail.request.cost_cny??'';
  form.elements.cost_reference.value=detail.request.cost_reference??'';
  form.hidden=['queued','running'].includes(detail.request.status)||!detail.attempts.length;
  if(!$('#detail-dialog').open)$('#detail-dialog').showModal();
}
function cellWithButton(label,sub,fn){const d=el('div');d.append(button(label,fn),el('small',sub,'subtext'));return d;}
async function overview(){
  const d=await api('/overview');$('#metrics').replaceChildren();
  [['上游账户余额',money(d.accounts.remain_credits),Number(d.accounts.stale)?`${d.accounts.stale} 个账户待同步，当前为部分合计`:'用于支付模型调用费用'],
    ['今日失败',number(d.requests.today_failed),'在调用记录中查看原因'],
    ['今日请求',number(d.requests.today),'全部已受理请求'],['今日 token',number(d.requests.today_tokens),'已确认的输入与输出总量']].forEach(([label,value,small])=>{
      const card=el('article',undefined,'metric');card.append(el('p',label),el('strong',value),el('small',small));$('#metrics').append(card);
    });
  const stats=[['进行中的请求',d.active],['排队请求',d.queue],['今日成功 / 失败',`${d.requests.today_success} / ${d.requests.today_failed}`],['待核实用量（累计）',d.requests.unknown],['平均响应耗时',d.requests.avg_ms?`${(d.requests.avg_ms/1000).toFixed(1)} 秒`:'—']];
  $('#runtime-stats').replaceChildren(...stats.map(([k,v])=>{const row=el('div',undefined,'stat-row');row.append(el('span',k),el('strong',String(v)));return row;}));
  const values=[];const today=new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Shanghai'}));
  for(let i=6;i>=0;i--){const day=new Date(today);day.setDate(day.getDate()-i);const key=`${day.getFullYear()}-${String(day.getMonth()+1).padStart(2,'0')}-${String(day.getDate()).padStart(2,'0')}`;values.push({day:key,tokens:Number(d.chart.find((r)=>r.day===key)?.tokens??0)});}
  const max=Math.max(1,...values.map((r)=>r.tokens));
  $('#usage-chart').replaceChildren(...values.map((r)=>{const column=el('div',undefined,'bar-column'),bar=el('div',undefined,'bar');bar.style.height=(r.tokens/max*140+3)+'px';bar.title=number(r.tokens)+' token';column.append(el('span',number(r.tokens),'bar-value'),bar,el('small',r.day.slice(5)));return column;}));
  renderRequests('#recent-requests',d.recent,true);
}
async function loadPool(){
  const [a,k]=await Promise.all([api('/accounts'),api('/keys')]);state.accounts=a.rows;state.keys=k.rows;state.providerTypes=a.provider_types;
  $('#account-provider').replaceChildren(...state.providerTypes.map((t)=>new Option(t.label,t.type)));
  $('#accounts').replaceChildren(...a.rows.map((row)=>{
    const card=el('article',undefined,'account-card');card.append(el('h2',row.name),el('strong',money(row.remain_credits)),el('p',`人民币 · 累计消费 ${money(row.used_credits)}`,'muted'),el('p',`同步：${time(row.balance_at)}`,'footnote'));
    const actions=el('div',undefined,'actions');actions.append(badge(!row.enabled?'已停用':stale(row)?'余额待同步':row.blocked?'余额不足':'正常',!row.enabled?'neutral':stale(row)||row.blocked?'warn':''),button(`设置 · 并发 ${row.active}/${row.concurrency}`,()=>edit('accounts',row)));
    card.append(actions);return card;
  }));
  if(!a.rows.length)$('#accounts').append(el('div','先添加一个 APIMart 账户，再录入 Key。','empty'));
  table('#keys',['Key / 账户','额度 / 同步','开放模型','并发','状态','操作'],k.rows.map((row)=>[
    cell(row.name,`${row.account_name} · …${row.suffix}`),cell(row.unlimited?'未设独立上限':money(row.remain_credits),(stale(row)?'待同步 · ':'')+time(row.balance_at)),cell(row.models.slice(0,2).join(', '),row.models.length>2?`共 ${row.models.length} 个模型`:''),`${row.active}/${row.concurrency}`,
    badge(!row.enabled?'已停用':row.last_error||row.balance_error?'异常':stale(row)?'待同步':'已启用',!row.enabled?'neutral':row.last_error||row.balance_error?'bad':stale(row)?'warn':''),
    rowActions(button('设置',()=>edit('keys',row)),button(row.enabled?'停用':'启用',async()=>{await api('/keys/'+row.id,'PATCH',{enabled:!row.enabled});await loadPool();}))
  ]));
}
async function loadUsers(){
  const [registration,email]=await Promise.all([api('/customers/summary'),api('/email/status')]);
  $('#customer-summary').textContent=`已验证注册用户 ${registration.registered} · 今日新增 ${registration.today_registered} · 后台创建用户 ${registration.manual_users}`;
  $('#email-service-status').textContent=email.ready?'邮箱发信服务已配置':'邮箱发信服务尚未配置，注册登录暂未开放';
  state.users=(await api('/users')).rows;
  table('#users',['用户 / 邮箱','访问凭证','已入账余额','累计请求','累计 token','最近调用','状态','操作'],state.users.map((u)=>[
    cell(u.name,u.email_verified?u.email:'后台创建 · '+u.id.slice(0,8)),cell(u.token_prefix?u.token_prefix+'…':'未签发',`${u.access_key_count} 把有效凭证`),money(u.wallet_balance_cny),number(u.request_count),number(u.total_tokens),time(u.last_request_at),badge(u.enabled?'正常':'已停用',u.enabled?'':'neutral'),
    rowActions(button('设置',()=>edit('users',u)),button('新增凭证',async()=>{showToken((await api('/users/'+u.id+'/token','POST',{})).token);await loadUsers();}),button(u.enabled?'停用':'启用',async()=>{await api('/users/'+u.id,'PATCH',{enabled:!u.enabled});await loadUsers();}))
  ]));
}
async function loadRequests(){
  const params=new URLSearchParams({...state.filter,page:state.requestPage});const d=await api('/requests?'+params);
  renderRequests('#requests',d.rows);$('#request-count').textContent=`共 ${number(d.count)} 条记录`;$('#page-number').textContent=state.requestPage;
  $('#prev-page').disabled=state.requestPage===1;$('#next-page').disabled=state.requestPage*d.page_size>=d.count;
}
async function refresh(){
  $('#refresh').disabled=true;
  try{await ({commissions:commissionUi.refresh,plugins:pluginUi.refresh,overview, pool:loadPool,users:loadUsers,requests:loadRequests,wallet:walletUi.refresh,management:accountUi.refresh}[state.page])();$('#sync-label').textContent='更新于 '+new Date().toLocaleTimeString('zh-CN',{hour12:false});}
  finally{$('#refresh').disabled=false;}
}
async function go(page){state.page=page;document.querySelectorAll('.page').forEach((n)=>n.hidden=n.id!=='page-'+page);document.querySelectorAll('[data-page]').forEach((b)=>b.classList.toggle('active',b.dataset.page===page));$('#page-title').textContent=titles[page][0];$('#breadcrumb').textContent=titles[page][1];if(page==='requests'){state.users=(await api('/users')).rows;const selected=$('#filter-user').value;$('#filter-user').replaceChildren(new Option('全部用户',''),...state.users.map((u)=>new Option(u.name,u.id)));$('#filter-user').value=selected;}await refresh();}
async function enterConsole(){
  const session=await api('/session'),full=session.role==='superadmin';
  document.querySelectorAll('[data-page]').forEach(b=>{b.hidden=!full&&!['pool','users','management'].includes(b.dataset.page);});
  accountUi.setRole(session.role);
  await go(full?'overview':'users');
}
function showToken(value){$('#issued-token').value=value;$('#token-dialog').showModal();}
function inputField(label,name,value,type='text'){const l=el('label',label),i=el(type==='textarea'?'textarea':'input');i.name=name;i.value=value;if(type!=='textarea')i.type=type;if(type==='text')i.maxLength=100;if(type==='number'){i.min=1;i.max=name==='rpm'?600:50;}i.required=true;l.append(i);return l;}
function edit(kind,row){state.edit={kind,id:row.id};$('#edit-title').textContent=row.name+' · 设置';const fields=[inputField('名称','name',row.name),inputField(kind==='users'?'每分钟请求上限':'并发上限',kind==='users'?'rpm':'concurrency',kind==='users'?row.rpm:row.concurrency,'number')];if(kind==='keys')fields.push(inputField('开放模型（逗号或换行分隔）','models',row.models.join('\n'),'textarea'));if(kind==='accounts'){fields.push(inputField('上游地址','base_url',row.base_url,'url'));const p=el('label','上游类型'),t=el('select');t.name='provider_type';t.append(...state.providerTypes.map((x)=>new Option(x.label,x.type)));t.value=row.provider_type;p.append(t);fields.push(p);const l=el('label','账户状态'),s=el('select');s.name='enabled';s.append(new Option('启用','true'),new Option('停用','false'));s.value=String(row.enabled);l.append(s);fields.push(l);}$('#edit-fields').replaceChildren(...fields);$('#edit-dialog').showModal();}
function formData(form){return Object.fromEntries(new FormData(form));}
function modelList(value){return value.split(/[,，\n]/).map((x)=>x.trim()).filter(Boolean);}
async function submit(form,path,body,done){const b=form.querySelector('button.primary');b.disabled=true;try{const result=await api(path,'POST',body);form.closest('dialog')?.close();form.reset();await done(result);}finally{b.disabled=false;}}
const pluginUi=setupPlugins({api,action,el,table,cell,button,rowActions,charge,time,number,notice});
const accountUi=setupAccounts({api,action,el,table,cell,button,rowActions,charge,time,showToken});
const commissionUi=setupCommissions({api,action,el,table,cell,button,charge,time,notice});
$('#login-form').addEventListener('submit',async(e)=>{e.preventDefault();const b=e.currentTarget.querySelector('button');b.disabled=true;$('#login-error').textContent='';try{await api('/login','POST',formData(e.currentTarget));e.target.reset();$('#login-view').hidden=true;$('#console-view').hidden=false;await enterConsole();}catch(err){$('#login-error').textContent=err.message;}finally{b.disabled=false;}});
document.querySelectorAll('[data-page]').forEach((b)=>b.addEventListener('click',action(()=>go(b.dataset.page))));
document.querySelectorAll('[data-go]').forEach((b)=>b.addEventListener('click',action(()=>go(b.dataset.go))));
document.querySelectorAll('[data-close]').forEach((b)=>b.addEventListener('click',()=>b.closest('dialog').close()));
$('#token-dialog').addEventListener('close',()=>{$('#issued-token').value='';$('#copy-token').textContent='复制凭证';});
$('#key-dialog').addEventListener('close',()=>{$('#key-form').elements.key.value='';});
$('#logout').addEventListener('click',action(async()=>{await api('/logout','POST',{});loginView();}));
$('#refresh').addEventListener('click',action(refresh));
$('#new-account').addEventListener('click',()=>$('#account-dialog').showModal());
$('#new-key').addEventListener('click',action(async()=>{await loadPool();if(!state.accounts.length){notice('请先创建上游账户。');$('#account-dialog').showModal();return;}$('#key-account').replaceChildren(...state.accounts.map((a)=>new Option(a.name,a.id)));$('#key-dialog').showModal();}));
$('#new-user').addEventListener('click',()=>$('#user-dialog').showModal());
$('#account-form').addEventListener('submit',action(async(e)=>{e.preventDefault();const b=formData(e.target);await submit(e.target,'/accounts',{...b,concurrency:Number(b.concurrency)},loadPool);}));
$('#key-form').addEventListener('submit',action(async(e)=>{e.preventDefault();const b=formData(e.target);await submit(e.target,'/keys',{...b,concurrency:Number(b.concurrency),models:modelList(b.models)},async()=>{notice('Key 已保存，余额正在后台同步。');await loadPool();});}));
$('#user-form').addEventListener('submit',action(async(e)=>{e.preventDefault();const b=formData(e.target);await submit(e.target,'/users',{...b,rpm:Number(b.rpm)},async(d)=>{showToken(d.token);await loadUsers();});}));
$('#edit-form').addEventListener('submit',action(async(e)=>{e.preventDefault();const b=formData(e.target);if(b.rpm)b.rpm=Number(b.rpm);if(b.concurrency)b.concurrency=Number(b.concurrency);if(b.models)b.models=modelList(b.models);if(b.enabled)b.enabled=b.enabled==='true';await api('/'+state.edit.kind+'/'+state.edit.id,'PATCH',b);$('#edit-dialog').close();await refresh();}));
$('#sync-balances').addEventListener('click',action(async()=>{await api('/balances/refresh','POST',{});notice('余额同步已开始，完成后刷新即可查看。');}));
$('#copy-token').addEventListener('click',action(async()=>{await navigator.clipboard.writeText($('#issued-token').value);$('#copy-token').textContent='已复制';}));
$('#filter-form').addEventListener('submit',action(async(e)=>{e.preventDefault();state.filter=Object.fromEntries(Object.entries(formData(e.target)).filter(([,v])=>v));state.requestPage=1;await loadRequests();}));
$('#prev-page').addEventListener('click',action(async()=>{state.requestPage--;await loadRequests();}));
$('#next-page').addEventListener('click',action(async()=>{state.requestPage++;await loadRequests();}));
$('#export-csv').addEventListener('click',()=>{window.location.href='/admin/api/requests/export?'+new URLSearchParams(state.filter);});
const walletUi=setupWallet({api,action,table,cell,money,time,number});
try{await api('/session');$('#login-view').hidden=true;$('#console-view').hidden=false;await enterConsole();}catch{loginView();}
setInterval(()=>{if(!['management','plugins'].includes(state.page)&&!document.hidden&&!$('#console-view').hidden&&!document.querySelector('dialog[open]'))refresh().catch((e)=>notice(e.message,true));},30000);

$('#charge-form').addEventListener('submit',action(async(e)=>{
  e.preventDefault();const form=e.target,b=formData(form);
  await api('/requests/'+state.detail+'/charge','PATCH',b);
  await showRequest(state.detail);notice('已保存账单扣费及核对依据。');
  if(state.page==='requests')await loadRequests();else if(state.page==='overview')await overview();
}));
