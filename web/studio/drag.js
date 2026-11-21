/**
 * 拖放事件的小工具（阶段十五 Phase A3 / Phase C2 + 站内作品快捷拖拽）。
 *
 * 区分两类拖拽载荷：
 *  1. 站内作品拖拽（`WORK_DRAG_MIME`）：从底部作品条 / 版本面板拖出，附带工作区相对路径；
 *     拖到舞台直接切换预览，拖到左栏参考图槽直接引用原路径，绝不走 `/import` 复制副本；
 *  2. 站外文件拖拽（`Files`）：从系统文件夹拖入的 PNG / JPEG。
 *
 * 不同浏览器给出的 `dataTransfer.types` / `items` 形态不一样，统一收在这里。
 */

/** 站内作品拖拽的自定义 MIME（全小写，避免浏览器对 types 做小写归一后失配）。 */
export const WORK_DRAG_MIME = 'application/x-aigc-work'

/** `DataTransfer.types` 在部分浏览器里是数组、部分是 DOMStringList，统一成字符串数组。 */
export function dataTransferTypesOf(dataTransfer) {
  const types = dataTransfer && dataTransfer.types
  if (!types) return []
  if (typeof types === 'string') return [types]
  const out = []
  const length = Number(types.length) || 0
  for (let index = 0; index < length; index += 1) {
    const type = types[index]
    if (typeof type === 'string') out.push(type)
  }
  return out
}

/** 这次拖拽是否为站内作品快捷拖拽。 */
export function hasWorkDragPayload(event) {
  const dataTransfer = event && event.dataTransfer
  if (!dataTransfer) return false
  return dataTransferTypesOf(dataTransfer).includes(WORK_DRAG_MIME)
}

/** 写入站内作品拖拽载荷（只写自定义 MIME，避免拖到提示词输入框时误填入路径文本）。 */
export function writeWorkDrag(dataTransfer, entry) {
  const image = entry && entry.image ? entry.image : entry
  const path = image && typeof image.path === 'string' ? image.path.trim() : ''
  if (!dataTransfer || !path) return ''
  try {
    dataTransfer.effectAllowed = 'copy'
  } catch {}
  if (typeof dataTransfer.setData === 'function') {
    try {
      dataTransfer.setData(WORK_DRAG_MIME, path)
    } catch {}
  }
  return path
}

/** 从 DataTransfer 读取站内作品路径；未携带或浏览器保护期不可读时返回空串。 */
export function workDragPathOf(dataTransfer) {
  if (!dataTransfer || typeof dataTransfer.getData !== 'function') return ''
  try {
    const raw = dataTransfer.getData(WORK_DRAG_MIME)
    return typeof raw === 'string' ? raw.trim() : ''
  } catch {
    return ''
  }
}

/** 启动一次站内作品拖拽：同时写 DataTransfer 与界面拖拽态（供全局两层高亮使用）。 */
export function beginWorkDrag(event, entry, ui) {
  const image = entry && entry.image ? entry.image : entry
  const path = image && typeof image.path === 'string' ? image.path.trim() : ''
  if (!path) return ''
  writeWorkDrag(event && event.dataTransfer, entry)
  if (ui && typeof ui.setDraggingWork === 'function') {
    ui.setDraggingWork({ path, entry: entry && entry.image ? entry : { image, item: null } })
  }
  return path
}

/** 结束一次站内作品拖拽：清理界面全局高亮态。 */
export function endWorkDrag(ui) {
  if (ui && typeof ui.setDraggingWork === 'function') {
    ui.setDraggingWork(null)
  }
}

/**
 * 这次拖拽是否携带外部文件（拖文字 / 拖链接 / 站内作品拖拽不视为文件导入）。
 */
export function hasFilePayload(event) {
  if (hasWorkDragPayload(event)) return false
  const dataTransfer = event && event.dataTransfer
  if (!dataTransfer) return false
  if (dataTransferTypesOf(dataTransfer).includes('Files')) return true
  const files = dataTransfer.files
  if (files && Number(files.length) > 0) return true
  const items = dataTransfer.items
  if (items) {
    const length = Number(items.length) || 0
    for (let index = 0; index < length; index += 1) {
      if (items[index] && items[index].kind === 'file') return true
    }
  }
  return false
}

/** 从 DataTransfer 里按顺序取文件：优先 files，其次 items 里的文件项。 */
export function filesOf(dataTransfer) {
  const out = []
  const files = dataTransfer && dataTransfer.files
  if (files) {
    const length = Number(files.length) || 0
    for (let index = 0; index < length; index += 1) {
      if (files[index]) out.push(files[index])
    }
  }
  if (out.length > 0) return out
  const items = dataTransfer && dataTransfer.items
  if (items) {
    const length = Number(items.length) || 0
    for (let index = 0; index < length; index += 1) {
      const item = items[index]
      if (!item || item.kind !== 'file') continue
      const file = typeof item.getAsFile === 'function' ? item.getAsFile() : null
      if (file) out.push(file)
    }
  }
  return out
}
