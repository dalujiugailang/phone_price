import test from 'node:test';
import assert from 'node:assert/strict';
import { computePriceDiagnostic, normalizeStorage } from './android-risk-diagnostics.mjs';

const dates = ['2026-10-26','2026-10-27','2026-10-28','2026-10-29','2026-10-30','2026-10-31','2026-11-01'];
function fixture() {
  return {
    board: {meta:{dates},models:[{n:'测试型号'}],sales:dates.map(()=>[[0,10,0,0]]),inv:dates.map(()=>[[0,20,5,4,.5,1]])},
    price:{models:{'测试型号':{s1:{
      '12GB+256GB|—|A1':{d:[dates[0]],p1:[3300],p1b:[3300],dq:[8],dc:[dates[0]],base:[3000],item:[2400]},
      '12GB+256GB|—|S':{d:[dates[0]],p1:[9999],p1b:[9999],dq:[2],dc:[dates[0]],base:[9999],item:[9999]},
      '16GB+512GB|—|A1':{d:[dates[6]],p1:[9999],dq:[1000]},
    }}}},
    sales:{models:{'测试型号':{'12GB+256GB|—|A1':{d:[dates[0]],bprice:[2800],cprice:[3000]}}}},
    strategy:{meta:{dates},models:{'测试型号':{tk:dates.map(()=>-.04),tkType:[],tkName:[]}}},
  };
}
const target = {model:'测试型号',storage:'12G+256G'};
test('同型号同规格按窗口成交量选PPV，不限S，不跨存储规格',()=>{
 const d=computePriceDiagnostic(fixture(),target);
 assert.equal(d.variant,'12GB+256GB|—|A1');assert.equal(d.selectedVolume,8);assert.equal(d.selectionDays,7);
 assert.equal(normalizeStorage('16 GB + 1 TB'),'16G+1T');
 assert.equal(d.windowDays,7);assert.equal(d.metrics.find(m=>m.id==='p1').value,3300);
 assert.equal(d.diagnoses.find(j=>j.title.startsWith('P1')).verdict,'P1虚高');
 assert.equal(d.metrics.find(m=>m.id==='bi').value,3125);
 assert.equal(d.diagnoses.find(j=>j.title==='周转系数是否合理').verdict,'周转系数需回撤');
});
test('当前风险日期作为截止日，禁止使用其后成交量选变体',()=>{
 const f=fixture();f.price.models['测试型号'].s1['12GB+256GB|—|S'].d=[dates[6]];
 const d=computePriceDiagnostic(f,{...target,riskPriceDate:'10.29'});
 assert.equal(d.asOf,'2026-10-29');assert.equal(d.grade,'A1');
 assert.ok(d.metrics.every(m=>m.dates.every(date=>date<='2026-10-29')));
});
test('未指定OS时覆盖所有候选，选中后仍严格锁定同变体',()=>{
 const f=fixture();f.price.models['测试型号'].s1['12GB+256GB|Android|B1']={d:[dates[0]],dq:[20],p1:[1234],p1b:[1234]};
 const d=computePriceDiagnostic(f,target);
 assert.equal(d.variant,'12GB+256GB|Android|B1');assert.equal(d.os,'Android');
 assert.equal(d.metrics.find(m=>m.id==='toc').value,null);
 assert.equal(computePriceDiagnostic(f,{...target,os:'—'}).grade,'A1');
});
test('日期轴错位保留缺失，不能计算反推BI或伪造BI合理诊断',()=>{
 const f=fixture();f.price.models['测试型号'].s1['12GB+256GB|—|A1'].base.push(9999);
 const d=computePriceDiagnostic(f,target);
 assert.equal(d.status,'partial');assert.equal(d.metrics.find(m=>m.id==='bi').value,null);
 assert.ok(d.warnings.some(w=>w.includes('base与dc')));
 assert.ok(!d.diagnoses.some(j=>j.title.includes('vs BI价')));
});
test('近7天没有成交则用30天选取，仍保留价格链统一近7天窗口',()=>{
 const f=fixture();const s=f.price.models['测试型号'].s1;
 for(const v of Object.values(s))v.d=['2026-10-10'];
 const d=computePriceDiagnostic(f,target);
 assert.equal(d.selectionDays,30);assert.equal(d.selectedVolume,8);assert.equal(d.windowDays,7);
 assert.equal(d.metrics.find(m=>m.id==='p1').value,null);
});
test('零成交、未知型号、指定等级缺失不借用别的变体',()=>{
 const f=fixture();for(const v of Object.values(f.price.models['测试型号'].s1))v.dq=[0];
 assert.equal(computePriceDiagnostic(f,target).status,'unmatched');
 assert.equal(computePriceDiagnostic(f,{...target,model:'未知'}).status,'unmatched');
 assert.equal(computePriceDiagnostic(f,{...target,grade:'95-S'}).status,'unmatched');
});
test('明确拒绝超出快照范围的日期',()=>{
 assert.throws(()=>computePriceDiagnostic(fixture(),{...target,date:'2026-11-03'}),/快照范围/);
});
test('图表竞争价严格锁定所选PPV及截止日，库存水位由真实快照计算',()=>{
 const f=fixture();f.price.models['测试型号'].s2={
  '12GB+256GB|—|A1':{d:[dates[0],'2026-11-02'],ahsAfter:[2500,9999],ahsBefore:[2400,9999],zz:[2600,100]},
  '12GB+256GB|—|S':{d:[dates[6]],ahsAfter:[9999],zz:[100]},
 };
 const d=computePriceDiagnostic(f,target);
 assert.equal(d.competition[0].our.value,2500);assert.equal(d.competition[0].our.date,dates[0]);
 assert.equal(d.competition[0].rival.value,2600);assert.equal(d.competition[0].pressure,true);
 assert.equal(d.competition[0].coupon,100);
 assert.equal(d.competition[1].our.value,null);
 assert.equal(d.inventory.latest,20);assert.equal(d.inventory.average,20);assert.equal(d.inventory.verdict,'库存水位正常');
});
