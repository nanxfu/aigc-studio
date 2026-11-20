/**
 * 各协议的终止原因归一（OpenAI / Anthropic / Ollama 的表层都用 SSE 或 NDJSON，
 * 但 stop_reason 的取值不同）。统一映射成工作台内部使用的一小组 kind：
 * `stop` / `max-tokens` / `tool-calls` / `content-filter` / 其它原样。
 */
export function mapFinishReason(reason) {
  switch (reason) {
    case 'stop':
    case 'end_turn':
    case 'stop_sequence':
      return 'stop'
    case 'length':
    case 'max_tokens':
    case 'max_output_tokens':
      return 'max-tokens'
    case 'tool_calls':
    case 'function_call':
    case 'tool_use':
      return 'tool-calls'
    case 'content_filter':
      return 'content-filter'
    default:
      return typeof reason === 'string' && reason ? reason : 'unknown'
  }
}
