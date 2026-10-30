// Read-only audit of persisted API evidence. Never invokes an API or edits prices.
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {matchesProduct} from '../server/lib/maishou-provider.mjs';
import {validateQuote} from '../server/lib/price-workbench.mjs';
const args=process.argv.slice(2),arg=(key,fallback)=>{const i=args.indexOf(key);return i<0?fallback:args[i+1];};
const date=arg('--date');if(!/^\d{4}-\d{2}-\d{2}$/.test(date || ''))throw new Error('需要 --date YYYY-MM-DD');
const db=new DatabaseSync(path.resolve(arg('--db','data/preview-20261027/price-workbench.sqlite')),{readOnly:true});
try{
  const catalog=db.prepare('SELECT m.name model,s.storage FROM skus s JOIN models m ON m.id=s.model_id WHERE s.active=1').all();
  const rows=db.prepare(`SELECT s.id,m.name model,m.brand,s.storage,d.review_state,d.list,d.coupon,
    o.quote_json,o.raw_json,o.run_id,o.created_at,
    (SELECT availability FROM revisions r WHERE r.sku_id=s.id AND r.date=d.date ORDER BY rowid DESC LIMIT 1) published_availability
    FROM daily d JOIN skus s ON s.id=d.sku_id JOIN models m ON m.id=s.model_id
    JOIN observations o ON o.id=(SELECT id FROM observations x WHERE x.sku_id=s.id AND x.date=d.date ORDER BY rowid DESC LIMIT 1)
    WHERE d.date=? ORDER BY m.name,s.storage`).all(date);
  const counts={total:rows.length,matched:0,unmatched:0,apiErrors:0,completePrices:0,quoteValidationPassed:0,publishedOnSale:0,modelViolations:0,identityValidatedMatches:0,activeModelViolations:0};
  const issues={},byBrand={},unmatched=[],violations=[];
  for(const r of rows){
    const q=JSON.parse(r.quote_json),raw=JSON.parse(r.raw_json),checks=validateQuote(q);
    const state=q.error?'apiErrors':q.matched?'matched':'unmatched';counts[state]++;
    const b=byBrand[r.brand] ||= {total:0,matched:0,unmatched:0,apiErrors:0};b.total++;b[state]++;
    if(q.list>0 && q.coupon!==null)counts.completePrices++;
    const modelValid=q.matched && matchesProduct(r,q.title || '',catalog);
    if(modelValid && !checks.length)counts.quoteValidationPassed++;
    if(r.published_availability==='on_sale')counts.publishedOnSale++;
    for(const check of checks)issues[check.code]=(issues[check.code] || 0)+1;
    if(modelValid)counts.identityValidatedMatches++;
    if(q.matched && !modelValid){
      counts.modelViolations++;if(r.published_availability==='on_sale')counts.activeModelViolations++;violations.push({id:r.id,model:r.model,storage:r.storage,title:q.title,published:r.published_availability});
    }
    if(!q.matched){
      const reasons={};for(const rejection of raw.rejections || [])for(const reason of rejection.reasons || [])reasons[reason]=(reasons[reason] || 0)+1;
      unmatched.push({id:r.id,model:r.model,storage:r.storage,error:q.error || null,searches:raw.searches?.length || 0,details:raw.details?.length || 0,
        keywords:(raw.searches || []).map(x=>({keyword:x.keyword,page:x.page})),rejectionCounts:reasons,
        rejectedDetails:(raw.rejections || []).filter(x=>x.stage==='detail'),reason:q.reason || '',runId:r.run_id});
    }
  }
  const baselineFile=arg('--baseline'),baseline=baselineFile?JSON.parse(fs.readFileSync(baselineFile,'utf8')).before:null;
  const report={date,generatedAt:new Date().toISOString(),scope:'Latest persisted API observation for each SKU/date; matched does not imply published. No current requests are made.',baseline,counts,byBrand,issues,violations,unmatched};
  const out=arg('--out');if(out){fs.mkdirSync(path.dirname(path.resolve(out)),{recursive:true});fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n');}
  console.log(JSON.stringify({date,counts,byBrand,issues,violations},null,2));
}finally{db.close();}
