import test from 'node:test';import assert from 'node:assert/strict';
import {resolveVerifiedRomOnlySpec as resolve} from '../server/lib/verified-rom-matching.mjs';
const sku=(model,storage)=>({model,storage});
test('RAM omitted from a known single-RAM nova title can be resolved by official identity',()=>{
  const row=sku('华为 nova 15','12G+256G');assert.equal(resolve(row,'华为 nova 15 256GB 幻夜黑',[row])?.ram,12);
  assert.equal(resolve(sku('华为 nova 15','8GB+256GB'),'华为 nova 15 256GB 幻夜黑',[row]),null);
});
test('generic nova Pro 256GB remains ambiguous between glass editions',()=>{
  const row=sku('华为 nova 15 Pro','12GB+256GB');assert.equal(resolve(row,'华为 nova 15 Pro 256GB 幻夜黑',[row]),null);
});
test('the unique Pro 512GB glass edition is backed by the official quick guide',()=>{
  const row=sku('华为 nova 15 Pro','12GB+512GB 昆仑玻璃版');assert.equal(resolve(row,'华为 nova 15 Pro 512GB 零度白',[row])?.glass,'昆仑玻璃');
});
test('Ultra 1TB keeps the correct strengthened glass identity',()=>{
  const row=sku('华为 nova 15 Ultra','12GB+1TB 玄武钢化昆仑玻璃版');assert.equal(resolve(row,'华为 nova 15 Ultra 1TB 幻夜黑',[row])?.glass,'玄武钢化昆仑玻璃');
});
test('explicit RAM and conflicting ROMs never use the fallback',()=>{
  const row=sku('华为 nova 15','12GB+256GB');
  for(const title of ['华为 nova 15 8GB+256GB','华为 nova 15 12GB+256GB','华为 nova 15 512GB','华为 nova 15 256GB/512GB','华为 nova 15 8GB RAM 256GB ROM'])assert.equal(resolve(row,title,[row]),null);
});
test('another RAM or edition in the same model/ROM makes the title ambiguous',()=>{
  const row=sku('华为 nova 15','12GB+256GB');assert.equal(resolve(row,'华为 nova 15 256GB',[row,sku(row.model,'16GB+256GB')]),null);
});
test('longer models and non-supported models cannot inherit the rule',()=>{
  const row=sku('华为 nova 15','12GB+256GB');assert.equal(resolve(row,'华为 nova 15 Pro 256GB',[row]),null);
  const other=sku('华为 Mate 90','12GB+256GB');assert.equal(resolve(other,'华为 Mate 90 256GB',[other]),null);
});
test('explicit glass conflict is rejected',()=>{
  const row=sku('华为 nova 15 Pro','12GB+512GB 昆仑玻璃版');assert.equal(resolve(row,'华为 nova 15 Pro 512GB 铝硅玻璃',[row]),null);
});
