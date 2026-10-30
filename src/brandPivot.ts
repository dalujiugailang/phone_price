import type { SKUData } from './data';

// Callers supply the same carried-forward snapshots used by the other summary tables.
export function buildBrandPivot(skus: SKUData[], dates: string[]) {
  const latestDate = dates.at(-1);
  const previousDate = dates.at(-2);
  const groups = new Map<string, SKUData[]>();
  for (const sku of skus) {
    if (!sku.snapshots.some(point => point.date === latestDate && point.finalPrice > 0)) continue;
    const brand = sku.brand || '未知品牌';
    const members = groups.get(brand) ?? [];
    members.push(sku);
    groups.set(brand, members);
  }
  const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  return [...groups].map(([brand, members]) => {
    const avgLaunch = average(members.map(sku => sku.launchPrice).filter(price => price > 0));
    const snapshotAvgs = dates.flatMap(date => {
      const prices = members.flatMap(sku => sku.snapshots.filter(point => point.date === date && point.finalPrice > 0).map(point => point.finalPrice));
      return prices.length ? [{ date, avgPrice: average(prices) }] : [];
    });
    const latest = snapshotAvgs.find(point => point.date === latestDate);
    const previous = snapshotAvgs.find(point => point.date === previousDate);
    const diff = latest && previous ? latest.avgPrice - previous.avgPrice : 0;
    const diffPct = previous?.avgPrice ? diff / previous.avgPrice * 100 : 0;
    const directionSummary = { up: 0, down: 0, flat: 0 };
    for (const sku of members) {
      const latest = sku.snapshots.find(point => point.date === latestDate);
      const previous = sku.snapshots.find(point => point.date === previousDate);
      const change = latest && previous ? latest.finalPrice - previous.finalPrice : 0;
      directionSummary[change > 0 ? 'up' : change < 0 ? 'down' : 'flat']++;
    }
    return { brand, skuCount: members.length, avgLaunch, snapshotAvgs, diff, diffPct,
      trendData: [...(avgLaunch > 0 ? [{ date: '发布', avgPrice: avgLaunch }] : []), ...snapshotAvgs], directionSummary };
  }).sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff) || a.brand.localeCompare(b.brand, 'zh-Hans-CN'));
}
