const $=(s)=>document.querySelector(s);let sentEmail='',hasToken=false,ready=false,countdown=null;
const money=(v)=>Number(v).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})+' 元';
const errors={email_service_unavailable:'邮箱登录暂未开放，发信服务正在配置。',email_delivery_failed:'邮件发送失败，请稍后重试。',customer_login_required:'请先使用邮箱验证码登录。',account_disabled:'账户已停用，请联系管理员。',invalid_email:'请检查邮箱地址。',rate_limited:'请求过于频繁，请稍后重试。',INVALID_OTP:'验证码错误或已失效，请检查后重试。',OTP_EXPIRED:'验证码已过期，请重新发送。',TOO_MANY_ATTEMPTS:'验证次数过多，请重新发送验证码。',INVALID_EMAIL:'邮箱地址格式不正确。',voucher_unavailable:'充值码不可用，请核对是否已兑换、过期或尚未启用。',invalid_voucher:'请检查充值码格式。'};
function clearSession(){hasToken=false;$('#customer-panel').hidden=true;$('#email-login').hidden=false;$('#customer-token').value='';$('#customer-token-result').hidden=true;$('#customer-redeem-form').reset();$('#customer-email').textContent='';$('#customer-id').textContent='';$('#customer-balance').textContent='';$('#customer-ledger').replaceChildren();}
async function request(path,body){const r=await fetch(path,{method:body?'POST':'GET',credentials:'same-origin',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});const d=await r.json();if(!r.ok){if(r.status===401)clearSession();throw new Error(errors[d.error?.code??d.code]??'操作未成功，请稍后重试。');}return d;}
function handler(fn){return async(e)=>{e.preventDefault();const b=e.target.closest('button')??e.target.querySelector('button');if(b)b.disabled=true;$('#account-notice').textContent='';try{await fn(e);}catch(error){$('#account-notice').textContent=error.message;}finally{if(b&&b.id!=='send-otp')b.disabled=false;}};}
async function loadAccount(){
  const [profile,wallet,usage]=await Promise.all([request('/api/me/profile'),request('/api/me/wallet'),request('/api/me/usage')]);
  if(!profile.user.email_verified)throw new Error('请使用已验证的邮箱账户登录。');
  $('#email-login').hidden=true;$('#customer-panel').hidden=false;
  $('#customer-email').textContent=profile.user.email;$('#customer-id').textContent='用户 ID：'+profile.user.id;
  $('#customer-balance').textContent=money(wallet.balance_cny);$('#customer-usage').textContent=`累计请求 ${usage.summary.requests} 次 · 累计 ${usage.summary.total_tokens} token`;
  hasToken=!!profile.credential;$('#customer-token-prefix').textContent=hasToken?profile.credential.prefix+'…':'尚未生成 API 凭证';$('#customer-issue-token').textContent=hasToken?'重置 API 凭证':'生成 API 凭证';
  $('#customer-ledger').replaceChildren(...wallet.entries.map((r)=>{const p=document.createElement('p');p.className='muted';p.textContent=`${new Date(r.created_at).toLocaleString('zh-CN')} · +${money(r.amount_cny)} · 流水 ${r.id.slice(0,8)}`;return p;}));
}
$('#email-send-form').addEventListener('submit',handler(async()=>{
  try{const email=$('#login-email').value.trim().toLowerCase();await request('/api/auth/email-otp/send-verification-otp',{email,type:'sign-in'});sentEmail=email;$('#email-verify-form').hidden=false;$('#email-verify-form').reset();$('#account-notice').textContent='验证码已发送，请查看邮箱。';
    let seconds=60;clearInterval(countdown);$('#send-otp').textContent=`${seconds} 秒后可重发`;countdown=setInterval(()=>{seconds--;$('#send-otp').textContent=seconds>0?`${seconds} 秒后可重发`:'发送验证码';if(seconds<=0){clearInterval(countdown);$('#send-otp').disabled=!ready;}},1000);
  }catch(e){$('#send-otp').disabled=!ready;throw e;}
}));
$('#email-verify-form').addEventListener('submit',handler(async(e)=>{
  if($('#login-email').value.trim().toLowerCase()!==sentEmail)throw new Error('邮箱已更改，请先向新邮箱发送验证码。');
  await request('/api/auth/sign-in/email-otp',{email:sentEmail,otp:e.target.elements.otp.value});e.target.reset();await loadAccount();$('#account-notice').textContent='已登录，邮箱验证成功。';
}));
$('#customer-redeem-form').addEventListener('submit',handler(async(e)=>{const r=await request('/api/me/vouchers/redeem',{code:e.target.elements.code.value});e.target.reset();await loadAccount();$('#account-notice').textContent=r.replayed?'这枚码已兑换到你的账户，未重复入账。':`兑换成功，已入账 ${money(r.amount_cny)}。`;}));
$('#customer-issue-token').addEventListener('click',handler(async()=>{if(hasToken&&!confirm('重置后原 API 凭证立即失效，确定继续？'))return;const r=await request('/api/me/token',{});$('#customer-token').value=r.token;$('#customer-token-result').hidden=false;await loadAccount();}));
$('#customer-copy-token').addEventListener('click',handler(async()=>{await navigator.clipboard.writeText($('#customer-token').value);$('#account-notice').textContent='已复制凭证。';}));
$('#customer-refresh').addEventListener('click',handler(loadAccount));
$('#customer-logout').addEventListener('click',handler(async()=>{await request('/api/auth/sign-out',{});clearSession();$('#account-notice').textContent='已退出。';}));
try{const status=await request('/api/account/status');ready=status.email_login_ready;$('#send-otp').disabled=!ready;if(!ready)$('#account-notice').textContent=errors.email_service_unavailable;await loadAccount();}catch{clearSession();}
