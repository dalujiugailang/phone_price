// Uses the application's authenticated, idempotent import and optimistic link APIs.
// No direct SQLite writes and no catalog removals. Credentials are never logged.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {isKnownStorage,extractStorageVariants,isAllowedJdOffer} from './lib/jd-storage.mjs';
const args=process.argv.slice(2), arg=(k,d)=>{const i=args.indexOf(k);return i<0?d:args[i+1];};
const file=arg('--payload');if(!file)throw Error('Specify --payload');
const payload=JSON.parse(fs.readFileSync(file));
if(createHash('sha256').update(JSON.stringify(payload.rows)).digest('hex')!==payload.hash)throw Error('Payload hash mismatch');
for(const row of payload.rows){
  const s=row.selected;
  if(!s || !extractStorageVariants(row.model,s.title).some(v=>isKnownStorage(v,[row.storage])))throw Error(`Unverified model/storage: ${row.model} ${row.storage}`);
  if(!isAllowedJdOffer(row.model,row.brand,{title:s.title,shopName:s.shop,sourceType:2,shopType:1}) || !/sourceType=2; shopType=1;.*自营/.test(s.selfEvidence))throw Error('Missing self-operated detail evidence');
}
const base=arg('--base','https://www.gtmdudu.xyz'), cookieFile=arg('--cookie');
const cookie=cookieFile?fs.readFileSync(cookieFile,'utf8').trim():'';
const headers={'Content-Type':'application/json',Origin:new URL(base).origin,...(cookie?{Cookie:cookie}:{})};
async function api(url,body,method='POST'){
  const r=await fetch(base+url,{method:body?method:'GET',headers,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});
  const j=await r.json();if(!r.ok)throw Error(`HTTP ${r.status}: ${j.message}`);return j;
}
const before=await api(`/api/workbench/rows?date=${payload.date}`);
const baselineFile=arg('--baseline');
if(baselineFile){const baseline=JSON.parse(fs.readFileSync(baselineFile));for(const row of payload.rows){
  const old=baseline.rows.find(r=>r.model===row.model&&isKnownStorage(row.storage,[r.storage]));
  const live=before.rows.find(r=>r.model===row.model&&isKnownStorage(row.storage,[r.storage]));
  if(old && (!live || old.work?.version!==live.work?.version))throw Error(`Concurrent change: ${row.model} ${row.storage}`);
  if(!old && live)throw Error(`Addition already exists: ${row.model} ${row.storage}`);
}}
if(!args.includes('--apply')){console.log(JSON.stringify({dryRun:true,rows:payload.rows.map(r=>({model:r.model,storage:r.storage})),currentSkuCount:before.rows.length},null,2));process.exit(0);}
if(!cookie)throw Error('Specify --cookie for application API session');
const receipt=await api('/api/workbench/import',payload);
const after=await api(`/api/workbench/rows?date=${payload.date}`);
const verified=[];
for(const row of payload.rows){
  const live=after.rows.find(r=>r.model===row.model&&isKnownStorage(row.storage,[r.storage]));if(!live)throw Error(`Missing imported row: ${row.model} ${row.storage}`);
  // Pin the independently verified link so future runs start with the exact product.
  const link=await api('/api/workbench/product-link/'+encodeURIComponent(live.id),{link:row.selected.link,baseLink:live.productLink||'',recollect:false},'PATCH');
  verified.push({id:live.id,model:live.model,storage:live.storage,title:live.work?.quote?.title,state:live.work?.review_state,protectedObservation:Boolean(live.work?.newObservation),link:link.link});
}
const result={appliedAt:new Date().toISOString(),receipt,beforeSkuCount:before.rows.length,afterSkuCount:after.rows.length,verified};
fs.writeFileSync(arg('--receipt',file+'.receipt.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
