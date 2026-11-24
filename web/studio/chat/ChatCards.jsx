/**
 * 创作助手卡片子组件集：澄清卡、步骤时间线、探索方案卡与生成确认卡。
 *
 * 从 ChatPanel.jsx 拆出，保持主面板聚焦在消息流、内联单图操作与一体化输入坞编排上。
 * 所有文案统一走 t()，严格遵循「黑白灰数字印相室」低噪、克制、信息分层原则。
 */

import React from 'react'

import { LIMITS, publicPresets } from '../../../shared/contract.js'

import { COUNT_OPTIONS } from '../../constants.js'
import { proposalTargetOf, toolLabelOf } from '../../logic/chat.js'
import { formatText } from '../../logic/format.js'
import { intentCount } from '../../logic/intent.js'
import { providerLabelOf } from '../../logic/status.js'
import { Icon } from '../icons.jsx'

const WORKING_STAGES = ['pending', 'queued', 'running']
const ACTIVE_SESSION_STATES = ['provisioning', 'connecting', 'warming', 'ready', 'stopping']
const PUBLIC_PRESET_LIST = publicPresets()

export function isWorkingStage(stage) {
  return WORKING_STAGES.indexOf(stage) >= 0
}

export function ratioLabelOf(t, ratioId) {
  return ratioId || t('studio.chat.ratioAuto')
}

export function modelLabelOf(presetId) {
  const preset = PUBLIC_PRESET_LIST.find((item) => item && item.id === presetId)
  return preset ? (preset.label || preset.short || preset.id) : ''
}

/** 轻量复制按钮：点击复制文本并在 1.5s 内显示勾选反馈。 */
export function CopyMiniButton({ text, t, className = '' }) {
  const [copied, setCopied] = React.useState(false)
  const timerRef = React.useRef(null)
  React.useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

  function handleCopy() {
    const value = typeof text === 'string' ? text.trim() : ''
    if (!value) return
    const nav = typeof navigator !== 'undefined' ? navigator : null
    if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
      void nav.clipboard.writeText(value)
    }
    setCopied(true)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setCopied(false), 1500)
  }

  const label = copied ? t('studio.chat.copied') : t('studio.chat.copy')
  return (
    <button
      type="button"
      className={className ? `ofs-chat-copy-btn ${className}${copied ? ' is-copied' : ''}` : `ofs-chat-copy-btn${copied ? ' is-copied' : ''}`}
      onClick={handleCopy}
      aria-label={label}
      title={label}
    >
      <Icon name={copied ? 'check' : 'copy'} size={11} />
      <span>{label}</span>
    </button>
  )
}

/**
 * 澄清卡（支持单维度单选即提交 / 多维度多选累积提交 / 「先按当前设置」兜底）。
 */
export function ClarifyCard({ t, message, resolve, locked }) {
  const clarify = message.clarify && typeof message.clarify === 'object' ? message.clarify : {}
  const question = typeof clarify.question === 'string' ? clarify.question : ''
  const dimensions = Array.isArray(clarify.dimensions) && clarify.dimensions.length > 0 ? clarify.dimensions : null
  const legacyOptions = Array.isArray(clarify.options) ? clarify.options : []
  const [picked, setPicked] = React.useState({})
  const disabled = locked === true

  const instant = dimensions
    ? dimensions.length === 1 && dimensions[0].multi !== true
    : true

  function toggle(dimension, option) {
    if (disabled) return
    if (instant) {
      resolve(message.id, option.value || option.label || option)
      return
    }
    setPicked((prev) => {
      const current = Array.isArray(prev[dimension.id]) ? prev[dimension.id] : []
      const exists = current.includes(option.value)
      const next = dimension.multi
        ? (exists ? current.filter((item) => item !== option.value) : [...current, option.value])
        : [option.value]
      return { ...prev, [dimension.id]: next }
    })
  }

  const summary = dimensions
    ? dimensions
      .map((dimension) => {
        const values = Array.isArray(picked[dimension.id]) ? picked[dimension.id] : []
        if (values.length === 0) return ''
        const labels = values.map((value) => {
          const found = dimension.options.find((option) => option.value === value)
          return found ? found.label : value
        })
        return `${dimension.label}：${labels.join('、')}`
      })
      .filter(Boolean)
      .join('；')
    : ''

  return (
    <div className="ofs-msg-card ofs-intent ofs-intent-clarify" key={message.id}>
      <div className="ofs-intent-head">
        <span className="ofs-intent-title">{t('studio.chat.clarify.title')}</span>
      </div>
      {question ? <p className="ofs-intent-question">{question}</p> : null}
      {dimensions ? (
        <div className="ofs-clarify-dimensions">
          {dimensions.map((dimension) => {
            const values = Array.isArray(picked[dimension.id]) ? picked[dimension.id] : []
            return (
              <div className="ofs-clarify-dimension" key={dimension.id}>
                <div className="ofs-clarify-dimension-head">
                  <span className="ofs-clarify-dimension-label">{dimension.label}</span>
                  <span className="ofs-clarify-dimension-mode">
                    {dimension.multi ? t('studio.chat.clarify.multi') : t('studio.chat.clarify.single')}
                  </span>
                </div>
                <div className="ofs-suggestions">
                  {dimension.options.map((option) => {
                    const on = values.includes(option.value)
                    return (
                      <button
                        type="button"
                        key={option.value}
                        className={on ? 'ofs-suggestion is-on' : 'ofs-suggestion'}
                        aria-pressed={on}
                        disabled={disabled}
                        onClick={() => toggle(dimension, option)}
                      >
                        {on ? <Icon name="check" size={11} className="ofs-suggestion-check" /> : null}
                        <span>{option.label}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="ofs-suggestions">
          {legacyOptions.map((option) => (
            <button
              type="button"
              key={option}
              className="ofs-suggestion"
              disabled={disabled}
              onClick={() => resolve(message.id, option)}
            >
              {option}
            </button>
          ))}
        </div>
      )}
      <div className="ofs-clarify-actions">
        {dimensions && !instant ? (
          <button
            type="button"
            className="ofs-btn is-primary ofs-clarify-submit"
            disabled={!summary || disabled}
            onClick={() => resolve(message.id, summary)}
          >
            {t('studio.chat.clarify.submit')}
          </button>
        ) : null}
        <button
          type="button"
          className="ofs-btn is-quiet ofs-clarify-auto"
          disabled={disabled}
          onClick={() => resolve(message.id, '')}
        >
          {t('studio.chat.clarify.auto')}
        </button>
      </div>
      <p className="ofs-clarify-footnote">{t('studio.chat.clarify.orType')}</p>
    </div>
  )
}

/**
 * 思考与工具步骤时间线：
 *  - 工具内部名映射为自然中文/英文动作标签，不再裸吐 `ui_propose_generation` 等开发符号；
 *  - 保留 `data-tool-name` 与 `title` 便于排查；
 *  - 流式进行中默认展开，完成后自动收起成一行极简摘要。
 */
export function AgentStepTimeline({ t, message }) {
  const tools = Array.isArray(message.tools) ? message.tools.filter((item) => item && item.name) : []
  const reasoning = typeof message.reasoning === 'string' ? message.reasoning.trim() : ''
  if (tools.length === 0 && !reasoning) return null
  const working = isWorkingStage(message.stage)
  const doneCount = tools.filter((tool) => tool.status === 'done').length
  const failedCount = tools.filter((tool) => tool.status === 'failed').length
  const summary = tools.length > 0
    ? formatText(t('studio.chat.steps.summary'), { count: tools.length, done: doneCount })
    : t('studio.chat.steps.thinking')

  return (
    <details className="ofs-chat-steps" open={working}>
      <summary className="ofs-chat-steps-summary">
        <span className={working ? 'ofs-dot ofs-chat-dot is-warn is-live' : 'ofs-dot ofs-chat-dot is-ok'} aria-hidden="true" />
        <span className="ofs-chat-steps-text">{working ? t('studio.chat.agent.streaming') : summary}</span>
        {failedCount > 0 ? <span className="ofs-chip ofs-chat-steps-fail">{failedCount}</span> : null}
        <span className="ofs-grow" />
        <Icon name="chevronDown" size={12} className="ofs-chat-steps-caret" />
      </summary>
      <div className="ofs-chat-steps-body">
        {reasoning ? <p className="ofs-chat-steps-reasoning">{reasoning}</p> : null}
        {tools.length > 0 ? (
          <div className="ofs-chat-tools-log">
            {tools.map((tool, index) => {
              const status = tool.status || 'running'
              const statusText = status === 'done'
                ? t('studio.chat.agent.toolDone')
                : status === 'failed'
                  ? t('studio.chat.agent.toolFailed')
                  : t('studio.chat.agent.toolRunning')
              const label = toolLabelOf(t, tool.name)
              return (
                <span
                  key={tool.id || `${tool.name}-${index}`}
                  className={`ofs-chat-tool-chip is-${status}`}
                  data-tool-name={tool.name}
                  title={`${tool.name} · ${statusText}`}
                >
                  <span className="ofs-chat-tool-state" aria-hidden="true">
                    {status === 'done' ? (
                      <Icon name="check" size={10} />
                    ) : status === 'failed' ? (
                      <Icon name="alert" size={10} />
                    ) : (
                      <span className="ofs-dot ofs-chat-dot is-warn is-live" />
                    )}
                  </span>
                  <span className="ofs-chat-tool-label">{label}</span>
                  <span className="ofs-chat-tool-status">{statusText}</span>
                </span>
              )
            })}
          </div>
        ) : null}
      </div>
    </details>
  )
}

/** 探索进度细条：用于探索方案卡和运行中/已完成的探索助手气泡。 */
export function ExploreProgress({ t, progress, showDone = false }) {
  if (!progress || typeof progress !== 'object') return null
  const produced = Math.max(0, Number(progress.produced) || 0)
  const maxImages = Math.max(1, Number(progress.maxImages) || 8)
  const exhausted = Boolean(progress.exhausted)
  if (!showDone && produced <= 0 && !exhausted) return null
  const percent = Math.min(100, Math.round((produced / maxImages) * 100))
  return (
    <div className="ofs-explore-progress">
      <div className="ofs-explore-progress-track">
        <div className="ofs-explore-progress-bar" style={{ width: `${percent}%` }} />
      </div>
      <span className="ofs-explore-progress-label">
        {formatText(t('studio.chat.explore.progress'), { produced, max: maxImages })}
        {showDone && exhausted ? ` · ${t('studio.chat.explore.done')}` : ''}
      </span>
    </div>
  )
}

/** M3.5 Phase C：探索方案卡。 */
export function ExploreCard({ t, message, startExplore, locked, sending, interpreting }) {
  const explore = message.explore
  const start = typeof startExplore === 'function' ? startExplore : () => {}
  const disabled = locked || sending || interpreting || Boolean(explore.exhausted)
  const maxImages = Math.max(1, Number(explore.maxImages) || 8)

  return (
    <div className="ofs-msg-card ofs-intent ofs-intent-explore" key={message.id}>
      <div className="ofs-intent-head">
        <span className="ofs-intent-title">{t('studio.chat.explore.title')}</span>
        {explore.presetId && modelLabelOf(explore.presetId) ? (
          <span className="ofs-chip ofs-intent-pill is-model">{modelLabelOf(explore.presetId)}</span>
        ) : null}
      </div>
      <p className="ofs-explore-strategy">{explore.strategy}</p>
      <div className="ofs-explore-budget">
        <span className="ofs-chip ofs-intent-pill">
          {formatText(t('studio.chat.explore.rounds'), { count: explore.maxRounds })}
        </span>
        <span className="ofs-chip ofs-intent-pill">
          {formatText(t('studio.chat.explore.images'), { count: maxImages })}
        </span>
        {explore.estCost ? (
          <span className="ofs-chip ofs-intent-pill is-cost">{explore.estCost}</span>
        ) : null}
      </div>
      {explore.basePrompt ? (
        <p className="ofs-explore-prompt" title={explore.basePrompt}>{explore.basePrompt}</p>
      ) : null}
      {explore.notes ? <p className="ofs-intent-notes">{explore.notes}</p> : null}
      <ExploreProgress t={t} progress={explore} showDone={false} />
      <div className="ofs-intent-actions">
        <button
          type="button"
          className="ofs-btn is-primary ofs-explore-go"
          disabled={disabled}
          onClick={() => start(message.id)}
        >
          {explore.exhausted ? t('studio.chat.explore.done') : t('studio.chat.explore.start')}
        </button>
      </div>
      <p className="ofs-explore-hint">{t('studio.chat.explore.hint')}</p>
    </div>
  )
}

/**
 * 生成确认卡 2.0：
 *  - 顶部统一规格行（模型 + 画幅比例 + 种子），彻底移除重复比例行；
 *  - 中文摘要作为第一阅读焦点；
 *  - 英文提示词区紧凑排版并带一键复制；已提交的历史卡自动收敛为轻量只读态，避免满屏大黑按钮；
 *  - 张数 1~4 分段与「锁种」精简合一在一行控制条内。
 */
export function IntentCard(props) {
  const {
    t,
    message,
    compute,
    negativeActive,
    locked,
    sending,
    canLockSeed,
    updateIntentField,
    generateIntent,
    handoff,
    toggleIntentLockSeed,
  } = props

  const submitted = message.submitted === true
  const [editingSubmitted, setEditingSubmitted] = React.useState(false)
  const expanded = !submitted || editingSubmitted

  const editField = typeof updateIntentField === 'function' ? updateIntentField : () => {}
  const promptValue = typeof message.prompt === 'string' ? message.prompt : ''
  const negativeValue = typeof message.negative === 'string' ? message.negative : ''
  const canGenerate = promptValue.trim().length > 0
  const summary = typeof message.summary === 'string' ? message.summary.trim() : ''
  const showSummary = summary.length > 0 && summary !== promptValue.trim()
  const count = intentCount(message.count)
  const hint = message.modelHint && typeof message.modelHint === 'object' ? message.modelHint : null
  const hintModel = hint ? modelLabelOf(hint.presetId) : ''
  const hintText = hint && hintModel && typeof hint.reason === 'string'
    ? formatText(t('studio.chat.intent.modelHint'), { model: hintModel, reason: hint.reason })
    : ''

  const proposal = message.proposal === true
  const presetLabel = proposal ? modelLabelOf(message.presetId) : ''
  const notes = proposal && typeof message.notes === 'string' ? message.notes.trim() : ''

  const target = proposal
    ? proposalTargetOf(message.presetId, {
        provider: compute && compute.provider,
        presets: compute && Array.isArray(compute.presets) ? compute.presets : undefined,
      })
    : null
  const crossTarget = target && target.kind === 'cross' ? target : null
  const crossLabel = crossTarget ? providerLabelOf(t, crossTarget.targetProvider) : ''
  const crossBlocked = Boolean(crossTarget && target && target.gated && compute && compute.hfTokenConfigured === false)
  const session = compute && compute.session ? compute.session : null
  const sessionProvider = session && typeof session.provider === 'string' && session.provider
    ? session.provider
    : (compute && compute.provider)
  const crossHot = Boolean(
    crossTarget
    && session
    && ACTIVE_SESSION_STATES.includes(session.state)
    && providerLabelOf(t, sessionProvider) !== crossLabel,
  )
  const crossHintText = crossTarget && crossLabel
    ? (crossHot
      ? formatText(t('studio.chat.intent.crossHot'), {
          from: providerLabelOf(t, sessionProvider),
          to: crossLabel,
        })
      : formatText(t('studio.chat.intent.crossHint'), { provider: crossLabel }))
    : ''

  const generateLabel = crossTarget && crossLabel
    ? formatText(t('studio.chat.intent.switchGenerate'), { provider: crossLabel })
    : (submitted && !editingSubmitted ? t('studio.chat.intent.generateAgain') : t('studio.chat.intent.generate'))

  const ratioText = ratioLabelOf(t, message.ratioId)

  return (
    <div className={submitted && !editingSubmitted ? 'ofs-msg-card ofs-intent is-submitted' : 'ofs-msg-card ofs-intent'} key={message.id}>
      <div className="ofs-intent-head">
        <span className="ofs-intent-title">{t('studio.chat.intent.title')}</span>
        <span className="ofs-grow" />
        {submitted ? (
          <span className="ofs-intent-submitted-badge">
            <Icon name="check" size={10} />
            <span>{t('studio.chat.intent.submitted')}</span>
          </span>
        ) : null}
        {submitted ? (
          <button
            type="button"
            className="ofs-intent-expand-btn"
            onClick={() => setEditingSubmitted((open) => !open)}
          >
            <Icon name="edit" size={11} />
            <span>{editingSubmitted ? t('studio.chat.intent.collapse') : t('studio.chat.intent.editAgain')}</span>
          </button>
        ) : null}
      </div>

      {/* 规格胶囊行：模型 / 画幅比例 / 固定种子，只展示一次不重复。 */}
      <div className="ofs-intent-pills">
        {presetLabel ? <span className="ofs-chip ofs-intent-pill is-model">{presetLabel}</span> : null}
        <span className="ofs-chip ofs-intent-pill">{ratioText}</span>
        {message.seed !== null && message.seed !== undefined ? (
          <span className="ofs-chip ofs-intent-pill">{`${t('studio.meta.seed')} ${message.seed}`}</span>
        ) : null}
        {submitted && !editingSubmitted ? (
          <span className="ofs-chip ofs-intent-pill">{`${count} ${t('unit.image')}`}</span>
        ) : null}
      </div>

      {/* 中文摘要优先：先让用户一眼确认画面语义。 */}
      {showSummary ? (
        <p className="ofs-intent-summary">{summary}</p>
      ) : null}

      {notes ? <p className="ofs-intent-note">{notes}</p> : null}

      {crossHintText && expanded ? (
        <p className="ofs-intent-cross">{crossHintText}</p>
      ) : null}
      {crossBlocked && expanded ? (
        <p className="ofs-intent-cross is-blocked">
          {formatText(t('studio.chat.intent.crossGated'), { model: presetLabel || message.presetId })}
        </p>
      ) : null}

      {expanded ? (
        <>
          <div className="ofs-intent-field">
            <div className="ofs-intent-field-head">
              <label className="ofs-intent-field-label" htmlFor={`ofs-intent-prompt-${message.id}`}>
                {t('studio.chat.intent.promptLabel')}
              </label>
              <CopyMiniButton text={promptValue} t={t} />
            </div>
            <textarea
              id={`ofs-intent-prompt-${message.id}`}
              className="ofs-intent-prompt"
              rows={2}
              value={promptValue}
              maxLength={LIMITS.prompt.maxChars}
              spellCheck={false}
              disabled={locked}
              aria-label={t('studio.chat.intent.promptLabel')}
              onChange={(event) => editField(message.id, 'prompt', event.target.value)}
            />
          </div>

          {hintText ? <p className="ofs-intent-model-hint">{hintText}</p> : null}

          {negativeActive ? (
            <div className="ofs-intent-field">
              <div className="ofs-intent-field-head">
                <label className="ofs-intent-field-label" htmlFor={`ofs-intent-negative-${message.id}`}>
                  {t('studio.chat.intent.negativeLabel')}
                </label>
              </div>
              <textarea
                id={`ofs-intent-negative-${message.id}`}
                className="ofs-intent-negative"
                rows={2}
                value={negativeValue}
                maxLength={LIMITS.negativePrompt.maxChars}
                placeholder={t('studio.chat.intent.negativePlaceholder')}
                spellCheck={false}
                disabled={locked}
                aria-label={t('studio.chat.intent.negativeLabel')}
                onChange={(event) => editField(message.id, 'negative', event.target.value)}
              />
            </div>
          ) : null}

          {message.source === 'local' ? <p className="ofs-intent-note">{t('studio.chat.intent.local')}</p> : null}

          {/* 张数分段 + 锁种开关收拢在紧凑控制行内。 */}
          <div className="ofs-intent-controls">
            <div className="ofs-intent-qty-row">
              <span className="ofs-intent-qty-label">{t('studio.countShort')}</span>
              <div
                className="ofs-intent-qty"
                role="group"
                aria-label={t('studio.count')}
                style={{ '--ofs-qty-index': String(Math.max(0, COUNT_OPTIONS.indexOf(count))) }}
              >
                <span className="ofs-qty-thumb" aria-hidden="true" />
                {COUNT_OPTIONS.map((option) => (
                  <button
                    type="button"
                    key={option}
                    className={option === count ? 'ofs-intent-qty-option is-on' : 'ofs-intent-qty-option'}
                    aria-pressed={option === count}
                    disabled={locked}
                    onClick={() => editField(message.id, 'count', option)}
                  >
                    {option}
                  </button>
                ))}
              </div>
            </div>

            <label
              className={`ofs-intent-lock${message.lockSeed === true ? ' is-on' : ''}${canLockSeed === false || locked ? ' is-disabled' : ''}`}
              title={t('studio.chat.intent.lockSeed')}
            >
              <input
                type="checkbox"
                checked={message.lockSeed === true}
                disabled={canLockSeed === false || locked}
                onChange={() => toggleIntentLockSeed(message.id)}
              />
              <Icon name="lock" size={11} />
              <span>{t('studio.chat.intent.lockSeedShort')}</span>
            </label>
          </div>
        </>
      ) : (
        promptValue ? (
          <p className="ofs-intent-prompt-preview" title={promptValue}>{promptValue}</p>
        ) : null
      )}

      <div className="ofs-intent-actions">
        <button
          type="button"
          className={submitted && !editingSubmitted ? 'ofs-btn is-quiet ofs-intent-go' : 'ofs-btn is-primary ofs-intent-go'}
          onClick={() => generateIntent(message)}
          disabled={sending || !canGenerate || locked || crossBlocked}
          title={crossBlocked ? formatText(t('studio.chat.intent.crossGated'), { model: presetLabel || message.presetId }) : undefined}
        >
          {sending ? t('studio.generating') : generateLabel}
        </button>
        <button
          type="button"
          className="ofs-btn is-quiet ofs-intent-handoff"
          onClick={() => handoff(message)}
          disabled={sending || !canGenerate || locked}
        >
          {t('studio.chat.intent.handoff')}
        </button>
      </div>
    </div>
  )
}
