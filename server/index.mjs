import 'dotenv/config';
import express from 'express';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';
import { registerWeeklySalesRoutes } from './lib/weekly-sales.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const dataDir = process.env.PRICE_MONITOR_DATA_DIR || path.join(projectRoot, 'data');
const draftPath = path.join(dataDir, 'raw-editor-draft.json');
const databasePath = process.env.PRICE_MONITOR_DRAFT_DB_PATH || path.join(dataDir, 'raw-editor-draft.sqlite');
const legacyWorkbookPath = path.join(projectRoot, '新机售价监控.xlsx');
const workbookPath =
  process.env.PRICE_MONITOR_WORKBOOK_PATH ||
  (fsSync.existsSync(path.join(dataDir, '新机售价监控.xlsx')) ? path.join(dataDir, '新机售价监控.xlsx') : legacyWorkbookPath);
const marketTrendSheetName = '市场总量份额趋势';
const marketTrendWorkbookPath = process.env.MARKET_TREND_WORKBOOK_PATH || path.join(dataDir, '市场总量份额趋势.xlsx');
const marketTrendDatabasePath = process.env.MARKET_TREND_DRAFT_DB_PATH || path.join(dataDir, 'market-trend.sqlite');
const distDir = path.join(projectRoot, 'dist');
const indexHtmlPath = path.join(distDir, 'index.html');
const port = Number(process.env.PORT || process.env.PRICE_MONITOR_API_PORT || 8787);
const dailyPriceLookupUrl = process.env.DAILY_PRICE_LOOKUP_URL || 'http://127.0.0.1:8765/api/lookup';
const dailyPriceTokenPath =
  process.env.DAILY_PRICE_TOKEN_PATH ||
  '/Users/dudu/Desktop/trae/重点日常项目/【daily price】/data/api_token.txt';

const app = express();
let rawDatabase;
let marketTrendDatabase;

const marketTrendCoreBrands = ['苹果', '小米', 'vivo总(含iQOO)', '华为', 'OPPO总(含一加、realme)', '荣耀', 'Others'];
const marketTrendBrandGroups = new Map([
  ['苹果', '苹果'],
  ['小米', '小米'],
  ['vivo总(含iQOO)', 'vivo'],
  ['华为', '华为'],
  ['OPPO总(含一加、realme)', 'OPPO'],
  ['荣耀', '荣耀'],
  ['Others', 'Others'],
]);

app.use(express.json({ limit: '10mb' }));

const weeklySalesService = registerWeeklySalesRoutes(app, { dataDir, applyMarketWeeks: applyAutomatedMarketWeeks });

async function ensureDataDir() {
  await fs.mkdir(dataDir, { recursive: true });
}

function ensureRawDatabase() {
  if (rawDatabase) {
    return rawDatabase;
  }

  rawDatabase = new DatabaseSync(databasePath);
  rawDatabase.exec(`
    CREATE TABLE IF NOT EXISTS raw_editor_drafts (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      dates_json TEXT NOT NULL,
      rows_json TEXT NOT NULL,
      saved_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  return rawDatabase;
}

function ensureMarketTrendDatabase() {
  if (marketTrendDatabase) {
    return marketTrendDatabase;
  }

  marketTrendDatabase = new DatabaseSync(marketTrendDatabasePath);
  marketTrendDatabase.exec(`
    CREATE TABLE IF NOT EXISTS market_trend_drafts (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      payload_json TEXT NOT NULL,
      saved_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  return marketTrendDatabase;
}

async function readLegacyDraftFile() {
  try {
    const content = await fs.readFile(draftPath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function readDraftFromDatabase() {
  const statement = ensureRawDatabase().prepare(`
    SELECT dates_json, rows_json, saved_at
    FROM raw_editor_drafts
    WHERE id = 1
  `);
  const row = statement.get();
  if (!row) {
    return null;
  }

  return {
    dates: JSON.parse(row.dates_json),
    rows: JSON.parse(row.rows_json),
    savedAt: row.saved_at,
  };
}

function writeDraftToDatabase(payload) {
  const now = new Date().toISOString();
  const nextDraft = {
    dates: payload.dates,
    rows: payload.rows,
    savedAt: typeof payload.savedAt === 'string' ? payload.savedAt : now,
  };

  ensureRawDatabase()
    .prepare(`
      INSERT INTO raw_editor_drafts (id, dates_json, rows_json, saved_at, updated_at)
      VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        dates_json = excluded.dates_json,
        rows_json = excluded.rows_json,
        saved_at = excluded.saved_at,
        updated_at = excluded.updated_at
    `)
    .run(JSON.stringify(nextDraft.dates), JSON.stringify(nextDraft.rows), nextDraft.savedAt, now);

  return nextDraft;
}

function readMarketTrendDraftFromDatabase() {
  const statement = ensureMarketTrendDatabase().prepare(`
    SELECT payload_json, saved_at
    FROM market_trend_drafts
    WHERE id = 1
  `);
  const row = statement.get();
  if (!row) {
    return null;
  }

  return {
    ...JSON.parse(row.payload_json),
    savedAt: row.saved_at,
  };
}

function writeMarketTrendDraftToDatabase(payload) {
  const now = new Date().toISOString();
  const nextPayload = {
    ...payload,
    sheetName: marketTrendSheetName,
    savedAt: typeof payload.savedAt === 'string' ? payload.savedAt : now,
  };

  ensureMarketTrendDatabase()
    .prepare(`
      INSERT INTO market_trend_drafts (id, payload_json, saved_at, updated_at)
      VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        payload_json = excluded.payload_json,
        saved_at = excluded.saved_at,
        updated_at = excluded.updated_at
    `)
    .run(JSON.stringify(nextPayload), nextPayload.savedAt, now);

  return nextPayload;
}

function readLegacyMarketTrendDraftFromRawDatabase() {
  try {
    const statement = ensureRawDatabase().prepare(`
      SELECT payload_json, saved_at
      FROM market_trend_drafts
      WHERE id = 1
    `);
    const row = statement.get();
    if (!row) {
      return null;
    }

    return {
      ...JSON.parse(row.payload_json),
      savedAt: row.saved_at,
    };
  } catch (error) {
    return null;
  }
}

async function migrateLegacyDraftIfNeeded() {
  const existingDraft = readDraftFromDatabase();
  if (existingDraft) {
    return;
  }

  const legacyDraft = await readLegacyDraftFile();
  if (!legacyDraft || !isValidDraftPayload(legacyDraft)) {
    return;
  }

  writeDraftToDatabase(legacyDraft);
}

function migrateLegacyMarketTrendDraftIfNeeded() {
  const existingDraft = readMarketTrendDraftFromDatabase();
  if (existingDraft) {
    return;
  }

  const legacyDraft = readLegacyMarketTrendDraftFromRawDatabase();
  if (!legacyDraft) {
    return;
  }

  writeMarketTrendDraftToDatabase(legacyDraft);
}

function isValidDraftPayload(payload) {
  return Boolean(
    payload &&
      Array.isArray(payload.dates) &&
      Array.isArray(payload.rows) &&
      payload.dates.every((item) => typeof item === 'string'),
  );
}

function normalizeHeader(value) {
  return String(value ?? '').replace(/\s+/g, '').trim();
}

function findHeaderIndex(headers, keywords) {
  return headers.findIndex((header) => keywords.some((keyword) => header.includes(keyword)));
}

function toDateLabel(header) {
  const dottedMatch = String(header).match(/(\d{1,2})\.(\d{1,2})/);
  if (dottedMatch) {
    return `${Number(dottedMatch[1])}.${dottedMatch[2].padStart(2, '0')}`;
  }

  const compactMatch = String(header).match(/(\d{2})(\d{2})/);
  if (compactMatch) {
    return `${Number(compactMatch[1])}.${compactMatch[2].padStart(2, '0')}`;
  }

  return null;
}

function toCompactDate(dateLabel) {
  const [month, day] = dateLabel.split('.');
  return `${month.padStart(2, '0')}${day.padStart(2, '0')}`;
}

function parseNumericInput(value) {
  const normalized = String(value ?? '').replace(/,/g, '').trim();
  if (!normalized) {
    return '';
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? Math.round(parsed) : normalized;
}

function parseMarketTrendNumber(value) {
  const normalized = String(value ?? '').replace(/,/g, '').replace(/%/g, '').trim();
  if (!normalized) {
    return null;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseWeekNumber(week) {
  const matched = String(week ?? '').match(/(\d+)/);
  return matched ? Number(matched[1]) : 0;
}

function normalizeMarketShare(value) {
  const parsed = parseMarketTrendNumber(value);
  if (parsed === null) {
    return null;
  }
  return Math.abs(parsed) < 1 ? Number((parsed * 100).toFixed(4)) : parsed;
}

function inferMarketTrendYear(rows) {
  const timeRangeCell = String(rows[2]?.find((value) => String(value ?? '').match(/20\d{2}/)) ?? '');
  const timeRangeMatched = timeRangeCell.match(/(20\d{2})/);
  if (timeRangeMatched) {
    return Number(timeRangeMatched[1]);
  }

  const firstCell = String(rows[0]?.[0] ?? '');
  const matched = firstCell.match(/(20\d{2})/);
  return matched ? Number(matched[1]) : new Date().getFullYear();
}

function sortMarketTrendWeeks(weeks) {
  return [...weeks].sort((left, right) => parseWeekNumber(left) - parseWeekNumber(right));
}

function getMarketTrendDisplayYear(payload) {
  const years = (payload.weeks ?? [])
    .flatMap((item) => String(item.timeRange ?? '').match(/20\d{2}/g) ?? [])
    .map(Number)
    .filter((year) => Number.isFinite(year));

  if (years.length > 0) {
    return Math.max(...years);
  }

  return payload.year;
}

function parseMarketTrendSheetRows(rows) {
  const headerRow = rows[1] ?? [];
  const weekColumns = [];
  headerRow.forEach((value, index) => {
    const week = String(value ?? '').trim();
    if (/^W\d+$/i.test(week)) {
      weekColumns.push({ week: week.toUpperCase(), columnIndex: index });
    }
  });

  if (weekColumns.length === 0) {
    throw new Error(`Excel 中的 ${marketTrendSheetName} sheet 未找到 W1/W2 这类周次列`);
  }

  const year = inferMarketTrendYear(rows);
  const weeks = weekColumns.map(({ week, columnIndex }) => ({
    week,
    timeRange: String(rows[2]?.[columnIndex] ?? '').trim(),
    totalIndex: parseMarketTrendNumber(rows[3]?.[columnIndex]) ?? 0,
    marketNote: String(rows[4]?.[columnIndex] ?? '').trim(),
    eventName: String(rows[0]?.[columnIndex - 1] ?? '').trim(),
  }));

  const brandShares = {};
  for (const row of rows.slice(5)) {
    const brandName = String(row[0] ?? '').trim();
    if (!brandName) {
      continue;
    }

    brandShares[brandName] = {};
    for (const { week, columnIndex } of weekColumns) {
      brandShares[brandName][week] = normalizeMarketShare(row[columnIndex]);
    }
  }

  return {
    sheetName: marketTrendSheetName,
    year,
    weeks,
    brandShares,
    savedAt: new Date().toISOString(),
  };
}

function readMarketTrendFromWorkbook() {
  const sourcePath = fsSync.existsSync(marketTrendWorkbookPath) ? marketTrendWorkbookPath : workbookPath;
  const workbook = XLSX.readFile(sourcePath);
  const sheet = workbook.Sheets[marketTrendSheetName];
  if (!sheet) {
    throw new Error(`Excel 数据源中未找到 ${marketTrendSheetName} sheet，请先导入历史数据`);
  }

  const rows = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: true,
    defval: '',
  });

  return parseMarketTrendSheetRows(rows);
}

function validateMarketTrendPayload(payload) {
  const errors = [];
  const warnings = [];
  if (!payload || !Array.isArray(payload.weeks) || !payload.brandShares) {
    return { errors: ['市场趋势数据结构无效'], warnings };
  }

  for (const weekItem of payload.weeks) {
    if (!/^W\d+$/i.test(String(weekItem.week ?? ''))) {
      errors.push(`周次无效：${weekItem.week || '(空)'}`);
    }
    if (parseMarketTrendNumber(weekItem.totalIndex) === null) {
      errors.push(`${weekItem.week} 总量指数必须为数字`);
    }

    const missingBrands = marketTrendCoreBrands.filter((brand) => {
      const value = payload.brandShares?.[brand]?.[weekItem.week];
      return normalizeMarketShare(value) === null;
    });
    if (missingBrands.length > 0) {
      errors.push(`${weekItem.week} 缺少核心品牌份额：${missingBrands.join('、')}`);
      continue;
    }

    const shareSum = marketTrendCoreBrands.reduce((sum, brand) => sum + (normalizeMarketShare(payload.brandShares[brand][weekItem.week]) ?? 0), 0);
    if (shareSum < 95 || shareSum > 105) {
      warnings.push(`${weekItem.week} 品牌份额合计为 ${shareSum.toFixed(1)}%，请确认`);
    }
  }

  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

function buildMarketTrendOverview(payload) {
  const weeks = sortMarketTrendWeeks(payload.weeks.map((item) => item.week));
  const displayYear = getMarketTrendDisplayYear(payload);
  const weeklyTotal = weeks.map((week) => {
    const item = payload.weeks.find((entry) => entry.week === week) ?? {};
    return {
      year: displayYear,
      week,
      timeRange: item.timeRange ?? '',
      totalIndex: parseMarketTrendNumber(item.totalIndex) ?? 0,
      marketNote: item.marketNote ?? '',
      eventName: item.eventName ?? '',
    };
  });
  const brandShare = [];
  for (const brandName of Object.keys(payload.brandShares ?? {})) {
    for (const week of weeks) {
      const sharePct = normalizeMarketShare(payload.brandShares[brandName]?.[week]);
      if (sharePct === null) {
        continue;
      }
      brandShare.push({
        year: displayYear,
        week,
        brandName,
        brandGroup: marketTrendBrandGroups.get(brandName) ?? brandName.replace(/^-/, ''),
        sharePct,
      });
    }
  }

  const latestWeek = weeks.at(-1) ?? '';
  const previousWeek = weeks.at(-2) ?? '';
  const latestTotal = weeklyTotal.find((item) => item.week === latestWeek);
  const previousTotal = weeklyTotal.find((item) => item.week === previousWeek);
  const latestTotalIndex = latestTotal?.totalIndex ?? 0;
  const previousTotalIndex = previousTotal?.totalIndex ?? 0;
  const peak = weeklyTotal.reduce((currentPeak, item) => (item.totalIndex > currentPeak.totalIndex ? item : currentPeak), weeklyTotal[0] ?? { week: '', totalIndex: 0 });
  const latestCoreShares = marketTrendCoreBrands
    .filter((brand) => brand !== 'Others')
    .map((brand) => ({
      brand,
      sharePct: normalizeMarketShare(payload.brandShares?.[brand]?.[latestWeek]) ?? 0,
    }));
  const topBrand = latestCoreShares.reduce((top, item) => (item.sharePct > top.sharePct ? item : top), { brand: '', sharePct: 0 });
  const brandChange = (brand) =>
    (normalizeMarketShare(payload.brandShares?.[brand]?.[latestWeek]) ?? 0) -
    (normalizeMarketShare(payload.brandShares?.[brand]?.[previousWeek]) ?? 0);

  return {
    source: 'excel-sheet',
    dataset: {
      sheetName: marketTrendSheetName,
      year: displayYear,
      periodStartWeek: weeks[0] ?? '',
      periodEndWeek: latestWeek,
      marketScope: '全部市场',
      savedAt: payload.savedAt ?? '',
    },
    weeklyTotal,
    brandShare,
    events: weeklyTotal
      .filter((item) => item.eventName)
      .map((item) => ({
        year: displayYear,
        week: item.week,
        eventName: item.eventName,
        eventType: '新品发布',
        relatedBrand: '',
        remark: '',
      })),
    payload,
    summary: {
      latestWeek,
      latestTotalIndex,
      latestTotalIndexChangePct: previousTotalIndex ? ((latestTotalIndex - previousTotalIndex) / previousTotalIndex) * 100 : 0,
      peakWeek: peak.week,
      peakTotalIndex: peak.totalIndex,
      topBrand: topBrand.brand,
      topBrandShare: topBrand.sharePct,
      appleShare: normalizeMarketShare(payload.brandShares?.['苹果']?.[latestWeek]) ?? 0,
      appleChangePctPoint: brandChange('苹果'),
      huaweiShare: normalizeMarketShare(payload.brandShares?.['华为']?.[latestWeek]) ?? 0,
      huaweiChangePctPoint: brandChange('华为'),
      oppoTotalShare: normalizeMarketShare(payload.brandShares?.['OPPO总(含一加、realme)']?.[latestWeek]) ?? 0,
      oppoTotalChangePctPoint: brandChange('OPPO总(含一加、realme)'),
      updatedAt: payload.savedAt ?? '',
    },
  };
}

function writeMarketTrendToWorkbook(payload) {
  const workbook = fsSync.existsSync(marketTrendWorkbookPath)
    ? XLSX.readFile(marketTrendWorkbookPath)
    : XLSX.utils.book_new();
  const oldSheet = workbook.Sheets[marketTrendSheetName];
  const oldIndex = workbook.SheetNames.indexOf(marketTrendSheetName);
  if (oldSheet) {
    workbook.SheetNames.splice(oldIndex, 1);
    delete workbook.Sheets[marketTrendSheetName];
  }

  const weeks = sortMarketTrendWeeks(payload.weeks.map((item) => item.week));
  const weekByName = new Map(payload.weeks.map((item) => [item.week, item]));
  const rows = [
    [`${payload.year + 1}年；事件→`, '', ...weeks.map((_, index) => weekByName.get(weeks[index + 1])?.eventName ?? '')],
    ['厂商', '趋势↓', ...weeks],
    ['时间周期', '', ...weeks.map((week) => weekByName.get(week)?.timeRange ?? '')],
    ['上年度W52基数-100', '', ...weeks.map((week) => parseMarketTrendNumber(weekByName.get(week)?.totalIndex) ?? '')],
    ['手机销量大盘环周', '', ...weeks.map((week) => weekByName.get(week)?.marketNote ?? '')],
  ];

  for (const brandName of Object.keys(payload.brandShares ?? {})) {
    rows.push([
      brandName,
      '',
      ...weeks.map((week) => {
        const sharePct = normalizeMarketShare(payload.brandShares[brandName]?.[week]);
        return sharePct === null ? '' : Number((sharePct / 100).toFixed(6));
      }),
    ]);
  }

  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const insertIndex = oldIndex >= 0 ? oldIndex : workbook.SheetNames.length;
  workbook.SheetNames.splice(insertIndex, 0, marketTrendSheetName);
  workbook.Sheets[marketTrendSheetName] = sheet;
  XLSX.writeFile(workbook, marketTrendWorkbookPath);

  return {
    workbookPath: marketTrendWorkbookPath,
    sheetName: marketTrendSheetName,
    weekCount: weeks.length,
    brandCount: Object.keys(payload.brandShares ?? {}).length,
  };
}

function mergeMarketTrendWeek(payload, weekPayload, allowUpdate) {
  const week = String(weekPayload.week ?? '').trim().toUpperCase();
  const existingIndex = payload.weeks.findIndex((item) => item.week === week);
  if (existingIndex >= 0 && !allowUpdate) {
    throw new Error(`当前数据源已存在 ${week}，请确认后改为更新该周`);
  }

  const nextPayload = {
    ...payload,
    savedAt: new Date().toISOString(),
    weeks: [...payload.weeks],
    brandShares: JSON.parse(JSON.stringify(payload.brandShares ?? {})),
  };
  const nextWeek = {
    week,
    timeRange: String(weekPayload.timeRange ?? '').trim(),
    totalIndex: weekPayload.totalIndex,
    marketNote: String(weekPayload.marketNote ?? '').trim(),
    eventName: String(weekPayload.eventName ?? '').trim(),
    sourcePostUrl: String(weekPayload.sourcePostUrl ?? '').trim(),
  };

  if (existingIndex >= 0) {
    nextPayload.weeks[existingIndex] = nextWeek;
  } else {
    nextPayload.weeks.push(nextWeek);
  }

  for (const share of weekPayload.brandShares ?? []) {
    const brandName = String(share.brandName ?? '').trim();
    if (!brandName) {
      continue;
    }
    nextPayload.brandShares[brandName] = nextPayload.brandShares[brandName] ?? {};
    nextPayload.brandShares[brandName][week] = normalizeMarketShare(share.sharePct);
  }

  nextPayload.weeks = nextPayload.weeks.sort((left, right) => parseWeekNumber(left.week) - parseWeekNumber(right.week));
  return nextPayload;
}

async function applyAutomatedMarketWeeks(marketWeeks) {
  if (!Array.isArray(marketWeeks) || marketWeeks.length === 0) {
    return { insertedWeeks: 0, skippedWeeks: 0, weeks: [] };
  }

  let payload = readMarketTrendDraftFromDatabase() ?? readMarketTrendFromWorkbook();
  let insertedWeeks = 0;
  let skippedWeeks = 0;
  const insertedLabels = [];
  for (const record of marketWeeks) {
    const displayYear = getMarketTrendDisplayYear(payload);
    if (displayYear !== Number(record.year)) {
      throw new Error(`市场趋势当前年份为 ${displayYear}，不能自动写入 ${record.year} ${record.weekLabel}`);
    }
    if (payload.weeks.some((item) => item.week === record.weekLabel)) {
      skippedWeeks += 1;
      continue;
    }
    payload = mergeMarketTrendWeek(
      payload,
      {
        week: record.weekLabel,
        timeRange: String(record.publishedAt ?? '').slice(0, 10),
        totalIndex: record.totalIndex,
        marketNote: record.marketNote,
        eventName: '',
        sourcePostUrl: record.sourcePostUrl,
        brandShares: marketTrendCoreBrands.map((brandName) => ({
          brandName,
          sharePct: record.brandShares[brandName],
        })),
      },
      false,
    );
    insertedWeeks += 1;
    insertedLabels.push(`${record.year} ${record.weekLabel}`);
  }

  if (insertedWeeks > 0) {
    const validation = validateMarketTrendPayload(payload);
    if (validation.errors.length > 0) {
      throw new Error(validation.errors.join('；'));
    }
    const nextDraft = writeMarketTrendDraftToDatabase(payload);
    writeMarketTrendToWorkbook(nextDraft);
  }
  return { insertedWeeks, skippedWeeks, weeks: insertedLabels };
}

function normalizeStorage(value) {
  return String(value ?? '')
    .replace(/\s+/g, '')
    .replace(/GB/gi, 'G')
    .replace(/TB/gi, 'T')
    .replace(/^(\d+)\+/, '$1G+')
    .toUpperCase();
}

function getSnapshotMetricHeader(dateLabel, metric) {
  const compactDate = toCompactDate(dateLabel);
  if (metric === 'finalPrice') {
    return '国补后价格试算';
  }
  if (metric === 'listPrice') {
    return `${compactDate}挂牌价`;
  }
  if (metric === 'coupon') {
    return `${compactDate}优惠力度`;
  }
  return `${compactDate}BI出货价`;
}

function isSnapshotMetricHeader(header, metric) {
  const lowerHeader = header.toLowerCase();
  if (metric === 'finalPrice') {
    return header.includes('国补后');
  }
  if (metric === 'listPrice') {
    return header.includes('挂牌价') || header.includes('面价');
  }
  if (metric === 'coupon') {
    return header.includes('优惠');
  }
  return lowerHeader.includes('bi价') || lowerHeader.includes('bi出货价');
}

function findOrCreateSnapshotColumn(sheet, rows, headerRowIndex, dateLabel, metric) {
  const groupHeaders = (rows[headerRowIndex - 1] ?? []).map(normalizeHeader);
  const headers = (rows[headerRowIndex] ?? []).map(normalizeHeader);
  let currentGroupHeader = '';
  let dateGroupEndIndex = -1;

  for (let index = 0; index < headers.length; index += 1) {
    if (groupHeaders[index]) {
      currentGroupHeader = groupHeaders[index];
    }

    if (!headers[index]) {
      continue;
    }

    const currentDate = toDateLabel(currentGroupHeader) ?? toDateLabel(headers[index]);
    if (currentDate !== dateLabel) {
      continue;
    }

    dateGroupEndIndex = index;
    if (isSnapshotMetricHeader(headers[index], metric)) {
      return index;
    }
  }

  const range = XLSX.utils.decode_range(sheet['!ref']);
  const preferredIndex = dateGroupEndIndex >= 0 ? dateGroupEndIndex + 1 : range.e.c + 1;
  let columnIndex = preferredIndex;

  while (headers[columnIndex] || groupHeaders[columnIndex]) {
    columnIndex += 1;
  }

  XLSX.utils.sheet_add_aoa(
    sheet,
    [[dateGroupEndIndex >= 0 ? '' : `-${dateLabel}原始数据`], [getSnapshotMetricHeader(dateLabel, metric)]],
    { origin: { r: headerRowIndex - 1, c: columnIndex } },
  );
  rows[headerRowIndex - 1][columnIndex] = dateGroupEndIndex >= 0 ? '' : `-${dateLabel}原始数据`;
  rows[headerRowIndex][columnIndex] = getSnapshotMetricHeader(dateLabel, metric);

  return columnIndex;
}

function writeDraftToWorkbook(payload) {
  const workbook = XLSX.readFile(workbookPath);
  const [sheetName] = workbook.SheetNames;
  if (!sheetName) {
    throw new Error('Excel 文件中没有可读取的工作表');
  }

  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: true,
    defval: '',
  });
  const headerRowIndex = rows.findIndex((row) => {
    const headers = row.map(normalizeHeader);
    return headers.includes('型号名称') && headers.includes('存储版本');
  });

  if (headerRowIndex === -1) {
    throw new Error('Excel 中未找到“型号名称 / 存储版本”表头');
  }

  const headers = rows[headerRowIndex].map(normalizeHeader);
  const modelIndex = findHeaderIndex(headers, ['型号名称']);
  const brandIndex = findHeaderIndex(headers, ['所属品牌名称']);
  const storageIndex = findHeaderIndex(headers, ['存储版本']);
  const positionIndex = findHeaderIndex(headers, ['定位']);
  const ppvIndex = findHeaderIndex(headers, ['ppv']);
  const launchPriceIndex = findHeaderIndex(headers, ['发布挂牌售价', '发布价']);
  if (modelIndex === -1 || storageIndex === -1) {
    throw new Error('Excel 中缺少型号名称或存储版本字段');
  }

  const rowIndexByKey = new Map();
  rows.slice(headerRowIndex + 1).forEach((row, offset) => {
    const model = String(row[modelIndex] ?? '').trim();
    const storage = String(row[storageIndex] ?? '').trim();
    const ppv = ppvIndex === -1 ? '' : String(row[ppvIndex] ?? '').trim();
    const rowIndex = headerRowIndex + 1 + offset;

    if (ppv) {
      rowIndexByKey.set(`ppv:${ppv}`, rowIndex);
    }
    if (model && storage) {
      rowIndexByKey.set(`model:${model}::${normalizeStorage(storage)}`, rowIndex);
    }
  });

  const columnByDateMetric = new Map();
  let cellsWritten = 0;
  let rowsAppended = 0;

  for (const draftRow of payload.rows) {
    const model = String(draftRow.model ?? '').trim();
    const storage = String(draftRow.storage ?? '').trim();
    if (!model || !storage) {
      continue;
    }

    let rowIndex =
      (draftRow.ppv ? rowIndexByKey.get(`ppv:${String(draftRow.ppv).trim()}`) : undefined) ??
      rowIndexByKey.get(`model:${model}::${normalizeStorage(storage)}`);

    if (rowIndex === undefined) {
      rowIndex = rows.length;
      rows.push([]);
      rowsAppended += 1;
    }

    const baseValues = [
      [modelIndex, model],
      [brandIndex, String(draftRow.brand ?? '').trim()],
      [storageIndex, storage],
      [positionIndex, String(draftRow.position ?? '').trim()],
      [ppvIndex, String(draftRow.ppv ?? '').trim()],
      [launchPriceIndex, parseNumericInput(draftRow.launchPrice)],
    ].filter(([columnIndex]) => columnIndex !== -1);

    for (const [columnIndex, value] of baseValues) {
      if (value === '') {
        continue;
      }
      XLSX.utils.sheet_add_aoa(sheet, [[value]], { origin: { r: rowIndex, c: columnIndex } });
      rows[rowIndex][columnIndex] = value;
      cellsWritten += 1;
    }

    const rowPpv = String(draftRow.ppv ?? '').trim();
    if (rowPpv) {
      rowIndexByKey.set(`ppv:${rowPpv}`, rowIndex);
    }
    rowIndexByKey.set(`model:${model}::${normalizeStorage(storage)}`, rowIndex);

    for (const dateLabel of payload.dates) {
      const snapshot = draftRow.snapshots?.[dateLabel];
      if (!snapshot) {
        continue;
      }

      for (const metric of ['finalPrice', 'listPrice', 'coupon', 'biPrice']) {
        const value = parseNumericInput(snapshot[metric]);
        if (value === '') {
          continue;
        }

        const columnKey = `${dateLabel}::${metric}`;
        const columnIndex =
          columnByDateMetric.get(columnKey) ?? findOrCreateSnapshotColumn(sheet, rows, headerRowIndex, dateLabel, metric);
        columnByDateMetric.set(columnKey, columnIndex);
        XLSX.utils.sheet_add_aoa(sheet, [[value]], { origin: { r: rowIndex, c: columnIndex } });
        rows[rowIndex][columnIndex] = value;
        cellsWritten += 1;
      }
    }
  }

  XLSX.writeFile(workbook, workbookPath);
  return {
    workbookPath,
    rowsWritten: cellsWritten,
    cellsWritten,
    rowsAppended,
  };
}

function writeLatestBiPricesToWorkbook(payload) {
  const targetDate = typeof payload.workbookTargetDate === 'string' ? payload.workbookTargetDate : payload.dates.at(-1);
  if (!targetDate) {
    throw new Error('没有可写回的目标日期');
  }

  const targetPpvs = Array.isArray(payload.workbookTargetPpvs)
    ? new Set(payload.workbookTargetPpvs.map((item) => String(item ?? '').trim()).filter(Boolean))
    : new Set();

  const workbook = XLSX.readFile(workbookPath);
  const [sheetName] = workbook.SheetNames;
  if (!sheetName) {
    throw new Error('Excel 文件中没有可读取的工作表');
  }

  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: true,
    defval: '',
  });
  const headerRowIndex = rows.findIndex((row) => {
    const headers = row.map(normalizeHeader);
    return headers.includes('型号名称') && headers.includes('存储版本');
  });

  if (headerRowIndex === -1) {
    throw new Error('Excel 中未找到“型号名称 / 存储版本”表头');
  }

  const headers = rows[headerRowIndex].map(normalizeHeader);
  const modelIndex = findHeaderIndex(headers, ['型号名称']);
  const storageIndex = findHeaderIndex(headers, ['存储版本']);
  const positionIndex = findHeaderIndex(headers, ['定位']);
  const ppvIndex = findHeaderIndex(headers, ['ppv']);
  const launchPriceIndex = findHeaderIndex(headers, ['发布挂牌售价', '发布价']);
  if (modelIndex === -1 || storageIndex === -1) {
    throw new Error('Excel 中缺少型号名称或存储版本字段');
  }

  const rowIndexByKey = new Map();
  rows.slice(headerRowIndex + 1).forEach((row, offset) => {
    const model = String(row[modelIndex] ?? '').trim();
    const storage = String(row[storageIndex] ?? '').trim();
    const ppv = ppvIndex === -1 ? '' : String(row[ppvIndex] ?? '').trim();
    const rowIndex = headerRowIndex + 1 + offset;

    if (ppv) {
      rowIndexByKey.set(`ppv:${ppv}`, rowIndex);
    }
    if (model && storage) {
      rowIndexByKey.set(`model:${model}::${normalizeStorage(storage)}`, rowIndex);
    }
  });

  const biPriceColumnIndex = findOrCreateSnapshotColumn(sheet, rows, headerRowIndex, targetDate, 'biPrice');
  let cellsWritten = 0;
  let rowsWritten = 0;
  let rowsAppended = 0;

  for (const draftRow of payload.rows) {
    const model = String(draftRow.model ?? '').trim();
    const storage = String(draftRow.storage ?? '').trim();
    const rowPpv = String(draftRow.ppv ?? '').trim();
    if (!model || !storage || (targetPpvs.size > 0 && !targetPpvs.has(rowPpv))) {
      continue;
    }

    const biPrice = parseNumericInput(draftRow.snapshots?.[targetDate]?.biPrice);
    if (biPrice === '') {
      continue;
    }

    let rowIndex =
      (rowPpv ? rowIndexByKey.get(`ppv:${rowPpv}`) : undefined) ??
      rowIndexByKey.get(`model:${model}::${normalizeStorage(storage)}`);

    if (rowIndex === undefined) {
      rowIndex = rows.length;
      rows.push([]);
      rowsAppended += 1;

      const baseValues = [
        [modelIndex, model],
        [storageIndex, storage],
        [positionIndex, String(draftRow.position ?? '').trim()],
        [ppvIndex, rowPpv],
        [launchPriceIndex, parseNumericInput(draftRow.launchPrice)],
      ].filter(([columnIndex]) => columnIndex !== -1);

      for (const [columnIndex, value] of baseValues) {
        if (value === '') {
          continue;
        }
        XLSX.utils.sheet_add_aoa(sheet, [[value]], { origin: { r: rowIndex, c: columnIndex } });
        rows[rowIndex][columnIndex] = value;
        cellsWritten += 1;
      }
    }

    XLSX.utils.sheet_add_aoa(sheet, [[biPrice]], { origin: { r: rowIndex, c: biPriceColumnIndex } });
    rows[rowIndex][biPriceColumnIndex] = biPrice;
    cellsWritten += 1;
    rowsWritten += 1;

    if (rowPpv) {
      rowIndexByKey.set(`ppv:${rowPpv}`, rowIndex);
    }
    rowIndexByKey.set(`model:${model}::${normalizeStorage(storage)}`, rowIndex);
  }

  XLSX.writeFile(workbook, workbookPath);
  return {
    workbookPath,
    mode: 'latestBiPriceOnly',
    targetDate,
    rowsWritten,
    cellsWritten,
    rowsAppended,
  };
}

app.get('/api/health', (_request, response) => {
  response.json({
    ok: true,
    storage: 'sqlite',
    databasePath,
    marketTrendDatabasePath,
    workbookPath,
    marketTrendWorkbookPath,
    weeklySalesDatabasePath: weeklySalesService.databasePath,
    weeklySalesWorkbookPath: weeklySalesService.workbookPath,
  });
});

app.get('/api/raw-editor-draft', async (_request, response) => {
  const draft = readDraftFromDatabase();
  if (!draft) {
    response.status(404).json({ message: 'No draft found' });
    return;
  }

  response.json(draft);
});

app.post('/api/raw-editor-draft', async (request, response) => {
  const payload = request.body;
  if (!isValidDraftPayload(payload)) {
    response.status(400).json({ message: 'Invalid raw editor draft payload' });
    return;
  }

  await ensureDataDir();
  const nextDraft = writeDraftToDatabase(payload);
  if (payload.syncWorkbook === true) {
    try {
      const workbookResult =
        payload.workbookSyncMode === 'latestBiPriceOnly' ? writeLatestBiPricesToWorkbook(payload) : writeDraftToWorkbook(payload);
      response.json({ ok: true, savedAt: nextDraft.savedAt, workbook: workbookResult });
    } catch (error) {
      response.status(500).json({
        message: error instanceof Error ? error.message : 'Excel 写回失败',
        savedAt: nextDraft.savedAt,
      });
    }
    return;
  }

  response.json({ ok: true, savedAt: nextDraft.savedAt });
});

app.get('/api/market-trend/overview', async (_request, response) => {
  try {
    const draft = readMarketTrendDraftFromDatabase();
    const payload = draft ?? readMarketTrendFromWorkbook();
    response.json(buildMarketTrendOverview(payload));
  } catch (error) {
    response.status(500).json({
      message: error instanceof Error ? error.message : '市场趋势数据读取失败',
    });
  }
});

app.post('/api/market-trend/draft', async (request, response) => {
  const payload = request.body;
  const validation = validateMarketTrendPayload(payload);
  if (validation.errors.length > 0) {
    response.status(400).json({ message: validation.errors.join('；'), validation });
    return;
  }

  await ensureDataDir();
  const nextDraft = writeMarketTrendDraftToDatabase(payload);
  response.json({ ok: true, savedAt: nextDraft.savedAt, validation });
});

app.post('/api/market-trend/apply', async (request, response) => {
  const payload = request.body;
  const validation = validateMarketTrendPayload(payload);
  if (validation.errors.length > 0) {
    response.status(400).json({ message: validation.errors.join('；'), validation });
    return;
  }

  try {
    await ensureDataDir();
    const nextDraft = writeMarketTrendDraftToDatabase(payload);
    const workbook = writeMarketTrendToWorkbook(nextDraft);
    response.json({ ok: true, savedAt: nextDraft.savedAt, workbook, validation, overview: buildMarketTrendOverview(nextDraft) });
  } catch (error) {
    response.status(500).json({
      message: error instanceof Error ? error.message : '市场趋势数据写回 Excel 失败',
      validation,
    });
  }
});

app.post('/api/market-trend/weeks', async (request, response) => {
  try {
    const currentPayload = readMarketTrendDraftFromDatabase() ?? readMarketTrendFromWorkbook();
    const nextPayload = mergeMarketTrendWeek(currentPayload, request.body, request.body?.allowUpdate === true);
    const validation = validateMarketTrendPayload(nextPayload);
    if (validation.errors.length > 0) {
      response.status(400).json({ message: validation.errors.join('；'), validation });
      return;
    }

    await ensureDataDir();
    const nextDraft = writeMarketTrendDraftToDatabase(nextPayload);
    const workbook = writeMarketTrendToWorkbook(nextDraft);
    response.json({ ok: true, savedAt: nextDraft.savedAt, workbook, validation, overview: buildMarketTrendOverview(nextDraft) });
  } catch (error) {
    response.status(500).json({
      message: error instanceof Error ? error.message : '市场趋势周度数据落数失败',
    });
  }
});

app.post('/api/bi-price-lookup', async (request, response) => {
  const ppvs = Array.isArray(request.body?.ppv)
    ? request.body.ppv
    : Array.isArray(request.body?.ppvs)
      ? request.body.ppvs
      : [];
  const normalizedPpvs = ppvs.map((item) => String(item ?? '').trim()).filter(Boolean);

  if (normalizedPpvs.length === 0) {
    response.status(400).json({ message: 'ppv is required' });
    return;
  }

  try {
    const token = (await fs.readFile(dailyPriceTokenPath, 'utf8')).trim();
    const lookupResponse = await fetch(dailyPriceLookupUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ppv: normalizedPpvs }),
    });
    const payload = await lookupResponse.json();

    if (!lookupResponse.ok) {
      response.status(lookupResponse.status).json(payload);
      return;
    }

    response.json(payload);
  } catch (error) {
    response.status(502).json({
      message: error instanceof Error ? error.message : 'BI 出货价接口调用失败',
    });
  }
});

app.get('/api/workbook.xlsx', (_request, response) => {
  response.sendFile(workbookPath, {
    headers: {
      'Cache-Control': 'no-store',
    },
  });
});

if (fsSync.existsSync(distDir)) {
  app.use(express.static(distDir, { index: false }));

  app.get('*', (request, response, next) => {
    if (request.path.startsWith('/api/')) {
      next();
      return;
    }

    response.sendFile(indexHtmlPath);
  });
}

ensureDataDir()
  .then(() => migrateLegacyDraftIfNeeded())
  .then(() => migrateLegacyMarketTrendDraftIfNeeded())
  .then(() => {
    weeklySalesService.startAutomationScheduler();
    app.listen(port, () => {
      console.log(`price-monitor-api listening on http://localhost:${port}`);
    });
  })
  .catch((error) => {
    console.error('Failed to initialize price-monitor-api', error);
    process.exit(1);
  });
