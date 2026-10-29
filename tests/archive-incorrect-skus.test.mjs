import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {archiveIncorrectSkus} from '../scripts/archive-incorrect-skus.mjs';
function fixture(){
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'sku-archive-')),file=path.join(folder,'price-workbench.sqlite');
  const db=new DatabaseSync(file);
  db.exec(`CREATE TABLE models(id TEXT PRIMARY KEY,name TEXT); INSERT INTO models VALUES('model','Example Phone');
    CREATE TABLE skus(id TEXT PRIMARY KEY,model_id TEXT,storage TEXT,active INTEGER);
    INSERT INTO skus VALUES('wrong','model','16GB+1TB',1),('valid','model','12GB+256GB',1),('edition','model','16GB+1TB 高定版',1);
    CREATE TABLE daily(sku_id TEXT,date TEXT,version INTEGER);INSERT INTO daily VALUES('wrong','2026-10-29',1);
    CREATE TABLE observations(id TEXT,sku_id TEXT);INSERT INTO observations VALUES('evidence','wrong');
    CREATE TABLE revisions(id TEXT,sku_id TEXT);INSERT INTO revisions VALUES('history','wrong');
    CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE audit(actor TEXT,action TEXT,entity TEXT,before_json TEXT,after_json TEXT,request_id TEXT,created_at TEXT,sku_id TEXT,business_date TEXT);
    CREATE TABLE runs(id TEXT,state TEXT);CREATE TABLE run_items(run_id TEXT,sku_id TEXT);
    CREATE TABLE outbox(id INTEGER PRIMARY KEY,pending INTEGER,updated_at TEXT,error TEXT);`);
  db.close();
  const plan={date:'2026-10-29',items:[{id:'wrong',model:'Example Phone',storage:'16GB+1TB',expectedDailyVersion:1,classification:'incorrect_spec',reason:'Capacity belongs only to the separate special edition',evidence:{url:'https://www.honor.com/cn/news/example/',conclusion:'The complete official launch list assigns 16GB+1TB exclusively to the special edition.'}}]};
  return {file,plan};
}
test('archives only the wrong SKU and retains every price record and special edition',()=>{
  const {file,plan}=fixture();assert.equal(archiveIncorrectSkus({databasePath:file,plan}).dryRun,true);
  const result=archiveIncorrectSkus({databasePath:file,plan,apply:true});assert.equal(result.archived,1);assert.ok(fs.existsSync(result.backupPath));
  const db=new DatabaseSync(file,{readOnly:true});
  assert.deepEqual(db.prepare('SELECT id,active FROM skus ORDER BY id').all().map(r=>[r.id,r.active]),[['edition',1],['valid',1],['wrong',0]]);
  for(const table of ['daily','observations','revisions'])assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n,1);
  assert.equal(db.prepare('SELECT count(*) n FROM audit').get().n,1);assert.equal(db.prepare('SELECT pending FROM outbox').get().pending,1);db.close();
  const backup=new DatabaseSync(result.backupPath,{readOnly:true});assert.equal(backup.prepare("SELECT active FROM skus WHERE id='wrong'").get().active,1);backup.close();
});
test('API search absence does not authorize archive',()=>{
  const {file,plan}=fixture();plan.items[0].evidence.conclusion='未检索到同规格商品';assert.throws(()=>archiveIncorrectSkus({databasePath:file,plan,apply:true}),/not archive evidence/);
});
test('concurrent edits abort before changing any SKU',()=>{
  const {file,plan}=fixture();plan.items[0].expectedDailyVersion=0;
  assert.throws(()=>archiveIncorrectSkus({databasePath:file,plan,apply:true}),/Concurrent change/);
  const db=new DatabaseSync(file,{readOnly:true});assert.equal(db.prepare("SELECT active FROM skus WHERE id='wrong'").get().active,1);db.close();
});
test('active collection on the target prevents maintenance',()=>{
  const {file,plan}=fixture();const db=new DatabaseSync(file);db.exec("INSERT INTO runs VALUES('run','running');INSERT INTO run_items VALUES('run','wrong')");db.close();
  assert.throws(()=>archiveIncorrectSkus({databasePath:file,plan,apply:true}),/active collection/);
});
test('transaction failure rolls back archive and preserves backup',()=>{
  const {file,plan}=fixture();const db=new DatabaseSync(file);db.prepare('INSERT INTO meta VALUES(?,?)').run('incorrect_spec_archive:wrong','previous');db.close();
  assert.throws(()=>archiveIncorrectSkus({databasePath:file,plan,apply:true}),/UNIQUE/);
  const check=new DatabaseSync(file,{readOnly:true});assert.equal(check.prepare("SELECT active FROM skus WHERE id='wrong'").get().active,1);assert.equal(check.prepare('SELECT count(*) n FROM audit').get().n,0);check.close();
});
