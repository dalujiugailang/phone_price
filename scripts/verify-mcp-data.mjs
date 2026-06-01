import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SOURCE_NAME,
  buildAnalysis,
  buildChangeSummaryReport,
  buildMetadata,
  parseWorkbookFile,
  querySkus,
  readRawEditorDraft,
} from '../server/lib/price-data.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const workbookPath = process.env.PRICE_MONITOR_WORKBOOK_PATH || path.join(projectRoot, DEFAULT_SOURCE_NAME);
const databasePath =
  process.env.PRICE_MONITOR_DRAFT_DATABASE_PATH || path.join(projectRoot, 'data', 'raw-editor-draft.sqlite');

const dataset = parseWorkbookFile(workbookPath, DEFAULT_SOURCE_NAME);
const draft = readRawEditorDraft(databasePath);
const summary = buildAnalysis(dataset);
const changeSummary = buildChangeSummaryReport(summary.skuList);
const vivoRows = querySkus(dataset, { brand: 'vivo', limit: 5 });

console.log(
  JSON.stringify(
    {
      metadata: buildMetadata(dataset, draft),
      summaryCounts: {
        skuList: summary.skuList.length,
        brandAnalysis: summary.brandAnalysis.length,
        positionAnalysis: summary.positionAnalysis.length,
        seriesAnalysis: summary.seriesAnalysis.length,
        changeSummaryBuckets: {
          listOnlyUp: changeSummary.listOnlyUp.length,
          listOnlyDown: changeSummary.listOnlyDown.length,
          couponOnlyDown: changeSummary.couponOnlyDown.length,
          couponOnlyUp: changeSummary.couponOnlyUp.length,
        },
      },
      sampleQuery: {
        total: vivoRows.total,
        returned: vivoRows.items.length,
        firstModel: vivoRows.items[0]?.model ?? null,
      },
    },
    null,
    2,
  ),
);
