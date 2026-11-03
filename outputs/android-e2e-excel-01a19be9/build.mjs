import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Workbook, SpreadsheetFile } from '@oai/artifact-tool';

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, '../..');
const source = path.join(root, 'data/android-e2e/browser-verified-20261102');
const read = async n => JSON.parse(await fs.readFile(path.join(source, n), 'utf8'));
const [daily, models, prices, sales, strategy, quality, manifest] = await Promise.all(
  ['daily.json', 'models.json', 'price_data.json', 's4_data.json', 'tk_data.json', 'data-quality.json', 'manifest.json'].map(read));
const latest = manifest.date_range[1];
const modelMap = new Map(models.map(m => [m.model, m]));
const workbook = Workbook.create();
const sheets = [];
const counts = {};
const serial = value => value ? (Date.parse(value + 'T00:00:00Z') / 86400000 + 25569) : null;
const sum = vals => vals.every(v => v == null) ? null : vals.reduce((a, b) => a + (b ?? 0), 0);
const clean = v => typeof v === 'string' && v.startsWith('=') ? "'" + v : v;
function letter(n) { let s=''; for(n++;n;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s;return s; }

function add(name, title, note, headers, rows, {dates=[], formats={}, widths={}}={}) {
  console.log(`Writing ${name}: ${rows.length} rows`);
  const s = workbook.worksheets.add(name);
  sheets.push(s); counts[name] = rows.length;
  s.showGridLines = false;
  s.getRange('A2').values = [[title]];
  s.getRange('A2').format.font = {name:'Arial', size:15, bold:true, color:'#16324F'};
  s.getRange('A3').values = [['来源：https://atrenew.feishu.link/app/app_17h053qz13d']];
  s.getRange('A3').format.font = {name:'Arial', size:10, color:'#62748A'};
  s.getRange('A4').values = [[note]];
  s.getRange('A4').format.font = {name:'Arial', size:10, color:'#8A5A14'};
  const end = rows.length + 5, last = letter(headers.length-1);
  s.getRange(`A5:${last}5`).values = [headers];
  for(let i=0;i<rows.length;i+=5000){
    const block=rows.slice(i,i+5000).map(row=>row.map(clean));
    s.getRangeByIndexes(i+5,0,block.length,headers.length).values=block;
  }
  s.getRange(`A5:${last}5`).format = {
    fill:'#24486C', font:{name:'Arial',size:10,bold:true,color:'#FFFFFF'},
    horizontalAlignment:'center',verticalAlignment:'center',wrapText:true,rowHeight:35,
  };
  s.getRange(`A6:${last}${Math.min(end,30)}`).format.font={name:'Arial',size:10,color:'#22354B'};
  for(let i=0;i<headers.length;i++){
    s.getRange(`${letter(i)}5:${letter(i)}${end}`).format.columnWidth=widths[i]??16;
  }
  for(const i of dates)s.getRange(`${letter(i)}6:${letter(i)}${end}`).setNumberFormat('yyyy-mm-dd');
  for(const [i,format] of Object.entries(formats))s.getRange(`${letter(+i)}6:${letter(+i)}${end}`).setNumberFormat(format);
  s.freezePanes.freezeRows(5);s.freezePanes.freezeColumns(3);
  const table=s.tables.add(`A5:${last}${end}`,true,`Data${sheets.length}`);
  table.style='TableStyleMedium2';table.showFilterButton=true;
  return s;
}

const fields = [
 ['date','日期'],['brand','品牌'],['model','型号'],['inventory','库存量（台）'],
 ['daily_sales_3d','近3天日均销量'],['daily_sales_7d','近7天日均销量'],
 ['purchase_sales_ratio_3d','快照近3天进销比'],['purchase_sales_ratio_7d','快照近7天进销比'],
 ['submit_self','自营提交量'],['submit_other_bd','其他BD提交量'],['submit_jd_recycle','京东普通回收提交量'],['submit_jd_tradein','京东换新提交量'],
 ['deal_self','自营成交量'],['deal_other_bd','其他BD成交量'],['deal_jd_recycle','京东普通回收成交量'],['deal_jd_tradein','京东换新成交量'],
 ['sales_toc','TOC销量'],['sales_tob','TOB销量'],['sales_unknown','未标注渠道销量'],
 ['backlog_estimated','在途未交付估算量'],['delivery_days_sum','交付耗时合计（天）'],['delivered_count','当日完结单量'],
];
const dailyMatrix = records=>records.map(r=>fields.map(([k])=>k==='date'?serial(r[k]):r[k]));
const numericFormats=Object.fromEntries(fields.slice(3).map(([k],i)=>[i+3,/ratio|daily_sales|backlog/.test(k)?'#,##0.00':'#,##0']));
add('最新日经营', `安卓端到端看板 ${latest}`, '最新日完整型号经营数据；空白表示缺失，0表示源值为0。在途量是估算值。',
  fields.map(f=>f[1]), dailyMatrix(daily.filter(r=>r.date===latest)),
  {dates:[0],formats:numericFormats,widths:{0:14,1:14,2:38}}).tabColor='#24486C';

const priceDefs = [
 {source:'s1',name:'回收价格',metrics:[['p1','成交日P1','d'],['p1b','成交日P1′','d'],['dq','成交量','d'],['base','回收基准价','dc'],['item','成交策略报价','dc'],['dqc','创单量','dc']]},
 {source:'s2',name:'普通回收竞争',metrics:[['zz','转转券后价','d'],['ahsBefore','爱回收券后价（追前）','d'],['ahsAfter','爱回收券后价（追后）','d'],['base','BI基准价','d']]},
 {source:'s3',name:'换新竞争',metrics:[['jdBefore','京东到手价（追前）','d'],['jdAfter','京东到手价（追后）','d'],['tm','天猫到手价','d'],['base','基准价','d'],['newSeries','关联新品系列','d']]},
 {source:'s4',name:'销售价格',metrics:[['bprice','B端实际出货价','d'],['cprice','C端实际结算价','d'],['dqTob','TOB销量','d'],['dqToc','TOC销量','d']]},
];
for(const def of priceDefs){
 const all=[]; let day='';
 const container=def.source==='s4'?sales.models:prices.models;
 for(const [name,m] of Object.entries(container)){
   const variants=def.source==='s4'?m:m[def.source];
   for(const [variant,v] of Object.entries(variants??{})){
     all.push({name,variant,v});
     for(const date of v.d??[])if(date>day)day=date;
   }
 }
 const rows=[];
 for(const {name,variant,v} of all){
   if(!(v.d??[]).includes(day)&&!(v.dc??[]).includes(day))continue;
   const parts=variant.split('|'),issues=[];
   const values=def.metrics.map(([field,label,axis])=>{
     if(!Array.isArray(v[field]))return null;
     if(v[field].length!==(v[axis]??[]).length){issues.push(`${field}日期轴不一致`);return null;}
     const i=v[axis].indexOf(day);return i<0?null:v[field][i]??null;
   });
   rows.push([serial(day),modelMap.get(name)?.brand??null,name,parts[0],parts[1],parts[2],...values,issues.join('；')||'']);
 }
 rows.sort((a,b)=>String(a[1]).localeCompare(String(b[1]),'zh-CN')||a[2].localeCompare(b[2],'zh-CN'));
 add(def.name,`${def.name} ${day}`, '仅列该源最新数据日有记录的变体，不沿用历史价；日期轴不一致字段留空，并在末列标注。金额单位：元。',
   ['日期','品牌','型号','内存规格','OS字段','等级',...def.metrics.map(m=>m[1]),'数据问题'],rows,
   {dates:[0],widths:{0:14,1:14,2:38,3:20,4:14,5:12,[6+def.metrics.length]:42},
    formats:Object.fromEntries(def.metrics.flatMap(([k],i)=>k==='newSeries'?[]:[[6+i,/dq/.test(k)?'#,##0':'#,##0.00']]))});
}

add('历史经营明细','历史经营明细 2026-08-01 至 2026-11-01','保留全部191,729行经营明细。库存是时点量，不能跨日期累计；进销比是上游快照口径。',
 fields.map(f=>f[1]),dailyMatrix(daily.slice(0,10)),{dates:[0],formats:numericFormats,widths:{0:14,1:14,2:38}});
counts['历史经营明细']=daily.length;
const tkDate=strategy.meta.dates.indexOf(latest);
const modelData=models.map(m=>{
 const tk=strategy.models[m.model];
 return [m.brand,m.model,serial(m.listing_date),m.tag_mask,tk?.tk?.[tkDate]??null,tk?.tkType?.[tkDate]??null,tk?.tkName?.[tkDate]??null];
});
add('型号资料','型号资料与最新日策略','标签掩码1/2/4/8分别为普通回收竞争、换新竞争、CC拉通、旗舰发新重点；可叠加。系数为调价比例。',
 ['品牌','型号','上市日期','标签掩码','周转系数','策略类型','策略名称'],modelData,
 {dates:[2],formats:{4:'0.0%'},widths:{0:14,1:38,2:14,3:14,4:16,5:24,6:48}});
const qualityRows=Object.entries(quality.array_length_mismatches).map(([k,n])=>[k,n,'原值保留；错轴字段留空（非订单数）']);
const q=add('数据质量','源数据质量问题','价格表中受影响字段留空；原始值完整保留在已导出的JSON中，未猜测对应日期。',
 ['字段','不一致数组数','处理说明'],qualityRows,{widths:{0:24,1:22,2:85},formats:{1:'#,##0'}});
const examples=quality.examples.map(e=>[e.path,e.axis,e.field,e.dates,e.values]);
q.getRange('A14:E14').values=[['问题路径','日期轴','字段','日期数','值数量']];
q.getRange(`A15:E${14+examples.length}`).values=examples;
q.getRange('A14:E14').format={fill:'#24486C',font:{bold:true,color:'#FFFFFF'},rowHeight:28};
q.getRange(`A15:A${14+examples.length}`).format.columnWidth=70;
q.getRange(`B15:B${14+examples.length}`).format.columnWidth=22;
q.getRange(`C15:C${14+examples.length}`).format.columnWidth=48;
q.getRange(`D15:E${14+examples.length}`).format.columnWidth=18;

const dictionary=fields.map(([key,label])=>['经营字段',key,label,
 key==='date'?'经营日期':key.includes('ratio')?'上游快照比值，与当日成交/销量自算比不同':key==='backlog_estimated'?'cohort存活估算在途量，不是订单明细实数':key==='delivery_days_sum'?'与当日完结单量相除可得平均交付天数':key==='inventory'?'当日库存快照，不跨日期累计':'源值直接导出']);
dictionary.push(['价格口径','s1.d / s1.dc','成交日 / 创单日','P1按成交日；回收基准价与成交策略报价按创单日'],
 ['价格口径','s4.bprice','TOB实际出货价','销售额÷TOB销售量'],['价格口径','s4.cprice','TOC实际结算价','一盘货C2B销售渠道结算价÷TOC销售量'],
 ['导出范围','价格快照','各源最新数据日','仅当日有记录的变体；并非完整价格历史。换新竞争最新日2026-10-31，其余价格源2026-11-01。'],
 ['导出范围','历史经营明细',`${daily.length}行`,'完整日期×型号×渠道数量；191,729行均保留。'],
 ['数据源','抓取时间',manifest.exported_at,'本表使用已核验的JSON快照，不重新抓取网站。']);
add('字段说明','字段说明与导出范围','数据日期截至2026-11-01。经营数据与价格源存在不同覆盖范围；空白不转换为0。',
 ['分组','字段标识','中文含义','口径'],dictionary,{widths:{0:18,1:40,2:34,3:105}});

workbook.recalculate();
console.log((await workbook.inspect({kind:'table',range:'最新日经营!A5:H8',include:'values',tableMaxRows:4,tableMaxCols:8,maxChars:2500})).ndjson);
for(const sheet of sheets){
 if(sheet.name!=='数据质量' && await fs.stat(path.join(dir,`${sheet.name}.png`)).then(()=>true,()=>false))continue;
 const preview=await workbook.render({sheetName:sheet.name,range:'A2:H10',scale:1.3,format:'png'});
 await fs.writeFile(path.join(dir,`${sheet.name}.png`),new Uint8Array(await preview.arrayBuffer()));
 console.log(`Rendered ${sheet.name}`);
}
console.log('Exporting workbook');
const file=await SpreadsheetFile.exportXlsx(workbook);
const output=path.join(dir,'workbook-base.xlsx');
await file.save(output);
await fs.writeFile(path.join(dir,'export-checks.json'),JSON.stringify({source,latest,rows:counts,output},null,2));
console.log(JSON.stringify({output,rows:counts}));
