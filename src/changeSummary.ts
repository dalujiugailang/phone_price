export const SUMMARY_THRESHOLD = 20;
export type SummaryCategory = 'list' | 'mixed' | 'coupon';
export type ComboDirection = 'up-up' | 'up-down' | 'down-up' | 'down-down';
export interface SummarySku {
  id: string;
  model: string;
  storage: string;
  listPriceDiff: number;
  couponDiff: number;
  finalPriceDiff?: number | null;
}
export interface SummaryModel {
  key: string;
  model: string;
  category: SummaryCategory;
  entries: SummarySku[];
  magnitude: number;
}

export const hasSummaryChange = (value: number) => Number.isFinite(value) && Math.abs(value) > SUMMARY_THRESHOLD;
export const comboDirection = (sku: SummarySku): ComboDirection => `${sku.listPriceDiff > 0 ? 'up' : 'down'}-${sku.couponDiff > 0 ? 'up' : 'down'}`;

// Preserve the existing rule: any qualifying combined SKU gives its model
// priority, and that model's single-component SKUs stay outside this report.
export function buildSummaryModels(skus: SummarySku[]): SummaryModel[] {
  const mixedModels = new Set(skus.filter(s => hasSummaryChange(s.listPriceDiff) && hasSummaryChange(s.couponDiff)).map(s => s.model));
  const groups = new Map<string, SummaryModel>();
  for (const sku of skus) {
    const list = hasSummaryChange(sku.listPriceDiff);
    const coupon = hasSummaryChange(sku.couponDiff);
    if (!list && !coupon) continue;
    if (mixedModels.has(sku.model) && !(list && coupon)) continue;
    const category: SummaryCategory = list && coupon ? 'mixed' : list ? 'list' : 'coupon';
    const key = JSON.stringify([sku.model, category]);
    const group = groups.get(key) ?? { key, model: sku.model, category, entries: [], magnitude: 0 };
    group.entries.push(sku);
    group.magnitude = Math.max(group.magnitude, list ? Math.abs(sku.listPriceDiff) : 0, coupon ? Math.abs(sku.couponDiff) : 0);
    groups.set(key, group);
  }
  return [...groups.values()].map(group => ({ ...group, entries: [...group.entries].sort((a, b) => a.storage.localeCompare(b.storage, 'zh-CN', { numeric: true })) }))
    .sort((a, b) => b.magnitude - a.magnitude || a.model.localeCompare(b.model, 'zh-CN') || a.category.localeCompare(b.category));
}

export function summarizeAmounts(values: number[]) {
  const parts: { direction: 'up' | 'down'; label: string }[] = [];
  for (const direction of ['down', 'up'] as const) {
    const amounts = values.filter(value => hasSummaryChange(value) && (direction === 'up' ? value > 0 : value < 0)).map(Math.abs);
    if (!amounts.length) continue;
    const min = Math.min(...amounts), max = Math.max(...amounts);
    const fmt = (n: number) => n.toLocaleString('zh-CN', { maximumFractionDigits: 2, useGrouping: false });
    parts.push({ direction, label: `${direction === 'up' ? '↑' : '↓'}${fmt(min)}${min === max ? '' : `–${fmt(max)}`}` });
  }
  return parts;
}


export type FinalDirection = 'down' | 'up' | 'flat' | 'missing';
export function finalDirection(sku: SummarySku): FinalDirection {
  const value = sku.finalPriceDiff;
  return value == null || !Number.isFinite(value) ? 'missing' : Math.abs(value) <= SUMMARY_THRESHOLD ? 'flat' : value > 0 ? 'up' : 'down';
}

// The direction report includes every qualifying SKU, including single-component
// siblings of combined SKUs and final-price changes without component changes.
export function buildFinalSummaryModels(skus: SummarySku[]): SummaryModel[] {
  const groups = new Map<string, SummaryModel>();
  for (const sku of skus) {
    const list = hasSummaryChange(sku.listPriceDiff), coupon = hasSummaryChange(sku.couponDiff);
    if (!list && !coupon && !hasSummaryChange(sku.finalPriceDiff ?? 0)) continue;
    const key = sku.model;
    const group = groups.get(key) ?? {key, model: sku.model, category: 'list', entries: [], magnitude: 0};
    group.entries.push(sku);
    group.magnitude = Math.max(group.magnitude, Math.abs(sku.finalPriceDiff ?? 0));
    groups.set(key, group);
  }
  return [...groups.values()].map(group => ({...group, entries: group.entries.sort((a,b) => a.storage.localeCompare(b.storage, 'zh-CN', {numeric:true}))}))
    .sort((a,b) => b.magnitude - a.magnitude || a.model.localeCompare(b.model, 'zh-CN'));
}
