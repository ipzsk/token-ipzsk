// Read-only operational check. Only model IDs and HTTP status are emitted.
import { readFile } from 'node:fs/promises';
import { database } from '../src/database.mjs';
import { Upstream } from '../src/upstream.mjs';
const db=database({host:'db',user:'gateway',database:'gateway',password:(await readFile('/run/secrets/db-password','utf8')).trim()});
const upstream=new Upstream(db,'/run/upstream');
try {
  const keys=(await db.query('SELECT secret_ref,models FROM upstream_keys WHERE enabled ORDER BY created_at')).rows;
  console.log(JSON.stringify({configured:keys.map(key=>key.models)}));
  if(keys.length) {
    const response=await upstream.request(keys[0].secret_ref,'/v1/models',{signal:AbortSignal.timeout(30000)});
    if(!response.ok){await response.body?.cancel();console.log(JSON.stringify({status:response.status}));}
    else {
      const raw=await response.json();
      const items=Array.isArray(raw.data)?raw.data:Array.isArray(raw.data?.data)?raw.data.data:[];
      console.log(JSON.stringify({status:response.status,models:items.map(item=>item.id).filter(id=>typeof id==='string')}));
    }
  }
} finally {await db.close();}
