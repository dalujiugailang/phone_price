# 市场总量&份额趋势分析 Tab 方案 PRD

## 1. 目标

在现有「新机售价监控系统」中新增一级 Tab：

```text
市场总量&份额趋势分析
```

用于展示手机市场周度总量指数、品牌份额趋势、事件节点、核心结论和品牌周度份额明细。该功能保持当前项目的 UI 规范和数据维护链路：

1. 平时编辑/粘贴后自动保存草稿，只落到 SQLite。
2. 点击「更新结果」或「确认落数」后，先写 SQLite，再写回 Excel 数据源。

## 2. 当前结论

原 Prompt 中的「新增独立 market_trend_ 业务表」调整为更贴合本项目的数据源方案：

- 主数据源仍使用 `新机售价监控.xlsx`。
- 市场趋势模块只读取和写回独立 sheet：`市场总量份额趋势`。
- SQLite 只作为在线编辑草稿和确认前缓存，不作为最终事实表。
- 不复用现有 `raw_editor_drafts` 表，新增市场趋势专用草稿表，避免污染原始价格监控编辑链路。

## 3. 数据源设计

### 3.1 Excel Sheet

目标文件：

```text
/Users/dudu/Desktop/trae/重点日常项目/【GTM】新机售价监控分析系统/新机售价监控.xlsx
```

新增 sheet：

```text
市场总量份额趋势
```

初始数据来自：

```text
/Users/dudu/Downloads/新机市场份额.xlsx
```

### 3.2 Sheet 结构

沿用上传 Excel 的宽表结构，后端负责解析：

| 行 | 含义 |
|---|---|
| 第 1 行 | 事件节点，按周列填写事件名 |
| 第 2 行 | 周次表头，如 W1、W2、W20 |
| 第 3 行 | 时间周期 |
| 第 4 行 | 市场总量指数，上年度 W52 基数 = 100 |
| 第 5 行 | 手机销量大盘环周描述 |
| 第 6 行起 | 品牌份额行 |

固定展示品牌：

```text
苹果
小米
vivo总(含iQOO)
华为
OPPO总(含一加、realme)
荣耀
Others
```

拆分品牌行保留在数据源中，但本期不进入主图和 KPI：

```text
-vivo
-iQOO
-OPPO
-一加
-realme
```

### 3.3 数值约定

Excel 中品牌份额可以保存为小数：

```text
0.207
```

前端统一展示为：

```text
20.7%
```

用户粘贴 `20.7` 或 `20.7%` 时，写回 Excel 前统一转换成小数 `0.207`。总量指数保持数字原值，例如 `79.0`。

## 4. SQLite 草稿设计

继续使用当前服务端 SQLite 文件：

```text
data/raw-editor-draft.sqlite
```

新增独立表：

```sql
CREATE TABLE IF NOT EXISTS market_trend_drafts (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  payload_json TEXT NOT NULL,
  saved_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

`payload_json` 保存完整市场趋势编辑草稿，建议结构：

```json
{
  "sheetName": "市场总量份额趋势",
  "year": 2026,
  "weeks": ["W1", "W2"],
  "timeRanges": {},
  "weeklyTotals": {},
  "marketWeekNotes": {},
  "brandShares": {},
  "events": {},
  "savedAt": "2026-06-04T00:00:00.000Z"
}
```

保存链路：

| 场景 | SQLite | Excel |
|---|---:|---:|
| 打开 Tab | 读取草稿；没有草稿则读取 Excel sheet | 读取 |
| 平时编辑/粘贴 | 写入 `market_trend_drafts` | 不写 |
| 点击「更新结果」 | 写入 `market_trend_drafts` | 写回 `市场总量份额趋势` sheet |
| 点击「确认落数」 | 写入 `market_trend_drafts` | 写回 `市场总量份额趋势` sheet |
| 导入历史数据 | 可先写草稿预览 | 用户确认后替换 sheet |

## 5. API 设计

新增 API 前缀：

```text
/api/market-trend
```

### 5.1 获取数据

```http
GET /api/market-trend/overview
```

逻辑：

1. 优先读取 SQLite 草稿。
2. 没有草稿时读取 Excel 的 `市场总量份额趋势` sheet。
3. 返回图表、KPI、明细表和事件节点所需数据。

### 5.2 保存草稿

```http
POST /api/market-trend/draft
```

只写 SQLite，不写 Excel。

### 5.3 更新结果

```http
POST /api/market-trend/apply
```

逻辑：

1. 校验数据。
2. 写 SQLite 草稿。
3. 写回 Excel sheet。
4. 重新解析并返回最新 overview。

### 5.4 新增/确认一周

```http
POST /api/market-trend/weeks
```

本质上与 `apply` 一致，只是 payload 中包含新增周数据。成功后：

1. 关闭弹窗。
2. 返回最新 overview。
3. 图表、KPI、明细表自动刷新。

### 5.5 导入历史数据

```http
POST /api/market-trend/import
```

本期只支持 Excel。导入后进入预览/草稿状态；用户点击「确认导入」后替换 `市场总量份额趋势` sheet。

## 6. UI 设计规范

### 6.1 与现项目保持一致

沿用当前项目风格：

- 页面背景：`#F8F9FA`
- 顶部 sticky header
- 顶部 Tab 使用 segmented control
- 卡片：白底、浅灰边框、轻阴影
- 按钮：lucide 图标 + 文字
- 主系统强调色仍使用橙色
- 市场趋势图表可以使用蓝色柱状图作为业务图形色，不改变全站主色

新增 Tab 按钮建议放在「S等级风险」之后、「原始数据」之前：

```text
概览 / 汇总 / S等级风险 / 市场趋势 / 原始数据 / 明细
```

### 6.2 页面结构

```text
顶部标题区
轻量筛选区
KPI 指标卡区
主图表区 + 核心结论卡
品牌周度份额明细表
数据管理区
```

### 6.3 顶部操作

保留本期真正需要且能落地的操作：

```text
新增一周
导入历史数据
更新结果
导出Excel
```

以下能力可以后置：

```text
保存图片
分享
全屏
```

原因：当前项目没有这些通用工具链，第一期先保证数据维护和看板展示闭环。

## 7. 展示逻辑

### 7.1 KPI

展示 5 张卡：

1. 最新总量指数
2. 最高周峰值
3. 苹果份额
4. 华为份额
5. OPPO总份额

计算规则：

- 最新周按 W 数字排序，不按字符串排序。
- 总量指数较上周变化使用百分比：
  `(当前周 - 上一周) / 上一周 * 100`
- 品牌份额变化使用 pct point：
  `当前周份额 - 上一周份额`

### 7.2 主图表

使用当前项目已安装的 `recharts`，不引入 ECharts。

图表固定为：

- 柱状图：市场总量指数，右 Y 轴。
- 多折线：品牌份额，左 Y 轴。
- X 轴：W1-W20-W21。
- tooltip 展示该周总量指数、全部核心品牌份额和事件。
- 事件节点使用 Recharts `ReferenceLine` 标注。

### 7.3 核心结论

按当前筛选结果自动生成：

- 最新周总量指数及环比
- 最新周份额领先品牌，排除 Others
- 苹果、华为、OPPO总份额变化
- 峰值周和峰值指数
- 当前统计周期

### 7.4 明细表

固定展示核心品牌行，周次横向铺开：

```text
品牌 / W1 / W2 / ... / 最新周份额 / 较上周变化
```

轻量条件格式：

- 高份额单元格加浅色底
- 正变化绿色
- 负变化红色
- 0 灰色

## 8. 新增一周弹窗

弹窗分 4 区：

1. 基础信息：年份、周次、周期起止日期、市场总量指数。
2. 品牌份额：固定核心品牌行，支持手动输入和粘贴。
3. 事件节点：可选，支持多个事件名；本期写入对应周第 1 行，多个事件用 `；` 连接。
4. 校验结果：错误和 warning。

默认逻辑：

- 当前最大 W20，则新增默认 W21。
- 起止日期优先按上一周往后推 7 天。
- 份额输入支持 `20.7`、`20.7%`、`0.207`；展示统一为百分比。

## 9. 校验规则

必须前后端双校验：

| 规则 | 处理 |
|---|---|
| week 不能重复新增 | 提示切换为更新该周 |
| total_index 必须为数字 | error |
| 核心品牌必须完整 | error |
| 品牌份额必须为数字 | error |
| 份额合计小于 95 或大于 105 | warning，可二次确认 |
| week_start_date 必须小于 week_end_date | error |
| Excel sheet 不存在 | error，提示先导入历史数据 |

## 10. 历史导入

本期导入优先支持上传 Excel 原宽表，字段结构与 `新机市场份额.xlsx` 一致。

导入流程：

1. 上传 Excel。
2. 后端读取第一个 sheet。
3. 校验 W 列、时间周期、总量指数和核心品牌行。
4. 生成草稿并返回预览。
5. 用户确认后写入 SQLite 并替换 Excel 的 `市场总量份额趋势` sheet。

CSV 和三表结构导入后置，不放第一期。

## 11. 开发优先级

1. 把上传 Excel 数据写入主数据源 sheet。
2. 新增 Excel sheet 解析函数。
3. 新增 `/api/market-trend/overview`。
4. 新增 `market_trend_drafts` 草稿表和 draft/apply API。
5. 新增顶部 Tab 和市场趋势页面基础布局。
6. 新增 KPI、组合图、核心结论、明细表。
7. 新增「新增一周」弹窗和粘贴解析。
8. 新增历史导入。
9. 新增导出 Excel。

## 12. 验收标准

### 数据验收

- `新机售价监控.xlsx` 中存在 `市场总量份额趋势` sheet。
- 页面默认能读取该 sheet 并展示 W1-W20。
- SQLite 自动保存不会修改 Excel。
- 点击「更新结果」或「确认落数」后，Excel sheet 被写回。
- 重启服务后，已确认写回的数据仍能从 Excel 读取。

### 页面验收

- 新增「市场趋势」Tab。
- UI 与当前系统一致，不出现独立风格的复杂配置面板。
- KPI、组合图、事件节点、核心结论、明细表展示正确。
- 新增一周后 W21 自动进入图表和明细表。
- 份额变化展示为 pct，不展示成百分比增长率。

### 技术验收

- 不引入新的大型图表库。
- 不改动现有价格监控主 sheet 解析逻辑。
- 不复用 `raw_editor_drafts` 表。
- 所有 Excel 写回由服务端 API 完成。
- 写回失败时页面保留当前草稿，并明确提示失败原因。
