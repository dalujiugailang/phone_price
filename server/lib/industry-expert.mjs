import fsSync from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Agent, run, tool } from '@openai/agents';
import { z } from 'zod';
import { buildAnalysis, parseWorkbookFile, readRawEditorDraft } from './price-data.mjs';

const DEFAULT_MODEL_LABEL = 'Agents SDK默认模型';

export const EXPERT_OUTPUT_SCHEMA = z.object({
  title: z.string().describe('本次分析的简短标题'),
  conclusion: z.string().describe('直接回答用户问题的一段结论'),
  facts: z
    .array(
      z.object({
        label: z.string().describe('事实名称'),
        value: z.string().describe('事实数字或内容'),
        dataDate: z.string().describe('数据日期、周次或暂无'),
        source: z.string().describe('数据来源'),
      }),
    )
    .max(8),
  inferences: z.array(z.string()).max(6).describe('明确标注为分析推断的判断'),
  actions: z
    .array(
      z.object({
        priority: z.enum(['高', '中', '低']),
        action: z.string(),
        reason: z.string(),
      }),
    )
    .max(6),
  evidenceSummary: z.array(z.string()).max(6).describe('本次实际调用的数据和证据摘要'),
  caveats: z.array(z.string()).max(6).describe('口径限制、风险和缺失数据'),
});

const SYSTEM_INSTRUCTION = `你是“3C行业专家agent”，服务于回收业务的价格和市场判断。

工作规则：
1. 回答前必须先调用工具，数字只能来自工具结果，禁止自行计算或补全。
2. 明确区分“事实”“推断”“建议”，每条重要判断写明数据日期或周次。
3. 当前系统的 latestPrice 是“国补后价格试算”口径，尚未确认等同JD自营实际成交价，必须如实说明。
4. 没有旧机回收量、库存、销量和毛利数据时，只能给机会方向，不能给预算或投入强度结论。
5. 市场零件、供应链等外部情报若工具没有返回，必须明确说当前没有已确认数据，不得编造。
6. 回答使用简洁中文，并严格按结构化输出字段填写：结论、关键事实、分析推断、建议动作、数据与证据、口径与风险。
7. facts只放工具返回的可验证事实；inferences只放推断；actions必须说明优先级和原因；不能确认的内容放入caveats。`;

function numberValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  const parsed = Number(String(value ?? '').replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (sorted.length === 0) {
    return 0;
  }
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function round(value, digits = 2) {
  return Number(Number(value || 0).toFixed(digits));
}

function compareDateLabels(left, right) {
  const [leftMonth, leftDay] = String(left).split('.').map(Number);
  const [rightMonth, rightDay] = String(right).split('.').map(Number);
  return leftMonth === rightMonth ? leftDay - rightDay : leftMonth - rightMonth;
}

function datasetFromDraft(draft, sourceName) {
  const dates = [...draft.dates].sort(compareDateLabels);
  const skus = draft.rows
    .map((row, index) => {
      const model = String(row.model ?? '').trim();
      const storage = String(row.storage ?? '').trim();
      if (!model || !storage) {
        return null;
      }

      const snapshots = dates
        .map((date) => {
          const raw = row.snapshots?.[date];
          if (!raw) {
            return null;
          }
          const finalPrice = numberValue(raw.finalPrice);
          const listPrice = numberValue(raw.listPrice);
          const coupon = numberValue(raw.coupon);
          const biPrice = numberValue(raw.biPrice);
          const rawValues = [raw.finalPrice, raw.listPrice, raw.coupon, raw.biPrice].map((value) =>
            String(value ?? '').trim(),
          );
          if (!rawValues.some(Boolean)) {
            return null;
          }
          return {
            date,
            finalPrice,
            listPrice,
            coupon,
            biPrice: biPrice || undefined,
            isDelisted: rawValues.some((value) => value === '已下架') || undefined,
          };
        })
        .filter(Boolean);

      return {
        id: String(row.id || `${model}-${storage}-${index + 1}`),
        brand: String(row.brand ?? '').trim() || '未识别',
        model,
        series: '',
        storage,
        position: String(row.position ?? '').trim(),
        ppv: String(row.ppv ?? '').trim(),
        launchPrice: numberValue(row.launchPrice),
        snapshots,
      };
    })
    .filter(Boolean);

  return {
    skus,
    dates,
    brands: [...new Set(skus.map((sku) => sku.brand))],
    loadedAt: draft.savedAt || new Date().toISOString(),
    sourceName,
    sheetName: 'raw-editor-draft',
  };
}

function loadPriceDataset({ workbookPath, databasePath }) {
  const workbookDataset = parseWorkbookFile(workbookPath);
  if (!databasePath || !fsSync.existsSync(databasePath)) {
    return workbookDataset;
  }

  const draft = readRawEditorDraft(databasePath);
  const draftLatestDate = draft?.dates?.at(-1) ?? '';
  const workbookLatestDate = workbookDataset.dates.at(-1) ?? '';
  if (!draft || !draftLatestDate || (workbookLatestDate && compareDateLabels(draftLatestDate, workbookLatestDate) < 0)) {
    return workbookDataset;
  }
  return datasetFromDraft(draft, '原始数据草稿');
}

function riskLevel(finalPrice, biPrice) {
  if (!finalPrice || !biPrice) {
    return 'unmatched';
  }
  if (biPrice >= finalPrice) {
    return 'high';
  }
  if (biPrice >= finalPrice * 0.95) {
    return 'risk';
  }
  return 'none';
}

function priceRows(dataset) {
  return buildAnalysis(dataset).skuList.map((sku) => {
    const snapshot = sku.snapshots.at(-1) ?? null;
    const finalPrice = snapshot?.finalPrice ?? 0;
    const biPrice = snapshot?.biPrice ?? 0;
    return {
      model: sku.model,
      storage: sku.storage,
      brand: sku.brand,
      position: sku.position,
      ppv: sku.ppv,
      priceDate: snapshot?.date ?? null,
      launchPrice: sku.launchPrice,
      latestPrice: finalPrice,
      biPrice,
      priceGap: finalPrice && biPrice ? round(finalPrice - biPrice) : null,
      riskRatioPct: finalPrice && biPrice ? round((biPrice / finalPrice) * 100) : null,
      recycleResidualPct: sku.launchPrice && biPrice ? round((biPrice / sku.launchPrice) * 100) : null,
      newProductResidualPct: sku.launchPrice && finalPrice ? round((finalPrice / sku.launchPrice) * 100) : null,
      riskLevel: riskLevel(finalPrice, biPrice || null),
    };
  });
}

export function buildPriceSummary(dataset, { limit = 8 } = {}) {
  const rows = priceRows(dataset);
  const matchedRows = rows.filter((row) => row.latestPrice > 0 && row.biPrice > 0);
  const riskRows = matchedRows
    .filter((row) => row.riskLevel === 'high' || row.riskLevel === 'risk')
    .sort((left, right) => (right.riskRatioPct ?? 0) - (left.riskRatioPct ?? 0));
  const byBrand = new Map();
  for (const row of rows) {
    if (!row.newProductResidualPct) {
      continue;
    }
    const values = byBrand.get(row.brand) ?? [];
    values.push(row.newProductResidualPct);
    byBrand.set(row.brand, values);
  }

  return {
    source: dataset.sourceName,
    priceDate: dataset.dates.at(-1) ?? null,
    priceDefinition: 'latestPrice 当前为系统“国补后价格试算”，尚未确认等同JD自营实际成交价',
    skuCount: rows.length,
    matchedBiPriceCount: matchedRows.length,
    highRiskCount: matchedRows.filter((row) => row.riskLevel === 'high').length,
    riskCount: matchedRows.filter((row) => row.riskLevel === 'risk').length,
    topRisks: riskRows.slice(0, Math.max(1, Math.min(20, Number(limit) || 8))),
    brandNewProductResiduals: [...byBrand.entries()]
      .map(([brand, values]) => ({
        brand,
        skuCount: values.length,
        medianResidualPct: round(median(values)),
      }))
      .sort((left, right) => right.medianResidualPct - left.medianResidualPct),
    evidence: [
      {
        label: '新机售价与BI价底表',
        source: dataset.sourceName,
        dataDate: dataset.dates.at(-1) ?? null,
        note: '风险阈值：BI价不低于新品价为高风险；达到新品价95%为风险。',
      },
    ],
  };
}

export function buildSalesSummary(overview, { limit = 8 } = {}) {
  const weeks = overview.filters?.weeks ?? [];
  const latestWeek = overview.summary?.latestWeek ?? weeks.at(-1) ?? '';
  const latestIndex = weeks.indexOf(latestWeek);
  const windowWeeks = weeks.slice(Math.max(0, latestIndex - 3), latestIndex + 1);
  const rowsByModel = new Map();

  for (const row of overview.weeklyRows ?? []) {
    if (!windowWeeks.includes(row.weekLabel)) {
      continue;
    }
    const current = rowsByModel.get(row.standardModelName) ?? {
      model: row.standardModelName,
      brand: row.brand,
      seriesPosition: row.seriesPosition || '未定位',
      values: Object.fromEntries(windowWeeks.map((week) => [week, null])),
    };
    current.values[row.weekLabel] = row.weeklySales;
    rowsByModel.set(row.standardModelName, current);
  }

  const candidates = [...rowsByModel.values()].map((item) => {
    const numericValues = windowWeeks
      .map((week) => item.values[week])
      .filter((value) => typeof value === 'number' && Number.isFinite(value));
    const first = numericValues[0] ?? 0;
    const last = numericValues.at(-1) ?? 0;
    return {
      model: item.model,
      brand: item.brand,
      seriesPosition: item.seriesPosition,
      weeklySales: item.values,
      fourWeekSales: round(numericValues.reduce((sum, value) => sum + value, 0)),
      latestWeekSales: round(last),
      trendPct: first ? round(((last - first) / first) * 100) : null,
      completeWeekCount: numericValues.length,
    };
  });

  const rankByPosition = new Map();
  for (const candidate of candidates) {
    const list = rankByPosition.get(candidate.seriesPosition) ?? [];
    list.push(candidate);
    rankByPosition.set(candidate.seriesPosition, list);
  }
  for (const list of rankByPosition.values()) {
    list
      .sort((left, right) => right.fourWeekSales - left.fourWeekSales)
      .forEach((item, index) => {
        item.positionRank = index + 1;
      });
  }

  return {
    source: '新品周销数据库',
    year: overview.summary?.year ?? null,
    latestWeek,
    windowWeeks,
    windowDefinition: '以最新可用完整周为截止，向前取4个周次；当前按T-2业务口径解释。',
    modelCount: candidates.length,
    topModels: candidates
      .filter((item) => item.completeWeekCount > 0)
      .sort((left, right) => right.fourWeekSales - left.fourWeekSales)
      .slice(0, Math.max(1, Math.min(20, Number(limit) || 8))),
    evidence: [
      {
        label: '新品周销累计销量差分',
        source: 'weekly-sales.sqlite',
        dataDate: latestWeek,
        note: `分析窗口：${windowWeeks.join('、') || '暂无数据'}`,
      },
    ],
  };
}

function buildMarketSummary(overview) {
  const latestWeek = overview.summary?.latestWeek ?? '';
  const recentWeeks = (overview.weeklyTotal ?? []).slice(-4);
  const latestEvents = (overview.events ?? []).filter((event) => recentWeeks.some((week) => week.week === event.week));
  return {
    source: overview.dataset?.sheetName ?? '市场总量份额趋势',
    latestWeek,
    latestTotalIndex: overview.summary?.latestTotalIndex ?? 0,
    latestTotalIndexChangePct: overview.summary?.latestTotalIndexChangePct ?? 0,
    topBrand: overview.summary?.topBrand ?? '',
    topBrandShare: overview.summary?.topBrandShare ?? 0,
    recentWeeks: recentWeeks.map((item) => ({
      week: item.week,
      totalIndex: item.totalIndex,
      marketNote: item.marketNote,
      eventName: item.eventName,
    })),
    events: latestEvents,
    externalSignalStatus: '当前没有已确认的零件、供应链涨价结构化数据，不能据此给出确定性判断。',
    evidence: [
      {
        label: '市场总量份额趋势',
        source: overview.dataset?.sheetName ?? '市场总量份额趋势',
        dataDate: latestWeek || null,
        note: '包括总量指数、品牌份额、市场备注和已录入事件。',
      },
    ],
  };
}

function buildBrief({ freshness, price, sales, market, configured, model }) {
  const topRisk = price.topRisks[0];
  const topSale = sales.topModels[0];
  const facts = [
    `价格数据截至 ${price.priceDate || '暂无'}，共 ${price.skuCount} 个SKU，匹配BI价 ${price.matchedBiPriceCount} 个。`,
    `防高收高风险 ${price.highRiskCount} 个、风险 ${price.riskCount} 个。`,
    `新品周销截至 ${sales.year || ''}${sales.latestWeek || '暂无'}，近四周窗口为 ${sales.windowWeeks.join('、') || '暂无'}。`,
    `市场总量数据截至 ${market.latestWeek || '暂无'}。`,
  ];
  const recommendations = [];
  if (topRisk) {
    recommendations.push(
      `优先核查 ${topRisk.model} ${topRisk.storage}：BI价/最新新品价为 ${topRisk.riskRatioPct}%。`,
    );
  }
  if (topSale) {
    recommendations.push(
      `新品侧优先关注 ${topSale.model}：近四周销量 ${topSale.fourWeekSales} 万，${topSale.seriesPosition}内排名第 ${topSale.positionRank}。`,
    );
  }
  if (recommendations.length === 0) {
    recommendations.push('当前有效数据不足，先补齐BI价或新品周销后再判断。');
  }
  return {
    configured,
    model,
    freshness,
    facts,
    recommendations,
    caveats: [
      '当前新品价为“国补后价格试算”，尚未确认等同JD自营实际成交价。',
      '当前缺少旧机回收量、库存和毛利，建议仅代表机会方向，不代表投入强度。',
      '当前没有已确认的零件和供应链结构化情报。',
    ],
  };
}

function toolSummary(name, result) {
  if (name === 'check_data_freshness') {
    return `价格 ${result.priceDate || '暂无'}；周销 ${result.salesYear || ''}${result.salesWeek || '暂无'}；市场 ${result.marketWeek || '暂无'}`;
  }
  if (name === 'get_price_summary') {
    return `高风险 ${result.highRiskCount}，风险 ${result.riskCount}，BI价匹配 ${result.matchedBiPriceCount}`;
  }
  if (name === 'get_sales_summary') {
    return `${result.windowWeeks.join('、') || '暂无周次'}，返回 ${result.topModels.length} 个型号`;
  }
  if (name === 'get_market_trend') {
    return `${result.latestWeek || '暂无周次'}，总量指数 ${result.latestTotalIndex}`;
  }
  if (name === 'drilldown_sku') {
    return `匹配 ${result.items.length} 个SKU`;
  }
  return '工具调用完成';
}

function ensureRunDatabase(databasePath) {
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE IF NOT EXISTS expert_runs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      model TEXT NOT NULL,
      tools_json TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_expert_runs_session_created
      ON expert_runs(session_id, created_at DESC);
  `);
  return database;
}

function outputToText(output) {
  if (typeof output === 'string') {
    return output;
  }
  if (!output || typeof output !== 'object') {
    return '';
  }
  return [
    `结论：${output.conclusion || ''}`,
    ...(output.facts ?? []).map((item) => `事实：${item.label} ${item.value}（${item.dataDate}，${item.source}）`),
    ...(output.inferences ?? []).map((item) => `推断：${item}`),
    ...(output.actions ?? []).map((item) => `建议：${item.action}（${item.priority}，${item.reason}）`),
    ...(output.caveats ?? []).map((item) => `口径：${item}`),
  ]
    .filter(Boolean)
    .join('\n');
}

function parseStoredOutput(value) {
  try {
    return JSON.parse(value);
  } catch {
    return {
      title: '历史分析',
      conclusion: String(value ?? ''),
      facts: [],
      inferences: [],
      actions: [],
      evidenceSummary: [],
      caveats: [],
    };
  }
}

export function createIndustryExpertService({
  dataDir,
  workbookPath,
  databasePath,
  getWeeklySalesOverview,
  getMarketTrendOverview,
}) {
  const runDatabase = ensureRunDatabase(`${dataDir}/expert-runs.sqlite`);

  async function loadContext() {
    const priceDataset = loadPriceDataset({ workbookPath, databasePath });
    const [salesOverview, marketOverview] = await Promise.all([
      getWeeklySalesOverview({ visibleOnly: 'true' }),
      getMarketTrendOverview(),
    ]);
    return {
      priceDataset,
      salesOverview,
      marketOverview,
      price: buildPriceSummary(priceDataset),
      sales: buildSalesSummary(salesOverview),
      market: buildMarketSummary(marketOverview),
    };
  }

  async function getFreshness(context) {
    return {
      priceDate: context.price.priceDate,
      priceSource: context.price.source,
      salesYear: context.sales.year,
      salesWeek: context.sales.latestWeek,
      marketWeek: context.market.latestWeek,
      checkedAt: new Date().toISOString(),
    };
  }

  async function executeTool(name, args, context) {
    if (name === 'check_data_freshness') {
      return getFreshness(context);
    }
    if (name === 'get_price_summary') {
      return buildPriceSummary(context.priceDataset, args);
    }
    if (name === 'get_sales_summary') {
      return buildSalesSummary(context.salesOverview, args);
    }
    if (name === 'get_market_trend') {
      return context.market;
    }
    if (name === 'drilldown_sku') {
      const keyword = String(args?.keyword ?? '').trim().toLowerCase();
      const items = priceRows(context.priceDataset)
        .filter((row) => [row.brand, row.model, row.ppv].some((value) => String(value).toLowerCase().includes(keyword)))
        .slice(0, 12);
      return {
        keyword,
        priceDate: context.price.priceDate,
        priceDefinition: context.price.priceDefinition,
        items,
        evidence: context.price.evidence,
      };
    }
    throw new Error(`不支持的Agent工具：${name}`);
  }

  async function getStatus() {
    const context = await loadContext();
    return {
      configured: Boolean(process.env.OPENAI_API_KEY),
      model: process.env.OPENAI_MODEL || DEFAULT_MODEL_LABEL,
      freshness: await getFreshness(context),
    };
  }

  async function getBrief() {
    const context = await loadContext();
    const configured = Boolean(process.env.OPENAI_API_KEY);
    const model = process.env.OPENAI_MODEL || DEFAULT_MODEL_LABEL;
    const freshness = await getFreshness(context);
    return buildBrief({ freshness, price: context.price, sales: context.sales, market: context.market, configured, model });
  }

  function getSessions() {
    const rows = runDatabase
      .prepare(
        `SELECT session_id, question, created_at
         FROM expert_runs
         ORDER BY created_at DESC`,
      )
      .all();
    const seen = new Set();
    return rows
      .filter((row) => {
        if (seen.has(row.session_id)) {
          return false;
        }
        seen.add(row.session_id);
        return true;
      })
      .slice(0, 30)
      .map((row) => ({
        sessionId: row.session_id,
        title: String(row.question).slice(0, 34),
        updatedAt: row.created_at,
      }));
  }

  function getSession(sessionId) {
    return runDatabase
      .prepare(
        `SELECT id, session_id, question, answer, model, tools_json, evidence_json, created_at
         FROM expert_runs
         WHERE session_id = ?
         ORDER BY created_at ASC`,
      )
      .all(String(sessionId))
      .map((row) => ({
        runId: row.id,
        sessionId: row.session_id,
        question: row.question,
        output: parseStoredOutput(row.answer),
        model: row.model,
        toolCalls: JSON.parse(row.tools_json),
        evidence: JSON.parse(row.evidence_json),
        createdAt: row.created_at,
      }));
  }

  async function ask({ question, sessionId, history = [] }, onEvent = () => {}) {
    const normalizedQuestion = String(question ?? '').trim();
    if (!normalizedQuestion) {
      throw new Error('请输入要分析的问题');
    }
    if (!process.env.OPENAI_API_KEY) {
      const error = new Error('Agent模型未配置，请在服务端设置 OPENAI_API_KEY');
      error.statusCode = 503;
      throw error;
    }

    const context = await loadContext();
    const model = process.env.OPENAI_MODEL || DEFAULT_MODEL_LABEL;
    const recentHistory = Array.isArray(history)
      ? history
          .slice(-6)
          .map((item) => `${item.role === 'assistant' ? '专家' : '用户'}：${String(item.content ?? '').slice(0, 1200)}`)
          .join('\n')
      : '';
    const prompt = recentHistory
      ? `最近对话：\n${recentHistory}\n\n当前问题：${normalizedQuestion}`
      : normalizedQuestion;
    const toolCalls = [];
    const evidence = [];
    onEvent({ type: 'status', label: '正在理解任务并选择数据工具' });

    const executeRecordedTool = async (name, args = {}) => {
      const callId = randomUUID();
      onEvent({ type: 'tool_started', callId, name, args });
      const result = await executeTool(name, args, context);
      const recordedCall = {
        callId,
        name,
        summary: toolSummary(name, result),
      };
      toolCalls.push(recordedCall);
      for (const item of result.evidence ?? []) {
        if (!evidence.some((existing) => existing.label === item.label && existing.dataDate === item.dataDate)) {
          evidence.push(item);
        }
      }
      onEvent({ type: 'tool_completed', ...recordedCall });
      return result;
    };

    const agentTools = [
      tool({
        name: 'check_data_freshness',
        description: '检查价格、新品周销和市场趋势数据分别更新到什么日期或周次。',
        parameters: z.object({}),
        execute: () => executeRecordedTool('check_data_freshness'),
      }),
      tool({
        name: 'get_price_summary',
        description: '获取防高收风险、回收残值率、新品残值率和品牌残值率。',
        parameters: z.object({
          limit: z.number().int().min(1).max(20).optional().describe('返回风险SKU数量，默认8条。'),
        }),
        execute: (args) => executeRecordedTool('get_price_summary', args),
      }),
      tool({
        name: 'get_sales_summary',
        description: '按最新可用完整周向前取四周，找出同定位中新品周销表现较好的型号。',
        parameters: z.object({
          limit: z.number().int().min(1).max(20).optional().describe('返回型号数量，默认8条。'),
        }),
        execute: (args) => executeRecordedTool('get_sales_summary', args),
      }),
      tool({
        name: 'get_market_trend',
        description: '获取当前市场总量指数、环周变化、品牌份额和已录入市场事件。',
        parameters: z.object({}),
        execute: () => executeRecordedTool('get_market_trend'),
      }),
      tool({
        name: 'drilldown_sku',
        description: '按品牌、型号或PPV关键词下钻价格、残值率和防高收风险证据。',
        parameters: z.object({
          keyword: z.string().min(1).describe('品牌、型号或PPV关键词。'),
        }),
        execute: (args) => executeRecordedTool('drilldown_sku', args),
      }),
    ];
    const agentOptions = {
      name: '3C行业专家agent',
      instructions: SYSTEM_INSTRUCTION,
      tools: agentTools,
      outputType: EXPERT_OUTPUT_SCHEMA,
      modelSettings: { toolChoice: 'required' },
      resetToolChoice: true,
    };
    if (process.env.OPENAI_MODEL) {
      agentOptions.model = process.env.OPENAI_MODEL;
    }
    const agent = new Agent(agentOptions);
    const result = await run(agent, prompt, {
      maxTurns: 6,
      toolNotFoundBehavior: 'return_error_to_model',
      stream: true,
    });
    for await (const event of result) {
      if (event.type === 'agent_updated_stream_event') {
        onEvent({ type: 'status', label: `${event.agent.name} 正在分析工具结果` });
      }
    }
    await result.completed;
    const output = result.finalOutput;
    if (!output) {
      throw new Error('Agent没有生成有效回答，请重试');
    }

    const runId = randomUUID();
    const normalizedSessionId = String(sessionId || randomUUID());
    const createdAt = new Date().toISOString();
    runDatabase
      .prepare(
        `INSERT INTO expert_runs
          (id, session_id, question, answer, model, tools_json, evidence_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        normalizedSessionId,
        normalizedQuestion,
        JSON.stringify(output),
        model,
        JSON.stringify(toolCalls),
        JSON.stringify(evidence),
        createdAt,
      );

    const payload = {
      runId,
      sessionId: normalizedSessionId,
      answer: outputToText(output),
      output,
      model,
      toolCalls,
      evidence,
      freshness: await getFreshness(context),
      createdAt,
    };
    onEvent({ type: 'final', payload });
    return payload;
  }

  return {
    getStatus,
    getBrief,
    getSessions,
    getSession,
    ask,
  };
}

export function registerIndustryExpertRoutes(app, options) {
  const service = createIndustryExpertService(options);

  app.get('/api/expert/status', async (_request, response) => {
    try {
      response.json(await service.getStatus());
    } catch (error) {
      response.status(500).json({ message: error instanceof Error ? error.message : 'Agent状态读取失败' });
    }
  });

  app.get('/api/expert/brief', async (_request, response) => {
    try {
      response.json(await service.getBrief());
    } catch (error) {
      response.status(500).json({ message: error instanceof Error ? error.message : '专家简报生成失败' });
    }
  });

  app.get('/api/expert/sessions', (_request, response) => {
    try {
      response.json({ sessions: service.getSessions() });
    } catch (error) {
      response.status(500).json({ message: error instanceof Error ? error.message : '任务列表读取失败' });
    }
  });

  app.get('/api/expert/sessions/:sessionId', (request, response) => {
    try {
      response.json({ runs: service.getSession(request.params.sessionId) });
    } catch (error) {
      response.status(500).json({ message: error instanceof Error ? error.message : '任务记录读取失败' });
    }
  });

  app.post('/api/expert/ask', async (request, response) => {
    try {
      response.json(await service.ask(request.body ?? {}));
    } catch (error) {
      response
        .status(Number(error?.statusCode) || 500)
      .json({ message: error instanceof Error ? error.message : 'Agent分析失败' });
    }
  });

  app.post('/api/expert/ask/stream', async (request, response) => {
    if (!process.env.OPENAI_API_KEY) {
      response.status(503).json({ message: 'Agent模型未配置，请在服务端设置 OPENAI_API_KEY' });
      return;
    }

    response.status(200);
    response.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
    response.setHeader('cache-control', 'no-cache, no-transform');
    response.setHeader('x-accel-buffering', 'no');
    response.flushHeaders();
    const send = (event) => response.write(`${JSON.stringify(event)}\n`);

    try {
      await service.ask(request.body ?? {}, send);
    } catch (error) {
      send({ type: 'error', message: error instanceof Error ? error.message : 'Agent分析失败' });
    } finally {
      response.end();
    }
  });

  return service;
}
