import { passwordHash,verifyPassword,httpError } from './security.mjs';
import * as v from './validation.mjs';
import { lanehubMode } from './lanehub.mjs';
export function adminAccountRoutes(app,{db,lanehub=null}){
  app.get('/admin/api/administrators',async()=>({rows:(await db.query('SELECT id,username,role,enabled FROM administrators ORDER BY id')).rows}));
  app.post('/admin/api/administrators',async req=>{
    const username=v.text(req.body?.username,100),password=v.text(req.body?.password,256),role=req.body?.role;
    if(!/^[a-zA-Z0-9_.-]{3,40}$/.test(username)||password.length<16||!['superadmin','operator','viewer'].includes(role))throw httpError(400,'invalid_administrator');
    const hashed=await passwordHash(password);
    return db.tx(async c=>{
      await c.query('LOCK TABLE administrators IN EXCLUSIVE MODE');
      const row=(await c.query('INSERT INTO administrators(id,username,password_hash,role) SELECT coalesce(max(id),0)+1,$1,$2,$3 FROM administrators RETURNING id',[username,hashed,role])).rows[0];return row;
    });
  });
  app.post('/admin/api/administrators/:id/disable',async req=>{
    const id=v.integer(Number(req.params.id),1,1000000);
    if(id===req.administrator.id)throw httpError(409,'cannot_disable_self');
    await db.tx(async c=>{
      await c.query('UPDATE administrators SET enabled=false WHERE id=$1',[id]);
      await c.query('DELETE FROM admin_sessions WHERE administrator_id=$1',[id]);
    });return {ok:true};
  });
  app.post('/admin/api/password',async req=>{
    const current=v.text(req.body?.current_password,256),next=v.text(req.body?.password,256);
    if(next.length<16)throw httpError(400,'password_too_short');
    const hashed=await passwordHash(next);
    await db.tx(async c=>{
      const row=(await c.query('SELECT password_hash FROM administrators WHERE id=$1 FOR UPDATE',[req.administrator.id])).rows[0];
      if(!await verifyPassword(current,row.password_hash))throw httpError(401,'invalid_password');
      await c.query('UPDATE administrators SET password_hash=$2 WHERE id=$1',[req.administrator.id,hashed]);
      await c.query('DELETE FROM admin_sessions WHERE administrator_id=$1',[req.administrator.id]);
    });return {ok:true};
  });
  app.get('/admin/api/audit',async()=>({rows:(await db.query(`SELECT e.id,e.action,e.target_id,e.created_at,e.details,a.username FROM audit_events e LEFT JOIN administrators a ON a.id=e.administrator_id ORDER BY e.id DESC LIMIT 200`)).rows}));
  app.get('/admin/api/ledger',async req=>{
    const user=req.query.user_id?v.uuid(req.query.user_id):null;
    // lanehub 模式下消费不落 wallet_debits（钱是对面扣的），流水要从 request_billing 取——
    // 否则后台的「钱包流水」只有充值、没有消费，对不上用户的真实余额。
    const lanehubOn=Boolean(lanehub)&&await lanehubMode(db);
    const consumption=lanehubOn
      ? `SELECT request_id AS id,user_id,-charged_cny AS amount_cny,NULL::numeric AS balance_after_cny,coalesce(resolved_at,created_at) AS created_at,'consumption' AS kind,request_id FROM request_billing WHERE state='settled' AND charged_cny>0`
      : `SELECT id,user_id,-amount_cny,balance_after_cny,created_at,'consumption' AS kind,request_id FROM wallet_debits`;
    return {rows:(await db.query(`SELECT l.*,u.name AS user_name FROM (
      SELECT id,user_id,amount_cny,balance_after_cny,created_at,'recharge' AS kind,NULL::uuid AS request_id FROM wallet_entries
      UNION ALL ${consumption}
      UNION ALL SELECT p.id,p.user_id,-f.balance_deduction_cny,NULL::numeric,f.created_at,'payment_refund',NULL::uuid
        FROM commission_payment_refunds f JOIN payment_orders p ON p.id=f.payment_order_id WHERE f.balance_deduction_cny>0
    ) l JOIN users u ON u.id=l.user_id WHERE ($1::uuid IS NULL OR user_id=$1) ORDER BY created_at DESC LIMIT 200`,[user])).rows};
  });
}
