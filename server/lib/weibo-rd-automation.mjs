import { spawn } from 'node:child_process';

const DEFAULT_WEIBO_UID = '7928198622';
const DEFAULT_LOOKBACK_DAYS = 21;
const DEFAULT_TIMEOUT_MS = 8 * 60 * 1000;
const RESULT_MARKER = '__RD_WEIBO_RESULT__';

export const MARKET_SHARE_BRANDS = [
  '苹果',
  '小米',
  'vivo总(含iQOO)',
  '华为',
  'OPPO总(含一加、realme)',
  '荣耀',
];

const BRAND_LABEL_MAP = new Map([
  ['苹果', '苹果'],
  ['小米', '小米'],
  ['华为', '华为'],
  ['荣耀', '荣耀'],
  ['vivo', 'vivo总(含iQOO)'],
  ['oppo', 'OPPO总(含一加、realme)'],
]);

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeModel(value) {
  return String(value ?? '')
    .replace(/[（(]\s*新增\s*[）)]/g, '')
    .replace(/\s+/g, '')
    .trim()
    .toLowerCase();
}

function round(value, digits = 4) {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function parsePeriod(content) {
  const matched = String(content ?? '').match(/\b(20\d{2})\s*(?:年)?\s*W(5[0-3]|[1-4]\d|[1-9])\b/i);
  if (!matched) {
    return null;
  }
  return { year: Number(matched[1]), weekIndex: Number(matched[2]), weekLabel: `W${Number(matched[2])}` };
}

export function parseMarketChange(text) {
  const explicit = String(text ?? '').match(/(上涨|增长|上升|下降|下跌|减少)\s*(?:约|近|超)?\s*([0-9]+(?:\.[0-9]+)?)\s*%/);
  if (explicit) {
    const direction = /上涨|增长|上升/.test(explicit[1]) ? 1 : -1;
    return direction * Number(explicit[2]) / 100;
  }

  const qualitative = String(text ?? '').match(/(略微|小幅|微幅|轻微)\s*(上涨|增长|上升|下降|下跌|减少)/);
  if (qualitative) {
    return /上涨|增长|上升/.test(qualitative[2]) ? 0.05 : -0.05;
  }
  if (/持平|基本不变/.test(String(text ?? ''))) {
    return 0;
  }
  return null;
}

function normalizePost(post) {
  const content = String(post?.content ?? '').trim();
  const postUrl = String(post?.post_url ?? post?.postUrl ?? '').trim();
  if (!content || !postUrl) {
    return null;
  }
  return {
    id: String(post?.id ?? postUrl),
    publishedAt: String(post?.published_at ?? post?.publishedAt ?? '').trim(),
    content,
    postUrl,
    type: String(post?.type ?? 'original'),
    isTop: Boolean(post?.is_top ?? post?.isTop),
    imageUrls: Array.isArray(post?.image_urls) ? post.image_urls.map(String) : [],
    videoUrl: post?.video_url ? String(post.video_url) : null,
    reposts: Number.isFinite(Number(post?.reposts)) ? Number(post.reposts) : null,
    comments: Number.isFinite(Number(post?.comments)) ? Number(post.comments) : null,
    likes: Number.isFinite(Number(post?.likes)) ? Number(post.likes) : null,
  };
}

function parseSalesRecords(posts, warnings) {
  const records = new Map();
  for (const post of posts) {
    const period = parsePeriod(post.content);
    if (!period) {
      continue;
    }

    for (const line of post.content.split(/\r?\n/)) {
      const matched = line.match(/^\s*(.+?)\s+约\s*([0-9]+(?:\.[0-9]+)?)万(?:台)?/);
      if (!matched) {
        continue;
      }
      const rawModelName = matched[1].trim();
      const cumulativeSales = Number(matched[2]);
      const key = `${period.year}|${period.weekIndex}|${normalizeModel(rawModelName)}`;
      const existing = records.get(key);
      if (existing && existing.cumulativeSales !== cumulativeSales) {
        warnings.push(
          `${period.year} ${period.weekLabel} ${rawModelName} 出现多个累计销量：${existing.cumulativeSales}、${cumulativeSales}，保留较新微博值`,
        );
        continue;
      }
      if (!existing) {
        records.set(key, {
          ...period,
          rawModelName,
          cumulativeSales,
          evidenceText: line.trim(),
          sourcePostUrl: post.postUrl,
          publishedAt: post.publishedAt,
        });
      }
    }
  }
  return [...records.values()].sort(
    (left, right) => left.year - right.year || left.weekIndex - right.weekIndex || left.rawModelName.localeCompare(right.rawModelName, 'zh-CN'),
  );
}

function parseMarketSharePosts(posts, warnings) {
  const extracted = new Map();
  for (const post of posts) {
    if (!/国内手机市场份额/i.test(post.content) || !/Sell\s*out/i.test(post.content)) {
      continue;
    }
    const period = parsePeriod(post.content);
    if (!period) {
      continue;
    }

    const lines = post.content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const marketNote = lines.find((line) => /本周大盘/.test(line)) ?? '';
    const marketChange = parseMarketChange(marketNote);
    const brandShares = {};
    for (const line of lines) {
      const matched = line.match(/^\d+[.、]\s*(华为|OPPO|vivo|苹果|小米|荣耀)\s*([0-9]+(?:\.[0-9]+)?)\s*%/i);
      if (!matched) {
        continue;
      }
      const normalizedBrand = BRAND_LABEL_MAP.get(matched[1].toLowerCase()) ?? BRAND_LABEL_MAP.get(matched[1]);
      if (normalizedBrand) {
        brandShares[normalizedBrand] = Number(matched[2]);
      }
    }

    const missingBrands = MARKET_SHARE_BRANDS.filter((brand) => !Number.isFinite(brandShares[brand]));
    if (missingBrands.length > 0) {
      warnings.push(`${period.year} ${period.weekLabel} 品牌份额不完整，跳过：${missingBrands.join('、')}`);
      continue;
    }
    if (marketChange === null && !(period.year === 2026 && period.weekIndex === 26)) {
      warnings.push(`${period.year} ${period.weekLabel} 未识别大盘环比，暂不计算总量指数`);
    }

    const totalKnownShare = MARKET_SHARE_BRANDS.reduce((sum, brand) => sum + brandShares[brand], 0);
    brandShares.Others = round(100 - totalKnownShare, 4);
    const key = `${period.year}|${period.weekIndex}`;
    if (!extracted.has(key)) {
      extracted.set(key, {
        ...period,
        marketNote,
        marketChange,
        brandShares,
        sourcePostUrl: post.postUrl,
        publishedAt: post.publishedAt,
      });
    }
  }

  const byYear = new Map();
  for (const record of extracted.values()) {
    const records = byYear.get(record.year) ?? [];
    records.push(record);
    byYear.set(record.year, records);
  }

  const result = [];
  for (const [year, yearRecords] of byYear) {
    const sorted = yearRecords.sort((left, right) => left.weekIndex - right.weekIndex);
    let previous = null;
    for (const record of sorted) {
      let totalIndex = null;
      if (year === 2026 && record.weekIndex === 26) {
        totalIndex = 90.4;
      } else if (previous && previous.weekIndex === record.weekIndex - 1 && Number.isFinite(record.marketChange)) {
        totalIndex = round(previous.totalIndex * (1 + record.marketChange), 1);
      }
      if (totalIndex === null) {
        warnings.push(`${year} ${record.weekLabel} 缺少连续基数，未生成总量指数`);
      } else {
        result.push({ ...record, totalIndex });
        previous = { weekIndex: record.weekIndex, totalIndex };
      }
    }
  }
  return result.sort((left, right) => left.year - right.year || left.weekIndex - right.weekIndex);
}

export function parseRdWeiboPosts(input) {
  const rawPosts = Array.isArray(input) ? input : input?.posts;
  const posts = (Array.isArray(rawPosts) ? rawPosts : []).map(normalizePost).filter(Boolean);
  if (posts.length === 0) {
    throw new Error('Browser Use 未返回可用微博内容，可能是登录失效或抓取失败');
  }
  const uniquePosts = [...new Map(posts.map((post) => [post.postUrl, post])).values()];
  const warnings = [];
  return {
    posts: uniquePosts,
    salesRecords: parseSalesRecords(uniquePosts, warnings),
    marketWeeks: parseMarketSharePosts(uniquePosts, warnings),
    warnings,
  };
}

export function buildSalesWideTables(records) {
  const byYear = new Map();
  for (const record of records) {
    const list = byYear.get(record.year) ?? [];
    list.push(record);
    byYear.set(record.year, list);
  }

  return [...byYear.entries()].sort(([left], [right]) => left - right).map(([year, yearRecords]) => {
    const weeks = [...new Set(yearRecords.map((record) => record.weekIndex))].sort((left, right) => left - right);
    const models = new Map();
    for (const record of yearRecords) {
      const model = models.get(record.rawModelName) ?? new Map();
      model.set(record.weekIndex, record.cumulativeSales);
      models.set(record.rawModelName, model);
    }
    const rows = [
      ['型号/系列', ...weeks.map((week) => `W${week}`)],
      ...[...models.entries()].map(([modelName, values]) => [modelName, ...weeks.map((week) => values.get(week) ?? '')]),
    ];
    return {
      year,
      weeks: weeks.map((week) => `W${week}`),
      modelCount: models.size,
      rawText: rows.map((row) => row.join('\t')).join('\n'),
    };
  });
}

function buildCliScraperScript({ uid, lookbackDays }) {
  return `
import json
import time
from datetime import datetime, timedelta, timezone

uid = ${JSON.stringify(uid)}
lookback_days = ${Number(lookbackDays)}
start_ms = int((datetime.now(timezone.utc) - timedelta(days=lookback_days)).timestamp() * 1000)
tab_id = None

try:
    tab_id = new_tab(f"https://weibo.com/u/{uid}?tabtype=feed")
    wait_for_load()
    js(f"""
    (() => {{
      const state = window.__gtmWeiboScrape = {{ status: 'running', payload: null, error: null }};
      (async () => {{
        try {{
      const uid = {json.dumps(uid)};
      const start = {start_ms};
      const end = Date.now();
      const statuses = [];

      for (let page = 1; page <= 15; page++) {{
        const response = await fetch(\`/ajax/statuses/mymblog?uid=\${{uid}}&page=\${{page}}&feature=0\`);
        if (!response.ok) throw new Error(\`page \${{page}}: HTTP \${{response.status}}\`);
        const body = await response.json();
        const list = body.data?.list;
        if (!Array.isArray(list)) throw new Error('登录失效、出现验证码或微博接口结构异常');
        if (list.length === 0) break;
        statuses.push(...list);
        const regularDates = list.filter(item => !item.isTop).map(item => Date.parse(item.created_at)).filter(Number.isFinite);
        if (regularDates.length > 0 && Math.min(...regularDates) < start) break;
      }}

      const unique = [...new Map(statuses
        .filter(item => {{
          const timestamp = Date.parse(item.created_at);
          return timestamp >= start && timestamp <= end;
        }})
        .map(item => [item.idstr, item])).values()];

      function plainText(html) {{
        const element = document.createElement('div');
        element.innerHTML = html || '';
        return element.innerText;
      }}

      const posts = [];
      for (const item of unique) {{
        let content = item.text_raw || plainText(item.text);
        if (item.isLongText) {{
          const longResponse = await fetch(\`/ajax/statuses/longtext?id=\${{item.mblogid}}\`);
          if (longResponse.ok) {{
            const longBody = await longResponse.json();
            content = longBody.data?.longTextContent_raw || plainText(longBody.data?.longTextContent) || content;
          }}
        }}
        const imageUrls = Object.values(item.pic_infos || {{}})
          .map(info => info.largest?.url || info.original?.url || info.large?.url || info.thumbnail?.url)
          .filter(Boolean);
        const mediaInfo = item.page_info?.media_info || {{}};
        posts.push({{
          id: item.idstr,
          published_at: item.created_at,
          type: item.retweeted_status ? 'repost' : 'original',
          is_top: Boolean(item.isTop),
          content,
          post_url: \`https://weibo.com/\${{uid}}/\${{item.mblogid}}\`,
          image_urls: imageUrls,
          video_url: mediaInfo.stream_url_hd || mediaInfo.stream_url || mediaInfo.mp4_720p_mp4 || mediaInfo.mp4_hd_url || null,
          reposts: Number.isFinite(item.reposts_count) ? item.reposts_count : null,
          comments: Number.isFinite(item.comments_count) ? item.comments_count : null,
          likes: Number.isFinite(item.attitudes_count) ? item.attitudes_count : null
        }});
      }}
      posts.sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
          state.payload = JSON.stringify({{ posts }});
          state.status = 'success';
        }} catch (error) {{
          state.error = error?.message || String(error);
          state.status = 'failed';
        }}
      }})();
      return true;
    }})()
    """)
    payload = None
    for _ in range(240):
        raw_state = js("JSON.stringify(window.__gtmWeiboScrape || null)")
        state = json.loads(raw_state) if raw_state else None
        if state and state.get("status") == "success":
            payload = state.get("payload")
            break
        if state and state.get("status") == "failed":
            raise RuntimeError(state.get("error") or "微博页面采集失败")
        time.sleep(1)
    if not payload:
        raise RuntimeError("微博页面采集超过 4 分钟")
    print(${JSON.stringify(RESULT_MARKER)} + payload)
finally:
    if tab_id:
        cdp("Target.closeTarget", targetId=tab_id)
`;
}

function runBrowserUseCli({ binary, script, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Browser Use CLI 执行超过 ${Math.round(timeoutMs / 60000)} 分钟`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(new Error(`Browser Use CLI 启动失败：${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `Browser Use CLI 退出码 ${code}`));
        return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin.end(script);
  });
}

export function createBrowserUseCliClient(options = {}) {
  const binary = String(options.binary ?? process.env.BROWSER_USE_CLI_PATH ?? 'browser-use');
  const timeoutMs = Number(options.timeoutMs ?? process.env.BROWSER_USE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const uid = String(options.uid ?? process.env.WEIBO_SOURCE_UID ?? DEFAULT_WEIBO_UID);
  const lookbackDays = Number(options.lookbackDays ?? process.env.WEIBO_LOOKBACK_DAYS ?? DEFAULT_LOOKBACK_DAYS);

  async function collectPosts({ onStatus } = {}) {
    await onStatus?.({ phase: 'scraping_weibo' });
    const result = await runBrowserUseCli({
      binary,
      script: buildCliScraperScript({ uid, lookbackDays }),
      env: {},
      timeoutMs,
    });
    const markerIndex = result.stdout.lastIndexOf(RESULT_MARKER);
    if (markerIndex < 0) {
      throw new Error('Browser Use CLI 未返回微博结构化结果');
    }
    const payloadText = result.stdout.slice(markerIndex + RESULT_MARKER.length).trim().split(/\r?\n/)[0];
    const payload = JSON.parse(payloadText);
    if (!Array.isArray(payload?.posts)) {
      throw new Error('Browser Use CLI 返回结果缺少 posts 数组');
    }
    return { posts: payload.posts, mode: 'local' };
  }

  return {
    configured: true,
    configurationError: '',
    mode: 'local',
    collectPosts,
  };
}
