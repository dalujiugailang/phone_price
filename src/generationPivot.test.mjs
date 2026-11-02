import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGenerationPivot } from './brandPivot.ts';

test('代际沿用型号配置，等权均价、方向计数及未配置完整保留', () => {
  const sku = (id,model,prices) => ({id,model,brand:'品牌',storage:id,launchPrice:1000,snapshots:prices.map((finalPrice,i)=>({date:['10.10','10.29'][i],finalPrice}))});
  const rows=buildGenerationPivot([sku('a','A',[100,200]),sku('b','A',[300,200]),sku('c','B',[500,400]),sku('d','C',[100,100])],['10.10','10.29'],[{name:'A',generation:'N'},{name:'B',generation:'N-1'}]);
  assert.deepEqual(rows.map(r=>r.brand),['N','N-1','未配置']);
  assert.equal(rows.reduce((n,r)=>n+r.skuCount,0),4);
  assert.equal(rows[0].snapshotAvgs[1].avgPrice,200);
  assert.deepEqual(rows[0].directionSummary,{up:1,down:1,flat:0});
  assert.equal(rows[1].diff,-100);
});
