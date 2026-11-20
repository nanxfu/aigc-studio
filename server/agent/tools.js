/**
 * Agent 工具注册表（Phase 1 收敛版）。
 *
 * 背景：原插件把 7 个生图工具注册进 DSH 的 `ctx.tools.register`，由 DSH 的 Agent 循环调用。
 * 独立客户端没有宿主 Agent，因此这里自己维护一份注册表：
 *  - `server/tools.js` 的 `registerTools(ctx, deps)` 原样调用 `ctx.tools.register(tool)`，
 *    本文件提供的 `createToolRegistry()` 就是那个 `ctx.tools`；
 *  - 注册项形状与原插件一致：`{ name, description, parameters(JSON Schema), output, execute(args) }`；
 *  - 同一份定义可直接转换为 OpenAI / Anthropic 的工具声明，Phase 2 也能零改动映射成 MCP tools。
 */

/**
 * @typedef {object} AgentTool
 * @property {string} name
 * @property {string} description
 * @property {object} parameters JSON Schema
 * @property {(args: object) => Promise<{ text: string } | { text: string, data?: unknown }>} execute
 */

/** 工具集合：注册/查询/协议转换/执行。 */
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
   * @param {string|object} rawArguments JSON 字符串（模型返回）或已解析对象
   * @returns {Promise<{ ok: boolean, name: string, text: string, data?: unknown }>}
   */
  async function execute(name, rawArguments) {
    const tool = get(name)
    if (!tool) return { ok: false, name, text: `不存在名为 ${name} 的工具` }
    let args = {}
    if (typeof rawArguments === 'string' && rawArguments.trim()) {
      try {
        args = JSON.parse(rawArguments)
      } catch {
        return { ok: false, name, text: `工具参数不是合法 JSON：${rawArguments.slice(0, 200)}` }
      }
    } else if (rawArguments && typeof rawArguments === 'object') {
      args = rawArguments
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return { ok: false, name, text: '工具参数必须是 JSON 对象' }
    }
    try {
      const result = await tool.execute(args)
      const text = result && typeof result.text === 'string' ? result.text : JSON.stringify(result ?? null)
      return { ok: true, name, text, data: result?.data }
    } catch (error) {
      return { ok: false, name, text: `工具执行失败：${String(error?.message ?? error).slice(0, 500)}` }
    }
  }

  return { register, list, get, execute, toOpenAiTools, toAnthropicTools, size: () => tools.size }
}
