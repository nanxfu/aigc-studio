/**
 * Agent 工具注册表（接入 `@earendil-works/pi-agent-core` 底座）。
 *
 * 背景：`server/tools.js` 注册了 7 个生图/配方/历史/会话工具。
 * 本文件维护统一注册表，同时提供：
 *  - `toPiAgentTools()`：转换为 `@earendil-works/pi-agent-core` 的 `AgentTool[]`（原生 JSON Schema 校验 + 执行）；
 *  - `toOpenAiTools()` / `toAnthropicTools()`：保留给 Phase 2 MCP Server 与离线检查复用；
 *  - `extractGeneratedImages()`：从工具返回文本/数据中提取结构化产物图，供工作台聊天气泡直接渲染预览网格。
 */

const IMAGE_LINE_RE = /^-\s+((?:outputs|imagen-output)\/[^\s（(]+)/
const URL_LINE_RE = /^(\/api\/file\?path=[^\s]+|https?:\/\/[^\s]+\/api\/file\?path=[^\s]+)/

/** 从工具执行结果（结构化 data 或描述文本）里提取生成的图片列表。 */
export function extractGeneratedImages(text, data) {
  if (data && Array.isArray(data.images) && data.images.length > 0) {
    return data.images
      .filter((img) => img && typeof img === 'object' && (img.path || img.url))
      .map((img) => ({
        path: String(img.path ?? ''),
        url: String(img.url ?? (img.path ? `/api/file?path=${encodeURIComponent(img.path)}` : '')),
        width: Number.isFinite(img.width) ? img.width : null,
        height: Number.isFinite(img.height) ? img.height : null,
        seed: Number.isFinite(img.seed) ? img.seed : null,
      }))
  }
  const lines = String(text ?? '').split(/\r?\n/)
  const found = []
  let pending = null
  for (const raw of lines) {
    const line = raw.trim()
    const pathMatch = IMAGE_LINE_RE.exec(line)
    if (pathMatch) {
      if (pending) found.push(pending)
      const path = pathMatch[1]
      const dimMatch = /(\d+)×(\d+)/.exec(line)
      const seedMatch = /seed\s+(-?\d+)/i.exec(line)
      pending = {
        path,
        url: `/api/file?path=${encodeURIComponent(path)}`,
        width: dimMatch ? Number(dimMatch[1]) : null,
        height: dimMatch ? Number(dimMatch[2]) : null,
        seed: seedMatch ? Number(seedMatch[1]) : null,
      }
      continue
    }
    if (pending) {
      const cleaned = line.replace(/^URL：\s*/i, '')
      const urlMatch = URL_LINE_RE.exec(cleaned)
      if (urlMatch) {
        pending.url = urlMatch[1]
        found.push(pending)
        pending = null
      }
    }
  }
  if (pending) found.push(pending)
  return found
}

/**
 * @typedef {object} AgentTool
 * @property {string} name
 * @property {string} description
 * @property {object} parameters JSON Schema
 * @property {(args: object) => Promise<{ text: string } | { text: string, data?: unknown }>} execute
 */

/** 工具集合：注册 / 查询 / 转换 / 执行。 */
export function createToolRegistry() {
  /** @type {Map<string, AgentTool>} */
  const tools = new Map()

  function register(tool) {
    if (!tool || typeof tool.name !== 'string' || !tool.name.trim()) {
      throw new Error('工具必须有 name')
    }
    if (typeof tool.execute !== 'function') {
      throw new Error(`工具 ${tool.name} 缺少 execute`)
    }
    const normalized = {
      name: tool.name.trim(),
      description: typeof tool.description === 'string' ? tool.description : '',
      parameters: tool.parameters && typeof tool.parameters === 'object' ? tool.parameters : { type: 'object', properties: {} },
      output: tool.output,
      execute: tool.execute,
    }
    tools.set(normalized.name, normalized)
    return () => {
      if (tools.get(normalized.name) === normalized) tools.delete(normalized.name)
    }
  }

  function list() {
    return [...tools.values()]
  }

  function get(name) {
    return tools.get(name) ?? null
  }

  /** OpenAI `tools` 数组。 */
  function toOpenAiTools() {
    return list().map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }))
  }

  /** Anthropic `tools` 数组。 */
  function toAnthropicTools() {
    return list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }))
  }

  /**
   * 执行一次工具调用：未知工具、参数解析失败、执行抛错都转成给模型看的文本，
   * 不让单次工具失败中断整个创作循环。
   *
   * @param {string} name
   * @param {string|object} rawArguments
   * @returns {Promise<{ ok: boolean, name: string, text: string, data?: unknown, images: Array<object> }>}
   */
  async function execute(name, rawArguments) {
    const tool = get(name)
    if (!tool) return { ok: false, name, text: `不存在名为 ${name} 的工具`, images: [] }
    let args = {}
    if (typeof rawArguments === 'string' && rawArguments.trim()) {
      try {
        args = JSON.parse(rawArguments)
      } catch {
        return { ok: false, name, text: `工具参数不是合法 JSON：${rawArguments.slice(0, 200)}`, images: [] }
      }
    } else if (rawArguments && typeof rawArguments === 'object') {
      args = rawArguments
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return { ok: false, name, text: '工具参数必须是 JSON 对象', images: [] }
    }
    try {
      const result = await tool.execute(args)
      const text = result && typeof result.text === 'string' ? result.text : JSON.stringify(result ?? null)
      const images = extractGeneratedImages(text, result?.data)
      return { ok: true, name, text, data: result?.data, images }
    } catch (error) {
      return { ok: false, name, text: `工具执行失败：${String(error?.message ?? error).slice(0, 500)}`, images: [] }
    }
  }

  /**
   * 转换为 `@earendil-works/pi-agent-core` `AgentTool[]`。
   * 由 `pi-agent-core` 负责参数校验、并行/串行调度与标准 `toolResult` 消息回传。
   */
  function toPiAgentTools() {
    return list().map((tool) => ({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      async execute(_toolCallId, params) {
        const executed = await execute(tool.name, params)
        return {
          content: [{ type: 'text', text: executed.text }],
          details: {
            images: executed.images,
            ...(executed.data !== undefined ? { data: executed.data } : {}),
          },
          isError: !executed.ok,
        }
      },
    }))
  }

  return {
    register,
    list,
    get,
    execute,
    toOpenAiTools,
    toAnthropicTools,
    toPiAgentTools,
    size: () => tools.size,
  }
}
