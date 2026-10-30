import {spawn} from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const dataDir=path.resolve(process.env.PREVIEW_DATA_DIR || 'data/preview-20261027');
if(!fs.existsSync(path.join(dataDir,'raw-editor-draft.sqlite')))throw new Error('预览数据副本不存在，请先准备隔离数据目录');
const server=spawn(process.execPath,['server/index.mjs'],{stdio:'inherit',env:{...process.env,PORT:'8788',PRICE_MONITOR_DATA_DIR:dataDir,PRICE_MONITOR_DRAFT_DB_PATH:path.join(dataDir,'raw-editor-draft.sqlite'),PRICE_MONITOR_WORKBOOK_PATH:path.join(dataDir,'新机售价监控.xlsx'),MARKET_TREND_WORKBOOK_PATH:path.join(dataDir,'市场总量份额趋势.xlsx'),MARKET_TREND_DRAFT_DB_PATH:path.join(dataDir,'market-trend.sqlite'),WEEKLY_SALES_DB_PATH:path.join(dataDir,'weekly-sales.sqlite'),GTM_WAREHOUSE_PATH:path.join(dataDir,'warehouse/gtm_warehouse.duckdb'),PRICE_COLLECTION_SCHEDULE_ENABLED:'false',WEEKLY_SALES_SCHEDULE_ENABLED:'false'}});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.kill(signal));
server.on('exit',code=>process.exit(code || 0));
