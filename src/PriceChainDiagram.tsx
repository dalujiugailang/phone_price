import React from 'react';
import type { DiagnosticRow } from './RiskPriceDiagnosticsPanel';

const price = (n: number | null | undefined) => n == null ? '无数据' : `${n < 0 ? '-' : ''}¥${Math.round(Math.abs(n)).toLocaleString('zh-CN')}`;
const pct = (n: number | null | undefined) => n == null ? '—' : `${n >= 0 ? '+' : ''}${(n * 100).toFixed(1)}%`;
const blue = '#193bff', orange = '#ff8500', green = '#089a34', red = '#ed252c', gray = '#868686';
function BoxText({ x, y, width, height, children, color = '#111', size = 13, weight = 400 }: {
  x: number; y: number; width: number; height: number; children: React.ReactNode; color?: string; size?: number; weight?: number;
}) {
  return <foreignObject x={x} y={y} width={width} height={height}>
    <div style={{ fontFamily: 'Arial, sans-serif', fontSize: size, fontWeight: weight, lineHeight: 1.5, color, overflowWrap: 'anywhere' }}>{children}</div>
  </foreignObject>;
}

export function PriceChainDiagram({ row }: { row: DiagnosticRow }) {
  const metric = (id: string) => row.metrics.find(m => m.id === id);
  const live = row.dailyPrice;
  const mixedDates = live != null && live.dataDate !== row.asOf;
  const referenceIds = row.mix?.mode === 'both' ? ['tob', 'toc'] : [row.mix?.mode === 'tob' ? 'tob' : 'toc'];
  const primaryRows = [
    { id: 'p1', label: 'P1 销售参考价', note: `销售参考价 · 近${row.windowDays}天均值`, color: blue, fill: '#c9c2ff' },
    ...referenceIds.map(id => ({ id, label: id === 'toc' ? 'C端实际结算价' : 'B端实际出货价', note: `实际${id === 'toc' ? '结算' : '出货'}价 · 近${row.windowDays}天均值`, color: '#64a3ff', fill: '#d5e4ff' })),
    { id: 'bi', label: live ? 'BI出货价 · Daily Price' : 'BI价', note: live ? `接口直接值 · ${live.dataDate ?? '查询未成功'}` : `由基准价反算：基准价 ÷ (1＋周转系数)`, color: '#ff9800', fill: '#ffebc9' },
    { id: 'base', label: live ? 'BI基准价 · Daily Price' : '基准价', note: live ? `接口直接值 · ${live.dataDate ?? '查询未成功'}` : `BI价 × (1＋周转系数) · 创单日口径`, color: '#8e278d', fill: '#dec4df' },
    { id: 'item', label: '回收物品价', note: live ? `历史创单日参考 · Daily Price未提供此字段` : `基准价 × (1－毛利诉求) · 创单日口径`, color: '#0fa942', fill: '#c7e9d1' },
    ...(live ? [{ id: 'finalQuote', label: '最终报价 · Daily Price', note: `独立接口字段，非回收物品价 · ${live.dataDate ?? '无记录'}`, color: '#119b94', fill: '#c4e9e5' }] : []),
  ].map(r => ({ ...r, value: metric(r.id)?.value ?? null, detail: metric(r.id) }));
  const chains = row.competition ?? [];
  const competitionRows = chains.flatMap(c => [
    { id: `${c.id}-our`, label: `我们的回收到手价 · ${c.label === '普通回收链' ? '普通回收' : '换新'}`, note: `${c.ourLabel} · ${c.our.date ?? '无记录'}`, color: '#ff8b00', fill: '#ffe2c3', value: c.our.value },
    { id: `${c.id}-rival`, label: `友商回收到手价 · ${c.id === 'recycle' ? '转转' : '天猫'}`, note: `${c.rivalLabel} · ${c.rival.date ?? '无记录'}`, color: '#98a7bd', fill: '#e2e7ed', value: c.rival.value },
  ]);
  const displayedChains = competitionRows.filter((r, i) => r.value != null || competitionRows[i % 2 === 0 ? i + 1 : i - 1]?.value != null);
  const rows: { id: string; label: string; note: string; color: string; fill: string; value: number | null; detail?: DiagnosticRow['metrics'][number] }[] = [...primaryRows, ...displayedChains];
  const rowStart = 206, rowHeight = 78, chartBottom = rowStart + rows.length * rowHeight;
  const barX = 222, barWidth = 450;
  const values = rows.flatMap(r => r.value != null && r.value > 0 ? [r.value] : []);
  const maximum = values.length ? Math.ceil(Math.max(...values) * 1.1 / 100) * 100 : null;
  const primaryRef = metric(referenceIds[0]);
  const p1 = metric('p1')?.value, bi = metric('bi')?.value, base = metric('base')?.value, item = metric('item')?.value;
  const stepNotes = [
    p1 != null && primaryRef?.value != null && p1 > 0 ? `结算偏差 ${pct((primaryRef.value - p1) / p1)}（${price(primaryRef.value - p1)}）` : '结算偏差：有效数据不足',
    bi != null && primaryRef?.value != null && bi > 0 ? `出货价 vs BI ${pct((primaryRef.value - bi) / bi)}` : '出货价 vs BI：有效数据不足',
    live ? bi != null && base != null && bi > 0 ? `接口基准价相对BI价 ${pct((base - bi) / bi)}（${price(base - bi)}）` : '接口基准价 / BI价：无有效数据' : row.coefficient != null ? `周转系数 ${pct(row.coefficient)}${bi != null && base != null ? `（${price(base - bi)}）` : ''}` : '周转系数：无记录',
    mixedDates ? '毛利诉求：来源日期不同，暂不计算' : base != null && item != null && base > 0 ? `毛利诉求 ${pct((base - item) / base)}（${price(base - item)}）` : '毛利诉求：有效数据不足',
  ];
  const p1Judgments = row.diagnoses.filter(d => d.title.startsWith('P1'));
  const biJudgments = row.diagnoses.filter(d => d.title.includes('vs BI价'));
  const tkJudgment = row.diagnoses.find(d => d.title === '周转系数是否合理');
  const p1Height = p1Judgments.length > 1 ? 199 : 143;
  const biY = 169 + p1Height + 18, biHeight = mixedDates ? biJudgments.length > 1 ? 262 : 199 : biJudgments.length > 1 ? 199 : 143;
  const strategyY = biY + biHeight + 18;
  const competitionY = strategyY + 251;
  const height = Math.max(competitionY + 118, chartBottom + 72);
  const mix = row.mix;
  function verdictBox(y: number, h: number, title: string, color: string, judgments: typeof row.diagnoses, fallback: string, threshold?: string) {
    return <g>
      <rect x={824} y={y} width={480} height={h} rx={11} fill="white" stroke={color} strokeWidth={1.5}/>
      <path d={`M835 ${y} H1293`} stroke={color} strokeWidth={5} strokeLinecap="round"/>
      <BoxText x={840} y={y + 12} width={449} height={27} color={color} size={15} weight={700}>{title}</BoxText>
      <BoxText x={840} y={y + 49} width={445} height={h - 50} color={color}>
        {judgments.length ? judgments.map((d, i) => <div key={i} style={{ marginBottom: 6 }}><strong>{d.verdict}{d.difference == null ? '' : `（${pct(d.difference)}）`}</strong><br/>{d.evidence}</div>) : <div style={{ color: gray }}>{fallback}</div>}
        {threshold && <div style={{ color: gray, fontSize: 11, marginTop: 7 }}>{threshold}</div>}
      </BoxText>
    </g>;
  }
  const connector = (from: number, to: number, color: string) => <path d={`M760 ${from} H803 V${to} H823`} fill="none" stroke={color} strokeWidth={1.1} strokeDasharray="5 5"/>;
  return <div className="price-chain-diagram">
    <h3 style={{ fontSize: 23, fontWeight: 750, color: '#080808', margin: '20px 0 8px' }}>价格链条诊断 ｜ {row.model}</h3>
    <p style={{ fontSize: 13, color: '#7a7a7a', marginBottom: 14 }}>变体 {row.storage} · 等级 {row.grade ?? '未匹配'} ｜ 成交参考截止 {row.asOf}{live ? ` ｜ Daily Price ${live.dataDate ?? '未获取'}` : ''} ｜ {row.selectionMethod}{row.selectedVolume == null ? '' : `：近${row.selectionDays}天成交${row.selectedVolume}台`}</p>
    {live && <p style={{ color: live.status === 'matched' ? '#087c3d' : '#b45309', fontSize: 12, marginBottom: 12 }}>Daily Price完整PPV：{live.ppv ?? '缺少完整SKU'}{mixedDates ? ' ｜ 当前定价与历史成交分开标日期；跨日价差仅作排查参考。' : ''}</p>}
    <svg viewBox={`0 0 1320 ${height}`} style={{ width: '100%', display: 'block', minWidth: 760 }} role="img" aria-label={`${row.model} ${row.storage} ${row.grade} 真实价格链与诊断`}>
      <rect x={1} y={1} width={800} height={height - 2} rx={13} fill="white" stroke="#cdcdcd"/>
      <rect x={820} y={1} width={499} height={height - 2} rx={13} fill="white" stroke="#cdcdcd"/>
      <text x={18} y={31} fill={blue} fontSize={16} fontWeight={700}>价格链条 · 横向条形图（条长＝价格，同一标尺）</text>
      <text x={18} y={55} fill={orange} fontSize={12}>{live ? `P1 / 成交参考近${row.windowDays}天；BI / 基准价 / 最终报价：Daily Price ${live.dataDate ?? '未获取'}` : `统一窗口 近${row.windowDays}天${row.windowDays === 7 ? '（近3天指标缺数，已整链降级）' : ''}`}</text>
      <text x={838} y={31} fill={orange} fontSize={16} fontWeight={700}>判定区</text>
      <rect x={16} y={85} width={372} height={66} rx={8} fill="white" stroke={green} strokeWidth={1.5}/>
      <BoxText x={27} y={94} width={351} height={51} size={12}><strong style={{ color: green }}>① 销量结构（近{mix?.days ?? 7}天 · 型号级）</strong><br/>{mix?.shareC != null ? `C端占比 ${(mix.shareC * 100).toFixed(1)}% · ${mix.mode === 'toc' ? 'ToC主导，取C端结算价' : mix.mode === 'tob' ? 'ToB主导，取B端出货价' : '双端并列，分别判断'}` : '销量结构缺失，暂无参考端'}</BoxText>
      <rect x={400} y={85} width={385} height={66} rx={8} fill="white" stroke={orange} strokeWidth={1.5}/>
      <BoxText x={412} y={94} width={361} height={51} size={12}><strong style={{ color: orange }}>{mixedDates ? `历史周转系数（${row.asOf}）` : '周转系数（作用：BI价 → 基准价）'}</strong><br/>周转 {row.turnoverDays == null ? '—' : row.turnoverDays.toFixed(1)}天 / 进销比 {row.purchaseSalesRatio3d?.toFixed(2) ?? '—'} / 系数 {pct(row.coefficient)}</BoxText>
      {maximum != null ? Array.from({ length: 5 }, (_, i) => <g key={i}>
        <line x1={barX + i * barWidth / 4} x2={barX + i * barWidth / 4} y1={186} y2={chartBottom - 10} stroke="#e5e5e5"/>
        <text x={barX + i * barWidth / 4} y={179} fill={gray} fontSize={11} textAnchor="middle">{price(maximum * i / 4)}</text>
      </g>) : <text x={barX} y={179} fill={gray} fontSize={12}>暂无有效价格标尺</text>}
      {rows.map((r, i) => {
        const y = rowStart + i * rowHeight;
        const width = maximum != null && r.value != null ? Math.max(0, r.value / maximum * barWidth) : null;
        return <g key={r.id}>
          <BoxText x={16} y={y - 3} width={196} height={63} size={13}><strong>{r.label}</strong><div style={{ color: gray, fontSize: 10.5, marginTop: 4 }}>{r.note}</div></BoxText>
          {width == null ? <><rect x={barX} y={y} width={barWidth} height={32} fill="#fafafa" stroke="#d4d4d4" strokeDasharray="5 4"/><text x={barX + 12} y={y + 21} fill={gray} fontSize={12}>无有效数据，不绘制价格条</text></> : <>
            <rect x={barX} y={y} width={width} height={32} fill={r.fill} stroke={r.color} strokeWidth={1.5}/>
            <text x={barX + width + 8} y={y + 23} fill={r.color} fontSize={16} fontWeight={700}>{price(r.value)}<title>{r.value?.toFixed(2)}元</title></text>
          </>}
          {r.detail && <text x={barX} y={y + 48} fill={gray} fontSize={10}>{r.detail.source === 'Daily Price API' ? 'Daily Price直接查询' : `近${row.windowDays}天有效${r.detail.points}日`} · {r.detail.dates.join(' / ')}</text>}
          {i < primaryRows.length - 1 && i < stepNotes.length && <text x={barX + 8} y={y + 67} fill={i === 1 ? green : red} fontSize={11}>{stepNotes[i]}</text>}
        </g>;
      })}
      {verdictBox(169, p1Height, 'P1 是否虚高 ｜ P1 vs 参考出货价', p1Judgments.some(d => d.verdict === 'P1虚高') ? red : green, p1Judgments, 'P1或参考出货价缺失，无法判断。', '阈值±5%：P1高于参考价5%以上为虚高；低于参考价5%以上为销售溢价机会。')}
      {verdictBox(biY, biHeight, mixedDates ? '当前BI价 ｜ 历史成交参考' : 'BI价是否合理 ｜ 出货价 vs BI价', biJudgments.some(d => d.verdict.includes('偏高')) ? red : orange, biJudgments, 'Daily Price当前BI或成交参考价缺失，无法判断。', mixedDates ? '不同日期价差仅作排查参考，不作同期定价合理性结论。' : '阈值±5%：出货价高于BI价5%以上提示BI偏低；低于5%提示BI偏高。')}
      <rect x={824} y={strategyY} width={480} height={231} rx={11} fill="white" stroke={orange} strokeWidth={1.5}/>
      <path d={`M835 ${strategyY} H1293`} stroke={orange} strokeWidth={5} strokeLinecap="round"/>
      <BoxText x={840} y={strategyY + 15} width={449} height={202}>
        <strong style={{ color: orange, fontSize: 15 }}>周转系数是否合理{mixedDates ? '（历史）' : ''}</strong>
        <div style={{ marginTop: 12 }}>周转 {row.turnoverDays?.toFixed(1) ?? '—'}天 ｜ 进销比 {row.purchaseSalesRatio3d?.toFixed(2) ?? '—'}</div>
        <div>当前周转系数 {pct(row.coefficient)}（平衡态容差 ±4%）</div>
        <div style={{ color: gray, marginTop: 7 }}>策略类型：{row.strategyType ?? '无数据'}</div>
        <div style={{ color: gray }}>策略名称：{row.strategyName ?? '无数据'}</div>
        <div style={{ color: orange, marginTop: 8, fontWeight: 600 }}>判定：{tkJudgment?.verdict ?? '数据不足，无法判断'}</div>
        <div style={{ color: green, marginTop: 8 }}>库存水位（型号级）：{row.inventory?.latest ?? '—'}台 / 近7天均值 {row.inventory?.average?.toFixed(1) ?? '—'}台 → {row.inventory?.verdict ?? '数据不足'}</div>
        <div style={{ color: gray, fontSize: 10 }}>库存水位偏离±10%独立提示，不改变系数判定。</div>
      </BoxText>
      {connector(rowStart + 16, 240, p1Judgments.some(d => d.verdict === 'P1虚高') ? red : green)}
      {connector(rowStart + rowHeight * (referenceIds.length + 1) + 16, biY + 67, orange)}
      {chains.map((c, i) => <BoxText key={c.id} x={840} y={competitionY + i * 43} width={449} height={42} color={c.pressure === true ? red : gray} size={11}>
        <strong>{c.label}：</strong>{c.difference == null ? '同变体竞争价不足，无法判断' : `${c.pressure ? '有竞争压力' : '无竞争压力'} · 我方${price(c.our.value)} vs 友商${price(c.rival.value)}（${pct(c.difference)}）`}
      </BoxText>)}
    </svg>
    <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 12 }}>
      {(chains.length ? chains : [{ id: 'none', label: '价格链', pressure: null, difference: null }]).map(c => <div key={c.id} style={{ border: '1px solid #d0d0d0', borderTop: `4px solid ${c.pressure ? red : orange}`, borderRadius: 9, padding: '14px 18px' }}>
        <strong style={{ fontSize: 15 }}>{c.label}综合结论</strong>
        <p style={{ marginTop: 8, color: '#333', fontSize: 13 }}>{p1Judgments.map(d => d.verdict).join(' / ') || 'P1判断数据不足'}；{biJudgments.map(d => d.verdict).join(' / ') || 'BI价判断数据不足'}；{tkJudgment?.verdict ?? '周转系数判断数据不足'}；{c.pressure == null ? '竞争价不足，无法判断' : c.pressure ? '有竞争压力' : '无竞争压力'}。</p>
        <p style={{ marginTop: 8, fontSize: 12, color: '#777' }}>建议反馈：{[...new Set(row.diagnoses.map(d => d.owner))].join('、') || '源数据维护'}{row.warnings.length ? '；源日期轴和缺数需要数据维护核对。' : '。'}</p>
      </div>)}
    </div>
    {row.warnings.length > 0 && <div style={{ marginTop: 12, padding: 12, background: '#fffaf0', color: '#99620b', fontSize: 12, lineHeight: 1.8 }}><strong>数据待核对</strong>{row.warnings.map(w => <div key={w}>{w}</div>)}</div>}
  </div>;
}
