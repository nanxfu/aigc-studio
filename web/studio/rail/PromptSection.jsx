/**
 * 左栏第 1 节：提示词输入、英译/润色、未配置模型气泡引导、
 * 动态多选微调抽屉以及双栏对照编辑弹窗。
 */

import React from 'react'

import { LIMITS } from '../../../shared/contract.js'

import { Tooltip } from '../../components/Tooltip.jsx'
import { formatText } from '../../logic/format.js'
import { Icon } from '../icons.jsx'
import { Drawer, useAnimateOpen } from './Drawer.jsx'
import { Fieldset } from './Fieldset.jsx'
import { PromptCompareModal } from './PromptCompareModal.jsx'

const PROMPT_MAX = LIMITS.prompt.maxChars

export function PromptSection({
  t,
  prompt,
  patchForm,
  generate,
  translating,
  translate,
  enhancing,
  mergingRefine,
  enhance,
  englishPromptHint,
  refineGroups,
  refineOriginPrompt,
  refineSelectedIds,
  refineNotice,
  dismissRefineNotice,
  toggleRefineOption,
  clearRefineSelection,
  applyRefineTweaks,
  restoreRefineOrigin,
  toggleRefine,
  onOpenAssistantSettings,
  onOpenCompare,
}) {
  // 润色建议默认展开，头部可收起。
  const [refineOpen, setRefineOpen] = React.useState(true)
  const [compareOpen, setCompareOpen] = React.useState(false)
  const actionsWrapRef = React.useRef(null)
  const animateOpen = useAnimateOpen()
  const promptLength = prompt.length
  const selectedIds = Array.isArray(refineSelectedIds) ? refineSelectedIds : []
  const selectedCount = selectedIds.length
  const busy = Boolean(enhancing || mergingRefine || translating)
  const hasOrigin = typeof refineOriginPrompt === 'string' && refineOriginPrompt.length > 0
  const showUnconfigured = Boolean(refineNotice && refineNotice.kind === 'unconfigured')

  // 点击气泡外区域或按 Esc 时自动收起未配置提示。
  React.useEffect(() => {
    if (!showUnconfigured || typeof document === 'undefined') return undefined
    function handlePointerDown(event) {
      if (actionsWrapRef.current && !actionsWrapRef.current.contains(event.target)) {
        if (typeof dismissRefineNotice === 'function') dismissRefineNotice()
      }
    }
    function handleKeyDown(event) {
      if (event.key === 'Escape' && typeof dismissRefineNotice === 'function') {
        dismissRefineNotice()
      }
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [showUnconfigured, dismissRefineNotice])

  function handleOptionClick(option) {
    if (typeof toggleRefineOption === 'function') {
      toggleRefineOption(option.id)
      return
    }
    if (typeof toggleRefine === 'function') {
      toggleRefine(option.text)
    }
  }

  function handleOpenSettings() {
    if (typeof dismissRefineNotice === 'function') dismissRefineNotice()
    if (typeof onOpenAssistantSettings === 'function') onOpenAssistantSettings()
  }

  return (
    <Fieldset
      title={t('studio.prompt')}
      action={<Tooltip text={t('studio.promptTooltip')} />}
    >
      <div className="ofs-composer">
        <textarea
          className="ofs-composer-input"
          value={prompt}
          maxLength={PROMPT_MAX}
          placeholder={t('studio.promptPlaceholder')}
          spellCheck={false}
          onChange={(event) => patchForm({ prompt: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) generate()
          }}
        />
        <div className="ofs-composer-foot">
          <span className="ofs-counter">
            {promptLength} / {PROMPT_MAX}
          </span>
          <span className="ofs-composer-actions-wrap" ref={actionsWrapRef}>
            {showUnconfigured ? (
              <div className="ofs-enhance-popover" role="dialog" aria-label={t('studio.enhance.unconfiguredTitle')}>
                <div className="ofs-enhance-popover-head">
                  <span className="ofs-enhance-popover-title">{t('studio.enhance.unconfiguredTitle')}</span>
                  <button
                    type="button"
                    className="ofs-enhance-popover-close"
                    aria-label={t('studio.guidance.close')}
                    onClick={() => typeof dismissRefineNotice === 'function' && dismissRefineNotice()}
                  >
                    <Icon name="close" size={12} />
                  </button>
                </div>
                <p className="ofs-enhance-popover-body">{t('studio.enhance.unconfiguredBody')}</p>
                <div className="ofs-enhance-popover-foot">
                  <button
                    type="button"
                    className="ofs-enhance-popover-btn"
                    onClick={handleOpenSettings}
                  >
                    {t('studio.enhance.goSettings')}
                  </button>
                </div>
              </div>
            ) : null}

            <span className="ofs-composer-actions">
              {/* 英译只是把当前提示词换成英文，不改写内容；含中文时在按钮本身做轻量高亮提示，不另起一行占高度。 */}
              <button
                type="button"
                className={englishPromptHint
                  ? 'ofs-text-action ofs-translate-action is-suggested'
                  : 'ofs-text-action ofs-translate-action'}
                title={englishPromptHint ? t('studio.prompt.englishHint') : undefined}
                onClick={translate}
                disabled={busy}
              >
                {translating ? t('studio.translate.thinking') : t('studio.translate.button')}
              </button>
              <button
                type="button"
                className="ofs-text-action"
                onClick={() => enhance({ action: 'initial' })}
                disabled={busy}
              >
                <Icon name="expandText" size={13} />
                {enhancing ? t('studio.enhance.thinking') : t('studio.enhance.button')}
              </button>
            </span>
          </span>
        </div>
      </div>

      {englishPromptHint ? (
        <p className="ofs-hint is-left ofs-prompt-lang-hint">{t('studio.prompt.englishHint')}</p>
      ) : null}

      {refineGroups.length > 0 || hasOrigin ? (
        <div className="ofs-refine">
          <div className="ofs-refine-head">
            <span>{t('studio.refine.title')}</span>
            <span className="ofs-refine-head-actions">
              {hasOrigin ? (
                <button
                  type="button"
                  className="ofs-text-action ofs-refine-toggle"
                  onClick={(event) => {
                    if (typeof onOpenCompare === 'function') {
                      onOpenCompare(event && event.currentTarget ? event.currentTarget : null)
                      return
                    }
                    setCompareOpen(true)
                  }}
                  title={t('studio.refine.compareTitle')}
                >
                  <Icon name="expand" size={11} />
                  {t('studio.refine.compare')}
                </button>
              ) : null}
              {hasOrigin ? (
                <button
                  type="button"
                  className="ofs-text-action ofs-refine-toggle"
                  onClick={restoreRefineOrigin}
                  disabled={busy}
                >
                  {t('studio.refine.restoreOrigin')}
                </button>
              ) : null}
              {refineGroups.length > 0 ? (
                <button
                  type="button"
                  className="ofs-text-action ofs-refine-toggle"
                  onClick={() => enhance({ action: 'refresh' })}
                  disabled={busy}
                >
                  {t('studio.refine.refresh')}
                </button>
              ) : null}
              {refineGroups.length > 0 ? (
                <button
                  type="button"
                  className="ofs-text-action ofs-refine-toggle"
                  aria-expanded={refineOpen}
                  onClick={() => setRefineOpen((open) => !open)}
                >
                  {refineOpen ? t('studio.refine.collapse') : t('studio.refine.expand')}
                </button>
              ) : null}
            </span>
          </div>
          {refineGroups.length > 0 ? (
            <Drawer open={refineOpen} animate={animateOpen}>
              <div className="ofs-refine-list">
                {refineGroups.map((group) => (
                  <div className="ofs-refine-group" key={group.dimension}>
                    <span className="ofs-refine-dim">
                      {group.label || t(`studio.refine.${group.dimension}`)}
                    </span>
                    <div className="ofs-suggestions">
                      {group.options.map((option) => {
                        const isSelected = Boolean(option.selected) || (!toggleRefineOption && Boolean(option.applied))
                        const isApplied = Boolean(option.applied)
                        const classes = ['ofs-suggestion']
                        if (isSelected) classes.push('is-on')
                        if (isApplied && !isSelected) classes.push('is-applied')
                        return (
                          <button
                            type="button"
                            key={option.id}
                            className={classes.join(' ')}
                            onClick={() => handleOptionClick(option)}
                            aria-pressed={isSelected}
                            title={option.text}
                            disabled={mergingRefine}
                          >
                            {isApplied && !isSelected ? <Icon name="check" size={11} /> : null}
                            {option.label || option.text}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                ))}

                <div className="ofs-refine-footer">
                  <span className="ofs-refine-selection-info">
                    {selectedCount > 0 ? (
                      <>
                        <span>{formatText(t('studio.refine.selectedCount'), { count: selectedCount })}</span>
                        <button
                          type="button"
                          className="ofs-text-action ofs-refine-clear"
                          onClick={clearRefineSelection}
                          disabled={busy}
                        >
                          {t('studio.refine.clearSelection')}
                        </button>
                      </>
                    ) : (
                      <span>{t('studio.refine.selectHint')}</span>
                    )}
                  </span>
                  <button
                    type="button"
                    className={selectedCount > 0 ? 'ofs-refine-apply is-ready' : 'ofs-refine-apply'}
                    onClick={applyRefineTweaks}
                    disabled={selectedCount === 0 || busy}
                  >
                    {mergingRefine ? t('studio.refine.merging') : t('studio.refine.apply')}
                  </button>
                </div>
              </div>
            </Drawer>
          ) : null}
        </div>
      ) : null}

      {typeof onOpenCompare !== 'function' ? (
        <PromptCompareModal
          t={t}
          open={compareOpen && hasOrigin}
          onClose={() => setCompareOpen(false)}
          originPrompt={refineOriginPrompt || ''}
          prompt={prompt}
          maxLength={PROMPT_MAX}
          patchForm={patchForm}
          onRestoreOrigin={restoreRefineOrigin}
        />
      ) : null}
    </Fieldset>
  )
}
