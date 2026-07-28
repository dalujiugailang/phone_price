import assert from 'node:assert/strict';
import test from 'node:test';
import { CHART_SPEC_SCHEMA } from './industry-expert.mjs';

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
