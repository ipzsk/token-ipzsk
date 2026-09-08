// Explicit release operation: add only the workstation's named model routes.
import { readFile } from 'node:fs/promises';
import { database } from '../src/database.mjs';
const models=['gpt-5.6-sol','gpt-image-2','seedance-2.0-mini','whisper-1'];
if(!process.argv.includes('--apply'))throw new Error('Pass --apply for the workstation release.');
const db=database({host:'db',user:'gateway',database:'gateway',password:(await readFile('/run/secrets/db-password','utf8')).trim()});
try{
  await db.tx(async c=>{
    const result=await c.query("SELECT id,models FROM upstream_keys WHERE secret_ref='apimart-primary.key' AND enabled FOR UPDATE");
    if(result.rowCount!==1)throw new Error('Primary upstream route unavailable');
    const row=result.rows[0],next=[...new Set([...row.models,...models])];
    await c.query('UPDATE upstream_keys SET models=$2 WHERE id=$1',[row.id,next]);
    await c.query('INSERT INTO audit_events(action,target_id,details) VALUES($1,$2,$3)',
      ['workstation.models.enable',row.id,JSON.stringify({previous:row.models,next})]);
    console.log(JSON.stringify({enabled_models:next}));
  });
}finally{await db.close();}
