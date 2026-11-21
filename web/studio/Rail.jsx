/**
 * 左侧创作面板（表单式）。
 *
 * 分区按内容分组；接收 { t, ui, form, actions }。
 *
 * 0.13.0 布局（320px 单轨，自上而下）：
 *  1. 提示词：输入框 / 英译与润色 / 空白态灵感示例 / 润色建议。
 *  2. 参考图（阶段十五 Phase C2，仅当前模型支持原生参考生图或槽位非空时出现）。
 *  3. 画面设置：标题栏实时显示当前像素读数；5 个画幅比例 → 「自定义宽高」折叠。
 *  4. 高级设置（折叠）：排除项仅在当前模型/CFG 可用时出现；步数、CFG、随机种子。
 *  5. 页脚：生成张数 1~4 → 立即生成 → 规格摘要。
 *
 * 阶段十五 Phase A1：面板顶部在有未提交修改时显示「已修改… · 尚未生成」+
 * 「恢复原参数」，替代原来的「正在微调：{prompt}」行（两者互斥）。
 *
 * 主表单只做纯文生图：参考图 / 蒙版 / 重绘强度随左栏参考图区一起删除，
 * 图片处理入口统一在舞台底部动作坞（见 `studio.rail.imageToolsHint`）。
 * Phase C2 的参考图槽只提交作品路径（`references`），不传 base64、不吃 strength。
 */

import React from 'react'

import { COUNT_OPTIONS } from '../constants.js'
import { clampSize } from '../logic/clamp.js'
import { formatText } from '../logic/format.js'
import { isBareImportOf, presetLabelOf } from '../logic/generate.js'
import { referenceHas } from '../logic/reference.js'
import { Icon } from './icons.jsx'
import { PanelModeTabs } from './PanelModeTabs.jsx'
import { FrameSection } from './rail/FrameSection.jsx'
import { ParamsSection } from './rail/ParamsSection.jsx'
import { PromptSection } from './rail/PromptSection.jsx'
import { ReferenceSection } from './rail/ReferenceSection.jsx'

export function Rail(props) {
  const { t, ui, form, actions, library, embedded, compute } = props
  const {
    advancedOpen,
    toggleAdvancedOpen,
    setAdvancedOpen,
    negativeOpen,
    setNegativeOpen,
    panelMode: mode,
    setPanelMode: setMode,
  } = ui
  // 业务路径由 useStudioUi 的 toggleAdvancedOpen 更新并持久化；
  // 预览 / 测试只注入 setAdvancedOpen 时退化为纯本地切换。
  const toggleAdvanced = typeof toggleAdvancedOpen === 'function'
    ? toggleAdvancedOpen
    : () => setAdvancedOpen((open) => !open)
  const {
    form: fields,
    patchForm,
    ratioId,
    activePreset,
    applyRatio,
    applyCustomSize,
    applyCfg,
    resetSeed,
    negativeActive,
    negativeHint,
    refineGroups,
    refineSource,
    enhancing,
    enhance,
    translating,
    translate,
    toggleRefine,
    englishPromptHint,
    // 微调来源（从胶卷 / 画廊回填而来）、未提交草稿状态与「新建创作」重置入口。
    tuning,
    newCreation,
    draftView,
    // 原生参考图槽（阶段十五 Phase C2）：能力位、切换目标名与契约上限。
    referenceSupported,
    referenceSwitchLabel,
    referenceMax,
  } = form
  const { sending, generate, restoreOriginal } = actions

  const hasPrompt = fields.prompt.trim().length > 0
  const currentWidth = clampSize(fields.width)
  const currentHeight = clampSize(fields.height)
  const frameSizeText = `${currentWidth} × ${currentHeight}`

  // 微调来源：当前参数来自哪张作品；提示只说明状态，不拦截任何操作。
  const tuningPrompt = tuning && typeof tuning === 'object' && typeof tuning.prompt === 'string'
    ? tuning.prompt.trim()
    : ''
  const tuningText = formatText(t('studio.rail.tuning'), {
    prompt: tuningPrompt || t('studio.rail.tuningUnknown'),
  })
  // 未提交草稿（1A 多作品草稿）：只对当前正在编辑的作品展示状态 +「恢复原参数」。
  // 只有确实有来源作品时才给还原入口（来源已丢失时只保留状态文案）。
  const draftSource = draftView && draftView.active && draftView.source ? draftView.source : null
  const draftActive = Boolean(draftView && draftView.active && draftView.source)
  const canRestore = Boolean(draftSource) && typeof restoreOriginal === 'function'
  const draftPrompt = draftSource && typeof draftSource.prompt === 'string' ? draftSource.prompt.trim() : ''
  // 明确告诉用户「改了什么」：切换模型是最容易让人迷惑的一类改动（用户以为只是换模型，
  // 界面却弹「正在编辑」）。这里把模型切换/提示词/尺寸/参数拆成具体文案。
  const originPatch = form.origin && form.origin.patch && typeof form.origin.patch === 'object'
    ? form.origin.patch
    : null
  const presetChanged = Boolean(
    originPatch
    && typeof originPatch.presetId === 'string'
    && originPatch.presetId
    && originPatch.presetId !== fields.presetId,
  )
  const changeItems = []
  if (originPatch) {
    if (
      typeof originPatch.prompt === 'string'
      && originPatch.prompt.trim() !== fields.prompt.trim()
    ) {
      changeItems.push(t('studio.rail.draftChange.prompt'))
    }
    const originWidth = Number(originPatch.width)
    const originHeight = Number(originPatch.height)
    if (
      (Number.isFinite(originWidth) && originWidth !== currentWidth)
      || (Number.isFinite(originHeight) && originHeight !== currentHeight)
    ) {
      changeItems.push(t('studio.rail.draftChange.size'))
    }
    const originSteps = Number(originPatch.steps)
    const originCfg = Number(originPatch.cfg)
    if (
      (Number.isFinite(originSteps) && originSteps !== Number(fields.steps))
      || (Number.isFinite(originCfg) && originCfg !== Number(fields.cfg))
    ) {
      changeItems.push(t('studio.rail.draftChange.params'))
    }
    const originSeed = typeof originPatch.seed === 'string' ? originPatch.seed.trim() : ''
    const currentSeed = String(fields.seed ?? '').trim()
    if (originSeed !== currentSeed) changeItems.push(t('studio.rail.draftChange.seed'))
  }
  const draftStatusText = presetChanged
    ? formatText(t('studio.rail.draftStatusModel'), { preset: presetLabelOf(activePreset) || fields.presetId })
    : changeItems.length > 0
      ? formatText(t('studio.rail.draftStatusItems'), {
          items: changeItems.join(t('studio.rail.draftChange.listSeparator')),
        })
      : t('studio.rail.draftStatus')
  const startNewCreation = typeof newCreation === 'function' ? newCreation : () => {}
  // 受限模型（gated）预检：未配置 HF Token 时，生成一定会失败；在左栏直接给出可执行提示。
  const gatedTokenMissing = Boolean(
    activePreset && activePreset.gated === true && compute && compute.hfTokenConfigured === false,
  )

  // 排除项：只有当前模型 + CFG 真的消费负向词时才出现（Host 与 Client 共用同一判定）。
  const showNegative = negativeActive === true
  const negativePlaceholder = negativeHint.length > 60
    ? `${negativeHint.slice(0, 60)}…`
    : (negativeHint || t('studio.negativePlaceholder'))

  // 页脚规格摘要：尺寸 · 比例 · 张数。
  const countValue = Number.isFinite(Number(fields.count)) ? Math.round(Number(fields.count)) : 1
  const qtyIndex = Math.max(0, COUNT_OPTIONS.indexOf(countValue))
  const specParts = [
    frameSizeText,
    ratioId || t('studio.rail.custom'),
    `${countValue} ${t('unit.image')}`,
  ]

  // 舞台停在无生成元数据的裸导入图、且用户正在左栏写词（未把该图挂进参考槽）时，
  // 顶部状态位给出极简的「纯文生图」标记 + 两个直达动作胶囊，防止误以为左栏会自动引用舞台图。
  const selectedWork = library && library.selected && typeof library.selected === 'object' ? library.selected : null
  const selectedWorkPath = selectedWork && selectedWork.image && typeof selectedWork.image.path === 'string'
    ? selectedWork.image.path.trim()
    : ''
  const showStageLinkChip = Boolean(
    library
    && library.workspaceMode === 'work'
    && selectedWorkPath
    && isBareImportOf(selectedWork)
    && hasPrompt
    && !referenceHas(fields.references, selectedWorkPath)
    && !draftActive
    && !tuning
  )

  const content = (
    <>
      {embedded ? null : (
        <PanelModeTabs t={t} mode={mode} setMode={setMode} onNewCreation={startNewCreation} />
      )}

      {/* 阶段十五 A1：有未提交草稿时顶部换成草稿状态 + 「还原原图」；
          否则保留原有的「正在微调：某张作品」轻量提示行。 */}
      {draftActive ? (
        <div className="ofs-tuning is-draft">
          <p className="ofs-tuning-source" title={draftPrompt || undefined}>
            {draftStatusText}
          </p>
          {canRestore ? (
            <button
              type="button"
              className="ofs-tuning-restore"
              onClick={() => restoreOriginal()}
              title={t('studio.rail.restoreOriginal')}
            >
              {t('studio.rail.restoreOriginal')}
            </button>
          ) : null}
        </div>
      ) : tuning ? (
        <div className="ofs-tuning">
          <p className="ofs-tuning-source" title={tuningPrompt || undefined}>{tuningText}</p>
        </div>
      ) : showStageLinkChip ? (
        <div className="ofs-tuning is-unlinked">
          <span className="ofs-tuning-source">
            <Icon name="sparkles" size={12} />
            {t('studio.rail.pureTextMode')}
          </span>
          <span className="ofs-tuning-actions">
            {actions && typeof actions.useAsReference === 'function' ? (
              <button
                type="button"
                className="ofs-tuning-pill"
                onClick={() => actions.useAsReference(selectedWork)}
              >
                <Icon name="plus" size={11} />
                {t('studio.reference.setAsReference')}
              </button>
            ) : null}
            {actions && typeof actions.openImageTool === 'function' ? (
              <button
                type="button"
                className="ofs-tuning-pill"
                onClick={() => actions.openImageTool('img2img', selectedWork)}
              >
                {t('studio.imageTool.img2img')}
              </button>
            ) : null}
          </span>
        </div>
      ) : null}

      {gatedTokenMissing ? (
        <div className="ofs-gate-hint" role="note">
          <Icon name="alert" size={12} />
          <span className="ofs-grow">
            {formatText(t('studio.rail.gatedHint'), {
              preset: presetLabelOf(activePreset) || fields.presetId,
            })}
          </span>
          {ui && typeof ui.openSettings === 'function' ? (
            <button
              type="button"
              className="ofs-gate-action"
              onClick={() => ui.openSettings(null, 'compute')}
            >
              {t('studio.rail.gatedAction')}
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="ofs-panel-scroll">
        <PromptSection
          t={t}
          prompt={fields.prompt}
          patchForm={patchForm}
          generate={generate}
          translating={translating}
          translate={translate}
          enhancing={enhancing}
          enhance={enhance}
          englishPromptHint={englishPromptHint}
          refineGroups={refineGroups}
          refineSource={refineSource}
          toggleRefine={toggleRefine}
        />

        {/* 阶段十五 Phase C2：原生参考图槽（提示词之后、画面设置之前）。
            当前模型不支持且槽位为空时组件自己隐藏，不占左栏空间。 */}
        <ReferenceSection
          t={t}
          references={fields.references}
          referenceSupported={referenceSupported === true}
          referenceSwitchLabel={referenceSwitchLabel || ''}
          referenceMax={referenceMax}
          works={library && Array.isArray(library.gallery) ? library.gallery : []}
          busy={Boolean(actions && actions.referenceUploading)}
          draggingWork={ui && ui.draggingWork ? ui.draggingWork : null}
          onEndWorkDrag={() => ui && typeof ui.setDraggingWork === 'function' && ui.setDraggingWork(null)}
          actions={actions}
        />

        <FrameSection
          t={t}
          width={fields.width}
          height={fields.height}
          frameSizeText={frameSizeText}
          ratioId={ratioId}
          applyRatio={applyRatio}
          applyCustomSize={applyCustomSize}
        />

        <ParamsSection
          t={t}
          fields={fields}
          activePreset={activePreset}
          patchForm={patchForm}
          applyCfg={applyCfg}
          resetSeed={resetSeed}
          showNegative={showNegative}
          negativeOpen={negativeOpen}
          setNegativeOpen={setNegativeOpen}
          negativePlaceholder={negativePlaceholder}
          advancedOpen={advancedOpen}
          toggleAdvanced={toggleAdvanced}
        />
      </div>

      <div className="ofs-panel-foot">
        {/* 生成张数提权到页脚：抽卡是高频动作，不再埋进高级折叠区。 */}
        <div className="ofs-qty-row">
          <span className="ofs-qty-label">{t('studio.countShort')}</span>
          <div
            className="ofs-qty"
            role="group"
            aria-label={t('studio.count')}
            style={{ '--ofs-qty-index': String(qtyIndex) }}
          >
            <span className="ofs-qty-thumb" aria-hidden="true" />
            {COUNT_OPTIONS.map((value) => (
              <button
                type="button"
                key={value}
                className={countValue === value ? 'ofs-qty-option is-on' : 'ofs-qty-option'}
                onClick={() => patchForm({ count: value })}
                aria-pressed={countValue === value}
              >
                {value}
              </button>
            ))}
          </div>
        </div>
        <button
          type="button"
          className={sending ? 'ofs-btn is-primary ofs-generate is-busy' : 'ofs-btn is-primary ofs-generate'}
          onClick={() => generate()}
          disabled={sending || !hasPrompt}
        >
          <Icon name="sparkles" size={16} />
          {sending ? t('studio.generating') : t('studio.generate')}
        </button>
        <p className="ofs-hint ofs-spec-summary">
          {specParts.join(' · ')}
        </p>
      </div>
    </>
  )

  if (embedded) return content
  return <aside className="ofs-panel ofs-panel--form">{content}</aside>
}
