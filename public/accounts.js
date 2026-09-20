export function setupAccounts({api,action,el,table,cell,button,rowActions,charge,time,showToken}){
  const nav=document.querySelector('nav');
  const section=el('section');section.id='page-management';section.className='page';section.hidden=true;
  document.querySelector('#page-users').parentNode.append(section);
  const heading=el('h2','账户、账单与权限');const tabs=el('div',undefined,'row-actions');const content=el('div');
  section.append(heading,tabs,content);let current='daily';
  function input(label,type='text',value=''){const l=el('label',label),n=el('input');n.type=type;n.value=value;l.append(n);return {l,n};}
  async function refresh(){content.replaceChildren();await views[current]();}
  const views={
    async daily(){
      const d=input('统计日期（北京时间）','date',new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'}));
      const box=el('div',undefined,'table-wrap');const load=async()=>{const data=await api('/users/daily?day='+d.n.value);table(box,['用户','请求','输入 token','输出 token','合计 token','用户扣款','上游实扣','上游估算','待核对'],data.rows.map(r=>[cell(r.name,r.email),r.requests,r.input_tokens,r.output_tokens,r.total_tokens,charge(r.charged_cny),charge(r.upstream_cost_cny),charge(r.upstream_estimated_cny),r.pending]));};
      d.n.addEventListener('change',action(load));content.append(d.l,box);await load();
    },
    async credentials(){
      const users=(await api('/users')).rows;const select=el('select');select.append(...users.map(u=>new Option(u.name,u.id)));const box=el('div',undefined,'table-wrap');
      const name=input('凭证名称'),rpm=input('每分钟请求上限（留空沿用账户）','number'),expiry=input('有效期（留空永久）','datetime-local');
      const create=button('创建独立凭证',async()=>{const r=await api('/users/'+select.value+'/tokens','POST',{name:name.n.value||'默认凭证',rpm:rpm.n.value?Number(rpm.n.value):null,expires_at:expiry.n.value?new Date(expiry.n.value).toISOString():null});showToken(r.token);await load();});
      const load=async()=>{if(!select.value)return;const data=await api('/users/'+select.value+'/tokens');table(box,['名称','凭证前缀','限速','到期时间','最后使用','状态','操作'],data.rows.map(r=>[r.name,r.prefix+'…',r.rpm??'账户上限',r.expires_at?time(r.expires_at):'永久',time(r.last_used_at),r.revoked_at?'已吊销':r.expires_at&&new Date(r.expires_at)<new Date()?'已到期':'有效',r.revoked_at?'—':button('吊销',async()=>{if(!confirm('吊销这把凭证？使用它的应用将无法继续调用。'))return;await api('/users/'+select.value+'/tokens/'+r.id+'/revoke','POST',{});await load();})]));};
      select.addEventListener('change',action(load));content.append(select,name.l,rpm.l,expiry.l,create,box);await load();
    },
    async billing(){
      const d=await api('/billing');content.append(el('p',d.policy.enabled?'收费已开启':'收费关闭：记录用量和上游成本，不扣用户钱包。'));
      content.append(el('p','开启后仅接受有定价的文字接口，必须指定最大输出 token；图片、音频、搜索和未能计价的调用会被拒绝。金额按 APIMart Credits × 售价倍数记录为元。'));
      const mult=input('对用户售价倍数','number',d.policy.multiplier);mult.n.step='0.0001';mult.n.min='0.0001';
      const rate=input('美元兑人民币汇率（媒体按美元定价）','number',d.policy.usd_cny);rate.n.step='0.0001';rate.n.min='0.0001';
      content.append(mult.l,rate.l,el('p','改汇率只影响之后新建的冻结单；已冻结的按下单时的快照结算，不会重算。','footnote'));
      content.append(button(d.policy.enabled?'关闭收费':'保存倍数并开启收费',async()=>{if(!confirm(`确认${d.policy.enabled?'关闭收费':'按 '+mult.n.value+' 倍开启实际钱包扣费'}？`))return;await api('/billing/policy','POST',{enabled:!d.policy.enabled,multiplier:mult.n.value,usd_cny:rate.n.value});await refresh();}));
      content.append(button('只保存倍数与汇率',async()=>{await api('/billing/policy','POST',{enabled:d.policy.enabled,multiplier:mult.n.value,usd_cny:rate.n.value});await refresh();}));
      content.append(el('p','待核对款项继续冻结；超过 24 小时显示逾期。核对后录入扣款金额，填 0 释放冻结款。'));
      const box=el('div',undefined,'table-wrap');content.append(box);table(box,['用户 / 请求','状态','冻结金额','核对期限','原因','操作'],d.pending.map(r=>[cell(r.user_name,r.request_id),r.state,charge(r.reserved_cny),cell(time(r.review_at),new Date(r.review_at)<new Date()?'已逾期':''),r.reason??'等待请求结束',r.state==='pending'?button('核对结算',async()=>{const amount=prompt('本次用户扣款金额（元），0 表示释放，不能超过冻结金额');if(amount===null)return;const reason=prompt('账单依据或释放原因（至少 5 个字）');if(!reason)return;await api('/billing/'+r.request_id+'/resolve','POST',{amount_cny:amount,reason});await refresh();}):'处理中']));
    },
    async ledger(){const d=await api('/ledger');table(content,['时间','用户','类型','金额变动','账面余额','请求 ID'],d.rows.map(r=>[time(r.created_at),r.user_name,r.kind==='recharge'?'充值':'消费',charge(r.amount_cny),charge(r.balance_after_cny),r.request_id??'—']));},
    async administrators(){
      const d=await api('/administrators'),box=el('div');content.append(box);table(box,['用户名','权限','状态','操作'],d.rows.map(r=>[r.username,r.role,r.enabled?'启用':'停用',r.enabled?button('停用',async()=>{if(!confirm('停用此管理员并注销其会话？'))return;await api('/administrators/'+r.id+'/disable','POST',{});await refresh();}):'—']));
      const name=input('管理员用户名'),pass=input('初始密码（至少 16 位）','password'),role=el('select');role.append(new Option('运营（用户、号池管理）','operator'),new Option('只读','viewer'),new Option('超级管理员','superadmin'));
      content.append(name.l,pass.l,role,button('创建管理员',async()=>{await api('/administrators','POST',{username:name.n.value,password:pass.n.value,role:role.value});pass.n.value='';await refresh();}));
    },
    async password(){const old=input('当前密码','password'),next=input('新密码（至少 16 位）','password');content.append(old.l,next.l,button('修改密码并退出',async()=>{await api('/password','POST',{current_password:old.n.value,password:next.n.value});old.n.value='';next.n.value='';location.reload();}));},
    async audit(){const d=await api('/audit');table(content,['时间','管理员','操作','对象'],d.rows.map(r=>[time(r.created_at),r.username??'系统 / 历史记录',cell(r.action,r.details?.route),r.target_id??'—']));}
  };
  for(const [id,label] of [['daily','每日用量'],['credentials','平台凭证'],['ledger','钱包流水'],['billing','计费与核对'],['administrators','管理员'],['password','修改密码'],['audit','操作审计']])tabs.append(button(label,async()=>{current=id;await refresh();}));
  const navButton=el('button','账户与账单');navButton.dataset.page='management';nav.append(navButton);
  return {refresh,setRole(role){current=role==='superadmin'?'daily':'password';for(const b of tabs.children)b.hidden=role!=='superadmin'&&b.textContent!=='修改密码';}};
}
