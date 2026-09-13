export function setupPlugins({api,action,el,table,cell,button,rowActions,charge,time,number,notice}){
  const section=el('section');section.id='page-plugins';section.className='page';section.hidden=true;
  document.querySelector('main').append(section);
  const nav=el('button','插件市场与用量');nav.dataset.page='plugins';document.querySelector('nav').append(nav);
  let selected=null;
  const input=(label,value='',type='text')=>{const l=el('label',label),n=el('input');n.type=type;n.value=value;l.append(n);return {l,n};};
  let view='review',reportQuery;
  const stateName={pending:'待审核',approved:'已批准',rejected:'已驳回',disabled:'已停用'};
  function dialog(title){const d=el('dialog');d.className='wide-dialog';const heading=el('div',undefined,'dialog-heading');heading.append(el('h2',title),button('关闭',()=>d.close()));d.append(heading);document.body.append(d);d.addEventListener('close',()=>d.remove());d.showModal();return d;}
  function inspect(title,rows){const d=dialog(title),box=el('div',undefined,'table-wrap');d.append(box);table(box,['项目','内容'],rows);}
  async function openReleases(p){selected=p;const d=dialog(p.name),box=el('div');box.id='plugin-releases';d.append(box);await releases();}
  async function refresh(){
    const [{plugins},{rows:developers},queue]=await Promise.all([api('/plugins'),api('/developers'),api('/plugins/review-queue')]);
    section.replaceChildren();const tabs=el('div',undefined,'role-tabs');section.append(tabs);
    const pending=developers.filter(d=>d.state==='pending');
    for(const [id,label] of [['review',`待审核 (${pending.length+queue.releases.length})`],['plugins','插件管理'],['finance','收支'],['settlements','结算单']]){
      const tab=button(label,async()=>{view=id;await refresh();},view===id?'primary':'secondary');tab.setAttribute('aria-pressed',String(view===id));tabs.append(tab);
    }
    if(view==='review'){
      section.append(el('h2','开发者申请'));const box=el('div',undefined,'table-wrap');section.append(box);
      table(box,['申请人','账号','操作'],pending.map(d=>[d.display_name,d.email,rowActions(...[['approved','批准'],['rejected','驳回']].map(([state,label])=>button(label,async()=>{const note=state==='rejected'?prompt('驳回原因'):'';if(note===null)return;await api('/developers/'+d.user_id+'/review','POST',{state,review_note:note});await refresh();})))]));
      section.append(el('h2','版本申请'));const versions=el('div',undefined,'table-wrap');section.append(versions);
      table(versions,['插件','版本','申请事项','操作'],queue.releases.map(r=>[r.plugin_name,r.version,r.withdrawal_requested?'申请下架':'申请上架',button('审核',()=>openReleases(plugins.find(p=>p.id===r.plugin_id)))]));
      return;
    }
    if(view==='plugins'){
      const box=el('div',undefined,'table-wrap');section.append(box);
      table(box,['插件','开发者','状态','操作'],plugins.map(p=>[p.name,developers.find(d=>d.user_id===p.owner_user_id)?.display_name??'待绑定',p.enabled?'启用':'停用',rowActions(button('版本',()=>openReleases(p)),button('管理',()=>{
        const d=dialog(p.name);d.append(el('p',p.owner_user_id?'管理插件发布、归属与运行设置。':'请先绑定已批准的开发者。','footnote'),rowActions(button('归属与分成',()=>{d.close();return ownership(p,developers);}),button('设置',()=>{d.close();return settings(p);}),button(p.enabled?'停用插件':'启用插件',async()=>{await api('/plugins/'+p.id+'/settings','POST',{...p,enabled:!p.enabled});d.close();await refresh();})));
      }))]));
      const details=el('details'),summary=el('summary','开发者管理');details.append(summary);const devBox=el('div',undefined,'table-wrap');details.append(devBox);section.append(details);
      table(devBox,['开发者','账号','状态','操作'],developers.map(d=>[d.display_name,d.email,stateName[d.state],button(d.state==='approved'?'停用':'查看',async()=>{
        if(d.state==='approved'){await api('/developers/'+d.user_id+'/review','POST',{state:'disabled'});await refresh();}
        else {const modal=dialog(d.display_name);modal.append(el('p',d.review_note||stateName[d.state]),button('批准',async()=>{await api('/developers/'+d.user_id+'/review','POST',{state:'approved'});modal.close();await refresh();}));}
      })]));
      const create=el('details');create.append(el('summary','手动登记插件'));const form=el('form'),fields={slug:input('插件标识'),name:input('名称'),repository:input('GitHub 仓库（owner/repo）'),package_name:input('npm 包名')};
      for(const f of Object.values(fields)){f.n.required=true;form.append(f.l);}const submit=el('button','登记','primary');submit.type='submit';form.append(submit);
      form.addEventListener('submit',action(async e=>{e.preventDefault();const body=Object.fromEntries(Object.entries(fields).map(([k,f])=>[k,f.n.value]));await api('/plugins','POST',{...body,publisher_ref:body.name,allowed_models:[]});await refresh();}));create.append(form);section.append(create);return;
    }
    if(view==='settlements'){await settlements();return;}
    const today=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});reportQuery??={from:today.slice(0,8)+'01',to:today,plugin_id:''};
    const from=input('开始日期',reportQuery.from,'date'),to=input('结束日期',reportQuery.to,'date'),select=el('select');select.setAttribute('aria-label','插件');select.append(new Option('全部插件',''),...plugins.map(p=>new Option(p.name,p.id)));select.value=reportQuery.plugin_id;
    const filters=el('div',undefined,'filters'),report=el('div',undefined,'table-wrap');let reportData;
    async function load(){reportQuery={from:from.n.value,to:to.n.value,plugin_id:select.value};reportData=await api('/plugin-usage?'+new URLSearchParams(reportQuery));table(report,
      ['插件 / 模型','用户收入','上游成本','已确认毛利','应计分成','明细'],reportData.rows.map(r=>[
      cell(r.plugin_name??'其他调用',r.model),r.charged_cny==null?'未扣款':charge(r.charged_cny),cell(charge(r.confirmed_cost_cny),Number(r.unknown_cost_requests)?'部分费用待确认':''),charge(r.confirmed_margin_cny),charge(r.developer_earnings_cny),button('查看',()=>inspect('用量与账目明细',[
        ['使用人数',number(r.active_users)],['调用次数',number(r.requests)],['失败次数',number(r.failed_requests)],['输入 / 输出 token',`${number(r.input_tokens)} / ${number(r.output_tokens)}`],['未知用量',r.unknown_token_requests+' 次'],['媒体任务 / 完成 / 失败',`${r.media_tasks} / ${r.completed_media_tasks} / ${r.failed_media_tasks}`],['收入和成本均已确认',r.margin_known_requests+' 笔'],['开发者归属标签',r.plugin_publisher_ref??'未归属']
      ]))]));}
    filters.append(from.l,to.l,select,button('查询',load),button('导出明细',()=>{
      if(!reportData)return;const keys=['plugin_id','plugin_name','model','requests','failed_requests','input_tokens','output_tokens','total_tokens','unknown_token_requests','charged_cny','confirmed_cost_cny','unknown_cost_requests','confirmed_margin_cny','developer_earnings_cny','refunded_cny'];
      const quote=v=>'"'+String(v??'').replace(/^[\s]*[=+@-]/,"'$&").replaceAll('"','""')+'"';const data='\ufeff'+[keys,...reportData.rows.map(r=>keys.map(k=>r[k]))].map(row=>row.map(quote).join(',')).join('\r\n');const url=URL.createObjectURL(new Blob([data],{type:'text/csv;charset=utf-8'})),a=el('a');a.href=url;a.download=`plugin-usage-${reportData.from}-${reportData.to}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }));section.append(filters,report,el('p','毛利只计收入和成本均已确认的调用，未扣开发者分成。应计分成尚未打款。','footnote'));await load();
  }
  // 结算单：打款是人工的，这一屏只做凭据——把还没出单的计提圈成一张单，
  // 冻结锁金额，打完款登记转账单号。冻结之后的退款不回溯改单，会作为负数计提
  // 落进下一张单，所以「待出单」那一栏出现负数是正常的。
  const settlementState={draft:'草稿',frozen:'已冻结',paid:'已打款',void:'已作废'};
  async function settlements(){
    const {rows,pending}=await api('/settlements');
    section.append(el('h2','待出单的计提'));
    const pendingBox=el('div',undefined,'table-wrap');section.append(pendingBox);
    table(pendingBox,['开发者','未结算金额','明细数','最早一笔','操作'],pending.map(p=>[
      p.owner_name,charge(p.amount_cny),number(p.item_count),time(p.since),
      button('出结算单',()=>draft(p))]));

    section.append(el('h2','结算单'));
    const box=el('div',undefined,'table-wrap');section.append(box);
    table(box,['开发者','区间','状态','金额','明细数','操作'],rows.map(r=>[
      r.owner_name,cell(`${r.period_from} ~ ${r.period_to}`,r.paid_note||r.note||''),
      settlementState[r.state]??r.state,charge(r.amount_cny),number(r.item_count),
      rowActions(
        button('明细',()=>detail(r)),
        ...(r.state==='draft'?[button('冻结',async()=>{await api('/settlements/'+r.id+'/freeze','POST',{});notice('已冻结，金额锁定');await refresh();})]:[]),
        ...(r.state==='frozen'?[button('登记打款',()=>pay(r))]:[]),
        ...(['draft','frozen'].includes(r.state)?[button('作废',()=>voidOne(r))]:[]))]));
    section.append(el('p','同一条明细只会进一张单。冻结之后金额锁定：之后发生的退款作为负数计提落到下一张单，已打款的单不能作废。','footnote'));

    async function draft(p){
      const d=el('dialog'),form=el('form');
      const today=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});
      const from=input('开始日期','2000-01-01','date'),to=input('结束日期',today,'date'),note=input('备注（可选）');
      form.append(el('h2','给 '+p.owner_name+' 出结算单'),
        el('p','只会圈进区间内还没归属任何结算单的计提；圈完可以先看明细再冻结。','footnote'),from.l,to.l,note.l);
      const save=el('button','出单','primary');save.type='submit';form.append(save,button('取消',()=>d.close()));
      form.addEventListener('submit',action(async e=>{e.preventDefault();
        const created=await api('/settlements','POST',{owner_user_id:p.owner_user_id,from:from.n.value,to:to.n.value,note:note.n.value});
        d.close();notice(`已出单 ${created.item_count} 条明细，合计 ${created.amount_cny} 元`);await refresh();}));
      d.append(form);document.body.append(d);d.addEventListener('close',()=>d.remove());d.showModal();
    }
    async function detail(r){
      const {settlement,items}=await api('/settlements/'+r.id);
      const d=dialog(`结算单 · ${r.owner_name} · ${settlementState[settlement.state]}`);
      const box=el('div',undefined,'table-wrap');d.append(box);
      table(box,['时间','插件 / 模型','类型','金额'],items.map(i=>[
        time(i.created_at),cell(i.plugin_name??'未知插件',i.model??''),i.kind==='refund'?'退款冲销':'计提',charge(i.amount_cny)]));
    }
    async function pay(r){
      const d=el('dialog'),form=el('form');
      const note=input('打款凭据（转账单号 / 渠道 / 日期，至少 5 个字）');note.n.required=true;note.n.minLength=5;
      form.append(el('h2','登记打款'),el('p','这里只登记事实，系统不发起任何转账。凭据写清楚，出账时要对得上。','footnote'),
        cell(`${r.owner_name} · ${charge(r.amount_cny)}`),note.l);
      const save=el('button','确认已打款','primary');save.type='submit';form.append(save,button('取消',()=>d.close()));
      form.addEventListener('submit',action(async e=>{e.preventDefault();
        await api('/settlements/'+r.id+'/pay','POST',{paid_note:note.n.value});d.close();notice('已登记打款');await refresh();}));
      d.append(form);document.body.append(d);d.addEventListener('close',()=>d.remove());d.showModal();
    }
    async function voidOne(r){
      const why=prompt('作废原因（至少 5 个字）：');
      if(!why)return;
      await api('/settlements/'+r.id+'/void','POST',{reason:why});
      notice('已作废，明细已释放，可以重新出单');await refresh();
    }
  }
  async function ownership(p,developers){
    const dialog=el('dialog'),form=el('form'),select=el('select');
    select.append(new Option('选择已批准的开发者',''),...developers.filter(d=>d.state==='approved').map(d=>new Option(d.display_name+' · '+d.email,d.user_id)));select.value=p.owner_user_id??'';
    const ownerLabel=el('label','插件所有者');ownerLabel.append(select);select.required=true;
    const share=input('开发者分成比例 %（留空表示未配置）',p.revenue_share_bps==null?'':String(p.revenue_share_bps/100),'number');share.n.min='0';share.n.max='100';share.n.step='0.01';
    form.append(el('h2','归属与分成'),el('p','按用户实际扣款金额计算应计分成。只影响后续请求，历史归属和比例保留；尚未开通打款。','footnote'),ownerLabel,share.l);
    const save=el('button','保存','primary');save.type='submit';form.append(save,button('关闭',()=>dialog.close()));
    form.addEventListener('submit',action(async e=>{e.preventDefault();await api('/plugins/'+p.id+'/owner','POST',{owner_user_id:select.value,revenue_share_bps:share.n.value===''?null:Math.round(Number(share.n.value)*100)});dialog.close();await refresh();}));
    dialog.append(form);document.body.append(dialog);dialog.addEventListener('close',()=>dialog.remove());dialog.showModal();
  }
  async function settings(p){
    const dialog=el('dialog'),form=el('form'),name=input('名称',p.name),models=input('允许调用的模型，逗号分隔',p.allowed_models.join(','));
    form.append(el('h2','插件设置'),name.l);
    const advanced=el('details');advanced.append(el('summary','技术配置'),models.l);form.append(advanced);
    const runtime=input('运行时 ID（留空则不向客户端注入配置）',p.runtime_id??''),config=el('textarea'),paths=el('textarea');config.value=JSON.stringify(p.runtime_config,null,2);paths.value=JSON.stringify(p.credential_paths);
    advanced.append(runtime.l,el('label','运行配置 JSON（不要填 API Key）'),config,el('label','凭证注入路径 JSON'),paths);
    const submit=el('button','保存','primary');submit.type='submit';form.append(submit,button('关闭',()=>dialog.close()));
    form.addEventListener('submit',action(async e=>{e.preventDefault();await api('/plugins/'+p.id+'/settings','POST',{enabled:p.enabled,name:name.n.value,publisher_ref:p.publisher_ref,allowed_models:models.n.value.split(',').map(s=>s.trim()).filter(Boolean),runtime_id:runtime.n.value||null,runtime_config:JSON.parse(config.value),credential_paths:JSON.parse(paths.value)});dialog.close();await refresh();}));
    dialog.append(form);document.body.append(dialog);dialog.addEventListener('close',()=>dialog.remove());dialog.showModal();
  }
  async function releases(){
    const p=selected,box=document.querySelector('#plugin-releases');box.replaceChildren(el('h2',p.name+' · 版本管理'));
    const link=input('GitHub Release 地址，例如 https://github.com/'+p.repository+'/releases/tag/v1.0.0'),asset=input('附件名（多个 .tgz 时必填）');
    const importer=el('details');importer.append(el('summary','导入新版本'));box.append(importer);
    importer.append(link.l,asset.l,button('导入为待审核',async()=>{await api('/plugins/'+p.id+'/releases/import','POST',{release_url:link.n.value,asset_name:asset.n.value||undefined});notice('已校验包名、版本和 SHA-256，导入为待审核；确认上架后才会出现在市场。');await refresh();await releases();}));
    importer.append(el('p','附件请使用 npm pack 生成的 .tgz。仓库源码 ZIP 不作为安装包。审核时请检查代码、权限和兼容性；系统校验下载内容，不代表已审计插件代码。','footnote'));
    const list=el('div',undefined,'table-wrap');box.append(list);const d=await api('/plugins/'+p.id+'/releases');
    table(list,['版本','状态','审核信息','操作'],d.releases.map(r=>[r.version,{pending:'待审核',published:'已上架',withdrawn:'已下架',rejected:'已驳回'}[r.state],cell(r.withdrawal_requested?'开发者申请下架':r.review_note||'—'),rowActions(button('详情',()=>inspect('版本详情',[['发布说明',r.notes||'—'],['发布时间',time(r.published_at)],['安装包校验值',r.sha256],['包大小',r.size_bytes+' bytes']])),button(r.state==='published'?'下架':'确认上架',async()=>{
      if(r.state!=='published'&&!confirm(`确认已审核 ${p.name} ${r.version}，将其上架供客户端安装？`))return;
      const review_note=prompt('审核说明（可留空）');if(review_note===null)return;await api('/plugins/'+p.id+'/releases/'+r.id+'/state','POST',{state:r.state==='published'?'withdrawn':'published',review_note});await refresh();await releases();
    }),...(r.state==='pending'?[button('驳回',async()=>{const review_note=prompt('驳回原因');if(!review_note)return;await api('/plugins/'+p.id+'/releases/'+r.id+'/state','POST',{state:'rejected',review_note});await refresh();await releases();})]:[]))]));
  }
  return {refresh};
}
