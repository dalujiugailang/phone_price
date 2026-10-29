// Correct edition labels only. RAM/ROM amounts and all price/history records are preserved.
import fs from 'node:fs';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';import {randomUUID} from 'node:crypto';import {fileURLToPath} from 'node:url';
const canonical=s=>String(s??'').normalize('NFKC').replace(/\s+/g,'').toLowerCase();
function memory(storage){const m=canonical(storage).match(/^(\d+)(?:gb|g)?\+(\d+)(tb|t|gb|g)(.*)$/);if(!m)throw Error('Expected RAM+ROM');return {ram:+m[1],rom:+m[2]*(/^t/.test(m[3])?1024:1),edition:m[4]};}
const identity=(model,storage)=>{const s=memory(storage);return `${canonical(model)}|${s.ram}:${s.rom}:${s.edition}`;};
export function correctSkuVersionLabels({databasePath,plan,apply=false}){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(plan.date||'')||!plan.items?.length)throw Error('Explicit dated plan required');
  for(const item of plan.items){
    const old=memory(item.storage),next=memory(item.newStorage);
    if(old.ram!==next.ram||old.rom!==next.rom||old.edition===next.edition)throw Error('This tool only corrects edition labels, never capacities');
    if(!item.reason||!item.evidence?.conclusion||!item.evidence?.url)throw Error('Official edition evidence required');
    const u=new URL(item.evidence.url);if(u.protocol!=='https:'||!['www.honor.com','consumer.huawei.com'].includes(u.hostname))throw Error('Official manufacturer evidence required');
  }
  if(new Set(plan.items.map(i=>i.id)).size!==plan.items.length)throw Error('Duplicate target');
  const db=new DatabaseSync(databasePath,{readOnly:!apply});db.exec('PRAGMA busy_timeout=5000');
  try{
    const inspect=()=>plan.items.map(item=>{
      const row=db.prepare('SELECT s.*,m.name model FROM skus s JOIN models m ON m.id=s.model_id WHERE s.id=?').get(item.id);
      if(!row||row.active!==1||row.model!==item.model||row.storage!==item.storage||row.identity!==identity(item.model,item.storage))throw Error('Target changed');
      const daily=db.prepare('SELECT version FROM daily WHERE sku_id=? AND date=?').get(item.id,plan.date);
      if((daily?.version??null)!==item.expectedDailyVersion)throw Error('Concurrent edit');
      const collision=db.prepare('SELECT id FROM skus WHERE identity=?').get(identity(item.model,item.newStorage));if(collision)throw Error('Correct edition already exists; review instead of merging');
      return {item,row};
    });
    const targets=inspect();if(!apply)return {dryRun:true,items:targets.map(({item})=>item)};
    const holders=db.prepare("SELECT 1 FROM run_items i JOIN runs r ON r.id=i.run_id WHERE i.sku_id IN ("+targets.map(()=>'?').join(',')+") AND r.state IN ('queued','running') LIMIT 1").get(...targets.map(t=>t.item.id));if(holders)throw Error('Target has active collection');
    const stamp=new Date().toISOString(),folder=path.join(path.dirname(databasePath),'.archive','edition-labels-'+stamp.replace(/[:.]/g,'-'));fs.mkdirSync(folder,{recursive:true,mode:0o700});
    const backupPath=path.join(folder,'price-workbench.sqlite');db.prepare('VACUUM INTO ?').run(backupPath);fs.writeFileSync(path.join(folder,'plan.json'),JSON.stringify(plan,null,2),{mode:0o600});
    db.exec('BEGIN IMMEDIATE');try{
      inspect();
      for(const {item,row} of targets){
        const newIdentity=identity(item.model,item.newStorage);db.prepare('UPDATE skus SET storage=?,identity=? WHERE id=?').run(item.newStorage,newIdentity,item.id);
        const after={storage:item.newStorage,identity:newIdentity,reason:item.reason,evidence:item.evidence};
        db.prepare('INSERT INTO audit(actor,action,entity,before_json,after_json,request_id,created_at,sku_id,business_date) VALUES(?,?,?,?,?,?,?,?,?)').run('maintenance','CORRECT_SKU_VERSION_LABEL',`${item.id}/${plan.date}`,JSON.stringify({storage:row.storage,identity:row.identity}),JSON.stringify(after),randomUUID(),stamp,item.id,plan.date);
        db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run('corrected_sku_identity:'+row.identity,JSON.stringify({skuId:item.id,newIdentity,at:stamp}));
      }
      db.prepare('INSERT INTO outbox(id,pending,updated_at,error) VALUES(1,1,?,NULL) ON CONFLICT(id) DO UPDATE SET pending=1,updated_at=excluded.updated_at,error=NULL').run(stamp);db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
    return {corrected:targets.length,backupPath,items:targets.map(({item})=>({id:item.id,model:item.model,before:item.storage,after:item.newStorage}))};
  }finally{db.close();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),arg=k=>{const i=args.indexOf(k);return i<0?null:args[i+1];};if(!arg('--db')||!arg('--plan'))throw Error('Specify --db and --plan');
  console.log(JSON.stringify(correctSkuVersionLabels({databasePath:arg('--db'),plan:JSON.parse(fs.readFileSync(arg('--plan'))),apply:args.includes('--apply')}),null,2));
}
