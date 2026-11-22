# AIGC Studio MCP Server

把工作室能力以标准 **MCP（Model Context Protocol）** 暴露给外部 Agent（Claude Desktop / Cursor / DSH 等）。

MCP 进程只做「协议适配」：通过 `runtime.json` 发现本地服务的端口与 Token，调用已鉴权的
`http://127.0.0.1:<port>/api/*`。它**不**持有队列 / 会话 / GPU 状态，因此外部 Agent 与桌面
工作台共享同一份会话、任务与产物目录。

## 前置条件

- Node ≥ 20；
- AIGC Studio 已启动（应用启动成功后会写入 `<dataDir>/runtime.json`，退出时删除）；
- 本地服务与 MCP 使用同一个数据目录（安装版默认 `%APPDATA%\aigc-studio`）。

## 配置

```bash
# 打印可粘贴的 Claude Desktop / Cursor 配置
node mcp/server.mjs --print-config
```

输出示例：

```json
{
  "mcpServers": {
    "aigc-studio": {
      "command": "node",
      "args": ["C:\\Program Files\\AIGC Studio\\resources\\app\\mcp\\server.mjs"],
      "env": { "AIGC_STUDIO_DATA_DIR": "C:\\Users\\<you>\\AppData\\Roaming\\aigc-studio" }
    }
  }
}
```

把 `mcpServers` 段合并进客户端配置（Claude Desktop：`claude_desktop_config.json`；Cursor：
`~/.cursor/mcp.json`），重启客户端即可看到 7 个 `imagen_*` 工具。

自定义发现文件位置：

```bash
node mcp/server.mjs --runtime D:\somewhere\runtime.json
# 或设置环境变量 AIGC_STUDIO_RUNTIME
```

## 工具

| 工具 | 本地 API | 说明 |
| :--- | :--- | :--- |
| `imagen_generate` | `POST /api/generate` + `GET /api/job` | 文生图；`waitSeconds` 默认 60、上限 300，超时返回 jobId（任务继续） |
| `imagen_batch` | 逐条 `POST /api/generate` | 共享总预算，单条失败隔离 |
| `imagen_upscale` | `POST /api/generate`（`tool=upscale`） | 源图必须在工作区 `outputs/` 内 |
| `imagen_history` | `GET /api/history` | 最近产物路径与提示词 |
| `imagen_cancel` | `POST /api/job/cancel` | 排队/运行中语义与 UI 一致 |
| `imagen_session` | `GET /api/state`、`POST /api/session/start|stop` | `action: start | stop | status` |
| `imagen_recipes` | 本地 `shared/recipes.js` | 纯函数，不请求服务 |

默认返回文本（工作区相对路径 + 可读摘要）。`imagen_generate` / `imagen_batch` / `imagen_upscale`
支持可选参数 `includeImage: true`，追加图片内容块；默认关闭，避免几 MB 的 base64 卡住客户端。

## 安全边界

- 只连回环地址：`runtime.json.origin` 不是 `127.0.0.1` / `localhost` / `::1` 直接拒绝；
- Token 只放 `Authorization: Bearer` 请求头，不写日志、不进错误文本、不进 MCP 返回值；
- 工具参数由本地服务再次校验（路径逃逸、体积、模型能力），MCP 不做「信任转发」；
- stdio 通道不能有噪声：所有日志写 stderr，`console.log` 一律禁用；
- `runtime.json` 权限 0600，正常退出时删除；崩溃残留由 `pid` 存活检查识别为 stale。

## 常见错误

| 现象 | 原因与处理 |
| :--- | :--- |
| `runtime_missing` | 应用未启动，或 MCP 的 `AIGC_STUDIO_DATA_DIR` 与应用的 dataDir 不一致 |
| `runtime_stale` | `runtime.json` 里的 pid 已退出（应用崩溃残留）；重启应用即可覆盖 |
| `runtime_invalid` | 文件损坏 / schema 不匹配 / origin 不是回环；删除文件后重启应用 |
| `unauthorized` | 应用重启换了 Token，而 MCP 进程仍持旧值；重启 MCP 进程 |
| `unreachable` | 本地服务端口不可达（应用正在退出 / 防火墙拦截本机回环） |
| `timeout` | 生成超过 `waitSeconds`；用返回的 jobId 稍后查 `imagen_history` |

## 手动验证

```bash
# 1) 启动应用（或 npm run dev:server）
# 2) 用 SDK 自带的 inspector 或任意 MCP 客户端连接
node mcp/server.mjs

# 3) 最小 JSON-RPC 冒烟（每行一条消息）
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
```
