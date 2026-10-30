import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import express from 'express';
import XLSX from 'xlsx';
import {createPriceWorkbench,cents,subsidy,skuIdentity,validateQuote,partitionReviewIssues,beijingDate} from './price-workbench.mjs';
import {registerPriceWorkbenchRoutes} from './price-workbench-routes.mjs';
import {matchesProduct,normalizeDetail} from './maishou-provider.mjs';
import {buildAnalysis,datasetFromRawEditorDraft} from './price-data.mjs';

const date='2026-10-27',shop='小米京东自营旗舰店';
const sample=(model='小米 17 Pro',storage='12GB+256GB',overrides={})=>({model,storage,brand:'小米',generation:'N-1',selected:{listing:5000,coupon:200,actual:4800,shop,link:'https://item.jd.com/123.html',title:`${model} ${storage}`,id:model,threshold:'0.00',start:'2026-10-01',end:'2026-10-31',...overrides}});
function fixture(options={}){
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'gtm-workbench-test-'));
  const legacyDatabasePath=path.join(dataDir,'raw-editor-draft.sqlite');
  const db=new DatabaseSync(legacyDatabasePath);
  db.exec('CREATE TABLE raw_editor_drafts(id INTEGER PRIMARY KEY,dates_json TEXT,rows_json TEXT,saved_at TEXT)');
  db.prepare('INSERT INTO raw_editor_drafts VALUES(1,?,?,?)').run(JSON.stringify(['10.26']),JSON.stringify([{id:'old-id',model:'小米 17 Pro',storage:'12G+256G',brand:'小米',position:'旗舰',ppv:'old-ppv',launchPrice:'5999',snapshots:{'10.26':{listPrice:'5100',coupon:'200',finalPrice:'4400'}}}]),'2026-10-26T01:00:00Z');db.close();
  const before=createHash('sha256').update(fs.readFileSync(legacyDatabasePath)).digest('hex');
  const service=createPriceWorkbench({dataDir,legacyDatabasePath,clock:()=>new Date('2026-10-27T02:00:00Z'),...options});
  const credentials=JSON.parse(fs.readFileSync(path.join(dataDir,'workbench-initial-accounts.json'),'utf8')).accounts;
  const users=Object.fromEntries(credentials.map(u=>[u.role==='reviewer'?u.username:u.role,service.login(u.username,u.password)]));
  return {service,dataDir,legacyDatabasePath,before,users,credentials};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('金额按分处理；国补公式边界、空值和非法输入',()=>{
  assert.equal(cents('3,000.01'),300001);assert.equal(cents(''),null);assert.equal(cents(0),0);
  assert.throws(()=>cents('1.234'));assert.throws(()=>cents('-1'));assert.throws(()=>cents('NaN'));
  assert.equal(subsidy(300000,20000),238000);assert.equal(subsidy(650000,10000),590000);
  assert.equal(subsidy(600000,0),550000);assert.equal(subsidy(600001,0),550001);
  assert.equal(subsidy(333333,0),283333);assert.equal(subsidy(null,0),null);assert.equal(subsidy(10,11),null);
  assert.equal(beijingDate(new Date('2026-10-26T16:01:00Z')),date);
});
test('SKU 标准化合并单位写法，但保留特别版和未知 RAM',()=>{
  assert.equal(skuIdentity('REDMI K90 Pro Max','16G+1T'),skuIdentity('redmi k90 pro max','16GB+1024GB'));
  assert.notEqual(skuIdentity('小米 17 Pro','16GB+1TB'),skuIdentity('小米 17 Pro 特别版','16GB+1TB'));
  assert.notEqual(skuIdentity('荣耀 Magic V Flip2','16GB+1TB'),skuIdentity('荣耀 Magic V Flip2','16GB+1TB 高定版'));
  assert.notEqual(skuIdentity('测试机','256GB'),skuIdentity('测试机','12GB+256GB'));
});
test('导入复用历史 ID、保留原库；缺价和价差异常不生效，重复导入幂等',async()=>{
  const f=fixture(),s=f.service;
  const rows=[sample(),sample('小米 18 Pro','16GB+512GB',{actual:4200}),{model:'小米 18 Pro Max',storage:'16GB+1TB',brand:'小米',selected:null}];
  const result=s.importRows(rows,date,f.users.admin.user,'a'.repeat(64));
  assert.deepEqual({...result,hash:undefined},{added:2,reused:1,total:3,published:1,unmatched:1,date,hash:undefined});
  assert.equal(s.importRows(rows,date,f.users.admin.user,'a'.repeat(64)).repeated,true);
  const draft=s.getDraft();assert.equal(draft.rows.length,3);assert.equal(draft.rows[0].id,'old-id');assert.equal(draft.rows[0].ppv,'old-ppv');
  assert.equal(draft.rows[0].snapshots['10.26'].finalPrice,'4400');assert.equal(draft.rows[0].snapshots['10.27'].finalPrice,'4300');
  assert.equal(draft.rows[1].snapshots['10.27'],undefined);assert.deepEqual(draft.rows[1].strictDates,['10.27']);
  assert.equal(createHash('sha256').update(fs.readFileSync(f.legacyDatabasePath)).digest('hex'),f.before);
  assert.equal(s.listRows(date).summary.pending,1);await settle();s.close();
});
test('不同字段的并发修改可合并；同字段版本冲突不覆盖；过期确认失败',async()=>{
  const {service:s,users}=fixture();s.importRows([sample()],date,users.admin.user,'b'.repeat(64));
  const a=s.listRows(date).rows[0];
  const first=s.patchCell(a.id,date,{field:'list',value:'5200',baseVersion:a.work.list_version},users.reviewer1.user);
  const second=s.patchCell(a.id,date,{field:'coupon',value:'300',baseVersion:a.work.coupon_version},users.reviewer2.user);
  assert.equal(second.list,520000);assert.equal(second.coupon,30000);assert.equal(second.final,440000);
  assert.throws(()=>s.patchCell(a.id,date,{field:'list',value:'5300',baseVersion:a.work.list_version},users.reviewer2.user),e=>e.status===409 && e.current.list===520000);
  assert.throws(()=>s.confirm(a.id,date,{baseVersion:first.version,reason:'已核验',evidence:'https://item.jd.com/123.html',availability:'on_sale'},users.reviewer1.user),e=>e.status===409);
  s.confirm(a.id,date,{baseVersion:second.version,reason:'商品页确认券 300 元',evidence:'https://item.jd.com/123.html',availability:'on_sale'},users.reviewer2.user);
  assert.equal(s.listRows(date).rows[0].work.published.coupon,30000);await settle();s.close();
});
test('人工改动和确认都不被后续 API 结果覆盖；来源证据持续追加',async()=>{
  const {service:s,users}=fixture();s.importRows([sample()],date,users.admin.user,'c'.repeat(64));
  let row=s.listRows(date).rows[0];s.patchCell(row.id,date,{field:'coupon',value:'400',baseVersion:row.work.coupon_version},users.reviewer1.user);
  s.importRows([sample(undefined,undefined,{coupon:500,actual:4500})],date,users.admin.user,'d'.repeat(64));
  row=s.listRows(date).rows[0];assert.equal(row.work.coupon,40000);
  s.confirm(row.id,date,{baseVersion:row.work.version,reason:'确认 400 元券，额外差价为其他优惠',evidence:'https://item.jd.com/123.html',availability:'on_sale'},users.reviewer1.user);
  s.importRows([sample(undefined,undefined,{coupon:600,actual:4400})],date,users.admin.user,'e'.repeat(64));
  row=s.listRows(date).rows[0];assert.equal(row.work.coupon,40000);assert.equal(row.work.review_state,'confirmed');assert.equal(s.history(row.id,date).observations.length,3);await settle();s.close();
});
test('核验领取限制其他核验人员；无证据不允许确认；停售不制造零元价',async()=>{
  const {service:s,users}=fixture();s.importRows([sample()],date,users.admin.user,'f'.repeat(64));const row=s.listRows(date).rows[0];
  s.claim(row.id,date,users.reviewer1.user);
  assert.throws(()=>s.claim(row.id,date,users.reviewer2.user),e=>e.status===409);
  assert.throws(()=>s.patchCell(row.id,date,{field:'coupon',value:0,baseVersion:0},users.reviewer2.user),e=>e.status===409);
  assert.throws(()=>s.confirm(row.id,date,{baseVersion:row.work.version,availability:'discontinued'},users.reviewer1.user),e=>e.status===422);
  s.confirm(row.id,date,{baseVersion:row.work.version,availability:'discontinued',reason:'商品页确认停售',evidence:'https://item.jd.com/123.html'},users.reviewer1.user);
  assert.equal(s.listRows(date).rows[0].work.published.final,null);assert.equal(s.getDraft().rows[0].snapshots['10.27'].finalPrice,'');await settle();s.close();
});
test('型号维度有版本冲突检查；管理员与两个核验角色固定，其他只能只读',async()=>{
  const {service:s,users}=fixture();const model=s.models()[0];
  s.updateModel(model.id,{brand:'小米',position:'旗舰',generation:'N-1',baseVersion:model.version},users.reviewer1.user);
  assert.throws(()=>s.updateModel(model.id,{brand:'小米',position:'中端',generation:'N',baseVersion:model.version},users.reviewer2.user),e=>e.status===409);
  const viewer=s.saveUser({username:'viewer1',name:'访客 1',password:'ViewerPassword123'},users.admin.user);assert.equal(viewer.role,'viewer');
  assert.throws(()=>s.saveUser({username:'third-reviewer',name:'核验3',role:'reviewer',password:'SafePassword123'},users.admin.user),e=>e.status===422);
  const list=s.users(users.admin.user);assert.equal(list.filter(u=>u.role==='admin').length,1);assert.equal(list.filter(u=>u.role==='reviewer').length,2);
  assert.equal(s.userFromToken(users.reviewer1.token).role,'reviewer');
  s.saveUser({id:users.reviewer1.user.id,username:'reviewer1',name:'核验人员1',password:'ChangedPassword123'},users.admin.user);
  assert.equal(s.userFromToken(users.reviewer1.token),null);await settle();s.close();
});
test('严格日期缺失不沿用昨日价进入今日聚合；历史口径仍保持兼容',()=>{
  const dataset=datasetFromRawEditorDraft({dates:['10.26','10.27'],rows:[{id:'x',model:'测试',storage:'12GB+256GB',brand:'测试',launchPrice:'5000',strictDates:['10.27'],snapshots:{'10.26':{listPrice:'5000',coupon:'0',finalPrice:'4500'},'10.27':{listPrice:'',coupon:'',finalPrice:'',biPrice:'3000'}}}]});
  assert.equal(dataset.skus[0].snapshots.length,1);
  const analysis=buildAnalysis(dataset);assert.equal(analysis.brandAnalysis.length,0);assert.equal(analysis.positionAnalysis.length,0);
});
test('原始券额保留，零券但实际价不同与过期券都触发核验',()=>{
  const q={matched:true,list:500000,coupon:0,actual:450000,shop,link:'https://item.jd.com/1.html',date};
  assert.ok(validateQuote(q).some(i=>i.code==='PRICE_COMPONENT_MISMATCH'));assert.equal(q.coupon,0);
  assert.ok(validateQuote({...q,coupon:10000,start:'2026-01-01',end:'2026-01-02',threshold:600000}).some(i=>i.code==='COUPON_EXPIRED'));
  assert.ok(validateQuote({...q,coupon:null}).some(i=>i.code==='MISSING_COUPON'));
  assert.deepEqual(validateQuote({...q,sourceChanged:true}),validateQuote(q));
});
test('挂牌和券额都缺失只计两个核验项，未匹配单列，公式不重复计数',()=>{
  const q={matched:false,date,list:null,coupon:null,actual:null};
  const all=validateQuote(q),result=partitionReviewIssues(all);
  assert.equal(all.length,3);
  assert.deepEqual(result.collectionIssues.map(i=>i.code),['NO_MATCH']);
  assert.deepEqual(result.verificationIssues.map(i=>i.code),['MISSING_LIST','MISSING_COUPON']);
  assert.equal(result.verificationCount,2);assert.equal(subsidy(q.list,q.coupon),null);
  assert.ok(!result.verificationIssues.some(i=>i.field==='final' || i.field==='finalPrice'));
  assert.equal(partitionReviewIssues(validateQuote({...q,coupon:0})).verificationCount,1);
  const identified={...q,matched:true,shop,link:'https://item.jd.com/1.html'};
  assert.equal(partitionReviewIssues(validateQuote(identified)).verificationCount,2);
});
test('批量粘贴整批原子保存，任一字段冲突全部回滚',async()=>{
  const {service:s,users}=fixture();s.importRows([sample()],date,users.admin.user,'3'.repeat(64));
  const row=s.listRows(date).rows[0];
  s.patchMany(date,[{id:row.id,field:'list',value:'5100',baseVersion:0},{id:row.id,field:'coupon',value:'300',baseVersion:0}],users.reviewer1.user);
  assert.equal(s.listRows(date).rows[0].work.list,510000);
  assert.throws(()=>s.patchMany(date,[{id:row.id,field:'list',value:'5200',baseVersion:1},{id:row.id,field:'coupon',value:'400',baseVersion:0}],users.reviewer2.user),e=>e.status===409);
  assert.equal(s.listRows(date).rows[0].work.list,510000);assert.equal(s.listRows(date).rows[0].work.coupon,30000);await settle();s.close();
});
test('管理员撤销与恢复追加价格版本，不删历史；核验人员无权撤销',async()=>{
  const {service:s,users}=fixture();s.importRows([sample()],date,users.admin.user,'4'.repeat(64));
  let row=s.listRows(date).rows[0];const first=row.work.published.id;
  assert.throws(()=>s.restoreRevision(row.id,date,{baseVersion:row.work.version,reason:'更正'},users.reviewer1.user),e=>e.status===403);
  s.restoreRevision(row.id,date,{baseVersion:row.work.version,reason:'撤销误确认'},users.admin.user);
  row=s.listRows(date).rows[0];assert.equal(row.work.published.availability,'withdrawn');assert.equal(s.listRows(date).summary.published,0);
  s.restoreRevision(row.id,date,{baseVersion:row.work.version,reason:'重新核实后恢复',revisionId:first},users.admin.user);
  assert.equal(s.history(row.id,date).revisions.length,3);assert.equal(s.listRows(date).summary.published,1);await settle();s.close();
});
test('人工确认后新接口结果待比较；采用与保留均须重新确认',async()=>{
  const {service:s,users}=fixture();s.importRows([sample()],date,users.admin.user,'5'.repeat(64));
  let row=s.listRows(date).rows[0];s.confirm(row.id,date,{baseVersion:row.work.version,reason:'人工确认',evidence:'https://item.jd.com/123.html',availability:'on_sale'},users.reviewer1.user);
  s.importRows([sample(undefined,undefined,{listing:4900,coupon:200,actual:4700})],date,users.admin.user,'6'.repeat(64));
  row=s.listRows(date).rows[0];assert.equal(row.work.list,500000);assert.equal(row.work.newObservation.quote.list,490000);assert.equal(s.listRows(date).summary.pending,0);
  s.adoptObservation(row.id,date,{baseVersion:row.work.version,observationId:row.work.newObservation.id},users.reviewer1.user);
  row=s.listRows(date).rows[0];assert.equal(row.work.list,490000);assert.equal(row.work.published.list,500000);assert.equal(row.work.dirty,true);
  s.confirm(row.id,date,{baseVersion:row.work.version,reason:'确认新报价',evidence:'https://item.jd.com/123.html',availability:'on_sale'},users.reviewer1.user);
  assert.equal(s.listRows(date).rows[0].work.newObservation,null);assert.equal(s.listRows(date).summary.published,1);await settle();s.close();
});
test('BI 兼容写入仅修改指定 PPV 的 BI 字段，不覆盖挂牌和券额',async()=>{
  const {service:s,users}=fixture();s.importRows([sample()],date,users.admin.user,'7'.repeat(64));
  s.updateBiPrices({workbookTargetDate:'10.27',workbookTargetPpvs:['old-ppv'],rows:[{model:'小米 17 Pro',storage:'12GB+256GB',snapshots:{'10.27':{biPrice:'3500',listPrice:'1',coupon:'1'}}}]},users.admin.user);
  const row=s.getDraft().rows[0];assert.equal(row.snapshots['10.27'].biPrice,'3500');assert.equal(row.snapshots['10.27'].listPrice,'5000');assert.equal(row.snapshots['10.27'].coupon,'200');await settle();s.close();
});
test('当前接口报价不能写入历史或未来；导入相同文件不能偷换日期',async()=>{
  const {service:s,users}=fixture({provider:{configured:true}});
  assert.throws(()=>s.createRun('2026-10-26',users.admin.user),e=>e.status===422);
  assert.throws(()=>s.createRun('2026-10-28',users.admin.user),e=>e.status===422);
  s.importRows([sample()],date,users.admin.user,'8'.repeat(64));
  assert.throws(()=>s.importRows([sample()],'2026-10-28',users.admin.user,'8'.repeat(64)),e=>e.status===422);await settle();s.close();
});
test('导入未匹配逐条有日志，按型号去空格搜索与分页，不冒充实时搜索',async()=>{
  const {service:s,users}=fixture();
  const row=sample('华为 Mate 90 Pro','12GB+256GB',{shop:'华为京东自营旗舰店'});row.brand='华为';
  s.importRows([row,{model:'华为 Mate 90 Pro',brand:'华为',storage:'16GB+1TB',selected:null}],date,users.admin.user,'9'.repeat(64));
  const logs=s.logs({query:'mate90pro',date,limit:1});assert.ok(logs.total>=2);assert.equal(logs.items.length,1);assert.equal(logs.nextOffset,1);assert.equal(logs.items[0].model,'华为 Mate 90 Pro');
  const imported=s.logs({query:'Mate 90 Pro',date,limit:200}).items.filter(l=>l.action==='IMPORT_RESULT');
  assert.equal(imported.length,2);assert.ok(imported.some(l=>!JSON.parse(l.after_json).matched));assert.ok(imported.every(l=>JSON.parse(l.after_json).queryPerformed===false));await settle();s.close();
});
test('已有导入补录日志幂等，保留真实导入时间并标注未执行新搜索',async()=>{
  const {service:s}=fixture();
  s.db.prepare('INSERT INTO observations VALUES(?,?,?,?,?,?,?)').run('legacy-import','old-id',date,'import:legacy',JSON.stringify({matched:false,date,list:null,coupon:null,actual:null,keyword:'小米17Pro'}),'{}','2026-10-27T01:00:00Z');
  assert.equal(s.backfillImportLogs().backfilled,1);assert.equal(s.backfillImportLogs().backfilled,0);
  const log=s.logs({query:'小米17Pro',date}).items.find(l=>l.action==='IMPORT_RESULT'),body=JSON.parse(log.after_json);
  assert.equal(body.backfilled,true);assert.equal(body.queryPerformed,false);assert.equal(body.importedAt,'2026-10-27T01:00:00Z');await settle();s.close();
});
test('商品匹配保留版本、运行内存和 ROM；错误店铺详情不会采纳',()=>{
  const sku={model:'小米 17 Pro',storage:'16GB+1TB'};
  assert.equal(matchesProduct(sku,'小米Xiaomi 17 Pro 全新 16GB+1TB 黑色'),true);
  assert.equal(matchesProduct(sku,'小米 17 Pro Max 16GB+1TB'),false);
  assert.equal(matchesProduct(sku,'小米 17 Pro 12GB+1TB'),false);
  assert.equal(matchesProduct(sku,'小米 17 Pro 特别版 16GB+1TB'),false);
  const detail={title:'小米 17 Pro 16GB+1TB',shopName:'第三方店',shopType:1,sourceType:2,tagList:['自营'],originalPrice:'6000',couponPrice:'0',actualPrice:'6000'};
  assert.equal(normalizeDetail(detail,'https://item.jd.com/1.html',sku,date).quote.matched,false);
});
test('持久化调度槽位幂等，崩溃后可恢复租约与队列',async()=>{
  const provider={configured:true,async collect(sku,date){return {quote:{matched:true,date,list:500000,coupon:0,actual:500000,shop,link:'https://item.jd.com/1.html',goodsId:'g'},raw:{}};}};
  const {service:s,users}=fixture({provider});const a=s.createRun(date,users.admin.user,{slot:`${date}/10:00`});
  assert.equal(s.createRun(date,null,{slot:`${date}/10:00`}).id,a.id);
  s.db.prepare("UPDATE runs SET state='running',lease_until='2000-01-01' WHERE id=?").run(a.id);
  await s.processRun();assert.equal(s.runs()[0].state,'completed');assert.equal(s.runs()[0].done,1);assert.equal(s.runs()[0].matched,1);assert.equal(s.runs()[0].unmatched,0);await settle();s.close();
});
test('分析同步失败保留 outbox，重试成功后确认，不丢发布记录',async()=>{
  let failing=true;
  const {service:s,users}=fixture({onPublished:async()=>{if(failing)throw new Error('模拟数仓失败');}});
  s.importRows([sample()],date,users.admin.user,'1'.repeat(64));await settle();
  assert.equal(s.db.prepare('SELECT pending FROM outbox').get().pending,1);assert.match(s.db.prepare('SELECT error FROM outbox').get().error,/模拟数仓失败/);
  failing=false;s.flushProjection();await settle();assert.equal(s.db.prepare('SELECT pending FROM outbox').get().pending,0);assert.equal(s.listRows(date).summary.published,1);s.close();
});
test('并行不同型号时同型号容量串行、并发不超过四，恢复不重采已完成项',async()=>{
  const active=new Set(),seen=new Set();let peak=0;
  const provider={configured:true,async collect(sku,date){
    assert.ok(!active.has(sku.model));active.add(sku.model);peak=Math.max(peak,active.size);seen.add(sku.id);
    await settle();active.delete(sku.model);
    return {quote:{matched:true,date,list:500000,coupon:0,actual:500000,shop,link:'https://item.jd.com/1.html'},raw:{}};
  }};
  const {service:s,users}=fixture({provider});
  s.importRows(Array.from({length:6},(_,i)=>[sample(`小米 回归型号${100+i}`,'12GB+256GB'),sample(`小米 回归型号${100+i}`,'16GB+512GB')]).flat(),date,users.admin.user,'b'.repeat(64));
  const run=s.createRun(date,users.admin.user),completed=s.listRows(date).rows.find(r=>r.model==='小米 回归型号100').id;
  s.db.prepare("UPDATE run_items SET state='done',message='已匹配' WHERE run_id=? AND sku_id=?").run(run.id,completed);
  await s.processRun();assert.equal(peak,4);assert.equal(seen.size,12);assert.ok(!seen.has(completed));
  assert.equal(s.runs()[0].state,'completed');assert.equal(s.runs()[0].done,13);await settle();s.close();
});
test('HTTP 权限：访客只读、viewer 不能写、核验可写；跨站写入和旧整表写入被拒绝',async()=>{
  const {service:s,users}=fixture();s.importRows([sample()],date,users.admin.user,'2'.repeat(64));
  const viewer=s.saveUser({username:'viewer-http',name:'只读',password:'ViewerPassword123'},users.admin.user);
  const viewerSession=s.login(viewer.username,'ViewerPassword123');
  const app=express();app.use(express.json());const routes=registerPriceWorkbenchRoutes(app,s);
  const server=await new Promise(resolve=>{const srv=app.listen(0,'127.0.0.1',()=>resolve(srv));});
  const base=`http://127.0.0.1:${server.address().port}`;
  const req=(url,body,token,origin)=>fetch(base+url,{method:body?'PATCH':'GET',headers:{'Content-Type':'application/json',...(token?{cookie:`gtm_workbench=${token}`} : {}),...(origin?{Origin:origin}:{})},body:body?JSON.stringify(body):undefined});
  try{
    assert.equal((await req(`/api/workbench/rows?date=${date}`)).status,200);
    const body={date,field:'coupon',value:'300',baseVersion:0};
    assert.equal((await req('/api/workbench/cells/old-id',body)).status,401);
    assert.equal((await req('/api/workbench/cells/old-id',body,viewerSession.token)).status,403);
    assert.equal((await req('/api/workbench/cells/old-id',body,users.reviewer1.token,'https://evil.example')).status,403);
    assert.equal((await req('/api/workbench/cells/old-id',body,users.reviewer1.token)).status,200);
    const exported=await req(`/api/workbench/export.xlsx?date=${date}`);
    assert.equal(exported.status,200);
    const workbook=XLSX.read(Buffer.from(await exported.arrayBuffer()),{type:'buffer'});
    assert.equal(workbook.Sheets[date].E2.v,4200);
    assert.match(workbook.Sheets[date].E2.f,/C2-D2/);
    assert.equal((await req('/api/raw-editor-draft',{},users.admin.token)).status,410);
  }finally{routes.stop();await new Promise(resolve=>server.close(resolve));await settle();s.close();}
});

test('重启后复用持久化的最近成功商品，之后的失败观察不会抹掉入口',async()=>{
  const previous=[];
  const provider={configured:true,async collect(sku,date){previous.push(sku.previousQuote || null);return {quote:{matched:true,date,list:500000,coupon:0,actual:500000,shop,link:'https://item.jd.com/saved.html',goodsId:'persisted-product'},raw:{}};}};
  const {service:s,users,dataDir,legacyDatabasePath}=fixture({provider});
  s.createRun(date,users.admin.user);await s.processRun();assert.equal(previous[0],null);
  s.db.prepare('INSERT INTO observations VALUES(?,?,?,?,?,?,?)').run('later-failure','old-id',date,null,JSON.stringify({matched:false,error:'暂时失败',date,list:null,coupon:null,actual:null}),'{}','2026-10-27T03:00:00Z');
  await settle();s.close();
  const resumed=createPriceWorkbench({dataDir,legacyDatabasePath,provider,clock:()=>new Date('2026-10-27T04:00:00Z')});
  resumed.createRun(date,users.admin.user);await resumed.processRun();assert.equal(previous[1].goodsId,'persisted-product');
  assert.equal(resumed.runs()[0].state,'completed');await settle();resumed.close();
});

test('大原始响应不进入历史列表；预览分段限长、分页和下载保留完整证据',async()=>{
  const {service:s,users}=fixture();s.importRows([sample()],date,users.admin.user,'c'.repeat(64));
  const id=s.listRows(date).rows[0].id;
  for(let i=0;i<31;i++)s.db.prepare('INSERT INTO observations VALUES(?,?,?,?,?,?,?)').run(`small-${i}`,id,date,null,'{"matched":false}','{}','2026-10-27T03:00:00Z');
  const raw=JSON.stringify({large:'测'.repeat(2_000_000)});
  s.db.prepare('INSERT INTO observations VALUES(?,?,?,?,?,?,?)').run('huge',id,date,null,'{"matched":true}',raw,'2026-10-27T04:00:00Z');
  const h=s.history(id,date);assert.equal(h.observationTotal,33);assert.equal(h.observations.length,30);
  assert.ok(!('raw' in h.observations[0]));assert.ok(!('raw_json' in h.observations[0]));assert.ok(JSON.stringify(h).length<20000);
  assert.equal(s.history(id,date,{offset:30,limit:2}).observations.length,2);
  const p=s.rawObservation('huge',id,date,{limit:1_000_000});assert.equal(p.text.length,16000);assert.equal(p.totalChars,raw.length);assert.equal(p.nextOffset,16000);
  assert.equal(s.rawObservation('huge',id,date,{offset:16000,limit:4}).text,raw.slice(16000,16004));
  assert.equal(s.observationDownload('huge',id,date),raw);
  assert.throws(()=>s.rawObservation('huge',id,'2026-10-26'),e=>e.status===404);
  assert.throws(()=>s.observationDownload('huge','other-sku',date),e=>e.status===404);
  await settle();s.close();
});

test('归档 SKU 退出型号、每日采价和分析投影，价格证据仍保留',()=>{
  const {service}=fixture();
  try {
    const before=service.db.prepare('SELECT COUNT(*) n FROM skus').get().n;
    service.db.prepare('UPDATE skus SET active=0').run();
    assert.equal(service.models().length,0);
    assert.equal(service.listRows(date).summary.total,0);
    assert.equal(service.getDraft().rows.length,0);
    assert.equal(service.db.prepare('SELECT COUNT(*) n FROM skus').get().n,before);
  } finally {service.close();}
});

test('工作室只关注价券差额和N代双缺价；N-1双缺价只提示且不放行无效报价',async()=>{
  const {reviewFocus}=await import('./price-workbench.mjs');
  const q={matched:false,list:null,coupon:null};const issues=validateQuote(q);
  const old=reviewFocus(issues,{generation:'N-1',...q,quote:q});
  assert.equal(old.verificationCount,0);assert.equal(old.reviewNotice,'未找到该N-1代机器京东自营销售信息');
  assert.equal(reviewFocus(issues,{generation:'N',...q,quote:q}).verificationCount,1);
  assert.equal(reviewFocus(issues,{generation:'N',list:100,coupon:null,quote:q}).verificationCount,0);
  assert.equal(reviewFocus([{code:'PRICE_COMPONENT_MISMATCH',field:'coupon'},{code:'PRICE_JUMP'}],{generation:'N-1',list:100,coupon:0}).verificationCount,1);
  assert.ok(issues.some(i=>i.code==='MISSING_LIST'));
});

test('商品链接可单独保存，支持并发冲突检查并记录审计，不制造价格',()=>{
  const {service:s,users}=fixture();
  try {
    const id=s.listRows(date).rows[0].id;
    assert.throws(()=>s.saveProductLink(id,{link:'javascript:alert(1)'},users.reviewer1.user),e=>e.status===422);
    s.saveProductLink(id,{link:'https://item.jd.com/123.html',baseLink:''},users.reviewer1.user);
    const row=s.listRows(date).rows[0];assert.equal(row.productLink,'https://item.jd.com/123.html');assert.equal(row.work,null);
    assert.throws(()=>s.saveProductLink(id,{link:'https://item.jd.com/456.html',baseLink:''},users.reviewer2.user),e=>e.status===409);
    assert.equal(s.db.prepare("SELECT count(*) n FROM audit WHERE action='SAVE_PRODUCT_LINK'").get().n,1);
  } finally {s.close();}
});

test('单元格检查留痕且不改价；价格或新报价变化使已检查状态失效',async()=>{
  const {service:s,users}=fixture();
  try{
    s.importRows([sample(undefined,undefined,{actual:4500})],date,users.admin.user,'check-test');
    let r=s.listRows(date).rows[0];
    s.checkCell(r.id,date,{field:'coupon',baseVersion:r.work.version},users.reviewer1.user);
    r=s.listRows(date).rows[0];assert.equal(r.work.checkedCells.coupon,true);assert.equal(r.work.coupon,20000);
    assert.throws(()=>s.checkCell(r.id,date,{field:'coupon',baseVersion:-1},users.reviewer1.user),e=>e.status===409);
    s.patchCell(r.id,date,{field:'coupon',value:'210',baseVersion:r.work.coupon_version},users.reviewer1.user);
    assert.equal(s.listRows(date).rows[0].work.checkedCells.coupon,false);
  }finally{await settle();s.close();}
});

test('一键推数仓允许价差报价按当前值生效，缺价空跑、重复推送不重复创建版本',async()=>{
  const {service:s,users}=fixture();
  try{
    s.importRows([sample(undefined,undefined,{actual:4500}),{...sample('真我 GT8 Pro'),generation:'N',selected:null}],date,users.admin.user,'push-test');
    let p=s.listRows(date);
    assert.throws(()=>s.pushWarehouse(date,{token:p.pushToken},users.reviewer1.user),e=>e.status===403);
    assert.throws(()=>s.pushWarehouse(date,{token:'stale'},users.admin.user),e=>e.status===409);
    const r=s.pushWarehouse(date,{token:p.pushToken},users.admin.user);
    assert.equal(r.published,1);assert.equal(r.skipped,1);
    p=s.listRows(date);const w=p.rows.find(x=>x.model==='小米 17 Pro').work;
    assert.equal(w.published.list,500000);assert.equal(w.published.coupon,20000);assert.equal(w.published.final,430000);
    assert.equal(p.rows.find(x=>x.model==='真我 GT8 Pro').work.published == null,true);
    const again=s.pushWarehouse(date,{token:p.pushToken},users.admin.user);assert.equal(again.published,0);assert.equal(again.unchanged,1);
    assert.equal(s.db.prepare('SELECT count(*) n FROM revisions').get().n,1);
  }finally{await settle();s.close();}
});

test('推数仓后可二次确认还原首次API版；核验颜色重置且已发布价格保留',async()=>{
  const {service:s,users}=fixture();
  try{
    s.importRows([sample(undefined,undefined,{actual:4500})],date,users.admin.user,'reset-base');
    s.db.prepare("UPDATE observations SET run_id='api-first'").run();
    let p=s.listRows(date),r=p.rows[0];
    s.patchCell(r.id,date,{field:'coupon',value:'300',baseVersion:r.work.coupon_version},users.reviewer1.user);
    p=s.listRows(date);s.pushWarehouse(date,{token:p.pushToken},users.admin.user);
    p=s.listRows(date);r=p.rows[0];s.checkCell(r.id,date,{field:'coupon',baseVersion:r.work.version},users.reviewer1.user);
    assert.throws(()=>s.resetApi(date,{token:p.pushToken},users.admin.user),e=>e.status===422);
    assert.throws(()=>s.resetApi(date,{token:p.pushToken,confirmed:true},users.reviewer1.user),e=>e.status===403);
    assert.throws(()=>s.resetApi(date,{token:'old',confirmed:true},users.admin.user),e=>e.status===409);
    assert.equal(s.resetApi(date,{token:p.pushToken,confirmed:true},users.admin.user).restored,1);
    r=s.listRows(date).rows[0];assert.equal(r.work.coupon,20000);assert.equal(r.work.published.coupon,30000);assert.equal(r.work.checkedCells.coupon,false);assert.equal(s.listRows(date).summary.pending,1);
    assert.equal(s.db.prepare('SELECT count(*) n FROM revisions').get().n,1);
  }finally{await settle();s.close();}
});

test('N代双缺价可标记下架完成核验，价格为空、投影无价格且可还原API',async()=>{
  const {service:s,users}=fixture();
  try{
    s.importRows([{...sample(),generation:'N',selected:null}],date,users.admin.user,'delisted-test');
    s.db.prepare("UPDATE observations SET run_id='api-first'").run();
    let r=s.listRows(date).rows[0];assert.equal(r.work.verificationCount,1);
    assert.throws(()=>s.markDelisted(r.id,date,{baseVersion:-1},users.reviewer1.user),e=>e.status===409);
    s.markDelisted(r.id,date,{baseVersion:r.work.version},users.reviewer1.user);
    r=s.listRows(date).rows[0];assert.equal(r.work.verificationCount,0);assert.equal(r.work.dirty,false);assert.equal(r.work.published.availability,'discontinued');assert.equal(r.work.list,null);assert.equal(r.work.coupon,null);assert.equal(r.work.final,null);assert.equal(s.listRows(date).summary.pending,0);
    assert.equal(s.getDraft().rows[0].snapshots['10.27'].listPrice,'');
    s.resetApi(date,{confirmed:true,token:s.listRows(date).pushToken},users.admin.user);assert.equal(s.listRows(date).summary.pending,1);
  }finally{await settle();s.close();}
});

test('提交链接创建单SKU任务；已人工确认缺货的行可载入新报价，并发修改仍受保护',async()=>{
  const provider={configured:true,collect:async()=>({quote:{matched:true,date,list:500000,coupon:20000,actual:480000,shop,link:'https://item.jd.com/123.html',goodsId:'linked',title:'小米17Pro 12+256GB',threshold:0,start:'2026-10-01',end:'2026-10-31'},raw:{summary:{manualLink:true}}})};
  const {service:s,users}=fixture({provider});
  try{
    s.importRows([{...sample(),selected:null}],date,users.admin.user,'link-queue-test');let r=s.listRows(date).rows[0];
    s.markDelisted(r.id,date,{baseVersion:r.work.version},users.reviewer1.user);
    const saved=s.saveProductLink(r.id,{link:'https://item.jd.com/123.html',baseLink:'',date,recollect:true},users.reviewer1.user);
    assert.ok(saved.runId);await s.processRun();r=s.listRows(date).rows[0];assert.equal(r.work.list,500000);assert.equal(r.work.published.availability,'on_sale');
    s.saveProductLink(r.id,{link:'https://item.jd.com/456.html',baseLink:saved.link,date,recollect:true},users.reviewer1.user);
    s.patchCell(r.id,date,{field:'coupon',value:'300',baseVersion:r.work.coupon_version},users.reviewer2.user);
    await s.processRun();assert.equal(s.listRows(date).rows[0].work.coupon,30000);
  }finally{await settle();s.close();}
});
