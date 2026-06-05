import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import XLSX from 'xlsx';

const DEFAULT_SERIES_POSITIONS = ['主品牌旗舰', '子系旗舰', '主品牌中端', '中低端'];
const SUMMARY_MODEL_PATTERN = /汇总|合计|总计|小计|总盘/;
const SAMPLE_WORKBOOK_PATH = '/Users/dudu/Downloads/新机销量数据源.xlsx';

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
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

function excelDateToIso(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return normalizeText(value).slice(0, 10);
  }

  const parsed = XLSX.SSF.parse_date_code(value);
  if (!parsed) {
    return normalizeText(value).slice(0, 10);
  }

  return `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
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
    priceBand: row.price_band,
    launchDate: row.launch_date,
    isVisible: fromSqlBool(row.is_visible),
    sortOrder: row.sort_order ?? 0,
    remark: row.remark ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function createWeeklySalesService({ dataDir }) {
  const databasePath = process.env.WEEKLY_SALES_DB_PATH || path.join(dataDir, 'weekly-sales.sqlite');
  const workbookPath = process.env.WEEKLY_SALES_WORKBOOK_PATH || path.join(dataDir, '新机销量数据源.xlsx');
  let database;

  async function ensureDataDir() {
    await fs.mkdir(dataDir, { recursive: true });
  }

  function ensureDatabase() {
    if (database) {
      return database;
    }

    database = new DatabaseSync(databasePath);
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

      CREATE TABLE IF NOT EXISTS weekly_cumulative_sales (
        standard_model_name TEXT NOT NULL,
        week_label TEXT NOT NULL,
        week_index INTEGER NOT NULL,
        cumulative_sales REAL NOT NULL,
        import_batch_id TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (standard_model_name, week_index)
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
    `);
    return database;
  }

  function modelCount() {
    return ensureDatabase().prepare('SELECT COUNT(*) AS count FROM weekly_model_dimension').get().count;
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
    const launchIndex = dimensionHeaders.findIndex((header) => header.includes('上市日期'));
    const positionIndex = dimensionHeaders.findIndex((header) => header.includes('系列定位'));
    const priceBandIndex = dimensionHeaders.findIndex((header) => header.includes('价格带'));
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
        priceBand: normalizeText(row[priceBandIndex]).replace(/^2k\+$/i, '2K+'),
        launchDate: excelDateToIso(row[launchIndex]),
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
      : fsSync.existsSync(SAMPLE_WORKBOOK_PATH)
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
        standard_model_name, week_label, week_index, cumulative_sales, import_batch_id, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(standard_model_name, week_index) DO UPDATE SET
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
          model.priceBand,
          model.launchDate,
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
    if (filters.priceBand) {
      clauses.push('price_band = ?');
      params.push(filters.priceBand);
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
    if (filters.priceBand) {
      clauses.push('m.price_band = ?');
      params.push(filters.priceBand);
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
          m.price_band,
          m.launch_date,
          m.is_visible,
          m.sort_order,
          s.week_label,
          s.week_index,
          s.cumulative_sales,
          s.updated_at
        FROM weekly_cumulative_sales s
        JOIN weekly_model_dimension m ON m.standard_model_name = s.standard_model_name
        ${where}
        ORDER BY m.sort_order ASC, m.standard_model_name ASC, s.week_index ASC
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
          priceBand: row.price_band,
          launchDate: row.launch_date,
          isVisible: fromSqlBool(row.is_visible),
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
    const models = getModels({});
    const allRows = readSalesRows({ ...filters, startWeek: undefined, endWeek: undefined });
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

    const charts = DEFAULT_SERIES_POSITIONS.map((seriesPosition) => {
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
        latestWeek,
        modelCount: models.filter((model) => model.isVisible).length,
        latestWeekSales: Number(latestWeekSales.toFixed(2)),
        wowChange: Number(wowChange.toFixed(2)),
        newModelCount: 0,
        errorCount,
        updatedAt: latestBatch?.imported_at ?? '',
      },
      filters: {
        brands: [...new Set(models.map((model) => model.brand).filter(Boolean))],
        seriesPositions: DEFAULT_SERIES_POSITIONS,
        priceBands: [...new Set(models.map((model) => model.priceBand).filter(Boolean))],
        weeks: allWeeks,
      },
      charts,
      models,
      cumulativeRows: rows.map((row) => ({
        standardModelName: row.standard_model_name,
        brand: row.brand,
        seriesPosition: row.series_position,
        priceBand: row.price_band,
        launchDate: row.launch_date,
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

  async function parseImport({ rawText, text, content, paste, importName }) {
    await seedFromWorkbookIfNeeded();
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
    const existingPoints = new Map(
      ensureDatabase()
        .prepare('SELECT standard_model_name, week_index, cumulative_sales FROM weekly_cumulative_sales')
        .all()
        .map((row) => [`${row.standard_model_name}::${row.week_index}`, row.cumulative_sales]),
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
          weekLabel: weekColumn.weekLabel,
          weekIndex: weekColumn.weekIndex,
          rawValue: String(rawValue ?? ''),
        };

        if (parsed === null) {
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

        const existingValue = existingPoints.get(`${standardModelName}::${weekColumn.weekIndex}`);
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

  async function confirmImport({ batchPreviewId, newModelMappings = [], importedBy = '' }) {
    await seedFromWorkbookIfNeeded();
    const db = ensureDatabase();
    const preview = db.prepare('SELECT payload_json FROM weekly_import_preview WHERE id = ?').get(batchPreviewId);
    if (!preview) {
      throw new Error('导入预览不存在或已失效，请重新解析');
    }

    const payload = JSON.parse(preview.payload_json);
    const timestamp = nowIso();
    const batchId = toId('batch');
    const mappingByRawName = new Map(newModelMappings.map((item) => [normalizeKey(item.rawModelName), item]));
    const insertModel = db.prepare(`
      INSERT INTO weekly_model_dimension (
        id, standard_model_name, brand, series_position, price_band, launch_date,
        is_visible, sort_order, remark, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(standard_model_name) DO UPDATE SET
        brand = excluded.brand,
        series_position = excluded.series_position,
        price_band = excluded.price_band,
        launch_date = excluded.launch_date,
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
        standard_model_name, week_label, week_index, cumulative_sales, import_batch_id, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(standard_model_name, week_index) DO UPDATE SET
        week_label = excluded.week_label,
        cumulative_sales = excluded.cumulative_sales,
        import_batch_id = excluded.import_batch_id,
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
        insertModel.run(
          toId('model'),
          standardModelName,
          normalizeText(mapping.brand),
          normalizeText(mapping.seriesPosition),
          normalizeText(mapping.priceBand).replace(/^2k\+$/i, '2K+'),
          normalizeText(mapping.launchDate),
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

        upsertPoint.run(standardModelName, row.weekLabel, row.weekIndex, row.cumulativeSales, batchId, timestamp, timestamp);
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
        VALUES (?, ?, 'paste', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        batchId,
        payload.importName,
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

  async function upsertModel(payload, existingId = null) {
    await seedFromWorkbookIfNeeded();
    const timestamp = nowIso();
    const standardModelName = normalizeText(payload.standardModelName || payload.modelName || payload.name || payload.model);
    if (!standardModelName) {
      throw new Error('标准型号/系列不能为空');
    }
    if (!normalizeText(payload.seriesPosition)) {
      throw new Error('系列定位不能为空');
    }

    ensureDatabase()
      .prepare(`
        INSERT INTO weekly_model_dimension (
          id, standard_model_name, brand, series_position, price_band, launch_date,
          is_visible, sort_order, remark, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(standard_model_name) DO UPDATE SET
          brand = excluded.brand,
          series_position = excluded.series_position,
          price_band = excluded.price_band,
          launch_date = excluded.launch_date,
          is_visible = excluded.is_visible,
          sort_order = excluded.sort_order,
          remark = excluded.remark,
          updated_at = excluded.updated_at
      `)
      .run(
        existingId || toId('model'),
        standardModelName,
        normalizeText(payload.brand),
        normalizeText(payload.seriesPosition),
        normalizeText(payload.priceBand).replace(/^2k\+$/i, '2K+'),
        normalizeText(payload.launchDate),
        toSqlBool(payload.isVisible),
        Number(payload.sortOrder ?? 999),
        normalizeText(payload.remark),
        timestamp,
        timestamp,
      );

    if (payload.rawModelAlias) {
      ensureDatabase()
        .prepare(`
          INSERT INTO weekly_model_alias (id, raw_model_name, standard_model_name, created_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(raw_model_name) DO UPDATE SET standard_model_name = excluded.standard_model_name
        `)
        .run(toId('alias'), normalizeText(payload.rawModelAlias), standardModelName, timestamp);
    }
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
        priceBand: query.priceBand,
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
        priceBand: row.price_band,
        launchDate: row.launch_date,
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
    const cumulativeRows = [['型号/系列', '上市日期间', '系列定位', '价格带', '品牌', ...weeks]];
    const weeklyRows = [['型号/系列', '上市日期间', '系列定位', '价格带', '品牌', ...weeks]];

    for (const model of models) {
      cumulativeRows.push([
        model.standardModelName,
        model.launchDate,
        model.seriesPosition,
        model.priceBand,
        model.brand,
        ...weeks.map((week) => overview.cumulativeRows.find((row) => row.standardModelName === model.standardModelName && row.weekLabel === week)?.cumulativeSales ?? ''),
      ]);
      weeklyRows.push([
        model.standardModelName,
        model.launchDate,
        model.seriesPosition,
        model.priceBand,
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
          价格带: model.priceBand,
          上市日期: model.launchDate,
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
        priceBand: query.priceBand,
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
    async getModels(query) {
      await seedFromWorkbookIfNeeded();
      return getModels(query);
    },
    upsertModel,
    updateModelById,
    exportWorkbook,
  };
}

export function registerWeeklySalesRoutes(app, { dataDir }) {
  const service = createWeeklySalesService({ dataDir });

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
