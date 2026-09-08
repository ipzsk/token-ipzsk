import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { database } from '/app/src/database.mjs';
const [action,id,tokenHash]=process.argv.slice(2);
if(!/^[a-f0-9-]{36}$/.test(id??'')||!['create','disable'].includes(action))throw new Error('Invalid smoke operation');
const db=database({host:'db',user:'gateway',database:'gateway',password:(await readFile('/run/secrets/db-password','utf8')).trim()});
try{
  if(action==='create'){
    if(!/^[a-f0-9]{64}$/.test(tokenHash??''))throw new Error('Invalid hash');
    await db.tx(async c=>{
      await c.query('INSERT INTO users(id,name,rpm) VALUES($1,$2,5)',[id,'IPZSK 工作台发布验证']);
      await c.query('INSERT INTO access_tokens(id,user_id,token_hash,prefix) VALUES($1,$2,$3,$4)',[randomUUID(),id,tokenHash,'ipz_smoke']);
    });
  }else{
    await db.tx(async c=>{
      await c.query('UPDATE access_tokens SET revoked_at=now() WHERE user_id=$1',[id]);
      await c.query('UPDATE users SET enabled=false WHERE id=$1 AND name=$2',[id,'IPZSK 工作台发布验证']);
    });
  }
  console.log(action==='create'?'smoke_user_created':'smoke_user_disabled');
}finally{await db.close();}
