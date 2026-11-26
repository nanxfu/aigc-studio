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
 *
 * M2.6（导入图焦点隔离）：舞台停在裸导入图或其无参数放大产物时，整块表单与本面板
 * 页脚一起 `inert`（字段值原样保留），顶部换成锁定引导 + 「新建创作」出口；
 * 判定布尔值来自组合层 `library.importLocked`。
 */

import React from 'react'

import { COUNT_OPTIONS } from '../constants.js'
import { clampSize } from '../logic/clamp.js'
import { formSectionChangesOf, styleLoraChangedOf } from '../logic/form.js'
import { formatText } from '../logic/format.js'
import { presetLabelOf } from '../logic/generate.js'
import { precisionOptionsOf, variantRequestOf } from '../logic/preset.js'
import { referenceListOf } from '../logic/reference.js'
import { Icon } from './icons.jsx'
import { PanelModeTabs } from './PanelModeTabs.jsx'
import { FrameSection } from './rail/FrameSection.jsx'
import { ParamsSection } from './rail/ParamsSection.jsx'
import { PromptSection } from './rail/PromptSection.jsx'
import { ReferenceSection } from './rail/ReferenceSection.jsx'
import { StyleSection } from './rail/StyleSection.jsx'

export function Rail(props) {
  const { t, isEn, ui, form, actions, library, embedded, compute } = props
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
    refineOriginPrompt,
    refineSelectedIds,
    refineNotice,
    dismissRefineNotice,
    enhancing,
    mergingRefine,
    enhance,
    translating,
    translate,
    toggleRefineOption,
    clearRefineSelection,
    applyRefineTweaks,
    restoreRefineOrigin,
    toggleRefine,
    englishPromptHint,
    newCreation,
    draftView,
    cleanBaseline,
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

  // 精度档提示（§8）：只在用户明确选了轻量 / 满血时出现；`auto` 的路由说明留在
  // 精度选择器的 tooltip 里，避免同一块区域重复解释。轻量档给下载体积与诚实的
  // Salad 冷启区间（节点带宽不可控，实测 5.5–29.8 分钟，不承诺固定 SLA）。
  const precisionOptions = precisionOptionsOf(activePreset)
  const precisionSelected = variantRequestOf(activePreset, fields.variantId)
  const precisionOption = precisionOptions.find((item) => item && item.id === precisionSelected) || null
  const precisionHint = (() => {
    if (!precisionOption) return ''
    const gb = Number(precisionOption.downloadGb)
    const size = Number.isFinite(gb) && gb > 0 ? gb.toFixed(1) : ''
    const provider = compute && typeof compute.provider === 'string' ? compute.provider : ''
    if (precisionOption.id !== 'full') {
      if (!size) return t('studio.precisionHint.compactBare')
      const key = provider === 'salad' ? 'studio.precisionHint.compactSalad' : 'studio.precisionHint.compact'
      return formatText(t(key), { size })
    }
    return size ? formatText(t('studio.precisionHint.full'), { size }) : t('studio.precisionHint.fullBare')
  })()

  // 未提交草稿（1A 多作品草稿）：顶部不再堆文字状态条；改用分组标题旁的就地变化点 + 页脚
  // 「恢复原参数 + 生成新图」对偶按钮直接传达当前修改范围与提交后果。
  const draftSource = draftView && draftView.active && draftView.source ? draftView.source : null
  const draftActive = Boolean(draftView && draftView.active && draftView.source)
  const canRestore = Boolean(draftSource) && typeof restoreOriginal === 'function'
  const originPatch = form.origin && form.origin.patch && typeof form.origin.patch === 'object'
    ? form.origin.patch
    : null
  const sectionChanges = (() => {
    if (!draftActive) {
      return { prompt: false, references: false, frame: false, negative: false, advanced: false, count: false, preset: false }
    }
    if (typeof cleanBaseline === 'string' && cleanBaseline) {
      return formSectionChangesOf(fields, cleanBaseline)
    }
    const refCount = referenceListOf(fields.references).length
    const originWidth = Number(originPatch?.width)
    const originHeight = Number(originPatch?.height)
    const originSteps = Number(originPatch?.steps)
    const originCfg = Number(originPatch?.cfg)
    const originSeed = typeof originPatch?.seed === 'string' ? originPatch.seed.trim() : ''
    const currentSeed = String(fields.seed ?? '').trim()
    return {
      prompt: Boolean(originPatch && typeof originPatch.prompt === 'string' && originPatch.prompt.trim() !== fields.prompt.trim()),
      references: refCount > 0,
      frame: Boolean(originPatch && ((Number.isFinite(originWidth) && originWidth !== currentWidth) || (Number.isFinite(originHeight) && originHeight !== currentHeight))),
      negative: Boolean(originPatch && typeof originPatch.negative === 'string' && originPatch.negative.trim() !== String(fields.negative ?? '').trim()),
      advanced: Boolean(originPatch && ((Number.isFinite(originSteps) && originSteps !== Number(fields.steps)) || (Number.isFinite(originCfg) && originCfg !== Number(fields.cfg)) || originSeed !== currentSeed)),
      count: false,
      preset: Boolean(originPatch && typeof originPatch.presetId === 'string' && originPatch.presetId && originPatch.presetId !== fields.presetId),
    }
  })()
  const styleChanged = Boolean(draftActive && typeof cleanBaseline === 'string' && cleanBaseline && styleLoraChangedOf(fields, cleanBaseline))
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

  // 页脚规格摘要：图片是「尺寸 · 比例 · 张数」；视频是「画幅/跟随首帧 · 时长 · 分辨率 · 单条」。
  const isVideo = Boolean(activePreset && activePreset.mediaType === 'video')
  const refItems = referenceListOf(fields.references)
  const firstFrame = isVideo && refItems.length > 0 ? refItems[0] : null
  const hasFirstFrame = Boolean(firstFrame)
  const videoRatios = Array.isArray(activePreset?.video?.ratios) && activePreset.video.ratios.length > 0
    ? activePreset.video.ratios
    : []
  const activeVideoRatio = typeof fields.ratio === 'string' && (videoRatios.length === 0 || videoRatios.includes(fields.ratio))
    ? fields.ratio
    : (activePreset?.video?.defaultRatio || videoRatios[0] || ratioId || '16:9')
  const countValue = Number.isFinite(Number(fields.count)) ? Math.round(Number(fields.count)) : 1
  const qtyIndex = Math.max(0, COUNT_OPTIONS.indexOf(countValue))
  const videoDuration = activePreset?.video?.supportsDuration === true
    ? formatText(t('studio.video.seconds'), {
        seconds: Number.isFinite(Number(fields.duration))
          ? Math.round(Number(fields.duration))
          : (activePreset?.video?.duration?.default ?? 5),
      })
    : t('studio.video.durationFixed')
  const videoFrameSummary = hasFirstFrame
    ? t('studio.video.followFirstFrame')
    : activeVideoRatio
  const specParts = isVideo
    ? [videoFrameSummary, videoDuration, fields.resolution ? String(fields.resolution) : '', t('unit.video')].filter(Boolean)
    : [
        frameSizeText,
        ratioId || t('studio.rail.custom'),
        `${countValue} ${t('unit.image')}`,
      ]

  // 导入图焦点隔离（M2.6）：舞台停在裸导入图（或其无参数放大产物）时，左栏整体锁定。
  // 判定口径只在组合层做一次（`isImportLockedOf`），这里只读布尔值，避免两处漂移。
  const locked = Boolean(library && library.importLocked)

  const content = (
    <>
      {embedded ? null : (
        <PanelModeTabs t={t} mode={mode} setMode={setMode} onNewCreation={startNewCreation} />
      )}

      {/* M2.6：导入图锁定态留在顶部，给锁定引导 + 「新建创作」出口；
          常规作品查看 / 改词不在面板顶部插状态条，避免输入时整块内容往下跳。 */}
      {locked ? (
        <div className="ofs-lock-hint" role="note">
          <div className="ofs-lock-head">
            <Icon name="image" size={12} />
            <span className="ofs-lock-title">{t('studio.lock.title')}</span>
            <button
              type="button"
              className="ofs-lock-action"
              onClick={() => startNewCreation()}
            >
              <Icon name="plus" size={11} />
              {t('studio.rail.newCreation')}
            </button>
          </div>
          <p className="ofs-lock-body">{t('studio.lock.formHint')}</p>
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

      {/* 锁定态只让提示词 / 参考图 / 画面设置 / 高级参数整块不可交互（`inert`），
          字段值与草稿原样保留；解锁后立即恢复，不需要重新填。 */}
      <div
        className={locked ? 'ofs-panel-scroll is-locked' : 'ofs-panel-scroll'}
        inert={locked ? true : undefined}
        aria-disabled={locked ? 'true' : undefined}
      >
        <PromptSection
          t={t}
          prompt={fields.prompt}
          patchForm={patchForm}
          generate={generate}
          translating={translating}
          translate={translate}
          enhancing={enhancing}
          mergingRefine={mergingRefine}
          enhance={enhance}
          englishPromptHint={englishPromptHint}
          refineGroups={refineGroups}
          refineOriginPrompt={refineOriginPrompt}
          refineSelectedIds={refineSelectedIds}
          refineNotice={refineNotice}
          dismissRefineNotice={dismissRefineNotice}
          toggleRefineOption={toggleRefineOption}
          clearRefineSelection={clearRefineSelection}
          applyRefineTweaks={applyRefineTweaks}
          restoreRefineOrigin={restoreRefineOrigin}
          toggleRefine={toggleRefine}
          onOpenAssistantSettings={
            ui && typeof ui.openSettings === 'function'
              ? () => ui.openSettings(null, 'assistant')
              : undefined
          }
          canReset={Boolean(draftActive && canRestore)}
          resetDisabled={Boolean(sending || locked)}
          onResetParams={() => restoreOriginal()}
          onOpenCompare={
            ui && typeof ui.openPromptCompare === 'function'
              ? ui.openPromptCompare
              : undefined
          }
        />

        {/* 阶段十五 Phase C2：原生参考图槽（提示词之后、画面设置之前）。
            当前模型不支持且槽位为空时组件自己隐藏，不占左栏空间。 */}
        <ReferenceSection
          t={t}
          references={fields.references}
          referenceSupported={referenceSupported === true}
          referenceSwitchLabel={referenceSwitchLabel || ''}
          referenceMax={referenceMax}
          mode={isVideo ? 'video' : 'image'}
          works={library && Array.isArray(library.gallery) ? library.gallery : []}
          busy={Boolean(actions && actions.referenceUploading)}
          draggingWork={ui && ui.draggingWork ? ui.draggingWork : null}
          onEndWorkDrag={() => ui && typeof ui.setDraggingWork === 'function' && ui.setDraggingWork(null)}
          actions={actions}
          changed={sectionChanges.references}
        />

        <FrameSection
          t={t}
          width={fields.width}
          height={fields.height}
          frameSizeText={frameSizeText}
          ratioId={isVideo ? activeVideoRatio : ratioId}
          video={isVideo ? (activePreset?.video || {}) : null}
          resolution={fields.resolution}
          hasFirstFrame={hasFirstFrame}
          firstFrame={firstFrame}
          applyRatio={applyRatio}
          applyCustomSize={applyCustomSize}
          changed={sectionChanges.frame}
        />

        <StyleSection
          t={t}
          activePreset={activePreset}
          styleLora={fields.styleLora}
          styleLocked={fields.styleLocked === true}
          patchForm={patchForm}
          changed={styleChanged}
        />

        <ParamsSection
          t={t}
          isEn={isEn}
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
          negativeChanged={sectionChanges.negative}
          advancedChanged={sectionChanges.advanced}
        />
      </div>

      <div
        className={locked ? 'ofs-panel-foot is-locked' : 'ofs-panel-foot'}
        inert={locked ? true : undefined}
        aria-disabled={locked ? 'true' : undefined}
      >
        {/* 生成张数提权到页脚：抽卡是高频动作，不再埋进高级折叠区。视频固定单条，不显示张数。 */}
        {isVideo ? null : (
          <div className="ofs-qty-row">
            <span className="ofs-qty-label">
              {t('studio.countShort')}
              {sectionChanges.count ? <span className="ofs-fieldset-dot" aria-hidden="true" /> : null}
            </span>
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
                  disabled={locked}
                  aria-pressed={countValue === value}
                >
                  {value}
                </button>
              ))}
            </div>
          </div>
        )}
        {(() => {
          const generateLabel = sending
            ? t('studio.generating')
            : draftActive
              ? (isVideo ? t('studio.generateNewVideo') : t('studio.generateNew'))
              : (isVideo ? t('studio.generateVideo') : t('studio.generate'))
          return (
            <button
              type="button"
              className={sending ? 'ofs-btn is-primary ofs-generate is-busy' : 'ofs-btn is-primary ofs-generate'}
              onClick={() => generate()}
              disabled={sending || !hasPrompt || locked}
            >
              <Icon name="sparkles" size={16} />
              {generateLabel}
            </button>
          )
        })()}
        {precisionHint ? (
          <p className="ofs-hint ofs-precision-hint">{precisionHint}</p>
        ) : null}
        <p className="ofs-hint ofs-spec-summary">
          {specParts.join(' · ')}
        </p>
      </div>
    </>
  )

  if (embedded) return content
  return <aside className="ofs-panel ofs-panel--form">{content}</aside>
}
