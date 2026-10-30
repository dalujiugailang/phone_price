import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBrandPivot } from '../src/brandPivot.ts';
import type { SKUData } from '../src/data';
const sku=(id:string,brand:string,prices:Array<[string,number]>,launchPrice=100):SKUData=>({id,brand,model:id,storage:'256GB',series:'系列',position:'旗舰',ppv:'',launchPrice,snapshots:prices.map(([date,finalPrice])=>({date,finalPrice,listPrice:finalPrice,coupon:0}))});
test('brand means weight each SKU equally and direction counts sum to member count',()=>{
 const result=buildBrandPivot([sku('a','甲',[['1.1',100],['1.2',120]]),sku('b','甲',[['1.1',200],['1.2',180]]),sku('c','甲',[['1.1',300],['1.2',330]])],['1.1','1.2']);
 assert.equal(result.length,1);const row=result[0];assert.equal(row.skuCount,3);assert.equal(row.snapshotAvgs[0].avgPrice,200);assert.equal(row.snapshotAvgs[1].avgPrice,210);assert.equal(row.diff,10);assert.equal(row.diffPct,5);assert.deepEqual(row.directionSummary,{up:2,down:1,flat:0});
});
test('exclude SKUs without latest price and missing launch prices from launch average',()=>{
 const result=buildBrandPivot([sku('a','甲',[['1.1',100],['1.2',110]],0),sku('b','甲',[['1.1',200],['1.2',200]],200),sku('c','乙',[['1.1',300]])],['1.1','1.2']);
 assert.equal(result.length,1);assert.equal(result[0].skuCount,2);assert.equal(result[0].avgLaunch,200);assert.equal(result[0].trendData[0].date,'发布');
});
test('a single-date brand has no fabricated historical movement',()=>{
 const [row]=buildBrandPivot([sku('a','甲',[['1.2',100]],0)],['1.1','1.2']);
 assert.equal(row.diff,0);assert.equal(row.diffPct,0);assert.deepEqual(row.directionSummary,{up:0,down:0,flat:1});assert.equal(row.trendData.length,1);
});
