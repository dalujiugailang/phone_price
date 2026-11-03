import * as XLSX from 'xlsx';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const dir = new URL('./', import.meta.url);
const file = new URL('downloads/新机售价明细_11.02.xlsx', dir);
const [label, skuCount, dateCount] = process.argv.slice(2);
const wb = XLSX.read(fs.readFileSync(file), { type: 'buffer' });
assert.deepEqual(wb.SheetNames, ['汇总', '数仓类明细']);
const wide = XLSX.utils.sheet_to_json(wb.Sheets['汇总'], { header: 1, defval: '' });
const long = XLSX.utils.sheet_to_json(wb.Sheets['数仓类明细'], { header: 1, defval: '' });
const count = Number(dateCount);
assert.equal(wide.length - 2, Number(skuCount));
assert.equal(long.length - 1, Number(skuCount) * count);
for (let i = 2; i < wide.length; i++) for (let d = 0; d < count; d++) {
  const row = long[1 + (i - 2) * count + d];
  assert.equal(wide[0][7 + d * 3], row[1]);
  assert.deepEqual(wide[i].slice(0, 7), row.slice(2, 9));
  assert.deepEqual(wide[i].slice(7 + d * 3, 10 + d * 3), row.slice(9, 12));
}
const report = {
  sheetNames: wb.SheetNames, skuRows: wide.length - 2, dateCount: count,
  detailRows: long.length - 1, firstDate: long[1][1], lastDate: long.at(-1)[1],
  brands: [...new Set(long.slice(1).map(r => r[3]))],
  models: [...new Set(long.slice(1).map(r => r[2]))],
  zeroCoupons: long.slice(1).filter(r => r[11] === 0).length,
  missingCoupons: long.slice(1).filter(r => r[11] === '').length,
  wideLongReconcile: true,
};
fs.writeFileSync(new URL(label + '-verification.json', dir), JSON.stringify(report, null, 2));
fs.renameSync(file, new URL('downloads/' + label + '.xlsx', dir));
console.log(JSON.stringify(report));
