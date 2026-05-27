import express from 'express';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const dataDir = path.join(projectRoot, 'data');
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
