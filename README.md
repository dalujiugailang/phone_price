<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/e37a476f-3a43-4a96-bec6-10e03b8b4685

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## MCP 数据服务

只读 MCP 服务用于给内部 AI Agent 查询新机售价监控数据。

本地启动：

```bash
MCP_API_TOKENS=your-token npm run mcp
```

MCP endpoint:

```text
http://localhost:8790/mcp
```

云端部署后 endpoint:

```text
https://mcp.gtmdudu.xyz/mcp
```

客户端请求需要携带：

```text
Authorization: Bearer your-token
```

可用工具：

- `get_metadata`
- `query_skus`
- `get_raw_skus`
- `get_raw_editor_draft`
- `get_summary`
- `get_change_summary`
- `export_all_data`

部署前验证数据读取：

```bash
npm run mcp:verify-data
```

Docker Compose 部署时需要配置：

```text
MCP_API_TOKENS=replace-with-strong-token
MCP_ALLOWED_ORIGINS=https://mcp.gtmdudu.xyz
```

## 3C行业专家agent

网站内置一个只读的 OpenAI Agents SDK Agent。确定性代码负责价格、残值率和周销计算，Agent负责选择工具、解释和给出建议。

服务端配置：

```text
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=http://cli-proxy-api:8317/v1
OPENAI_MODEL=
OPENAI_AGENTS_DISABLE_TRACING=1
```

`OPENAI_BASE_URL` 可指向同一私有 Docker 网络中的 CPA；`OPENAI_MODEL` 可留空以使用 Agents SDK 默认模型。接口：

- `GET /api/expert/brief`：不依赖模型的确定性简报
- `GET /api/expert/status`：模型配置和数据新鲜度
- `GET /api/expert/sessions`：左侧历史任务列表
- `GET /api/expert/sessions/:sessionId`：读取一项历史对话
- `POST /api/expert/ask`：运行只读行业专家 Agent
- `POST /api/expert/ask/stream`：以 NDJSON 实时返回状态、工具调用和最终回答

最终回答由结构化 Schema 固定为：结论、关键事实、分析推断、建议动作、数据与证据、口径与风险。

## 新品周销微博自动更新

执行链路固定为：云端创建任务 → 本机 Worker 领取 → 本机 Browser Use CLI + 已登录 Chrome 抓取 → JSON 回传云端解析入库。Browser Use Cloud 不参与。

云端 `.env`：

```text
WEEKLY_SALES_AUTOMATION_TOKEN=replace-with-strong-token
WEEKLY_SALES_WORKER_TOKEN=replace-with-a-different-strong-token
WEEKLY_SALES_SCHEDULE_ENABLED=true
WEEKLY_SALES_SCHEDULE_TIMEZONE=Asia/Shanghai
```

本机 Worker `.env` 使用相同的 `WEEKLY_SALES_WORKER_TOKEN`：

```text
BROWSER_USE_MODE=local
WEEKLY_SALES_WORKER_TOKEN=replace-with-a-different-strong-token
GTM_SERVER_URL=https://www.gtmdudu.xyz
GTM_WORKER_ID=dudu-mac
GTM_WORKER_POLL_MS=15000
```

保持 Chrome 已登录微博并开启远程调试，然后启动 Worker：

```bash
npm run weibo:worker
```

确认云端地址和 Token 已写入本机 `.env` 后，可将 [deploy/com.dudu.gtm-weibo-worker.plist.example](deploy/com.dudu.gtm-weibo-worker.plist.example) 复制到 `~/Library/LaunchAgents/com.dudu.gtm-weibo-worker.plist`，让 Worker 登录后自动启动并常驻。

生产服务会在每周一、周五 10:00（Asia/Shanghai）创建任务。同一日程槽位只创建一次；Worker 离线时任务保留在队列，恢复在线后继续执行。页面手动创建任务需要运行口令。
