import { useDeferredValue, useMemo, useState } from 'react';
import { buildSummaryModels, comboDirection, summarizeAmounts, type ComboDirection, type SummaryCategory, type SummarySku } from './changeSummary';
import './change-summary.css';

const categories: { key: SummaryCategory; label: string; tag: string }[] = [
  { key: 'list', label: '仅挂牌变化', tag: '挂牌价变化' },
  { key: 'mixed', label: '组合变化', tag: '组合变化' },
  { key: 'coupon', label: '仅优惠券变化', tag: '优惠券变化' },
];
const directions: { key: ComboDirection; label: string }[] = [
  { key: 'up-up', label: '牌升券升' }, { key: 'up-down', label: '牌升券降' },
  { key: 'down-up', label: '牌降券升' }, { key: 'down-down', label: '牌降券降' },
];

function Amount({ values }: { values: number[] }) {
  const parts = summarizeAmounts(values);
  return <span className="cs-amount">{parts.length ? parts.map(part => <span key={part.direction} className={`cs-${part.direction}`}>{part.label}</span>) : <span className="cs-flat">—</span>}</span>;
}

export function ChangeSummaryPanel({ skus, previousDate, latestDate }: { skus: SummarySku[]; previousDate: string; latestDate: string }) {
  const [search, setSearch] = useState('');
  const query = useDeferredValue(search.trim().toLocaleLowerCase());
  const [category, setCategory] = useState<SummaryCategory | 'all'>('all');
  const [direction, setDirection] = useState<ComboDirection | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const models = useMemo(() => buildSummaryModels(skus), [skus]);
  const searched = useMemo(() => models.filter(row => !query || `${row.model} ${row.entries.map(s => s.storage).join(' ')}`.toLocaleLowerCase().includes(query)), [models, query]);
  const visible = useMemo(() => searched.filter(row => category === 'all' || row.category === category).map(row => ({
    ...row, entries: direction ? row.entries.filter(sku => row.category === 'mixed' && comboDirection(sku) === direction) : row.entries,
  })).filter(row => row.entries.length), [searched, category, direction]);
  const selected = visible.find(row => row.key === selectedKey) ?? visible[0];
  const skuCount = visible.reduce((sum, row) => sum + row.entries.length, 0);
  const directionCounts = directions.map(item => ({ ...item, count: searched.filter(row => row.category === 'mixed').reduce((sum, row) => sum + row.entries.filter(sku => comboDirection(sku) === item.key).length, 0) }));
  const maxDirectionCount = Math.max(1, ...directionCounts.map(item => item.count));
  const changeCategory = (next: typeof category) => { setCategory(next); setDirection(null); };
  const isoDate = latestDate.includes('-') ? latestDate : `2026-${latestDate.split('.')[0]?.padStart(2, '0')}-${latestDate.split('.')[1]?.padStart(2, '0')}`;

  return <section className="change-summary" aria-label="价格变动汇总">
    <header className="cs-heading">
      <div className="cs-system"><span><i />LATEST SUMMARY <b>/ 价格组成变化</b></span><span>正式采价口径</span></div>
      <h2>价格及优惠券变动汇总<span>型号 / SKU</span></h2>
      <p>对比窗口 <strong>{previousDate} → {latestDate}</strong><span>·</span>有效变动 <strong>&gt; ¥20</strong><span>·</span>按型号汇总 / SKU 下钻</p>
    </header>

    <div className="cs-toolbar">
      <div className="cs-tabs" role="group" aria-label="变动分类">
        <button type="button" aria-pressed={category === 'all'} onClick={() => changeCategory('all')}>全部变动</button>
        {categories.map(item => <button type="button" key={item.key} aria-pressed={category === item.key} onClick={() => changeCategory(item.key)}>{item.key === 'list' ? '挂牌变化' : item.key === 'coupon' ? '优惠券变化' : item.label}</button>)}
      </div>
      <label className="cs-search"><span aria-hidden="true">/</span><input aria-label="搜索汇总型号或存储版本" placeholder="搜索型号 / 存储版本" value={search} onChange={event => setSearch(event.target.value)} /></label>
    </div>

    {direction && <div className="cs-filter-state">方向筛选：{directions.find(item => item.key === direction)?.label}<button type="button" onClick={() => setDirection(null)}>清除 ×</button></div>}

    <div className="cs-main-grid">
      <fieldset className="cs-panel cs-log"><legend><b>型号变动</b><span aria-live="polite">{visible.length} 型号行 · {skuCount} SKU</span></legend>
        <div className="cs-column-head" aria-hidden="true"><span>型号</span><span>Δ 挂牌</span><span>Δ 券</span></div>
        <div className="cs-log-scroll" role="group" aria-label="变动型号列表">
          {visible.map(row => <button type="button" className={`cs-model-row${selected?.key === row.key ? ' is-selected' : ''}`} key={row.key} aria-pressed={selected?.key === row.key} onClick={() => setSelectedKey(row.key)}>
            <span className="cs-model-name"><strong>{row.model}</strong><small>{categories.find(item => item.key === row.category)?.tag} · {row.entries.length} SKU</small></span>
            <Amount values={row.entries.map(s => s.listPriceDiff)} /><Amount values={row.entries.map(s => s.couponDiff)} />
          </button>)}
          {!visible.length && <div className="cs-empty">{models.length ? '没有符合当前筛选条件的型号' : '本期无超过 20 元的有效变动'}<small>{models.length ? '调整搜索或切换分类后重试' : '挂牌价与优惠券分别判断，恰好 20 元不计入'}</small></div>}
        </div>
      </fieldset>

      <fieldset className="cs-panel cs-meters"><legend><b>变动分布</b><span>统计概览</span></legend>
        <div className="cs-meter-heading"><span>分类分布</span><span>{searched.length} 型号行</span></div>
        <div className="cs-meter-list">{categories.map(item => {
          const count = searched.filter(row => row.category === item.key).length;
          return <button type="button" className={`cs-meter cs-category-${item.key}`} key={item.key} aria-pressed={category === item.key} aria-label={`${item.label}，${count} 个型号行，点击筛选`} onClick={() => changeCategory(category === item.key ? 'all' : item.key)}><span>{item.label}</span><span className="cs-bar"><i style={{ width: `${count / Math.max(1, searched.length) * 100}%` }} /></span><b>{count}</b></button>;
        })}</div>
        <div className="cs-meter-heading cs-divider"><span>组合变化方向</span><span>SKU 数量</span></div>
        <div className="cs-meter-list">{directionCounts.map(item => <button type="button" className="cs-meter cs-direction" key={item.key} aria-pressed={direction === item.key} aria-label={`${item.label}，${item.count} 个 SKU，点击筛选`} onClick={() => { setCategory('mixed'); setDirection(direction === item.key ? null : item.key); }}><span>{item.label}</span><span className="cs-bar"><i style={{ width: `${item.count / maxDirectionCount * 100}%` }} /></span><b>{item.count}</b></button>)}</div>
        <p className="cs-meter-note">分类：型号汇总行数 · 方向：SKU 数量<br />点击分类或方向筛选型号 →</p>
      </fieldset>
    </div>

    <fieldset className="cs-panel cs-inspector"><legend><b>SKU 变动明细</b><span>所选型号 / 存储版本</span></legend>
      {selected ? <>
        <div className="cs-inspector-heading"><div><h3>{selected.model}</h3><p>{categories.find(item => item.key === selected.category)?.tag} / {selected.entries.length} 个存储版本</p></div><span><i />当前选中</span></div>
        <div className="cs-detail-scroll"><table><thead><tr><th>存储版本 / SKU</th><th>挂牌价 Δ</th><th>优惠券 Δ</th><th>状态</th></tr></thead><tbody>{selected.entries.map(sku => <tr key={sku.id}><td><a href={`/?${new URLSearchParams({ view: 'raw', tab: 'daily', date: isoDate, sku: sku.id, search: sku.model })}`} title={`前往 ${sku.model} ${sku.storage} 采价记录`}>{sku.storage}<span aria-hidden="true"> ↗</span></a></td><td><Amount values={[sku.listPriceDiff]} /></td><td><Amount values={[sku.couponDiff]} /></td><td><span className="cs-status">● 汇总展示</span></td></tr>)}</tbody></table></div>
      </> : <div className="cs-empty">暂无可展示的 SKU<small>选择有变动的型号后在这里查看存储版本明细</small></div>}
      <footer className="cs-rule"><b>口径说明</b><span>挂牌 / 券分别按 &gt;20 元判定；组合变化按型号优先。金额为组成变化，不直接等同于最终到手价变化。</span></footer>
    </fieldset>
  </section>;
}
