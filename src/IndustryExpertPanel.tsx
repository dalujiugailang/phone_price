import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertCircle,
  BarChart3,
  Bot,
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  Database,
  ExternalLink,
  FileOutput,
  Globe2,
  Loader2,
  MessageSquareText,
  PanelLeft,
  Plus,
  Send,
  Search,
  ShieldAlert,
  Sparkles,
  TrendingUp,
  User,
  Wrench,
  X,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

interface ExpertFreshness {
  priceDate: string | null;
  priceSource: string;
  salesYear: number | null;
  salesWeek: string;
  marketWeek: string;
  checkedAt: string;
}

interface ExpertBrief {
  configured: boolean;
  model: string;
  freshness: ExpertFreshness;
  facts: string[];
  recommendations: string[];
  caveats: string[];
}

interface ChartSeries {
  name: string;
  values: number[];
}

interface ChartSpec {
  id: string;
  type: 'bar' | 'line' | 'pie';
  title: string;
  subtitle?: string;
  categories: string[];
  series: ChartSeries[];
  unit?: string;
}

interface WebSource {
  title: string;
  url: string;
}

interface ExpertOutput {
  version: 2;
  title: string;
  markdown: string;
  charts: ChartSpec[];
  sources: WebSource[];
}

interface ToolCall {
  callId?: string;
  name: string;
  label?: string;
  summary: string;
}

interface Evidence {
  label: string;
  source: string;
  dataDate: string | null;
  note: string;
}

interface RunStep {
  id: string;
  type: 'status' | 'tool';
  label: string;
  name?: string;
  summary?: string;
  args?: unknown;
  status: 'running' | 'completed';
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  output?: ExpertOutput;
  steps?: RunStep[];
  toolCalls?: ToolCall[];
  evidence?: Evidence[];
  failed?: boolean;
}

interface ExpertSession {
  sessionId: string;
  title: string;
  updatedAt: string;
}

interface StoredRun {
  runId: string;
  sessionId: string;
  question: string;
  output: ExpertOutput;
  toolCalls: ToolCall[];
  evidence: Evidence[];
  createdAt: string;
}

interface AgentResponse {
  sessionId: string;
  answer: string;
  output: ExpertOutput;
  toolCalls: ToolCall[];
  evidence: Evidence[];
}

type StreamEvent =
  | { type: 'status'; label: string }
  | { type: 'tool_started'; callId: string; name: string; label?: string; args?: unknown }
  | { type: 'tool_completed'; callId: string; name: string; label?: string; summary: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'final'; payload: AgentResponse }
  | { type: 'error'; message: string };

const SUGGESTED_QUESTIONS = [
  '哪些SKU的防高收风险最高？给出数字和原因。',
  '按T-2近四周看，哪些新品系列销量表现较好？',
  '结合当前价格和销量，旧机应该优先关注什么方向？',
  '搜索近期手机行业信息，结合内部数据判断换机机会，并用图表展示。',
];

const TOOL_LABELS: Record<string, string> = {
  inspect_warehouse: '读取数仓目录',
  query_new_price_trend: '查询新机价格走势',
  query_new_used_risk: '查询新旧机风险',
  query_market_sales_trend: '查询市场与新品周销',
  web_search: '搜索实时市场信息',
  create_chart: '生成图表',
};

const EXPERT_ROLES = [
  {
    id: 'general',
    name: '综合经营分析',
    description: '价格、销量与市场合并判断',
    prompt: '结合当前价格、销量和市场趋势，旧机应该优先关注什么方向？',
    icon: BrainCircuit,
    color: 'bg-violet-100 text-violet-700',
  },
  {
    id: 'price',
    name: '价格风险专家',
    description: '防高收、残值率与品牌对比',
    prompt: '哪些SKU的防高收风险最高？给出数字和原因。',
    icon: ShieldAlert,
    color: 'bg-rose-100 text-rose-700',
  },
  {
    id: 'sales',
    name: '新品销量专家',
    description: 'T-2近四周周销和系列机会',
    prompt: '按T-2近四周看，哪些新品系列销量表现较好？',
    icon: TrendingUp,
    color: 'bg-blue-100 text-blue-700',
  },
  {
    id: 'market',
    name: '市场趋势专家',
    description: '总量、品牌份额与市场事件',
    prompt: '当前市场趋势有什么值得关注的变化？',
    icon: Activity,
    color: 'bg-amber-100 text-amber-700',
  },
];

const ANSWER_PRINCIPLES = [
  ['01', '结构不固定', '由模型根据问题选择短答、要点、表格或分析'],
  ['02', '工具按需调用', '不再强制每次读取相同数据'],
  ['03', '实时市场信息', '需要近期信息时自动 Web Search，并展示来源'],
  ['04', '图表按需生成', '趋势和对比适合可视化时输出图表'],
  ['05', '事实可追溯', '内部数字标日期，网页事实带可点击引用'],
  ['06', '不确定性透明', '缺少数据时说明边界，不机械填充模板'],
];

function createId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

async function readJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.message || '数据读取失败');
  }
  return payload as T;
}

async function askAgentStream(
  request: {
    question: string;
    sessionId: string;
    history: ChatMessage[];
  },
  onEvent: (event: StreamEvent) => void,
) {
  const response = await fetch('/api/expert/ask/stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      question: request.question,
      sessionId: request.sessionId,
      history: request.history.map((message) => ({
        role: message.role,
        content: message.output?.markdown || message.content,
      })),
    }),
  });
  if (!response.ok) {
    const payload = await response.json();
    throw new Error(payload?.message || 'Agent分析失败');
  }
  if (!response.body) {
    throw new Error('Agent流式响应不可用');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) {
        onEvent(JSON.parse(line) as StreamEvent);
      }
    }
    if (done) {
      break;
    }
  }
  if (buffer.trim()) {
    onEvent(JSON.parse(buffer) as StreamEvent);
  }
}

function formatSessionTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

function OutputSpecification({ onClose }: { onClose: () => void }) {
  return (
    <div className="absolute right-5 top-14 z-30 w-[360px] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
      <div className="flex items-start justify-between border-b border-slate-100 px-5 py-4">
        <div>
          <h3 className="font-black text-slate-900">回答方式</h3>
          <p className="mt-1 text-xs text-slate-500">模型自主组织，不套固定报告模板</p>
        </div>
        <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100">
          <X size={16} />
        </button>
      </div>
      <div className="space-y-1 p-3">
        {ANSWER_PRINCIPLES.map(([number, label, detail]) => (
          <div key={number} className="flex items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-slate-50">
            <span className="font-mono text-[11px] font-bold text-orange-600">{number}</span>
            <div>
              <p className="text-sm font-bold text-slate-800">{label}</p>
              <p className="text-xs text-slate-500">{detail}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ToolTrace({ steps = [] }: { steps?: RunStep[] }) {
  const [expanded, setExpanded] = useState(true);
  if (steps.length === 0) {
    return null;
  }
  const isRunning = steps.some((step) => step.status === 'running');

  const operationCount = steps.filter((step) => step.type === 'tool').length;
  const stepIcon = (step: RunStep) => {
    if (step.name === 'web_search') {
      return <Search size={14} />;
    }
    if (step.name === 'create_chart') {
      return <BarChart3 size={14} />;
    }
    if (step.type === 'tool') {
      return <Database size={14} />;
    }
    return <BrainCircuit size={14} />;
  };

  return (
    <div className="mb-5 border-l-2 border-slate-200 pl-4">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center justify-between py-1 text-left"
      >
        <div className="flex items-center gap-2">
          {isRunning ? (
            <Loader2 className="animate-spin text-orange-600" size={15} />
          ) : (
            <Check className="text-emerald-600" size={15} />
          )}
          <span className="text-xs font-bold text-slate-700">
            {isRunning ? '正在处理' : operationCount > 0 ? `完成了 ${operationCount} 项操作` : '分析完成'}
          </span>
        </div>
        {expanded ? <ChevronDown size={15} className="text-slate-400" /> : <ChevronRight size={15} className="text-slate-400" />}
      </button>
      {expanded ? (
        <div className="mt-2 space-y-2">
          {steps.map((step, index) => (
            <div key={step.id} className="relative flex gap-3">
              {index < steps.length - 1 ? (
                <span className="absolute left-[9px] top-5 h-[calc(100%+4px)] w-px bg-slate-200" />
              ) : null}
              <span className="relative mt-0.5 flex h-5 w-5 items-center justify-center rounded-md bg-white text-slate-500 ring-1 ring-slate-200">
                {step.status === 'running' ? (
                  <Loader2 size={13} className="animate-spin text-orange-600" />
                ) : (
                  stepIcon(step)
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold leading-5 text-slate-700">{step.label}</p>
                {step.summary ? <p className="text-[11px] leading-5 text-slate-400">{step.summary}</p> : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function renderInlineMarkdown(text: string) {
  const tokens = text.split(/(\[[^\]]+\]\(https?:\/\/[^)]+\)|\*\*[^*]+\*\*)/g).filter(Boolean);
  return tokens.map((token, index) => {
    const link = token.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/);
    if (link) {
      return (
        <a
          key={`${token}-${index}`}
          href={link[2]}
          target="_blank"
          rel="noreferrer"
          className="font-semibold text-blue-700 underline decoration-blue-300 underline-offset-2 hover:text-blue-900"
        >
          {link[1]}
        </a>
      );
    }
    if (token.startsWith('**') && token.endsWith('**')) {
      return <strong key={`${token}-${index}`} className="font-black text-slate-900">{token.slice(2, -2)}</strong>;
    }
    return <React.Fragment key={`${token}-${index}`}>{token}</React.Fragment>;
  });
}

function splitMarkdownTableRow(line: string) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function isMarkdownTableDivider(line: string) {
  const cells = splitMarkdownTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function MarkdownMessage({ content }: { content: string }) {
  const lines = String(content).split('\n');
  const blocks: React.ReactNode[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const line = rawLine.trim();
    if (line.includes('|') && index + 1 < lines.length && isMarkdownTableDivider(lines[index + 1])) {
      const headers = splitMarkdownTableRow(line);
      const rows: string[][] = [];
      let rowIndex = index + 2;
      while (rowIndex < lines.length && lines[rowIndex].trim().includes('|')) {
        rows.push(splitMarkdownTableRow(lines[rowIndex]));
        rowIndex += 1;
      }
      blocks.push(
        <div key={`table-${index}`} className="my-3 overflow-x-auto rounded-xl border border-slate-200">
          <table className="min-w-full border-collapse text-left text-xs">
            <thead className="bg-slate-50">
              <tr>
                {headers.map((header, cellIndex) => (
                  <th key={`${header}-${cellIndex}`} className="whitespace-nowrap border-b border-slate-200 px-3 py-2 font-black text-slate-700">
                    {renderInlineMarkdown(header)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, tableRowIndex) => (
                <tr key={`row-${tableRowIndex}`} className="border-b border-slate-100 last:border-0">
                  {headers.map((_, cellIndex) => (
                    <td key={`cell-${tableRowIndex}-${cellIndex}`} className="whitespace-nowrap px-3 py-2 text-slate-600">
                      {renderInlineMarkdown(row[cellIndex] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      index = rowIndex - 1;
      continue;
    }
    if (!line) {
      blocks.push(<div key={`space-${index}`} className="h-1" />);
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const Tag = heading[1].length === 1 ? 'h3' : 'h4';
      blocks.push(<Tag key={`${line}-${index}`} className="pt-2 text-base font-black text-slate-900">{renderInlineMarkdown(heading[2])}</Tag>);
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      blocks.push(
        <div key={`${line}-${index}`} className="flex gap-2 pl-1">
          <span className="mt-[11px] h-1.5 w-1.5 shrink-0 rounded-full bg-slate-400" />
          <p>{renderInlineMarkdown(bullet[1])}</p>
        </div>,
      );
      continue;
    }
    const ordered = line.match(/^(\d+)[.)]\s+(.+)$/);
    if (ordered) {
      blocks.push(
        <div key={`${line}-${index}`} className="flex gap-2">
          <span className="min-w-5 font-mono text-xs font-bold text-slate-400">{ordered[1]}.</span>
          <p>{renderInlineMarkdown(ordered[2])}</p>
        </div>,
      );
      continue;
    }
    if (line.startsWith('> ')) {
      blocks.push(
        <blockquote key={`${line}-${index}`} className="border-l-2 border-slate-300 pl-3 text-slate-500">
          {renderInlineMarkdown(line.slice(2))}
        </blockquote>,
      );
      continue;
    }
    blocks.push(<p key={`${line}-${index}`} className="whitespace-pre-wrap">{renderInlineMarkdown(line)}</p>);
  }

  return (
    <div className="space-y-2 text-sm leading-7 text-slate-700">
      {blocks}
    </div>
  );
}

const CHART_COLORS = ['#f97316', '#2563eb', '#7c3aed', '#059669', '#e11d48'];

function AgentChart({ chart }: { chart: ChartSpec }) {
  const rows = chart.categories.map((category, index) => ({
    category,
    ...Object.fromEntries(chart.series.map((series) => [series.name, series.values[index]])),
  }));
  const tooltipFormatter = (value: number | string) => [`${value}${chart.unit || ''}`, ''];

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-4">
        <h4 className="text-sm font-black text-slate-900">{chart.title}</h4>
        {chart.subtitle ? <p className="mt-1 text-xs leading-5 text-slate-500">{chart.subtitle}</p> : null}
      </div>
      <div className="h-[280px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          {chart.type === 'line' ? (
            <LineChart data={rows} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="category" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} unit={chart.unit} />
              <Tooltip formatter={tooltipFormatter} />
              <Legend />
              {chart.series.map((series, index) => (
                <Line key={series.name} dataKey={series.name} stroke={CHART_COLORS[index % CHART_COLORS.length]} strokeWidth={2.5} dot={{ r: 3 }} />
              ))}
            </LineChart>
          ) : chart.type === 'pie' ? (
            <PieChart>
              <Pie
                data={rows.map((row) => ({ name: row.category, value: row[chart.series[0].name] }))}
                dataKey="value"
                nameKey="name"
                innerRadius={54}
                outerRadius={92}
                paddingAngle={2}
                label
              >
                {rows.map((row, index) => <Cell key={row.category} fill={CHART_COLORS[index % CHART_COLORS.length]} />)}
              </Pie>
              <Tooltip formatter={tooltipFormatter} />
              <Legend />
            </PieChart>
          ) : (
            <BarChart data={rows} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="category" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} unit={chart.unit} />
              <Tooltip formatter={tooltipFormatter} />
              <Legend />
              {chart.series.map((series, index) => (
                <Bar key={series.name} dataKey={series.name} fill={CHART_COLORS[index % CHART_COLORS.length]} radius={[5, 5, 0, 0]} />
              ))}
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>
    </section>
  );
}

function StructuredOutput({ output, evidence = [] }: { output: ExpertOutput; evidence?: Evidence[] }) {
  return (
    <div className="space-y-5">
      <MarkdownMessage content={output.markdown} />
      {output.charts?.map((chart) => (
        <React.Fragment key={chart.id}>
          <AgentChart chart={chart} />
        </React.Fragment>
      ))}
      {output.sources?.length > 0 ? (
        <section className="rounded-xl border border-blue-100 bg-blue-50/50 px-4 py-3">
          <h4 className="mb-2 flex items-center gap-2 text-xs font-black text-blue-900">
            <Globe2 size={14} />
            Web 来源
          </h4>
          <div className="space-y-2">
            {output.sources.map((source) => (
              <a
                key={source.url}
                href={source.url}
                target="_blank"
                rel="noreferrer"
                className="flex items-start gap-2 text-xs leading-5 text-blue-700 hover:text-blue-950"
              >
                <ExternalLink size={12} className="mt-1 shrink-0" />
                <span>{source.title}</span>
              </a>
            ))}
          </div>
        </section>
      ) : null}
      {evidence.length > 0 ? (
        <details className="rounded-xl bg-slate-50 px-4 py-3 text-xs text-slate-500">
          <summary className="cursor-pointer font-bold text-slate-600">查看内部数据证据（{evidence.length}）</summary>
          <div className="mt-2 space-y-1">
            {evidence.map((item) => (
              <p key={`${item.label}-${item.dataDate}`}>· {item.label} · {item.dataDate || '暂无日期'} · {item.note}</p>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

export function IndustryExpertPanel() {
  const [brief, setBrief] = useState<ExpertBrief | null>(null);
  const [sessions, setSessions] = useState<ExpertSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>(createId);
  const [taskTitle, setTaskTitle] = useState('新分析任务');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAsking, setIsAsking] = useState(false);
  const [showOutputSpec, setShowOutputSpec] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const messageEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      readJson<ExpertBrief>('/api/expert/brief'),
      readJson<{ sessions: ExpertSession[] }>('/api/expert/sessions'),
    ])
      .then(([briefPayload, sessionPayload]) => {
        if (!cancelled) {
          setBrief(briefPayload);
          setSessions(sessionPayload.sessions);
          setError(null);
        }
      })
      .catch((loadError) => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : '行业专家加载失败');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, isAsking]);

  const freshnessSummary = useMemo(() => {
    if (!brief) {
      return '';
    }
    return `价格 ${brief.freshness.priceDate || '--'} · 周销 ${brief.freshness.salesYear || ''}${brief.freshness.salesWeek || '--'} · 市场 ${brief.freshness.marketWeek || '--'}`;
  }, [brief]);

  const startTask = (title = '新分析任务', prompt = '') => {
    setActiveSessionId(createId());
    setTaskTitle(title);
    setMessages([]);
    setInput(prompt);
    setError(null);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const loadSession = async (session: ExpertSession) => {
    if (isAsking) {
      return;
    }
    setActiveSessionId(session.sessionId);
    setTaskTitle(session.title);
    setError(null);
    try {
      const payload = await readJson<{ runs: StoredRun[] }>(
        `/api/expert/sessions/${encodeURIComponent(session.sessionId)}`,
      );
      setMessages(
        payload.runs.flatMap((run) => [
          { id: `${run.runId}-user`, role: 'user' as const, content: run.question },
          {
            id: `${run.runId}-assistant`,
            role: 'assistant' as const,
            content: run.output.markdown,
            output: run.output,
            toolCalls: run.toolCalls,
            evidence: run.evidence,
            steps: run.toolCalls.map((item, index) => ({
              id: item.callId || `${run.runId}-tool-${index}`,
              type: 'tool' as const,
              label: item.label || TOOL_LABELS[item.name] || item.name,
              name: item.name,
              summary: item.summary,
              status: 'completed' as const,
            })),
          },
        ]),
      );
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '任务记录读取失败');
    }
  };

  const updateAssistant = (messageId: string, updater: (message: ChatMessage) => ChatMessage) => {
    setMessages((current) => current.map((message) => (message.id === messageId ? updater(message) : message)));
  };

  const submitQuestion = async (suggestedQuestion?: string) => {
    const question = String(suggestedQuestion ?? input).trim();
    if (!question || isAsking) {
      return;
    }

    const userMessage: ChatMessage = { id: createId(), role: 'user', content: question };
    const assistantMessageId = createId();
    const history = messages;
    setMessages((current) => [
      ...current,
      userMessage,
      {
        id: assistantMessageId,
        role: 'assistant',
        content: '',
        steps: [
          {
            id: createId(),
            type: 'status',
            label: '正在提交给 3C 行业专家',
            status: 'running',
          },
        ],
      },
    ]);
    setInput('');
    setError(null);
    setIsAsking(true);

    try {
      await askAgentStream(
        { question, sessionId: activeSessionId, history },
        (event) => {
          if (event.type === 'status') {
            updateAssistant(assistantMessageId, (message) => ({
              ...message,
              steps: [
                ...(message.steps ?? []).map((step) =>
                  step.type === 'status' ? { ...step, status: 'completed' as const } : step,
                ),
                { id: createId(), type: 'status', label: event.label, status: 'running' },
              ],
            }));
          }
          if (event.type === 'tool_started') {
            updateAssistant(assistantMessageId, (message) => ({
              ...message,
              steps: [
                ...(message.steps ?? []).map((step) =>
                  step.status === 'running' ? { ...step, status: 'completed' as const } : step,
                ),
                {
                  id: event.callId,
                  type: 'tool',
                  label: event.label || TOOL_LABELS[event.name] || event.name,
                  name: event.name,
                  args: event.args,
                  status: 'running',
                },
              ],
            }));
          }
          if (event.type === 'tool_completed') {
            updateAssistant(assistantMessageId, (message) => {
              const steps = message.steps ?? [];
              const exists = steps.some((step) => step.id === event.callId);
              return {
                ...message,
                steps: exists
                  ? steps.map((step) =>
                      step.id === event.callId
                        ? {
                            ...step,
                            label: event.label || step.label,
                            summary: event.summary,
                            status: 'completed' as const,
                          }
                        : step,
                    )
                  : [
                      ...steps.map((step) =>
                        step.status === 'running' ? { ...step, status: 'completed' as const } : step,
                      ),
                      {
                        id: event.callId,
                        type: 'tool' as const,
                        label: event.label || TOOL_LABELS[event.name] || event.name,
                        name: event.name,
                        summary: event.summary,
                        status: 'completed' as const,
                      },
                    ],
              };
            });
          }
          if (event.type === 'text_delta') {
            updateAssistant(assistantMessageId, (message) => ({
              ...message,
              content: `${message.content}${event.delta}`,
            }));
          }
          if (event.type === 'final') {
            updateAssistant(assistantMessageId, (message) => ({
              ...message,
              content: event.payload.output.markdown,
              output: event.payload.output,
              toolCalls: event.payload.toolCalls,
              evidence: event.payload.evidence,
              steps: (message.steps ?? []).map((step) => ({ ...step, status: 'completed' })),
            }));
            setTaskTitle((current) => (current === '新分析任务' ? event.payload.output.title : current));
          }
          if (event.type === 'error') {
            throw new Error(event.message);
          }
        },
      );
      const sessionsPayload = await readJson<{ sessions: ExpertSession[] }>('/api/expert/sessions');
      setSessions(sessionsPayload.sessions);
    } catch (askError) {
      const message = askError instanceof Error ? askError.message : 'Agent分析失败';
      updateAssistant(assistantMessageId, (current) => ({
        ...current,
        content: message,
        failed: true,
        steps: (current.steps ?? []).map((step) => ({ ...step, status: 'completed' })),
      }));
      setError(message);
    } finally {
      setIsAsking(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex min-h-[640px] items-center justify-center rounded-2xl border border-slate-200 bg-white">
        <div className="flex items-center gap-3 text-sm font-semibold text-slate-500">
          <Loader2 className="animate-spin text-orange-600" size={20} />
          正在打开 3C 行业专家工作台
        </div>
      </div>
    );
  }

  if (!brief) {
    return (
      <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-sm font-semibold text-red-700">
        {error || '行业专家暂不可用'}
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-164px)] min-h-[650px] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      {sidebarOpen ? (
        <aside className="flex w-[292px] shrink-0 flex-col border-r border-slate-200 bg-slate-50/80">
          <div className="border-b border-slate-200 p-4">
            <div className="mb-4 flex items-center gap-3 px-1">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-slate-950 text-white">
                <Bot size={19} />
              </div>
              <div className="min-w-0">
                <h2 className="truncate text-sm font-black text-slate-900">3C 行业专家</h2>
                <p className="mt-0.5 truncate text-[11px] text-slate-500">OpenAI Agents SDK</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => startTask()}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-slate-950 px-3 py-2.5 text-xs font-bold text-white transition hover:bg-slate-800"
            >
              <Plus size={15} />
              新建分析任务
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-3">
            <p className="mb-2 px-2 text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">专家角色</p>
            <div className="space-y-1">
              {EXPERT_ROLES.map((role) => {
                const Icon = role.icon;
                return (
                  <button
                    key={role.id}
                    type="button"
                    onClick={() => startTask(role.name, role.prompt)}
                    className="group flex w-full items-start gap-3 rounded-xl px-2.5 py-2.5 text-left transition hover:bg-white hover:shadow-sm"
                  >
                    <span className={`mt-0.5 rounded-lg p-2 ${role.color}`}>
                      <Icon size={15} />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-xs font-bold text-slate-700 group-hover:text-slate-950">{role.name}</span>
                      <span className="mt-0.5 block truncate text-[10px] text-slate-400">{role.description}</span>
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="mb-2 mt-5 flex items-center justify-between px-2">
              <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">最近任务</p>
              <Clock3 size={12} className="text-slate-300" />
            </div>
            <div className="space-y-1">
              {sessions.length === 0 ? (
                <p className="rounded-xl px-3 py-4 text-center text-[11px] leading-5 text-slate-400">完成一次分析后，任务会保存在这里</p>
              ) : (
                sessions.map((session) => (
                  <button
                    key={session.sessionId}
                    type="button"
                    onClick={() => loadSession(session)}
                    className={`flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left transition ${
                      activeSessionId === session.sessionId ? 'bg-white shadow-sm ring-1 ring-slate-200' : 'hover:bg-white'
                    }`}
                  >
                    <MessageSquareText size={14} className="shrink-0 text-slate-400" />
                    <span className="min-w-0 flex-1 truncate text-xs font-semibold text-slate-600">{session.title}</span>
                    <span className="text-[10px] text-slate-300">{formatSessionTime(session.updatedAt)}</span>
                  </button>
                ))
              )}
            </div>
          </div>

          <div className="border-t border-slate-200 p-3">
            <div className={`rounded-xl px-3 py-2.5 ${brief.configured ? 'bg-emerald-50' : 'bg-amber-50'}`}>
              <div className="flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${brief.configured ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                <span className={`text-[11px] font-bold ${brief.configured ? 'text-emerald-800' : 'text-amber-800'}`}>
                  {brief.configured ? 'Agent + 实时搜索已连接' : '等待 OPENAI_API_KEY'}
                </span>
              </div>
              <p className="mt-1 truncate pl-4 text-[10px] text-slate-500">{brief.model}</p>
            </div>
          </div>
        </aside>
      ) : null}

      <main className="relative flex min-w-0 flex-1 flex-col bg-white">
        <header className="flex h-[58px] shrink-0 items-center justify-between border-b border-slate-200 px-5">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={() => setSidebarOpen((value) => !value)}
              className="rounded-lg p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
              title={sidebarOpen ? '收起任务栏' : '展开任务栏'}
            >
              <PanelLeft size={17} />
            </button>
            <div className="min-w-0">
              <h2 className="truncate text-sm font-black text-slate-900">{taskTitle}</h2>
              <p className="mt-0.5 truncate text-[10px] text-slate-400">{freshnessSummary}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setShowOutputSpec((value) => !value)}
            className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 transition hover:bg-slate-50"
          >
            <FileOutput size={14} />
            回答方式
          </button>
          {showOutputSpec ? <OutputSpecification onClose={() => setShowOutputSpec(false)} /> : null}
        </header>

        <div className="flex-1 overflow-y-auto bg-white">
          <div className="mx-auto w-full max-w-[900px] px-6 py-8">
            {messages.length === 0 ? (
              <div className="flex min-h-[430px] flex-col items-center justify-center text-center">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-950 text-white shadow-lg">
                  <Sparkles size={25} />
                </div>
                <h3 className="mt-5 text-xl font-black text-slate-900">今天想判断什么？</h3>
                <p className="mt-2 max-w-lg text-sm leading-6 text-slate-500">
                  模型会按问题自主读取内部数据、搜索实时市场信息，并在适合时生成图表。
                </p>
                <div className="mt-7 grid w-full max-w-2xl grid-cols-1 gap-2 sm:grid-cols-2">
                  {SUGGESTED_QUESTIONS.map((question) => (
                    <button
                      key={question}
                      type="button"
                      onClick={() => submitQuestion(question)}
                      className="rounded-xl border border-slate-200 px-4 py-3 text-left text-xs font-semibold leading-5 text-slate-600 transition hover:border-orange-300 hover:bg-orange-50/50 hover:text-orange-900"
                    >
                      {question}
                    </button>
                  ))}
                </div>
                {!brief.configured ? (
                  <div className="mt-5 flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
                    <AlertCircle size={14} />
                    界面已就绪；配置 OPENAI_API_KEY 后可收到真实 AI 回复
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="space-y-8">
                {messages.map((message) => (
                  <div key={message.id} className="flex items-start gap-4">
                    <div
                      className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                        message.role === 'user' ? 'bg-slate-100 text-slate-600' : 'bg-slate-950 text-white'
                      }`}
                    >
                      {message.role === 'user' ? <User size={16} /> : <Bot size={16} />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="mb-2 flex items-center gap-2">
                        <span className="text-xs font-black text-slate-800">
                          {message.role === 'user' ? '你' : '3C 行业专家'}
                        </span>
                        {message.role === 'assistant' && message.steps?.some((step) => step.status === 'running') ? (
                          <span className="text-[10px] font-semibold text-orange-600">运行中</span>
                        ) : null}
                      </div>
                      {message.role === 'user' ? (
                        <p className="whitespace-pre-wrap text-sm font-medium leading-7 text-slate-700">{message.content}</p>
                      ) : (
                        <div>
                          <ToolTrace steps={message.steps} />
                          {message.output ? (
                            <StructuredOutput output={message.output} evidence={message.evidence} />
                          ) : message.failed ? (
                            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
                              {message.content}
                            </div>
                          ) : message.content ? (
                            <div>
                              <MarkdownMessage content={message.content} />
                              <div className="mt-3 flex items-center gap-2 text-xs font-semibold text-slate-400">
                                <Loader2 size={13} className="animate-spin text-orange-600" />
                                正在继续生成
                              </div>
                            </div>
                          ) : (
                            <div className="flex items-center gap-2 text-sm font-semibold text-slate-400">
                              <Loader2 size={15} className="animate-spin text-orange-600" />
                              正在思考并选择工具
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                <div ref={messageEndRef} />
              </div>
            )}
          </div>
        </div>

        <div className="shrink-0 border-t border-slate-100 bg-white px-5 pb-4 pt-3">
          <form
            className="mx-auto max-w-[900px]"
            onSubmit={(event) => {
              event.preventDefault();
              submitQuestion();
            }}
          >
            <div className="rounded-2xl border border-slate-300 bg-white p-2 shadow-[0_8px_30px_rgba(15,23,42,0.08)] transition focus-within:border-slate-500">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    submitQuestion();
                  }
                }}
                disabled={isAsking}
                rows={2}
                placeholder={brief.configured ? '输入消息，询问价格、销量、市场趋势或实时行业信息…' : '输入消息（发送前需配置 OPENAI_API_KEY）'}
                className="max-h-32 min-h-[54px] w-full resize-none bg-transparent px-3 py-2 text-sm leading-6 text-slate-800 outline-none placeholder:text-slate-400 disabled:cursor-not-allowed"
              />
              <div className="flex items-center justify-between px-2 pb-1">
                <div className="flex items-center gap-2 text-[10px] font-medium text-slate-400">
                  <Wrench size={12} />
                  4 个数仓工具 · 实时 Web Search · 图表输出
                </div>
                <button
                  type="submit"
                  disabled={isAsking || !input.trim()}
                  className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-950 text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-200"
                  title="发送"
                >
                  {isAsking ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
                </button>
              </div>
            </div>
          </form>
          {error && messages.length === 0 ? (
            <p className="mx-auto mt-2 max-w-[900px] text-xs font-semibold text-red-600">{error}</p>
          ) : null}
        </div>
      </main>
    </div>
  );
}
