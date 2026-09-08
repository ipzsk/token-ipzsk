import { readFile } from 'node:fs/promises';
import { createHmac, createHash } from 'node:crypto';
import { httpError } from './security.mjs';

// Tencent Cloud API v3 signing, using Node's cryptographic primitives.
// The only destination/action is SES SendEmail; no arbitrary URL is accepted.
const sha256=(value)=>createHash('sha256').update(value).digest('hex');
const hmac=(key,value)=>createHmac('sha256',key).update(value).digest();
export function sesRequest(config,{email,otp},timestamp=Math.floor(Date.now()/1000)) {
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!/^\d{6}$/.test(otp))throw new Error('invalid_email_payload');
  const host='ses.tencentcloudapi.com',date=new Date(timestamp*1000).toISOString().slice(0,10);
  const body=JSON.stringify({FromEmailAddress:config.from,Destination:[email],Subject:'IPZSK 登录验证码',
    Template:{TemplateID:config.templateId,TemplateData:JSON.stringify({code:otp})},TriggerType:1});
  const scope=`${date}/ses/tc3_request`;
  const canonical=`POST\n/\n\ncontent-type:application/json\nhost:${host}\n\ncontent-type;host\n${sha256(body)}`;
  const toSign=`TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${sha256(canonical)}`;
  const signingKey=hmac(hmac(hmac('TC3'+config.secretKey,date),'ses'),'tc3_request');
  const signature=hmac(signingKey,toSign).toString('hex');
  return {body,headers:{'Content-Type':'application/json','X-TC-Action':'SendEmail','X-TC-Version':'2020-10-02',
    'X-TC-Region':config.region,'X-TC-Timestamp':String(timestamp),
    Authorization:`TC3-HMAC-SHA256 Credential=${config.secretId}/${scope}, SignedHeaders=content-type;host, Signature=${signature}`}};
}
export async function loadMailer(path,fetcher=fetch) {
  let config;
  try {config=JSON.parse(await readFile(path,'utf8'));}
  catch {return {ready:false,provider:'tencent-ses',send:async()=>{throw httpError(503,'email_service_unavailable');}};}
  if(!config||!['ap-hongkong','ap-guangzhou'].includes(config.region)||!Number.isSafeInteger(config.templateId)||config.templateId<=0||
    typeof config.from!=='string'||!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(config.from)||
    typeof config.secretId!=='string'||!/^AKID[A-Za-z0-9]{10,100}$/.test(config.secretId)||
    typeof config.secretKey!=='string'||config.secretKey.length<16||config.secretKey.length>256) {
    return {ready:false,provider:'tencent-ses',send:async()=>{throw httpError(503,'email_service_unavailable');}};
  }
  return {ready:true,provider:'tencent-ses',async send(payload){
    try{
      const request=sesRequest(config,payload);
      const response=await fetcher('https://ses.tencentcloudapi.com/',{method:'POST',...request,redirect:'error',signal:AbortSignal.timeout(15000)});
      const data=await response.json();
      if(!response.ok||data.Response?.Error||!data.Response?.MessageId)throw new Error('send_failed');
    }catch {throw httpError(503,'email_delivery_failed');}
  }};
}
