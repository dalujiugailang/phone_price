import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { DuckDBInstance } from '@duckdb/node-api';

import { loadCurrentPriceDataset } from '../server/lib/price-data.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const dataDir = process.env.PRICE_MONITOR_DATA_DIR || path.join(projectRoot, 'data');
const warehouseDir = path.join(dataDir, 'warehouse');
const warehousePath =
  process.env.GTM_WAREHOUSE_PATH || path.join(warehouseDir, 'gtm_warehouse.duckdb');
const workbookPath =
  process.env.PRICE_MONITOR_WORKBOOK_PATH || path.join(dataDir, '新机售价监控.xlsx');
const rawDraftPath =
  process.env.PRICE_MONITOR_DRAFT_DB_PATH || path.join(dataDir, 'raw-editor-draft.sqlite');
const weeklySalesPath =
  process.env.WEEKLY_SALES_DB_PATH || path.join(dataDir, 'weekly-sales.sqlite');
const marketTrendPath =
  process.env.MARKET_TREND_DRAFT_DB_PATH || path.join(dataDir, 'market-trend.sqlite');
const dailyPricePath =
  process.env.DAILY_PRICE_DUCKDB_PATH ||
  '/Users/dudu/Desktop/trae/重点日常项目/【daily price】/data/daily_price.duckdb';
const priceDataYear = Number(process.env.WAREHOUSE_PRICE_YEAR || 2026);
const newBatchStartDate = process.env.WAREHOUSE_NEW_BATCH_START_DATE || `${priceDataYear}-05-26`;

const CORE_MARKET_BRANDS = new Set([
  '苹果',
  '小米',
  'vivo总(含iQOO)',
  '华为',
  'OPPO总(含一加、realme)',
  '荣耀',
  'Others',
]);

function stableKey(prefix, ...parts) {
  const normalized = parts
    .map((part) =>
      String(part ?? '')
        .normalize('NFKC')
        .replace(/\s+/g, '')
        .toLowerCase(),
    )
    .join('|');
  return `${prefix}_${crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 20)}`;
}

function productKey(brand, productName) {
  return stableKey('product', brand, productName);
}

function skuKey(brand, model, storage) {
  return stableKey('sku', brand, model, storage);
}

function brandKey(brand) {
  return stableKey('brand', brand);
}

function toNumber(value) {
  const parsed = Number(String(value ?? '').replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function toIsoDate(dateLabel, year = priceDataYear) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(dateLabel))) return String(dateLabel);
  const matched = String(dateLabel ?? '').trim().match(/^(\d{1,2})\.(\d{1,2})$/);
  if (!matched) {
    return null;
  }
  return `${year}-${matched[1].padStart(2, '0')}-${matched[2].padStart(2, '0')}`;
}

function isoWeekDate(year, weekIndex, dayOffset = 0) {
  const januaryFourth = new Date(Date.UTC(year, 0, 4));
  const weekday = januaryFourth.getUTCDay() || 7;
  const monday = new Date(januaryFourth);
  monday.setUTCDate(januaryFourth.getUTCDate() - weekday + 1 + (weekIndex - 1) * 7 + dayOffset);
  return monday.toISOString().slice(0, 10);
}

function inferMarketYear(payload) {
  const years = (payload.weeks ?? [])
    .flatMap((item) => String(item.timeRange ?? '').match(/20\d{2}/g) ?? [])
    .map(Number)
    .filter(Number.isFinite);
  return years.length > 0 ? Math.max(...years) : Number(payload.year || priceDataYear);
}

function marketBrandFor(brand) {
  const normalized = String(brand ?? '').trim();
  const upper = normalized.toUpperCase();
  if (normalized === '苹果' || upper === 'APPLE') {
    return '苹果';
  }
  if (normalized === '小米' || normalized === '红米' || upper === 'REDMI' || upper === 'XIAOMI') {
    return '小米';
  }
  if (normalized === 'vivo' || normalized === 'iQOO') {
    return 'vivo总(含iQOO)';
  }
  if (normalized === '华为' || upper === 'HUAWEI') {
    return '华为';
  }
  if (normalized === 'OPPO' || normalized === '一加' || normalized === '真我' || upper === 'REALME') {
    return 'OPPO总(含一加、realme)';
  }
  if (normalized === '荣耀' || upper === 'HONOR') {
    return '荣耀';
  }
  return 'Others';
}

function brandGroupFor(brand) {
  const marketBrand = marketBrandFor(brand);
  if (marketBrand === 'vivo总(含iQOO)') {
    return 'vivo';
  }
  if (marketBrand === 'OPPO总(含一加、realme)') {
    return 'OPPO';
  }
  return marketBrand;
}

function sourceBrandFromMarketName(name) {
  const normalized = String(name ?? '').replace(/^-/, '').trim();
  if (normalized === 'vivo总(含iQOO)') {
    return 'vivo';
  }
  if (normalized === 'OPPO总(含一加、realme)') {
    return 'OPPO';
  }
  if (normalized === 'Others') {
    return 'Others';
  }
  return normalized;
}

function readWeeklySales() {
  const db = new DatabaseSync(weeklySalesPath, { readOnly: true });
  try {
    const rows = db
      .prepare(
        `
          SELECT
            m.standard_model_name,
            m.brand,
            m.series_position,
            m.price_band,
            m.launch_date,
            m.is_visible,
            m.sort_order,
            s.year,
            s.week_label,
            s.week_index,
            s.cumulative_sales,
            s.updated_at
          FROM weekly_cumulative_sales s
          JOIN weekly_model_dimension m
            ON m.standard_model_name = s.standard_model_name
          ORDER BY
            m.standard_model_name,
            s.year,
            s.week_index
        `,
      )
      .all();

    const previousByModel = new Map();
    return rows.map((row) => {
      const previous = previousByModel.get(row.standard_model_name);
      const weeklySales =
        previous === undefined
          ? Number(row.cumulative_sales)
          : Number((Number(row.cumulative_sales) - previous).toFixed(4));
      previousByModel.set(row.standard_model_name, Number(row.cumulative_sales));
      return {
        productKey: productKey(row.brand, row.standard_model_name),
        brandName: row.brand,
        standardModelName: row.standard_model_name,
        seriesPosition: row.series_position,
        priceBand: row.price_band,
        launchDate: row.launch_date || null,
        isVisible: Boolean(row.is_visible),
        sortOrder: Number(row.sort_order),
        year: Number(row.year),
        weekLabel: row.week_label,
        weekIndex: Number(row.week_index),
        weekStartDate: isoWeekDate(Number(row.year), Number(row.week_index)),
        weekEndDate: isoWeekDate(Number(row.year), Number(row.week_index), 6),
        cumulativeSales: Number(row.cumulative_sales),
        weeklySales,
        sourceUpdatedAt: row.updated_at,
      };
    });
  } finally {
    db.close();
  }
}

function readMarketTrend() {
  const db = new DatabaseSync(marketTrendPath, { readOnly: true });
  try {
    const row = db
      .prepare(
        `
          SELECT payload_json, saved_at
          FROM market_trend_drafts
          WHERE id = 1
        `,
      )
      .get();
    if (!row) {
      throw new Error('市场趋势数据库中没有可用数据');
    }

    const payload = JSON.parse(row.payload_json);
    const year = inferMarketYear(payload);
    const rows = [];
    for (const week of payload.weeks ?? []) {
      const weekIndex = Number(String(week.week ?? '').match(/\d+/)?.[0] ?? 0);
      const common = {
        year,
        weekLabel: String(week.week ?? '').toUpperCase(),
        weekIndex,
        weekStartDate: isoWeekDate(year, weekIndex),
        weekEndDate: isoWeekDate(year, weekIndex, 6),
        marketNote: String(week.marketNote ?? ''),
        eventName: String(week.eventName ?? ''),
        sourceSavedAt: row.saved_at,
      };
      rows.push({
        ...common,
        entityType: '大盘',
        entityName: '大盘',
        brandGroupName: '大盘',
        isCoreBrand: false,
        brandSharePct: null,
        totalIndex: toNumber(week.totalIndex),
      });

      for (const [entityName, values] of Object.entries(payload.brandShares ?? {})) {
        const share = toNumber(values?.[common.weekLabel]);
        if (share === null) {
          continue;
        }
        rows.push({
          ...common,
          entityType: '品牌',
          entityName,
          brandGroupName: brandGroupFor(sourceBrandFromMarketName(entityName)),
          isCoreBrand: CORE_MARKET_BRANDS.has(entityName),
          brandSharePct: Math.abs(share) < 1 ? Number((share * 100).toFixed(4)) : share,
          totalIndex: null,
        });
      }
    }
    return rows;
  } finally {
    db.close();
  }
}

function readNewPrice() {
  const dataset = loadCurrentPriceDataset({
    workbookPath,
    databasePath: rawDraftPath,
  });
  const rows = [];
  for (const sku of dataset.skus) {
    const currentSkuKey = skuKey(sku.brand, sku.model, sku.storage);
    const currentProductKey = productKey(sku.brand, sku.model);
    for (const snapshot of sku.snapshots) {
      const priceDate = toIsoDate(snapshot.date);
      if (!priceDate) {
        continue;
      }
      rows.push({
        skuKey: currentSkuKey,
        productKey: currentProductKey,
        brandName: sku.brand,
        seriesName: sku.series,
        modelName: sku.model,
        storage: sku.storage,
        modelPosition: sku.position || '',
        ppv: sku.ppv || '',
        priceDate,
        dateLabel: snapshot.date,
        launchPrice: toNumber(sku.launchPrice),
        finalPrice: toNumber(snapshot.finalPrice),
        listPrice: toNumber(snapshot.listPrice),
        coupon: toNumber(snapshot.coupon),
        workbookBiPrice: toNumber(snapshot.biPrice),
        isDelisted: Boolean(snapshot.isDelisted),
        sourceName: dataset.sourceName,
        sourceLoadedAt: dataset.loadedAt,
      });
    }
  }
  return { dataset, rows };
}

function buildDimensions(priceRows, weeklyRows, marketRows) {
  const brands = new Map();
  const products = new Map();
  const skus = new Map();

  const addBrand = (name) => {
    const brandName = String(name ?? '').trim() || '未识别';
    brands.set(brandKey(brandName), {
      brandKey: brandKey(brandName),
      brandName,
      brandGroupName: brandGroupFor(brandName),
      marketEntityName: marketBrandFor(brandName),
    });
  };

  for (const row of priceRows) {
    addBrand(row.brandName);
    products.set(row.productKey, {
      productKey: row.productKey,
      brandKey: brandKey(row.brandName),
      brandName: row.brandName,
      productName: row.modelName,
      seriesName: row.seriesName,
      modelName: row.modelName,
      modelPosition: row.modelPosition,
      seriesPosition: '',
      productGrain: '型号',
    });
    skus.set(row.skuKey, {
      skuKey: row.skuKey,
      productKey: row.productKey,
      brandKey: brandKey(row.brandName),
      brandName: row.brandName,
      modelName: row.modelName,
      storage: row.storage,
      ppv: row.ppv,
      launchPrice: row.launchPrice,
    });
  }

  for (const row of weeklyRows) {
    addBrand(row.brandName);
    const existing = products.get(row.productKey);
    products.set(row.productKey, {
      productKey: row.productKey,
      brandKey: brandKey(row.brandName),
      brandName: row.brandName,
      productName: row.standardModelName,
      seriesName: existing?.seriesName || row.standardModelName,
      modelName: existing?.modelName || row.standardModelName,
      modelPosition: existing?.modelPosition || '',
      seriesPosition: row.seriesPosition,
      productGrain: row.standardModelName.includes('系列') ? '系列' : '型号',
    });
  }

  for (const row of marketRows) {
    if (row.entityType === '品牌') {
      addBrand(sourceBrandFromMarketName(row.entityName));
    }
  }

  return {
    brands: [...brands.values()],
    products: [...products.values()],
    skus: [...skus.values()],
  };
}

function appendValue(appender, type, value) {
  if (value === null || value === undefined) {
    appender.appendNull();
    return;
  }
  if (type === 'string') {
    appender.appendVarchar(String(value));
  } else if (type === 'double') {
    appender.appendDouble(Number(value));
  } else if (type === 'integer') {
    appender.appendInteger(Number(value));
  } else if (type === 'boolean') {
    appender.appendBoolean(Boolean(value));
  } else {
    throw new Error(`不支持的写入类型：${type}`);
  }
}

async function appendRows(connection, tableName, rows, columns) {
  const appender = await connection.createAppender(tableName);
  try {
    for (const row of rows) {
      for (const [field, type] of columns) {
        appendValue(appender, type, row[field]);
      }
      appender.endRow();
    }
  } finally {
    appender.closeSync();
  }
}

function escapeSqlPath(filePath) {
  return filePath.replaceAll("'", "''");
}

function rowsToObjects(reader) {
  const names = reader.columnNames();
  return reader.getRows().map((row) =>
    Object.fromEntries(
      names.map((name, index) => [
        name,
        typeof row[index] === 'bigint'
          ? Number(row[index])
          : row[index] && typeof row[index] === 'object' && typeof row[index].toString === 'function'
            ? row[index].toString()
            : row[index],
      ]),
    ),
  );
}

async function main() {
  for (const requiredPath of [workbookPath, weeklySalesPath, marketTrendPath]) {
    if (!fsSync.existsSync(requiredPath)) {
      throw new Error(`缺少建仓数据源：${requiredPath}`);
    }
  }

  await fs.mkdir(warehouseDir, { recursive: true });

  const { dataset: priceDataset, rows: priceRows } = readNewPrice();
  const weeklyRows = readWeeklySales();
  const marketRows = readMarketTrend();
  const catalogRows = priceDataset.skus.map((sku) => ({
    skuKey: skuKey(sku.brand, sku.model, sku.storage),
    productKey: productKey(sku.brand, sku.model),
    brandName: sku.brand,
    seriesName: sku.series,
    modelName: sku.model,
    modelPosition: sku.position || '',
    storage: sku.storage,
    ppv: sku.ppv || '',
    launchPrice: sku.launchPrice > 0 ? toNumber(sku.launchPrice) : null,
  }));
  const dimensions = buildDimensions(catalogRows, weeklyRows, marketRows);

  const instance = await DuckDBInstance.create(warehousePath);
  const connection = await instance.connect();
  try {
    await connection.run(`
      CREATE OR REPLACE TABLE stg_brand (
        brand_key VARCHAR,
        brand_name VARCHAR,
        brand_group_name VARCHAR,
        market_entity_name VARCHAR
      );
      CREATE OR REPLACE TABLE stg_product (
        product_key VARCHAR,
        brand_key VARCHAR,
        brand_name VARCHAR,
        product_name VARCHAR,
        series_name VARCHAR,
        model_name VARCHAR,
        model_position VARCHAR,
        series_position VARCHAR,
        product_grain VARCHAR
      );
      CREATE OR REPLACE TABLE stg_sku (
        sku_key VARCHAR,
        product_key VARCHAR,
        brand_key VARCHAR,
        brand_name VARCHAR,
        model_name VARCHAR,
        storage VARCHAR,
        ppv VARCHAR,
        launch_price DOUBLE
      );
      CREATE OR REPLACE TABLE stg_new_price (
        sku_key VARCHAR,
        product_key VARCHAR,
        brand_name VARCHAR,
        series_name VARCHAR,
        model_name VARCHAR,
        storage VARCHAR,
        model_position VARCHAR,
        ppv VARCHAR,
        price_date VARCHAR,
        date_label VARCHAR,
        launch_price DOUBLE,
        final_price DOUBLE,
        list_price DOUBLE,
        coupon DOUBLE,
        workbook_bi_price DOUBLE,
        is_delisted BOOLEAN,
        source_name VARCHAR,
        source_loaded_at VARCHAR
      );
      CREATE OR REPLACE TABLE stg_weekly_sales (
        product_key VARCHAR,
        brand_name VARCHAR,
        standard_model_name VARCHAR,
        series_position VARCHAR,
        price_band VARCHAR,
        launch_date VARCHAR,
        is_visible BOOLEAN,
        sort_order INTEGER,
        year INTEGER,
        week_label VARCHAR,
        week_index INTEGER,
        week_start_date VARCHAR,
        week_end_date VARCHAR,
        cumulative_sales DOUBLE,
        weekly_sales DOUBLE,
        source_updated_at VARCHAR
      );
      CREATE OR REPLACE TABLE stg_market_trend (
        year INTEGER,
        week_label VARCHAR,
        week_index INTEGER,
        week_start_date VARCHAR,
        week_end_date VARCHAR,
        entity_type VARCHAR,
        entity_name VARCHAR,
        brand_group_name VARCHAR,
        is_core_brand BOOLEAN,
        brand_share_pct DOUBLE,
        total_index DOUBLE,
        market_note VARCHAR,
        event_name VARCHAR,
        source_saved_at VARCHAR
      );
    `);

    await appendRows(connection, 'stg_brand', dimensions.brands, [
      ['brandKey', 'string'],
      ['brandName', 'string'],
      ['brandGroupName', 'string'],
      ['marketEntityName', 'string'],
    ]);
    await appendRows(connection, 'stg_product', dimensions.products, [
      ['productKey', 'string'],
      ['brandKey', 'string'],
      ['brandName', 'string'],
      ['productName', 'string'],
      ['seriesName', 'string'],
      ['modelName', 'string'],
      ['modelPosition', 'string'],
      ['seriesPosition', 'string'],
      ['productGrain', 'string'],
    ]);
    await appendRows(connection, 'stg_sku', dimensions.skus, [
      ['skuKey', 'string'],
      ['productKey', 'string'],
      ['brandKey', 'string'],
      ['brandName', 'string'],
      ['modelName', 'string'],
      ['storage', 'string'],
      ['ppv', 'string'],
      ['launchPrice', 'double'],
    ]);
    await appendRows(connection, 'stg_new_price', priceRows, [
      ['skuKey', 'string'],
      ['productKey', 'string'],
      ['brandName', 'string'],
      ['seriesName', 'string'],
      ['modelName', 'string'],
      ['storage', 'string'],
      ['modelPosition', 'string'],
      ['ppv', 'string'],
      ['priceDate', 'string'],
      ['dateLabel', 'string'],
      ['launchPrice', 'double'],
      ['finalPrice', 'double'],
      ['listPrice', 'double'],
      ['coupon', 'double'],
      ['workbookBiPrice', 'double'],
      ['isDelisted', 'boolean'],
      ['sourceName', 'string'],
      ['sourceLoadedAt', 'string'],
    ]);
    await appendRows(connection, 'stg_weekly_sales', weeklyRows, [
      ['productKey', 'string'],
      ['brandName', 'string'],
      ['standardModelName', 'string'],
      ['seriesPosition', 'string'],
      ['priceBand', 'string'],
      ['launchDate', 'string'],
      ['isVisible', 'boolean'],
      ['sortOrder', 'integer'],
      ['year', 'integer'],
      ['weekLabel', 'string'],
      ['weekIndex', 'integer'],
      ['weekStartDate', 'string'],
      ['weekEndDate', 'string'],
      ['cumulativeSales', 'double'],
      ['weeklySales', 'double'],
      ['sourceUpdatedAt', 'string'],
    ]);
    await appendRows(connection, 'stg_market_trend', marketRows, [
      ['year', 'integer'],
      ['weekLabel', 'string'],
      ['weekIndex', 'integer'],
      ['weekStartDate', 'string'],
      ['weekEndDate', 'string'],
      ['entityType', 'string'],
      ['entityName', 'string'],
      ['brandGroupName', 'string'],
      ['isCoreBrand', 'boolean'],
      ['brandSharePct', 'double'],
      ['totalIndex', 'double'],
      ['marketNote', 'string'],
      ['eventName', 'string'],
      ['sourceSavedAt', 'string'],
    ]);

    const schemaSql = await fs.readFile(path.join(projectRoot, 'warehouse', 'schema.sql'), 'utf8');
    await connection.run(schemaSql);

    const hasDailyPriceSource = fsSync.existsSync(dailyPricePath);
    if (hasDailyPriceSource) {
      await connection.run(`
        ATTACH '${escapeSqlPath(dailyPricePath)}' AS daily_price_source (READ_ONLY)
      `);
    }

    await connection.run('BEGIN TRANSACTION');
    try {
      await connection.run('DELETE FROM price_collection_dates');
      const strictDates = [...new Set(priceDataset.skus.flatMap((sku) => sku.strictDates || []))].map((d) => toIsoDate(d)).filter(Boolean);
      for (const date of strictDates) await connection.run(`INSERT INTO price_collection_dates VALUES (CAST('${date}' AS DATE))`);
      await connection.run(`
        DELETE FROM dim_brand;
        INSERT INTO dim_brand
        SELECT DISTINCT brand_key, brand_name, brand_group_name, market_entity_name
        FROM stg_brand;

        DELETE FROM dim_product;
        INSERT INTO dim_product
        SELECT
          product_key,
          brand_key,
          brand_name,
          product_name,
          series_name,
          model_name,
          model_position,
          series_position,
          product_grain
        FROM stg_product;

        DELETE FROM dim_sku;
        INSERT INTO dim_sku
        SELECT
          sku_key,
          product_key,
          brand_key,
          brand_name,
          model_name,
          storage,
          ppv,
          launch_price
        FROM stg_sku;

        DELETE FROM bridge_ppv_sku_mapping;
        INSERT INTO bridge_ppv_sku_mapping
        SELECT
          ppv,
          sku_key,
          CASE
            WHEN COUNT(*) OVER (PARTITION BY ppv) = 1 THEN '唯一匹配'
            ELSE '映射冲突'
          END,
          COUNT(*) OVER (PARTITION BY ppv)
        FROM dim_sku
        WHERE COALESCE(ppv, '') <> '';

        DELETE FROM fact_new_sku_price_daily;
        INSERT INTO fact_new_sku_price_daily
        SELECT
          CAST(price_date AS DATE),
          date_label,
          sku_key,
          product_key,
          brand_name,
          series_name,
          model_name,
          storage,
          model_position,
          ppv,
          launch_price,
          final_price,
          list_price,
          coupon,
          workbook_bi_price,
          is_delisted,
          source_name,
          TRY_CAST(source_loaded_at AS TIMESTAMP)
        FROM stg_new_price;

        DELETE FROM fact_new_product_sales_weekly;
        INSERT INTO fact_new_product_sales_weekly
        SELECT
          year,
          week_label,
          week_index,
          CAST(week_start_date AS DATE),
          CAST(week_end_date AS DATE),
          product_key,
          brand_name,
          standard_model_name,
          series_position,
          price_band,
          TRY_CAST(launch_date AS DATE),
          is_visible,
          sort_order,
          cumulative_sales,
          weekly_sales,
          TRY_CAST(source_updated_at AS TIMESTAMP)
        FROM stg_weekly_sales;

        DELETE FROM fact_brand_market_weekly;
        INSERT INTO fact_brand_market_weekly
        SELECT
          year,
          week_label,
          week_index,
          CAST(week_start_date AS DATE),
          CAST(week_end_date AS DATE),
          entity_type,
          entity_name,
          brand_group_name,
          is_core_brand,
          brand_share_pct,
          total_index,
          market_note,
          event_name,
          TRY_CAST(source_saved_at AS TIMESTAMP)
        FROM stg_market_trend;

        DELETE FROM warehouse_config;
        INSERT INTO warehouse_config VALUES
          ('price_data_year', '${priceDataYear}'),
          ('new_batch_start_date', '${newBatchStartDate}'),
          ('new_price_source', '${escapeSqlPath(priceDataset.sourceName)}'),
          ('daily_price_source', '${escapeSqlPath(dailyPricePath)}');
      `);

      if (hasDailyPriceSource) {
        await connection.run(`
          DELETE FROM fact_used_s_grade_price_daily
          WHERE data_date IN (
            SELECT DISTINCT data_date
            FROM daily_price_source.price_current
            WHERE grade_name = 'S'
          );
          INSERT INTO fact_used_s_grade_price_daily
          SELECT
            p.data_date,
            p.ppv,
            s.sku_key,
            p.grade_id,
            p.grade_name,
            p.sku_name,
            p.bi_price,
            p.bi_base_price,
            p.final_quote,
            p.cost_price,
            p.source_file,
            p.imported_at
          FROM daily_price_source.price_current p
          LEFT JOIN (
            SELECT ppv, MAX(sku_key) AS sku_key
            FROM bridge_ppv_sku_mapping
            WHERE mapping_status = '唯一匹配'
            GROUP BY ppv
          ) s ON s.ppv = p.ppv
          WHERE p.grade_name = 'S';
        `);
      }

      await connection.run(`
        INSERT INTO warehouse_refresh_log
        SELECT
          current_timestamp,
          '${escapeSqlPath(priceDataset.sourceName)}',
          (SELECT COUNT(*) FROM fact_new_sku_price_daily),
          (SELECT COUNT(*) FROM fact_brand_market_weekly),
          (SELECT COUNT(*) FROM fact_new_product_sales_weekly),
          (SELECT COUNT(*) FROM fact_used_s_grade_price_daily);
      `);
      await connection.run('COMMIT');
    } catch (error) {
      await connection.run('ROLLBACK');
      throw error;
    }
    if (hasDailyPriceSource) {
      await connection.run('DETACH daily_price_source');
    }

    const viewsSql = await fs.readFile(path.join(projectRoot, 'warehouse', 'views.sql'), 'utf8');
    await connection.run(viewsSql);

    const summaryReader = await connection.runAndReadAll(`
      SELECT '新机售价日事实表' AS table_name, COUNT(*) AS row_count, MIN(price_date) AS min_date, MAX(price_date) AS max_date
      FROM fact_new_sku_price_daily
      UNION ALL
      SELECT '市场趋势周事实表', COUNT(*), MIN(week_start_date), MAX(week_end_date)
      FROM fact_brand_market_weekly
      UNION ALL
      SELECT '新品周销事实表', COUNT(*), MIN(week_start_date), MAX(week_end_date)
      FROM fact_new_product_sales_weekly
      UNION ALL
      SELECT '旧机S等级价格日事实表', COUNT(*), MIN(data_date), MAX(data_date)
      FROM fact_used_s_grade_price_daily
    `);
    const qualityReader = await connection.runAndReadAll(`
      SELECT
        (SELECT COUNT(*) FROM dim_sku) AS sku_count,
        (SELECT COUNT(*) FROM dim_product) AS product_count,
        (SELECT COUNT(DISTINCT sku_key) FROM fact_used_s_grade_price_daily WHERE sku_key IS NOT NULL) AS matched_s_ppv_count,
        (SELECT COUNT(DISTINCT ppv) FROM bridge_ppv_sku_mapping WHERE mapping_status = '映射冲突') AS ambiguous_ppv_count,
        (SELECT COUNT(*) FROM bridge_ppv_sku_mapping WHERE mapping_status = '映射冲突') AS ambiguous_sku_count,
        (SELECT COUNT(*) FROM "新旧机风险表" WHERE "BI出货价" IS NOT NULL) AS risk_row_count,
        (SELECT MAX("新机价格日期") FROM "新旧机风险表") AS latest_risk_price_date,
        (SELECT MAX("BI数据日期") FROM "新旧机风险表") AS latest_bi_date
    `);

    console.log(
      JSON.stringify(
        {
          warehousePath,
          facts: rowsToObjects(summaryReader),
          quality: rowsToObjects(qualityReader)[0],
        },
        null,
        2,
      ),
    );
  } finally {
    connection.closeSync();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
