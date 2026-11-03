#!/usr/bin/env python3
"""Read the Feishu Android dashboard snapshots without executing downloaded JS.

Standard library only. Run --help; see docs/android-e2e-integration.md.
"""
import argparse
import concurrent.futures
from datetime import datetime, timezone
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request

BASE = "https://atrenew.feishu.link/app/app_17h053qz13d/"
TASK = "验证安卓看板HTTP并导出JSON"
SOURCES = {
    "PRICE_DATA": "price-data.js",
    "S4_DATA": "s4-price.js",
    "TK_DATA": "tk-data.js",
    "LISTING_DATA": "listing-dates.js",
    "BOARD_DATA": "app.js",
}
OUTPUTS = {k: k.lower() + ".json" for k in SOURCES}


class DataError(ValueError):
    pass


def allowed_response_url(url, final_url):
    old, new = urllib.parse.urlsplit(url), urllib.parse.urlsplit(final_url)
    if (old.scheme, old.netloc) == (new.scheme, new.netloc):
        return True
    app = re.search(r"/app/(app_[A-Za-z0-9_-]+)", old.path)
    return bool(app and new.scheme == "https" and
                new.netloc == "lf-miaoda-compiled-static.feishucdn.com" and
                new.path.startswith('/' + app.group(1) + '/'))


class SameOriginRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        old, new = urllib.parse.urlsplit(req.full_url), urllib.parse.urlsplit(newurl)
        if not allowed_response_url(req.full_url, newurl):
            raise DataError("请求跳转到其他站点（可能需要登录），已停止；请使用 --browser 或提供有效 Cookie。")
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        if redirected and (old.scheme, old.netloc) != (new.scheme, new.netloc):
            for name in ("Cookie", "Authorization"):
                redirected.remove_header(name)
        return redirected


def check_response(url, final_url, content_type, body):
    if not allowed_response_url(url, final_url):
        raise DataError("请求跳转到其他域名（可能是登录页）；请使用 --browser 或提供有效 Cookie。")
    head = body.lstrip()[:200].lower()
    if "text/html" in content_type.lower() or head.startswith((b"<!doctype", b"<html")):
        raise DataError("收到 HTML 而不是数据脚本（可能是登录页）。HTTP 200 不代表数据读取成功。")
    if not body:
        raise DataError("响应为空")


def parse_assignment(text, symbol):
    """Decode only the JSON literal following an assignment; never eval JS."""
    pattern = re.compile(r"(?:\bwindow\s*\.\s*|\b(?:var|let|const)\s+)"
                         + re.escape(symbol) + r"\s*=\s*")
    match = pattern.search(text.lstrip("\ufeff"))
    if not match:
        raise DataError(f"未找到 {symbol} 的 JSON 赋值")
    text = text.lstrip("\ufeff")
    try:
        obj, _ = json.JSONDecoder(parse_constant=lambda x: fail_constant(x)).raw_decode(text, match.end())
    except ValueError as exc:
        raise DataError(f"{symbol} 不是严格 JSON: {exc}") from exc
    if not isinstance(obj, dict) or not isinstance(obj.get("models"), (dict, list)):
        raise DataError(f"{symbol} 缺少有效 models")
    return obj


def fail_constant(value):
    raise ValueError(f"不支持非 JSON 数值 {value}")


def fetch_http(base, directory, args):
    if args.cookie_file:
        cookie = Path(args.cookie_file).read_text().strip()
        if "\n" in cookie or "\r" in cookie:
            raise DataError("Cookie 文件应仅包含单行 Cookie 请求头的值")
    else:
        cookie = os.environ.get("ANDROID_E2E_COOKIE", "")
    jar = None
    if args.cookie_jar:
        jar = http.cookiejar.MozillaCookieJar(args.cookie_jar)
        jar.load(ignore_discard=True, ignore_expires=False)

    def download(item):
        symbol, filename = item
        url = base + filename
        # Each request has its own opener and cookie jar: no concurrent mutation.
        handlers = [SameOriginRedirect()]
        if jar is not None:
            local_jar = http.cookiejar.CookieJar()
            for c in jar:
                local_jar.set_cookie(c)
            handlers.append(urllib.request.HTTPCookieProcessor(local_jar))
        opener = urllib.request.build_opener(*handlers)
        headers = {"User-Agent": "android-e2e-json-export/1.0", "Accept": "application/javascript"}
        if cookie:
            headers["Cookie"] = cookie
        with opener.open(urllib.request.Request(url, headers=headers), timeout=args.timeout) as r:
            body = r.read()
            check_response(url, r.url, r.headers.get("Content-Type", ""), body)
            record = {"file": filename, "status": r.status,
                      "content_type": r.headers.get("Content-Type"), "bytes": len(body)}
        parse_assignment(body.decode("utf-8-sig"), symbol)
        (directory / filename).write_bytes(body)
        print(f"HTTP OK {filename}: {len(body):,} bytes", flush=True)
        return record

    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        return list(pool.map(download, SOURCES.items()))


def ego(code, timeout):
    result = subprocess.run(["ego-browser", "nodejs"], input=code, text=True, timeout=timeout)
    if result.returncode:
        raise DataError("ego-browser 执行失败；请查看上方错误。若用户接管，需确认继续后使用 --resume-login。")


def fetch_browser(base, directory, args):
    """Reuse normal browser authentication; never extract session credentials."""
    select = "takeOverTaskSpace" if args.resume_login else "useOrCreateTaskSpace"
    code = f"""
const task = await {select}({json.dumps(TASK)});
cliLog(task);
await openOrReuseTab({json.dumps(base.rstrip('/'))}, {{wait:true,timeout:25}});
const info=await pageInfo();
if (!info.url || new URL(info.url).hostname !== new URL({json.dumps(base)}).hostname) {{
  await handOffTaskSpace(task.id);
  throw new Error('请在浏览器完成登录，确认继续后运行同一命令并增加 --resume-login');
}}
const fs=await import('node:fs/promises');
const reports=[];
for (const file of {json.dumps(list(SOURCES.values()))}) {{
  const url={json.dumps(base)}+file;
  const expression='(async()=>{{const r=await fetch('+JSON.stringify(url)+
    ',{{signal:AbortSignal.timeout(20000)}});window.__androidE2eAssetText=await r.text();return '+
    '{{status:r.status,url:r.url,type:r.headers.get("content-type"),length:window.__androidE2eAssetText.length,'+
    'head:window.__androidE2eAssetText.slice(0,200)}}}})()';
  const r=await js(expression);
  const final=new URL(r.url), origin=new URL(url);
  const app=origin.pathname.match(/\\/app\\/(app_[A-Za-z0-9_-]+)/);
  const allowed=final.origin===origin.origin || (final.protocol==='https:' &&
    final.hostname==='lf-miaoda-compiled-static.feishucdn.com' &&
    app && final.pathname.startsWith('/'+app[1]+'/'));
  if (r.status!==200 || /text\\/html/i.test(r.type||'') || /^\\s*</.test(r.head) || !allowed) {{
    throw new Error(file+': 未返回预期脚本，可能需要登录');
  }}
  // Keep CDP results bounded: app.js alone exceeds 80 MB.
  const handle=await fs.open({json.dumps(str(directory))}+'/'+file,'w');
  let bytes=0;
  try {{
    for(let offset=0;offset<r.length;offset+=1000000) {{
      const chunk=await js('window.__androidE2eAssetText.slice('+offset+','+Math.min(offset+1000000,r.length)+')');
      // UTF-16 slicing must not split a surrogate pair before UTF-8 encoding.
      const next=offset+1000000;
      let text=chunk;
      if(offset>0) {{
        const first=text.charCodeAt(0);
        if(first>=0xDC00&&first<=0xDFFF)text=text.slice(1);
      }}
      const last=text.charCodeAt(text.length-1);
      if(next<r.length&&last>=0xD800&&last<=0xDBFF) {{
        text+=await js('window.__androidE2eAssetText.slice('+next+','+(next+1)+')');
      }}
      const buffer=Buffer.from(text,'utf8');
      await handle.writeFile(buffer);bytes+=buffer.length;
    }}
  }} finally {{await handle.close();}}
  await js('window.__androidE2eAssetText=null');
  reports.push({{file,status:r.status,content_type:r.type,bytes}});
  cliLog({{file,status:r.status,content_type:r.type,bytes}});
}}
await fs.writeFile({json.dumps(str(directory / 'http-report.json'))},JSON.stringify(reports));
"""
    ego(code, max(args.timeout, 240))
    return json.loads((directory / "http-report.json").read_text())


def model_rows(board, listing):
    brands = board["meta"]["brands"]
    return [{"model_index": i, "model": m["n"], "brand": brands[m["b"]],
             "tag_mask": m["t"], "listing_date": listing["models"].get(m["n"])}
            for i, m in enumerate(board["models"])]


def daily_rows(board, models, date=None, model=None):
    fields = {
        "inv": ["inventory", "daily_sales_3d", "daily_sales_7d", "purchase_sales_ratio_3d", "purchase_sales_ratio_7d"],
        "flow": ["submit_self", "submit_other_bd", "submit_jd_recycle", "submit_jd_tradein"],
        "order": ["deal_self", "deal_other_bd", "deal_jd_recycle", "deal_jd_tradein"],
        "sales": ["sales_toc", "sales_tob", "sales_unknown"],
        "delivery": ["backlog_estimated", "delivery_days_sum", "delivered_count"],
    }
    dates = board["meta"]["dates"]
    if date and date not in dates:
        raise DataError(f"日期 {date} 不在数据日期轴中")
    if model and model not in {m["model"] for m in models}:
        raise DataError(f"未知型号: {model}")
    result = []
    for di, day in enumerate(dates):
        if date and day != date:
            continue
        merged = {}
        for source, columns in fields.items():
            if len(board[source]) != len(dates):
                raise DataError(f"{source} 日期轴长度不匹配")
            seen = set()
            for row in board[source][di]:
                if len(row) != len(columns) + 1:
                    raise DataError(f"{source}/{day} 行宽发生变化")
                mi = row[0]
                if not isinstance(mi, int) or mi < 0 or mi >= len(models) or mi in seen:
                    raise DataError(f"{source}/{day} 型号索引重复或无效: {mi}")
                seen.add(mi)
                m = models[mi]
                if model and m["model"] != model:
                    continue
                if mi not in merged:
                    merged[mi] = {"date": day, **m, **{c: None for cols in fields.values() for c in cols}}
                merged[mi].update(zip(columns, row[1:]))
        result.extend(merged.values())
    return result


def quality_report(data):
    """Report source array inconsistencies; keep raw values unchanged."""
    issues = []
    counts = {}
    def check(path, variant, axis, fields):
        for field in fields:
            if field in variant and len(variant[field]) != len(variant.get(axis, [])):
                key = path.split('/')[0] + '.' + field
                counts[key] = counts.get(key, 0) + 1
                if counts[key] <= 3 and len(issues) < 30:
                    issues.append({"path": path, "axis": axis, "field": field,
                                   "dates": len(variant.get(axis, [])), "values": len(variant[field])})
    for name, model in data["PRICE_DATA"]["models"].items():
        for source, variants in model.items():
            for key, variant in variants.items():
                if source == 's1':
                    check(f"s1/{name}/{key}", variant, "d", ["p1", "p1b", "dq"])
                    check(f"s1/{name}/{key}", variant, "dc", ["base", "item", "dqc"])
                else:
                    check(f"{source}/{name}/{key}", variant, "d",
                          [k for k, v in variant.items() if isinstance(v, list) and k != 'd'])
    for name, variants in data["S4_DATA"]["models"].items():
        for key, variant in variants.items():
            check(f"s4/{name}/{key}", variant, "d", ["bprice", "cprice", "dq", "dqTob", "dqToc"])
    return {"array_length_mismatches": counts, "examples": issues,
            "policy": "原始 JSON 保留全部源值；价格日期轴不一致时不得截断或推测对应日期。缺失字段与数值0分开。"}


def write_json(path, value):
    with path.open("w", encoding="utf-8") as f:
        json.dump(value, f, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        f.write("\n")


def main():
    p = argparse.ArgumentParser(description=__doc__)
    mode = p.add_mutually_exclusive_group()
    mode.add_argument("--browser", action="store_true", help="使用已登录的 ego-browser，无需导出 Cookie")
    mode.add_argument("--source-dir", type=Path, help="解析本地五份 JS 文件")
    mode.add_argument("--runtime-json", type=Path, help="解析含五个全局数据对象的 JSON 导出")
    p.add_argument("--resume-login", action="store_true", help="用户确认登录完成后接回本脚本交接的浏览器；配合 --browser")
    auth = p.add_mutually_exclusive_group()
    auth.add_argument("--cookie-file", help="单行 Cookie 请求头值文件；不要提交到 Git")
    auth.add_argument("--cookie-jar", help="Netscape 格式 Cookie 文件")
    p.add_argument("--base-url", default=BASE)
    p.add_argument("--timeout", type=int, default=60)
    p.add_argument("--date", help="仅筛选 daily.json；原始五份 JSON 始终完整")
    p.add_argument("--model", help="仅筛选 daily.json，要求精确型号名")
    p.add_argument("--output-dir", type=Path)
    args = p.parse_args()
    if args.resume_login and not args.browser:
        p.error("--resume-login 必须配合 --browser")
    now = datetime.now(timezone.utc)
    root = Path(__file__).resolve().parent.parent
    out = args.output_dir or root / "data/android-e2e" / now.strftime("%Y%m%dT%H%M%S.%fZ")
    if out.exists() and any(out.iterdir()):
        raise DataError(f"输出目录非空，不覆盖已有文件: {out}")
    base = args.base_url.rstrip('/') + '/'
    report = []
    if args.runtime_json:
        data = json.loads(args.runtime_json.read_text())
    else:
        directory = args.source_dir
        if directory is None:
            directory = Path(tempfile.mkdtemp(prefix="android-e2e-"))
            print(f"源文件临时目录（保留供检查）: {directory}", flush=True)
            report = fetch_browser(base, directory, args) if args.browser else fetch_http(base, directory, args)
        data = {symbol: parse_assignment((directory / filename).read_text(encoding="utf-8-sig"), symbol)
                for symbol, filename in SOURCES.items()}
    for symbol in SOURCES:
        if not isinstance(data.get(symbol), dict) or "models" not in data[symbol]:
            raise DataError(f"缺少数据对象 {symbol}")
    board = data["BOARD_DATA"]
    models = model_rows(board, data["LISTING_DATA"])
    daily = daily_rows(board, models, args.date, args.model)
    quality = quality_report(data)
    out.mkdir(parents=True, exist_ok=True)
    for symbol, filename in OUTPUTS.items():
        write_json(out / filename, data[symbol])
    write_json(out / "models.json", models)
    write_json(out / "daily.json", daily)
    write_json(out / "data-quality.json", quality)
    manifest = {"schema_version": 1, "exported_at": now.isoformat(), "base_url": base,
                "transport": "browser" if args.browser else "runtime-json" if args.runtime_json else "local" if args.source_dir else "http",
                "date_range": [board["meta"]["dates"][0], board["meta"]["dates"][-1]],
                "model_count": len(models), "daily_rows": len(daily),
                "daily_filters": {"date": args.date, "model": args.model},
                "http_checks": report, "quality_warning_count": sum(quality['array_length_mismatches'].values()),
                "files": {f.name: {"bytes": f.stat().st_size, "sha256": hashlib.sha256(f.read_bytes()).hexdigest()}
                          for f in sorted(out.glob("*.json"))}}
    # Manifest is written last: consumers should use only exports with a manifest.
    write_json(out / "manifest.json", manifest)
    print(json.dumps({"output_dir": str(out.resolve()), "date_range": manifest["date_range"],
                      "models": len(models), "daily_rows": len(daily),
                      "quality_warnings": manifest["quality_warning_count"]}, ensure_ascii=False), flush=True)
    if args.browser:
        ego(f"cliLog(await completeTaskSpace({json.dumps(TASK)}, {{keep:false}}));", 30)


if __name__ == "__main__":
    try:
        main()
    except (DataError, OSError, ValueError, KeyError, subprocess.SubprocessError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
