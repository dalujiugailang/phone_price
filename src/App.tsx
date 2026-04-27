import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Database,
  FileText,
  Info,
  LayoutDashboard,
  Minus,
  Search,
  Table as TableIcon,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { loadWorkbookData, PriceSnapshot, SKUData, WorkbookDataset } from './data';

type ViewMode = 'dashboard' | 'summary' | 'table' | 'raw';

interface AnalysisSKU extends SKUData {
  totalChange: number;
  recentChange: number;
  recentChangePct: number;
  listPriceDiff: number;
  couponDiff: number;
  changeDirection: 'up' | 'down' | 'flat';
  reason: string;
  reasonDetails: string[];
}

interface BrandAnalysisItem {
  name: string;
  avgRecentChangePct: number;
}

interface SeriesPoint {
  date: string;
  avgPrice: number;
}

interface SeriesAnalysisItem {
  model: string;
  brand: string;
  avgLaunch: number;
  snapshotAvgs: SeriesPoint[];
  diff: number;
  diffPct: number;
  trendData: SeriesPoint[];
  directionSummary: {
    up: number;
    down: number;
    flat: number;
  };
}

interface AnalysisResult {
  skuList: AnalysisSKU[];
  brandAnalysis: BrandAnalysisItem[];
  seriesAnalysis: SeriesAnalysisItem[];
}

interface ChangeSummaryRangeItem {
  model: string;
  storages: string[];
  amounts: number[];
}

interface ChangeSummaryMixedItem {
  model: string;
  entries: Array<{
    storage: string;
    listPriceDiff: number;
    couponDiff: number;
  }>;
}

interface ChangeSummaryReport {
  listOnlyUp: ChangeSummaryRangeItem[];
  listOnlyDown: ChangeSummaryRangeItem[];
  mixed: {
    listUpCouponUp: ChangeSummaryMixedItem[];
    listUpCouponDown: ChangeSummaryMixedItem[];
    listDownCouponUp: ChangeSummaryMixedItem[];
    listDownCouponDown: ChangeSummaryMixedItem[];
  };
  couponOnlyDown: ChangeSummaryRangeItem[];
  couponOnlyUp: ChangeSummaryRangeItem[];
}

interface RawEditorRow {
  id: string;
  model: string;
  storage: string;
  launchPrice: string;
  snapshots: Record<
    string,
    {
      finalPrice: string;
      listPrice: string;
      coupon: string;
    }
  >;
}

interface RawEditorDraft {
  dates: string[];
  rows: RawEditorRow[];
  savedAt: string;
}

type RawEditorColumnKey =
  | 'model'
  | 'storage'
  | 'launchPrice'
  | `${string}::finalPrice`
  | `${string}::listPrice`
  | `${string}::coupon`;

const EMPTY_ANALYSIS: AnalysisResult = {
  skuList: [],
  brandAnalysis: [],
  seriesAnalysis: [],
};

const formatPrice = (price: number) => `¥${Math.round(price).toLocaleString()}`;
const formatCoupon = (coupon: number) => (coupon > 0 ? `¥${Math.round(coupon).toLocaleString()}` : '--');
const formatSignedPercent = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
const isZeroChange = (value: number) => Math.abs(value) < 0.0001;
const SERIES_PIVOT_IGNORE_AMOUNT = 10;
const KNOWN_BRANDS = ['REDMI', 'iQOO', 'OPPO', 'vivo', '华为', '荣耀', '一加', '小米'];
const RAW_DRAFT_AUTOSAVE_MS = 1200;
const LIST_PRICE_ATTRIBUTION_IGNORE_DIFF = 1;

function sortDateLabels(left: string, right: string) {
  const [leftMonth, leftDay] = left.split('.').map(Number);
  const [rightMonth, rightDay] = right.split('.').map(Number);
  return leftMonth === rightMonth ? leftDay - rightDay : leftMonth - rightMonth;
}

function compareDateLabels(left: string, right: string) {
  return sortDateLabels(left, right);
}

function parseNumericInput(value: string) {
  const normalized = value.replace(/,/g, '').trim();
  if (!normalized) {
    return 0;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeDateLabelInput(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  let matched = trimmed.match(/^(\d{1,2})\.(\d{1,2})$/);
  if (matched) {
    return `${Number(matched[1])}.${matched[2].padStart(2, '0')}`;
  }

  matched = trimmed.match(/^(\d{2})(\d{2})$/);
  if (matched) {
    return `${Number(matched[1])}.${matched[2].padStart(2, '0')}`;
  }

  return null;
}

function normalizeListPriceDiffForAttribution(value: number) {
  return Math.abs(value) <= LIST_PRICE_ATTRIBUTION_IGNORE_DIFF ? 0 : value;
}

async function loadRawEditorDraftFromApi(): Promise<RawEditorDraft | null> {
  try {
    const response = await fetch('/api/raw-editor-draft');
    if (!response.ok) {
      return null;
    }

    const parsed = await response.json();
    if (!parsed || !Array.isArray(parsed.dates) || !Array.isArray(parsed.rows)) {
      return null;
    }

    return {
      dates: parsed.dates.filter((item: unknown): item is string => typeof item === 'string'),
      rows: parsed.rows.filter((item: unknown): item is RawEditorRow => Boolean(item && typeof item === 'object')),
      savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : '',
    };
  } catch {
    return null;
  }
}

async function persistRawEditorDraft(draft: RawEditorDraft) {
  const response = await fetch('/api/raw-editor-draft', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(draft),
  });

  if (!response.ok) {
    throw new Error('Failed to persist raw editor draft');
  }
}

function inferBrand(modelName: string) {
  const matchedBrand = KNOWN_BRANDS.find((brand) => modelName.startsWith(brand));
  if (matchedBrand) {
    return matchedBrand;
  }

  const [firstToken] = modelName.split(/\s+/);
  return firstToken || modelName;
}

function inferSeries(modelName: string, brand: string) {
  const remainder = modelName.startsWith(brand) ? modelName.slice(brand.length).trim() : modelName;
  const [firstToken = remainder || modelName] = remainder.split(/\s+/);
  const seriesSeed = firstToken.match(/^[A-Za-z\u4e00-\u9fa5]+/)?.[0] ?? firstToken;

  if (!seriesSeed) {
    return '其他系列';
  }

  if (/^\d/.test(seriesSeed)) {
    return '数字系列';
  }

  return `${seriesSeed}系列`;
}

function sortByChangePriority<T>(items: T[], getValue: (item: T) => number) {
  return [...items].sort((left, right) => {
    const leftValue = getValue(left);
    const rightValue = getValue(right);
    const leftIsZero = isZeroChange(leftValue);
    const rightIsZero = isZeroChange(rightValue);

    if (leftIsZero !== rightIsZero) {
      return leftIsZero ? 1 : -1;
    }

    const magnitudeDiff = Math.abs(rightValue) - Math.abs(leftValue);
    if (magnitudeDiff !== 0) {
      return magnitudeDiff;
    }

    return rightValue - leftValue;
  });
}

function isSeriesPivotChanged(series: SeriesAnalysisItem) {
  return Math.abs(series.diff) > SERIES_PIVOT_IGNORE_AMOUNT;
}

function getSeriesPivotDisplayChange(series: SeriesAnalysisItem) {
  if (!isSeriesPivotChanged(series)) {
    return {
      diff: 0,
      diffPct: 0,
    };
  }

  return {
    diff: series.diff,
    diffPct: series.diffPct,
  };
}

function sortSeriesPivotRows(items: SeriesAnalysisItem[]) {
  return [...items].sort((left, right) => {
    const leftHasChange = isSeriesPivotChanged(left);
    const rightHasChange = isSeriesPivotChanged(right);

    if (leftHasChange !== rightHasChange) {
      return leftHasChange ? -1 : 1;
    }

    const brandDiff = compareText(left.brand, right.brand);
    if (brandDiff !== 0) {
      return brandDiff;
    }

    const magnitudeDiff = Math.abs(right.diff) - Math.abs(left.diff);
    if (magnitudeDiff !== 0) {
      return magnitudeDiff;
    }

    const directionDiff = right.diff - left.diff;
    if (directionDiff !== 0) {
      return directionDiff;
    }

    return compareText(left.model, right.model);
  });
}

function compareText(left: string, right: string) {
  return left.localeCompare(right, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
}

const BRAND_COLOR_TONES = [
  {
    row: 'bg-orange-50/35 hover:bg-orange-50/70',
    sticky: 'bg-orange-50',
    chip: 'bg-orange-100 text-orange-700 ring-orange-200',
    bar: 'bg-orange-400',
  },
  {
    row: 'bg-sky-50/35 hover:bg-sky-50/70',
    sticky: 'bg-sky-50',
    chip: 'bg-sky-100 text-sky-700 ring-sky-200',
    bar: 'bg-sky-400',
  },
  {
    row: 'bg-emerald-50/35 hover:bg-emerald-50/70',
    sticky: 'bg-emerald-50',
    chip: 'bg-emerald-100 text-emerald-700 ring-emerald-200',
    bar: 'bg-emerald-400',
  },
  {
    row: 'bg-violet-50/35 hover:bg-violet-50/70',
    sticky: 'bg-violet-50',
    chip: 'bg-violet-100 text-violet-700 ring-violet-200',
    bar: 'bg-violet-400',
  },
  {
    row: 'bg-rose-50/35 hover:bg-rose-50/70',
    sticky: 'bg-rose-50',
    chip: 'bg-rose-100 text-rose-700 ring-rose-200',
    bar: 'bg-rose-400',
  },
  {
    row: 'bg-amber-50/35 hover:bg-amber-50/70',
    sticky: 'bg-amber-50',
    chip: 'bg-amber-100 text-amber-700 ring-amber-200',
    bar: 'bg-amber-400',
  },
  {
    row: 'bg-cyan-50/35 hover:bg-cyan-50/70',
    sticky: 'bg-cyan-50',
    chip: 'bg-cyan-100 text-cyan-700 ring-cyan-200',
    bar: 'bg-cyan-400',
  },
  {
    row: 'bg-lime-50/35 hover:bg-lime-50/70',
    sticky: 'bg-lime-50',
    chip: 'bg-lime-100 text-lime-700 ring-lime-200',
    bar: 'bg-lime-400',
  },
];

function getBrandTone(brand: string, brandIndexMap: Map<string, number>) {
  const index = brandIndexMap.get(brand) ?? 0;
  return BRAND_COLOR_TONES[index % BRAND_COLOR_TONES.length];
}

function getChangeStroke(value: number) {
  if (isZeroChange(value)) {
    return '#9CA3AF';
  }

  return value > 0 ? '#EA580C' : '#2563EB';
}

function getChangeTextClass(value: number) {
  if (isZeroChange(value)) {
    return 'text-gray-500';
  }

  return value > 0 ? 'text-orange-600' : 'text-blue-600';
}

function getChangeBadgeClass(value: number) {
  if (isZeroChange(value)) {
    return 'bg-gray-100 text-gray-500';
  }

  return value > 0 ? 'bg-orange-50 text-orange-600' : 'bg-blue-50 text-blue-600';
}

function getAttributionTagClass(detail: string) {
  if (detail.includes('升高')) {
    return 'bg-orange-50 text-orange-600';
  }

  if (detail.includes('降低')) {
    return 'bg-blue-50 text-blue-600';
  }

  return 'bg-gray-100 text-gray-600';
}

function BrandBarValueLabel(props: {
  height?: number;
  value?: number | string;
  width?: number;
  x?: number;
  y?: number;
}) {
  const value = Number(props.value ?? 0);
  const x = Number(props.x ?? 0);
  const y = Number(props.y ?? 0);
  const width = Number(props.width ?? 0);
  const height = Number(props.height ?? 0);

  return (
    <text
      x={x + width + 10}
      y={y + height / 2}
      dominantBaseline="middle"
      fill={isZeroChange(value) ? '#6B7280' : value > 0 ? '#C2410C' : '#1D4ED8'}
      fontSize={12}
      fontWeight={700}
    >
      {formatSignedPercent(value)}
    </text>
  );
}

function buildAttribution(listPriceDiff: number, couponDiff: number, recentChange: number, snapshotCount: number) {
  if (snapshotCount < 2) {
    return {
      changeDirection: 'flat' as const,
      reason: '暂无对比',
      reasonDetails: ['至少需要两个监测日期'],
    };
  }

  if (listPriceDiff === 0 && couponDiff === 0) {
    return {
      changeDirection: 'flat' as const,
      reason: '持平',
      reasonDetails: ['挂牌价与优惠券均持平'],
    };
  }

  const reasonDetails: string[] = [];
  if (listPriceDiff !== 0) {
    reasonDetails.push(`挂牌价${listPriceDiff > 0 ? '升高' : '降低'}`);
  }
  if (couponDiff !== 0) {
    reasonDetails.push(`优惠券${couponDiff > 0 ? '升高' : '降低'}`);
  }

  if (recentChange > 0) {
    return {
      changeDirection: 'up' as const,
      reason: '上涨',
      reasonDetails: reasonDetails.length > 0 ? reasonDetails : ['综合因素导致上涨'],
    };
  }

  if (recentChange < 0) {
    return {
      changeDirection: 'down' as const,
      reason: '下跌',
      reasonDetails: reasonDetails.length > 0 ? reasonDetails : ['综合因素导致下跌'],
    };
  }

  return {
    changeDirection: 'flat' as const,
    reason: '持平',
    reasonDetails: reasonDetails.length > 0 ? reasonDetails : ['价格变动相互抵消'],
  };
}

function MiniTrendChart({ points }: { points: PriceSnapshot[] }) {
  if (points.length === 0) {
    return <div className="h-16 w-full rounded-xl" />;
  }

  const values = points.map((point) => point.finalPrice);
  const maxValue = Math.max(...values);
  const minValue = Math.min(...values);
  const range = maxValue - minValue;
  const leftAxisX = 12;
  const rightEdge = 118;
  const topY = 8;
  const bottomY = 48;
  const flatY = 26;

  const svgPoints = points.map((point, index) => {
    const x = leftAxisX + (index * (rightEdge - leftAxisX)) / Math.max(points.length - 1, 1);
    const y = range === 0 ? flatY : topY + ((maxValue - point.finalPrice) / range) * (bottomY - topY - 6);
    const dotFill = point.finalPrice < values[0] ? '#2563EB' : '#C2410C';
    return { x, y, dotFill, key: `${point.date}-${index}` };
  });

  const path = svgPoints.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');

  return (
    <div className="rounded-xl px-2 py-1.5">
      <svg viewBox="0 0 128 56" className="h-16 w-full overflow-visible">
        <line x1={leftAxisX} y1={6} x2={leftAxisX} y2={bottomY} stroke="#D6D9DD" strokeWidth="1.5" />
        <line x1={leftAxisX} y1={bottomY} x2={rightEdge} y2={bottomY} stroke="#E7E2D7" strokeWidth="1" />
        <path d={path} fill="none" stroke="#C85A11" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
        {svgPoints.map((point) => (
          <circle key={point.key} cx={point.x} cy={point.y} r="3.2" fill={point.dotFill} stroke="#FFFFFF" strokeWidth="1.2" />
        ))}
      </svg>
    </div>
  );
}

function SeriesTrendChart({ points, diffPct }: { points: SeriesPoint[]; diffPct: number }) {
  if (points.length === 0) {
    return <div className="h-20 w-full rounded-xl" />;
  }

  const values = points.map((point) => point.avgPrice);
  const maxValue = Math.max(...values);
  const minValue = Math.min(...values);
  const range = maxValue - minValue;
  const leftAxisX = 14;
  const rightEdge = 154;
  const topY = 10;
  const bottomY = 62;
  const flatY = 36;

  const svgPoints = points.map((point, index) => {
    const x = leftAxisX + (index * (rightEdge - leftAxisX)) / Math.max(points.length - 1, 1);
    const y = range === 0 ? flatY : topY + ((maxValue - point.avgPrice) / range) * (bottomY - topY - 6);

    return { x, y, key: `${point.date}-${index}` };
  });

  const path = svgPoints.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
  const stroke = getChangeStroke(diffPct);

  return (
    <div className="rounded-xl px-2 py-1.5">
      <svg viewBox="0 0 168 72" className="h-20 w-full overflow-visible">
        <line x1={leftAxisX} y1={6} x2={leftAxisX} y2={bottomY} stroke="#D6D9DD" strokeWidth="1.5" />
        <line x1={leftAxisX} y1={bottomY} x2={rightEdge} y2={bottomY} stroke="#E7E2D7" strokeWidth="1" />
        <path d={path} fill="none" stroke={stroke} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        {svgPoints.map((point) => (
          <circle key={point.key} cx={point.x} cy={point.y} r="3.6" fill={stroke} stroke="#FFFFFF" strokeWidth="1.2" />
        ))}
      </svg>
    </div>
  );
}

function formatStorageCompact(storage: string) {
  return storage.replace(/GB/g, '').replace(/\s+/g, '');
}

function getAttributionCombination(reasonDetails: string[]) {
  return reasonDetails.join(' + ');
}

function formatAmountRange(amounts: number[]) {
  const normalized = [...new Set(amounts.map((value) => Math.abs(Math.round(value))))].sort((left, right) => left - right);
  if (normalized.length === 0) {
    return '0元';
  }

  const min = normalized[0];
  const max = normalized[normalized.length - 1];
  return min === max ? `${min}元` : `${min}-${max}元`;
}

function sortRangeItems(items: ChangeSummaryRangeItem[]) {
  return [...items].sort((left, right) => {
    const magnitudeDiff =
      Math.max(...right.amounts.map((amount) => Math.abs(amount))) - Math.max(...left.amounts.map((amount) => Math.abs(amount)));
    if (magnitudeDiff !== 0) {
      return magnitudeDiff;
    }

    return compareText(left.model, right.model);
  });
}

function sortMixedItems(items: ChangeSummaryMixedItem[]) {
  return [...items].sort((left, right) => compareText(left.model, right.model));
}

function buildChangeSummaryReport(skuList: AnalysisSKU[]): ChangeSummaryReport {
  const listOnlyUpMap = new Map<string, ChangeSummaryRangeItem>();
  const listOnlyDownMap = new Map<string, ChangeSummaryRangeItem>();
  const couponOnlyDownMap = new Map<string, ChangeSummaryRangeItem>();
  const couponOnlyUpMap = new Map<string, ChangeSummaryRangeItem>();
  const mixedMaps = {
    listUpCouponUp: new Map<string, ChangeSummaryMixedItem>(),
    listUpCouponDown: new Map<string, ChangeSummaryMixedItem>(),
    listDownCouponUp: new Map<string, ChangeSummaryMixedItem>(),
    listDownCouponDown: new Map<string, ChangeSummaryMixedItem>(),
  };

  const ensureRangeItem = (targetMap: Map<string, ChangeSummaryRangeItem>, sku: AnalysisSKU, amount: number) => {
    const current = targetMap.get(sku.model) ?? { model: sku.model, storages: [], amounts: [] };
    current.storages.push(sku.storage);
    current.amounts.push(amount);
    targetMap.set(sku.model, current);
  };

  const ensureMixedItem = (
    targetMap: Map<string, ChangeSummaryMixedItem>,
    sku: AnalysisSKU,
  ) => {
    const current = targetMap.get(sku.model) ?? { model: sku.model, entries: [] };
    current.entries.push({
      storage: sku.storage,
      listPriceDiff: sku.listPriceDiff,
      couponDiff: sku.couponDiff,
    });
    targetMap.set(sku.model, current);
  };

  skuList.forEach((sku) => {
    const hasListChange = sku.listPriceDiff !== 0;
    const hasCouponChange = sku.couponDiff !== 0;

    if (hasListChange && !hasCouponChange) {
      ensureRangeItem(sku.listPriceDiff > 0 ? listOnlyUpMap : listOnlyDownMap, sku, sku.listPriceDiff);
      return;
    }

    if (!hasListChange && hasCouponChange) {
      ensureRangeItem(sku.couponDiff > 0 ? couponOnlyUpMap : couponOnlyDownMap, sku, sku.couponDiff);
      return;
    }

    if (hasListChange && hasCouponChange) {
      if (sku.listPriceDiff > 0 && sku.couponDiff > 0) {
        ensureMixedItem(mixedMaps.listUpCouponUp, sku);
      } else if (sku.listPriceDiff > 0 && sku.couponDiff < 0) {
        ensureMixedItem(mixedMaps.listUpCouponDown, sku);
      } else if (sku.listPriceDiff < 0 && sku.couponDiff > 0) {
        ensureMixedItem(mixedMaps.listDownCouponUp, sku);
      } else {
        ensureMixedItem(mixedMaps.listDownCouponDown, sku);
      }
    }
  });

  return {
    listOnlyUp: sortRangeItems(Array.from(listOnlyUpMap.values())),
    listOnlyDown: sortRangeItems(Array.from(listOnlyDownMap.values())),
    mixed: {
      listUpCouponUp: sortMixedItems(Array.from(mixedMaps.listUpCouponUp.values())),
      listUpCouponDown: sortMixedItems(Array.from(mixedMaps.listUpCouponDown.values())),
      listDownCouponUp: sortMixedItems(Array.from(mixedMaps.listDownCouponUp.values())),
      listDownCouponDown: sortMixedItems(Array.from(mixedMaps.listDownCouponDown.values())),
    },
    couponOnlyDown: sortRangeItems(Array.from(couponOnlyDownMap.values())),
    couponOnlyUp: sortRangeItems(Array.from(couponOnlyUpMap.values())),
  };
}

function datasetToRawEditorRows(dataset: WorkbookDataset | null): RawEditorRow[] {
  if (!dataset) {
    return [];
  }

  return dataset.skus.map((sku) => {
    const snapshotMap = Object.fromEntries(
      dataset.dates.map((date) => {
        const snapshot = sku.snapshots.find((item) => item.date === date);

        return [
          date,
          {
            finalPrice: snapshot ? String(Math.round(snapshot.finalPrice)) : '',
            listPrice: snapshot ? String(Math.round(snapshot.listPrice)) : '',
            coupon: snapshot ? String(Math.round(snapshot.coupon)) : '',
          },
        ];
      }),
    );

    return {
      id: sku.id,
      model: sku.model,
      storage: sku.storage,
      launchPrice: String(Math.round(sku.launchPrice)),
      snapshots: snapshotMap,
    };
  });
}

function createEmptyRawEditorRow(dates: string[], index: number): RawEditorRow {
  return {
    id: `raw-${Date.now()}-${index}`,
    model: '',
    storage: '',
    launchPrice: '',
    snapshots: Object.fromEntries(
      dates.map((date) => [
        date,
        {
          finalPrice: '',
          listPrice: '',
          coupon: '',
        },
      ]),
    ),
  };
}

function getRawEditorColumnKeys(dates: string[]): RawEditorColumnKey[] {
  return [
    'model',
    'storage',
    'launchPrice',
    ...dates.flatMap((date) => [`${date}::finalPrice`, `${date}::listPrice`, `${date}::coupon`] as RawEditorColumnKey[]),
  ];
}

function updateRawEditorCell(row: RawEditorRow, columnKey: RawEditorColumnKey, value: string) {
  if (columnKey === 'model' || columnKey === 'storage' || columnKey === 'launchPrice') {
    return {
      ...row,
      [columnKey]: value,
    };
  }

  const [date, metric] = columnKey.split('::') as [string, 'finalPrice' | 'listPrice' | 'coupon'];
  return {
    ...row,
    snapshots: {
      ...row.snapshots,
      [date]: {
        ...row.snapshots[date],
        [metric]: value,
      },
    },
  };
}

function buildDatasetFromRawEditorRows(
  rows: RawEditorRow[],
  dates: string[],
  sourceName: string,
): WorkbookDataset {
  const skus = rows
    .map((row, index) => {
      const model = row.model.trim();
      const storage = row.storage.trim();

      if (!model || !storage) {
        return null;
      }

      const brand = inferBrand(model);
      const series = inferSeries(model, brand);
      const snapshots = dates
        .map((date) => {
          const snapshot = row.snapshots[date];
          if (!snapshot) {
            return null;
          }

          const finalPrice = parseNumericInput(snapshot.finalPrice);
          const listPrice = parseNumericInput(snapshot.listPrice);
          const coupon = parseNumericInput(snapshot.coupon);

          if (!finalPrice && !listPrice && !coupon) {
            return null;
          }

          return {
            date,
            finalPrice,
            listPrice,
            coupon,
          };
        })
        .filter((item): item is PriceSnapshot => item !== null);

      return {
        id: `${model}-${storage}-${index + 1}`,
        brand,
        model,
        series,
        storage,
        launchPrice: parseNumericInput(row.launchPrice),
        snapshots,
      };
    })
    .filter((sku): sku is SKUData => sku !== null);

  const brands = Array.from(new Set(skus.map((sku) => sku.brand))).sort((left, right) =>
    left.localeCompare(right, 'zh-Hans-CN', { sensitivity: 'base' }),
  );

  return {
    skus,
    dates,
    brands,
    loadedAt: new Date().toISOString(),
    sourceName,
  };
}

function buildAnalysis(dataset: WorkbookDataset | null): AnalysisResult {
  if (!dataset || dataset.skus.length === 0) {
    return EMPTY_ANALYSIS;
  }

  const processed = dataset.skus.map<AnalysisSKU>((sku) => {
    const last = sku.snapshots[sku.snapshots.length - 1];
    const prev = sku.snapshots[sku.snapshots.length - 2] ?? last;
    const recentChange = last ? last.finalPrice - prev.finalPrice : 0;
    const totalChange = last ? last.finalPrice - sku.launchPrice : 0;
    const recentChangePct = prev?.finalPrice ? (recentChange / prev.finalPrice) * 100 : 0;
    const listPriceDiff = normalizeListPriceDiffForAttribution((last?.listPrice ?? 0) - (prev?.listPrice ?? 0));
    const couponDiff = (last?.coupon ?? 0) - (prev?.coupon ?? 0);
    const attribution = buildAttribution(listPriceDiff, couponDiff, recentChange, sku.snapshots.length);

    return {
      ...sku,
      totalChange,
      recentChange,
      recentChangePct,
      listPriceDiff,
      couponDiff,
      changeDirection: attribution.changeDirection,
      reason: attribution.reason,
      reasonDetails: attribution.reasonDetails,
    };
  });

  const brandMap = new Map<string, { changePctTotal: number; count: number }>();
  processed.forEach((sku) => {
    const current = brandMap.get(sku.brand) ?? { changePctTotal: 0, count: 0 };
    brandMap.set(sku.brand, {
      changePctTotal: current.changePctTotal + sku.recentChangePct,
      count: current.count + 1,
    });
  });

  const brandAnalysis = Array.from(brandMap.entries())
    .map(([name, data]) => ({
      name,
      avgRecentChangePct: Number((data.changePctTotal / data.count).toFixed(2)),
    }))
    .sort((left, right) => right.avgRecentChangePct - left.avgRecentChangePct);

  const seriesMap = new Map<
    string,
    {
      brand: string;
      launchPrices: number[];
      snapshotPrices: Record<string, number[]>;
      directionSummary: {
        up: number;
        down: number;
        flat: number;
      };
    }
  >();

  processed.forEach((sku) => {
    const current = seriesMap.get(sku.model) ?? {
      brand: sku.brand,
      launchPrices: [],
      snapshotPrices: {},
      directionSummary: {
        up: 0,
        down: 0,
        flat: 0,
      },
    };

    current.launchPrices.push(sku.launchPrice);
    sku.snapshots.forEach((snapshot) => {
      if (!current.snapshotPrices[snapshot.date]) {
        current.snapshotPrices[snapshot.date] = [];
      }

      current.snapshotPrices[snapshot.date].push(snapshot.finalPrice);
    });

    if (sku.recentChange > 0) {
      current.directionSummary.up += 1;
    } else if (sku.recentChange < 0) {
      current.directionSummary.down += 1;
    } else {
      current.directionSummary.flat += 1;
    }

    seriesMap.set(sku.model, current);
  });

  const seriesAnalysis = sortSeriesPivotRows(
    Array.from(seriesMap.entries()).map(([model, data]) => {
      const avgLaunch = data.launchPrices.reduce((sum, value) => sum + value, 0) / data.launchPrices.length;
      const snapshotAvgs = dataset.dates
        .filter((date) => data.snapshotPrices[date]?.length)
        .map((date) => ({
          date,
          avgPrice:
            data.snapshotPrices[date].reduce((sum, value) => sum + value, 0) / data.snapshotPrices[date].length,
        }));

      const lastPoint = snapshotAvgs[snapshotAvgs.length - 1];
      const prevPoint = snapshotAvgs[snapshotAvgs.length - 2] ?? lastPoint;
      const diff = lastPoint ? lastPoint.avgPrice - prevPoint.avgPrice : 0;
      const diffPct = prevPoint?.avgPrice ? (diff / prevPoint.avgPrice) * 100 : 0;

      return {
        model,
        brand: data.brand,
        avgLaunch,
        snapshotAvgs,
        diff,
        diffPct,
        trendData: [{ date: '发布', avgPrice: avgLaunch }, ...snapshotAvgs],
        directionSummary: data.directionSummary,
      };
    }),
  );

  return {
    skuList: processed,
    brandAnalysis,
    seriesAnalysis,
  };
}

export default function App() {
  const [sourceDataset, setSourceDataset] = useState<WorkbookDataset | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [view, setView] = useState<ViewMode>('dashboard');
  const [attributionFilter, setAttributionFilter] = useState('all');
  const [rawEditorDates, setRawEditorDates] = useState<string[]>([]);
  const [rawEditorRows, setRawEditorRows] = useState<RawEditorRow[]>([]);
  const [rawEditorMessage, setRawEditorMessage] = useState<string | null>(null);
  const [rawEditorDateInput, setRawEditorDateInput] = useState('');
  const hasHydratedRawDraftRef = useRef(false);
  const rawDraftAutosaveTimerRef = useRef<number | null>(null);
  const lastSavedRawDraftSignatureRef = useRef('');

  useEffect(() => {
    let cancelled = false;

    setIsLoading(true);
    Promise.all([loadWorkbookData(), loadRawEditorDraftFromApi()])
      .then(([nextDataset, persistedDraft]) => {
        if (cancelled) {
          return;
        }

        const workbookLatestDate = nextDataset.dates.at(-1) ?? '';
        const draftLatestDate = persistedDraft?.dates.at(-1) ?? '';
        const shouldRestorePersistedDraft =
          Boolean(persistedDraft && persistedDraft.dates.length > 0) &&
          (!workbookLatestDate || !draftLatestDate || compareDateLabels(draftLatestDate, workbookLatestDate) >= 0);

        if (shouldRestorePersistedDraft && persistedDraft) {
          setRawEditorDates(persistedDraft.dates);
          setRawEditorRows(persistedDraft.rows);
          setSourceDataset(buildDatasetFromRawEditorRows(persistedDraft.rows, persistedDraft.dates, nextDataset.sourceName));
          setRawEditorMessage('已恢复上次保存的原始数据草稿');
          lastSavedRawDraftSignatureRef.current = JSON.stringify({
            dates: persistedDraft.dates,
            rows: persistedDraft.rows,
          });
        } else {
          const workbookRows = datasetToRawEditorRows(nextDataset);
          setRawEditorDates(nextDataset.dates);
          setRawEditorRows(workbookRows);
          setSourceDataset(nextDataset);
          lastSavedRawDraftSignatureRef.current = JSON.stringify({
            dates: nextDataset.dates,
            rows: workbookRows,
          });
          if (persistedDraft && draftLatestDate && workbookLatestDate && compareDateLabels(draftLatestDate, workbookLatestDate) < 0) {
            setRawEditorMessage(`检测到更新到 ${workbookLatestDate} 的新数据源，已优先加载最新 Excel`);
          }
        }
        hasHydratedRawDraftRef.current = true;
        setError(null);
      })
      .catch((loadError) => {
        if (cancelled) {
          return;
        }

        setError(loadError instanceof Error ? loadError.message : 'Excel 数据读取失败');
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hasHydratedRawDraftRef.current || isLoading) {
      return;
    }

    const nextSignature = JSON.stringify({
      dates: rawEditorDates,
      rows: rawEditorRows,
    });

    if (nextSignature === lastSavedRawDraftSignatureRef.current) {
      return;
    }

    if (rawDraftAutosaveTimerRef.current) {
      window.clearTimeout(rawDraftAutosaveTimerRef.current);
    }

    rawDraftAutosaveTimerRef.current = window.setTimeout(() => {
      const nextDraft: RawEditorDraft = {
        dates: rawEditorDates,
        rows: rawEditorRows,
        savedAt: new Date().toISOString(),
      };

      persistRawEditorDraft(nextDraft)
        .then(() => {
          lastSavedRawDraftSignatureRef.current = nextSignature;
        })
        .catch(() => {
          setRawEditorMessage((currentMessage) => currentMessage ?? '草稿自动保存失败，请点击“更新结果”重试');
        });
    }, RAW_DRAFT_AUTOSAVE_MS);

    return () => {
      if (rawDraftAutosaveTimerRef.current) {
        window.clearTimeout(rawDraftAutosaveTimerRef.current);
      }
    };
  }, [isLoading, rawEditorDates, rawEditorRows]);
  const dataset = sourceDataset;

  const analysis = useMemo(() => buildAnalysis(dataset), [dataset]);
  const attributionOptions = useMemo(() => {
    const optionMap = new Map<string, number>();

    analysis.skuList.forEach((sku) => {
      const key = getAttributionCombination(sku.reasonDetails);
      optionMap.set(key, (optionMap.get(key) ?? 0) + 1);
    });

    return Array.from(optionMap.entries())
      .map(([value, count]) => ({ value, count }))
      .sort((left, right) => {
        if (right.count !== left.count) {
          return right.count - left.count;
        }

        return compareText(left.value, right.value);
      });
  }, [analysis.skuList]);

  useEffect(() => {
    if (attributionFilter === 'all') {
      return;
    }

    if (!attributionOptions.some((option) => option.value === attributionFilter)) {
      setAttributionFilter('all');
    }
  }, [attributionFilter, attributionOptions]);

  const filteredSKUs = useMemo(
    () => {
      const keyword = searchTerm.trim().toLowerCase();
      const matchedSKUs = analysis.skuList.filter((sku) => {
        if (attributionFilter !== 'all' && getAttributionCombination(sku.reasonDetails) !== attributionFilter) {
          return false;
        }

        if (!keyword) {
          return true;
        }

        return (
          sku.model.toLowerCase().includes(keyword) ||
          sku.brand.toLowerCase().includes(keyword) ||
          sku.storage.toLowerCase().includes(keyword) ||
          sku.reason.toLowerCase().includes(keyword) ||
          sku.reasonDetails.some((detail) => detail.toLowerCase().includes(keyword))
        );
      });

      const isAttributionSearch =
        !!keyword &&
        matchedSKUs.some(
          (sku) => sku.reason.toLowerCase().includes(keyword) || sku.reasonDetails.some((detail) => detail.toLowerCase().includes(keyword)),
        );

      if (!isAttributionSearch) {
        return sortByChangePriority<AnalysisSKU>(matchedSKUs, (sku) => sku.recentChangePct);
      }

      return [...matchedSKUs].sort((left, right) => {
        const modelDiff = compareText(left.model, right.model);
        if (modelDiff !== 0) {
          return modelDiff;
        }

        const magnitudeDiff = Math.abs(right.recentChangePct) - Math.abs(left.recentChangePct);
        if (magnitudeDiff !== 0) {
          return magnitudeDiff;
        }

        return compareText(left.storage, right.storage);
      });
    },
    [analysis.skuList, attributionFilter, searchTerm],
  );
  const topVolatileSKUs = useMemo(
    () => sortByChangePriority<AnalysisSKU>(analysis.skuList, (sku) => sku.recentChangePct).slice(0, 5),
    [analysis.skuList],
  );
  const changeSummaryReport = useMemo(() => buildChangeSummaryReport(analysis.skuList), [analysis.skuList]);

  const dates = dataset?.dates ?? [];
  const latestDate = dates.at(-1) ?? '--';
  const previousDate = dates.at(-2) ?? latestDate;
  const brandCount = dataset?.brands.length ?? 0;
  const seriesBrandIndexMap = useMemo(() => {
    const brands = Array.from(new Set(analysis.seriesAnalysis.map((series) => series.brand))).sort(compareText);
    return new Map(brands.map((brand, index) => [brand, index]));
  }, [analysis.seriesAnalysis]);
  const avgVolatility =
    analysis.skuList.length > 0
      ? (analysis.skuList.reduce((sum, sku) => sum + Math.abs(sku.recentChangePct), 0) / analysis.skuList.length).toFixed(2)
      : '0.00';
  const latestRangeLabel = dates.length > 0 ? `${dates[0]} - ${latestDate}` : '--';
  const tableColumnCount = dates.length * 3 + 4;

  const handleRawCellChange = (
    rowId: string,
    field: 'model' | 'storage' | 'launchPrice',
    value: string,
  ) => {
    setRawEditorRows((currentRows) => currentRows.map((row) => (row.id === rowId ? updateRawEditorCell(row, field, value) : row)));
    setRawEditorMessage(null);
  };

  const handleRawSnapshotChange = (
    rowId: string,
    date: string,
    metric: 'finalPrice' | 'listPrice' | 'coupon',
    value: string,
  ) => {
    setRawEditorRows((currentRows) =>
      currentRows.map((row) =>
        row.id === rowId
          ? updateRawEditorCell(row, `${date}::${metric}`, value)
          : row,
      ),
    );
    setRawEditorMessage(null);
  };

  const handleRawBulkPaste = (rowId: string, columnKey: RawEditorColumnKey, pastedText: string) => {
    const normalizedRows = pastedText
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split('\n')
      .filter((line) => line.length > 0);

    if (normalizedRows.length === 0) {
      return;
    }

    const matrix = normalizedRows.map((line) => line.split('\t'));
    const rowStartIndex = rawEditorRows.findIndex((row) => row.id === rowId);

    if (rowStartIndex === -1) {
      return;
    }

    const columnKeys = getRawEditorColumnKeys(rawEditorDates);
    const columnStartIndex = columnKeys.indexOf(columnKey);

    if (columnStartIndex === -1) {
      return;
    }

    setRawEditorRows((currentRows) => {
      const nextRows = [...currentRows];
      const requiredRowCount = rowStartIndex + matrix.length;

      while (nextRows.length < requiredRowCount) {
        nextRows.push(createEmptyRawEditorRow(rawEditorDates, nextRows.length));
      }

      matrix.forEach((cells, rowOffset) => {
        const targetRowIndex = rowStartIndex + rowOffset;
        let nextRow = nextRows[targetRowIndex];

        cells.forEach((cellValue, columnOffset) => {
          const targetColumnKey = columnKeys[columnStartIndex + columnOffset];
          if (!targetColumnKey) {
            return;
          }

          nextRow = updateRawEditorCell(nextRow, targetColumnKey, cellValue);
        });

        nextRows[targetRowIndex] = nextRow;
      });

      return nextRows;
    });

    setRawEditorMessage(`已批量粘贴 ${matrix.length} 行数据，点击“更新结果”即可同步分析结果`);
  };

  const handleApplyRawEdits = async () => {
    const nextDraft = {
      dates: rawEditorDates,
      rows: rawEditorRows,
      savedAt: new Date().toISOString(),
    };
    const nextDataset = buildDatasetFromRawEditorRows(
      nextDraft.rows,
      nextDraft.dates,
      dataset?.sourceName ?? '新机售价数据源.xlsx',
    );
    setSourceDataset(nextDataset);
    try {
      await persistRawEditorDraft(nextDraft);
      lastSavedRawDraftSignatureRef.current = JSON.stringify({
        dates: nextDraft.dates,
        rows: nextDraft.rows,
      });
      setRawEditorMessage(
        `已保存并重算结果：${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`,
      );
    } catch {
      setRawEditorMessage('结果已重算，但服务端保存失败');
    }
  };

  const handleResetRawEdits = () => {
    setRawEditorDates(sourceDataset?.dates ?? []);
    setRawEditorRows(datasetToRawEditorRows(sourceDataset));
    setRawEditorMessage('已恢复为当前加载的数据版本');
  };

  const handleAddRawDateColumns = () => {
    const normalizedDate = normalizeDateLabelInput(rawEditorDateInput);

    if (!normalizedDate) {
      setRawEditorMessage('请输入有效日期，例如 4.15');
      return;
    }

    if (rawEditorDates.includes(normalizedDate)) {
      setRawEditorMessage(`日期 ${normalizedDate} 已存在`);
      return;
    }

    const nextDates = [...rawEditorDates, normalizedDate].sort(sortDateLabels);
    setRawEditorDates(nextDates);
    setRawEditorRows((currentRows) =>
      currentRows.map((row) => ({
        ...row,
        snapshots: {
          ...row.snapshots,
          [normalizedDate]: {
            finalPrice: '',
            listPrice: '',
            coupon: '',
          },
        },
      })),
    );
    setRawEditorDateInput('');
    setRawEditorMessage(`已新增 ${normalizedDate} 的国补后 / 挂牌价 / 优惠券三列`);
  };

  return (
    <div className="min-h-screen bg-[#F8F9FA] text-[#1A1C1E] font-sans selection:bg-orange-100">
      <header className="sticky top-0 z-50 border-b border-gray-200 bg-white/80 px-6 py-4 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-orange-600 text-white shadow-lg shadow-orange-200">
              <BarChart3 size={24} />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight">新机售价监控系统</h1>
              <p className="text-xs font-medium uppercase tracking-wider text-gray-500">
                Excel Driven Price Monitoring Dashboard
              </p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
              <input
                type="text"
                placeholder="搜索品牌、型号或归因，如：优惠券降低"
                className="w-64 rounded-xl border-none bg-gray-100 py-2 pl-10 pr-4 text-sm transition-all focus:ring-2 focus:ring-orange-500"
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
              />
            </div>
            <div className="flex rounded-xl bg-gray-100 p-1">
              <button
                onClick={() => setView('dashboard')}
                className={`flex items-center gap-2 rounded-lg px-4 py-1.5 text-sm font-medium transition-all ${
                  view === 'dashboard' ? 'bg-white text-orange-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                <LayoutDashboard size={16} /> 概览
              </button>
              <button
                onClick={() => setView('summary')}
                className={`flex items-center gap-2 rounded-lg px-4 py-1.5 text-sm font-medium transition-all ${
                  view === 'summary' ? 'bg-white text-orange-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                <FileText size={16} /> 汇总
              </button>
              <button
                onClick={() => setView('raw')}
                className={`flex items-center gap-2 rounded-lg px-4 py-1.5 text-sm font-medium transition-all ${
                  view === 'raw' ? 'bg-white text-orange-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                <Database size={16} /> 原始数据
              </button>
              <button
                onClick={() => setView('table')}
                className={`flex items-center gap-2 rounded-lg px-4 py-1.5 text-sm font-medium transition-all ${
                  view === 'table' ? 'bg-white text-orange-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                <TableIcon size={16} /> 明细
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1600px] space-y-6 p-6">
        {isLoading ? (
          <StatusPanel
            icon={<Database className="text-orange-600" size={20} />}
            title="正在读取 Excel 数据"
            description="页面会在解析完工作簿后自动展示最新的价格监控结果。"
          />
        ) : error ? (
          <StatusPanel
            icon={<Info className="text-red-500" size={20} />}
            title="Excel 数据读取失败"
            description={error}
          />
        ) : analysis.skuList.length === 0 ? (
          <StatusPanel
            icon={<Database className="text-gray-500" size={20} />}
            title="没有可展示的数据"
            description="请检查 Excel 中是否包含型号、存储版本和价格列。"
          />
        ) : view === 'dashboard' ? (
          <>
            <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-4">
              <MetricCard
                label="监控 SKU 总数"
                value={analysis.skuList.length}
                subValue={`覆盖 ${brandCount} 大品牌`}
                icon={<BarChart3 className="text-blue-600" />}
              />
              <MetricCard
                label={`最新涨价 SKU (${previousDate} -> ${latestDate})`}
                value={analysis.skuList.filter((sku) => sku.recentChange > 0).length}
                subValue="按最新两个日期快照对比"
                trend="up"
                icon={<TrendingUp className="text-orange-600" />}
              />
              <MetricCard
                label={`最新降价 SKU (${previousDate} -> ${latestDate})`}
                value={analysis.skuList.filter((sku) => sku.recentChange < 0).length}
                subValue="按最新两个日期快照对比"
                trend="down"
                icon={<TrendingDown className="text-emerald-600" />}
              />
              <MetricCard
                label="平均波动幅度"
                value={`${avgVolatility}%`}
                subValue={`数据窗口 ${latestRangeLabel}`}
                icon={<Info className="text-purple-600" />}
              />
            </div>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
              <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm lg:col-span-2">
                <div className="mb-6 flex items-center justify-between">
                  <h2 className="flex items-center gap-2 text-lg font-bold">
                    <BarChart3 size={20} className="text-orange-600" />
                    品牌层最新环比均值 (%)
                  </h2>
                  <span className="text-xs font-bold uppercase tracking-widest text-gray-400">Brand Level Analysis</span>
                </div>
                <div className="h-[300px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={analysis.brandAnalysis} layout="vertical" margin={{ left: 40, right: 88 }}>
                      <CartesianGrid stroke="#f0f0f0" strokeDasharray="3 3" horizontal={false} />
                      <XAxis type="number" hide />
                      <YAxis
                        dataKey="name"
                        type="category"
                        axisLine={false}
                        tickLine={false}
                        tick={{ fontSize: 13, fontWeight: 600, fill: '#4B5563' }}
                      />
                      <Tooltip
                        cursor={{ fill: '#f9fafb' }}
                        contentStyle={{
                          border: 'none',
                          borderRadius: '12px',
                          boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)',
                        }}
                        formatter={(value: number) => [`${value.toFixed(2)}%`, '平均环比']}
                      />
                      <Bar dataKey="avgRecentChangePct" radius={[0, 8, 8, 0]} barSize={24}>
                        {analysis.brandAnalysis.map((entry) => (
                          <Cell
                            key={entry.name}
                            fill={getChangeStroke(entry.avgRecentChangePct)}
                          />
                        ))}
                        <LabelList dataKey="avgRecentChangePct" content={<BrandBarValueLabel />} />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
                <h2 className="mb-4 flex items-center gap-2 text-lg font-bold">
                  <TrendingUp size={20} className="text-orange-600" />
                  波动最大 SKU
                </h2>
                <div className="space-y-4">
                  {topVolatileSKUs.map((sku) => (
                    <div
                      key={sku.id}
                      className="flex items-center justify-between rounded-xl border border-gray-100 bg-gray-50 p-3"
                    >
                      <div>
                        <p className="text-sm font-bold">{sku.model}</p>
                        <p className="text-xs text-gray-500">
                          {sku.brand} · {sku.storage}
                        </p>
                      </div>
                      <div className={`text-right ${getChangeTextClass(sku.recentChangePct)}`}>
                        <p className="text-sm font-bold">{formatSignedPercent(sku.recentChangePct)}</p>
                        <p className="text-[10px] font-medium uppercase">{sku.reason}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
              <div className="flex items-center justify-between border-b border-gray-100 p-6">
                <h2 className="text-lg font-bold">型号系列透视表 (汇总层)</h2>
                <div className="flex gap-2">
                  <span className="rounded bg-orange-50 px-2 py-1 text-[10px] font-bold uppercase text-orange-600">
                    {latestRangeLabel} Data
                  </span>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-max border-collapse text-left">
                  <thead>
                    <tr className="bg-gray-50/50">
                      <th className="sticky left-0 z-30 min-w-[120px] border-r border-gray-100 bg-gray-50/95 px-6 py-3 text-xs font-bold uppercase tracking-wider text-gray-500">
                        品牌
                      </th>
                      <th className="sticky left-[120px] z-20 min-w-[210px] border-r border-gray-100 bg-gray-50/95 px-6 py-3 text-xs font-bold uppercase tracking-wider text-gray-500">
                        型号系列
                      </th>
                      <th className="sticky left-[330px] z-10 min-w-[210px] border-r border-gray-100 bg-gray-50/95 px-6 py-3 text-xs font-bold uppercase tracking-wider text-gray-500">
                        均价走势
                      </th>
                      <th className="px-6 py-3 text-xs font-bold uppercase tracking-wider text-gray-500">发布均价</th>
                      {dates.map((date) => (
                        <th key={date} className="px-6 py-3 text-xs font-bold uppercase tracking-wider text-gray-500">
                          {date} 均价
                        </th>
                      ))}
                      <th className="px-6 py-3 text-xs font-bold uppercase tracking-wider text-gray-500">最新环比 (金额)</th>
                      <th className="px-6 py-3 text-xs font-bold uppercase tracking-wider text-gray-500">最新方向结构</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {analysis.seriesAnalysis.map((series) => {
                      const hasChange = isSeriesPivotChanged(series);
                      const displayChange = getSeriesPivotDisplayChange(series);
                      const brandTone = getBrandTone(series.brand, seriesBrandIndexMap);
                      const rowClassName = hasChange ? brandTone.row : 'bg-white hover:bg-gray-50/50';
                      const stickyClassName = hasChange ? brandTone.sticky : 'bg-white';

                      return (
                        <tr key={series.model} className={`transition-colors ${rowClassName}`}>
                          <td
                            className={`sticky left-0 z-30 min-w-[120px] border-r border-gray-100 px-6 py-2.5 text-sm font-medium shadow-[2px_0_5px_-2px_rgba(0,0,0,0.05)] ${stickyClassName}`}
                          >
                            {hasChange ? (
                              <>
                                <span className={`absolute left-0 top-0 h-full w-1 ${brandTone.bar}`} />
                                <span
                                  className={`inline-flex rounded-full px-2.5 py-1 text-xs font-bold ring-1 ${brandTone.chip}`}
                                >
                                  {series.brand}
                                </span>
                              </>
                            ) : (
                              series.brand
                            )}
                          </td>
                          <td
                            className={`sticky left-[120px] z-20 min-w-[210px] border-r border-gray-100 px-6 py-2.5 text-sm font-bold shadow-[2px_0_5px_-2px_rgba(0,0,0,0.04)] ${stickyClassName}`}
                          >
                            {series.model}
                          </td>
                          <td
                            className={`sticky left-[330px] z-10 min-w-[210px] border-r border-gray-100 px-4 py-2 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.03)] ${stickyClassName}`}
                          >
                            <SeriesTrendChart points={series.trendData} diffPct={displayChange.diffPct} />
                          </td>
                          <td className="px-6 py-2.5 text-sm text-gray-500">{formatPrice(series.avgLaunch)}</td>
                          {dates.map((date) => {
                            const point = series.snapshotAvgs.find((item) => item.date === date);
                            return (
                              <td key={`${series.model}-${date}`} className="px-6 py-2.5 text-sm font-medium">
                                {point ? formatPrice(point.avgPrice) : '--'}
                              </td>
                            );
                          })}
                          <td className="px-6 py-2.5">
                            <span
                              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold ${getChangeBadgeClass(displayChange.diffPct)}`}
                            >
                              {isZeroChange(displayChange.diffPct) ? (
                                <Minus size={12} />
                              ) : displayChange.diffPct > 0 ? (
                                <ArrowUpRight size={12} />
                              ) : (
                                <ArrowDownRight size={12} />
                              )}
                              {Math.abs(displayChange.diffPct).toFixed(1)}% ({displayChange.diff > 0 ? '+' : ''}
                              {Math.round(displayChange.diff)})
                            </span>
                          </td>
                          <td className="px-6 py-2.5 text-sm font-semibold text-gray-600">
                            {series.directionSummary.up}涨 / {series.directionSummary.down}跌 / {series.directionSummary.flat}平
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        ) : view === 'summary' ? (
          <ReportSummaryPanel previousDate={previousDate} latestDate={latestDate} report={changeSummaryReport} />
        ) : view === 'raw' ? (
          <RawDataPanel
            dates={rawEditorDates}
            rawEditorRows={rawEditorRows}
            rawEditorMessage={rawEditorMessage}
            rawEditorDateInput={rawEditorDateInput}
            onApply={handleApplyRawEdits}
            onReset={handleResetRawEdits}
            onDateInputChange={setRawEditorDateInput}
            onAddDateColumns={handleAddRawDateColumns}
            onCellChange={handleRawCellChange}
            onSnapshotChange={handleRawSnapshotChange}
            onBulkPaste={handleRawBulkPaste}
          />
        ) : (
          <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
            <div className="flex flex-col gap-4 border-b border-gray-100 p-6 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <h2 className="text-lg font-bold">SKU 趋势明细 (发售价 - {latestDate})</h2>
                <p className="mt-1 text-sm text-gray-500">深度展示每日国补后价格、挂牌价及优惠券变动明细</p>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm font-semibold text-gray-500">最新归因筛选</span>
                <div className="relative">
                  <select
                    value={attributionFilter}
                    onChange={(event) => setAttributionFilter(event.target.value)}
                    className="min-w-[240px] appearance-none rounded-xl border border-gray-200 bg-white px-4 py-2 pr-9 text-sm font-medium text-gray-700 shadow-sm transition focus:border-orange-400 focus:outline-none focus:ring-2 focus:ring-orange-200"
                  >
                    <option value="all">全部归因组合</option>
                    {attributionOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.value} ({option.count})
                      </option>
                    ))}
                  </select>
                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">▼</span>
                </div>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-[1800px] w-full border-collapse text-left">
                <thead>
                  <tr className="bg-gray-50/50">
                    <th
                      rowSpan={2}
                      className="sticky left-0 z-10 border-b border-r border-gray-100 bg-gray-50/50 px-4 py-4 text-xs font-bold uppercase tracking-wider text-gray-500"
                    >
                      SKU 信息
                    </th>
                    <th rowSpan={2} className="border-b border-r border-gray-100 px-4 py-4 text-xs font-bold uppercase tracking-wider text-gray-500">
                      价格趋势
                    </th>
                    <th rowSpan={2} className="border-b border-r border-gray-100 px-4 py-4 text-xs font-bold uppercase tracking-wider text-gray-500">
                      发售价
                    </th>
                    {dates.map((date) => (
                      <th
                        key={date}
                        colSpan={3}
                        className="border-b border-r border-gray-100 bg-gray-50/30 px-4 py-2 text-center text-xs font-bold uppercase tracking-wider text-gray-500"
                      >
                        {date} 数据
                      </th>
                    ))}
                    <th rowSpan={2} className="border-b px-4 py-4 text-xs font-bold uppercase tracking-wider text-gray-500">
                      最新归因
                    </th>
                  </tr>
                  <tr className="bg-gray-50/50">
                    {dates.map((date) => (
                      <React.Fragment key={`${date}-sub`}>
                        <th className="border-b border-gray-100 px-2 py-2 text-[10px] font-bold uppercase text-gray-400">国补后</th>
                        <th className="border-b border-gray-100 px-2 py-2 text-[10px] font-bold uppercase text-gray-400">挂牌价</th>
                        <th className="border-b border-r border-gray-100 px-2 py-2 text-[10px] font-bold uppercase text-gray-400">优惠券</th>
                      </React.Fragment>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filteredSKUs.length === 0 ? (
                    <tr>
                      <td colSpan={tableColumnCount} className="px-6 py-10 text-center text-sm text-gray-500">
                        没有匹配到对应的品牌或型号。
                      </td>
                    </tr>
                  ) : (
                    filteredSKUs.map((sku) => {
                      const listDiff = sku.listPriceDiff;
                      const couponDiff = sku.couponDiff;
                      const trendData = sku.snapshots;

                      return (
                        <tr key={sku.id} className="transition-colors hover:bg-gray-50/50">
                          <td className="sticky left-0 z-10 border-r border-gray-100 bg-white px-4 py-4 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.05)]">
                            <p className="max-w-[150px] truncate text-sm font-bold">{sku.model}</p>
                            <p className="text-[10px] text-gray-500">
                              {sku.brand} · {sku.storage}
                            </p>
                          </td>
                          <td className="w-40 border-r border-gray-100 px-4 py-4">
                            <MiniTrendChart points={trendData} />
                          </td>
                          <td className="border-r border-gray-100 px-4 py-4 text-sm text-gray-400">
                            {formatPrice(sku.launchPrice)}
                          </td>
                          {dates.map((date) => {
                            const snapshot = sku.snapshots.find((item) => item.date === date);
                            const isLast = date === latestDate;

                            return (
                              <React.Fragment key={`${sku.id}-${date}`}>
                                <td className={`px-2 py-4 text-sm font-bold ${isLast ? 'bg-orange-50/30' : ''}`}>
                                  {snapshot ? formatPrice(snapshot.finalPrice) : '--'}
                                </td>
                                <td className={`px-2 py-4 text-sm text-gray-500 ${isLast ? 'bg-orange-50/30' : ''}`}>
                                  {snapshot ? formatPrice(snapshot.listPrice) : '--'}
                                </td>
                                <td
                                  className={`border-r border-gray-100 px-2 py-4 text-sm font-medium text-emerald-600 ${
                                    isLast ? 'bg-orange-50/30' : ''
                                  }`}
                                >
                                  {snapshot ? formatCoupon(snapshot.coupon) : '--'}
                                </td>
                              </React.Fragment>
                            );
                          })}
                          <td className="px-4 py-4">
                            <div className="flex flex-col gap-1">
                              <div className="flex flex-wrap gap-1">
                                {sku.reasonDetails.map((detail) => (
                                  <span
                                    key={`${sku.id}-${detail}`}
                                    className={`rounded px-2 py-0.5 text-[10px] font-bold ${getAttributionTagClass(detail)}`}
                                  >
                                    {detail}
                                  </span>
                                ))}
                              </div>
                              <p className="whitespace-nowrap text-[10px] italic text-gray-400">
                                {listDiff !== 0 ? `挂牌${listDiff > 0 ? '涨' : '跌'}${Math.abs(listDiff)}` : ''}
                                {listDiff !== 0 && couponDiff !== 0 ? ' | ' : ''}
                                {couponDiff !== 0 ? `券${couponDiff > 0 ? '增' : '减'}${Math.abs(couponDiff)}` : ''}
                                {listDiff === 0 && couponDiff === 0 ? '挂牌价与优惠券均持平' : ''}
                              </p>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function SummaryRangeList({
  items,
  verb,
}: {
  items: ChangeSummaryRangeItem[];
  verb: string;
}) {
  if (items.length === 0) {
    return <p className="text-sm text-gray-400">本期无相关变动</p>;
  }

  return (
    <ol className="space-y-3 text-sm leading-6 text-gray-700">
      {items.map((item, index) => (
        <li key={item.model} className="flex gap-2">
          <span className="font-semibold text-gray-500">{index + 1}.</span>
          <span>
            <span className="font-semibold text-gray-900">{item.model}</span>
            {verb}
            <span className="font-semibold text-gray-900"> {formatAmountRange(item.amounts)}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function SummaryMixedList({
  items,
}: {
  items: ChangeSummaryMixedItem[];
}) {
  if (items.length === 0) {
    return <p className="text-sm text-gray-400">本期无相关变动</p>;
  }

  return (
    <div className="space-y-4">
      {items.map((item) => (
        <div key={item.model} className="rounded-2xl border border-gray-100 bg-gray-50/70 p-4">
          <h4 className="text-sm font-bold text-gray-900">{item.model}</h4>
          <ul className="mt-3 space-y-2 text-sm text-gray-700">
            {item.entries.map((entry) => (
              <li key={`${item.model}-${entry.storage}`} className="flex gap-2">
                <span className="text-gray-400">-</span>
                <span>
                  <span className="font-semibold text-gray-900">{formatStorageCompact(entry.storage)}</span>
                  {` 挂牌价${entry.listPriceDiff > 0 ? '升高' : '降低'} ${Math.abs(Math.round(entry.listPriceDiff))} 元，`}
                  {`优惠券${entry.couponDiff > 0 ? '升高' : '降低'} ${Math.abs(Math.round(entry.couponDiff))} 元`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function SummarySection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
      <h3 className="text-lg font-bold text-gray-900">{title}</h3>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function ReportSummaryPanel({
  previousDate,
  latestDate,
  report,
}: {
  previousDate: string;
  latestDate: string;
  report: ChangeSummaryReport;
}) {
  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-orange-100 bg-gradient-to-r from-orange-50 to-amber-50 p-6 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.28em] text-orange-500">Latest Summary</p>
            <h2 className="mt-2 text-2xl font-black tracking-tight text-gray-900">价格及优惠券变动汇总</h2>
            <p className="mt-2 text-sm text-gray-600">基于最新窗口 {previousDate} -&gt; {latestDate} 自动生成</p>
          </div>
        </div>
      </section>

      <SummarySection title="一、挂牌价变化">
        <div className="grid gap-6 lg:grid-cols-2">
          <div>
            <h4 className="mb-3 text-sm font-bold text-orange-600">挂牌价升高</h4>
            <SummaryRangeList items={report.listOnlyUp} verb=" 挂牌价升高 " />
          </div>
          <div>
            <h4 className="mb-3 text-sm font-bold text-blue-600">挂牌价降低</h4>
            <SummaryRangeList items={report.listOnlyDown} verb=" 挂牌价降低 " />
          </div>
        </div>
      </SummarySection>

      <SummarySection title="二、挂牌价变化 + 优惠券变化">
        <div className="grid gap-6 xl:grid-cols-2">
          <div>
            <h4 className="mb-3 text-sm font-bold text-orange-600">挂牌价升高 + 优惠券升高</h4>
            <SummaryMixedList items={report.mixed.listUpCouponUp} />
          </div>
          <div>
            <h4 className="mb-3 text-sm font-bold text-orange-600">挂牌价升高 + 优惠券降低</h4>
            <SummaryMixedList items={report.mixed.listUpCouponDown} />
          </div>
          <div>
            <h4 className="mb-3 text-sm font-bold text-blue-600">挂牌价降低 + 优惠券升高</h4>
            <SummaryMixedList items={report.mixed.listDownCouponUp} />
          </div>
          <div>
            <h4 className="mb-3 text-sm font-bold text-blue-600">挂牌价降低 + 优惠券降低</h4>
            <SummaryMixedList items={report.mixed.listDownCouponDown} />
          </div>
        </div>
      </SummarySection>

      <SummarySection title="三、优惠券变化">
        <div className="grid gap-6 lg:grid-cols-2">
          <div>
            <h4 className="mb-3 text-sm font-bold text-blue-600">优惠券降低</h4>
            <SummaryRangeList items={report.couponOnlyDown} verb=" 优惠券降低 " />
          </div>
          <div>
            <h4 className="mb-3 text-sm font-bold text-orange-600">优惠券升高</h4>
            <SummaryRangeList items={report.couponOnlyUp} verb=" 优惠券升高 " />
          </div>
        </div>
      </SummarySection>
    </div>
  );
}

function RawDataPanel({
  dates,
  rawEditorRows,
  rawEditorMessage,
  rawEditorDateInput,
  onApply,
  onReset,
  onDateInputChange,
  onAddDateColumns,
  onCellChange,
  onSnapshotChange,
  onBulkPaste,
}: {
  dates: string[];
  rawEditorRows: RawEditorRow[];
  rawEditorMessage: string | null;
  rawEditorDateInput: string;
  onApply: () => void;
  onReset: () => void;
  onDateInputChange: (value: string) => void;
  onAddDateColumns: () => void;
  onCellChange: (rowId: string, field: 'model' | 'storage' | 'launchPrice', value: string) => void;
  onSnapshotChange: (rowId: string, date: string, metric: 'finalPrice' | 'listPrice' | 'coupon', value: string) => void;
  onBulkPaste: (rowId: string, columnKey: RawEditorColumnKey, pastedText: string) => void;
}) {
  const [selectedCell, setSelectedCell] = useState<{ rowId: string; columnKey: RawEditorColumnKey } | null>(null);
  const cellRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const columnKeys = useMemo(() => getRawEditorColumnKeys(dates), [dates]);

  const setCellRef = (rowId: string, columnKey: RawEditorColumnKey, element: HTMLInputElement | null) => {
    cellRefs.current[`${rowId}::${columnKey}`] = element;
  };

  const focusCell = (rowId: string, columnKey: RawEditorColumnKey) => {
    setSelectedCell({ rowId, columnKey });
    window.requestAnimationFrame(() => {
      cellRefs.current[`${rowId}::${columnKey}`]?.focus();
    });
  };

  const moveSelection = (
    rowId: string,
    columnKey: RawEditorColumnKey,
    direction: 'up' | 'down' | 'left' | 'right',
  ) => {
    const rowIndex = rawEditorRows.findIndex((row) => row.id === rowId);
    const columnIndex = columnKeys.indexOf(columnKey);

    if (rowIndex === -1 || columnIndex === -1) {
      return;
    }

    const nextRowIndex =
      direction === 'up'
        ? Math.max(0, rowIndex - 1)
        : direction === 'down'
          ? Math.min(rawEditorRows.length - 1, rowIndex + 1)
          : rowIndex;

    const nextColumnIndex =
      direction === 'left'
        ? Math.max(0, columnIndex - 1)
        : direction === 'right'
          ? Math.min(columnKeys.length - 1, columnIndex + 1)
          : columnIndex;

    const nextRow = rawEditorRows[nextRowIndex];
    const nextColumnKey = columnKeys[nextColumnIndex];

    if (nextRow && nextColumnKey) {
      focusCell(nextRow.id, nextColumnKey);
    }
  };

  const getCellClass = (rowId: string, columnKey: RawEditorColumnKey, baseClassName: string) =>
    `${baseClassName} ${
      selectedCell?.rowId === rowId && selectedCell?.columnKey === columnKey
        ? 'border-orange-500 ring-2 ring-orange-200 bg-orange-50/60'
        : ''
    }`;

  const handleCellKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement>,
    rowId: string,
    columnKey: RawEditorColumnKey,
  ) => {
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveSelection(rowId, columnKey, 'up');
      return;
    }

    if (event.key === 'ArrowDown' || event.key === 'Enter') {
      event.preventDefault();
      moveSelection(rowId, columnKey, 'down');
      return;
    }

    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      moveSelection(rowId, columnKey, 'left');
      return;
    }

    if (event.key === 'ArrowRight') {
      event.preventDefault();
      moveSelection(rowId, columnKey, 'right');
    }
  };

  return (
    <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
      <div className="flex flex-col gap-4 border-b border-gray-100 p-6 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h2 className="text-lg font-bold">原始数据</h2>
          <p className="mt-1 text-sm text-gray-500">
            直接编辑基础数据，支持从 Excel 复制多行多列后，从任意起始单元格批量粘贴。点击“更新结果”后，概览、汇总和明细会同步重算。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="text"
            value={rawEditorDateInput}
            onChange={(event) => onDateInputChange(event.target.value)}
            placeholder="新增日期，如 4.15"
            className="w-40 rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm text-gray-700 focus:border-orange-400 focus:outline-none focus:ring-2 focus:ring-orange-100"
          />
          <button
            type="button"
            onClick={onAddDateColumns}
            className="rounded-xl border border-orange-200 bg-orange-50 px-4 py-2 text-sm font-semibold text-orange-600 transition hover:border-orange-300 hover:bg-orange-100"
          >
            新增三列
          </button>
          {rawEditorMessage ? <span className="text-sm font-medium text-emerald-600">{rawEditorMessage}</span> : null}
          <button
            type="button"
            onClick={onReset}
            className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-600 transition hover:border-gray-300 hover:text-gray-800"
          >
            恢复当前数据
          </button>
          <button
            type="button"
            onClick={onApply}
            className="rounded-xl bg-orange-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-orange-700"
          >
            更新结果
          </button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-[2200px] w-full border-collapse text-left">
          <thead>
            <tr className="bg-gray-50/50">
              <th
                rowSpan={2}
                className="sticky left-0 z-20 border-b border-r border-gray-100 bg-gray-50/95 px-4 py-4 text-xs font-bold uppercase tracking-wider text-gray-500"
              >
                型号
              </th>
              <th
                rowSpan={2}
                className="sticky left-[220px] z-20 border-b border-r border-gray-100 bg-gray-50/95 px-4 py-4 text-xs font-bold uppercase tracking-wider text-gray-500"
              >
                存储
              </th>
              <th
                rowSpan={2}
                className="sticky left-[380px] z-20 border-b border-r border-gray-100 bg-gray-50/95 px-4 py-4 text-xs font-bold uppercase tracking-wider text-gray-500"
              >
                发售价
              </th>
              {dates.map((date) => (
                <th
                  key={date}
                  colSpan={3}
                  className="border-b border-r border-gray-100 bg-gray-50/30 px-4 py-2 text-center text-xs font-bold uppercase tracking-wider text-gray-500"
                >
                  {date} 数据
                </th>
              ))}
            </tr>
            <tr className="bg-gray-50/50">
              {dates.map((date) => (
                <React.Fragment key={`${date}-sub`}>
                  <th className="border-b border-gray-100 px-3 py-2 text-[10px] font-bold uppercase text-gray-400">国补后</th>
                  <th className="border-b border-gray-100 px-3 py-2 text-[10px] font-bold uppercase text-gray-400">挂牌价</th>
                  <th className="border-b border-r border-gray-100 px-3 py-2 text-[10px] font-bold uppercase text-gray-400">优惠券</th>
                </React.Fragment>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rawEditorRows.map((row) => (
              <tr key={row.id} className="transition-colors hover:bg-gray-50/40">
                <td className="sticky left-0 z-10 min-w-[220px] border-r border-gray-100 bg-white px-4 py-3 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.05)]">
                  <input
                    type="text"
                    value={row.model}
                    onChange={(event) => onCellChange(row.id, 'model', event.target.value)}
                    onFocus={() => setSelectedCell({ rowId: row.id, columnKey: 'model' })}
                    onClick={() => setSelectedCell({ rowId: row.id, columnKey: 'model' })}
                    onKeyDown={(event) => handleCellKeyDown(event, row.id, 'model')}
                    onPaste={(event) => {
                      const text = event.clipboardData.getData('text');
                      if (text.includes('\t') || text.includes('\n')) {
                        event.preventDefault();
                        onBulkPaste(row.id, 'model', text);
                      }
                    }}
                    ref={(element) => setCellRef(row.id, 'model', element)}
                    className={getCellClass(
                      row.id,
                      'model',
                      'w-full rounded-lg border border-gray-200 px-3 py-2 text-sm font-semibold text-gray-800 focus:border-orange-400 focus:outline-none focus:ring-2 focus:ring-orange-100',
                    )}
                  />
                </td>
                <td className="sticky left-[220px] z-10 min-w-[160px] border-r border-gray-100 bg-white px-4 py-3 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.04)]">
                  <input
                    type="text"
                    value={row.storage}
                    onChange={(event) => onCellChange(row.id, 'storage', event.target.value)}
                    onFocus={() => setSelectedCell({ rowId: row.id, columnKey: 'storage' })}
                    onClick={() => setSelectedCell({ rowId: row.id, columnKey: 'storage' })}
                    onKeyDown={(event) => handleCellKeyDown(event, row.id, 'storage')}
                    onPaste={(event) => {
                      const text = event.clipboardData.getData('text');
                      if (text.includes('\t') || text.includes('\n')) {
                        event.preventDefault();
                        onBulkPaste(row.id, 'storage', text);
                      }
                    }}
                    ref={(element) => setCellRef(row.id, 'storage', element)}
                    className={getCellClass(
                      row.id,
                      'storage',
                      'w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 focus:border-orange-400 focus:outline-none focus:ring-2 focus:ring-orange-100',
                    )}
                  />
                </td>
                <td className="sticky left-[380px] z-10 min-w-[140px] border-r border-gray-100 bg-white px-4 py-3 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.03)]">
                  <input
                    type="text"
                    value={row.launchPrice}
                    onChange={(event) => onCellChange(row.id, 'launchPrice', event.target.value)}
                    onFocus={() => setSelectedCell({ rowId: row.id, columnKey: 'launchPrice' })}
                    onClick={() => setSelectedCell({ rowId: row.id, columnKey: 'launchPrice' })}
                    onKeyDown={(event) => handleCellKeyDown(event, row.id, 'launchPrice')}
                    onPaste={(event) => {
                      const text = event.clipboardData.getData('text');
                      if (text.includes('\t') || text.includes('\n')) {
                        event.preventDefault();
                        onBulkPaste(row.id, 'launchPrice', text);
                      }
                    }}
                    ref={(element) => setCellRef(row.id, 'launchPrice', element)}
                    className={getCellClass(
                      row.id,
                      'launchPrice',
                      'w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 focus:border-orange-400 focus:outline-none focus:ring-2 focus:ring-orange-100',
                    )}
                  />
                </td>
                {dates.map((date) => {
                  const snapshot = row.snapshots[date];
                  return (
                    <React.Fragment key={`${row.id}-${date}`}>
                      <td className="px-3 py-3">
                        <input
                          type="text"
                          value={snapshot?.finalPrice ?? ''}
                          onChange={(event) => onSnapshotChange(row.id, date, 'finalPrice', event.target.value)}
                          onFocus={() => setSelectedCell({ rowId: row.id, columnKey: `${date}::finalPrice` })}
                          onClick={() => setSelectedCell({ rowId: row.id, columnKey: `${date}::finalPrice` })}
                          onKeyDown={(event) => handleCellKeyDown(event, row.id, `${date}::finalPrice`)}
                          onPaste={(event) => {
                            const text = event.clipboardData.getData('text');
                            if (text.includes('\t') || text.includes('\n')) {
                              event.preventDefault();
                              onBulkPaste(row.id, `${date}::finalPrice`, text);
                            }
                          }}
                          ref={(element) => setCellRef(row.id, `${date}::finalPrice`, element)}
                          className={getCellClass(
                            row.id,
                            `${date}::finalPrice`,
                            'w-full min-w-[110px] rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-800 focus:border-orange-400 focus:outline-none focus:ring-2 focus:ring-orange-100',
                          )}
                        />
                      </td>
                      <td className="px-3 py-3">
                        <input
                          type="text"
                          value={snapshot?.listPrice ?? ''}
                          onChange={(event) => onSnapshotChange(row.id, date, 'listPrice', event.target.value)}
                          onFocus={() => setSelectedCell({ rowId: row.id, columnKey: `${date}::listPrice` })}
                          onClick={() => setSelectedCell({ rowId: row.id, columnKey: `${date}::listPrice` })}
                          onKeyDown={(event) => handleCellKeyDown(event, row.id, `${date}::listPrice`)}
                          onPaste={(event) => {
                            const text = event.clipboardData.getData('text');
                            if (text.includes('\t') || text.includes('\n')) {
                              event.preventDefault();
                              onBulkPaste(row.id, `${date}::listPrice`, text);
                            }
                          }}
                          ref={(element) => setCellRef(row.id, `${date}::listPrice`, element)}
                          className={getCellClass(
                            row.id,
                            `${date}::listPrice`,
                            'w-full min-w-[110px] rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 focus:border-orange-400 focus:outline-none focus:ring-2 focus:ring-orange-100',
                          )}
                        />
                      </td>
                      <td className="border-r border-gray-100 px-3 py-3">
                        <input
                          type="text"
                          value={snapshot?.coupon ?? ''}
                          onChange={(event) => onSnapshotChange(row.id, date, 'coupon', event.target.value)}
                          onFocus={() => setSelectedCell({ rowId: row.id, columnKey: `${date}::coupon` })}
                          onClick={() => setSelectedCell({ rowId: row.id, columnKey: `${date}::coupon` })}
                          onKeyDown={(event) => handleCellKeyDown(event, row.id, `${date}::coupon`)}
                          onPaste={(event) => {
                            const text = event.clipboardData.getData('text');
                            if (text.includes('\t') || text.includes('\n')) {
                              event.preventDefault();
                              onBulkPaste(row.id, `${date}::coupon`, text);
                            }
                          }}
                          ref={(element) => setCellRef(row.id, `${date}::coupon`, element)}
                          className={getCellClass(
                            row.id,
                            `${date}::coupon`,
                            'w-full min-w-[100px] rounded-lg border border-gray-200 px-3 py-2 text-sm text-emerald-600 focus:border-orange-400 focus:outline-none focus:ring-2 focus:ring-orange-100',
                          )}
                        />
                      </td>
                    </React.Fragment>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MetricCard({
  label,
  value,
  subValue,
  trend,
  icon,
}: {
  label: string;
  value: string | number;
  subValue: string;
  trend?: 'up' | 'down';
  icon: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm transition-shadow hover:shadow-md">
      <div className="mb-4 flex items-start justify-between">
        <div className="rounded-xl bg-gray-50 p-2">{icon}</div>
        {trend ? (
          <span className={`flex items-center gap-0.5 text-xs font-bold ${trend === 'up' ? 'text-orange-600' : 'text-emerald-600'}`}>
            {trend === 'up' ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
            {trend === 'up' ? '上升' : '下降'}
          </span>
        ) : null}
      </div>
      <p className="mb-1 text-sm font-medium text-gray-500">{label}</p>
      <h3 className="mb-1 text-2xl font-black tracking-tight">{value}</h3>
      <p className="text-xs font-medium text-gray-400">{subValue}</p>
    </div>
  );
}

function StatusPanel({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="flex min-h-[360px] items-center justify-center rounded-3xl border border-dashed border-gray-300 bg-white p-8 shadow-sm">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-gray-50">{icon}</div>
        <h2 className="text-xl font-bold tracking-tight">{title}</h2>
        <p className="mt-2 text-sm leading-6 text-gray-500">{description}</p>
      </div>
    </div>
  );
}
