export function setupCommissions({api,action,el,table,cell,button,charge,time,notice}) {
  const section=el('section',undefined,'page');section.id='page-commissions';section.hidden=true;
  document.querySelector('main').append(section);
  const nav=el('button','分佣与提现');nav.dataset.page='commissions';document.querySelector('nav').append(nav);
  const states={pending_billing:'待扣费回传',pending_sources:'待核对余额来源',historical_sources_review:'历史来源待人工核对',pending_cost:'BD 已计提，开发者待实际成本',accrued:'已计提',disputed:'争议冻结',requested:'待审核',approved:'待转账',paid:'已打款',cancelled:'已取消',pending:'待转入',applying:'正在转入',review:'待人工核对'};
  function panel(title) {
    const box=el('article',undefined,'panel');box.append(el('h2',title));section.append(box);return box;
  }
  function ask(title, fields, run) {
    const dialog=el('dialog'), form=el('form');form.append(el('h2',title));
    const inputs={};
    for(const [key,label,type='text',value='',required=type!=='checkbox'] of fields) {
      const l=el('label',label),input=el(type==='select'?'select':'input');
      if(type==='select')input.append(...value.map(([v,text])=>new Option(text,v)));else {input.type=type;input.value=value;input.maxLength=500;}
      input.required=required;l.append(input);form.append(l);inputs[key]=input;
    }
    const error=el('p',undefined,'error');error.setAttribute('role','alert');
    const cancel=button('取消',()=>dialog.close()),submit=el('button','确认保存','primary');submit.type='submit';form.append(error,cancel,submit);
    form.addEventListener('submit',async event=>{
      event.preventDefault();submit.disabled=true;error.textContent='';
      try {await run(Object.fromEntries(Object.entries(inputs).map(([key,input])=>[key,input.type==='checkbox'?input.checked:input.value])));dialog.close();await refresh();notice('已保存，账本和审计记录已更新。');}
      catch(e){error.textContent=e.message;}finally{submit.disabled=false;}
    });
    dialog.append(form);document.body.append(dialog);dialog.addEventListener('close',()=>dialog.remove());dialog.showModal();
  }
  const reason=[['reason','操作依据（至少 5 字）']];
  const receipt=[['reference','核对依据或银行流水号（至少 5 字）']];
  const roles={bd:'BD',developer:'插件开发者'},inviteStates={pending:'待接受',accepted:'已接受',revoked:'已撤销',expired:'已过期'};
  // The plaintext link exists only in this response; closing the dialog discards it.
  function showLink(result) {
    const dialog=el('dialog'),box=el('div'),input=el('input');input.readOnly=true;input.value=result.invitation_url;input.setAttribute('aria-label','邀请链接');
    box.append(el('h2',`${roles[result.invitation.role]}邀请链接 · 仅显示一次`),el('p',`发给 ${result.invitation.email}。链接 ${time(result.invitation.expires_at)} 前有效，只能由该账号登录后使用一次；关闭后无法再次查看，丢失请重发。`),input,
      button('复制链接',async()=>{await navigator.clipboard.writeText(input.value);notice('邀请链接已复制。');}),button('关闭',()=>dialog.close()));
    dialog.append(box);document.body.append(dialog);dialog.addEventListener('close',()=>{input.value='';dialog.remove();});dialog.showModal();
  }
  async function refresh() {
    const [data,invitations,adjustments]=await Promise.all([api('/commissions'),api('/commissions/invitations'),api('/lanehub-adjustments')]);section.replaceChildren();
    const percent=value=>`${Number(value)/100}%`;
    const policy=panel('API 消费分佣');policy.append(el('p',`当前${data.policy.enabled?'已启用':'未启用'}。BD 永久分有效付费 API 消费的 ${percent(data.policy.bd_share_bps)}；插件开发者永久分扣除实际上游成本和 BD 佣金后剩余利润的 ${percent(data.policy.developer_share_bps)}。赠送额度不分佣。`));
    policy.append(button(data.policy.enabled?'暂停新请求计佣':'启用新请求计佣',()=>ask('确认切换计佣规则',reason,b=>api('/commissions/policy','POST',{...b,enabled:!data.policy.enabled}))),button('重新核对待处理账目',action(async()=>{await api('/commissions/reconcile','POST',{});await refresh();})));
    const invites=panel('BD 与插件开发者邀请');
    invites.append(el('p','BD 与插件开发者只能由管理员邀请开通。按已验证邮箱或用户 ID 发起，链接 7 天内有效，只能由被邀请账号登录后使用一次，明文只在创建或重发时显示。同一用户同一身份只保留一份待接受邀请；重发会作废旧链接。'));
    invites.append(button('发起邀请',()=>ask('邀请 BD 或插件开发者',[['role','身份','select',[['bd','BD'],['developer','插件开发者']]],['target','被邀请用户的邮箱或用户 ID'],
      ['display_name','开发者名称（可选，留空沿用账户名或已有名称）','text','',false],...reason],b=>api('/commissions/invitations','POST',{...b,display_name:b.display_name||undefined}).then(showLink))));
    const inviteList=el('div');invites.append(inviteList);
    table(inviteList,['被邀请用户','身份','状态','有效期 / 处理时间','发起人 / 依据','操作'],invitations.rows.map(i=>[cell(i.name,i.email),roles[i.role],inviteStates[i.state],
      cell('至 '+time(i.expires_at),i.accepted_at?'接受于 '+time(i.accepted_at):i.revoked_at?`${i.revoked_by} 撤销于 ${time(i.revoked_at)}`:''),cell(i.created_by,i.reason),(()=>{const actions=el('div');
        if(i.state==='pending')actions.append(button('撤销',()=>ask('撤销邀请（旧链接立即失效）',reason,b=>api('/commissions/invitations/'+i.id+'/revoke','POST',b))));
        if(i.state!=='accepted')actions.append(button('重发',()=>ask('重发邀请（生成新链接，旧链接作废）',reason,b=>api('/commissions/invitations/'+i.id+'/resend','POST',b).then(showLink))));return actions;})()]));
    const profiles=panel('邀请人、BD 与收益冻结');const list=el('div');profiles.append(list);
    table(list,['用户','邀请身份','收益状态','操作'],data.profiles.map(p=>[cell(p.name,p.user_id),p.bd_active?'BD':'普通邀请人',p.frozen?'冻结':'正常',(()=>{const actions=el('div');
      if(p.bd_active)actions.append(button('取消 BD',()=>ask('取消 BD 身份（只影响后续请求，恢复需重新邀请）',reason,b=>api('/commissions/profiles/'+p.user_id,'POST',{...b,bd_active:false,frozen:p.frozen}))));
      actions.append(button(p.frozen?'解除冻结':'冻结收益',()=>ask('调整收益冻结状态',reason,b=>api('/commissions/profiles/'+p.user_id,'POST',{...b,bd_active:p.bd_active,frozen:!p.frozen}))));return actions;})()]));
    const payouts=panel('月度提现 · 满 100 元 · 审核后人工转账');const payoutList=el('div');payouts.append(payoutList);
    table(payoutList,['用户 / 申请','金额','状态','时间','操作'],data.payouts.map(p=>[cell(p.name,p.id),charge(p.amount_cny),states[p.state],time(p.created_at),(()=>{const actions=el('div');
      const transitions=p.state==='requested'?[['approved','审核通过'],['cancelled','取消申请']]:p.state==='approved'?[['paid','确认已转账'],['cancelled','取消申请']]:[];
      for(const [state,label] of transitions)actions.append(button(label,()=>ask(label+' · '+charge(p.amount_cny),receipt,b=>api('/commissions/payouts/'+p.id,'POST',{...b,state}))));return actions;})()]));
    const conversions=panel('收益转余额 · 不确定结果只人工核对，不自动重试');const conversionList=el('div');conversions.append(conversionList);
    table(conversionList,['用户 / 申请','金额','状态','操作'],data.conversions.map(p=>[cell(p.user_id,p.id),charge(p.amount_cny),states[p.state],(()=>{const actions=el('div');if(p.state==='review')for(const [result,label] of [['applied','确认上游已入账'],['not_applied','确认未入账并退回收益']])actions.append(button(label,()=>ask(label,receipt,b=>api('/commissions/conversions/'+p.id+'/resolve','POST',{...b,result}))));return actions;})()]));
    const lane=panel('LaneHub 额度调整 · 结果未知只人工核对，不自动重试');lane.append(el('p','先在 LaneHub 后台核对该用户的额度日志（备注含引用号），再选择处理方式。确认未生效才可重试；重试结果仍未知会再次进入待核对。远程尚未开始的待执行项由后台约两分钟内自动执行，也可直接终止。'));const laneList=el('div');lane.append(laneList);
    const laneStates={pending:'待后台执行（远程未开始）',applying:'执行中',applied:'已生效待落账',review:'待人工核对'};
    table(laneList,['引用号 / 用户','方向 / 金额','状态 / 原因','操作'],adjustments.rows.map(a=>[cell(a.reference,a.user_id),cell(a.kind==='debit'?'扣回':'加额度',charge(a.amount_cny)),cell(laneStates[a.state]??a.state,a.review_reason??''),(()=>{const actions=el('div');for(const [result,label] of a.state==='review'?[['applied','确认已生效'],['retry','确认未生效并重试'],['cancel','确认未生效并终止']]:a.state==='pending'?[['cancel','终止（远程尚未开始）']]:[])actions.append(button(label,()=>ask(label+' · '+a.reference,reason,b=>api('/lanehub-adjustments/resolve','POST',{...b,reference:a.reference,result}))));return actions;})()]));
    const requests=panel('逐请求计提');const requestList=el('div');requests.append(requestList);
    const basis={profit:'剩余利润',consumption:'付费消费',legacy_profit:'旧版利润'};
    table(requestList,['请求','扣款 / 本金','BD','开发者','比例快照','状态'],data.requests.map(p=>[p.request_id,cell(charge(p.charged_cny),charge(p.paid_cny)),charge(p.bd_cny),charge(p.developer_cny),`BD ${percent(p.bd_share_bps)} · 开发者 ${percent(p.developer_share_bps)} ${basis[p.developer_basis]}`,states[p.state]]));
    const opening=panel('历史账户余额来源');opening.append(el('p','先暂停新请求计佣并确认账户没有在途请求或缺失账单，再核对剩余本金。全部历史账户确认来源后才能开启计佣。迁移前尚未分配来源的消费保留为历史待核对，不从当前余额重复扣除；已分配的账目禁止重置。已验证充值订单之外的余额按不分佣余额导入。'));
    const accountList=el('div');opening.append(accountList);
    table(accountList,['用户','来源状态','操作'],data.accounts.map(p=>[cell(p.name,p.user_id),p.sources_confirmed?'已确认':'待迁移',button('核对期初余额',()=>ask('核对余额来源',[['paid_lots','已核实的剩余本金 JSON：[{"payment_order_id":"订单 ID","amount_cny":"10"}]','text','[]'],...receipt],b=>api('/commissions/opening-balance/'+p.user_id,'POST',{reference:b.reference,paid_lots:JSON.parse(b.paid_lots)})))]));
    const refunds=panel('已完成的充值退款 / 拒付回执');refunds.append(el('p','仅登记支付平台已确认的退款。此处不会执行银行退款；确认金额、回执和余额已扣回后再提交。拒付会追溯消费并冲回相关分佣。'));
    refunds.append(button('登记确认回执',()=>ask('确认充值退款已完成',[['payment_order_id','充值订单 ID'],['amount_cny','退款金额（元）'],['chargeback','包含已消费金额的拒付','checkbox'],...receipt],b=>api('/commissions/payment-refunds/'+b.payment_order_id,'POST',{amount_cny:b.amount_cny,chargeback:b.chargeback,reference:b.reference}))));
  }
  return {refresh};
}
