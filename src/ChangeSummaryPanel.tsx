import { Fragment, useDeferredValue, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { buildFinalSummaryModels, finalDirection, hasSummaryChange, summarizeAmounts, type FinalDirection, type SummaryCategory, type SummarySku } from './changeSummary';
import { HistoryLineChart } from './SkuPriceHistory';
import './change-summary.css';

const categories: { key: SummaryCategory; label: string; tag: string }[] = [
  { key: 'list', label: '仅挂牌变化', tag: '挂牌价变化' },
  { key: 'mixed', label: '组合变化', tag: '组合变化' },
  { key: 'coupon', label: '仅优惠券变化', tag: '优惠券变化' },
];
const directions: { key: FinalDirection; label: string }[] = [
  { key: 'down', label: '国补后到手价降低' }, { key: 'up', label: '国补后到手价升高' },
  { key: 'flat', label: '到手价持平（≤20元）' }, { key: 'missing', label: '到手价不可比' },
];
const componentCategory = (sku: SummarySku): SummaryCategory | null => hasSummaryChange(sku.listPriceDiff) && hasSummaryChange(sku.couponDiff) ? 'mixed' : hasSummaryChange(sku.listPriceDiff) ? 'list' : hasSummaryChange(sku.couponDiff) ? 'coupon' : null;

function Amount({ values, final = false }: { values: number[]; final?: boolean }) {
  const parts = summarizeAmounts(values);
  return <span className="cs-amount">{parts.length ? parts.map(part => <span key={part.direction} className={`cs-${part.direction}`}>{part.label}</span>) : <span className="cs-flat">{final ? values.length ? '持平（≤20元）' : '不可比' : '—'}</span>}</span>;
}

export function ChangeSummaryPanel({ skus, previousDate, latestDate }: { skus: SummarySku[]; previousDate: string; latestDate: string }) {
  const [search, setSearch] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);
  const query = useDeferredValue(search.trim().toLocaleLowerCase());
  const [category, setCategory] = useState<SummaryCategory | 'all'>('all');
  const [direction, setDirection] = useState<FinalDirection | null>(null);
  const [historySkuId, setHistorySkuId] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const models = useMemo(() => buildFinalSummaryModels(skus), [skus]);
  const searched = useMemo(() => models.filter(row => !query || `${row.model} ${row.entries.map(s => s.storage).join(' ')}`.toLocaleLowerCase().includes(query)), [models, query]);
  const visible = useMemo(() => searched.map(row => ({
    ...row, entries: row.entries.filter(sku => (!direction || finalDirection(sku) === direction) && (category === 'all' || componentCategory(sku) === category)),
  })).filter(row => row.entries.length), [searched, category, direction]);
  const selected = visible.find(row => row.key === selectedKey) ?? visible[0];
  const historySku = selected?.entries.find(sku => sku.id === historySkuId);
  const skuCount = visible.reduce((sum, row) => sum + row.entries.length, 0);
  const searchedSkus = searched.flatMap(row => row.entries);
  const directionCounts = directions.map(item => ({ ...item, count: searchedSkus.filter(sku => finalDirection(sku) === item.key).length }));
  const maxDirectionCount = Math.max(1, searchedSkus.length);
  const directionSkus = searchedSkus.filter(sku => !direction || finalDirection(sku) === direction);
  const isoDate = latestDate.includes('-') ? latestDate : `2026-${latestDate.split('.')[0]?.padStart(2, '0')}-${latestDate.split('.')[1]?.padStart(2, '0')}`;
  const changeCategory = (next: typeof category) => { setCategory(next); };

  return <section className="change-summary" aria-label="价格变动汇总">
    <header className="cs-heading">
      <div className="cs-system"><span><i />LATEST SUMMARY <b>/ 到手价变化</b></span><span>正式采价口径</span></div>
      <h2>国补后到手价变动汇总<span>型号 / SKU</span></h2>
      <p>对比窗口 <strong>{previousDate} → {latestDate}</strong><span>·</span>有效变动 <strong>&gt; ¥20</strong><span>·</span>按型号汇总 / SKU 下钻</p>
    </header>

    <div className="cs-toolbar">
      <div className="cs-tabs" role="group" aria-label="变动分类">
        <button type="button" aria-pressed={!direction} onClick={() => { setDirection(null); setCategory('all'); }}>全部变动</button>
        {directions.slice(0, 2).map(item => <button type="button" key={item.key} aria-pressed={direction === item.key} onClick={() => { setDirection(item.key); setCategory('all'); }}>{item.label}</button>)}
      </div>
      <div className="cs-search" role="search" aria-label="汇总搜索"><Search size={17} strokeWidth={1.8} aria-hidden="true" /><input ref={searchInput} aria-label="搜索汇总型号或存储版本" placeholder="搜索型号、存储版本…" value={search} onChange={event => setSearch(event.target.value)} />{search && <button type="button" className="cs-search-clear" aria-label="清空汇总搜索" onClick={() => { setSearch(''); searchInput.current?.focus(); }}><X size={14} aria-hidden="true" /></button>}</div>
    </div>

    {direction && <div className="cs-filter-state">方向筛选：{directions.find(item => item.key === direction)?.label}<button type="button" onClick={() => setDirection(null)}>清除 ×</button></div>}

    <div className="cs-main-grid">
      <fieldset className="cs-panel cs-log"><legend><b>型号变动</b><span aria-live="polite">{visible.length} 型号行 · {skuCount} SKU</span></legend>
        <div className="cs-column-head" aria-hidden="true"><span>型号</span><span>国补后到手价</span><span>挂牌价</span><span>优惠券</span></div>
        <div className="cs-log-scroll" role="group" aria-label="变动型号列表">
          {visible.map(row => <button type="button" className={`cs-model-row${selected?.key === row.key ? ' is-selected' : ''}`} key={row.key} aria-pressed={selected?.key === row.key} onClick={() => setSelectedKey(row.key)}>
            <span className="cs-model-name"><strong>{row.model}</strong><small>{row.entries.length} SKU · {directions.filter(item => row.entries.some(sku => finalDirection(sku) === item.key)).map(item => item.label).join(' / ')}</small></span>
            <Amount final values={row.entries.flatMap(s => s.finalPriceDiff == null ? [] : [s.finalPriceDiff])} /><Amount values={row.entries.map(s => s.listPriceDiff)} /><Amount values={row.entries.map(s => s.couponDiff)} />
          </button>)}
          {!visible.length && <div className="cs-empty">{models.length ? '没有符合当前筛选条件的型号' : '本期无超过 20 元的有效变动'}<small>{models.length ? '调整搜索或切换分类后重试' : '挂牌价与优惠券分别判断，恰好 20 元不计入'}</small></div>}
        </div>
      </fieldset>

      <fieldset className="cs-panel cs-meters"><legend><b>变动分布</b><span>统计概览</span></legend>
        <div className="cs-meter-heading"><span>国补后到手价方向</span><span>{searchedSkus.length} SKU</span></div>
        <div className="cs-meter-list">{directionCounts.map(item => <button type="button" className={`cs-meter cs-final-${item.key}`} key={item.key} aria-pressed={direction === item.key} aria-label={`${item.label}，${item.count} 个 SKU，点击筛选`} onClick={() => { setCategory('all'); setDirection(direction === item.key ? null : item.key); }}><span>{item.label}</span><span className="cs-bar"><i style={{ width: `${item.count / maxDirectionCount * 100}%` }} /></span><b>{item.count}</b></button>)}</div>
        <div className="cs-meter-heading cs-divider"><span>挂牌价 / 优惠券变化</span><span>{directionSkus.length} SKU · 当前方向</span></div>
        <div className="cs-meter-list">{categories.map(item => {
          const count = directionSkus.filter(sku => componentCategory(sku) === item.key).length;
          return <button type="button" className={`cs-meter cs-category-${item.key}`} key={item.key} aria-pressed={category === item.key} aria-label={`${item.label}，${count} 个 SKU，点击筛选`} onClick={() => changeCategory(category === item.key ? 'all' : item.key)}><span>{item.label}</span><span className="cs-bar"><i style={{ width: `${count / Math.max(1, directionSkus.length) * 100}%` }} /></span><b>{count}</b></button>;
        })}</div>
        <p className="cs-meter-note">按实际国补后报价判断方向，全部按 SKU 计数。<br />挂牌价与券变化供对照；仅到手价变化的 SKU 也保留。{category !== 'all' && <button type="button" onClick={() => setCategory('all')}>清除组成筛选 ×</button>}</p>
      </fieldset>
    </div>

    <fieldset className="cs-panel cs-inspector"><legend><b>SKU 变动明细</b><span>所选型号 / 存储版本</span></legend>
      {selected ? <>
        <div className="cs-inspector-heading"><div><h3>{selected.model}</h3><p>{selected.entries.length} 个存储版本 / 国补后报价对比</p></div><span><i />当前选中</span></div>
        <div className="cs-detail-scroll"><table><thead><tr><th>存储版本 / SKU</th><th>国补后到手价</th><th>挂牌价</th><th>优惠券</th><th>状态</th><th>详情</th></tr></thead><tbody>{selected.entries.map(sku => <Fragment key={sku.id}><tr className="cs-sku-row" onClick={() => setHistorySkuId(current => current === sku.id ? null : sku.id)}><td><a onClick={event => event.stopPropagation()} href={`/?${new URLSearchParams({ view: 'raw', tab: 'daily', date: isoDate, sku: sku.id, search: sku.model })}`} title={`前往 ${isoDate} ${sku.model} ${sku.storage} 采价记录`}><strong>{sku.storage}</strong><span aria-hidden="true"> ↗</span></a></td><td><Amount final values={sku.finalPriceDiff == null ? [] : [sku.finalPriceDiff]} /></td><td><Amount values={[sku.listPriceDiff]} /></td><td><Amount values={[sku.couponDiff]} /></td><td><span className="cs-status">{directions.find(item => item.key === finalDirection(sku))?.label}</span></td><td><button type="button" className="cs-history-toggle" aria-expanded={historySku?.id === sku.id} aria-controls="cs-selected-sku-history" aria-label={`${sku.model} ${sku.storage} 展示详情`} onClick={event => { event.stopPropagation(); setHistorySkuId(current => current === sku.id ? null : sku.id); }}>{historySku?.id === sku.id ? '收起详情' : '展示详情'}</button></td></tr>{historySku?.id === sku.id && <tr className="cs-history-row"><td colSpan={6}><div id="cs-selected-sku-history" className="cs-selected-history"><SummaryHistory sku={sku} /></div></td></tr>}</Fragment>)}</tbody></table></div>
      </> : <div className="cs-empty">暂无可展示的 SKU<small>选择有变动的型号后在这里查看存储版本明细</small></div>}
      <footer className="cs-rule"><b>口径说明</b><span>到手价方向按实际国补后报价差值判定，升降严格 &gt;20 元；≤20 元归为持平。到手价、挂牌价或券任一变化 &gt;20 元即纳入；不排除同型号其他存储版本。</span></footer>
    </fieldset>
  </section>;
}


const historyMoney = (value: number | undefined) => value != null && Number.isFinite(value) ? `¥${value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}` : '—';
function SummaryHistory({ sku }: { sku: SummarySku }) {
  const snapshots = sku.snapshots ?? [];
  return <section className="cs-history" aria-label={`${sku.model} ${sku.storage} 历史详情`}>
    <h4>{sku.storage} · 全部历史报价 <span>{snapshots.length} 次 · 曲线：发布 → 最新 · 报价表：最新在前</span></h4>
    {snapshots.length ? <>
      <HistoryLineChart row={{ model: sku.model, storage: sku.storage, launchPrice: sku.launchPrice, snapshots }} />
      <div className="cs-history-values" tabIndex={0} role="region" aria-label={`${sku.model} ${sku.storage} 全部历史价格`}>
        <table><thead><tr><th>日期</th><th>挂牌价（物品价）</th><th>优惠券</th><th>国补后到手价</th></tr></thead><tbody>
          {[...snapshots].reverse().map(point => <tr key={point.date}><td>{point.date}</td><td>{historyMoney(point.listPrice > 0 ? point.listPrice : undefined)}</td><td>{historyMoney(point.couponKnown !== false && point.coupon >= 0 ? point.coupon : undefined)}</td><td>{historyMoney(point.finalPrice > 0 ? point.finalPrice : undefined)}</td></tr>)}
          {sku.launchPrice && sku.launchPrice > 0 ? <tr><td>发布</td><td>{historyMoney(sku.launchPrice)}</td><td>—</td><td>—</td></tr> : null}
        </tbody></table>
      </div>
    </> : <p className="cs-empty">暂无历史报价</p>}
  </section>;
}
