# mcp/（Phase 2 预留）

把 AIGC Studio 的创作能力以标准 **MCP Server** 形式暴露给外部 Agent（DSH / Cursor / Claude Desktop 等）。

## 规划

- `server/agent/tools.js` 里注册的工具（`imagen_generate` / `imagen_batch` / `imagen_history` /
  `imagen_upscale` / `imagen_cancel` / `imagen_recipes` / `imagen_session`）已经是「名称 + 描述 +
  JSON Schema + 执行函数」的统一形状，Phase 2 直接映射为 MCP `tools/list` 与 `tools/call`，
  不重复维护第二份工具描述。
- 传输方式：
  - **stdio**：由外部宿主拉起 `node mcp/server.mjs --stdio`，最通用；
  - **HTTP/SSE**：复用本地服务（`/mcp`），供同一台机器上的多个客户端连接，需要 Bearer Token。
- 实现方式：MCP Server 不直接操作 GPU / 文件系统，而是调用本地服务已鉴权的 `/api/*`，
  这样「桌面工作台 + MCP」共享同一份会话、队列与产物目录，不会出现双份状态。
- 前置条件：Phase 1 完成本地服务与工具注册表（`server/agent/tools.js`）稳定；Phase 2 再切到
  MCP 的 `@modelcontextprotocol/sdk`（或等价实现），本目录暂不引入依赖。

## 状态

Phase 1 未实现。本目录只有占位说明；`server/agent/tools.js` 是唯一的工具定义来源。
