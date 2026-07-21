import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import {
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Database,
  Download,
  FileText,
  Info,
  LayoutDashboard,
  Minus,
  Search,
  Table as TableIcon,
  TrendingDown,
  TrendingUp,
  Upload,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  LabelList,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { loadWorkbookData, PriceSnapshot, SKUData, WorkbookDataset } from './data';
import { getNewMachinePpvMapping } from './ppvMapping';
import { WeeklySalesPanel } from './WeeklySalesPanel';

type ViewMode = 'dashboard' | 'summary' | 'risk' | 'marketTrend' | 'weeklySales' | 'table' | 'raw';
type PositionPivotScope = 'all' | 'stable' | 'new526';

const CHANGE_SUMMARY_MIN_AMOUNT = 11;
const NEW_BATCH_START_DATE = '5.26';
const POSITION_PIVOT_SCOPE_OPTIONS: Array<{ value: PositionPivotScope; label: string }> = [
  { value: 'all', label: '全量' },
  { value: 'stable', label: '老样本' },
  { value: 'new526', label: '5.26新增' },
];

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

interface PositionAnalysisItem {
  position: string;
  skuCount: number;
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
  positionAnalysis: PositionAnalysisItem[];
  seriesAnalysis: SeriesAnalysisItem[];
}

interface BiPriceRow {
  ppv: string;
  biPrice: number | null;
  matched: boolean;
  matchedPpv: string;
  dataDate: string | null;
}

type RiskLevel = 'none' | 'risk' | 'high' | 'unmatched';

interface RiskAnalysisRow {
  sku: AnalysisSKU;
  latestSnapshot: PriceSnapshot | null;
  biPrice: number | null;
  diff: number | null;
  riskLevel: RiskLevel;
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
  brand: string;
  storage: string;
  position: string;
  ppv: string;
  launchPrice: string;
  snapshots: Record<
    string,
    {
      finalPrice: string;
      listPrice: string;
      coupon: string;
      biPrice?: string;
    }
  >;
}

interface RawModelConfig {
  model: string;
  brand: string;
  position: string;
}

interface RawEditorDraft {
  dates: string[];
  rows: RawEditorRow[];
  savedAt: string;
}

interface PersistRawEditorDraftOptions {
  syncWorkbook?: boolean;
  workbookSyncMode?: 'latestBiPriceOnly';
  workbookTargetDate?: string;
  workbookTargetPpvs?: string[];
}

interface MarketTrendWeek {
  week: string;
  timeRange: string;
  totalIndex: number;
  marketNote: string;
  eventName: string;
}

interface MarketTrendPayload {
  sheetName: string;
  year: number;
  weeks: MarketTrendWeek[];
  brandShares: Record<string, Record<string, number | null>>;
  savedAt: string;
}

interface MarketTrendOverview {
  dataset: {
    sheetName: string;
    year: number;
    periodStartWeek: string;
    periodEndWeek: string;
    marketScope: string;
    savedAt: string;
  };
  weeklyTotal: MarketTrendWeek[];
  brandShare: Array<{
    year: number;
    week: string;
    brandName: string;
    brandGroup: string;
    sharePct: number;
  }>;
  events: Array<{
    year: number;
    week: string;
    eventName: string;
    eventType: string;
    relatedBrand: string;
    remark: string;
  }>;
  payload: MarketTrendPayload;
  summary: {
    latestWeek: string;
    latestTotalIndex: number;
    latestTotalIndexChangePct: number;
    peakWeek: string;
    peakTotalIndex: number;
    topBrand: string;
    topBrandShare: number;
    appleShare: number;
    appleChangePctPoint: number;
    huaweiShare: number;
    huaweiChangePctPoint: number;
    oppoTotalShare: number;
    oppoTotalChangePctPoint: number;
    updatedAt: string;
  };
}

interface MarketTrendWeekInput {
  week: string;
  timeRange: string;
  totalIndex: string;
  marketNote: string;
  eventName: string;
  brandShares: Record<string, string>;
}

type RawEditorColumnKey =
  | 'model'
  | 'storage'
  | 'launchPrice'
  | `${string}::finalPrice`
  | `${string}::listPrice`
  | `${string}::coupon`
  | `${string}::biPrice`;

const EMPTY_ANALYSIS: AnalysisResult = {
  skuList: [],
  brandAnalysis: [],
  positionAnalysis: [],
  seriesAnalysis: [],
};

const formatPrice = (price: number) => `¥${Math.round(price).toLocaleString()}`;
const formatCoupon = (coupon: number) => (coupon > 0 ? `¥${Math.round(coupon).toLocaleString()}` : '--');
const formatSignedPercent = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
const isZeroChange = (value: number) => Math.abs(value) < 0.0001;
const SERIES_PIVOT_IGNORE_AMOUNT = 10;
const KNOWN_BRANDS = ['REDMI', 'iQOO', 'OPPO', 'vivo', '华为', '荣耀', '一加', '小米'];
const RAW_DRAFT_AUTOSAVE_MS = 1200;
const RAW_DRAFT_FETCH_TIMEOUT_MS = 3000;
const LIST_PRICE_ATTRIBUTION_IGNORE_DIFF = 1;
const MARKET_TREND_CORE_BRANDS = ['苹果', '小米', 'vivo总(含iQOO)', '华为', 'OPPO总(含一加、realme)', '荣耀', 'Others'];
const MARKET_TREND_COLORS: Record<string, string> = {
  totalIndex: '#3B73F6',
  苹果: '#39BDEB',
  小米: '#8B5CF6',
  'vivo总(含iQOO)': '#F5C542',
  华为: '#EF4444',
  'OPPO总(含一加、realme)': '#F59E0B',
  荣耀: '#7096F5',
  Others: '#9CA3AF',
};

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

function isDelistedInput(value: string) {
  return value.replace(/\s+/g, '').trim() === '已下架';
}

function parseNumberValue(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  const normalized = String(value ?? '').replace(/,/g, '').trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getRiskLevel(finalPrice: number, biPrice: number | null): RiskLevel {
  if (!finalPrice || !biPrice) {
    return 'unmatched';
  }

  if (biPrice >= finalPrice) {
    return 'high';
  }

  if (biPrice >= finalPrice * 0.95) {
    return 'risk';
  }

  return 'none';
}

function getRiskLabel(riskLevel: RiskLevel) {
  if (riskLevel === 'high') {
    return '高风险';
  }

  if (riskLevel === 'risk') {
    return '有风险';
  }

  if (riskLevel === 'unmatched') {
    return '未匹配';
  }

  return '无风险';
}

function getRiskBadgeClass(riskLevel: RiskLevel) {
  if (riskLevel === 'high') {
    return 'bg-red-50 text-red-700 ring-red-100';
  }

  if (riskLevel === 'risk') {
    return 'bg-amber-50 text-amber-700 ring-amber-100';
  }

  if (riskLevel === 'unmatched') {
    return 'bg-gray-100 text-gray-500 ring-gray-200';
  }

  return 'bg-emerald-50 text-emerald-700 ring-emerald-100';
}

async function lookupBiPrices(ppvs: string[]): Promise<{ dataDate: string | null; rows: BiPriceRow[] }> {
  const response = await fetch('/api/bi-price-lookup', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ ppv: ppvs }),
  });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload?.message || payload?.error || 'BI 出货价接口调用失败');
  }

  return {
    dataDate: payload.dataDate ?? null,
    rows: ppvs.map((ppv, index) => {
      const row = payload.rows?.[index] ?? {};
      const biPrice = parseNumberValue(row['bi出货价']);

      return {
        ppv,
        biPrice: biPrice > 0 ? biPrice : null,
        matched: Boolean(row.matched),
        matchedPpv: String(row.ppv ?? ''),
        dataDate: row.dataDate ?? payload.dataDate ?? null,
      };
    }),
  };
}

async function loadMarketTrendOverview(): Promise<MarketTrendOverview> {
  const response = await fetch('/api/market-trend/overview');
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.message || '市场趋势数据读取失败');
  }
  return payload;
}

async function persistMarketTrendDraft(payload: MarketTrendPayload) {
  const response = await fetch('/api/market-trend/draft', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(result?.message || '市场趋势草稿保存失败');
  }
  return result;
}

async function applyMarketTrendPayload(payload: MarketTrendPayload) {
  const response = await fetch('/api/market-trend/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(result?.message || '市场趋势数据写回失败');
  }
  return result;
}

async function confirmMarketTrendWeek(payload: MarketTrendWeekInput, allowUpdate: boolean) {
  const response = await fetch('/api/market-trend/weeks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...payload,
      allowUpdate,
      totalIndex: parseMarketTrendNumber(payload.totalIndex),
      brandShares: MARKET_TREND_CORE_BRANDS.map((brandName) => ({
        brandName,
        sharePct: parseMarketTrendShareInput(payload.brandShares[brandName]),
      })),
    }),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(result?.message || '市场趋势周度数据落数失败');
  }
  return result;
}

function parseMarketTrendWeekNumber(week: string) {
  const matched = week.match(/(\d+)/);
  return matched ? Number(matched[1]) : 0;
}

function parseMarketTrendNumber(value: string) {
  const parsed = Number(String(value ?? '').replace(/,/g, '').replace(/%/g, '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseMarketTrendShareInput(value: string | number | null | undefined) {
  const parsed = parseMarketTrendNumber(String(value ?? ''));
  if (!parsed) {
    return 0;
  }
  return Math.abs(parsed) < 1 ? Number((parsed * 100).toFixed(4)) : parsed;
}

function formatPctPoint(value: number) {
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}pct`;
}

function formatMarketShare(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(1)}%` : '--';
}

function getMarketTrendWeeks(overview: MarketTrendOverview) {
  return overview.weeklyTotal.map((item) => item.week).sort((left, right) => parseMarketTrendWeekNumber(left) - parseMarketTrendWeekNumber(right));
}

function getMarketTrendShare(overview: MarketTrendOverview, brand: string, week: string) {
  return overview.brandShare.find((item) => item.brandName === brand && item.week === week)?.sharePct ?? null;
}

function buildMarketTrendChartData(overview: MarketTrendOverview) {
  return getMarketTrendWeeks(overview).map((week) => {
    const total = overview.weeklyTotal.find((item) => item.week === week);
    const row: Record<string, string | number> = {
      week,
      totalIndex: total?.totalIndex ?? 0,
    };
    for (const brand of MARKET_TREND_CORE_BRANDS) {
      row[brand] = getMarketTrendShare(overview, brand, week) ?? 0;
    }
    return row;
  });
}

function createNextMarketTrendWeekInput(overview: MarketTrendOverview): MarketTrendWeekInput {
  const weeks = getMarketTrendWeeks(overview);
  const latestWeek = weeks.at(-1) ?? 'W0';
  const nextWeek = `W${parseMarketTrendWeekNumber(latestWeek) + 1}`;
  const latestShares = Object.fromEntries(
    MARKET_TREND_CORE_BRANDS.map((brand) => [brand, String(getMarketTrendShare(overview, brand, latestWeek) ?? '')]),
  );

  return {
    week: nextWeek,
    timeRange: '',
    totalIndex: '',
    marketNote: '',
    eventName: '',
    brandShares: latestShares,
  };
}

function normalizeMarketTrendBrand(value: string) {
  const normalized = value.trim().toLowerCase();
  const aliases: Record<string, string> = {
    apple: '苹果',
    苹果: '苹果',
    xiaomi: '小米',
    小米: '小米',
    vivo: 'vivo总(含iQOO)',
    vivo总: 'vivo总(含iQOO)',
    'vivo总(含iqoo)': 'vivo总(含iQOO)',
    iqoo: 'vivo总(含iQOO)',
    huawei: '华为',
    华为: '华为',
    oppo: 'OPPO总(含一加、realme)',
    oppo总: 'OPPO总(含一加、realme)',
    'oppo总(含一加、realme)': 'OPPO总(含一加、realme)',
    一加: 'OPPO总(含一加、realme)',
    realme: 'OPPO总(含一加、realme)',
    honor: '荣耀',
    荣耀: '荣耀',
    others: 'Others',
    其他: 'Others',
  };
  return aliases[normalized] ?? aliases[value.trim()] ?? '';
}

function parseMarketTrendPaste(text: string) {
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const parts = trimmed.split(/\t|,|\s{2,}/).map((item) => item.trim()).filter(Boolean);
    if (parts.length < 2) {
      continue;
    }
    const brand = normalizeMarketTrendBrand(parts[0]);
    if (brand) {
      result[brand] = parts[1].replace(/%/g, '');
    }
  }
  return result;
}

function buildRiskReportCsv(rows: RiskAnalysisRow[], latestDate: string) {
  const headers = ['型号', '存储', '定位', 'ppv', `${latestDate}国补后`, 'BI出货价', '价差', '风险判定'];
  const escapeCsv = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const bodyRows = rows.map((row) => [
    row.sku.model,
    row.sku.storage,
    row.sku.position,
    row.sku.ppv,
    row.latestSnapshot?.finalPrice ?? '',
    row.biPrice ?? '',
    row.diff ?? '',
    getRiskLabel(row.riskLevel),
  ]);

  return `\uFEFF${[headers, ...bodyRows].map((row) => row.map(escapeCsv).join(',')).join('\n')}`;
}

function downloadTextFile(filename: string, content: string, mimeType: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function toRawExportCell(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  const parsed = Number(trimmed.replace(/,/g, ''));
  return Number.isFinite(parsed) && /^-?\d+(\.\d+)?$/.test(trimmed.replace(/,/g, '')) ? parsed : trimmed;
}

function downloadRawEditorWorkbook(dates: string[], rows: RawEditorRow[]) {
  const headerRows = [
    ['型号名称', '存储版本', '发布挂牌售价', ...dates.flatMap((date) => [date, '', '', ''])],
    ['', '', '', ...dates.flatMap(() => ['国补后价格试算', '挂牌价', '优惠券', 'BI出货价'])],
  ];
  const bodyRows = rows.map((row) => [
    row.model,
    row.storage,
    toRawExportCell(row.launchPrice),
    ...dates.flatMap((date) => {
      const snapshot = row.snapshots[date];
      return [
        toRawExportCell(snapshot?.finalPrice ?? ''),
        toRawExportCell(snapshot?.listPrice ?? ''),
        toRawExportCell(snapshot?.coupon ?? ''),
        toRawExportCell(snapshot?.biPrice ?? ''),
      ];
    }),
  ]);
  const worksheet = XLSX.utils.aoa_to_sheet([...headerRows, ...bodyRows]);

  worksheet['!merges'] = dates.map((_, index) => {
    const startColumn = 3 + index * 4;
    return { s: { r: 0, c: startColumn }, e: { r: 0, c: startColumn + 3 } };
  });
  worksheet['!cols'] = [
    { wch: 24 },
    { wch: 14 },
    { wch: 14 },
    ...dates.flatMap(() => [{ wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 12 }]),
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, '原始数据');
  XLSX.writeFile(workbook, `原始数据_${dates.at(-1) ?? '未命名'}.xlsx`);
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
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), RAW_DRAFT_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch('/api/raw-editor-draft', { signal: controller.signal });
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
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function persistRawEditorDraft(draft: RawEditorDraft, options: PersistRawEditorDraftOptions = {}) {
  const response = await fetch('/api/raw-editor-draft', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ...draft,
      syncWorkbook: options.syncWorkbook === true,
      workbookSyncMode: options.workbookSyncMode,
      workbookTargetDate: options.workbookTargetDate,
      workbookTargetPpvs: options.workbookTargetPpvs,
    }),
  });
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(payload?.message || 'Failed to persist raw editor draft');
  }

  return payload;
}

function inferBrand(modelName: string) {
  const matchedBrand = KNOWN_BRANDS.find((brand) => modelName.startsWith(brand));
  if (matchedBrand) {
    return normalizeConfiguredBrand(matchedBrand);
  }

  const [firstToken] = modelName.split(/\s+/);
  return normalizeConfiguredBrand(firstToken || modelName);
}

function normalizeConfiguredBrand(value: string) {
  const brand = value.trim();
  return brand === '红米' || brand.toUpperCase() === 'REDMI' ? '小米' : brand;
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

function isPositionPivotChanged(position: PositionAnalysisItem) {
  return Math.abs(position.diff) > SERIES_PIVOT_IGNORE_AMOUNT;
}

function getPositionPivotDisplayChange(position: PositionAnalysisItem) {
  if (!isPositionPivotChanged(position)) {
    return {
      diff: 0,
      diffPct: 0,
    };
  }

  return {
    diff: position.diff,
    diffPct: position.diffPct,
  };
}

function sortPositionPivotRows(items: PositionAnalysisItem[]) {
  return [...items].sort((left, right) => {
    const leftHasChange = isPositionPivotChanged(left);
    const rightHasChange = isPositionPivotChanged(right);

    if (leftHasChange !== rightHasChange) {
      return leftHasChange ? -1 : 1;
    }

    const magnitudeDiff = Math.abs(right.diff) - Math.abs(left.diff);
    if (magnitudeDiff !== 0) {
      return magnitudeDiff;
    }

    const directionDiff = right.diff - left.diff;
    if (directionDiff !== 0) {
      return directionDiff;
    }

    return compareText(left.position, right.position);
  });
}

function getFirstFinalPriceDate(sku: SKUData) {
  return sku.snapshots.find((snapshot) => snapshot.finalPrice)?.date ?? '';
}

function getAggregationSnapshots(sku: SKUData, dates: string[]) {
  const snapshotByDate = new Map(sku.snapshots.map((snapshot) => [snapshot.date, snapshot]));
  const normalizedSnapshots: PriceSnapshot[] = [];
  let previousSnapshot: PriceSnapshot | null = null;

  dates.forEach((date) => {
    const snapshot = snapshotByDate.get(date);
    if (snapshot?.isDelisted) {
      previousSnapshot = null;
      return;
    }

    if (snapshot && snapshot.finalPrice > 0) {
      normalizedSnapshots.push(snapshot);
      previousSnapshot = snapshot;
      return;
    }

    if (previousSnapshot) {
      normalizedSnapshots.push({ ...previousSnapshot, date });
    }
  });

  return normalizedSnapshots;
}

function hasLatestAggregationPrice(snapshots: PriceSnapshot[], dates: string[]) {
  return snapshots.at(-1)?.date === dates.at(-1);
}

function getSnapshotRecentChange(snapshots: PriceSnapshot[]) {
  const last = snapshots[snapshots.length - 1];
  const prev = snapshots[snapshots.length - 2] ?? last;
  return last ? last.finalPrice - prev.finalPrice : 0;
}

function hasPositionPivotPriceOnEveryDate(sku: SKUData, dates: string[]) {
  const normalizedSnapshots = getAggregationSnapshots(sku, dates);
  return dates.every((date) =>
    normalizedSnapshots.some((snapshot) => snapshot.date === date && snapshot.finalPrice),
  );
}

function filterPositionPivotSkus(skuList: AnalysisSKU[], dates: string[], scope: PositionPivotScope) {
  if (scope === 'stable') {
    return skuList.filter((sku) => hasPositionPivotPriceOnEveryDate(sku, dates));
  }

  if (scope === 'new526') {
    return skuList.filter((sku) => getFirstFinalPriceDate(sku) === NEW_BATCH_START_DATE);
  }

  return skuList;
}

function buildPositionAnalysisForSkus(skuList: AnalysisSKU[], dates: string[], includeLaunchTrendPoint = true) {
  const positionMap = new Map<
    string,
    {
      skuCount: number;
      launchPrices: number[];
      snapshotPrices: Record<string, number[]>;
      directionSummary: {
        up: number;
        down: number;
        flat: number;
      };
    }
  >();

  skuList.forEach((sku) => {
    const normalizedSnapshots = getAggregationSnapshots(sku, dates);
    if (!hasLatestAggregationPrice(normalizedSnapshots, dates)) {
      return;
    }
    const positionName = sku.position || '未定位';
    const positionCurrent = positionMap.get(positionName) ?? {
      skuCount: 0,
      launchPrices: [],
      snapshotPrices: {},
      directionSummary: {
        up: 0,
        down: 0,
        flat: 0,
      },
    };

    positionCurrent.skuCount += 1;
    positionCurrent.launchPrices.push(sku.launchPrice);
    normalizedSnapshots.forEach((snapshot) => {
      if (!positionCurrent.snapshotPrices[snapshot.date]) {
        positionCurrent.snapshotPrices[snapshot.date] = [];
      }

      positionCurrent.snapshotPrices[snapshot.date].push(snapshot.finalPrice);
    });

    const recentChange = getSnapshotRecentChange(normalizedSnapshots);
    if (recentChange > 0) {
      positionCurrent.directionSummary.up += 1;
    } else if (recentChange < 0) {
      positionCurrent.directionSummary.down += 1;
    } else {
      positionCurrent.directionSummary.flat += 1;
    }

    positionMap.set(positionName, positionCurrent);
  });

  return sortPositionPivotRows(
    Array.from(positionMap.entries()).map(([position, data]) => {
      const avgLaunch = data.launchPrices.reduce((sum, value) => sum + value, 0) / data.launchPrices.length;
      const snapshotAvgs = dates
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
        position,
        skuCount: data.skuCount,
        avgLaunch,
        snapshotAvgs,
        diff,
        diffPct,
        trendData: includeLaunchTrendPoint ? [{ date: '发布', avgPrice: avgLaunch }, ...snapshotAvgs] : snapshotAvgs,
        directionSummary: data.directionSummary,
      };
    }),
  );
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

function MarketShareChangeBadge({
  value,
  formatter,
}: {
  value: number;
  formatter: (value: number) => string;
}) {
  const isFlat = isZeroChange(value);
  const className = isFlat
    ? 'market-share-change-badge market-share-change-flat'
    : value > 0
      ? 'market-share-change-badge market-share-change-up'
      : 'market-share-change-badge market-share-change-down';
  const arrow = isFlat ? '→' : value > 0 ? '↗' : '↘';

  return (
    <span className={className}>
      <span className="market-share-change-arrow">{arrow}</span>
      {formatter(value)}
    </span>
  );
}

function BrandLogoIcon({
  brand,
}: {
  brand: 'apple' | 'huawei' | 'oppo';
}) {
  const config = {
    apple: {
      label: 'Apple',
      src: 'https://api.iconify.design/simple-icons/apple.svg?color=%23111827',
      className: 'brand-logo-icon brand-logo-apple',
    },
    huawei: {
      label: 'Huawei',
      src: 'https://api.iconify.design/simple-icons/huawei.svg?color=%23DC2626',
      className: 'brand-logo-icon brand-logo-huawei',
    },
    oppo: {
      label: 'OPPO',
      src: 'https://api.iconify.design/simple-icons/oppo.svg?color=%23F97316',
      className: 'brand-logo-icon brand-logo-oppo',
    },
  }[brand];

  return (
    <span className={config.className}>
      <img src={config.src} alt={config.label} />
    </span>
  );
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
  const isNegative = value < 0;
  const labelX = isNegative ? Math.min(x, x + width) - 10 : Math.max(x, x + width) + 10;

  return (
    <text
      x={labelX}
      y={y + height / 2}
      textAnchor={isNegative ? 'end' : 'start'}
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
  const mixedModelSet = new Set<string>();
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
    const hasListChange = Math.abs(sku.listPriceDiff) >= CHANGE_SUMMARY_MIN_AMOUNT;
    const hasCouponChange = Math.abs(sku.couponDiff) >= CHANGE_SUMMARY_MIN_AMOUNT;

    if (!hasListChange || !hasCouponChange) {
      return;
    }

    mixedModelSet.add(sku.model);

    if (sku.listPriceDiff > 0 && sku.couponDiff > 0) {
      ensureMixedItem(mixedMaps.listUpCouponUp, sku);
    } else if (sku.listPriceDiff > 0 && sku.couponDiff < 0) {
      ensureMixedItem(mixedMaps.listUpCouponDown, sku);
    } else if (sku.listPriceDiff < 0 && sku.couponDiff > 0) {
      ensureMixedItem(mixedMaps.listDownCouponUp, sku);
    } else {
      ensureMixedItem(mixedMaps.listDownCouponDown, sku);
    }
  });

  skuList.forEach((sku) => {
    if (mixedModelSet.has(sku.model)) {
      return;
    }

    const hasListChange = Math.abs(sku.listPriceDiff) >= CHANGE_SUMMARY_MIN_AMOUNT;
    const hasCouponChange = Math.abs(sku.couponDiff) >= CHANGE_SUMMARY_MIN_AMOUNT;

    if (hasListChange && !hasCouponChange) {
      ensureRangeItem(sku.listPriceDiff > 0 ? listOnlyUpMap : listOnlyDownMap, sku, sku.listPriceDiff);
      return;
    }

    if (!hasListChange && hasCouponChange) {
      ensureRangeItem(sku.couponDiff > 0 ? couponOnlyUpMap : couponOnlyDownMap, sku, sku.couponDiff);
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
            biPrice: snapshot?.biPrice ? String(Math.round(snapshot.biPrice)) : '',
          },
        ];
      }),
    );

    return {
      id: sku.id,
      model: sku.model,
      brand: normalizeConfiguredBrand(sku.brand),
      storage: sku.storage,
      position: sku.position,
      ppv: sku.ppv,
      launchPrice: String(Math.round(sku.launchPrice)),
      snapshots: snapshotMap,
    };
  });
}

function createEmptyRawEditorRow(dates: string[], index: number): RawEditorRow {
  return {
    id: `raw-${Date.now()}-${index}`,
    model: '',
    brand: '',
    storage: '',
    position: '',
    ppv: '',
    launchPrice: '',
    snapshots: Object.fromEntries(
      dates.map((date) => [
        date,
        {
          finalPrice: '',
          listPrice: '',
          coupon: '',
          biPrice: '',
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
    ...dates.flatMap(
      (date) => [`${date}::finalPrice`, `${date}::listPrice`, `${date}::coupon`, `${date}::biPrice`] as RawEditorColumnKey[],
    ),
  ];
}

function updateRawEditorCell(row: RawEditorRow, columnKey: RawEditorColumnKey, value: string) {
  if (columnKey === 'model' || columnKey === 'storage' || columnKey === 'launchPrice') {
    return {
      ...row,
      [columnKey]: value,
    };
  }

  const [date, metric] = columnKey.split('::') as [string, 'finalPrice' | 'listPrice' | 'coupon' | 'biPrice'];
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

      const brand = normalizeConfiguredBrand(row.brand ?? '') || inferBrand(model);
      const series = inferSeries(model, brand);
      const ppvMapping = getNewMachinePpvMapping(model, storage);
      const position = (row.position ?? '').trim();
      const ppv = (row.ppv ?? '').trim();
      const snapshots = dates
        .map((date) => {
          const snapshot = row.snapshots[date];
          if (!snapshot) {
            return null;
          }

          const finalPrice = parseNumericInput(snapshot.finalPrice);
          const listPrice = parseNumericInput(snapshot.listPrice);
          const coupon = parseNumericInput(snapshot.coupon);
          const biPrice = parseNumericInput(snapshot.biPrice ?? '');
          const isDelisted =
            isDelistedInput(snapshot.finalPrice) || isDelistedInput(snapshot.listPrice) || isDelistedInput(snapshot.coupon);
          const hasInputValue = Boolean(
            snapshot.finalPrice.trim() || snapshot.listPrice.trim() || snapshot.coupon.trim() || snapshot.biPrice?.trim(),
          );

          if (!finalPrice && !listPrice && !coupon && !biPrice && !hasInputValue) {
            return null;
          }

          const priceSnapshot: PriceSnapshot = {
            date,
            finalPrice,
            listPrice,
            coupon,
            biPrice: biPrice || undefined,
            isDelisted: isDelisted || undefined,
          };

          return priceSnapshot;
        })
        .filter((item): item is PriceSnapshot => item !== null);

      return {
        id: `${model}-${storage}-${index + 1}`,
        brand,
        model,
        series,
        storage,
        position: position || ppvMapping?.position || '',
        ppv: ppv || ppvMapping?.ppv || '',
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
  const aggregationSkus = processed
    .map((sku) => ({ sku, snapshots: getAggregationSnapshots(sku, dataset.dates) }))
    .filter((item) => hasLatestAggregationPrice(item.snapshots, dataset.dates));

  const brandMap = new Map<string, { changePctTotal: number; count: number }>();
  aggregationSkus.forEach(({ sku, snapshots }) => {
    const recentChange = getSnapshotRecentChange(snapshots);
    const previousPrice = snapshots[snapshots.length - 2]?.finalPrice ?? snapshots.at(-1)?.finalPrice ?? 0;
    const recentChangePct = previousPrice ? (recentChange / previousPrice) * 100 : 0;
    const current = brandMap.get(sku.brand) ?? { changePctTotal: 0, count: 0 };
    brandMap.set(sku.brand, {
      changePctTotal: current.changePctTotal + recentChangePct,
      count: current.count + 1,
    });
  });

  const brandAnalysis = Array.from(brandMap.entries())
    .map(([name, data]) => ({
      name,
      avgRecentChangePct: Number((data.changePctTotal / data.count).toFixed(2)),
    }))
    .sort((left, right) => right.avgRecentChangePct - left.avgRecentChangePct);

  const positionMap = new Map<
    string,
    {
      skuCount: number;
      launchPrices: number[];
      snapshotPrices: Record<string, number[]>;
      directionSummary: {
        up: number;
        down: number;
        flat: number;
      };
    }
  >();
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

  aggregationSkus.forEach(({ sku, snapshots }) => {
    const positionName = sku.position || '未定位';
    const positionCurrent = positionMap.get(positionName) ?? {
      skuCount: 0,
      launchPrices: [],
      snapshotPrices: {},
      directionSummary: {
        up: 0,
        down: 0,
        flat: 0,
      },
    };
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

    positionCurrent.skuCount += 1;
    positionCurrent.launchPrices.push(sku.launchPrice);
    current.launchPrices.push(sku.launchPrice);
    snapshots.forEach((snapshot) => {
      if (!positionCurrent.snapshotPrices[snapshot.date]) {
        positionCurrent.snapshotPrices[snapshot.date] = [];
      }

      positionCurrent.snapshotPrices[snapshot.date].push(snapshot.finalPrice);

      if (!current.snapshotPrices[snapshot.date]) {
        current.snapshotPrices[snapshot.date] = [];
      }

      current.snapshotPrices[snapshot.date].push(snapshot.finalPrice);
    });

    const recentChange = getSnapshotRecentChange(snapshots);
    if (recentChange > 0) {
      positionCurrent.directionSummary.up += 1;
      current.directionSummary.up += 1;
    } else if (recentChange < 0) {
      positionCurrent.directionSummary.down += 1;
      current.directionSummary.down += 1;
    } else {
      positionCurrent.directionSummary.flat += 1;
      current.directionSummary.flat += 1;
    }

    positionMap.set(positionName, positionCurrent);
    seriesMap.set(sku.model, current);
  });

  const positionAnalysis = sortPositionPivotRows(
    Array.from(positionMap.entries()).map(([position, data]) => {
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
        position,
        skuCount: data.skuCount,
        avgLaunch,
        snapshotAvgs,
        diff,
        diffPct,
        trendData: [{ date: '发布', avgPrice: avgLaunch }, ...snapshotAvgs],
        directionSummary: data.directionSummary,
      };
    }),
  );

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
    positionAnalysis,
    seriesAnalysis,
  };
}

export default function App() {
  const [sourceDataset, setSourceDataset] = useState<WorkbookDataset | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [view, setView] = useState<ViewMode>('dashboard');
  const [positionPivotScope, setPositionPivotScope] = useState<PositionPivotScope>('stable');
  const [attributionFilter, setAttributionFilter] = useState('all');
  const [rawEditorDates, setRawEditorDates] = useState<string[]>([]);
  const [rawEditorRows, setRawEditorRows] = useState<RawEditorRow[]>([]);
  const [rawEditorMessage, setRawEditorMessage] = useState<string | null>(null);
  const [rawEditorDateInput, setRawEditorDateInput] = useState('');
  const [biPriceRows, setBiPriceRows] = useState<BiPriceRow[]>([]);
  const [riskMessage, setRiskMessage] = useState<string | null>(null);
  const [isRiskLoading, setIsRiskLoading] = useState(false);
  const [riskConfirmedAt, setRiskConfirmedAt] = useState<string | null>(null);
  const [marketTrendOverview, setMarketTrendOverview] = useState<MarketTrendOverview | null>(null);
  const [marketTrendPayload, setMarketTrendPayload] = useState<MarketTrendPayload | null>(null);
  const [marketTrendMessage, setMarketTrendMessage] = useState<string | null>(null);
  const [isMarketTrendLoading, setIsMarketTrendLoading] = useState(true);
  const [marketTrendError, setMarketTrendError] = useState<string | null>(null);
  const hasHydratedRawDraftRef = useRef(false);
  const hasHydratedMarketTrendRef = useRef(false);
  const rawDraftAutosaveTimerRef = useRef<number | null>(null);
  const marketTrendAutosaveTimerRef = useRef<number | null>(null);
  const lastSavedRawDraftSignatureRef = useRef('');
  const lastSavedMarketTrendSignatureRef = useRef('');

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
          const workbookBrandByModel = new Map(
            nextDataset.skus.map((sku) => [sku.model.trim(), sku.brand.trim()] as const),
          );
          const restoredRows = persistedDraft.rows.map((row) => ({
            ...row,
            brand: normalizeConfiguredBrand(
              (row.brand ?? '').trim() ||
              workbookBrandByModel.get(String(row.model ?? '').trim()) ||
              inferBrand(String(row.model ?? '').trim()),
            ),
          }));
          setRawEditorDates(persistedDraft.dates);
          setRawEditorRows(restoredRows);
          setSourceDataset(buildDatasetFromRawEditorRows(restoredRows, persistedDraft.dates, nextDataset.sourceName));
          setRawEditorMessage('已恢复上次保存的原始数据草稿');
          lastSavedRawDraftSignatureRef.current = JSON.stringify({
            dates: persistedDraft.dates,
            rows: restoredRows,
          });
        } else {
          const workbookRows = datasetToRawEditorRows(nextDataset);
          setRawEditorDates(nextDataset.dates);
          setRawEditorRows(workbookRows);
          setSourceDataset(buildDatasetFromRawEditorRows(workbookRows, nextDataset.dates, nextDataset.sourceName));
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
    let cancelled = false;
    setIsMarketTrendLoading(true);
    loadMarketTrendOverview()
      .then((overview) => {
        if (cancelled) {
          return;
        }
        setMarketTrendOverview(overview);
        setMarketTrendPayload(overview.payload);
        setMarketTrendError(null);
        lastSavedMarketTrendSignatureRef.current = JSON.stringify(overview.payload);
        hasHydratedMarketTrendRef.current = true;
      })
      .catch((loadError) => {
        if (cancelled) {
          return;
        }
        setMarketTrendError(loadError instanceof Error ? loadError.message : '市场趋势数据读取失败');
        hasHydratedMarketTrendRef.current = true;
      })
      .finally(() => {
        if (!cancelled) {
          setIsMarketTrendLoading(false);
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

  useEffect(() => {
    if (!hasHydratedMarketTrendRef.current || !marketTrendPayload) {
      return;
    }

    const nextSignature = JSON.stringify(marketTrendPayload);
    if (nextSignature === lastSavedMarketTrendSignatureRef.current) {
      return;
    }

    if (marketTrendAutosaveTimerRef.current) {
      window.clearTimeout(marketTrendAutosaveTimerRef.current);
    }

    marketTrendAutosaveTimerRef.current = window.setTimeout(() => {
      persistMarketTrendDraft(marketTrendPayload)
        .then(() => {
          lastSavedMarketTrendSignatureRef.current = nextSignature;
          setMarketTrendMessage((currentMessage) => currentMessage ?? '市场趋势草稿已自动保存');
        })
        .catch((saveError) => {
          setMarketTrendMessage(saveError instanceof Error ? saveError.message : '市场趋势草稿自动保存失败');
        });
    }, RAW_DRAFT_AUTOSAVE_MS);

    return () => {
      if (marketTrendAutosaveTimerRef.current) {
        window.clearTimeout(marketTrendAutosaveTimerRef.current);
      }
    };
  }, [marketTrendPayload]);
  const dataset = sourceDataset;
  const dates = dataset?.dates ?? [];

  const analysis = useMemo(() => buildAnalysis(dataset), [dataset]);
  const scopedPositionAnalysis = useMemo(() => {
    const selectedSkus = filterPositionPivotSkus(analysis.skuList, dates, positionPivotScope);
    return buildPositionAnalysisForSkus(selectedSkus, dates, positionPivotScope !== 'new526');
  }, [analysis.skuList, dates, positionPivotScope]);
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
  const biPriceMap = useMemo(() => new Map(biPriceRows.map((row) => [row.ppv, row.biPrice])), [biPriceRows]);
  const riskRows = useMemo<RiskAnalysisRow[]>(
    () =>
      analysis.skuList
        .map((sku) => {
          const latestSnapshot = sku.snapshots.at(-1) ?? null;
          const biPrice = sku.ppv ? biPriceMap.get(sku.ppv) ?? latestSnapshot?.biPrice ?? null : latestSnapshot?.biPrice ?? null;
          const diff = latestSnapshot && biPrice ? biPrice - latestSnapshot.finalPrice : null;

          return {
            sku,
            latestSnapshot,
            biPrice,
            diff,
            riskLevel: latestSnapshot ? getRiskLevel(latestSnapshot.finalPrice, biPrice) : 'unmatched',
          };
        })
        .sort((left, right) => {
          const priority = { high: 0, risk: 1, unmatched: 2, none: 3 };
          const priorityDiff = priority[left.riskLevel] - priority[right.riskLevel];
          if (priorityDiff !== 0) {
            return priorityDiff;
          }

          return (right.diff ?? Number.NEGATIVE_INFINITY) - (left.diff ?? Number.NEGATIVE_INFINITY);
        }),
    [analysis.skuList, biPriceMap],
  );
  const riskStats = useMemo(
    () => ({
      high: riskRows.filter((row) => row.riskLevel === 'high').length,
      risk: riskRows.filter((row) => row.riskLevel === 'risk').length,
      none: riskRows.filter((row) => row.riskLevel === 'none').length,
      unmatched: riskRows.filter((row) => row.riskLevel === 'unmatched').length,
      ppvMatched: analysis.skuList.filter((sku) => sku.ppv).length,
    }),
    [analysis.skuList, riskRows],
  );
  const riskBiPriceCount = useMemo(() => riskRows.filter((row) => row.biPrice).length, [riskRows]);

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
    metric: 'finalPrice' | 'listPrice' | 'coupon' | 'biPrice',
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

  const handleRawBulkPaste = (
    rowId: string,
    columnKey: RawEditorColumnKey,
    pastedText: string,
    columnKeys: RawEditorColumnKey[],
  ) => {
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
      dataset?.sourceName ?? '新机售价监控.xlsx',
    );
    setSourceDataset(nextDataset);
    try {
      const persisted = await persistRawEditorDraft(nextDraft, { syncWorkbook: true });
      lastSavedRawDraftSignatureRef.current = JSON.stringify({
        dates: nextDraft.dates,
        rows: nextDraft.rows,
      });
      const workbookCellsWritten = Number(persisted?.workbook?.cellsWritten ?? persisted?.workbook?.rowsWritten ?? 0);
      const workbookRowsAppended = Number(persisted?.workbook?.rowsAppended ?? 0);
      setRawEditorMessage(
        `已保存、写回 Excel ${workbookCellsWritten} 格${workbookRowsAppended ? `，新增 ${workbookRowsAppended} 行` : ''}并重算结果：${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`,
      );
    } catch {
      setRawEditorMessage('结果已重算，但服务端保存或 Excel 写回失败');
    }
  };

  const handleSaveRawModelConfigs = async (configs: RawModelConfig[]) => {
    const invalidConfig = configs.find((config) => !config.brand.trim() || !config.position.trim());
    if (invalidConfig) {
      const missingFields = [
        !invalidConfig.brand.trim() ? '品牌' : '',
        !invalidConfig.position.trim() ? '机型定位' : '',
      ].filter(Boolean);
      setRawEditorMessage(`型号“${invalidConfig.model}”的${missingFields.join('、')}不能为空，请补充后再保存`);
      return;
    }

    const configByModel = new Map(
      configs.map((config) => [config.model.trim(), { ...config, brand: normalizeConfiguredBrand(config.brand) }] as const),
    );
    const nextRows = rawEditorRows.map((row) => {
      const config = configByModel.get(row.model.trim());
      return config
        ? {
            ...row,
            brand: config.brand.trim(),
            position: config.position.trim(),
          }
        : row;
    });
    const nextDraft: RawEditorDraft = {
      dates: rawEditorDates,
      rows: nextRows,
      savedAt: new Date().toISOString(),
    };
    const nextDataset = buildDatasetFromRawEditorRows(
      nextDraft.rows,
      nextDraft.dates,
      dataset?.sourceName ?? '新机售价监控.xlsx',
    );

    setRawEditorRows(nextRows);
    setSourceDataset(nextDataset);
    try {
      const persisted = await persistRawEditorDraft(nextDraft, { syncWorkbook: true });
      lastSavedRawDraftSignatureRef.current = JSON.stringify({
        dates: nextDraft.dates,
        rows: nextDraft.rows,
      });
      const workbookCellsWritten = Number(persisted?.workbook?.cellsWritten ?? persisted?.workbook?.rowsWritten ?? 0);
      setRawEditorMessage(`已保存 ${configs.length} 个型号配置，并写回 Excel ${workbookCellsWritten} 格`);
    } catch {
      setRawEditorMessage('型号配置已应用并重算，但服务端保存或 Excel 写回失败');
    }
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
            biPrice: '',
          },
        },
      })),
    );
    setRawEditorDateInput('');
    setRawEditorMessage(`已新增 ${normalizedDate} 的国补后 / 挂牌价 / 优惠券 / BI出货价四列`);
  };

  const handleFetchBiPrices = async () => {
    const ppvs: string[] = Array.from(
      new Set<string>(analysis.skuList.map((sku) => sku.ppv).filter((ppv): ppv is string => Boolean(ppv))),
    );
    if (ppvs.length === 0) {
      setRiskMessage('当前底表没有可查询的 PPV');
      return;
    }

    setIsRiskLoading(true);
    try {
      const lookupResult = await lookupBiPrices(ppvs);
      setBiPriceRows(lookupResult.rows);
      setRiskConfirmedAt(null);
      const matchedCount = lookupResult.rows.filter((row) => row.matched && row.biPrice).length;
      setRiskMessage(`已拉取 ${matchedCount}/${lookupResult.rows.length} 条 BI 出货价，请核对后确认落数`);
    } catch (lookupError) {
      setBiPriceRows([]);
      setRiskConfirmedAt(null);
      setRiskMessage(lookupError instanceof Error ? lookupError.message : 'BI 出货价接口调用失败');
    } finally {
      setIsRiskLoading(false);
    }
  };

  const handleBiPriceChange = (ppv: string, value: string) => {
    const biPrice = parseNumericInput(value);
    setBiPriceRows((currentRows) => {
      if (currentRows.some((row) => row.ppv === ppv)) {
        return currentRows.map((row) =>
          row.ppv === ppv
            ? {
                ...row,
                biPrice: biPrice > 0 ? biPrice : null,
                matched: biPrice > 0 ? row.matched : false,
              }
            : row,
        );
      }

      return [
        ...currentRows,
        {
          ppv,
          biPrice: biPrice > 0 ? biPrice : null,
          matched: biPrice > 0,
          matchedPpv: ppv,
          dataDate: null,
        },
      ];
    });
    setRiskConfirmedAt(null);
  };

  const handleConfirmRiskPrices = async () => {
    const targetDate = rawEditorDates.at(-1) ?? latestDate;
    const confirmedRows = riskRows.filter(
      (row): row is RiskAnalysisRow & { sku: AnalysisSKU & { ppv: string }; biPrice: number } => Boolean(row.sku.ppv && row.biPrice),
    );

    if (!targetDate || targetDate === '--') {
      setRiskMessage('当前没有可落数的日期');
      return;
    }

    if (confirmedRows.length === 0) {
      setRiskMessage('请先拉取 BI 出货价');
      return;
    }

    const confirmedAt = new Date().toISOString();
    const biPriceByPpv = new Map<string, number>(confirmedRows.map((row) => [row.sku.ppv, row.biPrice]));
    const nextRows = rawEditorRows.map((row) => {
      const ppvMapping = getNewMachinePpvMapping(row.model, row.storage);
      const rowPpv = row.ppv || ppvMapping?.ppv || '';
      const biPrice = rowPpv ? biPriceByPpv.get(rowPpv) : null;
      if (!biPrice) {
        return row;
      }

      const currentSnapshot = row.snapshots[targetDate] ?? {
        finalPrice: '',
        listPrice: '',
        coupon: '',
        biPrice: '',
      };

      return {
        ...row,
        position: row.position || ppvMapping?.position || '',
        ppv: rowPpv,
        snapshots: {
          ...row.snapshots,
          [targetDate]: {
            ...currentSnapshot,
            biPrice: String(Math.round(biPrice)),
          },
        },
      };
    });
    const nextDates = rawEditorDates.includes(targetDate) ? rawEditorDates : [...rawEditorDates, targetDate].sort(sortDateLabels);
    const nextDraft = {
      dates: nextDates,
      rows: nextRows,
      savedAt: confirmedAt,
    };
    const nextDataset = buildDatasetFromRawEditorRows(nextDraft.rows, nextDraft.dates, dataset?.sourceName ?? '新机售价监控.xlsx');

    setRawEditorDates(nextDates);
    setRawEditorRows(nextRows);
    setSourceDataset(nextDataset);
    setRiskConfirmedAt(confirmedAt);

    try {
      const persisted = await persistRawEditorDraft(nextDraft, {
        syncWorkbook: true,
        workbookSyncMode: 'latestBiPriceOnly',
        workbookTargetDate: targetDate,
        workbookTargetPpvs: confirmedRows.map((row) => row.sku.ppv),
      });
      lastSavedRawDraftSignatureRef.current = JSON.stringify({
        dates: nextDraft.dates,
        rows: nextDraft.rows,
      });
      const workbookCellsWritten = Number(persisted?.workbook?.cellsWritten ?? persisted?.workbook?.rowsWritten ?? 0);
      const workbookRowsAppended = Number(persisted?.workbook?.rowsAppended ?? 0);
      setRiskMessage(
        `已确认落数 ${confirmedRows.length} 条，已写回 Excel ${workbookCellsWritten} 格${workbookRowsAppended ? `，新增 ${workbookRowsAppended} 行` : ''}：${new Date(confirmedAt).toLocaleTimeString('zh-CN', {
          hour: '2-digit',
          minute: '2-digit',
        })}`,
      );
    } catch (saveError) {
      setRiskMessage(saveError instanceof Error ? `BI 价已写入当前页面，但保存失败：${saveError.message}` : 'BI 价已写入当前页面，但保存失败');
    }
  };

  const handleExportRiskReport = () => {
    if (!riskConfirmedAt) {
      setRiskMessage('请先确认落数，再输出风险报告');
      return;
    }

    const reportRows = riskRows.filter((row) => row.riskLevel === 'high' || row.riskLevel === 'risk');
    const exportRows = reportRows.length > 0 ? reportRows : riskRows;
    downloadTextFile(`S等级风险报告_${latestDate}.csv`, buildRiskReportCsv(exportRows, latestDate), 'text/csv;charset=utf-8');
    setRiskMessage(`已输出风险报告：${reportRows.length} 条风险 SKU`);
  };

  const handleDownloadRawData = () => {
    downloadRawEditorWorkbook(rawEditorDates, rawEditorRows);
  };

  const handleApplyMarketTrend = async () => {
    if (!marketTrendPayload) {
      return;
    }

    try {
      const result = await applyMarketTrendPayload(marketTrendPayload);
      setMarketTrendOverview(result.overview);
      setMarketTrendPayload(result.overview.payload);
      lastSavedMarketTrendSignatureRef.current = JSON.stringify(result.overview.payload);
      setMarketTrendMessage(`市场趋势已写回 Excel：${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`);
    } catch (saveError) {
      setMarketTrendMessage(saveError instanceof Error ? saveError.message : '市场趋势写回失败');
    }
  };

  const handleConfirmMarketTrendWeek = async (weekInput: MarketTrendWeekInput, allowUpdate: boolean) => {
    const result = await confirmMarketTrendWeek(weekInput, allowUpdate);
    setMarketTrendOverview(result.overview);
    setMarketTrendPayload(result.overview.payload);
    lastSavedMarketTrendSignatureRef.current = JSON.stringify(result.overview.payload);
    setMarketTrendMessage(`${weekInput.week} 数据已成功落库并写回 Excel`);
  };

  const handleDownloadMarketTrend = () => {
    if (!marketTrendOverview) {
      return;
    }
    const weeks = getMarketTrendWeeks(marketTrendOverview);
    const rows = [
      ['品牌', ...weeks, '最新周份额', '较上周变化'],
      ...MARKET_TREND_CORE_BRANDS.map((brand) => {
        const latest = getMarketTrendShare(marketTrendOverview, brand, weeks.at(-1) ?? '');
        const previous = getMarketTrendShare(marketTrendOverview, brand, weeks.at(-2) ?? '');
        return [
          brand,
          ...weeks.map((week) => getMarketTrendShare(marketTrendOverview, brand, week) ?? ''),
          latest ?? '',
          latest !== null && previous !== null ? Number((latest - previous).toFixed(1)) : '',
        ];
      }),
    ];
    const worksheet = XLSX.utils.aoa_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, '品牌周度份额');
    XLSX.writeFile(workbook, `市场总量份额趋势_${marketTrendOverview.summary.latestWeek}.xlsx`);
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
            <div className="flex items-center gap-3">
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
                  onClick={() => setView('risk')}
                  className={`flex items-center gap-2 rounded-lg px-4 py-1.5 text-sm font-medium transition-all ${
                    view === 'risk' ? 'bg-white text-orange-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  <Upload size={16} /> S等级风险
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
              <div className="flex rounded-xl bg-gray-100 p-1">
                <button
                  onClick={() => setView('marketTrend')}
                  className={`flex items-center gap-2 rounded-lg px-4 py-1.5 text-sm font-medium transition-all ${
                    view === 'marketTrend' ? 'bg-white text-orange-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  <BarChart3 size={16} /> 市场趋势
                </button>
                <button
                  onClick={() => setView('weeklySales')}
                  className={`flex items-center gap-2 rounded-lg px-4 py-1.5 text-sm font-medium transition-all ${
                    view === 'weeklySales' ? 'bg-white text-orange-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  <BarChart3 size={16} /> 新品周销
                </button>
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1600px] space-y-6 p-6">
        {view === 'weeklySales' ? (
          <WeeklySalesPanel />
        ) : isLoading ? (
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

            <div className="mb-6 overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 p-6">
                <h2 className="text-lg font-bold">机型定位透视表 (汇总层)</h2>
                <div className="flex flex-wrap items-center gap-3">
                  <div className="inline-flex rounded-lg border border-gray-200 bg-gray-50 p-1">
                    {POSITION_PIVOT_SCOPE_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => setPositionPivotScope(option.value)}
                        className={`rounded-md px-3 py-1.5 text-xs font-bold transition-colors ${
                          positionPivotScope === option.value
                            ? 'bg-white text-orange-600 shadow-sm'
                            : 'text-gray-500 hover:bg-white/70 hover:text-gray-900'
                        }`}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                  <span className="rounded bg-orange-50 px-2 py-1 text-[10px] font-bold uppercase text-orange-600">
                    {latestRangeLabel} Data
                  </span>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-max border-collapse text-left">
                  <thead>
                    <tr className="bg-gray-50/50">
                      <th className="sticky left-0 z-30 min-w-[150px] border-r border-gray-100 bg-gray-50/95 px-6 py-3 text-xs font-bold uppercase tracking-wider text-gray-500">
                        机型定位
                      </th>
                      <th className="sticky left-[150px] z-20 min-w-[110px] border-r border-gray-100 bg-gray-50/95 px-6 py-3 text-xs font-bold uppercase tracking-wider text-gray-500">
                        SKU 数
                      </th>
                      <th className="sticky left-[260px] z-10 min-w-[210px] border-r border-gray-100 bg-gray-50/95 px-6 py-3 text-xs font-bold uppercase tracking-wider text-gray-500">
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
                    {scopedPositionAnalysis.map((position) => {
                      const displayChange = getPositionPivotDisplayChange(position);
                      const hasChange = isPositionPivotChanged(position);
                      const rowClassName = hasChange ? 'bg-orange-50/40 hover:bg-orange-50/70' : 'bg-white hover:bg-gray-50/50';
                      const stickyClassName = hasChange ? 'bg-orange-50/90' : 'bg-white';

                      return (
                        <tr key={position.position} className={`transition-colors ${rowClassName}`}>
                          <td
                            className={`sticky left-0 z-30 min-w-[150px] border-r border-gray-100 px-6 py-2.5 text-sm font-bold shadow-[2px_0_5px_-2px_rgba(0,0,0,0.05)] ${stickyClassName}`}
                          >
                            {position.position}
                          </td>
                          <td
                            className={`sticky left-[150px] z-20 min-w-[110px] border-r border-gray-100 px-6 py-2.5 text-sm font-semibold text-gray-600 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.04)] ${stickyClassName}`}
                          >
                            {position.skuCount}
                          </td>
                          <td
                            className={`sticky left-[260px] z-10 min-w-[210px] border-r border-gray-100 px-4 py-2 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.03)] ${stickyClassName}`}
                          >
                            <SeriesTrendChart points={position.trendData} diffPct={displayChange.diffPct} />
                          </td>
                          <td className="px-6 py-2.5 text-sm text-gray-500">{formatPrice(position.avgLaunch)}</td>
                          {dates.map((date) => {
                            const point = position.snapshotAvgs.find((item) => item.date === date);
                            return (
                              <td key={`${position.position}-${date}`} className="px-6 py-2.5 text-sm font-medium">
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
                            {position.directionSummary.up}涨 / {position.directionSummary.down}跌 / {position.directionSummary.flat}平
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
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
        ) : view === 'risk' ? (
          <RiskMonitorPanel
            latestDate={latestDate}
            riskRows={riskRows}
            riskStats={riskStats}
            riskMessage={riskMessage}
            isLoading={isRiskLoading}
            confirmedAt={riskConfirmedAt}
            uploadedCount={riskBiPriceCount}
            onFetch={handleFetchBiPrices}
            onBiPriceChange={handleBiPriceChange}
            onConfirm={handleConfirmRiskPrices}
            onExport={handleExportRiskReport}
          />
        ) : view === 'marketTrend' ? (
          <MarketTrendPanel
            overview={marketTrendOverview}
            isLoading={isMarketTrendLoading}
            error={marketTrendError}
            message={marketTrendMessage}
            onApply={handleApplyMarketTrend}
            onConfirmWeek={handleConfirmMarketTrendWeek}
            onDownload={handleDownloadMarketTrend}
          />
        ) : view === 'raw' ? (
          <RawDataPanel
            dates={rawEditorDates}
            rawEditorRows={rawEditorRows}
            rawEditorMessage={rawEditorMessage}
            rawEditorDateInput={rawEditorDateInput}
            onApply={handleApplyRawEdits}
            onSaveModelConfigs={handleSaveRawModelConfigs}
            onDateInputChange={setRawEditorDateInput}
            onAddDateColumns={handleAddRawDateColumns}
            onCellChange={handleRawCellChange}
            onSnapshotChange={handleRawSnapshotChange}
            onBulkPaste={handleRawBulkPaste}
            onDownload={handleDownloadRawData}
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
                            <p className="mt-1 max-w-[180px] truncate text-[10px] text-gray-400">
                              {sku.position || '未定位'} · {sku.ppv || '未匹配PPV'}
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

function RiskMonitorPanel({
  latestDate,
  riskRows,
  riskStats,
  riskMessage,
  isLoading,
  confirmedAt,
  uploadedCount,
  onFetch,
  onBiPriceChange,
  onConfirm,
  onExport,
}: {
  latestDate: string;
  riskRows: RiskAnalysisRow[];
  riskStats: {
    high: number;
    risk: number;
    none: number;
    unmatched: number;
    ppvMatched: number;
  };
  riskMessage: string | null;
  isLoading: boolean;
  confirmedAt: string | null;
  uploadedCount: number;
  onFetch: () => void;
  onBiPriceChange: (ppv: string, value: string) => void;
  onConfirm: () => void;
  onExport: () => void;
}) {
  const [riskFilter, setRiskFilter] = useState<RiskLevel | 'all'>('all');
  const filteredRows = riskFilter === 'all' ? riskRows : riskRows.filter((row) => row.riskLevel === riskFilter);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="高风险 SKU"
          value={riskStats.high}
          subValue={`BI 出货价 ≥ ${latestDate} 国补后`}
          trend={riskStats.high > 0 ? 'up' : undefined}
          icon={<Info className="text-red-600" />}
        />
        <MetricCard
          label="有风险 SKU"
          value={riskStats.risk}
          subValue={`BI 出货价 ≥ ${latestDate} 国补后 95%`}
          trend={riskStats.risk > 0 ? 'up' : undefined}
          icon={<TrendingUp className="text-amber-600" />}
        />
        <MetricCard
          label="无风险 SKU"
          value={riskStats.none}
          subValue={`已拉取 BI 价 ${uploadedCount} 条`}
          icon={<TrendingDown className="text-emerald-600" />}
        />
        <MetricCard
          label="未匹配 SKU"
          value={riskStats.unmatched}
          subValue={`底表已匹配 PPV ${riskStats.ppvMatched} 条`}
          icon={<Database className="text-gray-500" />}
        />
      </div>

      <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
        <div className="flex flex-col gap-4 border-b border-gray-100 p-6 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h2 className="text-lg font-bold">S等级回收价风险监控 ({latestDate})</h2>
            <p className="mt-1 text-sm text-gray-500">
              使用底表 ppv 从 daily price API 拉取 S 等级 BI 出货价，核对后确认落数并输出风险报告。
            </p>
            {confirmedAt ? (
              <p className="mt-1 text-xs font-medium text-emerald-600">
                已确认：{new Date(confirmedAt).toLocaleString('zh-CN', { hour12: false })}
              </p>
            ) : (
              <p className="mt-1 text-xs font-medium text-amber-600">当前结果待确认</p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <select
              value={riskFilter}
              onChange={(event) => setRiskFilter(event.target.value as RiskLevel | 'all')}
              className="min-w-[160px] rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm focus:border-orange-400 focus:outline-none focus:ring-2 focus:ring-orange-100"
            >
              <option value="all">全部风险</option>
              <option value="high">高风险</option>
              <option value="risk">有风险</option>
              <option value="none">无风险</option>
                <option value="unmatched">未匹配</option>
              </select>
            <button
              type="button"
              onClick={onFetch}
              disabled={isLoading}
              className="inline-flex items-center gap-2 rounded-xl bg-orange-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-orange-700 disabled:cursor-not-allowed disabled:bg-orange-300"
            >
              <Upload size={16} />
              {isLoading ? '拉取中' : '拉取BI价'}
            </button>
            <button
              type="button"
              onClick={onConfirm}
              className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-700 transition hover:border-emerald-300 hover:bg-emerald-100"
            >
              确认落数
            </button>
            <button
              type="button"
              onClick={onExport}
              className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition hover:border-gray-300 hover:text-gray-900"
            >
              输出风险报告
            </button>
            {riskMessage ? <span className="text-sm font-medium text-gray-600">{riskMessage}</span> : null}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-[1500px] w-full border-collapse text-left">
            <thead>
              <tr className="bg-gray-50/50">
                <th className="border-b border-r border-gray-100 px-4 py-3 text-xs font-bold uppercase tracking-wider text-gray-500">型号</th>
                <th className="border-b border-r border-gray-100 px-4 py-3 text-xs font-bold uppercase tracking-wider text-gray-500">存储</th>
                <th className="border-b border-r border-gray-100 px-4 py-3 text-xs font-bold uppercase tracking-wider text-gray-500">定位</th>
                <th className="border-b border-r border-gray-100 px-4 py-3 text-xs font-bold uppercase tracking-wider text-gray-500">PPV</th>
                <th className="border-b border-r border-gray-100 px-4 py-3 text-xs font-bold uppercase tracking-wider text-gray-500">{latestDate} 国补后</th>
                <th className="border-b border-r border-gray-100 px-4 py-3 text-xs font-bold uppercase tracking-wider text-gray-500">BI出货价</th>
                <th className="border-b border-r border-gray-100 px-4 py-3 text-xs font-bold uppercase tracking-wider text-gray-500">价差</th>
                <th className="border-b px-4 py-3 text-xs font-bold uppercase tracking-wider text-gray-500">判定</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filteredRows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-6 py-10 text-center text-sm text-gray-500">
                    没有匹配当前筛选条件的数据。
                  </td>
                </tr>
              ) : (
                filteredRows.map((row) => (
                  <tr key={row.sku.id} className="transition-colors hover:bg-gray-50/50">
                    <td className="border-r border-gray-100 px-4 py-3 text-sm font-bold text-gray-800">{row.sku.model}</td>
                    <td className="border-r border-gray-100 px-4 py-3 text-sm text-gray-600">{row.sku.storage}</td>
                    <td className="border-r border-gray-100 px-4 py-3 text-sm text-gray-600">{row.sku.position || '--'}</td>
                    <td className="max-w-[460px] border-r border-gray-100 px-4 py-3 text-xs text-gray-500">
                      <span className="line-clamp-2">{row.sku.ppv || '--'}</span>
                    </td>
                    <td className="border-r border-gray-100 px-4 py-3 text-sm font-semibold text-gray-800">
                      {row.latestSnapshot ? formatPrice(row.latestSnapshot.finalPrice) : '--'}
                    </td>
                    <td className="border-r border-gray-100 px-4 py-3 text-sm font-semibold text-gray-800">
                      <input
                        type="text"
                        value={row.biPrice ?? ''}
                        onChange={(event) => onBiPriceChange(row.sku.ppv, event.target.value)}
                        className="w-28 rounded-lg border border-gray-200 px-3 py-2 text-sm font-semibold text-gray-800 focus:border-orange-400 focus:outline-none focus:ring-2 focus:ring-orange-100"
                      />
                    </td>
                    <td className={`border-r border-gray-100 px-4 py-3 text-sm font-semibold ${row.diff && row.diff > 0 ? 'text-red-600' : 'text-gray-500'}`}>
                      {row.diff === null ? '--' : `${row.diff > 0 ? '+' : ''}${Math.round(row.diff).toLocaleString()}`}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-bold ring-1 ${getRiskBadgeClass(row.riskLevel)}`}>
                        {getRiskLabel(row.riskLevel)}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function MarketTrendPanel({
  overview,
  isLoading,
  error,
  message,
  onApply,
  onConfirmWeek,
  onDownload,
}: {
  overview: MarketTrendOverview | null;
  isLoading: boolean;
  error: string | null;
  message: string | null;
  onApply: () => void;
  onConfirmWeek: (weekInput: MarketTrendWeekInput, allowUpdate: boolean) => Promise<void>;
  onDownload: () => void;
}) {
  const [weekInput, setWeekInput] = useState<MarketTrendWeekInput | null>(null);
  const [allowUpdate, setAllowUpdate] = useState(false);
  const [tableMessage, setTableMessage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  if (isLoading) {
    return <StatusPanel icon={<Database className="text-orange-600" size={20} />} title="正在读取市场趋势数据" description="页面会优先恢复 SQLite 草稿，没有草稿时读取 Excel 的市场趋势 sheet。" />;
  }

  if (error || !overview) {
    return <StatusPanel icon={<Info className="text-red-500" size={20} />} title="市场趋势数据读取失败" description={error ?? '暂无市场趋势数据'} />;
  }

  const weeks = getMarketTrendWeeks(overview);
  const latestWeek = overview.summary.latestWeek;
  const previousWeek = weeks.at(-2) ?? '';
  const draftWeek = weekInput?.week.trim().toUpperCase();
  const visibleWeeks = weekInput && draftWeek && !weeks.includes(draftWeek) ? [...weeks, draftWeek] : weeks;
  const chartData = buildMarketTrendChartData(overview);
  if (weekInput && draftWeek) {
    const draftChartRow = {
      week: draftWeek,
      totalIndex: parseMarketTrendNumber(weekInput.totalIndex),
      ...Object.fromEntries(MARKET_TREND_CORE_BRANDS.map((brand) => [brand, parseMarketTrendShareInput(weekInput.brandShares[brand])])),
    };
    const existingChartIndex = chartData.findIndex((row) => row.week === draftWeek);
    if (existingChartIndex >= 0) {
      chartData[existingChartIndex] = draftChartRow;
    } else {
      chartData.push(draftChartRow);
    }
  }
  const startInlineWeek = () => {
    setWeekInput(createNextMarketTrendWeekInput(overview));
    setAllowUpdate(false);
    setTableMessage('已新增草稿周，可在表格中粘贴品牌份额后确认落数');
  };
  const startEditWeek = (week: string) => {
    const total = overview.weeklyTotal.find((item) => item.week === week);
    setWeekInput({
      week,
      timeRange: total?.timeRange ?? '',
      totalIndex: total?.totalIndex ? String(total.totalIndex) : '',
      marketNote: total?.marketNote ?? '',
      eventName: total?.eventName ?? '',
      brandShares: Object.fromEntries(
        MARKET_TREND_CORE_BRANDS.map((brand) => {
          const share = getMarketTrendShare(overview, brand, week);
          return [brand, share === null ? '' : String(share)];
        }),
      ),
    });
    setAllowUpdate(true);
    setTableMessage(`${week} 已进入编辑状态，修改后点击“确认更新”`);
  };
  const updateWeekInput = (patch: Partial<MarketTrendWeekInput>) => {
    setWeekInput((current) => (current ? { ...current, ...patch } : current));
  };
  const updateShareInput = (brand: string, value: string) => {
    setWeekInput((current) =>
      current
        ? {
            ...current,
            brandShares: {
              ...current.brandShares,
              [brand]: value,
            },
          }
        : current,
    );
  };
  const handlePasteShares = (text: string, startBrand?: string) => {
    const parsed = parseMarketTrendPaste(text);
    const normalizedRows = text
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    if (Object.keys(parsed).length === 0 && startBrand && normalizedRows.length > 0) {
      const startIndex = MARKET_TREND_CORE_BRANDS.indexOf(startBrand);
      normalizedRows.forEach((line, rowOffset) => {
        const brand = MARKET_TREND_CORE_BRANDS[startIndex + rowOffset];
        const value = line.split(/\t|,|\s+/).map((item) => item.trim()).filter(Boolean).at(-1);
        if (brand && value) {
          parsed[brand] = value.replace(/%/g, '');
        }
      });
    }

    setWeekInput((current) =>
      current
        ? {
            ...current,
            brandShares: {
              ...current.brandShares,
              ...parsed,
            },
          }
        : current,
    );
    setTableMessage(`已解析 ${Object.keys(parsed).length} 个品牌份额`);
  };
  const handleConfirm = async () => {
    if (!weekInput) {
      return;
    }
    setIsSaving(true);
    setTableMessage(null);
    try {
      await onConfirmWeek(weekInput, allowUpdate);
      setWeekInput(null);
      setAllowUpdate(false);
    } catch (saveError) {
      setTableMessage(saveError instanceof Error ? saveError.message : '周度数据落数失败');
      if (saveError instanceof Error && saveError.message.includes('已存在')) {
        setAllowUpdate(true);
      }
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <>
      <div className="flex flex-col gap-4 rounded-2xl border border-gray-200 bg-white p-6 shadow-sm lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-black tracking-tight">
            <BarChart3 className="text-orange-600" size={22} />
            市场总量&份额趋势分析
          </h2>
          <p className="mt-1 text-sm text-gray-500">
            {overview.dataset.year}年 · 周度数据 · 手机市场 · {overview.dataset.periodStartWeek}-{overview.dataset.periodEndWeek}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {message ? <span className="text-sm font-medium text-emerald-600">{message}</span> : null}
          <button type="button" onClick={startInlineWeek} className="rounded-xl border border-orange-200 bg-orange-50 px-4 py-2 text-sm font-semibold text-orange-600 transition hover:border-orange-300 hover:bg-orange-100">
            新增一周
          </button>
          <button type="button" onClick={onDownload} className="inline-flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-600 transition hover:border-gray-300 hover:text-gray-800">
            <Download size={16} /> 导出Excel
          </button>
          <button type="button" onClick={onApply} className="rounded-xl bg-orange-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-orange-700">
            更新结果
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-5">
        <MetricCard label="最新总量指数" value={overview.summary.latestTotalIndex.toFixed(1)} subValue={`较上周 ${formatSignedPercent(overview.summary.latestTotalIndexChangePct)}`} trend={overview.summary.latestTotalIndexChangePct > 0 ? 'up' : overview.summary.latestTotalIndexChangePct < 0 ? 'down' : undefined} icon={<BarChart3 className="text-blue-600" />} />
        <MetricCard label="最高周峰值" value={overview.summary.peakTotalIndex.toFixed(1)} subValue={overview.summary.peakWeek} icon={<TrendingUp className="text-orange-600" />} />
        <MetricCard label="苹果份额" value={formatMarketShare(overview.summary.appleShare)} subValue={`较上周 ${formatPctPoint(overview.summary.appleChangePctPoint)}`} trend={overview.summary.appleChangePctPoint > 0 ? 'up' : overview.summary.appleChangePctPoint < 0 ? 'down' : undefined} icon={<BrandLogoIcon brand="apple" />} />
        <MetricCard label="华为份额" value={formatMarketShare(overview.summary.huaweiShare)} subValue={`较上周 ${formatPctPoint(overview.summary.huaweiChangePctPoint)}`} trend={overview.summary.huaweiChangePctPoint > 0 ? 'up' : overview.summary.huaweiChangePctPoint < 0 ? 'down' : undefined} icon={<BrandLogoIcon brand="huawei" />} />
        <MetricCard label="OPPO总份额" value={formatMarketShare(overview.summary.oppoTotalShare)} subValue={`较上周 ${formatPctPoint(overview.summary.oppoTotalChangePctPoint)}`} trend={overview.summary.oppoTotalChangePctPoint > 0 ? 'up' : overview.summary.oppoTotalChangePctPoint < 0 ? 'down' : undefined} icon={<BrandLogoIcon brand="oppo" />} />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-4">
        <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm lg:col-span-3">
          <div className="mb-6 flex items-center justify-between">
            <h3 className="text-lg font-bold">市场总量&份额趋势</h3>
            <span className="rounded bg-blue-50 px-2 py-1 text-[10px] font-bold uppercase text-blue-600">总量指数</span>
          </div>
          <div className="h-[420px]">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData} margin={{ left: 8, right: 24, top: 12, bottom: 12 }}>
                <CartesianGrid stroke="#f0f0f0" strokeDasharray="3 3" />
                <XAxis dataKey="week" tick={{ fontSize: 12, fill: '#6B7280' }} />
                <YAxis yAxisId="share" tickFormatter={(value) => `${value}%`} tick={{ fontSize: 12, fill: '#6B7280' }} />
                <YAxis yAxisId="total" orientation="right" tick={{ fontSize: 12, fill: '#6B7280' }} />
                <Tooltip contentStyle={{ border: 'none', borderRadius: '12px', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)' }} formatter={(value: number, name: string) => (name === 'totalIndex' ? [value.toFixed(1), '总量指数'] : [`${Number(value).toFixed(1)}%`, name])} />
                <Legend verticalAlign="bottom" height={36} />
                <Bar yAxisId="total" dataKey="totalIndex" name="总量指数" fill={MARKET_TREND_COLORS.totalIndex} radius={[6, 6, 0, 0]} barSize={18} />
                {MARKET_TREND_CORE_BRANDS.map((brand) => (
                  <Line key={brand} yAxisId="share" type="monotone" dataKey={brand} name={brand} stroke={MARKET_TREND_COLORS[brand]} strokeWidth={2} dot={false} activeDot={{ r: 5 }} />
                ))}
                {overview.events.map((event) => (
                  <ReferenceLine key={`${event.week}-${event.eventName}`} x={event.week} stroke="#F97316" strokeDasharray="4 4" label={{ value: event.eventName, position: 'top', fontSize: 11, fill: '#C2410C' }} />
                ))}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
          <h3 className="mb-4 text-lg font-bold">核心结论</h3>
          <div className="space-y-4 text-sm">
            <p><span className="font-bold">{latestWeek}总量指数</span><br />{overview.summary.latestTotalIndex.toFixed(1)}，较上周 {formatSignedPercent(overview.summary.latestTotalIndexChangePct)}</p>
            <p><span className="font-bold">{overview.summary.topBrand}份额领先</span><br />{formatMarketShare(overview.summary.topBrandShare)}</p>
            <p><span className="font-bold">华为份额</span><br />{formatMarketShare(overview.summary.huaweiShare)}，较上周 {formatPctPoint(overview.summary.huaweiChangePctPoint)}</p>
            <p><span className="font-bold">总量峰值出现在{overview.summary.peakWeek}</span><br />{overview.summary.peakTotalIndex.toFixed(1)}（上年度W52=100）</p>
            <div className="border-t border-gray-100 pt-4 text-xs text-gray-500">
              <p>统计周期：{overview.dataset.year}年{overview.dataset.periodStartWeek}-{overview.dataset.periodEndWeek}</p>
              <p>数据来源：内部统计</p>
              <p>更新于：{overview.summary.updatedAt ? new Date(overview.summary.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '--'}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
        <div className="flex flex-col gap-4 border-b border-gray-100 p-6 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h3 className="text-lg font-bold">品牌周度份额（%）</h3>
            <p className="mt-1 text-sm text-gray-500">注：份额基于品牌在各周的销量计算，可能因四舍五入导致合计不为100%。</p>
            {tableMessage ? <p className="mt-2 text-sm font-semibold text-orange-700">{tableMessage}</p> : null}
          </div>
          {weekInput ? (
            <div className="grid min-w-[520px] grid-cols-2 gap-3 text-sm lg:grid-cols-3">
              <label className="font-semibold text-gray-600">
                周次
                <input value={weekInput.week} onChange={(event) => updateWeekInput({ week: event.target.value.toUpperCase() })} className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:border-orange-400 focus:outline-none focus:ring-2 focus:ring-orange-100" />
              </label>
              <label className="font-semibold text-gray-600">
                时间周期
                <input value={weekInput.timeRange} onChange={(event) => updateWeekInput({ timeRange: event.target.value })} placeholder="2025.5.19-2025.5.25" className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:border-orange-400 focus:outline-none focus:ring-2 focus:ring-orange-100" />
              </label>
              <label className="font-semibold text-gray-600">
                事件节点
                <input value={weekInput.eventName} onChange={(event) => updateWeekInput({ eventName: event.target.value })} className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:border-orange-400 focus:outline-none focus:ring-2 focus:ring-orange-100" />
              </label>
              <label className="col-span-2 font-semibold text-gray-600 lg:col-span-3">
                大盘环周描述
                <input value={weekInput.marketNote} onChange={(event) => updateWeekInput({ marketNote: event.target.value })} className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2 text-sm focus:border-orange-400 focus:outline-none focus:ring-2 focus:ring-orange-100" />
              </label>
              <div className="col-span-2 flex justify-end gap-3 lg:col-span-3">
                <button type="button" onClick={() => { setWeekInput(null); setAllowUpdate(false); setTableMessage(null); }} className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-600 transition hover:border-gray-300 hover:text-gray-800">取消</button>
                <button type="button" disabled={isSaving} onClick={handleConfirm} className="rounded-xl bg-orange-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-50">{isSaving ? '落数中...' : allowUpdate ? '确认更新' : '确认落数'}</button>
              </div>
            </div>
          ) : null}
        </div>
        <div className="market-share-scroll">
          <table className="market-share-table">
            <thead>
              <tr className="bg-gray-50/50">
                <th className="market-share-brand-head">品牌</th>
                {visibleWeeks.map((week) => (
                  <th key={week} className={`market-share-week-head ${week === draftWeek ? 'market-share-draft-head' : ''}`}>
                    <button type="button" onClick={() => startEditWeek(week)} className="market-share-week-button">
                      {week}
                    </button>
                  </th>
                ))}
                <th className="market-share-change-head">较上周变化</th>
              </tr>
            </thead>
            <tbody>
              <tr className="market-share-row market-share-total-row">
                <td className="market-share-brand-cell">总量指数</td>
                {visibleWeeks.map((week) => {
                  const isDraftWeek = week === draftWeek;
                  const totalIndex = isDraftWeek && weekInput
                    ? parseMarketTrendNumber(weekInput.totalIndex)
                    : overview.weeklyTotal.find((item) => item.week === week)?.totalIndex ?? 0;

                  return (
                    <td key={`total-${week}`} className={`market-share-week-cell market-share-total-cell ${week === latestWeek ? 'market-share-current-week-cell' : ''} ${isDraftWeek ? 'market-share-draft-cell' : ''}`}>
                      {isDraftWeek && weekInput ? (
                        <input
                          value={weekInput.totalIndex}
                          onChange={(event) => updateWeekInput({ totalIndex: event.target.value })}
                          className="market-share-input"
                        />
                      ) : (
                        totalIndex ? totalIndex.toFixed(1) : '--'
                      )}
                    </td>
                  );
                })}
                <td className="market-share-change-cell">
                  <MarketShareChangeBadge value={overview.summary.latestTotalIndexChangePct} formatter={formatSignedPercent} />
                </td>
              </tr>
              {MARKET_TREND_CORE_BRANDS.map((brand) => {
                const latest = getMarketTrendShare(overview, brand, latestWeek);
                const previous = getMarketTrendShare(overview, brand, previousWeek);
                const change = latest !== null && previous !== null ? latest - previous : 0;
                return (
                  <tr key={brand} className="market-share-row">
                    <td className="market-share-brand-cell">{brand}</td>
                    {visibleWeeks.map((week) => {
                      const isDraftWeek = week === draftWeek;
                      const share = isDraftWeek && weekInput ? parseMarketTrendShareInput(weekInput.brandShares[brand]) : getMarketTrendShare(overview, brand, week);
                      return (
                        <td key={`${brand}-${week}`} className={`market-share-week-cell ${isDraftWeek ? 'market-share-draft-cell' : share && share >= 20 ? 'market-share-strong-cell' : ''}`}>
                          {isDraftWeek && weekInput ? (
                            <input
                              value={weekInput.brandShares[brand] ?? ''}
                              onChange={(event) => updateShareInput(brand, event.target.value)}
                              onPaste={(event) => {
                                event.preventDefault();
                                handlePasteShares(event.clipboardData.getData('text'), brand);
                              }}
                              className="market-share-input"
                            />
                          ) : (
                            formatMarketShare(share)
                          )}
                        </td>
                      );
                    })}
                    <td className="market-share-change-cell">
                      <MarketShareChangeBadge value={change} formatter={formatPctPoint} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function MarketTrendPanelV2({
  overview,
  isLoading,
  error,
  message,
  onApply,
  onConfirmWeek,
  onDownload,
}: {
  overview: MarketTrendOverview | null;
  isLoading: boolean;
  error: string | null;
  message: string | null;
  onApply: () => void;
  onConfirmWeek: (weekInput: MarketTrendWeekInput, allowUpdate: boolean) => Promise<void>;
  onDownload: () => void;
}) {
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [weekInput, setWeekInput] = useState<MarketTrendWeekInput | null>(null);
  const [allowUpdate, setAllowUpdate] = useState(false);
  const [modalMessage, setModalMessage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  if (isLoading) {
    return <StatusPanel icon={<Database className="text-orange-600" size={20} />} title="正在读取市场趋势数据" description="页面会优先恢复 SQLite 草稿，没有草稿时读取 Excel 的市场趋势 sheet。" />;
  }
  if (error || !overview) {
    return <StatusPanel icon={<Info className="text-red-500" size={20} />} title="市场趋势数据读取失败" description={error ?? '暂无市场趋势数据'} />;
  }

  const weeks = getMarketTrendWeeks(overview);
  const latestWeek = overview.summary.latestWeek;
  const previousWeek = weeks.at(-2) ?? '';
  const chartData = buildMarketTrendChartData(overview);
  const cardStyle: React.CSSProperties = { border: '1px solid #e5e7eb', borderRadius: 16, background: '#fff', boxShadow: '0 1px 3px rgba(15,23,42,0.06)' };
  const smallButtonStyle: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 8, minHeight: 38, padding: '0 16px', border: '1px solid #e5e7eb', borderRadius: 12, background: '#fff', color: '#4b5563', fontSize: 13, fontWeight: 700, cursor: 'pointer' };
  const selectBoxStyle: React.CSSProperties = { height: 42, minWidth: 170, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '0 16px', border: '1px solid #e5e7eb', borderRadius: 12, background: '#fff', color: '#374151', fontSize: 14, fontWeight: 700 };
  const rowBands: Record<string, string> = {
    苹果: '#eaf3ff',
    小米: '#f2ecff',
    'vivo总(含iQOO)': '#fff7db',
    华为: '#ffe8e8',
    'OPPO总(含一加、realme)': '#fff1da',
    荣耀: '#ecfdf3',
    Others: '#f3f4f6',
  };
  const getChangeColor = (value: number) => (value > 0 ? '#16a34a' : value < 0 ? '#ef4444' : '#64748b');
  const openAddModal = () => {
    setWeekInput(createNextMarketTrendWeekInput(overview));
    setAllowUpdate(false);
    setModalMessage(null);
    setIsAddOpen(true);
  };
  const updateWeekInput = (patch: Partial<MarketTrendWeekInput>) => {
    setWeekInput((current) => (current ? { ...current, ...patch } : current));
  };
  const updateShareInput = (brand: string, value: string) => {
    setWeekInput((current) =>
      current
        ? {
            ...current,
            brandShares: { ...current.brandShares, [brand]: value },
          }
        : current,
    );
  };
  const handlePasteShares = (text: string) => {
    const parsed = parseMarketTrendPaste(text);
    setWeekInput((current) => (current ? { ...current, brandShares: { ...current.brandShares, ...parsed } } : current));
    setModalMessage(`已解析 ${Object.keys(parsed).length} 个品牌份额`);
  };
  const handleConfirm = async () => {
    if (!weekInput) {
      return;
    }
    setIsSaving(true);
    setModalMessage(null);
    try {
      await onConfirmWeek(weekInput, allowUpdate);
      setIsAddOpen(false);
    } catch (saveError) {
      setModalMessage(saveError instanceof Error ? saveError.message : '周度数据落数失败');
      if (saveError instanceof Error && saveError.message.includes('已存在')) {
        setAllowUpdate(true);
      }
    } finally {
      setIsSaving(false);
    }
  };
  const Kpi = ({
    title,
    value,
    sub,
    color,
    icon,
    change,
  }: {
    title: string;
    value: string;
    sub: string;
    color: string;
    icon: React.ReactNode;
    change?: number;
  }) => (
    <div style={{ ...cardStyle, minHeight: 132, padding: 22, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ width: 42, height: 42, borderRadius: 12, background: '#f9fafb', color, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{icon}</div>
        {change !== undefined ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: getChangeColor(change), fontSize: 12, fontWeight: 900 }}>{change > 0 ? '上升' : change < 0 ? '下降' : '持平'}</span> : null}
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#6b7280', marginBottom: 8 }}>{title}</div>
        <div style={{ fontSize: 28, lineHeight: 1, fontWeight: 950, color: '#111827', letterSpacing: 0 }}>{value}</div>
        <div style={{ marginTop: 8, fontSize: 13, fontWeight: 800, color: change === undefined ? '#9ca3af' : getChangeColor(change) }}>{sub}</div>
      </div>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ width: 48, height: 48, borderRadius: 12, background: '#ea580c', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', boxShadow: '0 10px 20px rgba(234,88,12,0.2)' }}>
            <BarChart3 size={30} />
          </div>
          <div>
            <h2 style={{ margin: 0, fontSize: 24, lineHeight: 1.2, fontWeight: 950, color: '#111827', letterSpacing: 0 }}>市场总量&份额趋势分析</h2>
            <p style={{ margin: '6px 0 0', fontSize: 14, color: '#6b7280', fontWeight: 700 }}>{overview.dataset.year}年 · 周度数据 · 手机市场 · {overview.dataset.periodStartWeek}-{overview.dataset.periodEndWeek}</p>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <button type="button" onClick={openAddModal} style={{ ...smallButtonStyle, borderColor: '#fed7aa', color: '#ea580c', background: '#fff7ed' }}>新增一周</button>
          <button type="button" style={smallButtonStyle}>保存图片</button>
          <button type="button" onClick={onDownload} style={smallButtonStyle}><Download size={16} /> 导出Excel</button>
          <button type="button" style={smallButtonStyle}>分享</button>
          <button type="button" style={smallButtonStyle}>全屏</button>
          <button type="button" onClick={onApply} style={{ ...smallButtonStyle, background: '#ea580c', borderColor: '#ea580c', color: '#fff' }}>更新结果</button>
        </div>
      </div>

      <div style={{ ...cardStyle, padding: '18px 20px', display: 'flex', alignItems: 'center', gap: 34, flexWrap: 'wrap' }}>
        {[
          ['时间范围', `${overview.dataset.year}年 · ${overview.dataset.periodStartWeek}-${overview.dataset.periodEndWeek}`],
          ['周期粒度', '周度'],
          ['市场范围', '全部市场'],
          ['品牌范围', '全部品牌'],
        ].map(([label, value]) => (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <span style={{ color: '#475569', fontSize: 14, fontWeight: 900 }}>{label}</span>
            <div style={selectBoxStyle}>
              <span>{value}</span>
              <span style={{ color: '#64748b' }}>⌄</span>
            </div>
          </div>
        ))}
        {message ? <span style={{ color: '#16a34a', fontSize: 13, fontWeight: 800 }}>{message}</span> : null}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: 16 }}>
        <Kpi title="最新总量指数" value={overview.summary.latestTotalIndex.toFixed(1)} sub={`较上周 ${formatSignedPercent(overview.summary.latestTotalIndexChangePct)}`} change={overview.summary.latestTotalIndexChangePct} color="#2563eb" icon={<BarChart3 size={24} />} />
        <Kpi title="最高周峰值" value={overview.summary.peakTotalIndex.toFixed(1)} sub={overview.summary.peakWeek} color="#ea580c" icon={<TrendingUp size={24} />} />
        <Kpi title="苹果份额" value={formatMarketShare(overview.summary.appleShare)} sub={`较上周 ${formatPctPoint(overview.summary.appleChangePctPoint)}`} change={overview.summary.appleChangePctPoint} color="#16a34a" icon={<Info size={24} />} />
        <Kpi title="华为份额" value={formatMarketShare(overview.summary.huaweiShare)} sub={`较上周 ${formatPctPoint(overview.summary.huaweiChangePctPoint)}`} change={overview.summary.huaweiChangePctPoint} color="#ef4444" icon={<Info size={24} />} />
        <Kpi title="OPPO总份额" value={formatMarketShare(overview.summary.oppoTotalShare)} sub={`较上周 ${formatPctPoint(overview.summary.oppoTotalChangePctPoint)}`} change={overview.summary.oppoTotalChangePctPoint} color="#f97316" icon={<Info size={24} />} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 390px', gap: 18 }}>
        <div style={{ ...cardStyle, padding: 22 }}>
          <h3 style={{ margin: '0 0 16px', fontSize: 20, fontWeight: 950, color: '#111827' }}>市场总量&份额趋势</h3>
          <div style={{ height: 470 }}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData} margin={{ left: 8, right: 22, top: 34, bottom: 24 }}>
                <CartesianGrid stroke="#e5e7eb" strokeDasharray="3 3" />
                <XAxis dataKey="week" tick={{ fontSize: 12, fill: '#475569', fontWeight: 700 }} />
                <YAxis yAxisId="share" tickFormatter={(value) => `${value}%`} domain={[0, 30]} tick={{ fontSize: 12, fill: '#475569', fontWeight: 700 }} />
                <YAxis yAxisId="total" orientation="right" domain={[0, 300]} tick={{ fontSize: 12, fill: '#475569', fontWeight: 700 }} />
                <Tooltip contentStyle={{ border: '1px solid #e5e7eb', borderRadius: 12, boxShadow: '0 12px 24px rgba(15,23,42,0.12)' }} formatter={(value: number, name: string) => (name === 'totalIndex' ? [value.toFixed(1), '总量指数'] : [`${Number(value).toFixed(1)}%`, name])} />
                <Legend verticalAlign="bottom" height={42} iconType="square" />
                <Bar yAxisId="total" dataKey="totalIndex" name="总量指数" fill={MARKET_TREND_COLORS.totalIndex} radius={[4, 4, 0, 0]} barSize={22}>
                  <LabelList dataKey="totalIndex" position="top" fill="#2563eb" fontSize={12} fontWeight={900} formatter={(value: number) => value.toFixed(1)} />
                </Bar>
                {MARKET_TREND_CORE_BRANDS.filter((brand) => brand !== 'Others').map((brand) => (
                  <Line key={brand} yAxisId="share" type="monotone" dataKey={brand} name={brand} stroke={MARKET_TREND_COLORS[brand]} strokeWidth={2.4} dot={false} activeDot={{ r: 5 }} />
                ))}
                {overview.events.map((event) => (
                  <ReferenceLine key={`${event.week}-${event.eventName}`} x={event.week} stroke="#93c5fd" strokeWidth={2} label={{ value: event.eventName, position: 'top', fontSize: 12, fontWeight: 800, fill: '#334155' }} />
                ))}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div style={{ ...cardStyle, padding: 22 }}>
          <h3 style={{ margin: '0 0 14px', fontSize: 20, fontWeight: 950, color: '#111827' }}>核心结论</h3>
          {[
            [`${latestWeek}总量指数`, `${overview.summary.latestTotalIndex.toFixed(1)}，较上周 ${formatSignedPercent(overview.summary.latestTotalIndexChangePct)}`, '#2563eb'],
            [`${overview.summary.topBrand}份额领先`, `${formatMarketShare(overview.summary.topBrandShare)}，较上周 ${overview.summary.topBrand === '苹果' ? formatPctPoint(overview.summary.appleChangePctPoint) : ''}`, '#16a34a'],
            ['华为份额', `${formatMarketShare(overview.summary.huaweiShare)}，较上周 ${formatPctPoint(overview.summary.huaweiChangePctPoint)}`, '#ef4444'],
            [`总量峰值出现在${overview.summary.peakWeek}`, `${overview.summary.peakTotalIndex.toFixed(1)}（上年度W52=100）`, '#f97316'],
            ['统计周期', `${overview.dataset.year}年${overview.dataset.periodStartWeek}-${overview.dataset.periodEndWeek}`, '#7c3aed'],
          ].map(([title, text, color]) => (
            <div key={title} style={{ display: 'flex', gap: 12, padding: '14px 0', borderTop: '1px solid #e5e7eb' }}>
              <div style={{ width: 40, height: 40, borderRadius: 999, background: color, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto' }}><Info size={20} /></div>
              <div>
                <div style={{ fontSize: 15, fontWeight: 900, color: '#334155' }}>{title}</div>
                <div style={{ marginTop: 4, fontSize: 14, fontWeight: 700, color: '#64748b' }}>{text}</div>
              </div>
            </div>
          ))}
          <div style={{ borderTop: '1px solid #e5e7eb', marginTop: 6, paddingTop: 14, fontSize: 13, fontWeight: 800, color: '#64748b', display: 'flex', justifyContent: 'space-between' }}>
            <span>数据来源：内部统计</span>
            <span>更新于 {overview.summary.updatedAt ? new Date(overview.summary.updatedAt).toLocaleDateString('zh-CN') : '--'}</span>
          </div>
        </div>
      </div>

      <div style={{ ...cardStyle, overflow: 'hidden' }}>
        <div style={{ padding: '18px 22px', borderBottom: '1px solid #e5e7eb' }}>
          <h3 style={{ margin: 0, fontSize: 20, fontWeight: 950, color: '#111827' }}>品牌周度份额（%）</h3>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', minWidth: 1500, borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr style={{ background: '#f8fafc' }}>
                <th style={{ position: 'sticky', left: 0, zIndex: 2, minWidth: 230, background: '#f8fafc', borderRight: '1px solid #e5e7eb', padding: '12px 16px', textAlign: 'left', fontWeight: 950, color: '#334155' }}>品牌</th>
                {weeks.map((week) => <th key={week} style={{ border: '1px solid #e5e7eb', padding: '11px 14px', fontWeight: 950, color: '#334155', whiteSpace: 'nowrap' }}>{week}</th>)}
                <th style={{ border: '1px solid #e5e7eb', padding: '11px 14px', fontWeight: 950, color: '#334155', whiteSpace: 'nowrap' }}>{latestWeek}份额</th>
                <th style={{ border: '1px solid #e5e7eb', padding: '11px 14px', fontWeight: 950, color: '#334155', whiteSpace: 'nowrap' }}>较上周变化</th>
              </tr>
            </thead>
            <tbody>
              {MARKET_TREND_CORE_BRANDS.map((brand) => {
                const latest = getMarketTrendShare(overview, brand, latestWeek);
                const previous = getMarketTrendShare(overview, brand, previousWeek);
                const change = latest !== null && previous !== null ? latest - previous : 0;
                return (
                  <tr key={brand}>
                    <td style={{ position: 'sticky', left: 0, zIndex: 1, background: '#fff', borderRight: '1px solid #e5e7eb', borderBottom: '1px solid #e5e7eb', padding: '11px 16px', fontWeight: 950, color: '#334155', whiteSpace: 'nowrap' }}>{brand}</td>
                    {weeks.map((week) => (
                      <td key={`${brand}-${week}`} style={{ border: '1px solid #e5e7eb', padding: '10px 12px', textAlign: 'center', fontWeight: 800, color: '#334155', background: rowBands[brand] }}>{formatMarketShare(getMarketTrendShare(overview, brand, week))}</td>
                    ))}
                    <td style={{ border: '1px solid #e5e7eb', padding: '10px 12px', textAlign: 'center', fontWeight: 950, color: '#334155' }}>{formatMarketShare(latest)}</td>
                    <td style={{ border: '1px solid #e5e7eb', padding: '10px 12px', textAlign: 'center', fontWeight: 950, color: getChangeColor(change) }}>{formatPctPoint(change)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p style={{ margin: 0, padding: '14px 22px 20px', color: '#94a3b8', fontSize: 13, fontWeight: 700 }}>注：份额基于品牌在各周的销量计算，可能因四舍五入导致合计不为100%。</p>
      </div>

      {isAddOpen && weekInput ? (
        <div style={{ position: 'fixed', inset: 0, zIndex: 80, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(15,23,42,0.32)', padding: 20 }}>
          <div style={{ width: 'min(920px, 100%)', maxHeight: '90vh', overflow: 'auto', borderRadius: 16, background: '#fff', boxShadow: '0 24px 60px rgba(15,23,42,0.24)' }}>
            <div style={{ padding: 22, borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', gap: 16 }}>
              <div><h3 style={{ margin: 0, fontSize: 20, fontWeight: 950 }}>新增周度数据</h3><p style={{ margin: '6px 0 0', color: '#64748b', fontWeight: 700 }}>复制 Excel 品牌份额到任意份额输入框即可自动识别。</p></div>
              <button type="button" onClick={() => setIsAddOpen(false)} style={smallButtonStyle}>关闭</button>
            </div>
            <div style={{ padding: 22, display: 'grid', gap: 16 }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 14 }}>
                {[
                  ['周次', 'week'],
                  ['时间周期', 'timeRange'],
                  ['总量指数', 'totalIndex'],
                  ['事件节点', 'eventName'],
                ].map(([label, key]) => (
                  <label key={key} style={{ color: '#475569', fontSize: 13, fontWeight: 900 }}>{label}<input value={String(weekInput[key as keyof MarketTrendWeekInput] ?? '')} onChange={(event) => updateWeekInput({ [key]: key === 'week' ? event.target.value.toUpperCase() : event.target.value } as Partial<MarketTrendWeekInput>)} style={{ marginTop: 8, width: '100%', height: 40, border: '1px solid #e5e7eb', borderRadius: 10, padding: '0 12px', fontWeight: 800 }} /></label>
                ))}
              </div>
              <label style={{ color: '#475569', fontSize: 13, fontWeight: 900 }}>大盘环周描述<input value={weekInput.marketNote} onChange={(event) => updateWeekInput({ marketNote: event.target.value })} style={{ marginTop: 8, width: '100%', height: 40, border: '1px solid #e5e7eb', borderRadius: 10, padding: '0 12px', fontWeight: 800 }} /></label>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
                {MARKET_TREND_CORE_BRANDS.map((brand) => (
                  <label key={brand} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 12, border: '1px solid #e5e7eb', borderRadius: 12, background: '#f8fafc', color: '#334155', fontWeight: 900 }}><span style={{ width: 190 }}>{brand}</span><input value={weekInput.brandShares[brand] ?? ''} onChange={(event) => updateShareInput(brand, event.target.value)} onPaste={(event) => handlePasteShares(event.clipboardData.getData('text'))} style={{ flex: 1, minWidth: 0, height: 36, border: '1px solid #e5e7eb', borderRadius: 8, padding: '0 10px', fontWeight: 800 }} /></label>
                ))}
              </div>
              {modalMessage ? <div style={{ padding: 12, borderRadius: 10, background: '#eff6ff', color: '#2563eb', fontWeight: 900 }}>{modalMessage}</div> : null}
              {allowUpdate ? <div style={{ padding: 12, borderRadius: 10, background: '#fff7ed', color: '#ea580c', fontWeight: 900 }}>检测到周次可能已存在，再次确认会更新该周。</div> : null}
            </div>
            <div style={{ padding: 22, borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
              <button type="button" onClick={() => setIsAddOpen(false)} style={smallButtonStyle}>取消</button>
              <button type="button" disabled={isSaving} onClick={handleConfirm} style={{ ...smallButtonStyle, background: '#2563eb', borderColor: '#2563eb', color: '#fff', opacity: isSaving ? 0.55 : 1 }}>{isSaving ? '落数中...' : allowUpdate ? '确认更新' : '确认落数'}</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function RawDataPanel({
  dates,
  rawEditorRows,
  rawEditorMessage,
  rawEditorDateInput,
  onApply,
  onSaveModelConfigs,
  onDateInputChange,
  onAddDateColumns,
  onCellChange,
  onSnapshotChange,
  onBulkPaste,
  onDownload,
}: {
  dates: string[];
  rawEditorRows: RawEditorRow[];
  rawEditorMessage: string | null;
  rawEditorDateInput: string;
  onApply: () => void;
  onSaveModelConfigs: (configs: RawModelConfig[]) => void;
  onDateInputChange: (value: string) => void;
  onAddDateColumns: () => void;
  onCellChange: (rowId: string, field: 'model' | 'storage' | 'launchPrice', value: string) => void;
  onSnapshotChange: (rowId: string, date: string, metric: 'finalPrice' | 'listPrice' | 'coupon' | 'biPrice', value: string) => void;
  onBulkPaste: (
    rowId: string,
    columnKey: RawEditorColumnKey,
    pastedText: string,
    columnKeys: RawEditorColumnKey[],
  ) => void;
  onDownload: () => void;
}) {
  const [activeTab, setActiveTab] = useState<'data' | 'models'>('data');
  const [isHistoryExpanded, setIsHistoryExpanded] = useState(false);
  const [selectedCell, setSelectedCell] = useState<{ rowId: string; columnKey: RawEditorColumnKey } | null>(null);
  const modelConfigsFromRows = useMemo(() => {
    const configByModel = new Map<string, RawModelConfig>();
    rawEditorRows.forEach((row) => {
      const model = row.model.trim();
      if (!model || configByModel.has(model)) {
        return;
      }
      configByModel.set(model, {
        model,
        brand: normalizeConfiguredBrand(row.brand ?? '') || inferBrand(model),
        position: (row.position ?? '').trim(),
      });
    });
    return Array.from(configByModel.values()).sort((left, right) => compareText(left.model, right.model));
  }, [rawEditorRows]);
  const brandOptions = useMemo(
    () =>
      Array.from(
        new Set(
          rawEditorRows
            .map((row) => normalizeConfiguredBrand((row.brand ?? '').trim() || inferBrand(row.model.trim())))
            .filter(Boolean),
        ),
      ).sort(compareText),
    [rawEditorRows],
  );
  const positionOptions = useMemo(
    () => Array.from(new Set(rawEditorRows.map((row) => (row.position ?? '').trim()).filter(Boolean))).sort(compareText),
    [rawEditorRows],
  );
  const [modelConfigs, setModelConfigs] = useState<RawModelConfig[]>(modelConfigsFromRows);
  const cellRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const hiddenDateCount = Math.max(0, dates.length - 4);
  const visibleDates = useMemo(
    () => (isHistoryExpanded ? dates : dates.slice(-4)),
    [dates, isHistoryExpanded],
  );
  const columnKeys = useMemo(() => getRawEditorColumnKeys(visibleDates), [visibleDates]);

  useEffect(() => {
    setModelConfigs(modelConfigsFromRows);
  }, [modelConfigsFromRows]);

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

  const handleBulkPaste = (rowId: string, columnKey: RawEditorColumnKey, pastedText: string) => {
    onBulkPaste(rowId, columnKey, pastedText, columnKeys);
  };

  return (
    <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
      <div className="flex gap-2 border-b border-gray-100 bg-gray-50/60 px-6 pt-4">
        {[
          ['data', '数据编辑'],
          ['models', '型号配置'],
        ].map(([tab, label]) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab as 'data' | 'models')}
            className={`rounded-t-xl px-5 py-3 text-sm font-semibold transition ${
              activeTab === tab ? 'bg-white text-orange-600 shadow-sm' : 'text-gray-500 hover:text-gray-800'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {activeTab === 'models' ? (
        <div>
          <div className="flex flex-col gap-4 border-b border-gray-100 p-6 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="text-lg font-bold">型号配置</h2>
              <p className="mt-1 text-sm text-gray-500">按型号统一维护品牌和机型定位，保存后会同步该型号下全部存储版本。</p>
            </div>
            <div className="flex items-center gap-3">
              {rawEditorMessage ? <span className="text-sm font-medium text-emerald-600">{rawEditorMessage}</span> : null}
              <button
                type="button"
                onClick={() => onSaveModelConfigs(modelConfigs)}
                className="rounded-xl bg-orange-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-orange-700"
              >
                保存配置
              </button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-left">
              <thead className="bg-gray-50/70 text-xs font-bold uppercase tracking-wider text-gray-500">
                <tr>
                  <th className="border-b border-gray-100 px-6 py-4">型号</th>
                  <th className="border-b border-gray-100 px-6 py-4">品牌</th>
                  <th className="border-b border-gray-100 px-6 py-4">机型定位</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {modelConfigs.map((config, index) => (
                  <tr key={config.model} className="hover:bg-gray-50/50">
                    <td className="px-6 py-4 text-sm font-semibold text-gray-800">{config.model}</td>
                    <td className="px-6 py-3">
                      <select
                        value={config.brand}
                        onChange={(event) =>
                          setModelConfigs((current) =>
                            current.map((item, itemIndex) =>
                              itemIndex === index ? { ...item, brand: event.target.value } : item,
                            ),
                          )
                        }
                        className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-orange-400 focus:outline-none focus:ring-2 focus:ring-orange-100"
                      >
                        {brandOptions.map((brand) => (
                          <option key={brand} value={brand}>{brand}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-6 py-3">
                      <select
                        value={config.position}
                        onChange={(event) =>
                          setModelConfigs((current) =>
                            current.map((item, itemIndex) =>
                              itemIndex === index ? { ...item, position: event.target.value } : item,
                            ),
                          )
                        }
                        className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-orange-400 focus:outline-none focus:ring-2 focus:ring-orange-100"
                      >
                        {positionOptions.map((position) => (
                          <option key={position} value={position}>{position}</option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
      <>
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
            新增四列
          </button>
          {hiddenDateCount > 0 ? (
            <button
              type="button"
              onClick={() => setIsHistoryExpanded((expanded) => !expanded)}
              className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-gray-600 transition hover:border-orange-300 hover:text-orange-600"
            >
              {isHistoryExpanded ? '收起历史日期' : `展开历史日期（已隐藏 ${hiddenDateCount} 个）`}
            </button>
          ) : null}
          {rawEditorMessage ? <span className="text-sm font-medium text-emerald-600">{rawEditorMessage}</span> : null}
          <button
            type="button"
            onClick={onDownload}
            disabled={rawEditorRows.length === 0}
            className="inline-flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-600 transition hover:border-gray-300 hover:text-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Download size={16} /> 下载
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
        <table className="min-w-[2800px] w-full border-collapse text-left">
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
              {visibleDates.map((date) => (
                <th
                  key={date}
                  colSpan={4}
                  className="border-b border-r border-gray-100 bg-gray-50/30 px-4 py-2 text-center text-xs font-bold uppercase tracking-wider text-gray-500"
                >
                  {date} 数据
                </th>
              ))}
            </tr>
            <tr className="bg-gray-50/50">
              {visibleDates.map((date) => (
                <React.Fragment key={`${date}-sub`}>
                  <th className="border-b border-gray-100 px-3 py-2 text-[10px] font-bold uppercase text-gray-400">国补后</th>
                  <th className="border-b border-gray-100 px-3 py-2 text-[10px] font-bold uppercase text-gray-400">挂牌价</th>
                  <th className="border-b border-gray-100 px-3 py-2 text-[10px] font-bold uppercase text-gray-400">优惠券</th>
                  <th className="border-b border-r border-gray-100 px-3 py-2 text-[10px] font-bold uppercase text-gray-400">BI出货价</th>
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
                        handleBulkPaste(row.id, 'model', text);
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
                        handleBulkPaste(row.id, 'storage', text);
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
                        handleBulkPaste(row.id, 'launchPrice', text);
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
                {visibleDates.map((date) => {
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
                              handleBulkPaste(row.id, `${date}::finalPrice`, text);
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
                              handleBulkPaste(row.id, `${date}::listPrice`, text);
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
                              handleBulkPaste(row.id, `${date}::coupon`, text);
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
                      <td className="border-r border-gray-100 px-3 py-3">
                        <input
                          type="text"
                          value={snapshot?.biPrice ?? ''}
                          onChange={(event) => onSnapshotChange(row.id, date, 'biPrice', event.target.value)}
                          onFocus={() => setSelectedCell({ rowId: row.id, columnKey: `${date}::biPrice` })}
                          onClick={() => setSelectedCell({ rowId: row.id, columnKey: `${date}::biPrice` })}
                          onKeyDown={(event) => handleCellKeyDown(event, row.id, `${date}::biPrice`)}
                          onPaste={(event) => {
                            const text = event.clipboardData.getData('text');
                            if (text.includes('\t') || text.includes('\n')) {
                              event.preventDefault();
                              handleBulkPaste(row.id, `${date}::biPrice`, text);
                            }
                          }}
                          ref={(element) => setCellRef(row.id, `${date}::biPrice`, element)}
                          className={getCellClass(
                            row.id,
                            `${date}::biPrice`,
                            'w-full min-w-[110px] rounded-lg border border-gray-200 px-3 py-2 text-sm font-semibold text-sky-700 focus:border-orange-400 focus:outline-none focus:ring-2 focus:ring-orange-100',
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
      </>
      )}
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
