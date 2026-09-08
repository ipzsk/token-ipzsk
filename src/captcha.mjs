import { randomBytes, randomInt, createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { createCaptcha } from 'captcha-canvas';
import { hash, httpError } from './security.mjs';

export const unavailableCaptcha=()=>({ready:false,async verify(){throw httpError(503,'captcha_unavailable');}});
const actions=['register','resend','reset','login'];
const alphabet='23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const opaque=()=>randomBytes(32).toString('base64url');
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{43}$/.test(value);
export function createImageCaptcha({db,secret,render=createCaptcha}) {
  if(typeof secret!=='string'||secret.length<32)throw Error('captcha_secret_required');
  const digest=value=>createHmac('sha256',secret).update(value).digest('hex');
  const binding=({ip,action,email})=>{
    if(!isIP(String(ip))||!actions.includes(action)||typeof email!=='string'||email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw httpError(400,'invalid_captcha_request');
    return digest(JSON.stringify([ip,action,email.trim().toLowerCase()]));
  };
  let rendering=0;
  return {ready:true,provider:'captcha-canvas',async issue(context){
    const bound=binding(context);
    if(rendering>=2)throw httpError(429,'rate_limited');
    rendering++;
    try{
      const id=opaque(),answer=Array.from({length:5},()=>alphabet[randomInt(alphabet.length)]).join('');
      const {image}=render(300,110,{captcha:{text:answer,characters:5,size:44,font:'DejaVu Sans',color:'#172417',opacity:1,rotate:12,skew:true},decoy:{total:12,opacity:0.25},trace:{size:2,color:'#568441',opacity:0.6}});
      const png=await image;
      await db.query('DELETE FROM image_captchas WHERE id IN (SELECT id FROM image_captchas WHERE expires_at<=now() LIMIT 100)');
      await db.query(`INSERT INTO image_captchas(id,binding_hash,answer_hash,expires_at) VALUES($1,$2,$3,now()+interval '120 seconds')`,[id,bound,digest(id+':'+answer)]);
      return {id,image:'data:image/png;base64,'+png.toString('base64'),expires_in:120,length:5};
    }finally{rendering--;}
  },async solve(context){
    const bound=binding(context),{id,answer}=context;
    if(!validId(id)||typeof answer!=='string'||!new RegExp('^['+alphabet+']{5}$').test(answer.trim().toUpperCase()))throw httpError(403,'captcha_invalid');
    // Lock the challenge so concurrent guesses cannot exceed the attempt budget or mint multiple proofs.
    const result=await db.tx(async c=>{
      const row=(await c.query('SELECT *,expires_at>now() AS active FROM image_captchas WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!row||!row.active||row.binding_hash!==bound||!row.answer_hash||row.attempts>=5)return null;
      const correct=timingSafeEqual(Buffer.from(row.answer_hash,'hex'),Buffer.from(digest(id+':'+answer.trim().toUpperCase()),'hex'));
      if(!correct){await c.query('UPDATE image_captchas SET attempts=attempts+1 WHERE id=$1',[id]);return null;}
      const token=opaque();
      await c.query(`UPDATE image_captchas SET answer_hash=NULL,proof_hash=$2,expires_at=now()+interval '90 seconds' WHERE id=$1`,[id,hash(token)]);
      return {token};
    });
    if(!result)throw httpError(403,'captcha_invalid');
    return result;
  },async verify(context){
    const bound=binding(context);
    if(!validId(context.token))throw httpError(403,'captcha_invalid');
    // Atomic deletion consumes the proof exactly once, including across workers/restarts.
    const result=await db.query('DELETE FROM image_captchas WHERE proof_hash=$1 AND binding_hash=$2 AND expires_at>now() RETURNING id',[hash(context.token),bound]);
    if(!result.rowCount)throw httpError(403,'captcha_invalid');
  }};
}
