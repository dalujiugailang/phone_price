import fs from 'node:fs/promises';
import path from 'node:path';
import { createDailyPriceClient, selectedDailyPpv, attachDailyPrice } from './daily-price-client.mjs';

export const DIAGNOSTIC_SAMPLES = [
  { model: '真我 Neo8', storage: '12GB+256GB', ppv: 'S真我 Neo8 大陆国行 全网通 12G+256G 起源白' },
  { model: '真我 Neo8', storage: '16GB+512GB', ppv: 'S真我 Neo8 大陆国行 全网通 16G+512G 起源白' },
];
const finite = n => typeof n === 'number' && Number.isFinite(n);
export const normalizeStorage = s => String(s ?? '').replace(/\s/g, '').toUpperCase().replace(/GB/g, 'G').replace(/TB/g, 'T');
const dayBefore = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) - days * 86400000).toISOString().slice(0, 10);

// A price is usable only when its own date axis is intact. Never zip/truncate a
// malformed series, carry prices forward, or mix grades in the selected chain.
function average(v, field, axis, from, to, warnings) {
  const dates = v?.[axis], values = v?.[field];
  if (!Array.isArray(dates) || !Array.isArray(values)) return { value: null, points: 0, dates: [] };
  if (dates.length !== values.length) {
    warnings.add(`${field}与${axis}日期轴长度不一致（${values.length}/${dates.length}），未参与计算`);
    return { value: null, points: 0, dates: [] };
  }
  const points = dates.flatMap((d, i) => d >= from && d <= to && finite(values[i]) ? [{ date: d, value: values[i] }] : []);
  return { value: points.length ? points.reduce((n, p) => n + p.value, 0) / points.length : null,
    points: points.length, dates: points.map(p => p.date) };
}

export function computePriceDiagnostic(data, target) {
  const { board, price, sales, strategy } = data;
  const latest = board.meta.dates.at(-1);
  const shortDate = /^(\d{1,2})[.\/-](\d{1,2})$/.exec(target.riskPriceDate ?? '');
  const inferredDate = shortDate ? `${latest.slice(0, 4)}-${shortDate[1].padStart(2, '0')}-${shortDate[2].padStart(2, '0')}` : null;
  const asOf = target.date || inferredDate || latest;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || !board.meta.dates.includes(asOf)) throw new Error(`诊断日期不在快照范围内：${asOf}`);
  const model = String(target.model ?? '').trim();
  const storage = normalizeStorage(target.storage);
  const requestedGrade = target.grade ? String(target.grade).trim() : null;
  const requestedOs = target.os ? String(target.os).trim() : null;
  const modelData = price.models[model];
  const variantKeys = Object.keys(modelData?.s1 ?? {});
  const availableVariants = variantKeys.filter(k => normalizeStorage(k.split('|')[0]) === storage);
  let selectionDays = 7, selectedVolume = null;
  let key;
  if (requestedGrade) key = availableVariants.find(k => (!requestedOs || k.split('|')[1] === requestedOs) && k.split('|')[2] === requestedGrade);
  else {
    const candidates = availableVariants.filter(k => !requestedOs || k.split('|')[1] === requestedOs);
    const ranked = days => candidates.map(k => {
      const v = modelData.s1[k];
      const volume = v.d?.length === v.dq?.length ? v.d.reduce((sum, d, i) =>
        d >= dayBefore(asOf, days - 1) && d <= asOf && finite(v.dq[i]) && v.dq[i] > 0 ? sum + v.dq[i] : sum, 0) : 0;
      return { key: k, volume };
    }).filter(v => v.volume > 0).sort((a, b) => b.volume - a.volume || a.key.localeCompare(b.key));
    let rows = ranked(7);
    if (!rows.length) { selectionDays = 30; rows = ranked(30); }
    key = rows[0]?.key;
    selectedVolume = rows[0]?.volume ?? null;
  }
  const grade = key?.split('|')[2] ?? requestedGrade;
  const os = key?.split('|')[1] ?? requestedOs;
  const base = { model, storage: target.storage, grade, os, asOf, variant: key ?? null, availableVariants,
    inputPpv: target.ppv ?? null, riskPriceDate: target.riskPriceDate ?? null,
    riskBiPrice: finite(target.riskBiPrice) ? target.riskBiPrice : null,
    retailFinalPrice: finite(target.retailFinalPrice) ? target.retailFinalPrice : null,
    selectedVolume, selectionDays: requestedGrade ? null : selectionDays,
    selectionMethod: requestedGrade ? '指定等级真实样例' : '同型号同存储规格成交量最多的PPV',
    scope: '先选同型号同规格成交最多的变体，再锁定该变体取整条价格链；源数据不区分颜色。该成交变体可与风险表S等级不同，诊断不修改原风险判定。' };
  if (!key) return { ...base, status: 'unmatched', metrics: [], diagnoses: [], warnings: [],
    reason: modelData ? requestedGrade ? `同型号同规格未找到 ${requestedGrade} 等级价格链。` : '同型号同规格近7天及近30天均没有有效成交量，未选择其他规格替代。' : '快照中没有该型号的回收价格链。' };
  const s1 = modelData.s1[key], s4 = sales.models[model]?.[key];
  const warnings = new Set();
  const mi = board.models.findIndex(m => m.n === model);
  const end = board.meta.dates.indexOf(asOf);
  let coefficient = null, strategyName = null, strategyType = null, coefficientDate = null;
  const tk = strategy.models[model];
  for (let i = strategy.meta.dates.length - 1; i >= 0; i--) {
    if (strategy.meta.dates[i] <= asOf && finite(tk?.tk?.[i])) {
      coefficient = tk.tk[i]; strategyName = tk.tkName?.[i] ?? null; strategyType = tk.tkType?.[i] ?? null;
      coefficientDate = strategy.meta.dates[i]; break;
    }
  }
  const salesMix = n => {
    const totals = [0, 0, 0]; let points = 0;
    for (let d = Math.max(0, end - n + 1); d <= end; d++) {
      const row = board.sales[d]?.find(r => r[0] === mi);
      if (row) { points++; for (let k = 0; k < 3; k++) totals[k] += row[k + 1] ?? 0; }
    }
    const total = totals.reduce((a, b) => a + b, 0);
    const shareC = total > 0 ? totals[0] / total : null;
    return { days: n, points, toc: totals[0], tob: totals[1], unknown: totals[2], shareC,
      mode: shareC == null ? 'unknown' : shareC > .6 ? 'toc' : shareC < .4 ? 'tob' : 'both' };
  };
  let mix = salesMix(7); if (mix.shareC == null) mix = salesMix(30);
  const calculate = days => {
    const from = dayBefore(asOf, days - 1);
    const p1 = s1.p1?.map((v, i) => finite(v) && v > 0 ? v : s1.p1b?.[i] ?? null);
    const p = average({ ...s1, effectiveP1: p1 }, 'effectiveP1', 'd', from, asOf, warnings);
    const b = average(s4, 'bprice', 'd', from, asOf, warnings);
    const c = average(s4, 'cprice', 'd', from, asOf, warnings);
    const baseline = average(s1, 'base', 'dc', from, asOf, warnings);
    const item = average(s1, 'item', 'dc', from, asOf, warnings);
    const bi = { ...baseline, value: baseline.value != null && coefficient != null && 1 + coefficient > 0 ? baseline.value / (1 + coefficient) : null };
    return { p1: p, tob: b, toc: c, bi, base: baseline, item };
  };
  let windowDays = 3, values = calculate(3);
  const incomplete = v => ['p1', 'bi', 'base', 'item'].some(k => v[k].value == null) ||
    (mix.mode === 'toc' ? v.toc.value == null : mix.mode === 'tob' ? v.tob.value == null : mix.mode === 'both' ? v.tob.value == null && v.toc.value == null : true);
  if (incomplete(values)) { windowDays = 7; values = calculate(7); }
  const labels = { p1: 'P1销售参考价', tob: 'B端实际出货价', toc: 'C端实际结算价', bi: 'BI价（反算）', base: '基准价', item: '回收物品价' };
  const metrics = Object.entries(values).map(([id, detail]) => ({ id, label: labels[id], ...detail,
    basis: ['base', 'item', 'bi'].includes(id) ? '订单创建日' : id === 'p1' ? '订单成交日' : '销售日' }));
  const refs = mix.mode === 'toc' ? ['toc'] : mix.mode === 'tob' ? ['tob'] : mix.mode === 'both' ? ['tob', 'toc'] : [];
  const diagnoses = [];
  for (const ref of refs) {
    const value = values[ref].value;
    if (!(value > 0)) continue;
    if (values.p1.value != null) {
      const diff = (values.p1.value - value) / value;
      diagnoses.push({ title: `P1 vs ${labels[ref]}`, verdict: diff > .05 ? 'P1虚高' : diff < -.05 ? '销售溢价机会' : 'P1合理',
        difference: diff, owner: 'P1定价维护', evidence: `P1 ${values.p1.value.toFixed(2)}元；${labels[ref]} ${value.toFixed(2)}元；阈值±5%` });
    }
    if (values.bi.value > 0) {
      const diff = (value - values.bi.value) / values.bi.value;
      diagnoses.push({ title: `${labels[ref]} vs BI价`, verdict: diff < -.05 ? 'BI价偏高·需降价' : diff > .05 ? 'BI价偏低·需涨价' : 'BI价合理',
        difference: diff, owner: 'BI价格维护', evidence: `${labels[ref]} ${value.toFixed(2)}元；反算BI ${values.bi.value.toFixed(2)}元；阈值±5%` });
    }
  }
  const inv = board.inv[end]?.find(r => r[0] === mi);
  const turnoverDays = inv?.[2] > 0 ? inv[1] / inv[2] : null;
  const ratio = inv?.[4] ?? null;
  if (coefficient != null && turnoverDays != null && ratio != null) {
    const cycle = turnoverDays <= 12 ? 'fast' : turnoverDays <= 30 ? 'normal' : 'slow';
    const supply = ratio < .8 ? 'under' : ratio <= 2 ? 'balanced' : 'over';
    const balanced = cycle === 'fast' && supply === 'over' || cycle === 'normal' && supply === 'balanced' || cycle === 'slow' && supply === 'under';
    let verdict = '系数方向不冲突';
    if (cycle === 'fast' && supply === 'under' && coefficient < 0 || cycle === 'slow' && supply === 'over' && coefficient > 0) verdict = '周转系数需回撤';
    else if (balanced) verdict = Math.abs(coefficient) > .04 + 1e-9 ? '周转系数超±4%' : '周转系数在±4%内';
    else if ((cycle === 'fast' || supply === 'under') && coefficient < 0 || cycle !== 'fast' && supply !== 'under' && coefficient > 0) verdict = '周转系数考虑回撤';
    diagnoses.push({ title: '周转系数是否合理', verdict, owner: '周转策略维护', evidence: `周转${turnoverDays.toFixed(1)}天；近3天进销比${ratio.toFixed(2)}；系数${(coefficient * 100).toFixed(1)}%` });
  }
  const missing = metrics.filter(m => m.value == null).map(m => m.label);
  if (missing.length) warnings.add(`缺少：${missing.join('、')}；相关判断暂缺。`);
  if (coefficientDate && coefficientDate < asOf) warnings.add(`周转系数沿用${coefficientDate}的最近有效值。`);
  const inventoryPoints = board.inv.slice(Math.max(0, end - 6), end + 1).flatMap(rows => {
    const r = rows.find(r => r[0] === mi); return r && finite(r[1]) ? [r[1]] : [];
  });
  const inventoryAverage = inventoryPoints.length ? inventoryPoints.reduce((a, b) => a + b, 0) / inventoryPoints.length : null;
  const inventoryDiff = inventoryAverage > 0 && finite(inv?.[1]) ? (inv[1] - inventoryAverage) / inventoryAverage : null;
  const inventory = { latest: inv?.[1] ?? null, average: inventoryAverage, difference: inventoryDiff,
    points: inventoryPoints.length, verdict: inventoryDiff == null ? '库存水位数据不足' : inventoryDiff > .1 ? '库存水位偏高' : inventoryDiff < -.1 ? '库存水位偏低' : '库存水位正常' };
  const lastPrice = (v, field) => {
    if (!Array.isArray(v?.d) || !Array.isArray(v?.[field])) return { value: null, date: null };
    if (v.d.length !== v[field].length) { warnings.add(`${field}竞争价日期轴不一致，未参与计算`); return { value: null, date: null }; }
    let point = { value: null, date: null };
    for (let i = 0; i < v.d.length; i++) if (v.d[i] <= asOf && finite(v[field][i]) && (!point.date || v.d[i] > point.date)) point = { value: v[field][i], date: v.d[i] };
    return point;
  };
  const competition = [
    { id: 'recycle', label: '普通回收链', source: 's2', ours: 'ahsAfter', before: 'ahsBefore', rival: 'zz', ourLabel: '爱回收券后价', rivalLabel: '转转券后价' },
    { id: 'tradein', label: '换新链', source: 's3', ours: 'jdAfter', before: 'jdBefore', rival: 'tm', ourLabel: '京东换新到手价', rivalLabel: '天猫换新到手价' },
  ].map(c => {
    const v = modelData[c.source]?.[key];
    const after = lastPrice(v, c.ours), before = lastPrice(v, c.before), rival = lastPrice(v, c.rival);
    const our = after.value != null ? after : before;
    const difference = our.value != null && rival.value > 0 ? (our.value - rival.value) / rival.value : null;
    return { id: c.id, label: c.label, ourLabel: after.value != null ? c.ourLabel : c.ourLabel.replace('券后', '追前'), rivalLabel: c.rivalLabel,
      our, rival, difference, coupon: after.value != null && before.value != null ? after.value - before.value : null,
      pressure: difference == null ? null : difference < 0 };
  });
  return { ...base, status: incomplete(values) ? 'partial' : 'matched', metrics, diagnoses,
    warnings: [...warnings], windowDays, windowFrom: dayBefore(asOf, windowDays - 1), mix,
    inventory, competition,
    coefficient, coefficientDate, strategyName, strategyType, turnoverDays, purchaseSalesRatio3d: ratio,
    reason: incomplete(values) ? '部分字段缺失或源日期轴异常，仅对有效字段给出判断。' : '同变体价格链已匹配。' };
}

export function createAndroidRiskDiagnostics({ projectRoot }) {
  const dailyClient = createDailyPriceClient({ projectRoot });
  const root = process.env.ANDROID_E2E_SNAPSHOT_DIR || path.join(projectRoot, 'data/android-e2e');
  let cache, cacheKey;
  async function load() {
    const candidates = [];
    for (const dir of [root, ...(await fs.readdir(root, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => path.join(root, d.name))]) {
      try { const text = await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'); const manifest = JSON.parse(text); candidates.push({ dir, manifest, signature: text }); } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
    }
    const selected = candidates.sort((a, b) => b.manifest.exported_at.localeCompare(a.manifest.exported_at))[0];
    if (!selected) throw new Error('尚未找到完整安卓看板快照，请先运行抓取脚本。');
    const key = selected.dir + selected.signature;
    if (key !== cacheKey) {
      cacheKey = key;
      cache = Promise.all(['board_data', 'price_data', 's4_data', 'tk_data'].map(n => fs.readFile(path.join(selected.dir, n + '.json'), 'utf8').then(JSON.parse)))
        .then(([board, price, sales, strategy]) => ({ board, price, sales, strategy, manifest: selected.manifest }));
      cache.catch(() => { if (cacheKey === key) cacheKey = null; });
    }
    return cache;
  }
  return { async lookup(body) {
    const targets = body?.samples === true ? DIAGNOSTIC_SAMPLES : body?.targets;
    if (!Array.isArray(targets) || targets.length === 0 || targets.length > 20) throw new Error('请提供1至20个待诊断SKU。');
    if (targets.some(t => !t || typeof t.model !== 'string' || typeof t.storage !== 'string' || t.model.length > 150 || t.storage.length > 50)) throw new Error('型号或规格无效。');
    const data = await load();
    const historicalRows = targets.map(t => computePriceDiagnostic(data, t));
    const ppvs = historicalRows.map((row, i) => selectedDailyPpv(row, targets[i]));
    let dailyPayload = { rows: [], dataDate: null, zzDate: null, receivedAt: null }, dailyError = null;
    try { dailyPayload = await dailyClient.lookup(ppvs.filter(Boolean)); }
    catch (error) { dailyError = error.message; }
    const rows = historicalRows.map((row, i) => {
      if (row.status === 'unmatched') return row;
      const next = attachDailyPrice(row, ppvs[i], dailyPayload);
      if (dailyError) { next.dailyPrice.status = 'error'; next.warnings.unshift(dailyError); }
      return next;
    });
    return { sample: body?.samples === true, sourceUrl: data.manifest.base_url,
      exportedAt: data.manifest.exported_at, sourceDate: data.board.meta.dates.at(-1),
      dailyPrice: { status: dailyError ? 'error' : 'ok', dataDate: dailyPayload.dataDate, receivedAt: dailyPayload.receivedAt, error: dailyError },
      method: '当前BI出货价、BI基准价、最终报价从Daily Price API直接查询；成交最多变体和P1/结算/周转来自已核验历史成交快照。不同日期不作同期涨降价结论。',
      rows };
  } };
}

export function registerAndroidRiskDiagnosticsRoutes(app, options) {
  const service = createAndroidRiskDiagnostics(options);
  app.post('/api/risk-price-diagnostics', async (req, res) => {
    try { res.json(await service.lookup(req.body)); }
    catch (error) { res.status(400).json({ message: error.code === 'ENOENT' ? '尚无安卓看板快照，请先运行抓取脚本。' : error.message }); }
  });
}
