import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { TrendingUp, ExternalLink } from 'lucide-react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { rankVolatility, type VolatilitySKU } from './skuVolatility';
import './sku-volatility.css';
import { Pagination, usePagedRows } from './Pagination';

const money = (value?: number) => value === undefined ? '--' : `¥${value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;
const signed = (value: number | null, suffix = '') => value === null ? '--' : `${value > 0 ? '+' : ''}${suffix === '%' ? value.toFixed(1) : value.toLocaleString('zh-CN', { maximumFractionDigits: 2, useGrouping: false })}${suffix}`;
const tone = (value: number | null) => value === null || value === 0 ? 'is-flat' : value > 0 ? 'is-up' : 'is-down';

export function SkuVolatilityRanking({ skus, dates }: { skus: VolatilitySKU[]; dates: string[] }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [direction, setDirection] = useState('all');
  const [sort, setSort] = useState('percent');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [productLinks, setProductLinks] = useState<Record<string, string>>({});
  const [linkStatus, setLinkStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const frameIndex = Math.max(0, dates.length - 1);
  const date = dates[frameIndex];
  const previousDate = dates[frameIndex - 1];
  const barWidths = useRef<Record<string, number>>({});
  const [animatedWidths, setAnimatedWidths] = useState<Record<string, number>>({});
  const ranking = useMemo(() => rankVolatility(skus, date, previousDate), [skus, date, previousDate]);
  const top = ranking.filter(row => row.comparable).slice(0, 5);
  const sortedRanking = useMemo(() => [...ranking].sort((a, b) => Number(b.comparable) - Number(a.comparable)
    || Math.abs(sort === 'amount' ? b.amount ?? 0 : b.percent ?? 0) - Math.abs(sort === 'amount' ? a.amount ?? 0 : a.percent ?? 0)
    || Math.abs(sort === 'percent' ? b.amount ?? 0 : b.percent ?? 0) - Math.abs(sort === 'percent' ? a.amount ?? 0 : a.percent ?? 0)
    || a.id.localeCompare(b.id)), [ranking, sort]);
  const filtered = useMemo(() => sortedRanking.filter(row => {
    const text = `${row.brand} ${row.model} ${row.storage}`.toLowerCase();
    return text.includes(deferredQuery.trim().toLowerCase()) && (direction === 'all'
      || (direction === 'up' && (row.percent ?? 0) > 0)
      || (direction === 'down' && (row.percent ?? 0) < 0)
      || (direction === 'flat' && row.percent === 0)
      || (direction === 'missing' && !row.comparable));
  }), [sortedRanking, deferredQuery, direction]);

  const rankById = useMemo(() => new Map(sortedRanking.map((row, index) => [row.id, index + 1])), [sortedRanking]);
  const page = usePagedRows(filtered, 50, `${direction}|${sort}|${deferredQuery}`);
  const toggleHistory = useCallback((id: string) => setExpanded(current => current === id ? null : id), []);

  const openDetails = (source: HTMLButtonElement, skuId: string | null = null) => {
    trigger.current = source;
    setQuery('');
    setDirection('all');
    setSort('percent');
    page.setPage(0);
    setExpanded(skuId);
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => {
      const container = dialog.current?.querySelector('.sku-race-table-wrap');
      const row = [...(dialog.current?.querySelectorAll<HTMLTableRowElement>('tr[data-sku-id]') ?? [])].find(item => item.dataset.skuId === expanded);
      if (container) {
        const headerHeight = container.querySelector('thead')?.getBoundingClientRect().height ?? 0;
        container.scrollTo({ top: row ? container.scrollTop + row.getBoundingClientRect().top - container.getBoundingClientRect().top - headerHeight : 0 });
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [open, expanded, page.page]);

  useEffect(() => {
    if (!open || !date) return;
    const controller = new AbortController();
    setLinkStatus('loading');
    setProductLinks({});
    // The dataset uses short labels for its 2026 migration history, and ISO labels thereafter.
    const isoDate = date.includes('-') ? date : `2026-${date.split('.')[0].padStart(2, '0')}-${date.split('.')[1].padStart(2, '0')}`;
    fetch(`/api/workbench/product-links?date=${encodeURIComponent(isoDate)}`, { signal: controller.signal, credentials: 'same-origin' })
      .then(async response => {
        if (!response.ok) throw new Error('商品链接加载失败');
        const payload: { rows: Array<{ id: string; productLink?: string }> } = await response.json();
        const links = Object.fromEntries(payload.rows.map(row => [row.id, safeProductLink(row.productLink)]));
        if (!controller.signal.aborted) { setProductLinks(links); setLinkStatus('ready'); }
      })
      .catch(() => { if (!controller.signal.aborted) setLinkStatus('error'); });
    return () => controller.abort();
  }, [open, date]);
  useEffect(() => {
    const rows = ranking.filter(row => row.comparable).slice(0, 5);
    const maximum = Math.max(1, ...rows.map(row => Math.abs(row.percent ?? 0)));
    const targets = Object.fromEntries(rows.map(row => [row.id, Math.abs(row.percent ?? 0) / maximum * 28]));
    const from = { ...barWidths.current };
    let raf = 0;
    let start: number | undefined;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      barWidths.current = targets;
      setAnimatedWidths(targets);
      return;
    }
    const tick = (time: number) => {
      start ??= time;
      const fraction = Math.min(1, (time - start) / 850);
      const eased = 1 - (1 - fraction) ** 3;
      const widths = Object.fromEntries(Object.entries(targets).map(([id, target]) => [id, (from[id] ?? 0) + (target - (from[id] ?? 0)) * eased]));
      barWidths.current = widths;
      setAnimatedWidths(widths);
      if (fraction < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [ranking]);
  useEffect(() => {
    if (!open) return;
    const element = dialog.current;
    element?.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { element?.close(); document.body.style.overflow = overflow; trigger.current?.focus(); };
  }, [open]);

  return <section className="sku-race-card" aria-label="SKU 波动排行榜">
    <div className="sku-race-heading"><h2><TrendingUp size={20} aria-hidden="true" />SKU 波动排行榜 <span>TOP 5</span></h2><span className="sku-race-live">最新</span></div>
    <div className="sku-race-meta"><span>{previousDate ?? '--'} → {date ?? '--'}</span><span>按 |涨跌幅| 降序</span></div>
    <div className="sku-race-chart">
      <div className="sku-race-rows">
        {top.map((row, index) => {
          const width = Math.min(28, Math.max(0, Math.round(animatedWidths[row.id] ?? 0)));
          return <button key={row.id} type="button" className={`sku-race-row ${tone(row.percent)}`} style={{ transform: `translateY(${index * 62}px)` }} aria-label={`查看 ${row.model} ${row.storage} 的历史价格`} onClick={event => openDetails(event.currentTarget, row.id)}>
            <span className="sku-race-row-title"><span className="sku-race-rank">{String(index + 1).padStart(2, '0')}</span><span className="sku-race-name" title={`${row.model} · ${row.storage}`}>{row.model}</span><strong>{signed(row.percent, '%')}</strong></span>
            <span className="sku-race-row-bottom"><span className="sku-race-storage">{row.storage} · {signed(row.amount)}元</span><span className="sku-race-bar" aria-hidden="true">{'█'.repeat(width)}<span className="sku-race-bar-track">{'░'.repeat(28-width)}</span></span></span>
          </button>;
        })}
        {!top.length && <span className="sku-race-empty">暂无相邻日期可比报价</span>}
      </div>
      <button type="button" className="sku-race-footer" onClick={event => openDetails(event.currentTarget)} aria-label="查看全部 SKU 波动详情">查看全部 {skus.length} 个 SKU <span aria-hidden="true">查看明细 →</span></button>
    </div>
    <dialog ref={dialog} className="sku-race-dialog" onCancel={() => setOpen(false)} onClose={() => setOpen(false)}>
      {open && <><header><div><span className="sku-race-eyebrow">[ FULL RANKING ]</span><h2>全部 SKU 波动详情</h2><p>{previousDate ?? '--'} → {date ?? '--'} · 按波动绝对值降序 · 缺价沿用最近正式报价；无可比基准时标记不可比</p></div><button type="button" onClick={() => setOpen(false)} aria-label="关闭 SKU 波动详情">✕</button></header>
        <div className="sku-race-filters"><input aria-label="搜索 SKU 波动" placeholder="搜索品牌、型号、容量" value={query} onChange={event => setQuery(event.target.value)} /><select aria-label="波动方向" value={direction} onChange={event => setDirection(event.target.value)}><option value="all">全部方向</option><option value="up">上涨</option><option value="down">下跌</option><option value="flat">持平</option><option value="missing">不可比</option></select><select aria-label="波动排序" value={sort} onChange={event => setSort(event.target.value)}><option value="percent">按涨跌幅绝对值</option><option value="amount">按金额绝对值</option></select><span>{filtered.length} / {skus.length} 个 SKU</span></div>
        <div className="sku-race-table-wrap"><table><thead><tr><th>排名</th><th>品牌 / 型号 / 容量</th><th>{previousDate ?? '--'} 到手价</th><th>{date ?? '--'} 到手价</th><th>涨跌幅</th><th>变动金额</th><th>归因 / 状态</th><th>商品链接</th><th>历史</th></tr></thead><tbody>{page.rows.map(row => <SkuRow key={row.id} row={row} rank={rankById.get(row.id) ?? 0} date={date} productLink={productLinks[row.id]} linkStatus={linkStatus} expanded={expanded === row.id} onToggle={toggleHistory} />)}{!filtered.length && <tr><td colSpan={9} className="sku-race-no-results">没有符合条件的 SKU</td></tr>}</tbody></table></div>
        <Pagination control={page} label="SKU 波动" />
      </>}
    </dialog>
  </section>;
}

function safeProductLink(value?: string) {
  if (!value) return '';
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

const SkuRow = memo(function SkuRow({ row, rank, expanded, onToggle, productLink, linkStatus, date }: {
  row: ReturnType<typeof rankVolatility>[number]; rank: number; expanded: boolean; onToggle: (id: string) => void;
  date: string; productLink?: string; linkStatus: 'loading' | 'ready' | 'error';
}) {
  return <>
    <tr data-sku-id={row.id}>
      <td>{row.comparable ? String(rank).padStart(2, '0') : '--'}</td>
      <td><a className="sku-race-edit-link" href={`/?${new URLSearchParams({view:'raw',tab:'daily',date:date.includes('-')?date:`2026-${date.split('.')[0].padStart(2,'0')}-${date.split('.')[1].padStart(2,'0')}`,sku:row.id,search:row.model})}`} title="前往对应日期的每日采价，修改后可由管理员推数仓"><strong>{row.model}</strong><small>{row.brand} · {row.storage}</small></a></td>
      <td>{money(row.previous?.finalPrice)}</td><td>{money(row.current?.finalPrice)}</td>
      <td className={tone(row.percent)}>{signed(row.percent, '%')}</td>
      <td className={tone(row.amount)}>{signed(row.amount)}{row.amount === null ? '' : '元'}</td>
      <td>{row.comparable ? row.reasonDetails.join('、') || (row.amount === 0 ? '持平' : '价格变动') : !row.current ? '当日无生效报价' : '无相邻日期可比报价'}</td>
      <td>{productLink ? <a className="sku-race-product-link" href={productLink} target="_blank" rel="noopener noreferrer" title={productLink}>查看商品<ExternalLink size={12} aria-hidden="true" /></a> : <span className="sku-race-link-status">{linkStatus === 'loading' ? '加载中…' : linkStatus === 'error' ? '链接加载失败' : '暂无商品链接'}</span>}</td>
      <td><button type="button" aria-expanded={expanded} aria-label={`${row.model} ${row.storage} 历史报价`} onClick={() => onToggle(row.id)}>{expanded ? '收起 −' : '展开 +'}</button></td>
    </tr>
    {expanded && <tr data-history-sku-id={row.id}><td colSpan={9}><HistoryLineChart row={row} /></td></tr>}
  </>;
});

function HistoryLineChart({ row }: { row: ReturnType<typeof rankVolatility>[number] }) {
  const points = [...row.snapshots].reverse();
  return <div className="sku-race-history-chart" role="img" aria-label={`${row.model} ${row.storage} 历史到手价折线图，最新日期在左`}>
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={points} margin={{ top: 16, right: 28, bottom: 8, left: 12 }} accessibilityLayer>
        <CartesianGrid stroke="#f0f0f0" strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: '#9ca3af' }} minTickGap={36} interval="preserveStartEnd" />
        <YAxis domain={['auto', 'auto']} axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: '#9ca3af' }} tickFormatter={value => money(Number(value))} width={80} />
        <Tooltip formatter={value => [money(Number(value)), '到手价']} labelFormatter={label => `${label}`} contentStyle={{ borderRadius: 10, borderColor: '#e5e7eb', fontSize: 12 }} />
        <Line type="linear" dataKey="finalPrice" stroke="#ea580c" strokeWidth={2} dot={points.length === 1} activeDot={{ r: 4 }} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  </div>;
}
