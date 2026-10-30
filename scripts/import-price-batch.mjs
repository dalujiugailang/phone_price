import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import XLSX from 'xlsx';
import {createPriceWorkbench,skuIdentity} from '../server/lib/price-workbench.mjs';

const args=process.argv.slice(2);
const arg=(name)=>args[args.indexOf(name)+1];
for(const name of ['--source','--evidence','--data-dir','--date'])if(!args.includes(name))throw new Error(`必须指定 ${name}`);
const source=arg('--source'),evidence=arg('--evidence'),dataDir=path.resolve(arg('--data-dir')),date=arg('--date');
const rows=JSON.parse(fs.readFileSync(evidence,'utf8'));
const detailsFile=path.join(path.dirname(evidence),'details.json');
const originalDetails=fs.existsSync(detailsFile)?JSON.parse(fs.readFileSync(detailsFile,'utf8')):{};
const book=XLSX.readFile(source);
const sheet=book.Sheets['1027品牌自营查价'];
if(!sheet)throw new Error('找不到 1027品牌自营查价 工作表');
const excel=XLSX.utils.sheet_to_json(sheet,{range:5,defval:null});
if(excel.length!==rows.length)throw new Error('Excel 与查询证据行数不一致');
for(let i=0;i<rows.length;i++){
  const r=rows[i],x=excel[i],g=r.selected;
  if(x['型号']!==r.model || x['存储版本']!==r.storage)throw new Error(`第 ${i+7} 行型号或存储不一致`);
  for(const [col,key] of [['1027挂牌价（元）','listing'],['1027接口券额（元）','coupon'],['1027参考到手价（元）','actual']])if(g?Number(x[col])!==g[key]:x[col]!==null)throw new Error(`第 ${i+7} 行 ${col} 与接口证据不一致`);
}
if(new Set(rows.map(r=>skuIdentity(r.model,r.storage))).size!==rows.length)throw new Error('来源 SKU 重复');
const hash=createHash('sha256').update(fs.readFileSync(source)).digest('hex');
for(const row of rows)if(row.selected?.id && originalDetails[row.selected.id])row.originalApiDetail=originalDetails[row.selected.id];
if(!args.includes('--apply')){console.log(JSON.stringify({mode:'dry-run',source,date,rows:rows.length,hash,message:'逐行证据比对通过；传 --apply 才写入指定的数据目录'},null,2));process.exit(0);}
const service=createPriceWorkbench({dataDir,legacyDatabasePath:path.join(dataDir,'raw-editor-draft.sqlite')});
try{
  const admin=service.db.prepare("SELECT id FROM users WHERE role='admin'").get();
  console.log(JSON.stringify(service.importRows(rows,date,{id:admin.id},hash),null,2));
  // Allow projection acknowledgement to commit before closing the connection.
  await new Promise(resolve=>setImmediate(resolve));
}finally{service.close();}
