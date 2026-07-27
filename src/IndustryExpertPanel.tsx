import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertCircle,
  Bot,
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock3,
  Database,
  FileOutput,
  Loader2,
  MessageSquareText,
  PanelLeft,
  Plus,
  Send,
  ShieldAlert,
  Sparkles,
  TrendingUp,
  User,
  Wrench,
  X,
} from 'lucide-react';

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

interface ExpertFact {
  label: string;
  value: string;
  dataDate: string;
  source: string;
}

interface ExpertAction {
  priority: '高' | '中' | '低';
  action: string;
  reason: string;
}

interface ExpertOutput {
  title: string;
  conclusion: string;
  facts: ExpertFact[];
  inferences: string[];
  actions: ExpertAction[];
  evidenceSummary: string[];
  caveats: string[];
}

interface ToolCall {
  callId?: string;
  name: string;
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
  | { type: 'tool_started'; callId: string; name: string; args?: unknown }
  | { type: 'tool_completed'; callId: string; name: string; summary: string }
  | { type: 'final'; payload: AgentResponse }
  | { type: 'error'; message: string };

const SUGGESTED_QUESTIONS = [
  '哪些SKU的防高收风险最高？给出数字和原因。',
  '按T-2近四周看，哪些新品系列销量表现较好？',
  '结合当前价格和销量，旧机应该优先关注什么方向？',
  '当前市场趋势有什么值得关注的变化？',
];

const TOOL_LABELS: Record<string, string> = {
  check_data_freshness: '检查数据新鲜度',
  get_price_summary: '分析价格与残值',
  get_sales_summary: '分析新品周销',
  get_market_trend: '读取市场趋势',
  drilldown_sku: '下钻SKU证据',
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

const OUTPUT_SECTIONS = [
  ['01', '结论', '直接回答业务问题'],
  ['02', '关键事实', '数字、日期和数据来源'],
  ['03', '分析推断', '与事实严格分开'],
  ['04', '建议动作', '优先级、动作和原因'],
  ['05', '数据与证据', '本次实际调用的工具'],
  ['06', '口径与风险', '缺失数据和适用边界'],
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
        content: message.output?.conclusion || message.content,
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
          <h3 className="font-black text-slate-900">最终输出规范</h3>
          <p className="mt-1 text-xs text-slate-500">每次回答固定遵循六段式结构</p>
        </div>
        <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100">
          <X size={16} />
        </button>
      </div>
      <div className="space-y-1 p-3">
        {OUTPUT_SECTIONS.map(([number, label, detail]) => (
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

  return (
    <div className="mb-4 overflow-hidden rounded-xl border border-slate-200 bg-slate-50/80">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <div className="flex items-center gap-2">
          {isRunning ? (
            <Loader2 className="animate-spin text-orange-600" size={15} />
          ) : (
            <Check className="text-emerald-600" size={15} />
          )}
          <span className="text-xs font-bold text-slate-700">
            {isRunning ? 'Agent 正在执行' : `已完成 ${steps.filter((step) => step.type === 'tool').length} 个工具调用`}
          </span>
        </div>
        {expanded ? <ChevronDown size={15} className="text-slate-400" /> : <ChevronRight size={15} className="text-slate-400" />}
      </button>
      {expanded ? (
        <div className="space-y-3 border-t border-slate-200 px-4 py-3">
          {steps.map((step, index) => (
            <div key={step.id} className="relative flex gap-3">
              {index < steps.length - 1 ? (
                <span className="absolute left-[7px] top-4 h-[calc(100%+8px)] w-px bg-slate-200" />
              ) : null}
              <span className="relative mt-1">
                {step.status === 'running' ? (
                  <Loader2 size={15} className="animate-spin text-orange-600" />
                ) : (
                  <span className="flex h-[15px] w-[15px] items-center justify-center rounded-full bg-emerald-100">
                    <Check size={10} className="text-emerald-700" />
                  </span>
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-bold text-slate-700">{step.label}</p>
                {step.name ? <p className="mt-0.5 font-mono text-[10px] text-slate-400">{step.name}</p> : null}
                {step.summary ? <p className="mt-1 text-xs leading-5 text-slate-500">{step.summary}</p> : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function StructuredOutput({ output, evidence = [] }: { output: ExpertOutput; evidence?: Evidence[] }) {
  return (
    <div className="space-y-5">
      <section>
        <div className="mb-2 flex items-center gap-2 text-xs font-black uppercase tracking-wider text-orange-600">
          <Circle size={7} fill="currentColor" />
          结论
        </div>
        <h3 className="text-lg font-black text-slate-900">{output.title}</h3>
        <p className="mt-2 text-sm font-medium leading-7 text-slate-700">{output.conclusion}</p>
      </section>

      {output.facts.length > 0 ? (
        <section>
          <h4 className="mb-2 text-xs font-black uppercase tracking-wider text-slate-400">关键事实</h4>
          <div className="overflow-hidden rounded-xl border border-slate-200">
            {output.facts.map((fact, index) => (
              <div
                key={`${fact.label}-${index}`}
                className="grid grid-cols-[minmax(110px,0.8fr)_minmax(120px,1fr)_minmax(100px,0.8fr)] gap-3 border-b border-slate-100 px-4 py-3 text-xs last:border-b-0"
              >
                <span className="font-bold text-slate-700">{fact.label}</span>
                <span className="font-black text-slate-900">{fact.value}</span>
                <span className="text-right text-slate-400">{fact.dataDate} · {fact.source}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {output.inferences.length > 0 ? (
        <section>
          <h4 className="mb-2 text-xs font-black uppercase tracking-wider text-slate-400">分析推断</h4>
          <div className="space-y-2">
            {output.inferences.map((item, index) => (
              <div key={`${item}-${index}`} className="flex gap-3 rounded-xl bg-violet-50/70 px-4 py-3 text-sm leading-6 text-violet-950">
                <span className="font-mono text-xs font-bold text-violet-500">{String(index + 1).padStart(2, '0')}</span>
                <span>{item}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {output.actions.length > 0 ? (
        <section>
          <h4 className="mb-2 text-xs font-black uppercase tracking-wider text-slate-400">建议动作</h4>
          <div className="space-y-2">
            {output.actions.map((item, index) => (
              <div key={`${item.action}-${index}`} className="flex items-start gap-3 rounded-xl border border-slate-200 px-4 py-3">
                <span
                  className={`mt-0.5 rounded-md px-2 py-1 text-[10px] font-black ${
                    item.priority === '高'
                      ? 'bg-rose-100 text-rose-700'
                      : item.priority === '中'
                        ? 'bg-amber-100 text-amber-700'
                        : 'bg-slate-100 text-slate-600'
                  }`}
                >
                  {item.priority}
                </span>
                <div>
                  <p className="text-sm font-bold text-slate-800">{item.action}</p>
                  <p className="mt-1 text-xs leading-5 text-slate-500">{item.reason}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {output.evidenceSummary.length > 0 || evidence.length > 0 ? (
        <section className="rounded-xl bg-slate-50 px-4 py-3">
          <h4 className="mb-2 flex items-center gap-2 text-xs font-black uppercase tracking-wider text-slate-400">
            <Database size={13} />
            数据与证据
          </h4>
          {output.evidenceSummary.map((item, index) => (
            <p key={`${item}-${index}`} className="text-xs leading-6 text-slate-600">· {item}</p>
          ))}
          {evidence.map((item) => (
            <p key={`${item.label}-${item.dataDate}`} className="text-xs leading-6 text-slate-500">
              · {item.label} · {item.dataDate || '暂无日期'} · {item.note}
            </p>
          ))}
        </section>
      ) : null}

      {output.caveats.length > 0 ? (
        <section className="rounded-xl border border-amber-200 bg-amber-50/70 px-4 py-3">
          <h4 className="mb-2 flex items-center gap-2 text-xs font-black uppercase tracking-wider text-amber-700">
            <AlertCircle size={13} />
            口径与风险
          </h4>
          {output.caveats.map((item, index) => (
            <p key={`${item}-${index}`} className="text-xs leading-6 text-amber-900">· {item}</p>
          ))}
        </section>
      ) : null}
    </div>
  );
}

export function IndustryExpertPanel() {
  const [brief, setBrief] = useState<ExpertBrief | null>(null);
  const [sessions, setSessions] = useState<ExpertSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState(createId);
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
            content: run.output.conclusion,
            output: run.output,
            toolCalls: run.toolCalls,
            evidence: run.evidence,
            steps: run.toolCalls.map((item, index) => ({
              id: item.callId || `${run.runId}-tool-${index}`,
              type: 'tool' as const,
              label: TOOL_LABELS[item.name] || item.name,
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
                  label: TOOL_LABELS[event.name] || event.name,
                  name: event.name,
                  args: event.args,
                  status: 'running',
                },
              ],
            }));
          }
          if (event.type === 'tool_completed') {
            updateAssistant(assistantMessageId, (message) => ({
              ...message,
              steps: (message.steps ?? []).map((step) =>
                step.id === event.callId ? { ...step, summary: event.summary, status: 'completed' } : step,
              ),
            }));
          }
          if (event.type === 'final') {
            updateAssistant(assistantMessageId, (message) => ({
              ...message,
              content: event.payload.answer,
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
                  {brief.configured ? '真实 Agent 已连接' : '等待 OPENAI_API_KEY'}
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
            输出规范
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
                  我会自主调用价格、周销和市场工具，并把事实、推断与建议分开输出。
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
                          ) : (
                            <div className="flex items-center gap-2 text-sm font-semibold text-slate-400">
                              <Loader2 size={15} className="animate-spin text-orange-600" />
                              正在生成结构化结论
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
                placeholder={brief.configured ? '输入消息，询问价格、销量或市场趋势…' : '输入消息（发送前需配置 OPENAI_API_KEY）'}
                className="max-h-32 min-h-[54px] w-full resize-none bg-transparent px-3 py-2 text-sm leading-6 text-slate-800 outline-none placeholder:text-slate-400 disabled:cursor-not-allowed"
              />
              <div className="flex items-center justify-between px-2 pb-1">
                <div className="flex items-center gap-2 text-[10px] font-medium text-slate-400">
                  <Wrench size={12} />
                  可调用 5 个只读工具 · Enter 发送 · Shift+Enter 换行
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
