import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const SOURCE_NAME = '新机售价数据源.xlsx';
const REPORT_DIR = path.join(projectRoot, 'reports');
const KNOWN_BRANDS = ['REDMI', 'iQOO', 'OPPO', 'vivo', '华为', '荣耀', '一加', '小米'];

function normalizeHeader(value) {
  return String(value ?? '').replace(/\s+/g, '').trim();
}

function parseNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  const normalized = String(value ?? '').replace(/,/g, '').trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toDateLabel(header) {
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

function toSnapshotMetric(header) {
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

function buildAttribution(listPriceDiff, couponDiff, recentChange, snapshotCount) {
  if (snapshotCount < 2) {
    return {
      reason: '暂无对比',
      reasonDetails: ['至少需要两个监测日期'],
    };
  }

  if (recentChange > 0) {
    const reasonDetails = [];
    if (listPriceDiff > 0) {
      reasonDetails.push('挂牌价上调');
    }
    if (couponDiff < 0) {
      reasonDetails.push('优惠券力度收缩');
    }

    return {
      reason: '上涨',
      reasonDetails: reasonDetails.length > 0 ? reasonDetails : ['综合因素带动上涨'],
    };
  }

  if (recentChange < 0) {
    const reasonDetails = [];
    if (listPriceDiff < 0) {
      reasonDetails.push('挂牌价下调');
    }
    if (couponDiff > 0) {
      reasonDetails.push('优惠券力度加大');
    }

    return {
      reason: '下跌',
      reasonDetails: reasonDetails.length > 0 ? reasonDetails : ['综合因素带动下跌'],
    };
  }

  if (listPriceDiff === 0 && couponDiff === 0) {
    return {
      reason: '持平',
      reasonDetails: ['挂牌价和优惠券均无变化'],
    };
  }

  const reasonDetails = [];
  if (listPriceDiff !== 0) {
    reasonDetails.push(`挂牌价${listPriceDiff > 0 ? '上调' : '下调'}`);
  }
  if (couponDiff !== 0) {
    reasonDetails.push(`优惠券力度${couponDiff > 0 ? '增加' : '减少'}`);
  }

  return {
    reason: '持平',
    reasonDetails: reasonDetails.length > 0 ? reasonDetails : ['价格因素相互抵消'],
  };
}

function formatPrice(value) {
  return `¥${Math.round(value).toLocaleString('zh-CN')}`;
}

function formatSignedNumber(value) {
  return `${value > 0 ? '+' : ''}${Math.round(value)}`;
}

function formatSignedPercent(value) {
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function toReportDate(dateLabel, now = new Date()) {
  const [month = '01', day = '01'] = dateLabel.split('.');
  const year = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
  }).format(now);

  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

function parseWorkbook(filePath) {
  const workbook = XLSX.readFile(filePath);
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
    throw new Error('Excel 数据为空，无法生成报告。');
  }

  const headers = (rows[0] ?? []).map(normalizeHeader);
  const dateColumns = new Map();

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
        .filter(Boolean);

      return {
        id: `${model}-${storage}-${index + 2}`,
        brand,
        model,
        storage,
        launchPrice,
        snapshots,
      };
    })
    .filter(Boolean);

  return {
    sourceName: SOURCE_NAME,
    dates,
    skus,
    brands: Array.from(new Set(skus.map((sku) => sku.brand))).sort((left, right) =>
      left.localeCompare(right, 'zh-Hans-CN', { sensitivity: 'base' }),
    ),
  };
}

function analyzeDataset(dataset) {
  const skuList = dataset.skus.map((sku) => {
    const last = sku.snapshots[sku.snapshots.length - 1];
    const prev = sku.snapshots[sku.snapshots.length - 2] ?? last;
    const recentChange = last ? last.finalPrice - prev.finalPrice : 0;
    const totalChange = last ? last.finalPrice - sku.launchPrice : 0;
    const recentChangePct = prev?.finalPrice ? (recentChange / prev.finalPrice) * 100 : 0;
    const listPriceDiff = (last?.listPrice ?? 0) - (prev?.listPrice ?? 0);
    const couponDiff = (last?.coupon ?? 0) - (prev?.coupon ?? 0);
    const attribution = buildAttribution(listPriceDiff, couponDiff, recentChange, sku.snapshots.length);

    return {
      ...sku,
      last,
      prev,
      recentChange,
      totalChange,
      recentChangePct,
      listPriceDiff,
      couponDiff,
      reason: attribution.reason,
      reasonDetails: attribution.reasonDetails,
    };
  });

  const brandMap = new Map();
  skuList.forEach((sku) => {
    const current = brandMap.get(sku.brand) ?? { totalPct: 0, count: 0 };
    current.totalPct += sku.recentChangePct;
    current.count += 1;
    brandMap.set(sku.brand, current);
  });

  const brandAnalysis = Array.from(brandMap.entries())
    .map(([brand, value]) => ({
      brand,
      skuCount: value.count,
      avgRecentChangePct: value.count ? value.totalPct / value.count : 0,
    }))
    .sort((left, right) => right.avgRecentChangePct - left.avgRecentChangePct);

  const modelMap = new Map();
  skuList.forEach((sku) => {
    const current = modelMap.get(sku.model) ?? {
      brand: sku.brand,
      currentPrices: [],
      previousPrices: [],
      launchPrices: [],
    };

    current.currentPrices.push(sku.last?.finalPrice ?? 0);
    current.previousPrices.push(sku.prev?.finalPrice ?? 0);
    current.launchPrices.push(sku.launchPrice);
    modelMap.set(sku.model, current);
  });

  const modelAnalysis = Array.from(modelMap.entries())
    .map(([model, value]) => {
      const avgCurrent = value.currentPrices.reduce((sum, item) => sum + item, 0) / value.currentPrices.length;
      const avgPrevious = value.previousPrices.reduce((sum, item) => sum + item, 0) / value.previousPrices.length;
      const avgLaunch = value.launchPrices.reduce((sum, item) => sum + item, 0) / value.launchPrices.length;
      const diff = avgCurrent - avgPrevious;
      const diffPct = avgPrevious ? (diff / avgPrevious) * 100 : 0;

      return {
        model,
        brand: value.brand,
        avgCurrent,
        avgPrevious,
        avgLaunch,
        diff,
        diffPct,
      };
    })
    .sort((left, right) => Math.abs(right.diffPct) - Math.abs(left.diffPct));

  const rising = skuList.filter((sku) => sku.recentChange > 0).sort((left, right) => right.recentChangePct - left.recentChangePct);
  const falling = skuList.filter((sku) => sku.recentChange < 0).sort((left, right) => left.recentChangePct - right.recentChangePct);
  const volatile = [...skuList].sort((left, right) => Math.abs(right.recentChangePct) - Math.abs(left.recentChangePct));
  const biggestDiscounts = [...skuList]
    .filter((sku) => sku.totalChange < 0)
    .sort((left, right) => left.totalChange - right.totalChange);

  const avgVolatility =
    skuList.length > 0 ? skuList.reduce((sum, sku) => sum + Math.abs(sku.recentChangePct), 0) / skuList.length : 0;

  return {
    skuList,
    brandAnalysis,
    modelAnalysis,
    rising,
    falling,
    volatile,
    biggestDiscounts,
    avgVolatility,
  };
}

function buildTable(headers, rows) {
  const headerLine = `| ${headers.join(' | ')} |`;
  const dividerLine = `| ${headers.map(() => '---').join(' | ')} |`;
  const bodyLines = rows.map((row) => `| ${row.join(' | ')} |`);
  return [headerLine, dividerLine, ...bodyLines].join('\n');
}

function renderReport(dataset, analysis, generatedAt) {
  const dates = dataset.dates;
  const latestDate = dates.at(-1) ?? '--';
  const previousDate = dates.at(-2) ?? latestDate;
  const riseCount = analysis.rising.length;
  const fallCount = analysis.falling.length;
  const flatCount = analysis.skuList.length - riseCount - fallCount;
  const topRise = analysis.rising[0];
  const topFall = analysis.falling[0];
  const topBrand = analysis.brandAnalysis[0];
  const bottomBrand = analysis.brandAnalysis.at(-1);
  const topModel = analysis.modelAnalysis[0];

  const overviewLines = [
    `- 报告生成时间：${generatedAt}`,
    `- 数据源：${dataset.sourceName}`,
    `- 监控周期：${dates[0] ?? '--'} 至 ${latestDate}`,
    `- 最新环比窗口：${previousDate} -> ${latestDate}`,
    `- 覆盖 SKU 数：${analysis.skuList.length}`,
    `- 覆盖品牌数：${dataset.brands.length}`,
    `- 最新涨价 SKU：${riseCount}`,
    `- 最新降价 SKU：${fallCount}`,
    `- 最新持平 SKU：${flatCount}`,
    `- 平均波动幅度：${analysis.avgVolatility.toFixed(2)}%`,
  ];

  const summaryLines = [];
  if (topRise) {
    summaryLines.push(
      `- 最大涨幅 SKU 为 ${topRise.model} ${topRise.storage}，最新国补后价格环比 ${formatSignedNumber(
        topRise.recentChange,
      )} 元，涨幅 ${formatSignedPercent(topRise.recentChangePct)}。`,
    );
  }
  if (topFall) {
    summaryLines.push(
      `- 最大跌幅 SKU 为 ${topFall.model} ${topFall.storage}，最新国补后价格环比 ${formatSignedNumber(
        topFall.recentChange,
      )} 元，跌幅 ${formatSignedPercent(topFall.recentChangePct)}。`,
    );
  }
  if (topBrand) {
    summaryLines.push(`- 品牌层面环比最强的是 ${topBrand.brand}，平均环比 ${formatSignedPercent(topBrand.avgRecentChangePct)}。`);
  }
  if (bottomBrand) {
    summaryLines.push(`- 品牌层面环比最弱的是 ${bottomBrand.brand}，平均环比 ${formatSignedPercent(bottomBrand.avgRecentChangePct)}。`);
  }
  if (topModel) {
    summaryLines.push(
      `- 型号均价波动最明显的是 ${topModel.model}，均价环比 ${formatSignedNumber(topModel.diff)} 元，幅度 ${formatSignedPercent(
        topModel.diffPct,
      )}。`,
    );
  }

  const brandTable = buildTable(
    ['品牌', 'SKU 数', '平均环比'],
    analysis.brandAnalysis.map((item) => [item.brand, String(item.skuCount), formatSignedPercent(item.avgRecentChangePct)]),
  );

  const risingRows = analysis.rising.slice(0, 10);
  const risingTable =
    risingRows.length > 0
      ? buildTable(
          ['型号', '存储', '最新价', '环比金额', '环比幅度', '归因'],
          risingRows.map((item) => [
            item.model,
            item.storage,
            formatPrice(item.last?.finalPrice ?? 0),
            `${formatSignedNumber(item.recentChange)} 元`,
            formatSignedPercent(item.recentChangePct),
            item.reasonDetails.join(' / '),
          ]),
        )
      : '本期没有出现涨价 SKU。';

  const fallingRows = analysis.falling.slice(0, 10);
  const fallingTable =
    fallingRows.length > 0
      ? buildTable(
          ['型号', '存储', '最新价', '环比金额', '环比幅度', '归因'],
          fallingRows.map((item) => [
            item.model,
            item.storage,
            formatPrice(item.last?.finalPrice ?? 0),
            `${formatSignedNumber(item.recentChange)} 元`,
            formatSignedPercent(item.recentChangePct),
            item.reasonDetails.join(' / '),
          ]),
        )
      : '本期没有出现降价 SKU。';

  const discountTable = buildTable(
    ['型号', '存储', '发售价', '最新价', '较发售价'],
    analysis.biggestDiscounts.slice(0, 10).map((item) => [
      item.model,
      item.storage,
      formatPrice(item.launchPrice),
      formatPrice(item.last?.finalPrice ?? 0),
      `${formatSignedNumber(item.totalChange)} 元`,
    ]),
  );

  const volatileTable = buildTable(
    ['型号', '存储', '环比金额', '环比幅度'],
    analysis.volatile.slice(0, 10).map((item) => [
      item.model,
      item.storage,
      `${formatSignedNumber(item.recentChange)} 元`,
      formatSignedPercent(item.recentChangePct),
    ]),
  );

  return `# 新机售价监控报告

## 数据概览
${overviewLines.join('\n')}

## 核心结论
${summaryLines.join('\n')}

## 品牌层环比表现
${brandTable}

## 最新涨价 SKU TOP10
${risingTable}

## 最新降价 SKU TOP10
${fallingTable}

## 波动最大 SKU TOP10
${volatileTable}

## 相对发售价降幅 TOP10
${discountTable}
`;
}

async function main() {
  const sourcePath = path.join(projectRoot, SOURCE_NAME);
  const dataset = parseWorkbook(sourcePath);
  const analysis = analyzeDataset(dataset);
  const latestDate = dataset.dates.at(-1);

  const now = new Date();
  const reportDate = latestDate ? toReportDate(latestDate, now) : new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const generatedAt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(now);

  const reportContent = renderReport(dataset, analysis, generatedAt);
  const datedReportPath = path.join(REPORT_DIR, `新机售价监控报告_${reportDate}.md`);
  const latestReportPath = path.join(REPORT_DIR, '最新监控报告.md');

  await fs.mkdir(REPORT_DIR, { recursive: true });
  await fs.writeFile(datedReportPath, reportContent, 'utf8');
  await fs.writeFile(latestReportPath, reportContent, 'utf8');

  console.log(`报告已生成: ${datedReportPath}`);
  console.log(`最新报告: ${latestReportPath}`);
  console.log(`覆盖 SKU: ${analysis.skuList.length}`);
  console.log(`最新环比窗口: ${dataset.dates.at(-2) ?? '--'} -> ${dataset.dates.at(-1) ?? '--'}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
