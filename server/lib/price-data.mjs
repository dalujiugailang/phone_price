import { DatabaseSync } from 'node:sqlite';
import XLSX from 'xlsx';

export const DEFAULT_SOURCE_NAME = '新机售价监控.xlsx';

const KNOWN_BRANDS = ['REDMI', 'iQOO', 'OPPO', 'vivo', '华为', '荣耀', '一加', '小米'];
const CHANGE_SUMMARY_MIN_AMOUNT = 11;
const LIST_PRICE_ATTRIBUTION_IGNORE_DIFF = 10;
const SERIES_PIVOT_IGNORE_AMOUNT = 10;

function normalizeHeader(value) {
  return String(value ?? '').replace(/\s+/g, '').trim();
}

function findHeaderIndex(headers, keywords) {
  return headers.findIndex((header) => keywords.some((keyword) => header.includes(keyword)));
}

function parseNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  const normalized = String(value ?? '').replace(/,/g, '').trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isExplicitZeroCell(value) {
  const normalized = String(value ?? '').replace(/\s+/g, '').trim();
  return normalized === '#VALUE!' || normalized === '已下架';
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

function toSnapshotMetric(header) {
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

function sortDateLabels(left, right) {
  const [leftMonth, leftDay] = left.split('.').map(Number);
  const [rightMonth, rightDay] = right.split('.').map(Number);
  return leftMonth === rightMonth ? leftDay - rightDay : leftMonth - rightMonth;
}

function inferBrand(modelName) {
  const matchedBrand = KNOWN_BRANDS.find((brand) => modelName.startsWith(brand));
  if (matchedBrand) {
    return matchedBrand;
  }

  const [firstToken] = modelName.split(/\s+/);
  return firstToken || modelName;
}

function inferSeries(modelName, brand) {
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

function normalizeListPriceDiffForAttribution(value) {
  return Math.abs(value) <= LIST_PRICE_ATTRIBUTION_IGNORE_DIFF ? 0 : value;
}

function buildAttribution(listPriceDiff, couponDiff, recentChange, snapshotCount) {
  if (snapshotCount < 2) {
    return {
      changeDirection: 'flat',
      reason: '暂无对比',
      reasonDetails: ['至少需要两个监测日期'],
    };
  }

  if (listPriceDiff === 0 && couponDiff === 0) {
    return {
      changeDirection: 'flat',
      reason: '持平',
      reasonDetails: ['挂牌价与优惠券均持平'],
    };
  }

  const reasonDetails = [];
  if (listPriceDiff !== 0) {
    reasonDetails.push(`挂牌价${listPriceDiff > 0 ? '升高' : '降低'}`);
  }
  if (couponDiff !== 0) {
    reasonDetails.push(`优惠券${couponDiff > 0 ? '升高' : '降低'}`);
  }

  if (recentChange > 0) {
    return {
      changeDirection: 'up',
      reason: '上涨',
      reasonDetails: reasonDetails.length > 0 ? reasonDetails : ['综合因素导致上涨'],
    };
  }

  if (recentChange < 0) {
    return {
      changeDirection: 'down',
      reason: '下跌',
      reasonDetails: reasonDetails.length > 0 ? reasonDetails : ['综合因素导致下跌'],
    };
  }

  return {
    changeDirection: 'flat',
    reason: '持平',
    reasonDetails: reasonDetails.length > 0 ? reasonDetails : ['价格变动相互抵消'],
  };
}

function compareText(left, right) {
  return String(left).localeCompare(String(right), 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
}

function isSeriesPivotChanged(series) {
  return Math.abs(series.diff) > SERIES_PIVOT_IGNORE_AMOUNT;
}

function sortSeriesPivotRows(items) {
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

function isPositionPivotChanged(position) {
  return Math.abs(position.diff) > SERIES_PIVOT_IGNORE_AMOUNT;
}

function sortPositionPivotRows(items) {
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

function sortRangeItems(items) {
  return [...items].sort((left, right) => compareText(left.model, right.model));
}

function sortMixedItems(items) {
  return [...items].sort((left, right) => compareText(left.model, right.model));
}

export function parseWorkbookFile(workbookPath, sourceName = DEFAULT_SOURCE_NAME) {
  const workbook = XLSX.readFile(workbookPath);
  const [sheetName] = workbook.SheetNames;
  if (!sheetName) {
    throw new Error('Excel 文件中没有可读取的工作表。');
  }

  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: true,
    defval: '',
  });

  if (rows.length < 2) {
    throw new Error('Excel 数据为空，无法生成 MCP 数据。');
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

  const dateColumns = new Map();
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

          return {
            date,
            finalPrice,
            listPrice,
            coupon,
            biPrice: biPrice || undefined,
          };
        })
        .filter(Boolean);

      return {
        id: `${model}-${storage}-${headerRowIndex + index + 2}`,
        brand,
        model,
        series,
        storage,
        position,
        ppv,
        launchPrice,
        snapshots,
      };
    })
    .filter(Boolean);

  const brands = Array.from(new Set(skus.map((sku) => sku.brand))).sort((left, right) =>
    left.localeCompare(right, 'zh-Hans-CN', { sensitivity: 'base' }),
  );

  return {
    skus,
    dates,
    brands,
    loadedAt: new Date().toISOString(),
    sourceName,
    sheetName,
  };
}

export function readRawEditorDraft(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = db
      .prepare(
        `
          SELECT dates_json, rows_json, saved_at, updated_at
          FROM raw_editor_drafts
          WHERE id = 1
        `,
      )
      .get();

    if (!row) {
      return null;
    }

    return {
      dates: JSON.parse(row.dates_json),
      rows: JSON.parse(row.rows_json),
      savedAt: row.saved_at,
      updatedAt: row.updated_at,
    };
  } finally {
    db.close();
  }
}

export function buildAnalysis(dataset) {
  if (!dataset || dataset.skus.length === 0) {
    return {
      skuList: [],
      brandAnalysis: [],
      positionAnalysis: [],
      seriesAnalysis: [],
    };
  }

  const processed = dataset.skus.map((sku) => {
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

  const brandMap = new Map();
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

  const positionMap = new Map();
  const seriesMap = new Map();

  processed.forEach((sku) => {
    const positionName = sku.position || '未定位';
    const positionCurrent = positionMap.get(positionName) ?? {
      skuCount: 0,
      launchPrices: [],
      snapshotPrices: {},
      directionSummary: { up: 0, down: 0, flat: 0 },
    };
    const current = seriesMap.get(sku.model) ?? {
      brand: sku.brand,
      launchPrices: [],
      snapshotPrices: {},
      directionSummary: { up: 0, down: 0, flat: 0 },
    };

    positionCurrent.skuCount += 1;
    positionCurrent.launchPrices.push(sku.launchPrice);
    current.launchPrices.push(sku.launchPrice);

    sku.snapshots.forEach((snapshot) => {
      if (!positionCurrent.snapshotPrices[snapshot.date]) {
        positionCurrent.snapshotPrices[snapshot.date] = [];
      }
      positionCurrent.snapshotPrices[snapshot.date].push(snapshot.finalPrice);

      if (!current.snapshotPrices[snapshot.date]) {
        current.snapshotPrices[snapshot.date] = [];
      }
      current.snapshotPrices[snapshot.date].push(snapshot.finalPrice);
    });

    if (sku.recentChange > 0) {
      positionCurrent.directionSummary.up += 1;
      current.directionSummary.up += 1;
    } else if (sku.recentChange < 0) {
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

export function buildChangeSummaryReport(skuList) {
  const listOnlyUpMap = new Map();
  const listOnlyDownMap = new Map();
  const couponOnlyDownMap = new Map();
  const couponOnlyUpMap = new Map();
  const mixedModelSet = new Set();
  const mixedMaps = {
    listUpCouponUp: new Map(),
    listUpCouponDown: new Map(),
    listDownCouponUp: new Map(),
    listDownCouponDown: new Map(),
  };

  const ensureRangeItem = (targetMap, sku, amount) => {
    const current = targetMap.get(sku.model) ?? { model: sku.model, storages: [], amounts: [] };
    current.storages.push(sku.storage);
    current.amounts.push(amount);
    targetMap.set(sku.model, current);
  };

  const ensureMixedItem = (targetMap, sku) => {
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

export function buildMetadata(dataset, draft = null) {
  return {
    sourceName: dataset.sourceName,
    sheetName: dataset.sheetName,
    loadedAt: dataset.loadedAt,
    latestDate: dataset.dates.at(-1) ?? null,
    previousDate: dataset.dates.at(-2) ?? null,
    dateCount: dataset.dates.length,
    skuCount: dataset.skus.length,
    brandCount: dataset.brands.length,
    brands: dataset.brands,
    draft: draft
      ? {
          savedAt: draft.savedAt,
          updatedAt: draft.updatedAt,
          dateCount: draft.dates.length,
          latestDate: draft.dates.at(-1) ?? null,
          rowCount: draft.rows.length,
          ppvRows: draft.rows.filter((row) => row?.ppv).length,
        }
      : null,
  };
}

export function querySkus(dataset, args = {}) {
  const limit = Math.min(Math.max(Number(args.limit ?? 50), 1), 200);
  const offset = Math.max(Number(args.offset ?? 0), 0);
  const normalizedBrand = String(args.brand ?? '').trim().toLowerCase();
  const normalizedModel = String(args.model ?? '').trim().toLowerCase();
  const normalizedPpv = String(args.ppv ?? '').trim().toLowerCase();
  const date = String(args.date ?? '').trim();

  const filtered = dataset.skus.filter((sku) => {
    if (normalizedBrand && !sku.brand.toLowerCase().includes(normalizedBrand)) {
      return false;
    }
    if (normalizedModel && !sku.model.toLowerCase().includes(normalizedModel)) {
      return false;
    }
    if (normalizedPpv && !sku.ppv.toLowerCase().includes(normalizedPpv)) {
      return false;
    }
    return true;
  });

  const items = filtered.slice(offset, offset + limit).map((sku) => {
    if (!date) {
      return sku;
    }

    return {
      ...sku,
      snapshots: sku.snapshots.filter((snapshot) => snapshot.date === date),
    };
  });

  return {
    items,
    total: filtered.length,
    limit,
    offset,
    nextOffset: offset + limit < filtered.length ? offset + limit : null,
  };
}

export function exportAllData({ workbookPath, databasePath, sourceName = DEFAULT_SOURCE_NAME }) {
  const dataset = parseWorkbookFile(workbookPath, sourceName);
  const draft = readRawEditorDraft(databasePath);
  const summary = buildAnalysis(dataset);

  return {
    metadata: buildMetadata(dataset, draft),
    workbookDataset: dataset,
    rawEditorDraft: draft,
    summary,
    changeSummary: buildChangeSummaryReport(summary.skuList),
  };
}
