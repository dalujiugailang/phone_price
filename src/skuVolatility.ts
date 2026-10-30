import type { PriceSnapshot } from './data';

export interface VolatilitySKU {
  id: string;
  brand: string;
  model: string;
  storage: string;
  snapshots: PriceSnapshot[];
  reasonDetails: string[];
}

export function rankVolatility(skus: VolatilitySKU[], date: string, previousDate?: string) {
  return skus.map(sku => {
    const current = sku.snapshots.find(point => point.date === date);
    const previous = sku.snapshots.find(point => point.date === previousDate);
    const comparable = !!current && !!previous && Number.isFinite(current.finalPrice) && current.finalPrice > 0 && Number.isFinite(previous.finalPrice) && previous.finalPrice > 0;
    const amount = comparable ? current.finalPrice - previous.finalPrice : null;
    const percent = amount !== null ? amount / previous!.finalPrice * 100 : null;
    return { ...sku, current, previous, amount, percent, comparable };
  }).sort((a, b) => Number(b.comparable) - Number(a.comparable)
    || Math.abs(b.percent ?? 0) - Math.abs(a.percent ?? 0)
    || Math.abs(b.amount ?? 0) - Math.abs(a.amount ?? 0)
    || a.id.localeCompare(b.id));
}
