// Explicit one-off backfill: current prices, historical missing cache counts remain disclosed assumptions.
import { readFile } from 'node:fs/promises';
import { database } from '../src/database.mjs';
import { estimateTextCost, prices } from '../src/text-pricing.mjs';
const db=database({host:'db',user:'gateway',database:'gateway',password:(await readFile('/run/secrets/db-password','utf8')).trim()});
try {
  const rows=(await db.query(`SELECT id,model,input_tokens,output_tokens,total_tokens,status FROM requests
    WHERE pricing_details IS NULL AND usage_state='reported' AND model=ANY($1)`,[Object.keys(prices.models)])).rows;
  let recorded=0;
  for(const r of rows) {
    const estimate=estimateTextCost(r.model,{input:Number(r.input_tokens),output:Number(r.output_tokens),
      total:Number(r.total_tokens),cached_input:null,cache_write:null},{status:r.status,historical:true});
    if(estimate.amount===null)continue;
    await db.tx(async c=>{
      const saved=await c.query('UPDATE requests SET estimated_cost_cny=$2,pricing_details=$3 WHERE id=$1 AND pricing_details IS NULL RETURNING id',
        [r.id,estimate.amount,JSON.stringify(estimate.details)]);
      if(!saved.rowCount)return;
      await c.query('INSERT INTO audit_events(action,target_id,details) VALUES($1,$2,$3)',
        ['request.estimate.backfill',r.id,JSON.stringify({version:prices.version,amount:estimate.amount,warnings:estimate.details.warnings})]);
      recorded++;
    });
  }
  console.log(JSON.stringify({checked:rows.length,recorded}));
} finally {await db.close();}
