// Maintenance only: archive individually evidenced misconfigured SKUs, preserving all history.
// Missing API search results are deliberately not accepted as archive evidence.
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

export function archiveIncorrectSkus({databasePath,plan,apply=false}) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(plan.date || ''))throw Error('An explicit business date is required');
  if (!Array.isArray(plan.items) || !plan.items.length) throw Error('An explicit archive plan is required');
  const seen=new Set();
  for (const item of plan.items) {
    if(seen.has(item.id))throw Error('Duplicate target');seen.add(item.id);
    if(item.classification!=='incorrect_spec' || !item.reason || !item.evidence?.conclusion || !item.evidence?.url)throw Error('Only confirmed incorrect specs can be archived');
    const url=new URL(item.evidence.url);
    if(url.protocol!=='https:' || !['www.honor.com','consumer.huawei.com','www.vivo.com.cn','www.oppo.com','www.mi.com','m.mi.com','www.samsung.com'].includes(url.hostname))throw Error('Official manufacturer evidence is required');
    if(/仅.*搜不到|未检索到|缺货|下架/.test(item.evidence.conclusion))throw Error('Search absence or availability is not archive evidence');
  }
  const db=new DatabaseSync(databasePath,{readOnly:!apply});
  try {
    db.exec('PRAGMA busy_timeout=5000');
    const inspect=()=>plan.items.map(item=>{
      const row=db.prepare('SELECT s.id,s.storage,s.active,s.model_id,m.name model FROM skus s JOIN models m ON m.id=s.model_id WHERE s.id=?').get(item.id);
      if(!row || row.model!==item.model || row.storage!==item.storage)throw Error(`Target changed: ${item.model} ${item.storage}`);
      if(row.active!==1)throw Error(`Target is already archived: ${item.id}`);
      if(item.expectedDailyVersion!==undefined){
        const daily=db.prepare('SELECT version FROM daily WHERE sku_id=? AND date=?').get(item.id,plan.date);
        if((daily?.version??null)!==item.expectedDailyVersion)throw Error(`Concurrent change: ${item.id}`);
      }
      if(item.evidence.retainedSkuId){
        const retained=db.prepare('SELECT active FROM skus WHERE id=?').get(item.evidence.retainedSkuId);
        if(item.evidence.retainedSkuId===item.id || retained?.active!==1)throw Error('Correct counterpart is not active');
      }
      return {...row,evidence:item.evidence,reason:item.reason};
    });
    const before=inspect();
    if(!apply)return {dryRun:true,items:before};
    if(db.prepare("SELECT 1 FROM run_items i JOIN runs r ON r.id=i.run_id WHERE i.sku_id IN ("+before.map(()=>'?').join(',')+") AND r.state IN ('queued','running') LIMIT 1").get(...before.map(x=>x.id)))throw Error('Target has an active collection run');
    const stamp=new Date().toISOString(),archiveDir=path.join(path.dirname(databasePath),'.archive',`incorrect-specs-${stamp.replace(/[:.]/g,'-')}`);
    fs.mkdirSync(archiveDir,{recursive:true,mode:0o700});
    const backupPath=path.join(archiveDir,'price-workbench.sqlite');
    db.prepare('VACUUM INTO ?').run(backupPath);
    fs.writeFileSync(path.join(archiveDir,'archive-plan.json'),JSON.stringify(plan,null,2),{mode:0o600});
    db.exec('BEGIN IMMEDIATE');
    try {
      inspect();
      for(const item of before){
        const after={active:0,reason:item.reason,evidence:item.evidence,archivedAt:stamp};
        const changed=db.prepare('UPDATE skus SET active=0 WHERE id=? AND active=1').run(item.id);
        if(changed.changes!==1)throw Error('Concurrent archive');
        db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run(`incorrect_spec_archive:${item.id}`,JSON.stringify(after));
        db.prepare('INSERT INTO audit(actor,action,entity,before_json,after_json,request_id,created_at,sku_id,business_date) VALUES(?,?,?,?,?,?,?,?,?)').run('maintenance','ARCHIVE_INCORRECT_SPEC',`${item.id}/${plan.date}`,JSON.stringify({active:1,model:item.model,storage:item.storage}),JSON.stringify(after),randomUUID(),stamp,item.id,plan.date);
      }
      db.prepare('INSERT INTO outbox(id,pending,updated_at,error) VALUES(1,1,?,NULL) ON CONFLICT(id) DO UPDATE SET pending=1,updated_at=excluded.updated_at,error=NULL').run(stamp);
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    return {archived:before.length,items:before.map(({id,model,storage})=>({id,model,storage})),backupPath,projectionPending:true};
  }finally{db.close();}
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),arg=k=>{const i=args.indexOf(k);return i<0?null:args[i+1];};
  if(!arg('--db')||!arg('--plan'))throw Error('Specify --db and --plan; --apply is optional');
  console.log(JSON.stringify(archiveIncorrectSkus({databasePath:arg('--db'),plan:JSON.parse(fs.readFileSync(arg('--plan'))),apply:args.includes('--apply')}),null,2));
}
