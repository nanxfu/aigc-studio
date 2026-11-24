/**
 * 轻量零依赖 Markdown 解析器（纯数据 AST，绝不输出原始 HTML）。
 *
 * 面向创作助手 362px 窄栏的常见大模型输出：
 *  - 块级：标题（# / ## / ###）、无序列表（- / * / •）、有序列表（1.）、
 *          引用块（>）、围栏代码块（```）、普通段落；
 *  - 行内：行内代码（`code`）、粗体（**bold**）、斜体（*italic*）。
 *
 * 纯函数，可在 Node 测试环境与浏览器直接复用。
 */

/**
 * 解析一段行内文本为 token 数组：`{ type: 'text' | 'code' | 'bold' | 'italic', text }`。
 *
 * @param {string} source
 * @returns {Array<{ type: string, text: string }>}
 */
export function parseInline(source) {
  const input = typeof source === 'string' ? source : ''
  if (!input) return []
  const tokens = []
  // 优先级：行内代码 > 粗体 > 斜体（避免 ** 里套 ` 或单个 * 误匹配）。
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+?\*\*|\*[^*\n]+?\*)/g
  let lastIndex = 0
  let match
  while ((match = pattern.exec(input)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ type: 'text', text: input.slice(lastIndex, match.index) })
    }
    const raw = match[0]
    if (raw.startsWith('`') && raw.endsWith('`') && raw.length >= 2) {
      tokens.push({ type: 'code', text: raw.slice(1, -1) })
    } else if (raw.startsWith('**') && raw.endsWith('**') && raw.length >= 4) {
      tokens.push({ type: 'bold', text: raw.slice(2, -2) })
    } else if (raw.startsWith('*') && raw.endsWith('*') && raw.length >= 2) {
      tokens.push({ type: 'italic', text: raw.slice(1, -1) })
    } else {
      tokens.push({ type: 'text', text: raw })
    }
    lastIndex = pattern.lastIndex
  }
  if (lastIndex < input.length) {
    tokens.push({ type: 'text', text: input.slice(lastIndex) })
  }
  return tokens
}

/**
 * 将 Markdown 文本解析为块级节点列表。
 *
 * @param {string} source
 * @returns {Array<object>}
 */
export function parseMarkdown(source) {
  const text = typeof source === 'string' ? source.replace(/\r\n?/g, '\n') : ''
  if (!text.trim()) return []
  const lines = text.split('\n')
  const blocks = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]
    const trimmed = line.trim()

    if (!trimmed) {
      index += 1
      continue
    }

    // 围栏代码块（流式半截未闭合时也安全收口为代码块）。
    const fence = trimmed.match(/^```([a-zA-Z0-9_-]*)\s*$/)
    if (fence) {
      const lang = fence[1] || ''
      const codeLines = []
      index += 1
      while (index < lines.length && !lines[index].trim().startsWith('```')) {
        codeLines.push(lines[index])
        index += 1
      }
      if (index < lines.length && lines[index].trim().startsWith('```')) index += 1
      blocks.push({ type: 'code', lang, text: codeLines.join('\n') })
      continue
    }

    // 标题（1~4 级，窄栏内统一映射为紧凑小标题）。
    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/)
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, tokens: parseInline(heading[2].trim()) })
      index += 1
      continue
    }

    // 引用块。
    if (/^>\s?/.test(trimmed)) {
      const quoteLines = []
      while (index < lines.length && /^>\s?/.test(lines[index].trim())) {
        quoteLines.push(lines[index].trim().replace(/^>\s?/, ''))
        index += 1
      }
      blocks.push({ type: 'quote', tokens: parseInline(quoteLines.join('\n')) })
      continue
    }

    // 无序列表。
    if (/^[-*•]\s+/.test(trimmed)) {
      const items = []
      while (index < lines.length && /^[-*•]\s+/.test(lines[index].trim())) {
        items.push(parseInline(lines[index].trim().replace(/^[-*•]\s+/, '')))
        index += 1
      }
      blocks.push({ type: 'list', ordered: false, items })
      continue
    }

    // 有序列表。
    if (/^\d+\.\s+/.test(trimmed)) {
      const items = []
      while (index < lines.length && /^\d+\.\s+/.test(lines[index].trim())) {
        items.push(parseInline(lines[index].trim().replace(/^\d+\.\s+/, '')))
        index += 1
      }
      blocks.push({ type: 'list', ordered: true, items })
      continue
    }

    // 普通段落：合并相邻的非特殊文本行。
    const paraLines = []
    while (index < lines.length) {
      const current = lines[index]
      const curTrim = current.trim()
      if (!curTrim) break
      if (
        curTrim.startsWith('```')
        || /^(#{1,4})\s+/.test(curTrim)
        || /^>\s?/.test(curTrim)
        || /^[-*•]\s+/.test(curTrim)
        || /^\d+\.\s+/.test(curTrim)
      ) {
        break
      }
      paraLines.push(current)
      index += 1
    }
    if (paraLines.length > 0) {
      blocks.push({ type: 'paragraph', tokens: parseInline(paraLines.join('\n')) })
    } else {
      index += 1
    }
  }

  return blocks
}
