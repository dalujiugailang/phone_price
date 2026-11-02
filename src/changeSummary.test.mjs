import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSummaryModels, summarizeAmounts, comboDirection } from './changeSummary.ts';
import { buildChangeSummaryReport } from '../server/lib/price-data.mjs';

const sku = (id, model, listPriceDiff, couponDiff) => ({ id, model, storage: id, listPriceDiff, couponDiff });

test('汇总严格大于20元，含小数边界；挂牌与券分别判定', () => {
  for (const value of [-21, -20.01, -20, 0, 20, 20.01, 21]) {
    for (const field of ['listPriceDiff', 'couponDiff']) {
      const rows = buildSummaryModels([{ ...sku('256GB', '边界型号', 0, 0), [field]: value }]);
      assert.equal(rows.length, Math.abs(value) > 20 ? 1 : 0);
    }
  }
  const rows = buildSummaryModels([sku('256GB', '单项型号', 21, 20)]);
  assert.equal(rows[0].category, 'list');
});

test('型号组合优先，跨容量单项变化继续排除；组合方向逐SKU统计', () => {
  const rows = buildSummaryModels([
    sku('12GB+256GB', '型号A', 100, 50), sku('12GB+512GB', '型号A', 100, 0),
    sku('16GB+512GB', '型号A', -100, 50), sku('16GB+1TB', '型号A', -200, -100),
    sku('12GB+1TB', '型号A', 200, -100),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].category, 'mixed');
  assert.equal(rows[0].entries.length, 4);
  assert.deepEqual(new Set(rows[0].entries.map(comboDirection)), new Set(['up-up', 'up-down', 'down-up', 'down-down']));
});

test('同型号同分类合并存储，单项分类各自保留且不虚构组合', () => {
  const rows = buildSummaryModels([
    sku('12GB+256GB', '型号B', 50, 0), sku('16GB+512GB', '型号B', -100, 0),
    sku('16GB+1TB', '型号B', 0, 80),
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows.find(r => r.category === 'list').entries.length, 2);
  assert.equal(rows.find(r => r.category === 'coupon').entries.length, 1);
  assert.equal(rows.some(r => r.category === 'mixed'), false);
});

test('金额范围区分涨跌、保留小数、忽略未达门槛金额', () => {
  assert.deepEqual(summarizeAmounts([-850, -650.5, 20, 50, 300]), [
    { direction: 'down', label: '↓650.5–850' }, { direction: 'up', label: '↑50–300' },
  ]);
  assert.deepEqual(summarizeAmounts([20, -20, 0]), []);
});

test('新型号-SKU视图与既有后端汇总保留相同SKU集合', () => {
  const samples = [sku('a', 'A', 100, 100), sku('b', 'A', 200, 0), sku('c', 'B', -50, 20), sku('d', 'B', 50, 0), sku('e', 'B', 0, -100), sku('f', 'C', 20, 20)];
  const old = buildChangeSummaryReport(samples);
  const oldEntries = [...old.listOnlyUp, ...old.listOnlyDown, ...old.couponOnlyUp, ...old.couponOnlyDown].flatMap(r => r.storages);
  oldEntries.push(...Object.values(old.mixed).flat().flatMap(r => r.entries.map(e => e.storage)));
  assert.deepEqual(buildSummaryModels(samples).flatMap(r => r.entries.map(e => e.storage)).sort(), oldEntries.sort());
});
