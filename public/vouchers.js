export function setupVouchers({api,action,el,table,cell,button,rowActions,money,time,number,notice,formData}) {
  const $=(s)=>document.querySelector(s);
  const state={page:1,codePage:1,walletPage:1,batch:null,generateId:null,operation:null};
  const batchExpired=(b)=>b.expires_at&&new Date(b.expires_at)<=new Date();
  const pageLabel=(selector,data)=>{$(selector).textContent=`第 ${data.page} 页 · 共 ${number(data.count)} 条`;};
  async function refresh(){
    const [summary,data]=await Promise.all([api('/vouchers/summary'),api('/vouchers/batches?page='+state.page)]);
    $('#voucher-summary').replaceChildren(...[10,50,100].map((amount)=>{
      const row=summary.rows.find((r)=>Number(r.amount_cny)===amount)??{};
      const card=el('article',undefined,'account-card');card.append(el('h2',money(amount)),el('strong',`${row.unassigned??0} 枚待分配`),el('p',`已分配未兑 ${row.assigned??0} · 已兑换 ${row.redeemed??0}`,'muted'),el('p',`已作废 ${row.revoked??0} · 已过期 ${row.expired??0}`,'footnote'));return card;
    }));
    table('#voucher-batches',['批次 / 面额','数量 / 可用','分配 / 导出','有效期 / 创建','操作'],data.rows.map((b)=>[
      cell(b.name,money(b.amount_cny)),cell(`${b.quantity} / ${b.available}`,`已兑 ${b.redeemed} · 作废 ${b.revoked}`),cell(b.channel??'尚未分配',b.exported_at?`导出 ${b.export_count} 次 · ${time(b.exported_at)}`:'尚未导出'),cell(b.expires_at?time(b.expires_at):'长期有效',time(b.created_at)),
      rowActions(button('查看码',()=>showCodes(b)),...(Number(b.available)>0&&!batchExpired(b)?[
        button('导出 TXT',()=>download(b,'txt')),button('导出 CSV',()=>download(b,'csv')),
        ...(!b.assigned_at?[button('确认已导入',()=>openAssign(b))]:[]),button('作废未兑换码',()=>openRevoke('batches',b.id,b.name))]:[]))
    ]));
    pageLabel('#voucher-page-label',data);$('#voucher-prev').disabled=state.page<=1;$('#voucher-next').disabled=state.page*30>=data.count;
    await loadWallet();
  }
  async function download(batch,format){
    if(batch.assigned_at&&!confirm(`这批码已分配给“${batch.channel}”。重导出仅用于该渠道补传，请勿重复铺货。继续导出？`))return;
    const response=await fetch('/admin/api/vouchers/batches/'+batch.id+'/export',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({format})});
    if(!response.ok){let d;try{d=await response.json()}catch{}throw new Error(d?.error?.code==='no_available_vouchers'?'没有可导出的未兑换码。':'导出失败，请刷新后重试。');}
    const url=URL.createObjectURL(await response.blob()),link=document.createElement('a');link.href=url;link.download=`ipzsk-${Number(batch.amount_cny)}yuan-${batch.id}.${format}`;link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
    notice('已开始下载。请导入对应面额商品，确认成功后点击“确认已导入”。');await refresh();
  }
  async function showCodes(batch){state.batch=batch;state.codePage=1;$('#voucher-state-filter').value='';$('#voucher-codes-title').textContent=batch.name+' · 充值码';await loadCodes();$('#voucher-codes-dialog').showModal();}
  async function loadCodes(){
    const params=new URLSearchParams({batch_id:state.batch.id,page:state.codePage});if($('#voucher-state-filter').value)params.set('state',$('#voucher-state-filter').value);
    const data=await api('/vouchers/codes?'+params);
    table('#voucher-codes',['充值码尾号','金额 / 状态','兑换人 / 时间','渠道 / 说明','操作'],data.rows.map((r)=>[
      cell('…'+r.code_suffix,r.id.slice(0,8)),cell(money(r.amount_cny),r.state==='redeemed'?'已兑换':r.state==='revoked'?'已作废':batchExpired(r)?'已过期':r.assigned_at?'已分配未兑':'待分配'),
      cell(r.user_name??'—',r.redeemed_at?time(r.redeemed_at):''),cell(r.channel??'尚未分配',r.revoke_reason??''),r.state==='unused'?button('作废',()=>openRevoke('codes',r.id,'尾号 '+r.code_suffix)):'—'
    ]));
    pageLabel('#voucher-code-page-label',data);$('#voucher-code-prev').disabled=state.codePage<=1;$('#voucher-code-next').disabled=state.codePage*30>=data.count;
  }
  function openAssign(batch){state.operation={id:batch.id};$('#voucher-assign-form').reset();$('#voucher-assign-title').textContent='确认导入 · '+batch.name;$('#voucher-assign-dialog').showModal();}
  function openRevoke(kind,id,label){state.operation={kind,id};$('#voucher-revoke-form').reset();$('#voucher-revoke-title').textContent='作废 · '+label;$('#voucher-revoke-dialog').showModal();}
  async function loadWallet(){
    const data=await api('/wallet/entries?page='+state.walletPage);
    table('#wallet-entries',['流水 / 用户','到账金额','入账后余额','充值码 / 批次','兑换时间'],data.rows.map((r)=>[
      cell(r.id.slice(0,8),r.user_name),money(r.amount_cny),money(r.balance_after_cny),cell('…'+r.code_suffix,r.batch_name),time(r.created_at)
    ]));pageLabel('#wallet-page-label',data);$('#wallet-prev').disabled=state.walletPage<=1;$('#wallet-next').disabled=state.walletPage*30>=data.count;
  }
  $('#new-voucher-batch').addEventListener('click',()=>{state.generateId=crypto.randomUUID();$('#voucher-generate-form').reset();$('#voucher-generate-dialog').showModal();});
  $('#voucher-generate-form').addEventListener('submit',action(async(e)=>{
    e.preventDefault();const form=e.target,b=formData(form),submit=form.querySelector('button.primary');submit.disabled=true;
    try{await api('/vouchers/batches','POST',{id:state.generateId,name:b.name,amount_cny:Number(b.amount_cny),quantity:Number(b.quantity),expires_at:b.expires_at?new Date(b.expires_at).toISOString():null});$('#voucher-generate-dialog').close();state.page=1;await refresh();notice('充值码已加密保存。请导出并导入售卖网站。');}finally{submit.disabled=false;}
  }));
  $('#voucher-assign-form').addEventListener('submit',action(async(e)=>{e.preventDefault();await api('/vouchers/batches/'+state.operation.id+'/assign','POST',formData(e.target));$('#voucher-assign-dialog').close();await refresh();notice('已确认分配，客户现在可以兑换。');}));
  $('#voucher-revoke-form').addEventListener('submit',action(async(e)=>{e.preventDefault();await api('/vouchers/'+state.operation.kind+'/'+state.operation.id+'/revoke','POST',formData(e.target));$('#voucher-revoke-dialog').close();await refresh();if($('#voucher-codes-dialog').open)await loadCodes();notice('未兑换充值码已作废，已兑换记录保留。');}));
  for(const [id,field,delta,fn] of [['voucher-prev','page',-1,refresh],['voucher-next','page',1,refresh],['voucher-code-prev','codePage',-1,loadCodes],['voucher-code-next','codePage',1,loadCodes],['wallet-prev','walletPage',-1,loadWallet],['wallet-next','walletPage',1,loadWallet]])$('#'+id).addEventListener('click',action(async()=>{state[field]+=delta;await fn();}));
  $('#voucher-state-filter').addEventListener('change',action(async()=>{state.codePage=1;await loadCodes();}));
  return {refresh};
}
