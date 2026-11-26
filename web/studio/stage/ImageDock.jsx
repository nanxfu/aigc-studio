/**
 * 舞台底部动作坞（图片处理组 + 创作复用组 + 资产工坊组）。
 *
 * 宽窗口结构；窄窗口将低频工具与复用、工坊动作收进原生 disclosure：
 *   .ofs-dock
 *     ├─ .ofs-dock-group[data-group="process"] > button.ofs-dock-button × N
 *     ├─ .ofs-dock-group[data-group="reuse"]   > button.ofs-dock-button × 2（编辑态隐藏）
 *     └─ .ofs-dock-group[data-group="asset"]   > button.ofs-dock-button × 1（M4.2a 资产工坊入口）
 *
 * 图片处理组由桌面注册表 `IMAGE_TOOLS` 驱动：`tools` 的每一项由 Stage 补好
 * `label`（翻译后的按钮文案）、`enabled`（能力是否可用）与可选 `hint`（悬停说明）。
 * 阶段十五 Phase B 起四个工具全部可用（高清放大点击即提交、扩图进入画布），
 * 不再有禁用占位；保留 `enabled` 分支只为后续新增工具能先占位。
 * 编辑态下只保留「退出」按钮，创作复用组隐藏，避免误操作打断正在涂抹的草稿。
 *
 * 阶段十五 Phase A1：「带回参数」下线（点胶片条已自动回填，§2.3），复用组只剩
 * 「重新生成」——按当前作品提示词与参数、换随机种子再抽一张纯文生图。
 * 阶段十五 Phase C2：复用组新增「设为参考图」——把当前作品送进左栏原生参考图槽，
 * 当前模型不支持时由组合层自动切到支持参考的模型（见 SPEC §5.21）。
 *
 * M4.2a 资产工坊组：「进工坊」带着当前作品切到独立工坊页（抹除背景 / 像素对齐 /
 * 序列帧 / 无缝平铺 / SVG 矢量 / PBR 拆解都在那里）。
 */

import React from 'react'

import { Icon } from '../icons.jsx'

export function ImageDock(props) {
  const {
    t,
    tools,
    activeToolId,
    editing,
    resumeLabel,
    draftStatusLabel,
    onOpen,
    onResume,
    onClose,
    onReroll,
    rerollDisabled,
    rerollTitle,
    onUseReference,
    plannedTitle,
    noTargetTitle,
    // M4.2a 资产工坊组：「进工坊」页内入口。
    onOpenWorkshop,
    targetAvailable = true,
  } = props
  const list = Array.isArray(tools) ? tools.filter((item) => item && item.id) : []
  const active = list.find((item) => item.id === activeToolId) || null
  const closeLabel = t('studio.imageTool.exit')
  const dockRef = React.useRef(null)
  const moreRef = React.useRef(null)
  const requiredWidthRef = React.useRef(0)
  const [compact, setCompact] = React.useState(false)
  React.useLayoutEffect(() => {
    requiredWidthRef.current = 0
    setCompact(false)
  }, [t.lang])
  React.useLayoutEffect(() => {
    const dock = dockRef.current
    if (!dock || typeof ResizeObserver !== 'function') return undefined
    // Read the full row once; keep that requirement when the disclosure replaces it.
    if (!compact) {
      const groups = Array.from(dock.querySelectorAll(':scope > .ofs-dock-group'))
      requiredWidthRef.current = groups.reduce((sum, group) => {
        const buttons = Array.from(group.querySelectorAll(':scope > button'))
        return sum + buttons.reduce((width, button) => width + button.getBoundingClientRect().width, 0)
          + Math.max(0, buttons.length - 1) * 6
      }, 0) + Math.max(0, groups.length - 1) * 6
    }
    const fit = () => setCompact(dock.clientWidth < requiredWidthRef.current)
    fit()
    let resizeFrame = null
    const observer = new ResizeObserver(() => {
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame)
      resizeFrame = requestAnimationFrame(fit)
    })
    observer.observe(dock)
    return () => {
      observer.disconnect()
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame)
    }
  }, [compact, t.lang, editing, resumeLabel, targetAvailable])

  React.useEffect(() => {
    function dismiss(event) {
      const more = moreRef.current
      if (!more?.open) return
      if (event.type === 'keydown') {
        if (event.key !== 'Escape') return
        event.stopPropagation()
        more.open = false
        more.querySelector('summary')?.focus()
      } else if (!more.contains(event.target)) more.open = false
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', dismiss)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', dismiss)
    }
  }, [])

  function toolButton(tool) {
    const toolReady = tool.enabled !== false && tool.ready !== false
    const enabled = targetAvailable && toolReady
    const label = tool.label || t(tool.labelKey)
    const isActive = Boolean(editing) && tool.id === activeToolId
    return (
      <button
        key={tool.id}
        type="button"
        className={isActive ? 'ofs-dock-button is-on' : 'ofs-dock-button'}
        disabled={!enabled}
        title={enabled ? (tool.hint || label) : (!targetAvailable ? (noTargetTitle || label) : (plannedTitle || label))}
        aria-disabled={enabled ? undefined : 'true'}
        aria-pressed={isActive ? 'true' : undefined}
        onClick={enabled ? () => { if (moreRef.current) moreRef.current.open = false; onOpen(tool.id) } : undefined}
      >
        <Icon name={tool.icon} size={15} />
        {label}
      </button>
    )
  }

  const secondary = !editing ? <>
    <div className="ofs-dock-group" data-group="reuse">
      <button type="button" className="ofs-dock-button" disabled={rerollDisabled === true || !targetAvailable}
        title={!targetAvailable ? (noTargetTitle || undefined) : (rerollTitle || undefined)}
        onClick={rerollDisabled === true || !targetAvailable ? undefined : () => { if (moreRef.current) moreRef.current.open = false; onReroll() }}>
        <Icon name="reroll" size={15} />{t('studio.action.reroll')}
      </button>
      <button type="button" className="ofs-dock-button ofs-dock-reference" disabled={!targetAvailable}
        title={!targetAvailable ? (noTargetTitle || undefined) : undefined}
        onClick={targetAvailable ? () => { if (moreRef.current) moreRef.current.open = false; onUseReference() } : undefined}>
        <Icon name="image" size={15} />{t('studio.reference.setAsReference')}
      </button>
    </div>
    <div className="ofs-dock-group" data-group="asset" role="group" aria-label={t('studio.imageTool.groupAsset')}>
      <button type="button" className="ofs-dock-button ofs-dock-workshop" disabled={!targetAvailable}
        title={!targetAvailable ? (noTargetTitle || undefined) : undefined}
        onClick={targetAvailable ? () => { if (moreRef.current) moreRef.current.open = false; onOpenWorkshop() } : undefined}>
        <Icon name="frame" size={15} />{t('studio.imageTool.enterWorkshop')}
      </button>
    </div>
  </> : null

  return (
    <div ref={dockRef} className="ofs-dock" data-compact={compact ? 'true' : undefined} data-target-available={targetAvailable ? 'true' : 'false'}>
      <div className="ofs-dock-group" data-group="process" role="group" aria-label={t('studio.imageTool.groupLabel')}>
        {(compact && !editing ? list.slice(0, 2) : list).map(toolButton)}

        {active && editing ? (
          <button type="button" className="ofs-dock-button ofs-dock-close" onClick={onClose}>
            <Icon name="close" size={15} />
            {closeLabel}
          </button>
        ) : null}

        {targetAvailable && active && !editing && resumeLabel ? (
          <button type="button" className="ofs-dock-button ofs-dock-resume" onClick={onResume}>
            <Icon name="focus" size={15} />
            {resumeLabel}
            {draftStatusLabel ? <span className="ofs-dock-draft">{draftStatusLabel}</span> : null}
          </button>
        ) : null}
      </div>

      {compact && !editing ? (
        <details className="ofs-dock-more" ref={moreRef}>
          <summary className="ofs-dock-button">{t('studio.imageTool.more')}<Icon name="chevronDown" size={12} /></summary>
          <div className="ofs-dock-menu">
            {list.slice(2).map(toolButton)}
            {secondary}
          </div>
        </details>
      ) : secondary}
    </div>
  )
}
