import * as XLSX from 'xlsx';
import workbookUrl from '../新机售价数据源.xlsx?url';

export interface PriceSnapshot {
  date: string;
  listPrice: number;
  coupon: number;
  finalPrice: number;
}

export interface SKUData {
  id: string;
  brand: string;
  model: string;
  series: string;
  storage: string;
  launchPrice: number;
  snapshots: PriceSnapshot[];
}

export interface WorkbookDataset {
  skus: SKUData[];
  dates: string[];
  brands: string[];
  loadedAt: string;
  sourceName: string;
}

type SnapshotMetric = 'finalPrice' | 'listPrice' | 'coupon';

interface SnapshotColumnMap {
  label: string;
  finalPrice?: number;
  listPrice?: number;
  coupon?: number;
}

const KNOWN_BRANDS = ['REDMI', 'iQOO', 'OPPO', 'vivo', '华为', '荣耀', '一加', '小米'];
const SOURCE_NAME = '新机售价数据源.xlsx';

let workbookPromise: Promise<WorkbookDataset> | null = null;

function normalizeHeader(value: unknown) {
  return String(value ?? '').replace(/\s+/g, '').trim();
}

function parseNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  const normalized = String(value ?? '').replace(/,/g, '').trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toDateLabel(header: string) {
  const dottedMatch = header.match(/(\d{1,2})\.(\d{1,2})/);
  if (dottedMatch) {
    return `${Number(dottedMatch[1])}.${dottedMatch[2].padStart(2, '0')}`;
  }

  const compactMatch = header.match(/(\d{2})(\d{2})/);
  if (compactMatch) {
    return `${Number(compactMatch[1])}.${compactMatch[2].padStart(2, '0')}`;
  }

  return null;
}

function toSnapshotMetric(header: string): SnapshotMetric | null {
  if (header.includes('国补后')) {
    return 'finalPrice';
  }

  if (header.includes('挂牌价') || header.includes('面价')) {
    return 'listPrice';
  }

  if (header.includes('优惠')) {
    return 'coupon';
  }

  return null;
}

function sortDateLabels(left: string, right: string) {
  const [leftMonth, leftDay] = left.split('.').map(Number);
  const [rightMonth, rightDay] = right.split('.').map(Number);
  return leftMonth === rightMonth ? leftDay - rightDay : leftMonth - rightMonth;
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

function parseWorkbook(arrayBuffer: ArrayBuffer): WorkbookDataset {
  const workbook = XLSX.read(arrayBuffer, { type: 'array' });
  const [sheetName] = workbook.SheetNames;

  if (!sheetName) {
    throw new Error('Excel 文件中没有可读取的工作表。');
  }

  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: true,
    defval: '',
  });

  if (rows.length < 2) {
    throw new Error('Excel 数据为空，无法生成页面内容。');
  }

  const headers = (rows[0] ?? []).map(normalizeHeader);
  const dateColumns = new Map<string, SnapshotColumnMap>();

  headers.forEach((header, index) => {
    if (!header || index < 3) {
      return;
    }

    const dateLabel = toDateLabel(header);
    const metric = toSnapshotMetric(header);

    if (!dateLabel || !metric) {
      return;
    }

    const currentMapping = dateColumns.get(dateLabel) ?? { label: dateLabel };
    currentMapping[metric] = index;
    dateColumns.set(dateLabel, currentMapping);
  });

  const dates = Array.from(dateColumns.keys()).sort(sortDateLabels);
  const skus = rows
    .slice(1)
    .map((row, index) => {
      const model = String(row[0] ?? '').trim();
      const storage = String(row[1] ?? '').trim();
      const launchPrice = parseNumber(row[2]);

      if (!model || !storage) {
        return null;
      }

      const brand = inferBrand(model);
      const series = inferSeries(model, brand);
      const snapshots = dates
        .map((date) => {
          const mapping = dateColumns.get(date);
          if (!mapping) {
            return null;
          }

          const finalPrice = parseNumber(mapping.finalPrice === undefined ? '' : row[mapping.finalPrice]);
          const listPrice = parseNumber(mapping.listPrice === undefined ? '' : row[mapping.listPrice]);
          const coupon = parseNumber(mapping.coupon === undefined ? '' : row[mapping.coupon]);

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
        .filter((snapshot): snapshot is PriceSnapshot => snapshot !== null);

      return {
        id: `${model}-${storage}-${index + 2}`,
        brand,
        model,
        series,
        storage,
        launchPrice,
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
    sourceName: SOURCE_NAME,
  };
}

export async function loadWorkbookData() {
  if (!workbookPromise) {
    if (typeof window !== 'undefined' && window.__PRELOADED_WORKBOOK_DATA__) {
      workbookPromise = Promise.resolve(window.__PRELOADED_WORKBOOK_DATA__);
    } else {
      workbookPromise = fetch(workbookUrl)
        .then((response) => {
          if (!response.ok) {
            throw new Error(`Excel 文件读取失败: ${response.status}`);
          }

          return response.arrayBuffer();
        })
        .then(parseWorkbook);
    }
  }

  return workbookPromise;
}
