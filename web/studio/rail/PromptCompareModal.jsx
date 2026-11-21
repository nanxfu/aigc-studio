/**
 * 提示词双栏对比与编辑弹窗：
 * 左侧只读展示润色前的原始草稿（支持复制与一键恢复），
 * 右侧提供宽敞的可编辑文本域实时同步左栏提示词，弥补左栏 362px 窄输入框对长文本阅读与微调的不便。
 */

import React from 'react'

import { Icon } from '../icons.jsx'

export function PromptCompareModal({
  t,
  open,
  onClose,
  originPrompt,
  prompt,
  maxLength,
  patchForm,
  onRestoreOrigin,
}) {
  const [copied, setCopied] = React.useState(false)
  const timerRef = React.useRef(null)

  React.useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

  React.useEffect(() => {
    if (!open || typeof window === 'undefined') return undefined
    function handleKeyDown(event) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  if (!open) return null

  async function copyOrigin() {
    if (!originPrompt || typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return
    try {
      await navigator.clipboard.writeText(originPrompt)
      setCopied(true)
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setCopied(false), 1400)
    } catch {}
  }

  function handleRestore() {
    onRestoreOrigin()
    onClose()
  }

  return (
    <div className="ofs-settings ofs-prompt-compare" role="presentation" onClick={onClose}>
      <div
        className="ofs-prompt-compare-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t('studio.refine.compareTitle')}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="ofs-prompt-compare-head">
          <span className="ofs-prompt-compare-title">{t('studio.refine.compareTitle')}</span>
          <button
            type="button"
            className="ofs-icon-btn"
            aria-label={t('studio.guidance.close')}
            onClick={onClose}
          >
            <Icon name="close" size={16} />
          </button>
        </header>

        <div className="ofs-prompt-compare-grid">
          <div className="ofs-prompt-compare-col">
            <div className="ofs-prompt-compare-col-head">
              <span>{t('studio.refine.originLabel')}</span>
              <span className="ofs-counter">{originPrompt.length}</span>
            </div>
            <textarea
              className="ofs-prompt-compare-textarea is-readonly"
              value={originPrompt}
              readOnly
              spellCheck={false}
            />
            <div className="ofs-prompt-compare-col-foot">
              <button type="button" className="ofs-text-action" onClick={copyOrigin}>
                <Icon name={copied ? 'check' : 'copy'} size={12} />
                {copied ? t('studio.refine.copied') : t('studio.refine.copyOrigin')}
              </button>
              <button type="button" className="ofs-text-action is-accent" onClick={handleRestore}>
                {t('studio.refine.restoreOrigin')}
              </button>
            </div>
          </div>

          <div className="ofs-prompt-compare-col">
            <div className="ofs-prompt-compare-col-head">
              <span>{t('studio.refine.polishedLabel')}</span>
              <span className="ofs-counter">{prompt.length} / {maxLength}</span>
            </div>
            <textarea
              className="ofs-prompt-compare-textarea"
              value={prompt}
              maxLength={maxLength}
              spellCheck={false}
              onChange={(event) => patchForm({ prompt: event.target.value })}
            />
            <div className="ofs-prompt-compare-col-foot is-end">
              <button type="button" className="ofs-chip is-on ofs-prompt-compare-done" onClick={onClose}>
                {t('studio.refine.compareDone')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
