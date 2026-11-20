/**
 * 流式响应解析工具：SSE（OpenAI / Anthropic）与 NDJSON（Ollama）。
 *
 * 为什么自己写：Phase 1 不引入 LLM SDK，只依赖内置 fetch + Web Streams；
 * 两类协议都只是「按行切分 + 逐条 JSON」，几十行即可覆盖，且便于离线用 mock 服务测试。
 *
 * 健壮性约定：
 *  - 不假设 chunk 边界与事件边界对齐（跨 chunk 的半行、半事件都要缓存）；
 *  - 忽略空行与注释行（`:` 开头的心跳）；
 *  - JSON 解析失败不抛错，交给调用方按「跳过坏帧」处理——流中断时的半帧不应该让整次调用失败；
 *  - 服务端返回 error 事件时抛出带 code 的 Error，由上层统一兜底。
 */

/** 把 fetch 的 ReadableStream 逐块解码成文本片段。 */
async function* readTextChunks(body) {
  if (!body) return
  const decoder = new TextDecoder('utf-8')
  // Node 18+ 的 web ReadableStream 支持异步迭代；Node 的 http.IncomingMessage 也支持。
  for await (const chunk of body) {
    if (chunk == null) continue
    const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
    if (text) yield text
  }
  const tail = decoder.decode()
  if (tail) yield tail
}

/**
 * 解析 SSE 流，逐条产出 `{ event, data }`。
 *
 * @param {ReadableStream<Uint8Array>|AsyncIterable<unknown>} body
 * @returns {AsyncGenerator<{ event: string, data: string }>}
 */
export async function* readSseEvents(body) {
  let buffer = ''
  for await (const text of readTextChunks(body)) {
    buffer += text
    // 事件以空行分隔；同时兼容 \r\n。
    while (true) {
      const match = /\r?\n\r?\n/.exec(buffer)
      if (!match) break
      const rawEvent = buffer.slice(0, match.index)
      buffer = buffer.slice(match.index + match[0].length)
      const parsed = parseSseEvent(rawEvent)
      if (parsed) yield parsed
    }
    // 有些服务端不补最后一个空行，单行 data 事件也可能刚好在 chunk 末尾：等下一块再判断。
  }
  const last = parseSseEvent(buffer)
  if (last) yield last
}

function parseSseEvent(rawEvent) {
  if (!rawEvent || !rawEvent.trim()) return null
  let event = 'message'
  const dataLines = []
  for (const line of rawEvent.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim()
      continue
    }
    if (line.startsWith('data:')) {
      // 规范：去掉冒号后的一个可选空格，其余原样保留。
      const value = line.slice('data:'.length)
      dataLines.push(value.startsWith(' ') ? value.slice(1) : value)
    }
  }
  if (dataLines.length === 0) return null
  return { event, data: dataLines.join('\n') }
}

/**
 * 解析 NDJSON 流（Ollama），逐条产出对象。
 *
 * @param {ReadableStream<Uint8Array>|AsyncIterable<unknown>} body
 * @returns {AsyncGenerator<object>}
 */
export async function* readJsonLines(body) {
  let buffer = ''
  for await (const text of readTextChunks(body)) {
    buffer += text
    while (true) {
      const index = buffer.indexOf('\n')
      if (index === -1) break
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      const value = tryParse(line)
      if (value) yield value
    }
  }
  const tail = buffer.trim()
  if (tail) {
    const value = tryParse(tail)
    if (value) yield value
  }
}

function tryParse(line) {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

/** 把可能跨多个 chunk 的 `data:` 负载解析成对象；坏帧返回 null。 */
export function parseDataJson(data) {
  if (typeof data !== 'string' || !data.trim()) return null
  const value = tryParse(data)
  return value && typeof value === 'object' ? value : null
}
