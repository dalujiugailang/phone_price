import test from 'node:test';
import assert from 'node:assert/strict';
import { createDailyPriceClient, selectedDailyPpv, attachDailyPrice } from './daily-price-client.mjs';

const ppv = 'A+真我 Neo8 大陆国行 全网通 12G+256G 起源白';
const row = () => ({ model:'真我 Neo8',grade:'A+',asOf:'2026-10-29',status:'matched',warnings:[],mix:{mode:'toc'},competition:[],
 metrics:[{id:'p1',label:'P1',value:2267.75,dates:['2026-10-29'],points:1},{id:'toc',label:'C端结算价',value:2223.5,dates:['2026-10-29'],points:1},
 {id:'bi',value:9999,dates:[],points:1},{id:'base',value:9999,dates:[],points:1},{id:'item',value:null,dates:[],points:0}],
 diagnoses:[{title:'旧出货价 vs BI价',verdict:'旧判断不可保留'}] });
const payload = () => ({dataDate:'2026-11-03',zzDate:'2026-11-03',receivedAt:'2026-11-03T10:00:00Z',rows:[{
 ppv,matched:true,'等级名称':'A+','bi出货价':2261,'BI基准价':2216,'最终报价':1365,'ZZ券前价':1000,'ZZ券后价':1500,dataDate:'2026-11-03'}]});

test('标准SKU只替换等级，不凭型号猜测颜色和完整PPV',()=>{
 assert.equal(selectedDailyPpv(row(),{ppv:'S真我 Neo8 大陆国行 全网通 12G+256G 起源白'}),ppv);
 assert.equal(selectedDailyPpv(row(),{}),null);
 assert.equal(selectedDailyPpv(row(),{ppv:'S其他型号 12G+256G 黑色'}),null);
});
test('使用Daily Price接口直接值；最终报价独立，不冒充回收物品价',()=>{
 const result=attachDailyPrice(row(),ppv,payload());
 assert.equal(result.metrics.find(m=>m.id==='bi').value,2261);
 assert.equal(result.metrics.find(m=>m.id==='base').value,2216);
 assert.equal(result.metrics.find(m=>m.id==='finalQuote').value,1365);
 assert.equal(result.metrics.find(m=>m.id==='item').value,null);
 assert.deepEqual(result.metrics.find(m=>m.id==='bi').dates,['2026-11-03']);
 assert.ok(!result.diagnoses.some(d=>d.verdict.includes('旧判断')));
 assert.equal(result.diagnoses[0].verdict,'跨日历史参考，暂不判涨降价');
});
test('未匹配或等级不同不使用错误行，也不回退历史反算BI',()=>{
 const p=payload();p.rows[0]['等级名称']='S';
 const result=attachDailyPrice(row(),ppv,p);
 assert.equal(result.dailyPrice.status,'unmatched');
 assert.equal(result.metrics.find(m=>m.id==='bi').value,null);
 assert.equal(result.metrics.find(m=>m.id==='base').value,null);
 assert.equal(result.metrics.find(m=>m.id==='finalQuote').value,null);
});
test('Daily/ZZ不同日期时不使用ZZ价格',()=>{
 const p=payload();p.zzDate='2026-11-02';
 const r=attachDailyPrice(row(),ppv,p);
 assert.equal(r.dailyPrice.zzAfter,null);assert.ok(r.warnings.some(w=>w.includes('ZZ竞争价日期不一致')));
});
test('真实查询客户端把Token保留在服务端，验证meta及Bearer契约',async()=>{
 const calls=[];
 const client=createDailyPriceClient({projectRoot:'/tmp/test',tokenReader:async()=> 'test-only-token',fetchImpl:async(url,options)=>{
  calls.push({url,options});
  return new Response(JSON.stringify(String(url).endsWith('/meta')?{zzCompetitiveness:{dataDate:'2026-11-03'}}:payload()),{status:200,headers:{'content-type':'application/json'}});
 }});
 const r=await client.lookup([ppv,ppv]);
 const lookup=calls.find(c=>c.options.method==='POST');
 assert.equal(lookup.options.headers.authorization,'Bearer test-only-token');
 assert.deepEqual(JSON.parse(lookup.options.body),{ppv:[ppv]});
 assert.equal(r.dataDate,'2026-11-03');assert.equal(r.zzDate,'2026-11-03');
 assert.ok(!JSON.stringify(r).includes('test-only-token'));
});
test('接口401和连接失败清晰报错，不返回成功假数据',async()=>{
 const options={projectRoot:'/tmp/test',tokenReader:async()=> 'test'};
 const client=createDailyPriceClient({...options,fetchImpl:async()=>new Response('{}',{status:401})});
 await assert.rejects(()=>client.lookup([ppv]),/401/);
 const unavailable=createDailyPriceClient({...options,fetchImpl:async()=>{throw new Error('private transport message');}});
 await assert.rejects(()=>unavailable.lookup([ppv]),/连接失败/);
});
