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
