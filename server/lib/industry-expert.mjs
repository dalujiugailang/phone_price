import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Agent, run, tool, webSearchTool } from '@openai/agents';
import { z } from 'zod';
import { createWarehouseQueryService } from './warehouse-query.mjs';

const DEFAULT_MODEL_LABEL = 'Agents SDK默认模型';

export const CHART_SPEC_SCHEMA = z.object({
  type: z.enum(['bar', 'line', 'pie']).describe('柱状图、折线图或饼图'),
  title: z.string().min(1).max(80),
  subtitle: z.string().max(160).optional(),
  categories: z.array(z.string()).min(1).max(20),
  series: z
    .array(
      z.object({
        name: z.string().min(1).max(40),
        values: z.array(z.number()).min(1).max(20),
      }),
    )
    .min(1)
    .max(5),
  unit: z.string().max(16).optional(),
});

const SYSTEM_INSTRUCTION = `你是“3C行业专家agent”，服务于回收业务的价格和市场判断。

工作规则：
1. 先理解用户真正要做的判断，再自行决定是否调用工具、调用哪些工具以及调用顺序。简单问题可以直接回答，不要为了展示能力而滥用工具。
2. 涉及内部价格、残值、销量或市场数据时，必须查询数仓工具；不要凭记忆补数字，也不要把工具返回的事实误写成模型估算。涉及近期新闻、零件涨价、供应链、品牌发布或外部市场变化时，使用实时 Web Search。
3. 回答结构由问题决定，不使用固定六段式模板。可以是一段结论、要点、对比表或短报告，优先直接、具体、有数字。
4. 业务数字只能来自工具结果；重要数字写明日期、周次或来源。把已确认事实和分析判断区分清楚，但不必机械地使用固定标题。
5. 风险与残值只使用四项指标：高收价差=BI出货价－国补后价格试算；高收风险率=BI出货价÷国补后价格试算；旧机残值率=BI出货价÷新机发售价；新机残值率=国补后价格试算÷新机发售价。不要自行新增风险分、风险等级或阈值。
6. 新机价格走势的聚合口径与【概览】一致；价格为0或已下架时，都沿用此前最近一次有效的国补后价格试算。
7. 新品周销的T-2是相对数仓内最新周向前推2周。若用户要求“近一个月”，应查询足够周次后由你汇总判断，而不是只返回一个固定榜单。
8. 没有旧机回收量、库存、销量和毛利数据时，只能给机会方向，不能给预算或投入强度结论。
9. Web Search 信息必须带可点击来源；优先品牌官网、监管机构、研究机构和可信媒体，不要把搜索摘要当成内部事实。
10. 当趋势、品牌对比、排名或时间序列用图形更容易理解时，调用 create_chart；图表数字必须来自本轮工具结果，简单问答不要强行生成图表。
11. 最终回答使用自然、简洁的中文 Markdown。不要复述工具执行过程，界面会单独展示。`;

function toolSummary(name, result) {
  if (name === 'inspect_warehouse') {
    return `价格 ${result.价格数据日期 || '暂无'}；BI ${result.BI数据日期 || '暂无'}；周销 ${result.周销年份 || ''}${result.周销最新周 || '暂无'}；市场 ${result.市场最新周 || '暂无'}`;
  }
  if (name === 'query_new_price_trend') {
    return `${result.数据粒度}，返回 ${result.返回行数} 行`;
  }
  if (name === 'query_new_used_risk') {
    return `新旧机风险明细，返回 ${result.返回行数} 行`;
  }
  if (name === 'query_market_sales_trend') {
    return `市场与新品周销，返回 ${result.返回行数} 行`;
  }
  return '工具调用完成';
}

function toolActivityLabel(name, args = {}) {
  if (name === 'inspect_warehouse') {
    return '读取数仓目录与数据新鲜度';
  }
  if (name === 'query_new_price_trend') {
    return args.mode === '聚合' ? '查询新机价格聚合走势' : '查询SKU价格走势';
  }
  if (name === 'query_new_used_risk') {
    return '查询新旧机风险与残值';
  }
  if (name === 'query_market_sales_trend') {
    return '查询新品周销与市场趋势';
  }
  if (name === 'create_chart') {
    return `生成图表：${String(args.title ?? '').trim() || '数据图表'}`;
  }
  if (name === 'web_search') {
    return '搜索实时市场信息';
  }
  return name;
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
  if (typeof output.markdown === 'string') {
    return output.markdown;
  }
  return [
    output.conclusion || '',
    ...(output.facts ?? []).map((item) => `- ${item.label}：${item.value}（${item.dataDate}，${item.source}）`),
    ...(output.inferences ?? []).map((item) => `- ${item}`),
    ...(output.actions ?? []).map((item) => `- ${item.action}（${item.priority}，${item.reason}）`),
    ...(output.caveats ?? []).map((item) => `- ${item}`),
  ]
    .filter(Boolean)
    .join('\n');
}

function parseStoredOutput(value) {
  try {
    const parsed = JSON.parse(value);
    if (parsed?.version === 2 && typeof parsed.markdown === 'string') {
      return {
        ...parsed,
        charts: Array.isArray(parsed.charts) ? parsed.charts : [],
        sources: Array.isArray(parsed.sources) ? parsed.sources : [],
      };
    }
    return {
      version: 2,
      title: parsed?.title || '历史分析',
      markdown: outputToText(parsed),
      charts: [],
      sources: [],
    };
  } catch {
    return {
      version: 2,
      title: '历史分析',
      markdown: String(value ?? ''),
      charts: [],
      sources: [],
    };
  }
}

function deriveTitle(question, answer) {
  const heading = String(answer)
    .split('\n')
    .map((line) => line.trim())
    .find((line) => /^#{1,3}\s+\S/.test(line));
  const candidate = heading ? heading.replace(/^#{1,3}\s+/, '') : String(question);
  return candidate.replace(/\s+/g, ' ').trim().slice(0, 40) || '3C行业分析';
}

function normalizeChart(chart) {
  const categoryCount = chart.categories.length;
  for (const series of chart.series) {
    if (series.values.length !== categoryCount) {
      throw new Error(`图表“${series.name}”的数据数量与分类数量不一致`);
    }
  }
  if (chart.type === 'pie' && chart.series.length !== 1) {
    throw new Error('饼图只支持一个数据系列');
  }
  return {
    id: randomUUID(),
    type: chart.type,
    title: chart.title,
    subtitle: chart.subtitle || '',
    categories: chart.categories,
    series: chart.series,
    unit: chart.unit || '',
  };
}

function uniqueSource(sources, source) {
  const url = String(source?.url ?? '').trim();
  if (!url || sources.some((item) => item.url === url)) {
    return;
  }
  sources.push({
    title: String(source?.title ?? '').trim() || url,
    url,
  });
}

function collectMessageSources(item, sources) {
  for (const content of item?.rawItem?.content ?? []) {
    for (const annotation of content?.providerData?.annotations ?? []) {
      if (annotation?.type === 'url_citation') {
        uniqueSource(sources, annotation);
      }
    }
  }
}

export function createIndustryExpertService({
  dataDir,
  warehousePath,
  waitForWarehouse,
}) {
  const runDatabase = ensureRunDatabase(`${dataDir}/expert-runs.sqlite`);
  const warehouse = createWarehouseQueryService({
    dataDir,
    warehousePath,
    waitForWarehouse,
  });

  function catalogToFreshness(catalog) {
    return {
      priceDate: catalog.价格数据日期 ?? null,
      priceSource: catalog.新机价格来源 ?? '新机价格走势表',
      biPriceDate: catalog.BI数据日期 ?? null,
      salesYear: catalog.周销年份 ?? null,
      salesWeek: catalog.周销最新周 ?? '',
      marketWeek: catalog.市场最新周 ?? '',
      warehouseRefreshedAt: catalog.数仓刷新时间 ?? null,
      checkedAt: new Date().toISOString(),
    };
  }

  async function getFreshness() {
    return catalogToFreshness(await warehouse.getCatalog());
  }

  async function executeTool(name, args) {
    if (name === 'inspect_warehouse') {
      return warehouse.getCatalog();
    }
    if (name === 'query_new_price_trend') {
      return warehouse.queryNewPriceTrend(args);
    }
    if (name === 'query_new_used_risk') {
      return warehouse.queryNewUsedRisk(args);
    }
    if (name === 'query_market_sales_trend') {
      return warehouse.queryMarketSalesTrend(args);
    }
    throw new Error(`不支持的Agent工具：${name}`);
  }

  async function getStatus() {
    return {
      configured: Boolean(process.env.OPENAI_API_KEY),
      model: process.env.OPENAI_MODEL || DEFAULT_MODEL_LABEL,
      freshness: await getFreshness(),
      warehousePath: warehouse.warehousePath,
    };
  }

  async function getBrief() {
    const configured = Boolean(process.env.OPENAI_API_KEY);
    const model = process.env.OPENAI_MODEL || DEFAULT_MODEL_LABEL;
    const catalog = await warehouse.getCatalog();
    return {
      configured,
      model,
      freshness: catalogToFreshness(catalog),
      facts: [
        `数仓包含 ${catalog.新机价格事实行数} 行新机价格事实和 ${catalog.旧机S等级价格事实行数} 行旧机S等级价格事实。`,
        `新品周销 ${catalog.新品周销事实行数} 行，市场趋势 ${catalog.市场趋势事实行数} 行。`,
      ],
      recommendations: [],
      caveats: catalog.PPV冲突数 > 0 ? [`存在 ${catalog.PPV冲突数} 个PPV映射冲突，相关SKU不会自动匹配BI价。`] : [],
    };
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
    const charts = [];
    const sources = [];
    const recordedToolCallIds = new Set();
    const webSearchStates = new Map();
    onEvent({ type: 'status', label: '正在理解问题' });

    const executeRecordedTool = async (name, args = {}) => {
      const callId = randomUUID();
      const label = toolActivityLabel(name, args);
      onEvent({ type: 'tool_started', callId, name, label, args });
      const result = await executeTool(name, args);
      const recordedCall = {
        callId,
        name,
        label,
        summary: toolSummary(name, result),
      };
      toolCalls.push(recordedCall);
      recordedToolCallIds.add(callId);
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
        name: 'inspect_warehouse',
        description: '读取数仓中有哪些业务表、四项指标口径、事实表行数、数据日期、刷新时间和PPV映射质量。',
        parameters: z.object({}),
        execute: () => executeRecordedTool('inspect_warehouse'),
      }),
      tool({
        name: 'query_new_price_trend',
        description:
          '查询新机SKU价格历史，或按与【概览】相同逻辑查询品牌、机型定位、型号系列的聚合价格走势。适合价格变化、趋势、挂牌价、优惠券和品牌对比。',
        parameters: z.object({
          mode: z.enum(['SKU明细', '聚合']).optional().describe('默认SKU明细；需要均价、环比或品牌/定位/型号趋势时用聚合。'),
          brand: z.string().optional().describe('精确品牌名。'),
          position: z.string().optional().describe('精确机型定位，仅SKU明细模式。'),
          keyword: z.string().optional().describe('SKU模式匹配型号；聚合模式匹配维度值。'),
          scope: z.enum(['全量', '老样本', '5.26新增']).optional().describe('聚合样本范围。'),
          dimension: z.enum(['品牌', '机型定位', '型号系列']).optional().describe('聚合维度。'),
          startDate: z.string().optional().describe('开始日期，YYYY-MM-DD。'),
          endDate: z.string().optional().describe('结束日期，YYYY-MM-DD。'),
          limit: z.number().int().min(1).max(100).optional().describe('最多返回100行，默认20行。'),
        }),
        execute: (args) => executeRecordedTool('query_new_price_trend', args),
      }),
      tool({
        name: 'query_new_used_risk',
        description:
          '查询SKU级新旧机价格、BI出货价，以及仅有的四项指标：高收价差、高收风险率、旧机残值率、新机残值率。适合风险排序、品牌或型号残值比较。',
        parameters: z.object({
          brand: z.string().optional().describe('精确品牌名。'),
          position: z.string().optional().describe('精确机型定位。'),
          keyword: z.string().optional().describe('型号关键词。'),
          startDate: z.string().optional().describe('新机价格开始日期，YYYY-MM-DD。'),
          endDate: z.string().optional().describe('新机价格结束日期，YYYY-MM-DD。'),
          latestOnly: z.boolean().optional().describe('是否只看最新新机价格日，默认true。'),
          onlyMatched: z.boolean().optional().describe('是否只看已匹配BI价的SKU，默认true。'),
          minRiskRate: z.number().optional().describe('高收风险率下限，例如0.95。'),
          sortBy: z.enum(['高收风险率', '高收价差', '旧机残值率', '新机残值率']).optional(),
          limit: z.number().int().min(1).max(100).optional().describe('最多返回100行，默认20行。'),
        }),
        execute: (args) => executeRecordedTool('query_new_used_risk', args),
      }),
      tool({
        name: 'query_market_sales_trend',
        description:
          '联合查询新品分周销量、累计销量、系列定位、品牌周度份额、大盘指数和市场事件。适合T-2、近一个月销量、市场趋势和旧机投入方向判断。',
        parameters: z.object({
          brand: z.string().optional().describe('精确品牌名。'),
          position: z.string().optional().describe('精确系列定位。'),
          keyword: z.string().optional().describe('型号或系列关键词。'),
          week: z.string().optional().describe('精确周次，例如W19。'),
          tMinus2Only: z.boolean().optional().describe('是否只返回T-2周。'),
          limit: z.number().int().min(1).max(100).optional().describe('最多返回100行，默认20行。'),
        }),
        execute: (args) => executeRecordedTool('query_market_sales_trend', args),
      }),
      tool({
        name: 'create_chart',
        description:
          '当趋势、品牌对比、排名或时间序列用图形更易理解时，创建一个柱状图、折线图或饼图。简单问答不要调用。',
        parameters: CHART_SPEC_SCHEMA,
        execute: async (args) => {
          const callId = randomUUID();
          const label = toolActivityLabel('create_chart', args);
          onEvent({ type: 'tool_started', callId, name: 'create_chart', label, args });
          const chart = normalizeChart(args);
          charts.push(chart);
          const recordedCall = {
            callId,
            name: 'create_chart',
            label,
            summary: `${chart.type === 'line' ? '折线图' : chart.type === 'pie' ? '饼图' : '柱状图'}，${chart.categories.length} 个分类`,
          };
          toolCalls.push(recordedCall);
          recordedToolCallIds.add(callId);
          onEvent({ type: 'tool_completed', ...recordedCall });
          return {
            created: true,
            chartId: chart.id,
            title: chart.title,
            categoryCount: chart.categories.length,
          };
        },
      }),
      webSearchTool({
        searchContextSize: 'medium',
        externalWebAccess: true,
        userLocation: {
          type: 'approximate',
          country: 'CN',
          timezone: 'Asia/Shanghai',
        },
      }),
    ];
    const agentOptions = {
      name: '3C行业专家agent',
      instructions: SYSTEM_INSTRUCTION,
      tools: agentTools,
    };
    if (process.env.OPENAI_MODEL) {
      agentOptions.model = process.env.OPENAI_MODEL;
    }
    const agent = new Agent(agentOptions);
    const result = await run(agent, prompt, {
      maxTurns: 8,
      toolNotFoundBehavior: 'return_error_to_model',
      stream: true,
    });
    for await (const event of result) {
      if (event.type === 'agent_updated_stream_event') {
        onEvent({ type: 'status', label: `${event.agent.name} 正在继续分析` });
        continue;
      }
      if (event.type === 'raw_model_stream_event') {
        if (event.data?.type === 'output_text_delta' && event.data.delta) {
          onEvent({ type: 'text_delta', delta: event.data.delta });
          continue;
        }
        if (event.data?.type !== 'model') {
          continue;
        }
        const rawEvent = event.data.event;
        const rawType = rawEvent?.type;
        const callId = rawEvent?.item_id || rawEvent?.item?.id;
        if (
          callId &&
          (rawType === 'response.web_search_call.in_progress' || rawType === 'response.web_search_call.searching') &&
          !webSearchStates.has(callId)
        ) {
          const label = toolActivityLabel('web_search');
          webSearchStates.set(callId, { callId, label, completed: false });
          onEvent({ type: 'tool_started', callId, name: 'web_search', label });
        }
        if (callId && rawType === 'response.web_search_call.completed') {
          const current = webSearchStates.get(callId) ?? {
            callId,
            label: toolActivityLabel('web_search'),
          };
          current.completed = true;
          webSearchStates.set(callId, current);
          onEvent({
            type: 'tool_completed',
            callId,
            name: 'web_search',
            label: current.label,
            summary: '已完成实时 Web 搜索',
          });
        }
        continue;
      }
      if (event.type === 'run_item_stream_event' && event.name === 'message_output_created') {
        collectMessageSources(event.item, sources);
        continue;
      }
      if (event.type === 'run_item_stream_event' && event.name === 'tool_called') {
        const rawItem = event.item?.rawItem;
        if (rawItem?.type !== 'hosted_tool_call' || rawItem?.providerData?.type !== 'web_search_call') {
          continue;
        }
        const callId = event.item.callId || rawItem.id || randomUUID();
        const action = rawItem.providerData.action ?? {};
        const query = String(action.query ?? action.queries?.[0] ?? '').trim();
        for (const source of action.sources ?? []) {
          uniqueSource(sources, source);
        }
        const label = query ? `搜索：${query}` : toolActivityLabel('web_search');
        const summary = sources.length > 0 ? `搜索完成，引用 ${sources.length} 个来源` : '搜索完成';
        const recordedCall = { callId, name: 'web_search', label, summary };
        const existingIndex = toolCalls.findIndex((item) => item.callId === callId);
        if (existingIndex >= 0) {
          toolCalls[existingIndex] = recordedCall;
        } else {
          toolCalls.push(recordedCall);
        }
        recordedToolCallIds.add(callId);
        onEvent({ type: 'tool_completed', ...recordedCall });
      }
    }
    await result.completed;
    const answer = String(result.finalOutput ?? '').trim();
    if (!answer) {
      throw new Error('Agent没有生成有效回答，请重试');
    }
    for (const [callId, state] of webSearchStates) {
      if (!recordedToolCallIds.has(callId)) {
        toolCalls.push({
          callId,
          name: 'web_search',
          label: state.label,
          summary: state.completed ? '已完成实时 Web 搜索' : '实时 Web 搜索已结束',
        });
      }
    }
    const output = {
      version: 2,
      title: deriveTitle(normalizedQuestion, answer),
      markdown: answer,
      charts,
      sources,
    };

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
      freshness: await getFreshness(),
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
