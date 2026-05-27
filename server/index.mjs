import express from 'express';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const dataDir = process.env.PRICE_MONITOR_DATA_DIR || path.join(projectRoot, 'data');
const draftPath = path.join(dataDir, 'raw-editor-draft.json');
const databasePath = path.join(dataDir, 'raw-editor-draft.sqlite');
const workbookPath = process.env.PRICE_MONITOR_WORKBOOK_PATH || path.join(projectRoot, '新机售价监控.xlsx');
const distDir = path.join(projectRoot, 'dist');
const indexHtmlPath = path.join(distDir, 'index.html');
const port = Number(process.env.PORT || process.env.PRICE_MONITOR_API_PORT || 8787);
const dailyPriceLookupUrl = process.env.DAILY_PRICE_LOOKUP_URL || 'http://127.0.0.1:8765/api/lookup';
const dailyPriceTokenPath =
  process.env.DAILY_PRICE_TOKEN_PATH ||
  '/Users/dudu/Desktop/trae/重点日常项目/【daily price】/data/api_token.txt';

const app = express();
let database;

app.use(express.json({ limit: '10mb' }));

async function ensureDataDir() {
  await fs.mkdir(dataDir, { recursive: true });
}

function ensureDatabase() {
  if (database) {
    return database;
  }

  database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE IF NOT EXISTS raw_editor_drafts (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      dates_json TEXT NOT NULL,
      rows_json TEXT NOT NULL,
      saved_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  return database;
}

async function readLegacyDraftFile() {
  try {
    const content = await fs.readFile(draftPath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function readDraftFromDatabase() {
  const statement = ensureDatabase().prepare(`
    SELECT dates_json, rows_json, saved_at
    FROM raw_editor_drafts
    WHERE id = 1
  `);
  const row = statement.get();
  if (!row) {
    return null;
  }

  return {
    dates: JSON.parse(row.dates_json),
    rows: JSON.parse(row.rows_json),
    savedAt: row.saved_at,
  };
}

function writeDraftToDatabase(payload) {
  const now = new Date().toISOString();
  const nextDraft = {
    dates: payload.dates,
    rows: payload.rows,
    savedAt: typeof payload.savedAt === 'string' ? payload.savedAt : now,
  };

  ensureDatabase()
    .prepare(`
      INSERT INTO raw_editor_drafts (id, dates_json, rows_json, saved_at, updated_at)
      VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        dates_json = excluded.dates_json,
        rows_json = excluded.rows_json,
        saved_at = excluded.saved_at,
        updated_at = excluded.updated_at
    `)
    .run(JSON.stringify(nextDraft.dates), JSON.stringify(nextDraft.rows), nextDraft.savedAt, now);

  return nextDraft;
}

async function migrateLegacyDraftIfNeeded() {
  const existingDraft = readDraftFromDatabase();
  if (existingDraft) {
    return;
  }

  const legacyDraft = await readLegacyDraftFile();
  if (!legacyDraft || !isValidDraftPayload(legacyDraft)) {
    return;
  }

  writeDraftToDatabase(legacyDraft);
}

function isValidDraftPayload(payload) {
  return Boolean(
    payload &&
      Array.isArray(payload.dates) &&
      Array.isArray(payload.rows) &&
      payload.dates.every((item) => typeof item === 'string'),
  );
}

function normalizeHeader(value) {
  return String(value ?? '').replace(/\s+/g, '').trim();
}

function findHeaderIndex(headers, keywords) {
  return headers.findIndex((header) => keywords.some((keyword) => header.includes(keyword)));
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

function toCompactDate(dateLabel) {
  const [month, day] = dateLabel.split('.');
  return `${month.padStart(2, '0')}${day.padStart(2, '0')}`;
}

function parseNumericInput(value) {
  const normalized = String(value ?? '').replace(/,/g, '').trim();
  if (!normalized) {
    return '';
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? Math.round(parsed) : normalized;
}

function normalizeStorage(value) {
  return String(value ?? '')
    .replace(/\s+/g, '')
    .replace(/GB/gi, 'G')
    .replace(/TB/gi, 'T')
    .replace(/^(\d+)\+/, '$1G+')
    .toUpperCase();
}

function getSnapshotMetricHeader(dateLabel, metric) {
  const compactDate = toCompactDate(dateLabel);
  if (metric === 'finalPrice') {
    return '国补后价格试算';
  }
  if (metric === 'listPrice') {
    return `${compactDate}挂牌价`;
  }
  if (metric === 'coupon') {
    return `${compactDate}优惠力度`;
  }
  return `${compactDate}BI出货价`;
}

function isSnapshotMetricHeader(header, metric) {
  const lowerHeader = header.toLowerCase();
  if (metric === 'finalPrice') {
    return header.includes('国补后');
  }
  if (metric === 'listPrice') {
    return header.includes('挂牌价') || header.includes('面价');
  }
  if (metric === 'coupon') {
    return header.includes('优惠');
  }
  return lowerHeader.includes('bi价') || lowerHeader.includes('bi出货价');
}

function findOrCreateSnapshotColumn(sheet, rows, headerRowIndex, dateLabel, metric) {
  const groupHeaders = (rows[headerRowIndex - 1] ?? []).map(normalizeHeader);
  const headers = (rows[headerRowIndex] ?? []).map(normalizeHeader);
  let currentGroupHeader = '';
  let dateGroupEndIndex = -1;

  for (let index = 0; index < headers.length; index += 1) {
    if (groupHeaders[index]) {
      currentGroupHeader = groupHeaders[index];
    }

    if (!headers[index]) {
      continue;
    }

    const currentDate = toDateLabel(currentGroupHeader) ?? toDateLabel(headers[index]);
    if (currentDate !== dateLabel) {
      continue;
    }

    dateGroupEndIndex = index;
    if (isSnapshotMetricHeader(headers[index], metric)) {
      return index;
    }
  }

  const range = XLSX.utils.decode_range(sheet['!ref']);
  const preferredIndex = dateGroupEndIndex >= 0 ? dateGroupEndIndex + 1 : range.e.c + 1;
  let columnIndex = preferredIndex;

  while (headers[columnIndex] || groupHeaders[columnIndex]) {
    columnIndex += 1;
  }

  XLSX.utils.sheet_add_aoa(
    sheet,
    [[dateGroupEndIndex >= 0 ? '' : `-${dateLabel}原始数据`], [getSnapshotMetricHeader(dateLabel, metric)]],
    { origin: { r: headerRowIndex - 1, c: columnIndex } },
  );
  rows[headerRowIndex - 1][columnIndex] = dateGroupEndIndex >= 0 ? '' : `-${dateLabel}原始数据`;
  rows[headerRowIndex][columnIndex] = getSnapshotMetricHeader(dateLabel, metric);

  return columnIndex;
}

function writeDraftToWorkbook(payload) {
  const workbook = XLSX.readFile(workbookPath);
  const [sheetName] = workbook.SheetNames;
  if (!sheetName) {
    throw new Error('Excel 文件中没有可读取的工作表');
  }

  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: true,
    defval: '',
  });
  const headerRowIndex = rows.findIndex((row) => {
    const headers = row.map(normalizeHeader);
    return headers.includes('型号名称') && headers.includes('存储版本');
  });

  if (headerRowIndex === -1) {
    throw new Error('Excel 中未找到“型号名称 / 存储版本”表头');
  }

  const headers = rows[headerRowIndex].map(normalizeHeader);
  const modelIndex = findHeaderIndex(headers, ['型号名称']);
  const storageIndex = findHeaderIndex(headers, ['存储版本']);
  const positionIndex = findHeaderIndex(headers, ['定位']);
  const ppvIndex = findHeaderIndex(headers, ['ppv']);
  const launchPriceIndex = findHeaderIndex(headers, ['发布挂牌售价', '发布价']);
  if (modelIndex === -1 || storageIndex === -1) {
    throw new Error('Excel 中缺少型号名称或存储版本字段');
  }

  const rowIndexByKey = new Map();
  rows.slice(headerRowIndex + 1).forEach((row, offset) => {
    const model = String(row[modelIndex] ?? '').trim();
    const storage = String(row[storageIndex] ?? '').trim();
    const ppv = ppvIndex === -1 ? '' : String(row[ppvIndex] ?? '').trim();
    const rowIndex = headerRowIndex + 1 + offset;

    if (ppv) {
      rowIndexByKey.set(`ppv:${ppv}`, rowIndex);
    }
    if (model && storage) {
      rowIndexByKey.set(`model:${model}::${normalizeStorage(storage)}`, rowIndex);
    }
  });

  const columnByDateMetric = new Map();
  let cellsWritten = 0;
  let rowsAppended = 0;

  for (const draftRow of payload.rows) {
    const model = String(draftRow.model ?? '').trim();
    const storage = String(draftRow.storage ?? '').trim();
    if (!model || !storage) {
      continue;
    }

    let rowIndex =
      (draftRow.ppv ? rowIndexByKey.get(`ppv:${String(draftRow.ppv).trim()}`) : undefined) ??
      rowIndexByKey.get(`model:${model}::${normalizeStorage(storage)}`);

    if (rowIndex === undefined) {
      rowIndex = rows.length;
      rows.push([]);
      rowsAppended += 1;
    }

    const baseValues = [
      [modelIndex, model],
      [storageIndex, storage],
      [positionIndex, String(draftRow.position ?? '').trim()],
      [ppvIndex, String(draftRow.ppv ?? '').trim()],
      [launchPriceIndex, parseNumericInput(draftRow.launchPrice)],
    ].filter(([columnIndex]) => columnIndex !== -1);

    for (const [columnIndex, value] of baseValues) {
      if (value === '') {
        continue;
      }
      XLSX.utils.sheet_add_aoa(sheet, [[value]], { origin: { r: rowIndex, c: columnIndex } });
      rows[rowIndex][columnIndex] = value;
      cellsWritten += 1;
    }

    const rowPpv = String(draftRow.ppv ?? '').trim();
    if (rowPpv) {
      rowIndexByKey.set(`ppv:${rowPpv}`, rowIndex);
    }
    rowIndexByKey.set(`model:${model}::${normalizeStorage(storage)}`, rowIndex);

    for (const dateLabel of payload.dates) {
      const snapshot = draftRow.snapshots?.[dateLabel];
      if (!snapshot) {
        continue;
      }

      for (const metric of ['finalPrice', 'listPrice', 'coupon', 'biPrice']) {
        const value = parseNumericInput(snapshot[metric]);
        if (value === '') {
          continue;
        }

        const columnKey = `${dateLabel}::${metric}`;
        const columnIndex =
          columnByDateMetric.get(columnKey) ?? findOrCreateSnapshotColumn(sheet, rows, headerRowIndex, dateLabel, metric);
        columnByDateMetric.set(columnKey, columnIndex);
        XLSX.utils.sheet_add_aoa(sheet, [[value]], { origin: { r: rowIndex, c: columnIndex } });
        rows[rowIndex][columnIndex] = value;
        cellsWritten += 1;
      }
    }
  }

  XLSX.writeFile(workbook, workbookPath);
  return {
    workbookPath,
    rowsWritten: cellsWritten,
    cellsWritten,
    rowsAppended,
  };
}

app.get('/api/health', (_request, response) => {
  response.json({ ok: true, storage: 'sqlite', databasePath });
});

app.get('/api/raw-editor-draft', async (_request, response) => {
  const draft = readDraftFromDatabase();
  if (!draft) {
    response.status(404).json({ message: 'No draft found' });
    return;
  }

  response.json(draft);
});

app.post('/api/raw-editor-draft', async (request, response) => {
  const payload = request.body;
  if (!isValidDraftPayload(payload)) {
    response.status(400).json({ message: 'Invalid raw editor draft payload' });
    return;
  }

  await ensureDataDir();
  const nextDraft = writeDraftToDatabase(payload);
  if (payload.syncWorkbook === true) {
    try {
      const workbookResult = writeDraftToWorkbook(payload);
      response.json({ ok: true, savedAt: nextDraft.savedAt, workbook: workbookResult });
    } catch (error) {
      response.status(500).json({
        message: error instanceof Error ? error.message : 'Excel 写回失败',
        savedAt: nextDraft.savedAt,
      });
    }
    return;
  }

  response.json({ ok: true, savedAt: nextDraft.savedAt });
});

app.post('/api/bi-price-lookup', async (request, response) => {
  const ppvs = Array.isArray(request.body?.ppv)
    ? request.body.ppv
    : Array.isArray(request.body?.ppvs)
      ? request.body.ppvs
      : [];
  const normalizedPpvs = ppvs.map((item) => String(item ?? '').trim()).filter(Boolean);

  if (normalizedPpvs.length === 0) {
    response.status(400).json({ message: 'ppv is required' });
    return;
  }

  try {
    const token = (await fs.readFile(dailyPriceTokenPath, 'utf8')).trim();
    const lookupResponse = await fetch(dailyPriceLookupUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ppv: normalizedPpvs }),
    });
    const payload = await lookupResponse.json();

    if (!lookupResponse.ok) {
      response.status(lookupResponse.status).json(payload);
      return;
    }

    response.json(payload);
  } catch (error) {
    response.status(502).json({
      message: error instanceof Error ? error.message : 'BI 出货价接口调用失败',
    });
  }
});

app.get('/api/workbook.xlsx', (_request, response) => {
  response.sendFile(workbookPath, {
    headers: {
      'Cache-Control': 'no-store',
    },
  });
});

if (fsSync.existsSync(distDir)) {
  app.use(express.static(distDir, { index: false }));

  app.get('*', (request, response, next) => {
    if (request.path.startsWith('/api/')) {
      next();
      return;
    }

    response.sendFile(indexHtmlPath);
  });
}

ensureDataDir()
  .then(() => migrateLegacyDraftIfNeeded())
  .then(() => {
    app.listen(port, () => {
      console.log(`price-monitor-api listening on http://localhost:${port}`);
    });
  })
  .catch((error) => {
    console.error('Failed to initialize price-monitor-api', error);
    process.exit(1);
  });
