import * as XLSX from 'xlsx';
import type { SKUData } from './data';

interface DetailExportSKU extends SKUData {
  reasonDetails: string[];
  listPriceDiff: number;
  couponDiff: number;
}

/** Export the same filtered SKUs and date window as the detail table. */
export function buildDetailWorkbook(
  skus: DetailExportSKU[],
  dates: string[],
  couponIsKnown: (skuId: string, date: string) => boolean,
) {
  const dimensions = ['型号', '品牌', '存储版本', '机型定位', 'PPV', '型号系列', '发售价'];
  const summaryRows: (string | number)[][] = [
    [...dimensions, ...dates.flatMap(date => [date, '', '']), '最新归因', '最新挂牌价变动', '最新优惠券变动'],
    [...dimensions.map(() => ''), ...dates.flatMap(() => ['国补后', '挂牌价', '优惠券']), '', '', ''],
  ];
  const detailRows: (string | number)[][] = [
    ['SKU ID', '日期', ...dimensions, '国补后', '挂牌价', '优惠券', '报价状态', '最新归因'],
  ];

  for (const sku of skus) {
    const metadata = [sku.model, sku.brand, sku.storage, sku.position, sku.ppv, sku.series, sku.launchPrice || ''];
    const snapshots = new Map(sku.snapshots.map(snapshot => [snapshot.date, snapshot]));
    const attribution = sku.reasonDetails.join('；');
    const prices = dates.flatMap(date => {
      const snapshot = snapshots.get(date);
      const values = snapshot
        ? [snapshot.finalPrice, snapshot.listPrice, couponIsKnown(sku.id, date) ? snapshot.coupon : '']
        : ['', '', ''];
      detailRows.push([
        sku.id, date, ...metadata, ...values,
        snapshot ? (snapshot.isDelisted ? '已下架' : '有报价') : '缺失', attribution,
      ]);
      return values;
    });
    summaryRows.push([...metadata, ...prices, attribution, sku.listPriceDiff, sku.couponDiff]);
  }

  const summary = XLSX.utils.aoa_to_sheet(summaryRows);
  summary['!merges'] = [
    ...dimensions.map((_, c) => ({ s: { r: 0, c }, e: { r: 1, c } })),
    ...dates.map((_, i) => ({ s: { r: 0, c: dimensions.length + i * 3 }, e: { r: 0, c: dimensions.length + i * 3 + 2 } })),
    ...[0, 1, 2].map(i => ({ s: { r: 0, c: dimensions.length + dates.length * 3 + i }, e: { r: 1, c: dimensions.length + dates.length * 3 + i } })),
  ];
  summary['!cols'] = [24, 12, 18, 16, 24, 24, 14, ...dates.flatMap(() => [14, 14, 14]), 42, 20, 20].map(wch => ({ wch }));
  summary['!rows'] = [{ hpt: 25 }, { hpt: 22 }];

  const detail = XLSX.utils.aoa_to_sheet(detailRows);
  detail['!cols'] = [32, 16, 24, 12, 18, 16, 24, 24, 14, 14, 14, 14, 12, 42].map(wch => ({ wch }));
  detail['!autofilter'] = { ref: detail['!ref']! };
  // Numeric cells remain usable for sorting and pivot tables.
  for (const sheet of [summary, detail]) {
    for (const [address, cell] of Object.entries(sheet)) {
      if (!address.startsWith('!') && cell.t === 'n') cell.z = '#,##0.##';
    }
  }
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, summary, '汇总');
  XLSX.utils.book_append_sheet(workbook, detail, '数仓类明细');
  return workbook;
}
