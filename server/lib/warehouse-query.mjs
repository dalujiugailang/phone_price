import fs from 'node:fs';
import path from 'node:path';

import { DuckDBInstance } from '@duckdb/node-api';

function normalizeValue(value) {
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value && typeof value === 'object' && typeof value.toString === 'function') {
    return value.toString();
  }
  return value;
}

function rowsToObjects(reader) {
  const names = reader.columnNames();
  return reader.getRows().map((row) =>
    Object.fromEntries(names.map((name, index) => [name, normalizeValue(row[index])])),
  );
}

function normalizedLimit(value, fallback = 20) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(1, Math.min(100, parsed)) : fallback;
}

function addTextFilter(filters, values, column, value, { fuzzy = false } = {}) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    return;
  }
  filters.push(`${column} ${fuzzy ? 'ILIKE' : '='} ?`);
  values.push(fuzzy ? `%${normalized}%` : normalized);
}

function addDateFilter(filters, values, column, operator, value) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    return;
  }
  filters.push(`${column} ${operator} CAST(? AS DATE)`);
  values.push(normalized);
}

export function createWarehouseQueryService({
  dataDir,
  warehousePath = process.env.GTM_WAREHOUSE_PATH || path.join(dataDir, 'warehouse', 'gtm_warehouse.duckdb'),
  waitForWarehouse = async () => {},
}) {
  async function query(sql, values = []) {
    await waitForWarehouse();
    if (!fs.existsSync(warehousePath)) {
      throw new Error(`数仓尚未生成：${warehousePath}`);
    }
    const instance = await DuckDBInstance.create(warehousePath, { access_mode: 'READ_ONLY' });
    const connection = await instance.connect();
    try {
      return rowsToObjects(await connection.runAndReadAll(sql, values));
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
  }

  async function getCatalog() {
    const [catalog] = await query(`
      SELECT
        (SELECT MAX(price_date) FROM fact_new_sku_price_daily) AS "价格数据日期",
        (SELECT MAX(data_date) FROM fact_used_s_grade_price_daily) AS "BI数据日期",
        (SELECT MAX(year) FROM fact_new_product_sales_weekly) AS "周销年份",
        (SELECT week_label FROM fact_new_product_sales_weekly ORDER BY year DESC, week_index DESC LIMIT 1) AS "周销最新周",
        (SELECT week_label FROM fact_brand_market_weekly ORDER BY year DESC, week_index DESC LIMIT 1) AS "市场最新周",
        (SELECT MAX(refreshed_at) FROM warehouse_refresh_log) AS "数仓刷新时间",
        (SELECT COUNT(*) FROM fact_new_sku_price_daily) AS "新机价格事实行数",
        (SELECT COUNT(*) FROM fact_used_s_grade_price_daily) AS "旧机S等级价格事实行数",
        (SELECT COUNT(*) FROM fact_new_product_sales_weekly) AS "新品周销事实行数",
        (SELECT COUNT(*) FROM fact_brand_market_weekly) AS "市场趋势事实行数",
        (SELECT COUNT(DISTINCT ppv) FROM bridge_ppv_sku_mapping WHERE mapping_status = '映射冲突') AS "PPV冲突数",
        (SELECT config_value FROM warehouse_config WHERE config_key = 'new_price_source') AS "新机价格来源"
    `);
    return {
      ...catalog,
      "数仓文件": warehousePath,
      "数据表": ['新机价格走势表', '新机价格走势聚合表', '新旧机风险表', '市场销量趋势表'],
      "风险指标": {
        "高收价差": 'BI出货价－国补后价格试算',
        "高收风险率": 'BI出货价÷国补后价格试算',
        "旧机残值率": 'BI出货价÷新机发售价',
        "新机残值率": '国补后价格试算÷新机发售价',
      },
    };
  }

  async function queryNewPriceTrend(args = {}) {
    const mode = args.mode === '聚合' ? '聚合' : 'SKU明细';
    const limit = normalizedLimit(args.limit);
    const filters = [];
    const values = [];

    if (mode === '聚合') {
      addTextFilter(filters, values, '"样本范围"', args.scope);
      addTextFilter(filters, values, '"聚合维度"', args.dimension);
      addTextFilter(filters, values, '"维度值"', args.keyword, { fuzzy: true });
      addTextFilter(filters, values, '"品牌"', args.brand);
      addDateFilter(filters, values, '"日期"', '>=', args.startDate);
      addDateFilter(filters, values, '"日期"', '<=', args.endDate);
      const rows = await query(
        `
          SELECT *
          FROM "新机价格走势聚合表"
          ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
          ORDER BY "日期" DESC, "样本范围", "聚合维度", "维度值"
          LIMIT ${limit}
        `,
        values,
      );
      return {
        "查询口径": '与【概览】相同的聚合逻辑；价格为0或已下架时均沿用此前最近一次有效价格。',
        "数据粒度": '样本范围＋聚合维度＋日期',
        "返回行数": rows.length,
        "数据": rows,
        evidence: [
          {
            label: '新机价格走势聚合表',
            source: path.basename(warehousePath),
            dataDate: rows[0]?.日期 ?? null,
            note: '与【概览】一致的均价和环比聚合。',
          },
        ],
      };
    }

    addTextFilter(filters, values, '"品牌"', args.brand);
    addTextFilter(filters, values, '"机型定位"', args.position);
    addTextFilter(filters, values, '"型号"', args.keyword, { fuzzy: true });
    addDateFilter(filters, values, '"日期"', '>=', args.startDate);
    addDateFilter(filters, values, '"日期"', '<=', args.endDate);
    const rows = await query(
      `
        SELECT *
        FROM "新机价格走势表"
        ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
        ORDER BY "日期" DESC, "品牌", "型号", "存储"
        LIMIT ${limit}
      `,
      values,
    );
    return {
      "查询口径": 'SKU级原始价格及聚合有效价格；价格为0或已下架时均沿用此前最近一次有效价格。',
      "数据粒度": '标准SKU＋日期',
      "返回行数": rows.length,
      "数据": rows,
      evidence: [
        {
          label: '新机价格走势表',
          source: path.basename(warehousePath),
          dataDate: rows[0]?.日期 ?? null,
          note: '包含发售价、国补后价格试算、挂牌价、优惠券及沿用来源。',
        },
      ],
    };
  }

  async function queryNewUsedRisk(args = {}) {
    const limit = normalizedLimit(args.limit);
    const filters = [];
    const values = [];
    addTextFilter(filters, values, '"品牌"', args.brand);
    addTextFilter(filters, values, '"机型定位"', args.position);
    addTextFilter(filters, values, '"型号"', args.keyword, { fuzzy: true });
    addDateFilter(filters, values, '"新机价格日期"', '>=', args.startDate);
    addDateFilter(filters, values, '"新机价格日期"', '<=', args.endDate);
    if (args.onlyMatched !== false) {
      filters.push('"BI出货价" IS NOT NULL');
    }
    if (args.latestOnly !== false) {
      filters.push('"新机价格日期" = (SELECT MAX("新机价格日期") FROM "新旧机风险表")');
    }
    if (Number.isFinite(args.minRiskRate)) {
      filters.push('"高收风险率" >= ?');
      values.push(Number(args.minRiskRate));
    }
    const sortColumns = {
      高收风险率: '"高收风险率"',
      高收价差: '"高收价差"',
      旧机残值率: '"旧机残值率"',
      新机残值率: '"新机残值率"',
    };
    const sortColumn = sortColumns[args.sortBy] || '"高收风险率"';
    const rows = await query(
      `
        SELECT *
        FROM "新旧机风险表"
        ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
        ORDER BY ${sortColumn} DESC NULLS LAST, "品牌", "型号", "存储"
        LIMIT ${limit}
      `,
      values,
    );
    return {
      "数据粒度": '标准SKU＋S等级＋日期',
      "返回行数": rows.length,
      "指标口径": {
        "高收价差": 'BI出货价－国补后价格试算',
        "高收风险率": 'BI出货价÷国补后价格试算',
        "旧机残值率": 'BI出货价÷新机发售价',
        "新机残值率": '国补后价格试算÷新机发售价',
      },
      "数据": rows,
      evidence: [
        {
          label: '新旧机风险表',
          source: path.basename(warehousePath),
          dataDate: rows[0]?.新机价格日期 ?? null,
          note: '仅包含已确认的四项风险与残值指标。',
        },
      ],
    };
  }

  async function queryMarketSalesTrend(args = {}) {
    const limit = normalizedLimit(args.limit);
    const filters = [];
    const values = [];
    addTextFilter(filters, values, '"品牌"', args.brand);
    addTextFilter(filters, values, '"系列定位"', args.position);
    addTextFilter(filters, values, '"型号或系列"', args.keyword, { fuzzy: true });
    addTextFilter(filters, values, '"周次"', args.week);
    if (args.tMinus2Only === true) {
      filters.push('"是否T-2周" = TRUE');
    }
    const rows = await query(
      `
        SELECT *
        FROM "市场销量趋势表"
        ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
        ORDER BY "年份" DESC, CAST(REGEXP_EXTRACT("周次", '[0-9]+') AS INTEGER) DESC, "分周销量" DESC
        LIMIT ${limit}
      `,
      values,
    );
    return {
      "数据粒度": '型号或系列＋周次；品牌份额和大盘指数按品牌周关联',
      "T-2说明": '是否T-2周按各年份最新周次向前推2周计算。',
      "返回行数": rows.length,
      "数据": rows,
      evidence: [
        {
          label: '市场销量趋势表',
          source: path.basename(warehousePath),
          dataDate: rows[0]?.周次 ?? null,
          note: '包含新品分周销量、累计销量、品牌周度份额和大盘指数。',
        },
      ],
    };
  }

  return {
    warehousePath,
    getCatalog,
    queryNewPriceTrend,
    queryNewUsedRisk,
    queryMarketSalesTrend,
  };
}
