import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import XLSX from 'xlsx';
import { buildSalesWideTables, parseRdWeiboPosts } from './weibo-rd-automation.mjs';

const DEFAULT_SERIES_POSITIONS = ['主品牌旗舰', '子系旗舰', '主品牌中端', '中低端'];
const SUMMARY_MODEL_PATTERN = /汇总|合计|总计|小计|总盘/;
const SAMPLE_WORKBOOK_PATH = '/Users/dudu/Downloads/新机销量数据源.xlsx';
const DEFAULT_WEEKLY_SALES_YEAR = 2026;
const AUTOMATION_SCHEDULE_KEY = 'rd-weibo-mon-fri-10';
const AUTOMATION_SCHEDULE_HOUR = 10;
const AUTOMATION_SCHEDULE_WEEKDAYS = new Set([1, 5]);

function nowIso() {
  return new Date().toISOString();
}

export function getWeeklySalesScheduleSlot(date = new Date(), timeZone = 'Asia/Shanghai') {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
      weekday: 'short',
    })
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  const weekday = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[parts.weekday];
  if (!AUTOMATION_SCHEDULE_WEEKDAYS.has(weekday) || Number(parts.hour) < AUTOMATION_SCHEDULE_HOUR) {
    return null;
  }
  return `${parts.year}-${parts.month}-${parts.day}@10:00`;
}

function isTruthyEnvironmentValue(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

function tokensMatch(actual, expected) {
  const actualBuffer = Buffer.from(String(actual ?? ''));
  const expectedBuffer = Buffer.from(String(expected ?? ''));
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeBrand(value) {
  const brand = normalizeText(value);
  return brand === '红米' ? '小米' : brand;
}

function normalizeKey(value) {
  return normalizeText(value).replace(/\s+/g, '').toLowerCase();
}

function normalizeHeader(value) {
  return String(value ?? '').replace(/\s+/g, '').trim();
}

function parseWeekLabel(value) {
  const matched = normalizeText(value).match(/^W(\d+)$/i);
  if (!matched) {
    return null;
  }

  const weekIndex = Number(matched[1]);
  if (weekIndex < 1 || weekIndex > 53) {
    return null;
  }
  return {
    weekLabel: `W${weekIndex}`,
    weekIndex,
  };
}

function parseNumberValue(value) {
  const normalized = String(value ?? '').replace(/,/g, '').trim();
  if (!normalized || normalized === '-') {
    return null;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function toId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function sortWeeks(left, right) {
  return left.weekIndex - right.weekIndex;
}

function sortWeekLabels(left, right) {
  return (parseWeekLabel(left)?.weekIndex ?? 0) - (parseWeekLabel(right)?.weekIndex ?? 0);
}

function toSqlBool(value) {
  return value === false || value === 0 || value === '0' ? 0 : 1;
}

function fromSqlBool(value) {
  return Number(value) !== 0;
}

function splitPastedRows(rawText) {
  return String(rawText ?? '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
    .map((line) => {
      const delimiter = line.includes('\t') ? '\t' : ',';
      return line.split(delimiter).map((cell) => cell.trim());
    });
}

function mapModelRow(row) {
  return {
    id: row.id,
    standardModelName: row.standard_model_name,
    brand: row.brand,
    seriesPosition: row.series_position,
    isVisible: fromSqlBool(row.is_visible),
    sortOrder: row.sort_order ?? 0,
    remark: row.remark ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function migrateWeeklySalesSchema(database) {
  const columns = database.prepare('PRAGMA table_info(weekly_cumulative_sales)').all();
  if (!columns.some((column) => column.name === 'year')) {
    database.exec(`
      BEGIN;
      ALTER TABLE weekly_cumulative_sales RENAME TO weekly_cumulative_sales_legacy;
      CREATE TABLE weekly_cumulative_sales (
        standard_model_name TEXT NOT NULL,
        year INTEGER NOT NULL,
        week_label TEXT NOT NULL,
        week_index INTEGER NOT NULL,
        cumulative_sales REAL NOT NULL,
        import_batch_id TEXT NOT NULL DEFAULT '',
        source_post_url TEXT NOT NULL DEFAULT '',
        evidence_text TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (standard_model_name, year, week_index)
      );
      INSERT INTO weekly_cumulative_sales (
        standard_model_name, year, week_label, week_index, cumulative_sales,
        import_batch_id, source_post_url, evidence_text, created_at, updated_at
      )
      SELECT
        standard_model_name, ${DEFAULT_WEEKLY_SALES_YEAR}, week_label, week_index, cumulative_sales,
        import_batch_id, '', '', created_at, updated_at
      FROM weekly_cumulative_sales_legacy;
      DROP TABLE weekly_cumulative_sales_legacy;
      COMMIT;
    `);
    return;
  }

  if (!columns.some((column) => column.name === 'source_post_url')) {
    database.exec("ALTER TABLE weekly_cumulative_sales ADD COLUMN source_post_url TEXT NOT NULL DEFAULT ''");
  }
  if (!columns.some((column) => column.name === 'evidence_text')) {
    database.exec("ALTER TABLE weekly_cumulative_sales ADD COLUMN evidence_text TEXT NOT NULL DEFAULT ''");
  }
}

function migrateAutomationSchema(database) {
  const columns = database.prepare('PRAGMA table_info(weibo_crawl_run)').all();
  if (!columns.some((column) => column.name === 'trigger_source')) {
    database.exec("ALTER TABLE weibo_crawl_run ADD COLUMN trigger_source TEXT NOT NULL DEFAULT 'manual'");
  }
  if (!columns.some((column) => column.name === 'worker_id')) {
    database.exec("ALTER TABLE weibo_crawl_run ADD COLUMN worker_id TEXT NOT NULL DEFAULT ''");
  }
  if (!columns.some((column) => column.name === 'claimed_at')) {
    database.exec("ALTER TABLE weibo_crawl_run ADD COLUMN claimed_at TEXT NOT NULL DEFAULT ''");
  }
}

export function createWeeklySalesService({ dataDir, applyMarketWeeks }) {
  const databasePath = process.env.WEEKLY_SALES_DB_PATH || path.join(dataDir, 'weekly-sales.sqlite');
  const workbookPath = process.env.WEEKLY_SALES_WORKBOOK_PATH || path.join(dataDir, '新机销量数据源.xlsx');
  const automationToken = String(process.env.WEEKLY_SALES_AUTOMATION_TOKEN ?? '').trim();
  const workerToken = String(process.env.WEEKLY_SALES_WORKER_TOKEN ?? '').trim();
  const scheduleEnabled = isTruthyEnvironmentValue(process.env.WEEKLY_SALES_SCHEDULE_ENABLED);
  const scheduleTimeZone = String(process.env.WEEKLY_SALES_SCHEDULE_TIMEZONE ?? 'Asia/Shanghai').trim();
  let database;
  let activeAutomationPromise = null;
  let schedulerTimer = null;

  async function ensureDataDir() {
    await fs.mkdir(dataDir, { recursive: true });
  }

  function ensureDatabase() {
    if (database) {
      return database;
    }

    database = new DatabaseSync(databasePath);
    database.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    database.exec(`
      CREATE TABLE IF NOT EXISTS weekly_model_dimension (
        id TEXT PRIMARY KEY,
        standard_model_name TEXT NOT NULL UNIQUE,
        brand TEXT NOT NULL DEFAULT '',
        series_position TEXT NOT NULL DEFAULT '',
        price_band TEXT NOT NULL DEFAULT '',
        launch_date TEXT NOT NULL DEFAULT '',
        is_visible INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0,
        remark TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS weekly_model_alias (
        id TEXT PRIMARY KEY,
        raw_model_name TEXT NOT NULL UNIQUE,
        standard_model_name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS weekly_dimension_option (
        option_type TEXT NOT NULL,
        option_value TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (option_type, option_value)
      );

      CREATE TABLE IF NOT EXISTS weekly_cumulative_sales (
        standard_model_name TEXT NOT NULL,
        year INTEGER NOT NULL,
        week_label TEXT NOT NULL,
        week_index INTEGER NOT NULL,
        cumulative_sales REAL NOT NULL,
        import_batch_id TEXT NOT NULL DEFAULT '',
        source_post_url TEXT NOT NULL DEFAULT '',
        evidence_text TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (standard_model_name, year, week_index)
      );

      CREATE TABLE IF NOT EXISTS weekly_import_batch (
        id TEXT PRIMARY KEY,
        import_name TEXT NOT NULL,
        import_type TEXT NOT NULL,
        imported_by TEXT NOT NULL DEFAULT '',
        imported_at TEXT NOT NULL,
        total_rows INTEGER NOT NULL DEFAULT 0,
        parsed_points INTEGER NOT NULL DEFAULT 0,
        inserted_points INTEGER NOT NULL DEFAULT 0,
        updated_points INTEGER NOT NULL DEFAULT 0,
        error_points INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS weekly_import_error (
        id TEXT PRIMARY KEY,
        import_batch_id TEXT NOT NULL,
        raw_model_name TEXT NOT NULL,
        week_label TEXT NOT NULL,
        raw_value TEXT NOT NULL,
        error_type TEXT NOT NULL,
        error_message TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS weekly_import_preview (
        id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS weibo_crawl_run (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        phase TEXT NOT NULL DEFAULT '',
        mode TEXT NOT NULL DEFAULT '',
        trigger_source TEXT NOT NULL DEFAULT 'manual',
        worker_id TEXT NOT NULL DEFAULT '',
        claimed_at TEXT NOT NULL DEFAULT '',
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL DEFAULT '',
        post_count INTEGER NOT NULL DEFAULT 0,
        sales_record_count INTEGER NOT NULL DEFAULT 0,
        market_week_count INTEGER NOT NULL DEFAULT 0,
        inserted_points INTEGER NOT NULL DEFAULT 0,
        skipped_points INTEGER NOT NULL DEFAULT 0,
        new_model_count INTEGER NOT NULL DEFAULT 0,
        raw_json_path TEXT NOT NULL DEFAULT '',
        summary_json TEXT NOT NULL DEFAULT '{}',
        error_message TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS weekly_automation_schedule_state (
        schedule_key TEXT PRIMARY KEY,
        last_attempt_slot TEXT NOT NULL DEFAULT '',
        attempted_at TEXT NOT NULL DEFAULT '',
        run_id TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS weekly_automation_worker (
        worker_id TEXT PRIMARY KEY,
        last_seen_at TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'local-chrome'
      );
    `);
    migrateWeeklySalesSchema(database);
    migrateAutomationSchema(database);
    return database;
  }

  function modelCount() {
    return ensureDatabase().prepare('SELECT COUNT(*) AS count FROM weekly_model_dimension').get().count;
  }

  function ensureConfigInitialized() {
    const db = ensureDatabase();
    const timestamp = nowIso();
    const insertOption = db.prepare(`
      INSERT OR IGNORE INTO weekly_dimension_option (
        option_type, option_value, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)
    `);
    const redmiOption = db
      .prepare("SELECT sort_order FROM weekly_dimension_option WHERE option_type = 'brand' AND option_value = '红米'")
      .get();
    db.prepare("UPDATE weekly_model_dimension SET brand = '小米', updated_at = ? WHERE brand = '红米'").run(timestamp);
    db.prepare("DELETE FROM weekly_dimension_option WHERE option_type = 'brand' AND option_value = '红米'").run();
    const brandCount = db.prepare("SELECT COUNT(*) AS count FROM weekly_dimension_option WHERE option_type = 'brand'").get().count;
    if (brandCount === 0) {
      const brands = db
        .prepare("SELECT DISTINCT brand FROM weekly_model_dimension WHERE TRIM(brand) <> '' ORDER BY brand ASC")
        .all()
        .map((row) => row.brand);
      brands.forEach((brand, index) => insertOption.run('brand', brand, index + 1, timestamp, timestamp));
    } else if (redmiOption) {
      insertOption.run('brand', '小米', redmiOption.sort_order, timestamp, timestamp);
    }

    const positionCount = db.prepare("SELECT COUNT(*) AS count FROM weekly_dimension_option WHERE option_type = 'series_position'").get().count;
    if (positionCount === 0) {
      DEFAULT_SERIES_POSITIONS.forEach((position, index) => insertOption.run('series_position', position, index + 1, timestamp, timestamp));
    }
  }

  function getConfig() {
    ensureConfigInitialized();
    const rows = ensureDatabase()
      .prepare('SELECT option_type, option_value FROM weekly_dimension_option ORDER BY option_type ASC, sort_order ASC, option_value ASC')
      .all();
    return {
      brands: rows.filter((row) => row.option_type === 'brand').map((row) => row.option_value),
      seriesPositions: rows.filter((row) => row.option_type === 'series_position').map((row) => row.option_value),
    };
  }

  function normalizeOptions(values) {
    return [...new Set((Array.isArray(values) ? values : []).map(normalizeText).filter(Boolean))];
  }

  async function updateConfig(payload) {
    await seedFromWorkbookIfNeeded();
    const brands = [...new Set(normalizeOptions(payload.brands).map(normalizeBrand))];
    const seriesPositions = normalizeOptions(payload.seriesPositions);
    if (brands.length === 0) {
      throw new Error('至少保留一个品牌选项');
    }
    if (seriesPositions.length === 0) {
      throw new Error('至少保留一个系列定位选项');
    }

    const db = ensureDatabase();
    const usedBrands = db
      .prepare("SELECT DISTINCT brand FROM weekly_model_dimension WHERE TRIM(brand) <> '' ORDER BY brand ASC")
      .all()
      .map((row) => row.brand);
    const usedSeriesPositions = db
      .prepare("SELECT DISTINCT series_position FROM weekly_model_dimension WHERE TRIM(series_position) <> '' ORDER BY series_position ASC")
      .all()
      .map((row) => row.series_position);
    const removedUsedBrands = usedBrands.filter((brand) => !brands.includes(brand));
    const removedUsedSeriesPositions = usedSeriesPositions.filter((position) => !seriesPositions.includes(position));
    if (removedUsedBrands.length > 0 || removedUsedSeriesPositions.length > 0) {
      const details = [];
      if (removedUsedBrands.length > 0) {
        details.push(`仍被型号使用的品牌：${removedUsedBrands.join('、')}`);
      }
      if (removedUsedSeriesPositions.length > 0) {
        details.push(`仍被型号使用的系列定位：${removedUsedSeriesPositions.join('、')}`);
      }
      throw new Error(`无法删除在用配置，请先修改相关型号。${details.join('；')}`);
    }

    const timestamp = nowIso();
    const insertOption = db.prepare(`
      INSERT INTO weekly_dimension_option (
        option_type, option_value, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)
    `);
    db.exec('BEGIN');
    try {
      db.prepare("DELETE FROM weekly_dimension_option WHERE option_type IN ('brand', 'series_position')").run();
      brands.forEach((brand, index) => insertOption.run('brand', brand, index + 1, timestamp, timestamp));
      seriesPositions.forEach((position, index) => insertOption.run('series_position', position, index + 1, timestamp, timestamp));
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return getConfig();
  }

  function validateConfiguredDimensions(payload) {
    const brand = normalizeBrand(payload.brand);
    const seriesPosition = normalizeText(payload.seriesPosition);
    const config = getConfig();
    if (!brand) {
      throw new Error('品牌不能为空');
    }
    if (!config.brands.includes(brand)) {
      throw new Error(`品牌“${brand}”不在可选配置中`);
    }
    if (!seriesPosition) {
      throw new Error('系列定位不能为空');
    }
    if (!config.seriesPositions.includes(seriesPosition)) {
      throw new Error(`系列定位“${seriesPosition}”不在可选配置中`);
    }
    return { brand, seriesPosition };
  }

  function parseWorkbookRows(rows) {
    const cumulativeTitleRowIndex = rows.findIndex((row) => row.some((cell) => normalizeHeader(cell).includes('累计销量')));
    if (cumulativeTitleRowIndex === -1) {
      return { models: [], points: [] };
    }

    const dimensionHeaders = rows[cumulativeTitleRowIndex].map(normalizeHeader);
    const weekHeaderRowIndex = rows
      .slice(cumulativeTitleRowIndex + 1, cumulativeTitleRowIndex + 4)
      .findIndex((row) => row.some((cell) => parseWeekLabel(cell)));
    if (weekHeaderRowIndex === -1) {
      return { models: [], points: [] };
    }

    const resolvedWeekHeaderRowIndex = cumulativeTitleRowIndex + 1 + weekHeaderRowIndex;
    const weekHeaders = rows[resolvedWeekHeaderRowIndex];
    const modelIndex = dimensionHeaders.findIndex((header) => header.includes('型号/系列'));
    const positionIndex = dimensionHeaders.findIndex((header) => header.includes('系列定位'));
    const brandIndex = dimensionHeaders.findIndex((header) => header.includes('品牌'));
    const weekColumns = weekHeaders
      .map((header, index) => ({ index, week: parseWeekLabel(header) }))
      .filter((item) => item.week)
      .map((item) => ({ index: item.index, ...item.week }));

    const models = [];
    const points = [];
    for (const row of rows.slice(resolvedWeekHeaderRowIndex + 1)) {
      const modelName = normalizeText(row[modelIndex]);
      if (!modelName) {
        continue;
      }
      if (SUMMARY_MODEL_PATTERN.test(modelName)) {
        continue;
      }

      const seriesPosition = normalizeText(row[positionIndex]);
      const isVisible = DEFAULT_SERIES_POSITIONS.includes(seriesPosition);
      models.push({
        standardModelName: modelName,
        brand: normalizeText(row[brandIndex]),
        seriesPosition,
        isVisible,
      });

      for (const weekColumn of weekColumns) {
        const cumulativeSales = parseNumberValue(row[weekColumn.index]);
        if (cumulativeSales === null) {
          continue;
        }
        points.push({
          standardModelName: modelName,
          weekLabel: weekColumn.weekLabel,
          weekIndex: weekColumn.weekIndex,
          cumulativeSales,
        });
      }
    }

    return { models, points };
  }

  async function seedFromWorkbookIfNeeded() {
    await ensureDataDir();
    const db = ensureDatabase();
    if (modelCount() > 0) {
      return;
    }

    const sourcePath = fsSync.existsSync(workbookPath)
      ? workbookPath
      : process.env.NODE_ENV !== 'test' && fsSync.existsSync(SAMPLE_WORKBOOK_PATH)
        ? SAMPLE_WORKBOOK_PATH
        : null;
    if (!sourcePath) {
      return;
    }

    const workbook = XLSX.readFile(sourcePath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) {
      return;
    }

    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
    const parsed = parseWorkbookRows(rows);
    const batchId = 'seed_workbook';
    const timestamp = nowIso();

    const insertModel = db.prepare(`
      INSERT INTO weekly_model_dimension (
        id, standard_model_name, brand, series_position, price_band, launch_date,
        is_visible, sort_order, remark, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?)
      ON CONFLICT(standard_model_name) DO UPDATE SET
        brand = excluded.brand,
        series_position = excluded.series_position,
        price_band = excluded.price_band,
        launch_date = excluded.launch_date,
        is_visible = excluded.is_visible,
        updated_at = excluded.updated_at
    `);
    const insertAlias = db.prepare(`
      INSERT OR IGNORE INTO weekly_model_alias (id, raw_model_name, standard_model_name, created_at)
      VALUES (?, ?, ?, ?)
    `);
    const insertPoint = db.prepare(`
      INSERT INTO weekly_cumulative_sales (
        standard_model_name, year, week_label, week_index, cumulative_sales, import_batch_id, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(standard_model_name, year, week_index) DO UPDATE SET
        week_label = excluded.week_label,
        cumulative_sales = excluded.cumulative_sales,
        import_batch_id = excluded.import_batch_id,
        updated_at = excluded.updated_at
    `);

    db.exec('BEGIN');
    try {
      parsed.models.forEach((model, index) => {
        insertModel.run(
          toId('model'),
          model.standardModelName,
          model.brand,
          model.seriesPosition,
          '',
          '',
          toSqlBool(model.isVisible),
          index + 1,
          timestamp,
          timestamp,
        );
        insertAlias.run(toId('alias'), model.standardModelName, model.standardModelName, timestamp);
      });

      parsed.points.forEach((point) => {
        insertPoint.run(
          point.standardModelName,
          DEFAULT_WEEKLY_SALES_YEAR,
          point.weekLabel,
          point.weekIndex,
          point.cumulativeSales,
          batchId,
          timestamp,
          timestamp,
        );
      });

      db.prepare(`
        INSERT OR IGNORE INTO weekly_import_batch (
          id, import_name, import_type, imported_at, total_rows, parsed_points,
          inserted_points, updated_points, error_points, status
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, '成功')
      `).run(batchId, `初始化：${path.basename(sourcePath)}`, 'workbook-seed', timestamp, parsed.models.length, parsed.points.length, parsed.points.length);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function getModelLookup() {
    const db = ensureDatabase();
    const modelRows = db.prepare('SELECT standard_model_name FROM weekly_model_dimension').all();
    const lookup = new Map();
    for (const row of modelRows) {
      lookup.set(normalizeKey(row.standard_model_name), row.standard_model_name);
    }

    const aliasRows = db.prepare('SELECT raw_model_name, standard_model_name FROM weekly_model_alias').all();
    for (const row of aliasRows) {
      lookup.set(normalizeKey(row.raw_model_name), row.standard_model_name);
    }
    return lookup;
  }

  function getModels(filters = {}) {
    const clauses = [];
    const params = [];
    if (filters.brand) {
      clauses.push('brand = ?');
      params.push(filters.brand);
    }
    if (filters.seriesPosition) {
      clauses.push('series_position = ?');
      params.push(filters.seriesPosition);
    }
    if (filters.isVisible !== undefined) {
      clauses.push('is_visible = ?');
      params.push(toSqlBool(filters.isVisible));
    }
    if (filters.keyword) {
      clauses.push('(standard_model_name LIKE ? OR brand LIKE ?)');
      params.push(`%${filters.keyword}%`, `%${filters.keyword}%`);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return ensureDatabase()
      .prepare(`
        SELECT *
        FROM weekly_model_dimension
        ${where}
        ORDER BY sort_order ASC, updated_at DESC, standard_model_name ASC
      `)
      .all(...params)
      .map(mapModelRow);
  }

  function readSalesRows(filters = {}) {
    const clauses = [];
    const params = [];
    if (filters.brand) {
      clauses.push('m.brand = ?');
      params.push(filters.brand);
    }
    if (filters.seriesPosition) {
      clauses.push('m.series_position = ?');
      params.push(filters.seriesPosition);
    }
    if (filters.year) {
      clauses.push('s.year = ?');
      params.push(Number(filters.year));
    }
    if (filters.visibleOnly !== false) {
      clauses.push('m.is_visible = 1');
    }
    if (filters.startWeek) {
      clauses.push('s.week_index >= ?');
      params.push(Number(filters.startWeek));
    }
    if (filters.endWeek) {
      clauses.push('s.week_index <= ?');
      params.push(Number(filters.endWeek));
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return ensureDatabase()
      .prepare(`
        SELECT
          m.standard_model_name,
          m.brand,
          m.series_position,
          m.is_visible,
          m.sort_order,
          s.year,
          s.week_label,
          s.week_index,
          s.cumulative_sales,
          s.updated_at
        FROM weekly_cumulative_sales s
        JOIN weekly_model_dimension m ON m.standard_model_name = s.standard_model_name
        ${where}
        ORDER BY m.sort_order ASC, m.standard_model_name ASC, s.year ASC, s.week_index ASC
      `)
      .all(...params);
  }

  function buildWeeklyRows(rows) {
    const byModel = new Map();
    for (const row of rows) {
      const list = byModel.get(row.standard_model_name) ?? [];
      list.push(row);
      byModel.set(row.standard_model_name, list);
    }

    const weeklyRows = [];
    for (const list of byModel.values()) {
      const sorted = [...list].sort(sortWeeks);
      let previousCumulativeSales = null;
      for (const row of sorted) {
        const weeklySales =
          previousCumulativeSales === null
            ? row.cumulative_sales
            : Number((row.cumulative_sales - previousCumulativeSales).toFixed(4));
        previousCumulativeSales = row.cumulative_sales;
        weeklyRows.push({
          standardModelName: row.standard_model_name,
          brand: row.brand,
          seriesPosition: row.series_position,
          isVisible: fromSqlBool(row.is_visible),
          year: row.year,
          weekLabel: row.week_label,
          weekIndex: row.week_index,
          cumulativeSales: row.cumulative_sales,
          weeklySales,
        });
      }
    }
    return weeklyRows;
  }

  async function getOverview(filters = {}) {
    await seedFromWorkbookIfNeeded();
    const config = getConfig();
    const models = getModels({});
    const years = ensureDatabase()
      .prepare('SELECT DISTINCT year FROM weekly_cumulative_sales ORDER BY year ASC')
      .all()
      .map((row) => Number(row.year));
    const selectedYear = Number(filters.year || years.at(-1) || DEFAULT_WEEKLY_SALES_YEAR);
    const allRows = readSalesRows({ ...filters, year: selectedYear, startWeek: undefined, endWeek: undefined });
    const allWeeklyRows = buildWeeklyRows(allRows);
    const startWeek = filters.startWeek ? Number(filters.startWeek) : null;
    const endWeek = filters.endWeek ? Number(filters.endWeek) : null;
    const isInWeekRange = (row) =>
      (startWeek === null || row.weekIndex >= startWeek || row.week_index >= startWeek) &&
      (endWeek === null || row.weekIndex <= endWeek || row.week_index <= endWeek);
    const rows = allRows.filter(isInWeekRange);
    const weeklyRows = allWeeklyRows.filter(isInWeekRange);
    const weeks = Array.from(new Set(rows.map((row) => row.week_label))).sort(sortWeekLabels);
    const allWeeks = Array.from(new Set(allRows.map((row) => row.week_label))).sort(sortWeekLabels);
    const latestWeek = weeks.at(-1) ?? '';
    const previousWeek = weeks.at(-2) ?? '';
    const latestWeekSales = weeklyRows
      .filter((row) => row.weekLabel === latestWeek && row.weeklySales !== null)
      .reduce((sum, row) => sum + row.weeklySales, 0);
    const previousWeekSales = weeklyRows
      .filter((row) => row.weekLabel === previousWeek && row.weeklySales !== null)
      .reduce((sum, row) => sum + row.weeklySales, 0);
    const wowChange = previousWeekSales ? ((latestWeekSales - previousWeekSales) / previousWeekSales) * 100 : 0;
    const errorCount = ensureDatabase().prepare('SELECT COUNT(*) AS count FROM weekly_import_error').get().count;
    const latestBatch = ensureDatabase()
      .prepare('SELECT imported_at FROM weekly_import_batch ORDER BY imported_at DESC LIMIT 1')
      .get();

    const charts = config.seriesPositions.map((seriesPosition) => {
      const seriesModels = models.filter((model) => model.seriesPosition === seriesPosition && model.isVisible);
      return {
        seriesPosition,
        title: `${seriesPosition}周销量`,
        xAxis: weeks,
        series: seriesModels
          .map((model) => ({
            name: model.standardModelName,
            data: weeks.map((week) => {
              const item = weeklyRows.find((row) => row.standardModelName === model.standardModelName && row.weekLabel === week);
              return item?.weeklySales ?? null;
            }),
          }))
          .filter((item) => item.data.some((value) => value !== null)),
      };
    });

    return {
      summary: {
        year: selectedYear,
        latestWeek,
        modelCount: models.filter((model) => model.isVisible).length,
        latestWeekSales: Number(latestWeekSales.toFixed(2)),
        wowChange: Number(wowChange.toFixed(2)),
        newModelCount: 0,
        errorCount,
        updatedAt: latestBatch?.imported_at ?? '',
      },
      filters: {
        years,
        selectedYear,
        brands: config.brands,
        seriesPositions: config.seriesPositions,
        weeks: allWeeks,
      },
      charts,
      models,
      cumulativeRows: rows.map((row) => ({
        standardModelName: row.standard_model_name,
        brand: row.brand,
        seriesPosition: row.series_position,
        year: row.year,
        weekLabel: row.week_label,
        weekIndex: row.week_index,
        cumulativeSales: row.cumulative_sales,
      })),
      weeklyRows,
      errors: ensureDatabase()
        .prepare('SELECT * FROM weekly_import_error ORDER BY created_at DESC LIMIT 300')
        .all()
        .map((row) => ({
          id: row.id,
          importBatchId: row.import_batch_id,
          rawModelName: row.raw_model_name,
          weekLabel: row.week_label,
          rawValue: row.raw_value,
          errorType: row.error_type,
          errorMessage: row.error_message,
          createdAt: row.created_at,
        })),
      importBatches: ensureDatabase()
        .prepare('SELECT * FROM weekly_import_batch ORDER BY imported_at DESC LIMIT 50')
        .all(),
    };
  }

  async function parseImport({ rawText, text, content, paste, importName, year, recordMetadata = [], ignoreBlank = false }) {
    await seedFromWorkbookIfNeeded();
    const selectedYear = Number(year || DEFAULT_WEEKLY_SALES_YEAR);
    if (!Number.isInteger(selectedYear) || selectedYear < 2000 || selectedYear > 2100) {
      throw new Error('导入年份无效');
    }
    const rows = splitPastedRows(rawText ?? text ?? content ?? paste);
    if (rows.length < 2) {
      throw new Error('请粘贴至少一行表头和一行数据');
    }

    const headers = rows[0].map(normalizeHeader);
    const modelIndex = headers.findIndex((header) => header === '型号/系列');
    if (modelIndex !== 0) {
      throw new Error('标准粘贴第一列必须是“型号/系列”');
    }

    const weekColumns = headers
      .map((header, index) => ({ index, week: parseWeekLabel(header) }))
      .filter((item) => item.week)
      .map((item) => ({ index: item.index, ...item.week }));
    if (weekColumns.length === 0) {
      throw new Error('导入数据缺少 W1、W2 这类周数字段');
    }
    if (weekColumns.some((weekColumn, index) => weekColumn.index !== index + 1)) {
      throw new Error('标准粘贴除第一列外只能包含 W 数字周次列');
    }

    const lookup = getModelLookup();
    const metadataByPoint = new Map(
      recordMetadata.map((record) => [
        `${normalizeKey(record.rawModelName)}::${Number(record.year || selectedYear)}::${Number(record.weekIndex)}`,
        record,
      ]),
    );
    const existingPoints = new Map(
      ensureDatabase()
        .prepare('SELECT standard_model_name, year, week_index, cumulative_sales FROM weekly_cumulative_sales WHERE year = ?')
        .all(selectedYear)
        .map((row) => [`${row.standard_model_name}::${row.year}::${row.week_index}`, row.cumulative_sales]),
    );

    const previewRows = [];
    const errors = [];
    const unknownModels = new Set();
    for (const row of rows.slice(1)) {
      const rawModelName = normalizeText(row[modelIndex]);
      if (!rawModelName || SUMMARY_MODEL_PATTERN.test(rawModelName)) {
        continue;
      }

      const standardModelName = lookup.get(normalizeKey(rawModelName));
      if (!standardModelName) {
        unknownModels.add(rawModelName);
      }

      let previousValue = null;
      for (const weekColumn of weekColumns) {
        const rawValue = row[weekColumn.index] ?? '';
        const parsed = parseNumberValue(rawValue);
        const baseRow = {
          rawModelName,
          standardModelName: standardModelName ?? '',
          year: selectedYear,
          weekLabel: weekColumn.weekLabel,
          weekIndex: weekColumn.weekIndex,
          rawValue: String(rawValue ?? ''),
          sourcePostUrl:
            metadataByPoint.get(`${normalizeKey(rawModelName)}::${selectedYear}::${weekColumn.weekIndex}`)?.sourcePostUrl ?? '',
          evidenceText:
            metadataByPoint.get(`${normalizeKey(rawModelName)}::${selectedYear}::${weekColumn.weekIndex}`)?.evidenceText ?? '',
        };

        if (parsed === null) {
          if (!String(rawValue ?? '').trim() && ignoreBlank) {
            continue;
          }
          if (String(rawValue ?? '').trim()) {
            errors.push({ ...baseRow, errorType: 'non_numeric', errorMessage: '累计销量不是可解析数字' });
          } else {
            errors.push({ ...baseRow, errorType: 'blank', errorMessage: '累计销量为空' });
          }
          continue;
        }

        if (!standardModelName) {
          previewRows.push({ ...baseRow, cumulativeSales: parsed, action: 'pending_model', error: '型号未维护' });
          continue;
        }

        if (previousValue !== null && parsed < previousValue) {
          errors.push({ ...baseRow, errorType: 'rollback', errorMessage: '累计销量小于前一周' });
        }
        previousValue = parsed;

        const existingValue = existingPoints.get(`${standardModelName}::${selectedYear}::${weekColumn.weekIndex}`);
        const action = existingValue === undefined ? 'insert' : 'skip_existing';
        previewRows.push({
          ...baseRow,
          standardModelName,
          cumulativeSales: parsed,
          existingSales: existingValue ?? null,
          action,
          error: action === 'skip_existing' ? '已存在，本次不导入' : null,
        });
      }
    }

    const previewId = toId('preview');
    const payload = {
      importName: normalizeText(importName) || `新品周销导入 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
      year: selectedYear,
      previewRows,
      errors,
      unknownModels: Array.from(unknownModels).map((rawModelName) => ({ rawModelName })),
    };
    ensureDatabase()
      .prepare('INSERT INTO weekly_import_preview (id, payload_json, created_at) VALUES (?, ?, ?)')
      .run(previewId, JSON.stringify(payload), nowIso());

    const parsedPoints = previewRows.filter((row) => row.action !== 'pending_model' && row.action !== 'skip_existing').length;
    return {
      batchPreviewId: previewId,
      summary: {
        modelCount: new Set(previewRows.map((row) => row.rawModelName)).size,
        weekCount: weekColumns.length,
        parsedPoints,
        newPoints: previewRows.filter((row) => row.action === 'insert').length,
        updatePoints: 0,
        skippedPoints: previewRows.filter((row) => row.action === 'skip_existing').length,
        unknownModelCount: unknownModels.size,
        errorCount: errors.length,
      },
      unknownModels: payload.unknownModels,
      previewRows: previewRows.slice(0, 500),
      errors: errors.slice(0, 300),
    };
  }

  async function confirmImport({
    batchPreviewId,
    newModelMappings = [],
    importedBy = '',
    allowPendingModels = false,
    importType = 'paste',
  }) {
    await seedFromWorkbookIfNeeded();
    const db = ensureDatabase();
    const preview = db.prepare('SELECT payload_json FROM weekly_import_preview WHERE id = ?').get(batchPreviewId);
    if (!preview) {
      throw new Error('导入预览不存在或已失效，请重新解析');
    }

    const payload = JSON.parse(preview.payload_json);
    if (!allowPendingModels) {
      newModelMappings.forEach(validateConfiguredDimensions);
    }
    const timestamp = nowIso();
    const batchId = toId('batch');
    const mappingByRawName = new Map(newModelMappings.map((item) => [normalizeKey(item.rawModelName), item]));
    const insertModel = db.prepare(`
      INSERT INTO weekly_model_dimension (
        id, standard_model_name, brand, series_position,
        is_visible, sort_order, remark, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(standard_model_name) DO UPDATE SET
        brand = excluded.brand,
        series_position = excluded.series_position,
        is_visible = excluded.is_visible,
        remark = excluded.remark,
        updated_at = excluded.updated_at
    `);
    const insertAlias = db.prepare(`
      INSERT INTO weekly_model_alias (id, raw_model_name, standard_model_name, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(raw_model_name) DO UPDATE SET standard_model_name = excluded.standard_model_name
    `);
    const upsertPoint = db.prepare(`
      INSERT INTO weekly_cumulative_sales (
        standard_model_name, year, week_label, week_index, cumulative_sales, import_batch_id,
        source_post_url, evidence_text, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(standard_model_name, year, week_index) DO UPDATE SET
        week_label = excluded.week_label,
        cumulative_sales = excluded.cumulative_sales,
        import_batch_id = excluded.import_batch_id,
        source_post_url = excluded.source_post_url,
        evidence_text = excluded.evidence_text,
        updated_at = excluded.updated_at
    `);
    const insertError = db.prepare(`
      INSERT INTO weekly_import_error (
        id, import_batch_id, raw_model_name, week_label, raw_value, error_type, error_message, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let insertedPoints = 0;
    let updatedPoints = 0;
    let errorPoints = payload.errors.length;

    db.exec('BEGIN');
    try {
      for (const mapping of newModelMappings) {
        const standardModelName = normalizeText(mapping.standardModelName || mapping.rawModelName);
        if (!standardModelName) {
          continue;
        }
        const dimensions = allowPendingModels
          ? { brand: normalizeBrand(mapping.brand), seriesPosition: normalizeText(mapping.seriesPosition) }
          : validateConfiguredDimensions(mapping);
        insertModel.run(
          toId('model'),
          standardModelName,
          dimensions.brand,
          dimensions.seriesPosition,
          toSqlBool(mapping.isVisible),
          Number(mapping.sortOrder ?? 999),
          normalizeText(mapping.remark),
          timestamp,
          timestamp,
        );
        insertAlias.run(toId('alias'), normalizeText(mapping.rawModelName), standardModelName, timestamp);
      }

      for (const error of payload.errors) {
        insertError.run(
          toId('err'),
          batchId,
          error.rawModelName,
          error.weekLabel,
          error.rawValue,
          error.errorType,
          error.errorMessage,
          timestamp,
        );
      }

      for (const row of payload.previewRows) {
        if (row.action === 'skip_existing') {
          continue;
        }

        let standardModelName = row.standardModelName;
        if (!standardModelName) {
          const mapping = mappingByRawName.get(normalizeKey(row.rawModelName));
          standardModelName = normalizeText(mapping?.standardModelName || mapping?.rawModelName);
        }
        if (!standardModelName) {
          errorPoints += 1;
          insertError.run(
            toId('err'),
            batchId,
            row.rawModelName,
            row.weekLabel,
            row.rawValue,
            'unknown_model',
            '型号未维护',
            timestamp,
          );
          continue;
        }

        upsertPoint.run(
          standardModelName,
          Number(row.year || payload.year || DEFAULT_WEEKLY_SALES_YEAR),
          row.weekLabel,
          row.weekIndex,
          row.cumulativeSales,
          batchId,
          normalizeText(row.sourcePostUrl),
          normalizeText(row.evidenceText),
          timestamp,
          timestamp,
        );
        if (row.action === 'insert' || row.action === 'pending_model') {
          insertedPoints += 1;
        } else {
          updatedPoints += 1;
        }
      }

      const status = errorPoints > 0 ? '部分成功' : '成功';
      db.prepare(`
        INSERT INTO weekly_import_batch (
          id, import_name, import_type, imported_by, imported_at, total_rows, parsed_points,
          inserted_points, updated_points, error_points, status
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        batchId,
        payload.importName,
        normalizeText(importType) || 'paste',
        normalizeText(importedBy),
        timestamp,
        new Set(payload.previewRows.map((row) => row.rawModelName)).size,
        payload.previewRows.length,
        insertedPoints,
        updatedPoints,
        errorPoints,
        status,
      );
      db.exec('COMMIT');
      return {
        success: true,
        importBatchId: batchId,
        insertedPoints,
        updatedPoints,
        errorPoints,
      };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function mapAutomationRun(row) {
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      status: row.status,
      phase: row.phase,
      mode: row.mode,
      triggerSource: row.trigger_source,
      workerId: row.worker_id,
      claimedAt: row.claimed_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      postCount: row.post_count,
      salesRecordCount: row.sales_record_count,
      marketWeekCount: row.market_week_count,
      insertedPoints: row.inserted_points,
      skippedPoints: row.skipped_points,
      newModelCount: row.new_model_count,
      rawJsonPath: row.raw_json_path,
      summary: JSON.parse(row.summary_json || '{}'),
      errorMessage: row.error_message,
    };
  }

  function updateAutomationPhase(runId, phase) {
    ensureDatabase().prepare('UPDATE weibo_crawl_run SET phase = ? WHERE id = ?').run(phase, runId);
  }

  async function importAutomationRecords(records) {
    const tables = buildSalesWideTables(records);
    const results = [];
    for (const table of tables) {
      const yearRecords = records.filter((record) => record.year === table.year);
      const preview = await parseImport({
        rawText: table.rawText,
        year: table.year,
        recordMetadata: yearRecords,
        ignoreBlank: true,
        importName: `Browser Use CLI：RD观测 ${table.year} ${table.weeks.join('、')}`,
      });
      const newModelMappings = preview.unknownModels.map(({ rawModelName }) => ({
        rawModelName,
        standardModelName: rawModelName,
        brand: '',
        seriesPosition: '',
        isVisible: false,
        sortOrder: 999,
        remark: 'Browser Use CLI 自动发现，待维护',
      }));
      const confirmed = await confirmImport({
        batchPreviewId: preview.batchPreviewId,
        newModelMappings,
        importedBy: 'Browser Use CLI',
        allowPendingModels: true,
        importType: 'browser-use-cli',
      });
      results.push({ year: table.year, weeks: table.weeks, preview: preview.summary, confirmed });
    }
    return {
      results,
      insertedPoints: results.reduce((sum, result) => sum + result.confirmed.insertedPoints, 0),
      skippedPoints: results.reduce((sum, result) => sum + result.preview.skippedPoints, 0),
      newModelCount: results.reduce((sum, result) => sum + result.preview.unknownModelCount, 0),
    };
  }

  async function processAutomationPosts(runId, posts) {
    updateAutomationPhase(runId, 'parsing');
    const parsed = parseRdWeiboPosts(posts);
    if (parsed.salesRecords.length === 0) {
      throw new Error('最近21天微博中未识别到新品累计周销量');
    }

    const runDir = path.join(dataDir, 'weibo-runs', runId);
    const rawJsonPath = path.join(runDir, 'raw.json');
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(
      rawJsonPath,
      JSON.stringify(
        {
          metadata: { runId, fetchedAt: nowIso(), account: 'RD观测', uid: '7928198622', count: parsed.posts.length },
          posts: parsed.posts,
        },
        null,
        2,
      ),
      'utf8',
    );

    updateAutomationPhase(runId, 'importing_weekly_sales');
    const salesImport = await importAutomationRecords(parsed.salesRecords);
    updateAutomationPhase(runId, 'importing_market_share');
    const marketImport = applyMarketWeeks ? await applyMarketWeeks(parsed.marketWeeks) : { skipped: parsed.marketWeeks.length };
    return { parsed, salesImport, marketImport, rawJsonPath };
  }

  async function executeAutomationRun(runId, injectedPosts = null) {
    const db = ensureDatabase();
    try {
      if (!Array.isArray(injectedPosts)) {
        throw new Error('本机 Worker 未回传微博 posts 数组');
      }
      const result = await processAutomationPosts(runId, injectedPosts);
      const summary = {
        years: [...new Set(result.parsed.salesRecords.map((record) => record.year))],
        weeks: [...new Set(result.parsed.salesRecords.map((record) => `${record.year} ${record.weekLabel}`))],
        marketWeeks: result.parsed.marketWeeks.map((record) => `${record.year} ${record.weekLabel}`),
        warnings: result.parsed.warnings,
        salesImport: result.salesImport.results,
        marketImport: result.marketImport,
      };
      db.prepare(`
        UPDATE weibo_crawl_run
        SET status = 'success', phase = 'completed', finished_at = ?, post_count = ?, sales_record_count = ?,
            market_week_count = ?, inserted_points = ?, skipped_points = ?, new_model_count = ?,
            raw_json_path = ?, summary_json = ?, error_message = ''
        WHERE id = ?
      `).run(
        nowIso(),
        result.parsed.posts.length,
        result.parsed.salesRecords.length,
        result.parsed.marketWeeks.length,
        result.salesImport.insertedPoints,
        result.salesImport.skippedPoints,
        result.salesImport.newModelCount,
        result.rawJsonPath,
        JSON.stringify(summary),
        runId,
      );
    } catch (error) {
      db.prepare(`
        UPDATE weibo_crawl_run
        SET status = 'failed', phase = 'failed', finished_at = ?, error_message = ?
        WHERE id = ?
      `).run(nowIso(), error instanceof Error ? error.message : String(error), runId);
    }
    return mapAutomationRun(db.prepare('SELECT * FROM weibo_crawl_run WHERE id = ?').get(runId));
  }

  async function startAutomationRun({ posts, triggerSource = 'manual' } = {}) {
    await seedFromWorkbookIfNeeded();
    const db = ensureDatabase();
    const active = db
      .prepare("SELECT * FROM weibo_crawl_run WHERE status IN ('queued', 'running') ORDER BY started_at ASC LIMIT 1")
      .get();
    if (activeAutomationPromise || active) {
      return { alreadyRunning: true, run: mapAutomationRun(active) };
    }

    const runId = toId('weibo_run');
    const isInjected = Array.isArray(posts);
    db.prepare(`
      INSERT INTO weibo_crawl_run (id, status, phase, mode, trigger_source, started_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      runId,
      isInjected ? 'running' : 'queued',
      isInjected ? 'parsing' : 'waiting_for_local_worker',
      isInjected ? 'injected' : 'local-worker',
      triggerSource,
      nowIso(),
    );
    if (isInjected) {
      activeAutomationPromise = executeAutomationRun(runId, posts).finally(() => {
        activeAutomationPromise = null;
      });
    }
    return { alreadyRunning: false, run: mapAutomationRun(db.prepare('SELECT * FROM weibo_crawl_run WHERE id = ?').get(runId)) };
  }

  async function runAutomationFromPosts(posts) {
    const started = await startAutomationRun({ posts });
    if (started.alreadyRunning) {
      throw new Error('已有微博抓取任务正在运行');
    }
    return activeAutomationPromise;
  }

  function getAutomationStatus() {
    const db = ensureDatabase();
    const latest = db.prepare('SELECT * FROM weibo_crawl_run ORDER BY started_at DESC LIMIT 1').get();
    const scheduleState = db
      .prepare('SELECT last_attempt_slot, attempted_at, run_id FROM weekly_automation_schedule_state WHERE schedule_key = ?')
      .get(AUTOMATION_SCHEDULE_KEY);
    const worker = db.prepare('SELECT * FROM weekly_automation_worker ORDER BY last_seen_at DESC LIMIT 1').get();
    const workerOnline = Boolean(worker && Date.now() - Date.parse(worker.last_seen_at) < 120_000);
    return {
      configured: Boolean(workerToken),
      configurationError: workerToken ? '' : '云端缺少 WEEKLY_SALES_WORKER_TOKEN',
      mode: 'local-worker',
      source: { account: 'RD观测', uid: '7928198622', lookbackDays: 21 },
      schedule: '每周一、周五 10:00',
      scheduler: {
        enabled: scheduleEnabled,
        timeZone: scheduleTimeZone,
        lastAttemptSlot: scheduleState?.last_attempt_slot ?? '',
        attemptedAt: scheduleState?.attempted_at ?? '',
      },
      worker: {
        id: worker?.worker_id ?? '',
        lastSeenAt: worker?.last_seen_at ?? '',
        online: workerOnline,
      },
      latestRun: mapAutomationRun(latest),
    };
  }

  async function runScheduledAutomationIfDue(date = new Date()) {
    if (!scheduleEnabled || !workerToken) {
      return null;
    }
    const slot = getWeeklySalesScheduleSlot(date, scheduleTimeZone);
    if (!slot) {
      return null;
    }
    const db = ensureDatabase();
    const claim = db.prepare(`
      INSERT INTO weekly_automation_schedule_state (schedule_key, last_attempt_slot, attempted_at, run_id)
      VALUES (?, ?, ?, '')
      ON CONFLICT(schedule_key) DO UPDATE SET
        last_attempt_slot = excluded.last_attempt_slot,
        attempted_at = excluded.attempted_at,
        run_id = ''
      WHERE weekly_automation_schedule_state.last_attempt_slot <> excluded.last_attempt_slot
    `).run(AUTOMATION_SCHEDULE_KEY, slot, nowIso());
    if (claim.changes === 0) {
      return null;
    }
    const result = await startAutomationRun({ triggerSource: 'schedule' });
    db.prepare('UPDATE weekly_automation_schedule_state SET run_id = ? WHERE schedule_key = ?').run(
      result.run?.id ?? '',
      AUTOMATION_SCHEDULE_KEY,
    );
    return result;
  }

  function startAutomationScheduler() {
    if (!scheduleEnabled || schedulerTimer) {
      return;
    }
    const tick = () => {
      runScheduledAutomationIfDue().catch((error) => {
        console.error('weekly-sales scheduler failed', error);
      });
    };
    const initialTimer = setTimeout(tick, 5000);
    initialTimer.unref?.();
    schedulerTimer = setInterval(tick, 60_000);
    schedulerTimer.unref?.();
  }

  function authorizeManualAutomation(token) {
    return Boolean(automationToken) && tokensMatch(token, automationToken);
  }

  function authorizeWorker(token) {
    return Boolean(workerToken) && tokensMatch(token, workerToken);
  }

  function touchAutomationWorker(workerId) {
    const db = ensureDatabase();
    const normalizedWorkerId = normalizeText(workerId) || 'local-worker';
    const timestamp = nowIso();
    db.prepare(`
      INSERT INTO weekly_automation_worker (worker_id, last_seen_at, mode)
      VALUES (?, ?, 'local-chrome')
      ON CONFLICT(worker_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
    `).run(normalizedWorkerId, timestamp);
    return { workerId: normalizedWorkerId, lastSeenAt: timestamp };
  }

  async function claimAutomationRun(workerId) {
    await seedFromWorkbookIfNeeded();
    const db = ensureDatabase();
    const heartbeat = touchAutomationWorker(workerId);
    const normalizedWorkerId = heartbeat.workerId;
    const timestamp = heartbeat.lastSeenAt;
    db.prepare(`
      UPDATE weibo_crawl_run
      SET status = 'queued', phase = 'waiting_for_local_worker', worker_id = '', claimed_at = ''
      WHERE status = 'running' AND claimed_at <> '' AND claimed_at < ?
    `).run(new Date(Date.now() - 15 * 60_000).toISOString());
    const queued = db.prepare("SELECT * FROM weibo_crawl_run WHERE status = 'queued' ORDER BY started_at ASC LIMIT 1").get();
    if (!queued) {
      return null;
    }
    const claimed = db.prepare(`
      UPDATE weibo_crawl_run
      SET status = 'running', phase = 'scraping_weibo', worker_id = ?, claimed_at = ?
      WHERE id = ? AND status = 'queued'
    `).run(normalizedWorkerId, timestamp, queued.id);
    return claimed.changes ? mapAutomationRun(db.prepare('SELECT * FROM weibo_crawl_run WHERE id = ?').get(queued.id)) : null;
  }

  async function completeAutomationRun(runId, workerId, posts) {
    const row = ensureDatabase().prepare('SELECT * FROM weibo_crawl_run WHERE id = ?').get(runId);
    if (!row || row.status !== 'running' || row.worker_id !== normalizeText(workerId)) {
      throw new Error('任务不存在、状态已变化或不属于当前 Worker');
    }
    return executeAutomationRun(runId, posts);
  }

  function failAutomationRun(runId, workerId, message) {
    const result = ensureDatabase().prepare(`
      UPDATE weibo_crawl_run
      SET status = 'failed', phase = 'failed', finished_at = ?, error_message = ?
      WHERE id = ? AND status = 'running' AND worker_id = ?
    `).run(nowIso(), normalizeText(message) || '本机 Worker 执行失败', runId, normalizeText(workerId));
    if (!result.changes) {
      throw new Error('任务不存在、状态已变化或不属于当前 Worker');
    }
    return mapAutomationRun(ensureDatabase().prepare('SELECT * FROM weibo_crawl_run WHERE id = ?').get(runId));
  }

  async function upsertModel(payload, existingId = null) {
    await seedFromWorkbookIfNeeded();
    const timestamp = nowIso();
    const standardModelName = normalizeText(payload.standardModelName || payload.modelName || payload.name || payload.model);
    if (!standardModelName) {
      throw new Error('标准型号/系列不能为空');
    }
    const dimensions = validateConfiguredDimensions(payload);

    ensureDatabase()
      .prepare(`
        INSERT INTO weekly_model_dimension (
          id, standard_model_name, brand, series_position,
          is_visible, sort_order, remark, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(standard_model_name) DO UPDATE SET
          brand = excluded.brand,
          series_position = excluded.series_position,
          is_visible = excluded.is_visible,
          sort_order = excluded.sort_order,
          remark = excluded.remark,
          updated_at = excluded.updated_at
      `)
      .run(
        existingId || toId('model'),
        standardModelName,
        dimensions.brand,
        dimensions.seriesPosition,
        toSqlBool(payload.isVisible),
        Number(payload.sortOrder ?? 999),
        normalizeText(payload.remark),
        timestamp,
        timestamp,
      );

    return getModels({ keyword: standardModelName })[0];
  }

  async function updateModelById(id, payload) {
    await seedFromWorkbookIfNeeded();
    const existing = ensureDatabase().prepare('SELECT * FROM weekly_model_dimension WHERE id = ?').get(id);
    if (!existing) {
      throw new Error('型号不存在');
    }
    return upsertModel({ standardModelName: existing.standard_model_name, ...payload }, id);
  }

  async function getModelDetail(query) {
    await seedFromWorkbookIfNeeded();
    const id = normalizeText(query.id);
    const keyword = normalizeText(query.standardModelName || query.modelName || query.model || query.name || query.keyword);
    if (!id && !keyword) {
      return getOverview({
        brand: query.brand,
        seriesPosition: query.seriesPosition,
        startWeek: query.startWeek,
        endWeek: query.endWeek,
        visibleOnly: query.visibleOnly !== 'false',
      });
    }

    const model = id
      ? ensureDatabase().prepare('SELECT * FROM weekly_model_dimension WHERE id = ?').get(id)
      : ensureDatabase().prepare('SELECT * FROM weekly_model_dimension WHERE standard_model_name = ?').get(keyword);
    if (!model) {
      throw new Error('型号不存在');
    }

    const rows = readSalesRows({
      visibleOnly: false,
      year: query.year,
      startWeek: query.startWeek,
      endWeek: query.endWeek,
    }).filter((row) => row.standard_model_name === model.standard_model_name);
    const weeklyRows = buildWeeklyRows(rows);
    return {
      model: mapModelRow(model),
      cumulativeRows: rows.map((row) => ({
        standardModelName: row.standard_model_name,
        brand: row.brand,
        seriesPosition: row.series_position,
        year: row.year,
        weekLabel: row.week_label,
        weekIndex: row.week_index,
        cumulativeSales: row.cumulative_sales,
      })),
      weeklyRows,
    };
  }

  async function exportWorkbook() {
    const overview = await getOverview({ visibleOnly: false });
    const weeks = overview.filters.weeks;
    const models = overview.models;
    const cumulativeRows = [['型号/系列', '系列定位', '品牌', ...weeks]];
    const weeklyRows = [['型号/系列', '系列定位', '品牌', ...weeks]];

    for (const model of models) {
      cumulativeRows.push([
        model.standardModelName,
        model.seriesPosition,
        model.brand,
        ...weeks.map((week) => overview.cumulativeRows.find((row) => row.standardModelName === model.standardModelName && row.weekLabel === week)?.cumulativeSales ?? ''),
      ]);
      weeklyRows.push([
        model.standardModelName,
        model.seriesPosition,
        model.brand,
        ...weeks.map((week) => overview.weeklyRows.find((row) => row.standardModelName === model.standardModelName && row.weekLabel === week)?.weeklySales ?? ''),
      ]);
    }

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(weeklyRows), '分周销量');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(cumulativeRows), '累计销量');
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet(
        models.map((model) => ({
          标准型号系列: model.standardModelName,
          品牌: model.brand,
          系列定位: model.seriesPosition,
          是否展示: model.isVisible ? '是' : '否',
          排序: model.sortOrder,
          备注: model.remark,
        })),
      ),
      '型号维表',
    );

    return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  }

  return {
    databasePath,
    workbookPath,
    async getOverview(query) {
      return getOverview({
        brand: query.brand,
        seriesPosition: query.seriesPosition,
        year: query.year,
        startWeek: query.startWeek,
        endWeek: query.endWeek,
        visibleOnly: query.visibleOnly !== 'false',
      });
    },
    async getDetail(query) {
      return getModelDetail(query);
    },
    parseImport,
    confirmImport,
    startAutomationRun,
    runAutomationFromPosts,
    getAutomationStatus,
    runScheduledAutomationIfDue,
    startAutomationScheduler,
    authorizeManualAutomation,
    manualAutomationTokenConfigured: Boolean(automationToken),
    authorizeWorker,
    workerTokenConfigured: Boolean(workerToken),
    touchAutomationWorker,
    claimAutomationRun,
    completeAutomationRun,
    failAutomationRun,
    async getModels(query) {
      await seedFromWorkbookIfNeeded();
      return getModels(query);
    },
    async getConfig() {
      await seedFromWorkbookIfNeeded();
      return getConfig();
    },
    updateConfig,
    upsertModel,
    updateModelById,
    exportWorkbook,
  };
}

export function registerWeeklySalesRoutes(app, { dataDir, applyMarketWeeks }) {
  const service = createWeeklySalesService({ dataDir, applyMarketWeeks });

  app.get('/api/weekly-sales/overview', async (request, response) => {
    try {
      response.json(await service.getOverview(request.query));
    } catch (error) {
      response.status(500).json({ message: error instanceof Error ? error.message : '新品周销数据读取失败' });
    }
  });

  app.get('/api/weekly-sales/detail', async (request, response) => {
    try {
      response.json(await service.getDetail(request.query));
    } catch (error) {
      response.status(500).json({ message: error instanceof Error ? error.message : '新品周销明细读取失败' });
    }
  });

  app.post('/api/weekly-sales/import/parse', async (request, response) => {
    try {
      response.json(await service.parseImport(request.body ?? {}));
    } catch (error) {
      response.status(400).json({ message: error instanceof Error ? error.message : '新品周销导入解析失败' });
    }
  });

  app.get('/api/weekly-sales/automation/status', async (_request, response) => {
    try {
      response.json(service.getAutomationStatus());
    } catch (error) {
      response.status(500).json({ message: error instanceof Error ? error.message : '微博自动化状态读取失败' });
    }
  });

  app.post('/api/weekly-sales/automation/run', async (_request, response) => {
    const token = _request.get('x-automation-token') ?? '';
    if (!service.authorizeManualAutomation(token)) {
      const status = service.manualAutomationTokenConfigured ? 401 : 503;
      response.status(status).json({
        message:
          status === 401
            ? '自动抓取运行口令不正确'
            : '远程手动触发尚未配置 WEEKLY_SALES_AUTOMATION_TOKEN',
      });
      return;
    }
    try {
      const result = await service.startAutomationRun({ triggerSource: 'manual' });
      response.status(result.alreadyRunning ? 200 : 202).json(result);
    } catch (error) {
      response.status(400).json({ message: error instanceof Error ? error.message : '云端抓取任务创建失败' });
    }
  });

  app.post('/api/weekly-sales/automation/jobs/claim', async (request, response) => {
    const token = String(request.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!service.authorizeWorker(token)) {
      response.status(service.workerTokenConfigured ? 401 : 503).json({ message: '本机 Worker 鉴权失败或云端未配置 Worker Token' });
      return;
    }
    try {
      response.json({ job: await service.claimAutomationRun(request.body?.workerId) });
    } catch (error) {
      response.status(500).json({ message: error instanceof Error ? error.message : 'Worker 领取任务失败' });
    }
  });

  app.post('/api/weekly-sales/automation/jobs/heartbeat', (request, response) => {
    const token = String(request.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!service.authorizeWorker(token)) {
      response.status(401).json({ message: '本机 Worker 鉴权失败' });
      return;
    }
    response.json(service.touchAutomationWorker(request.body?.workerId));
  });

  app.post('/api/weekly-sales/automation/jobs/:id/complete', async (request, response) => {
    const token = String(request.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!service.authorizeWorker(token)) {
      response.status(401).json({ message: '本机 Worker 鉴权失败' });
      return;
    }
    try {
      response.json(await service.completeAutomationRun(request.params.id, request.body?.workerId, request.body?.posts));
    } catch (error) {
      response.status(400).json({ message: error instanceof Error ? error.message : 'Worker 结果回传失败' });
    }
  });

  app.post('/api/weekly-sales/automation/jobs/:id/fail', async (request, response) => {
    const token = String(request.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!service.authorizeWorker(token)) {
      response.status(401).json({ message: '本机 Worker 鉴权失败' });
      return;
    }
    try {
      response.json(service.failAutomationRun(request.params.id, request.body?.workerId, request.body?.message));
    } catch (error) {
      response.status(400).json({ message: error instanceof Error ? error.message : 'Worker 失败状态回传失败' });
    }
  });

  app.post('/api/weekly-sales/import/confirm', async (request, response) => {
    try {
      response.json(await service.confirmImport(request.body ?? {}));
    } catch (error) {
      response.status(400).json({ message: error instanceof Error ? error.message : '新品周销确认落库失败' });
    }
  });

  app.get('/api/weekly-sales/models', async (request, response) => {
    try {
      response.json(await service.getModels(request.query));
    } catch (error) {
      response.status(500).json({ message: error instanceof Error ? error.message : '型号列表读取失败' });
    }
  });

  app.get('/api/weekly-sales/config', async (_request, response) => {
    try {
      response.json(await service.getConfig());
    } catch (error) {
      response.status(500).json({ message: error instanceof Error ? error.message : '新品周销配置读取失败' });
    }
  });

  app.put('/api/weekly-sales/config', async (request, response) => {
    try {
      response.json(await service.updateConfig(request.body ?? {}));
    } catch (error) {
      response.status(400).json({ message: error instanceof Error ? error.message : '新品周销配置保存失败' });
    }
  });

  app.post('/api/weekly-sales/models', async (request, response) => {
    try {
      response.json(await service.upsertModel(request.body ?? {}));
    } catch (error) {
      response.status(400).json({ message: error instanceof Error ? error.message : '型号保存失败' });
    }
  });

  app.put('/api/weekly-sales/models/:id', async (request, response) => {
    try {
      response.json(await service.updateModelById(request.params.id, request.body ?? {}));
    } catch (error) {
      response.status(400).json({ message: error instanceof Error ? error.message : '型号更新失败' });
    }
  });

  app.put('/api/weekly-sales/models', async (request, response) => {
    try {
      response.json(await service.updateModelById(request.body?.id, request.body ?? {}));
    } catch (error) {
      response.status(400).json({ message: error instanceof Error ? error.message : '型号更新失败' });
    }
  });

  app.get('/api/weekly-sales/export.xlsx', async (_request, response) => {
    try {
      const buffer = await service.exportWorkbook();
      response.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      response.setHeader('Content-Disposition', 'attachment; filename="weekly-sales.xlsx"');
      response.send(buffer);
    } catch (error) {
      response.status(500).json({ message: error instanceof Error ? error.message : '新品周销导出失败' });
    }
  });

  return service;
}
