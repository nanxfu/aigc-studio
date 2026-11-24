/**
 * 创作助手轻量 Markdown 渲染器。
 *
 * 将 `parseMarkdown` 产出的纯数据 AST 映射为紧凑语义 DOM：
 * 绝不使用 `dangerouslySetInnerHTML`，代码块提供轻量一键复制。
 */

import React from 'react'

import { parseMarkdown } from '../../logic/markdown.js'
import { Icon } from '../icons.jsx'

function renderInline(tokens, keyPrefix) {
  return tokens.map((token, index) => {
    const key = `${keyPrefix}-${index}`
    if (token.type === 'bold') return <strong key={key}>{token.text}</strong>
    if (token.type === 'italic') return <em key={key}>{token.text}</em>
    if (token.type === 'code') return <code key={key} className="ofs-md-inline-code">{token.text}</code>
    return <React.Fragment key={key}>{token.text}</React.Fragment>
  })
}

function CodeBlock({ code, lang, t }) {
  const [copied, setCopied] = React.useState(false)
  const timerRef = React.useRef(null)
  React.useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

  function copy() {
    if (!code) return
    const nav = typeof navigator !== 'undefined' ? navigator : null
    if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
      void nav.clipboard.writeText(code)
    }
    setCopied(true)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div className="ofs-md-code">
      <div className="ofs-md-code-head">
        <span className="ofs-md-code-lang">{lang || 'prompt'}</span>
        <button
          type="button"
          className="ofs-md-code-copy"
          onClick={copy}
          aria-label={copied ? t('studio.chat.copied') : t('studio.chat.copy')}
          title={copied ? t('studio.chat.copied') : t('studio.chat.copy')}
        >
          <Icon name={copied ? 'check' : 'copy'} size={11} />
          <span>{copied ? t('studio.chat.copied') : t('studio.chat.copy')}</span>
        </button>
      </div>
      <pre className="ofs-md-code-pre"><code>{code}</code></pre>
    </div>
  )
}

export function ChatMarkdown({ text, t }) {
  const blocks = React.useMemo(() => parseMarkdown(text), [text])
  if (blocks.length === 0) return null
  return (
    <div className="ofs-md">
      {blocks.map((block, index) => {
        const key = `b-${index}`
        if (block.type === 'heading') {
          return <h4 key={key} className="ofs-md-heading">{renderInline(block.tokens, key)}</h4>
        }
        if (block.type === 'quote') {
          return <blockquote key={key} className="ofs-md-quote">{renderInline(block.tokens, key)}</blockquote>
        }
        if (block.type === 'list') {
          const Tag = block.ordered ? 'ol' : 'ul'
          return (
            <Tag key={key} className={block.ordered ? 'ofs-md-list is-ordered' : 'ofs-md-list'}>
              {block.items.map((itemTokens, itemIndex) => (
                <li key={`${key}-i-${itemIndex}`}>{renderInline(itemTokens, `${key}-i-${itemIndex}`)}</li>
              ))}
            </Tag>
          )
        }
        if (block.type === 'code') {
          return <CodeBlock key={key} code={block.text} lang={block.lang} t={t} />
        }
        return <p key={key} className="ofs-md-p">{renderInline(block.tokens, key)}</p>
      })}
    </div>
  )
}
