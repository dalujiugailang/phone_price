import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const SOURCE_NAME = '新机售价数据源.xlsx';
const DIST_DIR = path.join(projectRoot, 'dist');
const WEB_CACHE_DIR = path.join(projectRoot, 'Web Cache');
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
    throw new Error('Excel 数据为空，无法生成网页缓存。');
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
        series: '',
        storage,
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
    sourceName: SOURCE_NAME,
  };
}

function formatCacheDate(dateLabel) {
  const [month, day] = dateLabel.split('.');
  return `2026-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

async function ensureBuildExists() {
  const indexPath = path.join(DIST_DIR, 'index.html');
  await fs.access(indexPath);
}

async function copyDirectory(sourceDir, targetDir) {
  await fs.mkdir(targetDir, { recursive: true });
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, targetPath);
    } else if (entry.isFile()) {
      await fs.copyFile(sourcePath, targetPath);
    }
  }
}

async function main() {
  await ensureBuildExists();

  const dataset = parseWorkbook(path.join(projectRoot, SOURCE_NAME));
  const latestDate = dataset.dates.at(-1);

  if (!latestDate) {
    throw new Error('未识别到任何监测日期，无法生成网页缓存。');
  }

  const cacheDate = formatCacheDate(latestDate);
  const cacheDir = path.join(WEB_CACHE_DIR, `新机售价监控报告_${cacheDate}`);
  const cacheAssetsDir = path.join(cacheDir, 'assets');
  const distAssetsDir = path.join(DIST_DIR, 'assets');
  const distIndexPath = path.join(DIST_DIR, 'index.html');
  const cacheHtmlPath = path.join(cacheDir, `新机售价监控报告_${cacheDate}.html`);

  await fs.rm(cacheDir, { recursive: true, force: true });
  await fs.mkdir(cacheDir, { recursive: true });
  await copyDirectory(distAssetsDir, cacheAssetsDir);

  const distHtml = await fs.readFile(distIndexPath, 'utf8');
  const jsMatch = distHtml.match(/src="\/assets\/([^"]+\.js)"/);
  const cssMatch = distHtml.match(/href="\/assets\/([^"]+\.css)"/);

  if (!jsMatch || !cssMatch) {
    throw new Error('未能从构建产物中识别 JS/CSS 资源。');
  }

  const jsFileName = jsMatch[1];
  const jsCachePath = path.join(cacheAssetsDir, jsFileName);
  const jsContent = await fs.readFile(jsCachePath, 'utf8');
  const rewrittenJsContent = jsContent.replaceAll('/assets/', './assets/');

  await fs.writeFile(jsCachePath, rewrittenJsContent, 'utf8');

  const preloadedDataScript = `<script>window.__PRELOADED_WORKBOOK_DATA__ = ${JSON.stringify(dataset)};</script>`;
  const cacheHtml = distHtml
    .replace('<html lang="en">', '<html lang="zh-CN">')
    .replace('<title>新机售价监控系统</title>', `<title>新机售价监控报告_${cacheDate}</title>`)
    .replace('<title>My Google AI Studio App</title>', `<title>新机售价监控报告_${cacheDate}</title>`)
    .replace(/(src|href)="\/assets\//g, '$1="./assets/')
    .replace(/<script\b[^>]*src="\.\/assets\/([^"]+\.js)"[^>]*><\/script>/, '<script defer src="./assets/$1"></script>')
    .replace(/<link\b[^>]*href="\.\/assets\/([^"]+\.css)"[^>]*>/, '<link rel="stylesheet" href="./assets/$1">')
    .replace('</head>', `  ${preloadedDataScript}\n</head>`);

  await fs.writeFile(cacheHtmlPath, cacheHtml, 'utf8');

  console.log(`交互式网页缓存已生成: ${cacheHtmlPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
