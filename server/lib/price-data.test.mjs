import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAnalysis } from './price-data.mjs';

test('概览聚合将已下架价格按 0 价处理并沿用上一有效价格', () => {
  const analysis = buildAnalysis({
    dates: ['7.01', '7.02'],
    skus: [
      {
        id: '测试机型-256GB',
        brand: '测试品牌',
        model: '测试机型',
        series: '测试系列',
        storage: '256GB',
        position: '测试定位',
        launchPrice: 1200,
        snapshots: [
          { date: '7.01', finalPrice: 1000, listPrice: 1100, coupon: 100 },
          { date: '7.02', finalPrice: 0, listPrice: 0, coupon: 0, isDelisted: true },
        ],
      },
    ],
  });

  assert.deepEqual(analysis.seriesAnalysis[0].snapshotAvgs, [
    { date: '7.01', avgPrice: 1000 },
    { date: '7.02', avgPrice: 1000 },
  ]);
  assert.equal(analysis.seriesAnalysis[0].diff, 0);
  assert.equal(analysis.positionAnalysis[0].skuCount, 1);
});

test('新增 SKU 缺少发售价时，不以零价拉低发售均价或虚构发布趋势点', () => {
  const base={brand:'测试',series:'测试',storage:'12GB+256GB',position:'旗舰'};
  const analysis=buildAnalysis({dates:['10.27'],skus:[
    {...base,id:'known',model:'已知发售价',launchPrice:1000,snapshots:[{date:'10.27',finalPrice:900,listPrice:1000,coupon:0}]},
    {...base,id:'unknown',model:'未知发售价',launchPrice:0,snapshots:[{date:'10.27',finalPrice:2000,listPrice:2500,coupon:0}]},
  ]});
  assert.equal(analysis.positionAnalysis[0].avgLaunch,1000);
  assert.equal(analysis.skuList.find(r=>r.id==='unknown').totalChange,0);
  assert.ok(!analysis.seriesAnalysis.find(r=>r.model==='未知发售价').trendData.some(p=>p.date==='发布'));
});
