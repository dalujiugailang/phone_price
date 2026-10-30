import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankVolatility, type VolatilitySKU } from '../src/skuVolatility.ts';
const sku = (id: string, prices: Array<[string,number]>): VolatilitySKU => ({id,brand:'品牌',model:id,storage:'256GB',reasonDetails:[],snapshots:prices.map(([date,finalPrice])=>({date,finalPrice,listPrice:finalPrice,coupon:0}))});
test('ranks by absolute movement, including larger price drops before increases',()=>{
 const rows=rankVolatility([sku('rise',[['1.1',100],['1.2',120]]),sku('fall',[['1.1',100],['1.2',60]]),sku('flat',[['1.1',100],['1.2',100]])],'1.2','1.1');
 assert.deepEqual(rows.map(row=>row.id),['fall','rise','flat']);assert.equal(rows[0].percent,-40);assert.equal(rows[0].amount,-40);
});
test('missing adjacent dates and invalid prices are incomparable rather than flat or 100% declines',()=>{
 for(const prices of [[['1.1',100]],[['1.2',100]],[['1.1',0],['1.2',100]],[['1.1',100],['1.2',0]]] as Array<Array<[string,number]>>){
 const [row]=rankVolatility([sku('missing',prices)],'1.2','1.1');assert.equal(row.comparable,false);assert.equal(row.percent,null);assert.equal(row.amount,null);
 }
});
test('historical frames use the requested pair and do not mutate source snapshots',()=>{
 const input=[sku('a',[['1.1',100],['1.2',110],['1.3',55]])];const before=structuredClone(input);
 assert.ok(Math.abs(rankVolatility(input,'1.2','1.1')[0].percent!-10)<1e-10);
 assert.equal(rankVolatility(input,'1.3','1.2')[0].percent,-50);assert.deepEqual(input,before);
});
test('the race leader changes with actual snapshot volatility',()=>{
 const input=[sku('a',[['1.1',100],['1.2',140],['1.3',140]]),sku('b',[['1.1',100],['1.2',110],['1.3',55]])];
 const first=rankVolatility(input,'1.2','1.1');const next=rankVolatility(input,'1.3','1.2');
 assert.equal(first[0].id,'a');assert.equal(first[0].percent,40);
 assert.equal(next[0].id,'b');assert.equal(next[0].percent,-50);
 assert.equal(next.find(row=>row.id==='a')?.percent,0);
});
