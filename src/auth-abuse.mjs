import { hash, httpError } from './security.mjs';

// Fixed windows live in PostgreSQL so workers/restarts share the same limits.
export async function takeAuthLimit(db,key,limit,seconds) {
  await db.query('DELETE FROM auth_abuse_limits WHERE key_hash IN (SELECT key_hash FROM auth_abuse_limits WHERE expires_at<=now() LIMIT 100)');
  const result=await db.query(`INSERT INTO auth_abuse_limits(key_hash,count,expires_at) VALUES($1,1,now()+$2*interval '1 second')
    ON CONFLICT(key_hash) DO UPDATE SET count=CASE WHEN auth_abuse_limits.expires_at<=now() THEN 1 ELSE auth_abuse_limits.count+1 END,
    expires_at=CASE WHEN auth_abuse_limits.expires_at<=now() THEN EXCLUDED.expires_at ELSE auth_abuse_limits.expires_at END
    WHERE auth_abuse_limits.expires_at<=now() OR auth_abuse_limits.count<$3 RETURNING count`,[hash(key),seconds,limit]);
  if(!result.rowCount)throw httpError(429,'rate_limited');
  return result.rows[0].count;
}

export async function verifyAuthCaptcha(db,captcha,body,ip,action) {
  if(!captcha.ready)throw httpError(503,'captcha_unavailable');
  const proof=body?.captcha;
  if(!proof)throw httpError(403,'captcha_required');
  if(typeof proof.token!=='string'||!proof.token.length||proof.token.length>2048)throw httpError(403,'captcha_invalid');
  await captcha.verify({token:proof.token,ip,action,email:body.email});
}
