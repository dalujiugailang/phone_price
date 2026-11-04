import fs from 'node:fs/promises';
import path from 'node:path';

// Keep the token server-side. No browser cookies, token values or raw transport
// errors are returned to the UI.
/** @param {{projectRoot: string, fetchImpl?: typeof fetch, tokenReader?: () => Promise<string>}} options */
export function createDailyPriceClient({ projectRoot, fetchImpl = fetch, tokenReader }) {
  const endpoint = process.env.DAILY_PRICE_LOOKUP_URL || 'http://127.0.0.1:8765/api/daily-price/lookup';
  const tokenPath = process.env.DAILY_PRICE_TOKEN_PATH || path.join(projectRoot, '..', '【daily price】/data/api_token.txt');
  return { async lookup(ppvs) {
    const unique = [...new Set(ppvs)];
    let token;
    try { token = (tokenReader ? await tokenReader() : await fs.readFile(tokenPath, 'utf8')).trim(); }
    catch { throw new Error('Daily Price凭证文件不可用，请检查DAILY_PRICE_TOKEN_PATH。'); }
    if (!token) throw new Error('Daily Price凭证为空。');
    let response, metaResponse;
    try {
      [response, metaResponse] = await Promise.all([
        fetchImpl(endpoint, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ ppv: unique }), signal: AbortSignal.timeout(15000), redirect: 'error' }),
        fetchImpl(new URL('/meta', endpoint).href, { signal: AbortSignal.timeout(15000), redirect: 'error' }),
      ]);
    } catch { throw new Error('Daily Price连接失败，请检查服务地址或本机SSH转发；未使用历史BI价代替。'); }
    if (!response.ok) throw new Error(response.status === 401 ? 'Daily Price凭证校验失败（401）。' : `Daily Price查询失败（${response.status}）。`);
    let payload, meta;
    try {
      payload = await response.json();
      meta = metaResponse.ok ? await metaResponse.json() : null;
    } catch { throw new Error('Daily Price返回内容不是有效JSON。'); }
    if (!Array.isArray(payload?.rows)) throw new Error('Daily Price返回缺少rows字段。');
    return { dataDate: payload.dataDate ?? meta?.dataDate ?? null, zzDate: meta?.zzCompetitiveness?.dataDate ?? null,
      receivedAt: new Date().toISOString(), rows: payload.rows };
  } };
}

export function selectedDailyPpv(row, target) {
  // The risk table's S+SKU is the authoritative full SKU, including colour,
  // region and network. Only the grade prefix is replaced after selecting the
  // most-traded historical variant; no SKU name is fabricated from a model.
  const ppv = String(target.ppv || '');
  if (!row.grade || !ppv.startsWith(`S${row.model}`)) return null;
  return row.grade + ppv.slice(1);
}

const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
export function attachDailyPrice(row, requestedPpv, payload) {
  const apiRow = payload?.rows.find(r => r.ppv === requestedPpv && r.matched === true);
  const available = apiRow && apiRow['等级名称'] === row.grade;
  const daily = { status: available ? 'matched' : 'unmatched', ppv: requestedPpv,
    dataDate: available ? apiRow.dataDate || payload.dataDate : payload?.dataDate ?? null,
    receivedAt: payload?.receivedAt ?? null,
    biPrice: available ? numeric(apiRow['bi出货价']) : null,
    basePrice: available ? numeric(apiRow['BI基准价']) : null,
    finalQuote: available ? numeric(apiRow['最终报价']) : null,
    zzBefore: available && payload.zzDate === (apiRow.dataDate || payload.dataDate) ? numeric(apiRow['ZZ券前价']) : null,
    zzAfter: available && payload.zzDate === (apiRow.dataDate || payload.dataDate) ? numeric(apiRow['ZZ券后价']) : null,
    zzDate: payload?.zzDate ?? null };
  const warnings = row.warnings.map(w => `历史成交快照：${w}`);
  if (!available) warnings.push(requestedPpv ? 'Daily Price未命中所选等级的完整PPV，当前BI/基准价留空。' : '缺少标准完整SKU，不能仅凭型号和内存猜测Daily Price的PPV。');
  const sameDate = daily.dataDate === row.asOf;
  if (available && !sameDate) warnings.push(`Daily Price当前价日期${daily.dataDate}；成交参考截止${row.asOf}，分开标注，跨日不输出当前涨降价结论。`);
  if (available && payload.zzDate !== daily.dataDate) warnings.push('Daily Price与ZZ竞争价日期不一致，ZZ价格未参与判断。');
  const metrics = row.metrics.map(m => {
    if (m.id !== 'bi' && m.id !== 'base') return { ...m, source: '端到端成交快照' };
    const value = m.id === 'bi' ? daily.biPrice : daily.basePrice;
    return { ...m, label: m.id === 'bi' ? 'BI出货价（Daily Price）' : 'BI基准价（Daily Price）', value,
      points: value == null ? 0 : 1, dates: value == null ? [] : [daily.dataDate], basis: 'Daily Price当前快照', source: 'Daily Price API' };
  });
  metrics.push({ id: 'finalQuote', label: '最终报价（Daily Price）', value: daily.finalQuote,
    points: daily.finalQuote == null ? 0 : 1, dates: daily.finalQuote == null ? [] : [daily.dataDate], basis: 'Daily Price当前快照', source: 'Daily Price API' });
  const diagnoses = row.diagnoses.filter(d => !d.title.includes('vs BI价'));
  const refs = row.mix?.mode === 'toc' ? ['toc'] : row.mix?.mode === 'tob' ? ['tob'] : row.mix?.mode === 'both' ? ['tob', 'toc'] : [];
  for (const ref of refs) {
    const m = metrics.find(m => m.id === ref);
    if (m?.value > 0 && daily.biPrice > 0) {
      const diff = (m.value - daily.biPrice) / daily.biPrice;
      diagnoses.push({ title: `${m.label} vs BI价`, difference: diff, owner: 'BI价格维护',
        verdict: sameDate ? Math.abs(diff) <= .05 ? 'BI价合理' : diff < 0 ? 'BI价偏高·需降价' : 'BI价偏低·需涨价' : '跨日历史参考，暂不判涨降价',
        evidence: `${m.label} ${m.value.toFixed(2)}元（参考截止${row.asOf}）；Daily Price BI ${daily.biPrice.toFixed(2)}元（${daily.dataDate}）` });
    }
  }
  const competition = row.competition?.map(c => {
    if (c.id !== 'recycle' || daily.zzAfter == null) return c;
    const aligned = c.our.date === daily.zzDate;
    const difference = aligned && c.our.value != null && daily.zzAfter > 0 ? (c.our.value - daily.zzAfter) / daily.zzAfter : null;
    return { ...c, rival: { value: daily.zzAfter, date: daily.zzDate }, rivalLabel: '转转券后价（Daily Price）',
      difference, pressure: difference == null ? null : difference < 0 };
  });
  return { ...row, dailyPrice: daily, metrics, diagnoses, warnings, competition,
    status: !available || metrics.some(m => ['p1', 'bi', 'base', 'item'].includes(m.id) && m.value == null) ? 'partial' : row.status,
    reason: available ? 'BI出货价、BI基准价和最终报价已直接读取Daily Price；P1/实际结算等为历史成交参考。' : 'Daily Price未匹配；当前价缺失，未以历史反算BI替代。' };
}
