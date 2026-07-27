import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPriceSummary, buildSalesSummary, CHART_SPEC_SCHEMA } from './industry-expert.mjs';

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

test('chart schema accepts a compact chart returned by the agent', () => {
  const chart = CHART_SPEC_SCHEMA.parse({
    type: 'bar',
    title: '品牌新品残值率',
    categories: ['品牌A', '品牌B'],
    series: [{ name: '残值率', values: [92.3, 88.7] }],
    unit: '%',
  });

  assert.equal(chart.type, 'bar');
  assert.deepEqual(chart.series[0].values, [92.3, 88.7]);
});
