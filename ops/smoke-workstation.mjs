// Explicit live smoke test: two small model calls, isolated database records.
// No customer content, credential values or upstream response bodies are logged.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { database } from '../src/database.mjs';
import { Upstream } from '../src/upstream.mjs';
import { Scheduler } from '../src/scheduler.mjs';
import { createApp } from '../src/app.mjs';
import { hash, token } from '../src/security.mjs';

if(!process.argv.includes('--live'))throw new Error('Pass --live to authorize two small upstream model calls.');
const config={host:'db',user:'gateway',password:(await readFile('/run/secrets/db-password','utf8')).trim()};
const production=database({...config,database:'gateway'});
let ref;
try{ref=(await production.query('SELECT secret_ref FROM upstream_keys WHERE enabled ORDER BY created_at LIMIT 1')).rows[0]?.secret_ref;}
finally{await production.close();}
assert.ok(ref,'No enabled upstream credential');
const setup=database({...config,database:'gateway_test'});
const schema='smoke_'+randomUUID().replaceAll('-','');
assert.equal((await setup.query('SELECT current_database() AS name')).rows[0].name,'gateway_test');
await setup.query(`CREATE SCHEMA ${schema}`);
const db=database({...config,database:'gateway_test',options:`-c search_path=${schema}`});
const upstream=new Upstream(db,'/run/upstream');
let app;
try{
  await db.migrate();
  const account=randomUUID(),key=randomUUID(),user=randomUUID(),credential=token('ipz_');
  await db.query('INSERT INTO upstream_accounts(id,name) VALUES($1,$2)',[account,'Isolated smoke test']);
  await db.query('INSERT INTO upstream_keys(id,account_id,name,fingerprint,suffix,secret_ref,models) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [key,account,'Smoke key metadata','smoke','test',ref,['gpt-5.6-sol','claude-sonnet-4-6']]);
  await db.query('INSERT INTO users(id,name) VALUES($1,$2)',[user,'Synthetic smoke user']);
  await db.query('INSERT INTO access_tokens(id,user_id,token_hash,prefix) VALUES($1,$2,$3,$4)',[randomUUID(),user,hash(credential),'ipz_test']);
  await upstream.refresh();
  app=await createApp({db,upstream,scheduler:new Scheduler(),origin:'https://api.ipzsk.com',secureCookies:true});
  const parameters={type:'object',properties:{name:{type:'string'}},required:['name'],additionalProperties:false};
  const cases=[
    ['/v1/responses',{model:'gpt-5.6-sol',input:'Call write_test_file with name smoke.txt.',max_output_tokens:256,
      tools:[{type:'function',name:'write_test_file',description:'Create a synthetic test file.',parameters,strict:true}],tool_choice:{type:'function',name:'write_test_file'},stream:true},'function_call'],
    ['/v1/messages',{model:'claude-sonnet-4-6',max_tokens:256,messages:[{role:'user',content:'Call write_test_file with name smoke.txt.'}],
      tools:[{name:'write_test_file',description:'Create a synthetic test file.',input_schema:parameters}],tool_choice:{type:'tool',name:'write_test_file'},stream:true},'tool_use'],
  ];
  let failed=false;
  for(const [path,payload,expected]of cases){
    const result=await app.inject({method:'POST',url:path,payload,headers:{authorization:'Bearer '+credential}});
    const record=(await db.query('SELECT status,usage_state,input_tokens,output_tokens,error_code FROM requests WHERE id=$1',[result.headers['x-request-id']])).rows[0];
    const toolCall=result.body.includes(expected)&&result.body.includes('write_test_file');
    console.log(JSON.stringify({path,model:payload.model,http:result.statusCode,toolCall,record}));
    if(result.statusCode!==200||!toolCall||record?.status!=='succeeded')failed=true;
  }
  if(failed)process.exitCode=1;
}finally{
  upstream.close();await upstream.pending?.catch(()=>{});
  await app?.close();await db.close();
  await setup.query(`DROP SCHEMA ${schema} CASCADE`);await setup.close();
}
