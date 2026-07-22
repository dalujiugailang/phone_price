import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const projectRoot = path.resolve(import.meta.dirname, '..');
const dbPath = process.env.GTM_PRICE_DRAFT_DB || '/tmp/gtm-report-raw-editor-draft.sqlite';
const outputPath =
  process.env.GTM_PRICE_REPORT_HTML || path.join(projectRoot, 'reports', 'gtm-old-sku-618-price-report.html');

const START_DATE = '3.16';
const PROMO_START_DATE = '5.15';
const END_DATE = '6.16';
const CHANGE_THRESHOLD = 20;
const KNOWN_BRANDS = ['REDMI', 'iQOO', 'OPPO', 'vivo', '华为', '荣耀', '一加', '小米', '摩托罗拉', '努比亚', '三星', '真我'];
const KEY_DATES = ['3.16', '4.13', '5.13', '5.15', '5.28', '6.01', '6.08', '6.16'];

function readDraft(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = db
      .prepare(
        `
          SELECT dates_json, rows_json, saved_at, updated_at
          FROM raw_editor_drafts
          WHERE id = 1
        `,
      )
      .get();
    if (!row) {
      throw new Error(`No raw_editor_drafts row found in ${databasePath}`);
    }
    return {
      dates: JSON.parse(row.dates_json),
      rows: JSON.parse(row.rows_json),
      savedAt: row.saved_at,
      updatedAt: row.updated_at,
    };
  } finally {
    db.close();
  }
}

function parseNumber(value) {
  const parsed = Number(String(value ?? '').replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function snapshot(row, date) {
  const item = row.snapshots?.[date] ?? {};
  return {
    finalPrice: parseNumber(item.finalPrice),
    listPrice: parseNumber(item.listPrice),
    coupon: parseNumber(item.coupon),
    biPrice: parseNumber(item.biPrice),
  };
}

function hasValidPrice(row, date) {
  const item = snapshot(row, date);
  return item.finalPrice > 0 && item.listPrice > 0;
}

function inferBrand(modelName) {
  const model = String(modelName ?? '').trim();
  return KNOWN_BRANDS.find((brand) => model.startsWith(brand)) ?? model.split(/\s+/)[0] ?? '未识别';
}

function average(values) {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function round(value, digits = 0) {
  return Number(value.toFixed(digits));
}

function formatNumber(value, digits = 0) {
  return round(value, digits).toLocaleString('zh-CN');
}

function formatSigned(value) {
  const rounded = round(value);
  return `${rounded > 0 ? '+' : ''}${rounded.toLocaleString('zh-CN')}`;
}

function formatPct(value) {
  return `${round(value, 1)}%`;
}

function groupBy(items, getKey) {
  const grouped = new Map();
  for (const item of items) {
    const key = getKey(item) || '未识别';
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key).push(item);
  }
  return Array.from(grouped.entries());
}

function classifyLever(listDiff, couponDiff) {
  const hasList = Math.abs(listDiff) >= CHANGE_THRESHOLD;
  const hasCoupon = Math.abs(couponDiff) >= CHANGE_THRESHOLD;
  if (!hasList && !hasCoupon) return '基本不动';
  if (hasList && !hasCoupon) return listDiff < 0 ? '降挂牌' : '抬挂牌';
  if (!hasList && hasCoupon) return couponDiff > 0 ? '加券' : '收券';
  if (listDiff < 0 && couponDiff > 0) return '降挂牌+加券';
  if (listDiff > 0 && couponDiff < 0) return '抬挂牌+收券';
  if (listDiff > 0 && couponDiff > 0) return Math.abs(couponDiff) > Math.abs(listDiff) ? '抬挂牌但加券更多' : '抬挂牌加券对冲';
  if (listDiff < 0 && couponDiff < 0) return Math.abs(listDiff) > Math.abs(couponDiff) ? '降挂牌但收券' : '降挂牌收券对冲';
  return '混合';
}

function summarize(items, startDate, endDate) {
  const comparable = items.filter((row) => hasValidPrice(row, startDate) && hasValidPrice(row, endDate));
  const diffs = comparable.map((row) => {
    const start = snapshot(row, startDate);
    const end = snapshot(row, endDate);
    const finalDiff = end.finalPrice - start.finalPrice;
    const listDiff = end.listPrice - start.listPrice;
    const couponDiff = end.coupon - start.coupon;
    return {
      row,
      start,
      end,
      finalDiff,
      listDiff,
      couponDiff,
      lever: classifyLever(listDiff, couponDiff),
    };
  });
  const down = diffs.filter((item) => item.finalDiff <= -CHANGE_THRESHOLD).length;
  const up = diffs.filter((item) => item.finalDiff >= CHANGE_THRESHOLD).length;
  const leverCounts = new Map();
  for (const item of diffs) {
    leverCounts.set(item.lever, (leverCounts.get(item.lever) ?? 0) + 1);
  }

  return {
    n: diffs.length,
    startFinal: round(average(diffs.map((item) => item.start.finalPrice))),
    endFinal: round(average(diffs.map((item) => item.end.finalPrice))),
    finalDiff: round(average(diffs.map((item) => item.finalDiff))),
    listDiff: round(average(diffs.map((item) => item.listDiff))),
    couponDiff: round(average(diffs.map((item) => item.couponDiff))),
    down,
    up,
    flat: diffs.length - down - up,
    downPct: diffs.length ? round((down / diffs.length) * 100, 1) : 0,
    upPct: diffs.length ? round((up / diffs.length) * 100, 1) : 0,
    leverTop: Array.from(leverCounts.entries())
      .sort((left, right) => right[1] - left[1])
      .slice(0, 3)
      .map(([name, count]) => `${name}${count}`)
      .join(' / '),
  };
}

function buildTrend(rows, dates) {
  return dates
    .map((date) => {
      const values = rows.filter((row) => hasValidPrice(row, date)).map((row) => snapshot(row, date));
      return {
        date,
        n: values.length,
        finalPrice: round(average(values.map((item) => item.finalPrice))),
        listPrice: round(average(values.map((item) => item.listPrice))),
        coupon: round(average(values.map((item) => item.coupon))),
      };
    })
    .filter((item) => item.n > 0);
}

function summarizeBy(rows, getKey, startDate, endDate) {
  return groupBy(rows, getKey)
    .map(([name, items]) => ({ name, ...summarize(items, startDate, endDate) }))
    .sort((left, right) => right.n - left.n || left.name.localeCompare(right.name, 'zh-Hans-CN'));
}

function buildModelMovements(rows) {
  return groupBy(rows, (row) => row.model)
    .map(([model, items]) => {
      const full = summarize(items, START_DATE, END_DATE);
      const promo = summarize(items, PROMO_START_DATE, END_DATE);
      return {
        model,
        brand: inferBrand(items[0]?.model),
        position: items[0]?.position || '未定位',
        n: full.n,
        fullDiff: full.finalDiff,
        fullList: full.listDiff,
        fullCoupon: full.couponDiff,
        promoDiff: promo.finalDiff,
        promoList: promo.listDiff,
        promoCoupon: promo.couponDiff,
        promoLever: promo.leverTop,
      };
    })
    .filter((item) => item.n > 0);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function polyline(points) {
  return points.map((point) => `${round(point.x, 1)},${round(point.y, 1)}`).join(' ');
}

function trendSvg(data) {
  const width = 1120;
  const height = 410;
  const margin = { top: 34, right: 34, bottom: 62, left: 72 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const finalMin = Math.min(...data.map((item) => item.finalPrice)) - 80;
  const finalMax = Math.max(...data.map((item) => item.finalPrice)) + 80;
  const couponMin = Math.min(...data.map((item) => item.coupon)) - 40;
  const couponMax = Math.max(...data.map((item) => item.coupon)) + 40;
  const x = (index) => margin.left + (index / Math.max(data.length - 1, 1)) * plotWidth;
  const yFinal = (value) => margin.top + ((finalMax - value) / (finalMax - finalMin)) * plotHeight;
  const yCoupon = (value) => margin.top + ((couponMax - value) / (couponMax - couponMin)) * plotHeight;
  const finalPoints = data.map((item, index) => ({ x: x(index), y: yFinal(item.finalPrice) }));
  const couponPoints = data.map((item, index) => ({ x: x(index), y: yCoupon(item.coupon) }));

  return `
    <svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="老样本均到手价和优惠券趋势">
      <rect x="0" y="0" width="${width}" height="${height}" rx="18" fill="#ffffff"/>
      <g class="grid">
        ${[0, 0.25, 0.5, 0.75, 1]
          .map((ratio) => {
            const y = margin.top + ratio * plotHeight;
            const label = round(finalMax - ratio * (finalMax - finalMin));
            return `<line x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}"/><text x="${margin.left - 12}" y="${y + 4}" text-anchor="end">${label}</text>`;
          })
          .join('')}
      </g>
      <polyline points="${polyline(finalPoints)}" fill="none" stroke="#2563eb" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
      <polyline points="${polyline(couponPoints)}" fill="none" stroke="#f59e0b" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="8 8"/>
      ${data
        .map((item, index) => {
          const px = x(index);
          const labelY = index % 2 === 0 ? height - 34 : height - 18;
          return `
            <circle cx="${px}" cy="${yFinal(item.finalPrice)}" r="5" fill="#2563eb"/>
            <circle cx="${px}" cy="${yCoupon(item.coupon)}" r="4" fill="#f59e0b"/>
            <text x="${px}" y="${height - 44}" text-anchor="middle">${item.date}</text>
            <text x="${px}" y="${labelY}" text-anchor="middle" class="tiny">券${item.coupon}</text>
          `;
        })
        .join('')}
      <text x="${margin.left}" y="24" class="chart-title">均到手价趋势（蓝）与均优惠券趋势（橙色虚线）</text>
      <text x="${width - margin.right}" y="24" text-anchor="end" class="tiny">样本：3.16 和 6.16 均有效的老 SKU</text>
    </svg>
  `;
}

function barSvg(items, valueKey, labelKey, title) {
  const width = 1120;
  const rowHeight = 40;
  const margin = { top: 50, right: 126, bottom: 34, left: 156 };
  const height = margin.top + margin.bottom + rowHeight * items.length;
  const values = items.map((item) => item[valueKey]);
  const maxAbs = Math.max(...values.map((value) => Math.abs(value)), 1);
  const zeroX = margin.left + (width - margin.left - margin.right) / 2;
  const scale = (width - margin.left - margin.right) / 2 / maxAbs;
  return `
    <svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}">
      <rect x="0" y="0" width="${width}" height="${height}" rx="18" fill="#ffffff"/>
      <text x="${margin.left}" y="28" class="chart-title">${escapeHtml(title)}</text>
      <line x1="${zeroX}" y1="${margin.top - 12}" x2="${zeroX}" y2="${height - margin.bottom + 8}" stroke="#94a3b8" stroke-width="1"/>
      ${items
        .map((item, index) => {
          const value = item[valueKey];
          const y = margin.top + index * rowHeight;
          const barWidth = Math.abs(value) * scale;
          const x = value >= 0 ? zeroX : zeroX - barWidth;
          const color = value > 0 ? '#e11d48' : value < 0 ? '#059669' : '#64748b';
          return `
            <text x="${margin.left - 14}" y="${y + 22}" text-anchor="end">${escapeHtml(item[labelKey])}</text>
            <rect x="${x}" y="${y + 6}" width="${barWidth}" height="20" rx="6" fill="${color}" opacity="0.88"/>
            <text x="${value >= 0 ? x + barWidth + 8 : x - 8}" y="${y + 22}" text-anchor="${value >= 0 ? 'start' : 'end'}" class="value">${formatSigned(value)}</text>
          `;
        })
        .join('')}
    </svg>
  `;
}

function renderRows(rows, columns) {
  return rows
    .map(
      (row) => `
      <tr>
        ${columns
          .map((column) => {
            const value = column.format ? column.format(row[column.key], row) : row[column.key];
            return `<td class="${column.numeric ? 'numeric' : ''}">${escapeHtml(value)}</td>`;
          })
          .join('')}
      </tr>
    `,
    )
    .join('');
}

function tableHtml(rows, columns) {
  return `
    <div class="table-wrap">
      <table>
        <thead><tr>${columns.map((column) => `<th class="${column.numeric ? 'numeric' : ''}">${escapeHtml(column.label)}</th>`).join('')}</tr></thead>
        <tbody>${renderRows(rows, columns)}</tbody>
      </table>
    </div>
  `;
}

const draft = readDraft(dbPath);
const oldRows = draft.rows.filter((row) => hasValidPrice(row, START_DATE) && hasValidPrice(row, END_DATE));
const fullCoverageRows = draft.rows.filter((row) => draft.dates.every((date) => hasValidPrice(row, date)));
const trend = buildTrend(oldRows, KEY_DATES);
const trendAllDays = buildTrend(oldRows, draft.dates);
const minDay = trendAllDays.reduce((best, item) => (item.finalPrice < best.finalPrice ? item : best), trendAllDays[0]);
const maxDay = trendAllDays.reduce((best, item) => (item.finalPrice > best.finalPrice ? item : best), trendAllDays[0]);
const overallFull = summarize(oldRows, START_DATE, END_DATE);
const overallPre = summarize(oldRows, START_DATE, PROMO_START_DATE);
const overallPromo = summarize(oldRows, PROMO_START_DATE, END_DATE);
const brandFull = summarizeBy(oldRows, (row) => inferBrand(row.model), START_DATE, END_DATE);
const brandPromo = summarizeBy(oldRows, (row) => inferBrand(row.model), PROMO_START_DATE, END_DATE);
const positionPromo = summarizeBy(oldRows, (row) => row.position || '未定位', PROMO_START_DATE, END_DATE);
const modelMovements = buildModelMovements(oldRows);
const topPromoDrops = modelMovements.filter((item) => item.promoDiff < 0).sort((left, right) => left.promoDiff - right.promoDiff).slice(0, 8);
const topPromoUps = modelMovements.filter((item) => item.promoDiff > 0).sort((left, right) => right.promoDiff - left.promoDiff).slice(0, 5);

const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>老样本 SKU 价格趋势与 618 价格政策报告</title>
  <style>
    :root {
      --ink: #172033;
      --muted: #667085;
      --line: #d8dee8;
      --paper: #f7f8fb;
      --blue: #2563eb;
      --green: #059669;
      --rose: #e11d48;
      --amber: #f59e0b;
      --violet: #7c3aed;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--paper);
      color: var(--ink);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      line-height: 1.62;
    }
    .page {
      max-width: 1180px;
      margin: 0 auto;
      padding: 44px 28px 72px;
    }
    .hero {
      padding: 34px 36px;
      background: #fff;
      border: 1px solid var(--line);
      border-radius: 12px;
      box-shadow: 0 16px 36px rgba(23, 32, 51, 0.08);
    }
    .eyebrow {
      margin: 0 0 8px;
      color: var(--blue);
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0;
      text-transform: uppercase;
    }
    h1 {
      margin: 0;
      font-size: 34px;
      line-height: 1.16;
      letter-spacing: 0;
    }
    h2 {
      margin: 34px 0 14px;
      font-size: 23px;
      line-height: 1.28;
      letter-spacing: 0;
    }
    h3 {
      margin: 22px 0 10px;
      font-size: 17px;
      letter-spacing: 0;
    }
    p { margin: 10px 0; }
    .sub {
      color: var(--muted);
      margin-top: 12px;
      max-width: 900px;
    }
    .cards {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 14px;
      margin-top: 22px;
    }
    .card {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 16px;
      background: #ffffff;
    }
    .card .label {
      color: var(--muted);
      font-size: 13px;
    }
    .card .value {
      display: block;
      margin-top: 6px;
      font-size: 26px;
      line-height: 1.1;
      font-weight: 800;
    }
    .section {
      margin-top: 22px;
      padding: 24px 28px;
      background: #fff;
      border: 1px solid var(--line);
      border-radius: 12px;
    }
    .summary {
      display: grid;
      gap: 12px;
      padding-left: 20px;
    }
    .summary li { padding-left: 4px; }
    .callout {
      border-left: 4px solid var(--blue);
      background: #eff6ff;
      padding: 14px 16px;
      border-radius: 8px;
      color: #1e3a8a;
    }
    .chart {
      width: 100%;
      height: auto;
      border: 1px solid var(--line);
      border-radius: 12px;
      margin: 12px 0 4px;
      background: #fff;
    }
    .grid line { stroke: #e7ebf2; }
    .grid text, svg text {
      font-size: 13px;
      fill: #475467;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    }
    .chart-title {
      font-size: 17px;
      font-weight: 800;
      fill: var(--ink);
    }
    .tiny { font-size: 11px; fill: #667085; }
    .value { font-size: 13px; font-weight: 800; fill: #344054; }
    .table-wrap {
      overflow-x: auto;
      border: 1px solid var(--line);
      border-radius: 10px;
      margin-top: 12px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
      background: #fff;
    }
    th, td {
      padding: 10px 11px;
      border-bottom: 1px solid #edf1f6;
      vertical-align: top;
      white-space: nowrap;
    }
    th {
      background: #f2f5f9;
      color: #344054;
      text-align: left;
      font-weight: 800;
    }
    tr:last-child td { border-bottom: 0; }
    .numeric { text-align: right; font-variant-numeric: tabular-nums; }
    .pill-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 14px;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 5px 10px;
      font-size: 12px;
      color: #344054;
      background: #fff;
    }
    .footer {
      color: var(--muted);
      font-size: 12px;
      margin: 18px 4px 0;
    }
    @media (max-width: 860px) {
      .page { padding: 22px 14px 44px; }
      .hero, .section { padding: 20px 18px; }
      h1 { font-size: 26px; }
      .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      th, td { white-space: normal; }
    }
  </style>
</head>
<body>
  <main class="page">
    <header class="hero">
      <p class="eyebrow">GTM New Machine Price Monitor · HTML Anything Report</p>
      <h1>老样本 SKU 价格趋势与 618 价格政策报告</h1>
      <p class="sub">基于云端生产机 <strong>admin@8.162.25.246</strong> 拉取的 <strong>raw-editor-draft.sqlite</strong>。老样本口径为 <strong>${START_DATE}</strong> 与 <strong>${END_DATE}</strong> 均有有效挂牌价和到手价的 SKU。</p>
      <div class="cards">
        <div class="card"><span class="label">云端全量行数</span><span class="value">${draft.rows.length}</span></div>
        <div class="card"><span class="label">老样本 SKU</span><span class="value">${oldRows.length}</span></div>
        <div class="card"><span class="label">全 36 日有效</span><span class="value">${fullCoverageRows.length}</span></div>
        <div class="card"><span class="label">最新监测日</span><span class="value">${END_DATE}</span></div>
      </div>
    </header>

    <section class="section">
      <h2>Executive Summary</h2>
      <ul class="summary">
        <li><strong>老样本全周期是明显下探。</strong>${START_DATE} 到 ${END_DATE}，均到手价从 ${overallFull.startFinal} 降到 ${overallFull.endFinal}，净降 ${Math.abs(overallFull.finalDiff)}；但挂牌均值反而 ${formatSigned(overallFull.listDiff)}，优惠券 ${formatSigned(overallFull.couponDiff)}，说明主动作是加券压价。</li>
        <li><strong>价格最低点在 618 前半段。</strong>最低均到手价出现在 ${minDay.date}，为 ${minDay.finalPrice}；之后 ${END_DATE} 回到 ${overallFull.endFinal}，仍低于 3.16 基线。</li>
        <li><strong>618 专题不是全价位普降。</strong>${PROMO_START_DATE} 到 ${END_DATE} 均到手价再降 ${Math.abs(overallPromo.finalDiff)}；折叠和旗舰继续让利，中端和 REDMI 老样本出现收券回价。</li>
        <li><strong>品牌策略分化清楚。</strong>华为、一加、OPPO、荣耀是主要让利方；vivo 偏“抬挂牌但加券更多”；REDMI 在 618 段通过收券把到手价抬回去。</li>
      </ul>
    </section>

    <section class="section">
      <h2>趋势先在 5.28 打到底，618 后段小幅回收</h2>
      <p><strong>读图方式：</strong>蓝线是老样本均到手价，橙色虚线是均优惠券。3 月到 4 月挂牌价上移，5 月中旬开始优惠券快速抬升，到手价在 5.28 触底。</p>
      ${trendSvg(trend)}
      ${tableHtml(trend, [
        { key: 'date', label: '日期' },
        { key: 'n', label: '有效 SKU', numeric: true },
        { key: 'finalPrice', label: '均到手价', numeric: true },
        { key: 'listPrice', label: '均挂牌价', numeric: true },
        { key: 'coupon', label: '均优惠券', numeric: true },
      ])}
    </section>

    <section class="section">
      <h2>全周期主线：挂牌做锚点，优惠券承担真实让利</h2>
      <p>从 ${START_DATE} 到 ${END_DATE}，老样本整体到手价净降 ${Math.abs(overallFull.finalDiff)}。但挂牌价不是下行主因：均挂牌价 ${formatSigned(overallFull.listDiff)}，均优惠券 ${formatSigned(overallFull.couponDiff)}。也就是说，品牌更常用“保持或抬高挂牌价，再用券补贴”的方式管理价格感知。</p>
      ${barSvg(brandFull, 'finalDiff', 'name', '品牌老样本到手价变化：3.16 → 6.16')}
      ${tableHtml(brandFull, [
        { key: 'name', label: '品牌' },
        { key: 'n', label: 'SKU', numeric: true },
        { key: 'startFinal', label: '3.16 均到手', numeric: true },
        { key: 'endFinal', label: '6.16 均到手', numeric: true },
        { key: 'finalDiff', label: '到手变化', numeric: true, format: formatSigned },
        { key: 'listDiff', label: '挂牌变化', numeric: true, format: formatSigned },
        { key: 'couponDiff', label: '券变化', numeric: true, format: formatSigned },
        { key: 'downPct', label: '降价占比', numeric: true, format: formatPct },
        { key: 'leverTop', label: '主要手法' },
      ])}
    </section>

    <section class="section">
      <h2>618 价格政策：高端真打，中低端更偏控价</h2>
      <p>618 段从 ${PROMO_START_DATE} 到 ${END_DATE}，整体均到手价继续下降 ${Math.abs(overallPromo.finalDiff)}，但定位差异很大：折叠机净降 ${Math.abs(positionPromo.find((item) => item.name === '折叠')?.finalDiff ?? 0)}，旗舰净降 ${Math.abs(positionPromo.find((item) => item.name === '旗舰')?.finalDiff ?? 0)}；中端则净涨 ${positionPromo.find((item) => item.name === '中端')?.finalDiff ?? 0}。</p>
      ${barSvg(positionPromo, 'finalDiff', 'name', '定位维度 618 到手价变化：5.15 → 6.16')}
      ${tableHtml(brandPromo, [
        { key: 'name', label: '品牌' },
        { key: 'n', label: 'SKU', numeric: true },
        { key: 'startFinal', label: '5.15 均到手', numeric: true },
        { key: 'endFinal', label: '6.16 均到手', numeric: true },
        { key: 'finalDiff', label: '618 到手变化', numeric: true, format: formatSigned },
        { key: 'listDiff', label: '挂牌变化', numeric: true, format: formatSigned },
        { key: 'couponDiff', label: '券变化', numeric: true, format: formatSigned },
        { key: 'downPct', label: '降价占比', numeric: true, format: formatPct },
        { key: 'leverTop', label: '618 主要手法' },
      ])}
    </section>

    <section class="section">
      <h2>机型层面：华为高端、折叠和 OPPO 旗舰是让利核心</h2>
      <p><strong>618 让利最大的机型</strong>集中在华为 Mate 80 Pro、华为 Mate X7、vivo X Fold 5、iQOO 15、OPPO Find X9 系列；相反，REDMI K90、REDMI Turbo 5 Max、iQOO Neo11 更像是收券回价。</p>
      <h3>618 降价 TOP</h3>
      ${tableHtml(topPromoDrops, [
        { key: 'model', label: '机型' },
        { key: 'brand', label: '品牌' },
        { key: 'position', label: '定位' },
        { key: 'n', label: 'SKU', numeric: true },
        { key: 'promoDiff', label: '到手变化', numeric: true, format: formatSigned },
        { key: 'promoList', label: '挂牌变化', numeric: true, format: formatSigned },
        { key: 'promoCoupon', label: '券变化', numeric: true, format: formatSigned },
        { key: 'promoLever', label: '政策' },
      ])}
      <h3>618 回价 TOP</h3>
      ${tableHtml(topPromoUps, [
        { key: 'model', label: '机型' },
        { key: 'brand', label: '品牌' },
        { key: 'position', label: '定位' },
        { key: 'n', label: 'SKU', numeric: true },
        { key: 'promoDiff', label: '到手变化', numeric: true, format: formatSigned },
        { key: 'promoList', label: '挂牌变化', numeric: true, format: formatSigned },
        { key: 'promoCoupon', label: '券变化', numeric: true, format: formatSigned },
        { key: 'promoLever', label: '政策' },
      ])}
    </section>

    <section class="section">
      <h2>建议动作</h2>
      <div class="callout"><strong>经营判断：</strong>后续看 618 后复盘，不要只看挂牌价，要同时看优惠券变化。这个样本里，价格政策的真实方向主要藏在券里。</div>
      <div class="pill-row">
        <span class="pill">重点跟踪：华为 Mate 80 Pro</span>
        <span class="pill">重点跟踪：华为 Mate X7</span>
        <span class="pill">重点跟踪：OPPO Find X9</span>
        <span class="pill">风险监控：REDMI 收券回价</span>
        <span class="pill">策略拆分：折叠 / 旗舰 / 中低端</span>
      </div>
      <p>建议下一步把老样本和 5.26 后新增样本分开监控：老样本适合看价格政策变化，新样本更适合看新品入市定价和后续促销节奏。</p>
    </section>

    <p class="footer">数据源：SSH 拉取的生产 SQLite，路径 /www/wwwroot/gtm-price-monitor/data/raw-editor-draft.sqlite；生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}。口径：有效价格为挂牌价与到手价均大于 0。</p>
  </main>
</body>
</html>`;

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, html);
console.log(outputPath);
