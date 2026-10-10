import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { httpError } from './security.mjs';
import { uuid } from './validation.mjs';

const text=(value,max=100)=>{if(typeof value!=='string'||!value.trim()||value.length>max)throw httpError(400,'invalid_plugin');return value.trim();};
const repository=value=>{const s=text(value,200);if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s))throw httpError(400,'invalid_github_repository');return s;};
const packageName=value=>{const s=text(value,214);if(!/^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(s))throw httpError(400,'invalid_package_name');return s;};
const models=value=>{if(!Array.isArray(value)||value.length>50||value.some(v=>typeof v!=='string'||! /^[A-Za-z0-9._-]{1,128}$/.test(v)))throw httpError(400,'invalid_models');return [...new Set(value)];};

function runtime(b){
  const id=b.runtime_id??null,config=b.runtime_config??{},paths=b.credential_paths??[];
  if(id!==null && (typeof id!=='string'||!/^[a-z0-9-]{1,100}$/.test(id)))throw httpError(400,'invalid_runtime_config');
  if(!config||typeof config!=='object'||Array.isArray(config)||JSON.stringify(config).length>10000||!Array.isArray(paths)||paths.length>10)throw httpError(400,'invalid_runtime_config');
  for(const path of paths){
    if(!Array.isArray(path)||!path.length||path.length>5||path.some(k=>typeof k!=='string'||!/^[a-zA-Z0-9_-]+$/.test(k)||['__proto__','constructor','prototype'].includes(k)))throw httpError(400,'invalid_credential_path');
    let value=config;for(const key of path)value=value?.[key];
    if(value!==undefined && value!==null && value!=='')throw httpError(400,'credentials_must_not_be_stored');
  }
  return {id,config,paths};
}

async function bytes(response,limit){
  if(!response.ok) {await response.body?.cancel();throw httpError(502,'github_fetch_failed');}
  const chunks=[];let size=0;
  for await(const chunk of response.body){size+=chunk.length;if(size>limit)throw httpError(400,'release_too_large');chunks.push(chunk);}
  return Buffer.concat(chunks);
}
// Only GitHub release assets are fetched; no arbitrary server-side URL or credentials.
export async function importGithubRelease(plugin,body,fetcher=fetch){
  let url;try{url=new URL(body.release_url);}catch{throw httpError(400,'invalid_release_url');}
  const prefix='/'+plugin.repository+'/releases/tag/';
  if(url.origin!=='https://github.com'||url.username||url.password||url.search||url.hash||!url.pathname.startsWith(prefix))throw httpError(400,'invalid_release_url');
  let tag;try{tag=decodeURIComponent(url.pathname.slice(prefix.length));}catch{throw httpError(400,'invalid_release_url');}
  if(!tag||tag.length>100)throw httpError(400,'invalid_release_url');
  const version=tag.replace(/^v/,'');
  if(!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))throw httpError(400,'release_tag_must_be_version');
  const signal=AbortSignal.timeout(25000);
  const raw=await bytes(await fetcher(`https://api.github.com/repos/${plugin.repository}/releases/tags/${encodeURIComponent(tag)}`,
    {headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'ipzsk-market'},redirect:'error',signal}),2_000_000);
  let release;try{release=JSON.parse(raw);}catch{throw httpError(502,'invalid_github_release');}
  if(release.draft||!Number.isSafeInteger(release.id)||!Array.isArray(release.assets))throw httpError(400,'release_not_public');
  const assets=release.assets.filter(a=>a.state==='uploaded'&&/\.tgz$/.test(a.name));
  const asset=body.asset_name?assets.find(a=>a.name===body.asset_name):assets.length===1?assets[0]:null;
  if(!asset||!Number.isSafeInteger(asset.id))throw httpError(400,'select_one_tgz_asset');
  if(asset.size>50_000_000||asset.size<=0)throw httpError(400,'release_too_large');
  let artifact;try{artifact=new URL(asset.browser_download_url);}catch{throw httpError(502,'invalid_github_asset');}
  if(artifact.origin!=='https://github.com'||!artifact.pathname.startsWith('/'+plugin.repository+'/releases/download/')||artifact.username||artifact.password)throw httpError(502,'invalid_github_asset');
  let download=artifact.href,response;
  for(let i=0;i<4;i++){
    const next=new URL(download);
    if(next.protocol!=='https:'||next.username||next.password||!['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(next.hostname)||next.port)throw httpError(502,'invalid_asset_redirect');
    response=await fetcher(download,{redirect:'manual',signal});
    if(![301,302,303,307,308].includes(response.status))break;
    const location=response.headers.get('location');await response.body?.cancel();
    if(!location)throw httpError(502,'invalid_asset_redirect');
    download=new URL(location,download).href;
  }
  const archive=await bytes(response,50_000_000);
  if(archive.length!==asset.size)throw httpError(502,'asset_size_mismatch');
  const sha256=createHash('sha256').update(archive).digest('hex');
  if(asset.digest&&asset.digest!=='sha256:'+sha256)throw httpError(502,'asset_digest_mismatch');
  let manifest;
  try{manifest=JSON.parse(execFileSync('tar',['-xzOf','-','package/package.json'],{input:archive,timeout:10000,maxBuffer:1_000_000,stdio:['pipe','pipe','pipe']}).toString());}
  catch{throw httpError(400,'invalid_plugin_archive');}
  if(manifest.name!==plugin.package_name||manifest.version!==version)throw httpError(400,'package_identity_mismatch');
  return {version,github_release_id:release.id,github_asset_id:asset.id,release_url:url.href,
    artifact_url:artifact.href,sha256,size_bytes:archive.length,notes:String(release.body??'').slice(0,10000)};
}
function period(query){
  const today=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'}),from=query.from??today.slice(0,8)+'01',to=query.to??today;
  for(const v of [from,to])if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString().slice(0,10)!==v)throw httpError(400,'invalid_date');
  if(from>to||Date.parse(to)-Date.parse(from)>366*86400000)throw httpError(400,'invalid_date_range');
  return {from,to};
}
export function pluginRoutes(app,{db,githubFetch}){
  app.get('/admin/api/plugins/review-queue',async()=>({releases:(await db.query("SELECT r.id,r.plugin_id,r.version,r.state,r.withdrawal_requested,r.created_at,p.name AS plugin_name FROM plugin_releases r JOIN plugins p ON p.id=r.plugin_id WHERE r.state='pending' OR r.withdrawal_requested ORDER BY r.created_at")).rows}));
  app.get('/admin/api/plugins',async()=>({plugins:(await db.query('SELECT * FROM plugins ORDER BY created_at,id')).rows}));
  app.post('/admin/api/plugins',async req=>{
    const b=req.body??{},slug=text(b.slug,80);
    if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))throw httpError(400,'invalid_plugin_slug');
    const id=randomUUID();
    await db.query(`INSERT INTO plugins(id,slug,name,repository,package_name,publisher_ref,allowed_models) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [id,slug,text(b.name),repository(b.repository),packageName(b.package_name),text(b.publisher_ref),models(b.allowed_models??[])]);
    return {id};
  });
  app.post('/admin/api/plugins/:id/settings',async req=>{
    const id=uuid(req.params.id),b=req.body??{};
    if(typeof b.enabled!=='boolean')throw httpError(400,'invalid_plugin');
    const r=runtime(b);
    const saved=await db.query('UPDATE plugins SET enabled=$2,name=$3,publisher_ref=$4,allowed_models=$5,runtime_id=$6,runtime_config=$7,credential_paths=$8 WHERE id=$1 RETURNING id',
      [id,b.enabled,text(b.name),text(b.publisher_ref),models(b.allowed_models),r.id,JSON.stringify(r.config),JSON.stringify(r.paths)]);
    if(!saved.rowCount)throw httpError(404,'plugin_not_found');return {ok:true};
  });
  app.get('/admin/api/plugins/:id/releases',async req=>({releases:(await db.query('SELECT * FROM plugin_releases WHERE plugin_id=$1 ORDER BY created_at DESC',[uuid(req.params.id)])).rows}));
  app.post('/admin/api/plugins/:id/releases/import',async req=>{
    const plugin=(await db.query('SELECT * FROM plugins WHERE id=$1',[uuid(req.params.id)])).rows[0];
    if(!plugin)throw httpError(404,'plugin_not_found');
    const r=await importGithubRelease(plugin,req.body??{},githubFetch),id=randomUUID();
    await db.query(`INSERT INTO plugin_releases(id,plugin_id,version,github_release_id,github_asset_id,release_url,artifact_url,sha256,size_bytes,notes,imported_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[id,plugin.id,r.version,r.github_release_id,r.github_asset_id,r.release_url,r.artifact_url,r.sha256,r.size_bytes,r.notes,req.administrator.id]);
    return {id,state:'pending',...r};
  });
  app.post('/admin/api/plugins/:id/releases/:releaseId/state',async req=>{
    const {state}=req.body??{};
    if(!['published','withdrawn','rejected'].includes(state))throw httpError(400,'invalid_release_state');
    const saved=await db.tx(async c=>{
      await c.query('SELECT id FROM plugins WHERE id=$1 FOR UPDATE',[uuid(req.params.id)]);
      return c.query(`UPDATE plugin_releases SET state=$3,review_note=$5,withdrawal_requested=false,published_by=CASE WHEN $3='published' THEN $4 ELSE published_by END,
      published_at=CASE WHEN $3='published' THEN now() ELSE published_at END WHERE plugin_id=$1 AND id=$2 RETURNING id`,
      [uuid(req.params.id),uuid(req.params.releaseId),state,req.administrator.id,String(req.body.review_note??'').slice(0,500)]);
    });
    if(!saved.rowCount)throw httpError(404,'release_not_found');return {ok:true};
  });
  app.get('/api/me/plugin-market',async()=>({market_id:'dsh-ipzsk-market',plugins:(await db.query(`SELECT p.id,p.slug,p.name,p.package_name,p.repository,
    r.id AS release_id,r.version,r.artifact_url,r.sha256,r.size_bytes::integer AS size_bytes,r.notes,r.published_at
    FROM plugins p JOIN LATERAL (SELECT * FROM plugin_releases WHERE plugin_id=p.id AND state='published' ORDER BY published_at DESC,id DESC LIMIT 1) r ON true
    WHERE p.enabled ORDER BY p.slug`)).rows}));
  app.get('/admin/api/plugin-usage',async req=>{
    const {from,to}=period(req.query),id=req.query.plugin_id?uuid(req.query.plugin_id):null;
    const rows=(await db.query(`SELECT r.plugin_id,p.name AS plugin_name,r.plugin_publisher_ref,r.model,
      count(DISTINCT r.user_id) FILTER(WHERE (t.id IS NULL AND r.status='succeeded') OR t.status='completed') AS active_users,
      count(*) AS requests,count(*) FILTER(WHERE r.status='failed') AS failed_requests,
      count(*) FILTER(WHERE r.usage_state='reported') AS reported_usage_requests,
      count(*) FILTER(WHERE r.total_tokens IS NULL) AS unknown_token_requests,
      sum(r.input_tokens) AS input_tokens,sum(r.output_tokens) AS output_tokens,sum(r.total_tokens) AS total_tokens,
      sum(r.cost_cny) AS confirmed_cost_cny,count(*) FILTER(WHERE r.cost_cny IS NULL) AS unknown_cost_requests,
      -- 分成读 plugin_earnings（唯一真源：计提一行、退款一行负数），不在这里按
      -- charged_cny 再算一遍——两份口径只要差一点，打给作者的钱就是错的。
      sum((SELECT coalesce(sum(pe.amount_cny),0) FROM plugin_earnings pe WHERE pe.request_id=r.id)
        +(SELECT coalesce(sum(cl.amount_cny),0) FROM commission_ledger cl WHERE cl.request_id=r.id AND cl.kind='developer')) AS developer_earnings_cny,
      sum(b.refunded_cny) FILTER(WHERE b.state='settled') AS refunded_cny,
      sum(b.charged_cny-b.refunded_cny-r.cost_cny) FILTER(WHERE b.state='settled' AND r.cost_cny IS NOT NULL) AS confirmed_margin_cny,
      count(*) FILTER(WHERE b.state='settled' AND r.cost_cny IS NOT NULL) AS margin_known_requests,
      sum(b.charged_cny) FILTER(WHERE b.state='settled') AS charged_cny,
      count(*) FILTER(WHERE b.state='settled') AS settled_requests,
      count(t.id) AS media_tasks,count(*) FILTER(WHERE t.status='completed') AS completed_media_tasks,
      count(*) FILTER(WHERE t.status='failed') AS failed_media_tasks
      FROM requests r LEFT JOIN plugins p ON p.id=r.plugin_id LEFT JOIN request_billing b ON b.request_id=r.id LEFT JOIN media_tasks t ON t.id=r.id
      WHERE r.created_at>=($1::date::timestamp AT TIME ZONE 'Asia/Shanghai') AND r.created_at<(($2::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')
      AND ($3::uuid IS NULL OR r.plugin_id=$3) GROUP BY r.plugin_id,p.name,r.plugin_publisher_ref,r.model ORDER BY p.name NULLS LAST,r.model`,[from,to,id])).rows;
    return {from,to,timezone:'Asia/Shanghai',rows};
  });
}

export {text,repository,packageName,period};
