# mcp/（规划：M3.3 MCP Server）

把 AIGC Studio 的创作能力以标准 **MCP Server** 形式暴露给外部 Agent（Claude Desktop / Cursor / DSH 等）。

## 规划

- 工具定义的单源是 `server/tools.js`（名称 + 描述 + JSON Schema + 执行函数）。MCP 只复用其中的
  规格（后续抽到 `shared/tool-specs.js`），不重复维护第二份描述；`server/agent/tools.js` 只负责
  把同一份规格转换成 `pi-agent-core` 需要的形状。
- 传输方式：
  - **stdio**：由外部宿主拉起 `node mcp/server.mjs`，最通用；
  - **HTTP/SSE**：本阶段不做；同一台机器上的多个客户端各自拉起 stdio 进程即可。
- 实现方式：MCP Server 不直接操作 GPU / 文件系统，而是通过 `runtime.json` 发现本地服务的端口与
  Token，调用已鉴权的 `/api/*`。这样「桌面工作台 + MCP」共享同一份会话、队列与产物目录，不会出现
  双份状态。
- 前置条件：本地服务稳定、工具规格可被纯数据复用、`runtime.json` 发现机制就绪。依赖
  `@modelcontextprotocol/sdk`，随安装包一起分发（`electron-builder.yml` 的 `files` 需包含 `mcp/**`）。

## 状态

未实现。本目录目前只有占位说明；执行规划见
[`docs/M3_PRIVATE_WORKER_AND_MCP_PLAN.md`](../docs/M3_PRIVATE_WORKER_AND_MCP_PLAN.md) §7。
