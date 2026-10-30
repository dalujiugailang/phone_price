import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DuckDBInstance } from '@duckdb/node-api';

import { buildAnalysis, loadCurrentPriceDataset } from '../server/lib/price-data.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const dataDir = process.env.PRICE_MONITOR_DATA_DIR || path.join(projectRoot, 'data');
const warehousePath =
  process.env.GTM_WAREHOUSE_PATH || path.join(dataDir, 'warehouse', 'gtm_warehouse.duckdb');
const workbookPath =
  process.env.PRICE_MONITOR_WORKBOOK_PATH || path.join(dataDir, '新机售价监控.xlsx');
const rawDraftPath =
  process.env.PRICE_MONITOR_DRAFT_DB_PATH || path.join(dataDir, 'raw-editor-draft.sqlite');

function normalizeValue(value) {
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (value && typeof value === 'object' && typeof value.toString === 'function') {
    return value.toString();
  }
  return value;
}

function rowsToObjects(reader) {
  const names = reader.columnNames();
  return reader
    .getRows()
    .map((row) => Object.fromEntries(names.map((name, index) => [name, normalizeValue(row[index])])));
}

function latestAverage(points) {
  return points.at(-1)?.avgPrice ?? null;
}

function compareNumber(label, actual, expected, issues, tolerance = 1e-8) {
  if (actual === null || expected === null || Math.abs(Number(actual) - Number(expected)) > tolerance) {
    issues.push(`${label}不一致：数仓=${actual}，概览=${expected}`);
  }
}

async function main() {
  const instance = await DuckDBInstance.create(warehousePath, { access_mode: 'READ_ONLY' });
  const connection = await instance.connect();
  try {
    const duplicateReader = await connection.runAndReadAll(`
      SELECT '新机售价日事实表' AS table_name, COUNT(*) AS duplicate_grains
      FROM (
        SELECT price_date, sku_key
        FROM fact_new_sku_price_daily
        GROUP BY price_date, sku_key
        HAVING COUNT(*) > 1
      )
      UNION ALL
      SELECT '市场趋势周事实表', COUNT(*)
      FROM (
        SELECT year, week_index, entity_type, entity_name
        FROM fact_brand_market_weekly
        GROUP BY year, week_index, entity_type, entity_name
        HAVING COUNT(*) > 1
      )
      UNION ALL
      SELECT '新品周销事实表', COUNT(*)
      FROM (
        SELECT year, week_index, product_key
        FROM fact_new_product_sales_weekly
        GROUP BY year, week_index, product_key
        HAVING COUNT(*) > 1
      )
      UNION ALL
      SELECT '旧机S等级价格日事实表', COUNT(*)
      FROM (
        SELECT data_date, ppv
        FROM fact_used_s_grade_price_daily
        GROUP BY data_date, ppv
        HAVING COUNT(*) > 1
      )
    `);
    const duplicates = rowsToObjects(duplicateReader);
    const issues = duplicates
      .filter((row) => row.duplicate_grains > 0)
      .map((row) => `${row.table_name}存在${row.duplicate_grains}组重复颗粒度`);

    const qualityReader = await connection.runAndReadAll(`
      SELECT
        (SELECT COUNT(*) FROM dim_sku) AS sku_count,
        (SELECT COUNT(*) FROM fact_used_s_grade_price_daily) AS s_ppv_count,
        (SELECT COUNT(DISTINCT sku_key) FROM fact_used_s_grade_price_daily WHERE sku_key IS NOT NULL) AS matched_s_ppv_count,
        (SELECT COUNT(DISTINCT ppv) FROM bridge_ppv_sku_mapping WHERE mapping_status = '映射冲突') AS ambiguous_ppv_count,
        (SELECT COUNT(*) FROM bridge_ppv_sku_mapping WHERE mapping_status = '映射冲突') AS ambiguous_sku_count,
        (SELECT COUNT(*) FROM "新机价格走势表") AS price_trend_rows,
        (SELECT COUNT(*) FROM "新旧机风险表") AS risk_rows,
        (SELECT COUNT(*) FROM "新旧机风险表" WHERE "BI出货价" IS NOT NULL) AS matched_risk_rows,
        (SELECT COUNT(*) FROM "市场销量趋势表") AS market_sales_rows,
        (SELECT COUNT(*) FROM "市场销量趋势表" WHERE "品牌周度份额" IS NULL) AS market_share_null_rows,
        (SELECT MIN(price_date) FROM fact_new_sku_price_daily) AS new_price_min_date,
        (SELECT MAX(price_date) FROM fact_new_sku_price_daily) AS new_price_max_date,
        (SELECT MAX(data_date) FROM fact_used_s_grade_price_daily) AS bi_max_date
    `);
    const quality = rowsToObjects(qualityReader)[0];

    const dataset = loadCurrentPriceDataset({
      workbookPath,
      databasePath: rawDraftPath,
    });
    const overview = buildAnalysis(dataset);
    const configReader = await connection.runAndReadAll(`
      SELECT config_value
      FROM warehouse_config
      WHERE config_key = 'price_data_year'
    `);
    const priceDataYear = rowsToObjects(configReader)[0]?.config_value ?? '2026';
    const [latestMonth, latestDay] = dataset.dates.at(-1).split('.');
    const latestDate = dataset.dates.at(-1).includes('-') ? dataset.dates.at(-1) : `${priceDataYear}-${latestMonth.padStart(2, '0')}-${latestDay.padStart(2, '0')}`;
    const aggregateReader = await connection.runAndReadAll(`
      SELECT
        "聚合维度" AS dimension_type,
        "维度值" AS dimension_value,
        "国补后均价" AS avg_final_price,
        "SKU环比率均值" AS avg_sku_change_rate
      FROM "新机价格走势聚合表"
      WHERE "样本范围" = '全量'
        AND "日期" = CAST('${latestDate}' AS DATE)
        AND "聚合维度" IN ('品牌', '机型定位', '型号系列')
    `);
    const aggregateRows = rowsToObjects(aggregateReader);
    const aggregateMap = new Map(
      aggregateRows.map((row) => [`${row.dimension_type}::${row.dimension_value}`, row]),
    );

    for (const series of overview.seriesAnalysis) {
      const warehouse = aggregateMap.get(`型号系列::${series.model}`);
      if (!warehouse) {
        issues.push(`型号系列缺失：${series.model}`);
        continue;
      }
      compareNumber(
        `型号系列${series.model}最新均价`,
        warehouse.avg_final_price,
        latestAverage(series.snapshotAvgs),
        issues,
      );
    }

    for (const position of overview.positionAnalysis) {
      const warehouse = aggregateMap.get(`机型定位::${position.position}`);
      if (!warehouse) {
        issues.push(`机型定位缺失：${position.position}`);
        continue;
      }
      compareNumber(
        `机型定位${position.position}最新均价`,
        warehouse.avg_final_price,
        latestAverage(position.snapshotAvgs),
        issues,
      );
    }

    for (const brand of overview.brandAnalysis) {
      const warehouse = aggregateMap.get(`品牌::${brand.name}`);
      if (!warehouse) {
        issues.push(`品牌缺失：${brand.name}`);
        continue;
      }
      compareNumber(
        `品牌${brand.name}SKU环比率均值`,
        Number(warehouse.avg_sku_change_rate?.toFixed(4)),
        Number((brand.avgRecentChangePct / 100).toFixed(4)),
        issues,
        1e-4,
      );
    }

    if (quality.sku_count !== dataset.skus.length) {
      issues.push(`SKU数量不一致：数仓=${quality.sku_count}，当前数据源=${dataset.skus.length}`);
    }
    const warnings = [];
    if (quality.matched_s_ppv_count !== quality.sku_count) {
      warnings.push(
        `S等级PPV唯一匹配${quality.matched_s_ppv_count}/${quality.sku_count}；${quality.ambiguous_ppv_count}个PPV涉及${quality.ambiguous_sku_count}个冲突SKU`,
      );
    }

    const result = {
      ok: issues.length === 0,
      warehousePath,
      duplicates,
      quality,
      overviewParity: {
        latestDate,
        brandsChecked: overview.brandAnalysis.length,
        positionsChecked: overview.positionAnalysis.length,
        modelsChecked: overview.seriesAnalysis.length,
      },
      warnings,
      issues,
    };
    console.log(JSON.stringify(result, null, 2));
    if (issues.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    connection.closeSync();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
