import test from 'node:test';
import assert from 'node:assert/strict';
import {extractStorageVariants, isKnownStorage} from '../scripts/lib/jd-storage.mjs';
test('excludes longer models and non-phone search hits', () => {
  assert.deepEqual(extractStorageVariants('一加 Turbo 6','一加Turbo 6X Pro 8GB+256GB 跃马黑'), []);
  assert.deepEqual(extractStorageVariants('荣耀 WIN','荣耀WIN游戏本 H9 16GB 1TB 笔记本电脑'), []);
  assert.deepEqual(extractStorageVariants('小米 17','小米 17 Pro Max 16GB+512GB 手机'), []);
});
test('reads full and shorthand memory without absorbing the model or 5G network', () => {
  assert.deepEqual(extractStorageVariants('小米 17 Max','小米 17 Max 白色 16GB+256GB 5G手机'), ['16GB+256GB']);
  assert.deepEqual(extractStorageVariants('REDMI Note 17','小米 REDMI Note 17 6+128 黑 手机'), ['6GB+128GB']);
  assert.deepEqual(extractStorageVariants('一加 15','一加 15 16+512 5G 手机'), ['16GB+512GB']);
});
test('does not invent RAM or duplicate a ROM-only evidence match', () => {
  assert.deepEqual(extractStorageVariants('华为 nova 15','华为 nova 15 512GB 幻夜黑'), ['512GB']);
  assert.equal(isKnownStorage('256GB',['12G+256G']),true);
  assert.equal(isKnownStorage('512GB',['12G+256G']),false);
});
test('rejects mixed capacities', () => {
  assert.deepEqual(extractStorageVariants('小米 17','小米 17 12GB+256GB / 16GB+512GB'), []);
});
test('normalizes 1024GB without inventing another variant', () => {
  assert.equal(isKnownStorage('16GB+1024GB',['16G+1T']),true);
  assert.deepEqual(extractStorageVariants('一加 Turbo 6','一加Turbo 6V 12GB+512GB 白色'),[]);
});
test('permits marketing text and edition labels after the actual model', () => {
  assert.deepEqual(extractStorageVariants('三星 Galaxy S26','三星Galaxy S26 AI手机 12+256GB 旷宇黑'),['12GB+256GB']);
  assert.deepEqual(extractStorageVariants('华为 Mate XTs 非凡大师','HUAWEI Mate XTs【24期免息】 非凡大师 皓白16GB+256GB 华为手机'),['16GB+256GB']);
});
test('discovery requires the exact brand self-operated store and special edition', async () => {
  const {isAllowedJdOffer}=await import('../scripts/lib/jd-storage.mjs');
  const offer={title:'一加 Turbo 6 12GB+256GB 手机',shopName:'一加手机京东自营旗舰店',sourceType:2,shopType:1};
  assert.equal(isAllowedJdOffer('一加 Turbo 6','一加',offer),true);
  assert.equal(isAllowedJdOffer('一加 Turbo 6','一加',{...offer,shopName:'OPPO京东自营旗舰店'}),false);
  assert.equal(isAllowedJdOffer('一加 Turbo 6 至尊版','一加',offer),false);
});
