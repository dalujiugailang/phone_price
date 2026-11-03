import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { buildDetailWorkbook } from './detailExport.ts';

test('明细导出往返读取后保持日期顺序、两层表头、数值零和缺失值', () => {
  const sku = {
    id: 'sku-1', model: '测试机型', brand: '测试品牌', storage: '256GB',
    position: '旗舰', ppv: '00123', series: '测试系列', launchPrice: 3999,
    reasonDetails: ['挂牌价下降'], listPriceDiff: -100, couponDiff: 0,
    snapshots: [
      { date: '10.29', finalPrice: 2800, listPrice: 3299, coupon: 0 },
      { date: '10.30', finalPrice: 2700, listPrice: 3199, coupon: 0 },
    ],
  };
  const workbook = buildDetailWorkbook([sku], ['10.30', '10.29', '10.28'], (_, date) => date === '10.30');
  const restored = XLSX.read(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' });
  assert.deepEqual(restored.SheetNames, ['汇总', '数仓类明细']);
  const summary = XLSX.utils.sheet_to_json(restored.Sheets['汇总'], { header: 1, defval: '' });
  const detail = XLSX.utils.sheet_to_json(restored.Sheets['数仓类明细'], { header: 1, defval: '' });
  assert.equal(summary.length, 3);
  assert.deepEqual(summary[0].slice(7, 16), ['10.30', '', '', '10.29', '', '', '10.28', '', '']);
  assert.deepEqual(summary[2].slice(7, 16), [2700, 3199, 0, 2800, 3299, '', '', '', '']);
  assert.equal(detail.length, 4);
  assert.deepEqual(detail.slice(1).map(row => row[1]), ['10.30', '10.29', '10.28']);
  assert.equal(detail[1][6], '00123');
  assert.deepEqual(detail.slice(1).map(row => row[11]), [0, '', '']);
  assert.equal(detail[3][12], '缺失');
  assert.equal(restored.Sheets['数仓类明细']['!autofilter'].ref, 'A1:N4');
  assert.equal(restored.Sheets['汇总']['!merges'].length, 13);
});
