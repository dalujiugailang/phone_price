import React, { useEffect, useRef, useState } from 'react';
import { PriceChainDiagram } from './PriceChainDiagram';

export interface DiagnosticTarget {
  model: string; storage: string; ppv?: string; grade?: string; date?: string;
  riskPriceDate?: string; riskBiPrice?: number | null; retailFinalPrice?: number | null;
}
export interface DiagnosticRow extends DiagnosticTarget {
  inputPpv?: string | null;
  asOf: string; variant: string | null; status: 'matched' | 'partial' | 'unmatched'; reason: string;
  availableVariants: string[]; scope: string; windowDays?: number; windowFrom?: string;
  selectionMethod: string; selectedVolume: number | null; selectionDays: number | null;
  metrics: { id: string; label: string; value: number | null; points: number; dates: string[]; basis: string; source?: string }[];
  diagnoses: { title: string; verdict: string; difference?: number; owner: string; evidence: string }[];
  warnings: string[]; coefficient?: number | null; strategyName?: string | null; strategyType?: string | null;
  mix?: { days: number; shareC: number | null; mode: string };
  turnoverDays?: number | null; purchaseSalesRatio3d?: number | null;
  inventory?: { latest: number | null; average: number | null; difference: number | null; points: number; verdict: string };
  dailyPrice?: { status: string; ppv: string | null; dataDate: string | null; receivedAt: string | null;
    biPrice: number | null; basePrice: number | null; finalQuote: number | null };
  competition?: { id: string; label: string; ourLabel: string; rivalLabel: string;
    our: { value: number | null; date: string | null }; rival: { value: number | null; date: string | null };
    difference: number | null; pressure: boolean | null; coupon: number | null }[];
}
interface DiagnosticResult {
  sample: boolean; sourceUrl: string; exportedAt: string; sourceDate: string; method: string; rows: DiagnosticRow[];
  dailyPrice?: { status: string; dataDate: string | null; receivedAt: string | null; error: string | null };
}
const money = (n: number | null) => n == null ? '暂无数据' : `¥${n.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;
function feedback(result: DiagnosticResult) {
  return [result.sample ? '价格链真实样例（非当前高风险SKU）' : '高风险SKU价格链排查',
    `快照截至：${result.sourceDate}；抓取时间：${result.exportedAt}`, `数据源：${result.sourceUrl}`, result.method,
    result.dailyPrice ? `Daily Price直接查询：${result.dailyPrice.dataDate ?? '未获取'}；状态${result.dailyPrice.status}；${result.dailyPrice.error ?? ''}` : '',
    ...result.rows.flatMap(row => ['', `${row.model} / ${row.storage} / ${row.grade ?? '未匹配'} / 基准日${row.asOf}`,
      `选取规则：${row.selectionMethod}${row.selectedVolume == null ? '' : `；近${row.selectionDays}天成交${row.selectedVolume}台`}`,
      row.inputPpv ? `风险PPV：${row.inputPpv}` : '',
      row.riskPriceDate ? `风险价格日期：${row.riskPriceDate}；风险BI出货价：${money(row.riskBiPrice ?? null)}；国补后价：${money(row.retailFinalPrice ?? null)}` : '',
      `匹配：${row.variant ?? '未匹配'}；${row.reason}`,
      row.dailyPrice ? `Daily Price完整PPV：${row.dailyPrice.ppv ?? '未匹配'}；数据日期：${row.dailyPrice.dataDate ?? '无'}；实际请求时间：${row.dailyPrice.receivedAt ?? '无'}` : '',
      ...row.metrics.map(m => `${m.label}：${money(m.value)}；${m.source ?? ''}；${m.basis}；${m.dates.join('/')}；有效${m.points}日`),
      ...row.diagnoses.map(d => `${d.title}：${d.verdict}。${d.evidence}。建议反馈环节：${d.owner}`),
      row.strategyName ? `策略：${row.strategyType ?? ''} / ${row.strategyName}` : '',
      row.inventory ? `库存水位：${row.inventory.latest ?? '缺失'}台；近7天均值${row.inventory.average?.toFixed(1) ?? '缺失'}台；${row.inventory.verdict}` : '',
      ...(row.competition ?? []).map(c => `${c.label}：我方${money(c.our.value)}（${c.our.date ?? '无记录'}） vs 友商${money(c.rival.value)}（${c.rival.date ?? '无记录'}）；${c.pressure == null ? '数据不足' : c.pressure ? '有竞争压力' : '无竞争压力'}`),
      ...row.warnings.map(w => `待核对：${w}`),
      ...(row.status === 'unmatched' ? [`同规格源变体：${row.availableVariants.join('、') || '无'}`] : []), row.scope])].filter(Boolean).join('\n');
}

export function RiskPriceDiagnosticsPanel({ targets }: { targets: DiagnosticTarget[] }) {
  const [result, setResult] = useState<DiagnosticResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [selected, setSelected] = useState(0);
  const sequence = useRef(0);
  const signature = JSON.stringify(targets);
  useEffect(() => {
    sequence.current++; setResult(null); setLoading(false); setMessage('');
    if (targets.length > 0) void load(false);
  }, [signature]);
  async function load(samples: boolean) {
    const request = ++sequence.current;
    setLoading(true); setMessage(''); setResult(null);
    try {
      const response = await fetch('/api/risk-price-diagnostics', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(samples ? { samples: true } : { targets: targets.slice(0, 20) }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || '价格链读取失败');
      if (request === sequence.current) {
        setResult(data);
        const counts = data.rows.map((r: DiagnosticRow) => r.metrics.filter(m => m.value != null).length);
        setSelected(Math.max(0, counts.indexOf(Math.max(...counts))));
      }
    } catch (error) {
      if (request === sequence.current) setMessage(error instanceof Error ? error.message : '价格链读取失败');
    } finally { if (request === sequence.current) setLoading(false); }
  }
  async function copy() {
    if (!result) return;
    try { await navigator.clipboard.writeText(feedback(result)); setMessage('已复制反馈材料，可粘贴给对应维护同事。'); }
    catch { setMessage('剪贴板不可用，请下载反馈材料。'); }
  }
  function download() {
    if (!result) return;
    const url = URL.createObjectURL(new Blob([feedback(result)], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url;
    a.download = `${result.sample ? '真实样例' : '高风险SKU'}价格链反馈_${result.sourceDate}.txt`; a.click();
    URL.revokeObjectURL(url);
  }
  return <section className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm" aria-label="高风险价格链诊断试用">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h2 className="text-lg font-bold text-gray-900">高风险价格链诊断 <span className="ml-2 text-xs font-medium text-orange-700">试用</span></h2>
        <p className="mt-1 text-sm text-gray-500">从 Daily Price 直接查询 BI出货价、BI基准价、最终报价，结合历史成交链定位问题。</p>
        <p className="mt-1 text-xs text-gray-500">同型号同规格选近7天成交最多的PPV，无成交再看近30天；展示实际等级，不限S。</p>
        <p className="mt-1 text-xs text-gray-500">诊断针对所选成交变体，用于排查；原风险仍按S等级BI出货价判断。</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={loading || targets.length === 0} onClick={() => load(false)} className="rounded-lg bg-orange-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{loading ? '读取中…' : `拉取高风险诊断（${Math.min(targets.length, 20)}）`}</button>
        <button type="button" disabled={loading} onClick={() => load(true)} className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium disabled:opacity-50">查看真实样例</button>
        {result && <><button type="button" onClick={copy} className="rounded-lg border border-gray-200 px-3 py-2 text-sm">复制反馈材料</button><button type="button" onClick={download} className="rounded-lg border border-gray-200 px-3 py-2 text-sm">下载反馈材料</button></>}
      </div>
    </div>
    {targets.length > 20 && <p className="mt-3 text-sm text-amber-700">本次先诊断价差排序前20条高风险SKU。</p>}
    {message && <p role="status" className="mt-3 text-sm text-orange-800">{message}</p>}
    {result && <div className="mt-5 space-y-4">
      <div className="rounded-lg bg-slate-50 px-4 py-3 text-xs leading-6 text-slate-600">
        <p className={result.dailyPrice?.status === 'ok' ? 'font-semibold text-emerald-700' : 'font-semibold text-red-700'}>Daily Price：{result.dailyPrice?.status === 'ok' ? `已直接查询 · 数据日期 ${result.dailyPrice.dataDate} · 请求于 ${result.dailyPrice.receivedAt ? new Date(result.dailyPrice.receivedAt).toLocaleString('zh-CN', { hour12: false }) : '—'}` : result.dailyPrice?.error ?? '未接通'}</p>
        <p>{result.sample ? '独立真实样例。' : '当前高风险SKU诊断。'}历史成交快照截至 {result.sourceDate}，抓取于 {new Date(result.exportedAt).toLocaleString('zh-CN', { hour12: false })}。</p>
        <p>{result.method}</p>
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="选择诊断型号规格">{result.rows.map((row, i) => <button key={`${row.model}-${row.storage}-${i}`} type="button" aria-pressed={selected === i} onClick={() => setSelected(i)} className={`rounded-lg border px-3 py-2 text-sm ${selected === i ? 'border-orange-500 bg-orange-50 font-semibold text-orange-800' : 'border-gray-200 text-gray-600'}`}>{row.model} · {row.storage} · {row.grade ?? '未匹配'}</button>)}</div>
      {result.rows[selected] && (result.rows[selected].status === 'unmatched' ? <div className="rounded-lg border border-amber-200 p-5 text-sm text-amber-800">{result.rows[selected].reason}<p className="mt-2 break-words">同规格源变体：{result.rows[selected].availableVariants.join('、') || '无'}</p></div> : <div style={{ overflowX: 'auto' }}><PriceChainDiagram row={result.rows[selected]} /></div>)}
    </div>}
  </section>;
}
