import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as z from 'zod/v4';
import {
  DEFAULT_SOURCE_NAME,
  buildAnalysis,
  buildChangeSummaryReport,
  buildMetadata,
  exportAllData,
  parseWorkbookFile,
  querySkus,
  readRawEditorDraft,
} from './lib/price-data.mjs';
import { getAllowedOrigins, getMcpTokens, isAllowedOrigin, isAuthorizedRequest } from './lib/mcp-auth.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const dataDir = process.env.PRICE_MONITOR_DATA_DIR || path.join(projectRoot, 'data');
const workbookPath = process.env.PRICE_MONITOR_WORKBOOK_PATH || path.join(projectRoot, DEFAULT_SOURCE_NAME);
const databasePath = path.join(dataDir, 'raw-editor-draft.sqlite');
const port = Number(process.env.MCP_PORT || 8790);
const host = process.env.MCP_HOST || '127.0.0.1';

function loadDataset() {
  return parseWorkbookFile(workbookPath, DEFAULT_SOURCE_NAME);
}

function loadDraft() {
  try {
    return readRawEditorDraft(databasePath);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function toToolResult(payload) {
  return {
    structuredContent: payload,
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload),
      },
    ],
  };
}

function createServer() {
  const server = new McpServer(
    {
      name: 'gtm-new-machine-price-monitor',
      version: '1.0.0',
    },
    {
      instructions:
        'Use these read-only tools to query GTM new-machine price monitor data. Prefer query_skus with filters before export_all_data.',
    },
  );

  const readOnlyAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  };

  server.registerTool(
    'get_metadata',
    {
      title: 'Get price monitor metadata',
      description: 'Return source, latest date, SKU count, brands, and raw editor draft status.',
      inputSchema: {},
      annotations: readOnlyAnnotations,
    },
    async () => {
      const dataset = loadDataset();
      const draft = loadDraft();
      return toToolResult(buildMetadata(dataset, draft));
    },
  );

  server.registerTool(
    'query_skus',
    {
      title: 'Query normalized SKU data',
      description: 'Query normalized SKU rows by brand, model, PPV, and optional date. Results are paginated.',
      inputSchema: {
        brand: z.string().optional().describe('Brand keyword, for example vivo, OPPO, 华为.'),
        model: z.string().optional().describe('Model keyword, for example iQOO 15.'),
        ppv: z.string().optional().describe('PPV keyword.'),
        date: z.string().optional().describe('Date label such as 5.28. If omitted, all snapshots are returned.'),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      },
      annotations: readOnlyAnnotations,
    },
    async (args) => {
      const dataset = loadDataset();
      return toToolResult(querySkus(dataset, args));
    },
  );

  server.registerTool(
    'get_raw_skus',
    {
      title: 'Get normalized raw SKU data',
      description: 'Return normalized SKU rows from the workbook with pagination.',
      inputSchema: {
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      },
      annotations: readOnlyAnnotations,
    },
    async (args) => {
      const dataset = loadDataset();
      return toToolResult(querySkus(dataset, args));
    },
  );

  server.registerTool(
    'get_raw_editor_draft',
    {
      title: 'Get raw editor draft',
      description: 'Return the saved raw editor draft from SQLite, if present.',
      inputSchema: {},
      annotations: readOnlyAnnotations,
    },
    async () => {
      return toToolResult({
        draft: loadDraft(),
      });
    },
  );

  server.registerTool(
    'get_summary',
    {
      title: 'Get price monitor summary',
      description: 'Return brand, position, model, and SKU-level analysis using the same business rules as the app summary.',
      inputSchema: {},
      annotations: readOnlyAnnotations,
    },
    async () => {
      const dataset = loadDataset();
      return toToolResult({
        metadata: buildMetadata(dataset, loadDraft()),
        summary: buildAnalysis(dataset),
      });
    },
  );

  server.registerTool(
    'get_change_summary',
    {
      title: 'Get list price and coupon change summary',
      description: 'Return the current list-price/coupon movement buckets used by the summary view.',
      inputSchema: {},
      annotations: readOnlyAnnotations,
    },
    async () => {
      const dataset = loadDataset();
      const summary = buildAnalysis(dataset);
      return toToolResult({
        metadata: buildMetadata(dataset, loadDraft()),
        changeSummary: buildChangeSummaryReport(summary.skuList),
      });
    },
  );

  server.registerTool(
    'export_all_data',
    {
      title: 'Export all price monitor data',
      description: 'Return metadata, workbook dataset, raw editor draft, summary, and change summary in one response.',
      inputSchema: {},
      annotations: readOnlyAnnotations,
    },
    async () => {
      return toToolResult(exportAllData({ workbookPath, databasePath }));
    },
  );

  return server;
}

function rejectJson(response, status, message) {
  response.status(status).json({
    jsonrpc: '2.0',
    error: {
      code: status === 401 ? -32001 : -32003,
      message,
    },
    id: null,
  });
}

const app = express();
app.use(express.json({ limit: '10mb' }));

app.get('/health', (_request, response) => {
  response.json({
    ok: true,
    service: 'gtm-price-monitor-mcp',
    tokensConfigured: getMcpTokens().length > 0,
    allowedOrigins: getAllowedOrigins(),
  });
});

app.use('/mcp', (request, response, next) => {
  if (!isAllowedOrigin(request)) {
    rejectJson(response, 403, 'Forbidden origin');
    return;
  }

  if (!isAuthorizedRequest(request)) {
    response.setHeader('WWW-Authenticate', 'Bearer');
    rejectJson(response, 401, 'Unauthorized');
    return;
  }

  next();
});

app.post('/mcp', async (request, response) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  let closed = false;
  const closeTransport = () => {
    if (closed) {
      return;
    }
    closed = true;
    transport.close();
    server.close();
  };
  response.on('close', closeTransport);

  try {
    await server.connect(transport);
    await transport.handleRequest(request, response, request.body);
  } catch (error) {
    console.error('Error handling MCP request:', error);
    if (!response.headersSent) {
      rejectJson(response, 500, 'Internal server error');
    }
  } finally {
    if (response.writableEnded) {
      closeTransport();
    }
  }
});

app.get('/mcp', (_request, response) => {
  response.status(405).set('Allow', 'POST').send('Method Not Allowed');
});

app.delete('/mcp', (_request, response) => {
  response.status(405).set('Allow', 'POST').send('Method Not Allowed');
});

app.listen(port, host, (error) => {
  if (error) {
    console.error('Failed to start GTM MCP server:', error);
    process.exit(1);
  }
  console.log(`gtm-price-monitor-mcp listening on http://${host}:${port}/mcp`);
});
