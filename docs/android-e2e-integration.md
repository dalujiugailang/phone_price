# 安卓端到端看板数据接入

## 高风险价格链诊断试用（2026-11-03）

### Daily Price 已直接接入

数据提供方是聊天“分析项目架构与风险”对应的
`/Users/dudu_1/Desktop/trae/重点日常项目/【daily price】` 项目。
每次诊断直接调用 `POST /api/daily-price/lookup`，凭证只在服务端读取，
从原风险行的标准S+SKU中保留完整SKU（含颜色/地区/网络），替换为选中的成交等级后查询，
校验返回PPV和等级；没有完整SKU时不猜测。

- 图中BI出货价、BI基准价、最终报价均来自接口直接值，接口数据日期单独显示。
- 最终报价是独立字段，不当作回收物品价；接口没有P1、B/C端实际成交价、回收物品价和周转策略，
  这些仍使用有日期标识的历史成交快照，或明确显示缺失。
- 当前接口与历史成交日期不一致时，只展示历史参考价差，不下同期涨降价结论。
- API连接失败、401或PPV未匹配时，当前BI/基准价留空，不回退反算BI冒充接口值。
- `/meta` 用于检查Daily与ZZ日期；不同批次不联用ZZ价格。
- 8002试用页的原“拉取BI价”按钮也直接走Daily Price，不再代理另一工作副本的旧Token路径。

2026-11-03已实测云端Daily主表202,906行、ZZ表2,381行，接口业务日期均为2026-11-03。
当时域名TLS连接失败，现通过仅绑定本机127.0.0.1:8765的SSH转发连接既有服务器8.162.25.246上的
127.0.0.1:8765服务，未修改云端数据或配置。本地试用时需保持转发进程运行，
或设置有效的 `DAILY_PRICE_LOOKUP_URL` 和 `DAILY_PRICE_TOKEN_PATH`。

实测完整PPV `A+真我 Neo8 大陆国行 全网通 12G+256G 起源白`：
BI出货价2261、BI基准价2216、最终报价1365（元），均直接来自11月3日API返回。

```bash
node --test server/lib/daily-price-client.test.mjs server/lib/android-risk-diagnostics.test.mjs
```

以下原始快照与历史诊断说明仍适用于成交参考部分，当前BI值已改为上述接口直接值。

风险页新增“高风险价格链诊断”区，可一次查询前20条高风险SKU，并复制或下载反馈文本。
本地独立试用入口为 `http://localhost:8002/?view=risk`，代理现有8001的经营数据API。
原8001正在运行另一工作副本，因此本次没有重启它。启动试用页：

```bash
PRICE_MONITOR_PROXY_TARGET=http://127.0.0.1:8001 npm run dev -- --port=8002
```

只读接口 `POST /api/risk-price-diagnostics`：

```json
{"targets":[{"model":"真我 Neo8","storage":"12GB+256GB","riskPriceDate":"10.29"}]}
```

- 在同型号、同内存规格内按近7天回收成交量 `s1.dq` 累计选最多的PPV；
  不限定S等级。近7天无有效成交时看近30天；均无成交则显示未匹配。
- 日期截止到风险记录的日期；`10.29` 使用快照数据年份推为2026-10-29。
  不使用截止日之后的成交量排名或价格。也可显式传 `date: "2026-10-29"`。
- 可显式传入OS以限制候选；默认对该型号规格的所有OS和等级排名。
  选中后所有价格字段锁定同一变体，不从其他等级或OS补价。
  该成交变体的诊断只作为排查参考，不改写原S等级风险结论。
- 价格统一近3天窗口，关键字段缺失时整链切至近7天。仍缺失则明确显示；
  不将近30天的选取窗口当成近7天的价格窗口。
- 返回P1、B端出货价、C端结算价、反算BI价、基准价、回收物品价，以及每项有效日期数。
  BI反算为基准价÷(1+周转系数)，与风险表daily price API的BI出货价分开保存和展示。
- 参照源看板规则重算P1/参考出货价、参考出货价/反算BI（±5%），并给出周转系数判断。
  参考端按型号近7天销量结构选择（无销量看近30天），C占比>60%取C，<40%取B，
  其余双端；不以另一端价格替代选中的参考端。
- 返回维护环节建议和判断证据，不自动给其他人发消息。原始价格日期轴异常不参与诊断。

接口从 `data/android-e2e/` 的完整快照中按 `manifest.exported_at` 选择最新一份，
复用加载缓存。可用 `ANDROID_E2E_SNAPSHOT_DIR` 指定快照目录或其父目录。
首次试用使用已核验的2026-11-01数据，不宣称为2026-11-03实时价。

界面按参考图展示左侧同一价格标尺的横向条形链、右侧P1/BI/周转判定卡片及下方双链综合结论。
销量结构、策略、型号库存水位、同PPV竞争价均来自真实快照；缺失字段不绘制价格条，相关判定显示无法判断。
默认先展示价格字段较完整的高风险记录，可通过型号规格标签切换全部查询结果。

验证：8项诊断测试覆盖成交量排名、规格和OS隔离、历史截止日期、统一窗口、缺数、异常日期轴、
同变体竞争价日期边界和库存水位计算。

```bash
node --test server/lib/android-risk-diagnostics.test.mjs
```

核验日期：2026-11-02（北京时间）。源应用：
<https://atrenew.feishu.link/app/app_17h053qz13d>。

## 实际 HTTP 结果

五个地址均已分别进行无登录 HTTP 请求及已登录浏览器请求。

| 文件 | 无登录请求 | 已登录请求 | 实测 UTF-8 字节数 | 导出对象 |
| --- | --- | --- | ---: | --- |
| `price-data.js` | 重定向至飞书登录页，最终200/HTML | 200/JavaScript | 36,126,494 | `PRICE_DATA` |
| `s4-price.js` | 同上 | 200/JavaScript | 26,153,694 | `S4_DATA` |
| `tk-data.js` | 同上 | 200/JavaScript | 10,728,705 | `TK_DATA` |
| `listing-dates.js` | 同上 | 200/JavaScript | 77,259 | `LISTING_DATA` |
| `app.js` | 同上 | 200/JavaScript | 86,568,568 | `BOARD_DATA`，后面还有其他应用代码 |

完整 URL = 应用地址 + `/文件名`。登录态下可能重定向至
`lf-miaoda-compiled-static.feishucdn.com` 的临时签名 URL；不要保存签名 URL 当固定接口。
脚本允许该应用对应的官方 CDN 路径，HTTP 跨域时移除 Cookie/Authorization，不输出签名 URL。

这些是应用快照资源，不是支持筛选、分页的 JSON REST API。每次抓取会下载约160 MB源文件；
应在服务端按需要刷新后缓存，避免前端每次访问都抓取。源文件保留在系统临时目录供核查。

## 运行

Python 3.9+；JSON解析及普通HTTP模式只用标准库。浏览器模式额外需要已安装并运行的
ego-browser（本机已验证）。在项目根目录运行：

```bash
python3 scripts/fetch-android-e2e.py --browser
```

浏览器模式使用专用任务空间及浏览器登录态，不读取或导出 Cookie。若跳转至登录页，脚本会
交接浏览器并退出；用户完成登录、确认继续后运行：

```bash
python3 scripts/fetch-android-e2e.py --browser --resume-login
```

有独立的有效会话 Cookie 时，可直接走 Python HTTP：

```bash
python3 scripts/fetch-android-e2e.py --cookie-file /absolute/path/to/private-cookie.txt
# 或 Netscape Cookie 文件：
python3 scripts/fetch-android-e2e.py --cookie-jar /absolute/path/to/private-cookies.txt
```

`--cookie-file` 内容仅为单行 Cookie 请求头的值，也可用 `ANDROID_E2E_COOKIE` 环境变量。
不要把 Cookie 文件提交至仓库；不要在聊天或命令参数中粘贴 Cookie。Cookie模式的成功响应
依赖会话有效性，本次成功的完整在线流程使用浏览器模式。

已下载五个源脚本时可离线解析，无需登录：

```bash
python3 scripts/fetch-android-e2e.py --source-dir /absolute/path/to/downloads
```

仅缩小展开明细的范围（五份原始对象仍完整保留）：

```bash
python3 scripts/fetch-android-e2e.py --browser --date 2026-11-01 --model 'OPPO K10 (活力版)'
```

默认输出为项目的 `data/android-e2e/<UTC时间戳>/`，位于已有Git忽略目录内。
`--output-dir` 可以指定空目录；非空目录会报错，不覆盖旧快照。
仅在 `manifest.json` 存在时读取该批次，manifest最后写入，包含文件SHA-256、范围及HTTP状态。
抓取失败退出码为1；质量警告保留数据并记录，不阻止快照导出。

## JSON 文件及接入示例

| 文件 | 用途 |
| --- | --- |
| `board_data.json` | 完整经营源对象；保留压缩数组及全部元数据 |
| `price_data.json` | 回收/竞争源对象及价格日期轴，保留全部原始字段 |
| `s4_data.json` | B/C端实际销售价格、数量 |
| `tk_data.json` | 周转系数、策略类型、策略名称 |
| `listing_data.json` | 型号上市日期及来源说明 |
| `models.json` | 展开型号索引、型号、品牌、标签掩码、上市日期 |
| `daily.json` | 日期×型号展开经营明细；原始0保留为0，缺失源行保留为null |
| `data-quality.json` | 价格及数量数组与日期轴长度不一致的数量、示例 |
| `manifest.json` | 导出范围、时间、HTTP检查、文件校验摘要 |

Python消费：

```python
import json
from pathlib import Path

snapshot = Path('data/android-e2e/browser-verified-20261102')
manifest = json.loads((snapshot / 'manifest.json').read_text(encoding='utf-8'))
daily = json.loads((snapshot / 'daily.json').read_text(encoding='utf-8'))
prices = json.loads((snapshot / 'price_data.json').read_text(encoding='utf-8'))

rows = [r for r in daily if r['date'] == '2026-11-01' and r['brand'] == 'OPPO']
model_prices = prices['models'].get('OPPO K10 (活力版)', {})
```

项目现有Node服务可使用 `JSON.parse(await readFile(path, 'utf8'))` 读取相同文件。
该脚本只导出快照，不会写入现有正式报价仓库或自动发布看板。

## 字段与口径

`models.json` 的 `tag_mask` 是源 `models[i].t`；保留原始掩码，标签来源见 `board_data.meta.tagSources`。

`daily.json` 字段：

| 字段 | 含义 |
| --- | --- |
| `date`, `model_index`, `model`, `brand`, `tag_mask`, `listing_date` | 日期和型号资料 |
| `inventory`, `daily_sales_3d`, `daily_sales_7d` | 库存、近3/7天日均销量 |
| `purchase_sales_ratio_3d`, `purchase_sales_ratio_7d` | 上游快照近3/7天进销比，不是当日成交/销量自算值 |
| `submit_self`, `submit_other_bd`, `submit_jd_recycle`, `submit_jd_tradein` | 自营/其他BD/京东普通回收/京东换新提交量 |
| `deal_self`, `deal_other_bd`, `deal_jd_recycle`, `deal_jd_tradein` | 同四渠道回收成交量 |
| `sales_toc`, `sales_tob`, `sales_unknown` | 三类销售渠道数量 |
| `backlog_estimated`, `delivery_days_sum`, `delivered_count` | 估算在途量、交付耗时合计、当日完结单量 |

价格数据保留对象路径：

```text
price_data.models[型号].s1[变体]:
  d/p1/p1b/dq     成交日期/P1/P1′/成交量
  dc/base/item/dqc 创单日期/回收预估销售额(基准价)/成交策略报价/创单量
price_data.models[型号].s2[变体]:
  d/zz/ahsBefore/ahsAfter/base 日期/转转券后价/爱回收追前价/追后价/BI基准价
price_data.models[型号].s3[变体]:
  d/jdBefore/jdAfter/tm/base/newSeries 日期/京东追前价/追后价/天猫价/基准价/关联新品系列
s4_data.models[型号][变体]:
  d/bprice/cprice/dqTob/dqToc 日期/TOB出货价/TOC结算价/TOB销量/TOC销量
tk_data.models[型号]: tk/tkType/tkName 周转系数/策略类型/策略名称
```

变体格式为 `内存规格|OS字段|等级`。不同源只在型号及变体完全一致时比较，不跨等级替代。
P1与基准价使用不同日期轴；竞争源的滚动数量不得当作当日回收成交量。

## 实测质量及限制

2026-11-02的完整快照：日期范围2026-08-01～2026-11-01，2,389个型号，展开经营明细191,729行。
五份源JS解析后的数据对象与已加载浏览器中的对应对象逐项相等。

发现61,207个“字段数组与所属日期轴长度不同”的情况（不是61,207条订单）：

| 字段 | 不一致数组数 |
| --- | ---: |
| 源1 `base` | 11,671 |
| 源1 `item` | 11,671 |
| 源3 `newSeries` | 701 |
| 源4 `dqTob` | 18,582 |
| 源4 `dqToc` | 18,582 |

例如某变体 `dc` 有21个日期，而 `base/item` 各22个值。脚本保留所有原值，
不执行 `zip` 截断、不猜测多出值的日期，因此没有直接展开价格序列。
使用有警告的变体前，应由上游确认日期映射；经营明细的展开独立于这些价格数组。

脚本不会执行下载脚本的应用代码；仅用JSON解码器提取命名变量赋值中的JSON字面量。
这批是安卓回收经营/竞争价格，不应自动作为本项目新机正式售价发布。

验证命令：

```bash
python3 -m unittest discover -s tests -p test_android_e2e.py -v
```
