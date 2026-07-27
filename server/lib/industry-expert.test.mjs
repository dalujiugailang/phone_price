import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPriceSummary, buildSalesSummary, EXPERT_OUTPUT_SCHEMA } from './industry-expert.mjs';

test('price summary keeps the existing high-risk and 95% risk thresholds', () => {
  const dataset = {
    sourceName: 'test',
    dates: ['7.01'],
    brands: ['测试品牌'],
    loadedAt: new Date().toISOString(),
    skus: [
      {
        id: 'a',
        brand: '测试品牌',
        model: '测试A',
        series: '',
        storage: '256G',
        position: '高端',
        ppv: 'a',
        launchPrice: 1000,
        snapshots: [{ date: '7.01', listPrice: 900, coupon: 0, finalPrice: 900, biPrice: 900 }],
      },
      {
        id: 'b',
        brand: '测试品牌',
        model: '测试B',
        series: '',
        storage: '256G',
        position: '高端',
        ppv: 'b',
        launchPrice: 1000,
        snapshots: [{ date: '7.01', listPrice: 900, coupon: 0, finalPrice: 900, biPrice: 855 }],
      },
    ],
  };

  const summary = buildPriceSummary(dataset);
  assert.equal(summary.highRiskCount, 1);
  assert.equal(summary.riskCount, 1);
  assert.equal(summary.brandNewProductResiduals[0].medianResidualPct, 90);
});

test('sales summary uses the latest four available weeks and ranks within position', () => {
  const weeks = ['W24', 'W25', 'W26', 'W27', 'W28'];
  const overview = {
    summary: { year: 2026, latestWeek: 'W28' },
    filters: { weeks },
    weeklyRows: [
      ...weeks.map((week, index) => ({
        standardModelName: '测试A',
        brand: '测试品牌',
        seriesPosition: '高端',
        weekLabel: week,
        weeklySales: index + 1,
      })),
      ...weeks.map((week) => ({
        standardModelName: '测试B',
        brand: '测试品牌',
        seriesPosition: '高端',
        weekLabel: week,
        weeklySales: 1,
      })),
    ],
  };

  const summary = buildSalesSummary(overview);
  assert.deepEqual(summary.windowWeeks, ['W25', 'W26', 'W27', 'W28']);
  assert.equal(summary.topModels[0].model, '测试A');
  assert.equal(summary.topModels[0].fourWeekSales, 14);
  assert.equal(summary.topModels[0].positionRank, 1);
});

test('expert output keeps facts, inferences, actions and caveats separated', () => {
  const output = EXPERT_OUTPUT_SCHEMA.parse({
    title: '防高收分析',
    conclusion: '先核查高风险SKU。',
    facts: [{ label: '高风险SKU', value: '2个', dataDate: '7.24', source: '价格底表' }],
    inferences: ['风险主要集中在高残值型号。'],
    actions: [{ priority: '高', action: '复核BI价', reason: 'BI价接近新品价' }],
    evidenceSummary: ['调用价格与残值工具'],
    caveats: ['新品价仍是国补后价格试算口径'],
  });

  assert.equal(output.actions[0].priority, '高');
  assert.equal(output.facts[0].source, '价格底表');
});
