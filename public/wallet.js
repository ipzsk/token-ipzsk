export function setupWallet({api,action,table,cell,money,time,number}) {
  const $ = s => document.querySelector(s);
  let page = 1;
  async function refresh() {
    const data = await api('/wallet/entries?page=' + page);
    table('#wallet-entries',['流水 / 用户','到账金额','入账后余额','来源','入账时间'],data.rows.map(r => [
      cell(r.id.slice(0,8),r.user_name),money(r.amount_cny),money(r.balance_after_cny),
      r.source === 'signup_bonus' ? '注册赠送' : r.source === 'payment' ? '在线充值' : '历史充值',time(r.created_at)
    ]));
    $('#wallet-page-label').textContent = `第 ${data.page} 页 · 共 ${number(data.count)} 条`;
    $('#wallet-prev').disabled = page <= 1;
    $('#wallet-next').disabled = page * data.page_size >= data.count;
  }
  for (const [id,delta] of [['wallet-prev',-1],['wallet-next',1]])
    $('#' + id).addEventListener('click',action(async () => { page += delta; await refresh(); }));
  return {refresh};
}
