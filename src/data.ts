import * as XLSX from 'xlsx';
import { getNewMachinePpvMapping } from './ppvMapping';

export interface PriceSnapshot {
  date: string;
  listPrice: number;
  coupon: number;
  finalPrice: number;
  biPrice?: number;
}

export interface SKUData {
  id: string;
  brand: string;
  model: string;
  series: string;
  storage: string;
  position: string;
  ppv: string;
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

type SnapshotMetric = 'finalPrice' | 'listPrice' | 'coupon' | 'biPrice';

interface SnapshotColumnMap {
  label: string;
  finalPrice?: number;
  listPrice?: number;
  coupon?: number;
  biPrice?: number;
}

const KNOWN_BRANDS = ['REDMI', 'iQOO', 'OPPO', 'vivo', '华为', '荣耀', '一加', '小米'];
const SOURCE_NAME = '新机售价监控.xlsx';
const WORKBOOK_URL = '/api/workbook.xlsx';
const WORKBOOK_FETCH_TIMEOUT_MS = 15000;

let workbookPromise: Promise<WorkbookDataset> | null = null;

function normalizeHeader(value: unknown) {
  return String(value ?? '').replace(/\s+/g, '').trim();
}

function findHeaderIndex(headers: string[], keywords: string[]) {
  return headers.findIndex((header) => keywords.some((keyword) => header.includes(keyword)));
}

function parseNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  const normalized = String(value ?? '').replace(/,/g, '').trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isExplicitZeroCell(value: unknown) {
  const normalized = String(value ?? '').replace(/\s+/g, '').trim();
  return normalized === '#VALUE!' || normalized === '已下架';
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
  const lowerHeader = header.toLowerCase();

  if (lowerHeader.includes('bi价') || lowerHeader.includes('bi出货价')) {
    return 'biPrice';
  }

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

  const headerRowIndex = rows.findIndex((row) => {
    const headers = row.map(normalizeHeader);
    return headers.includes('型号名称') && headers.includes('存储版本');
  });

  if (headerRowIndex === -1) {
    throw new Error('Excel 中未找到“型号名称 / 存储版本”表头。');
  }

  const groupHeaders = (rows[headerRowIndex - 1] ?? []).map(normalizeHeader);
  const headers = (rows[headerRowIndex] ?? []).map(normalizeHeader);
  const modelIndex = findHeaderIndex(headers, ['型号名称']);
  const storageIndex = findHeaderIndex(headers, ['存储版本']);
  const positionIndex = findHeaderIndex(headers, ['定位']);
  const ppvIndex = findHeaderIndex(headers, ['ppv']);
  const launchPriceIndex = findHeaderIndex(headers, ['发布挂牌售价', '发布价']);
  const brandIndex = findHeaderIndex(headers, ['所属品牌名称']);
  const seriesIndex = findHeaderIndex(headers, ['系列版本']);

  if (modelIndex === -1 || storageIndex === -1 || launchPriceIndex === -1) {
    throw new Error('Excel 中缺少型号名称、存储版本或发布价字段。');
  }

  const dateColumns = new Map<string, SnapshotColumnMap>();
  let currentGroupHeader = '';

  headers.forEach((header, index) => {
    const groupHeader = groupHeaders[index];
    if (groupHeader) {
      currentGroupHeader = groupHeader;
    }

    if (!header) {
      return;
    }

    const dateLabel = toDateLabel(currentGroupHeader) ?? toDateLabel(header);
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
    .slice(headerRowIndex + 1)
    .map((row, index) => {
      const model = String(row[modelIndex] ?? '').trim();
      const storage = String(row[storageIndex] ?? '').trim();
      const launchPrice = parseNumber(row[launchPriceIndex]);

      if (!model || !storage) {
        return null;
      }

      const brand = String(brandIndex === -1 ? '' : row[brandIndex] ?? '').trim() || inferBrand(model);
      const series = String(seriesIndex === -1 ? '' : row[seriesIndex] ?? '').trim() || inferSeries(model, brand);
      const position = String(positionIndex === -1 ? '' : row[positionIndex] ?? '').trim();
      const ppv = String(ppvIndex === -1 ? '' : row[ppvIndex] ?? '').trim();
      const ppvMapping = getNewMachinePpvMapping(model, storage);
      const snapshots = dates
        .map((date) => {
          const mapping = dateColumns.get(date);
          if (!mapping) {
            return null;
          }

          const finalPriceValue = mapping.finalPrice === undefined ? '' : row[mapping.finalPrice];
          const listPriceValue = mapping.listPrice === undefined ? '' : row[mapping.listPrice];
          const couponValue = mapping.coupon === undefined ? '' : row[mapping.coupon];
          const biPriceValue = mapping.biPrice === undefined ? '' : row[mapping.biPrice];
          const finalPrice = parseNumber(finalPriceValue);
          const listPrice = parseNumber(listPriceValue);
          const coupon = parseNumber(couponValue);
          const biPrice = parseNumber(biPriceValue);
          const hasExplicitZeroCell =
            isExplicitZeroCell(finalPriceValue) || isExplicitZeroCell(listPriceValue) || isExplicitZeroCell(couponValue);

          if (!finalPrice && !listPrice && !coupon && !biPrice && !hasExplicitZeroCell) {
            return null;
          }

          const snapshot: PriceSnapshot = {
            date,
            finalPrice,
            listPrice,
            coupon,
            biPrice: biPrice || undefined,
          };

          return snapshot;
        })
        .filter((snapshot): snapshot is PriceSnapshot => snapshot !== null);

      return {
        id: `${model}-${storage}-${headerRowIndex + index + 2}`,
        brand,
        model,
        series,
        storage,
        position: position || ppvMapping?.position || '',
        ppv: ppv || ppvMapping?.ppv || '',
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
      workbookPromise = new Promise<Response>((resolve, reject) => {
        const controller = new AbortController();
        const timeoutId = window.setTimeout(() => {
          controller.abort();
          reject(new Error('Excel 文件读取超时，请检查线上静态资源是否可访问。'));
        }, WORKBOOK_FETCH_TIMEOUT_MS);

        fetch(WORKBOOK_URL, { cache: 'no-store', signal: controller.signal })
          .then(resolve)
          .catch((error) => {
            if (error instanceof Error && error.name === 'AbortError') {
              return;
            }
            reject(error);
          })
          .finally(() => window.clearTimeout(timeoutId));
      })
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
