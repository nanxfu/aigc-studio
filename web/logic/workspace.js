/**
 * 工作区视图的纯逻辑：响应解析与路径展示。
 *
 * 数据来源是 GET /api/workspace / POST /api/workspace 的 `{ ok, workspace }`；
 * /api/state 里将来也会带同形 workspace 字段，两处共用这里的归一化。
 * 本模块不依赖 React / DOM，便于单测与桌面 / 浏览器两种入口共用。
 */

/** 路径字符串归一化：非字符串与纯空白一律视为空。 */
export function workspacePathOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** 工作区视图归一化：缺字段按「未知 / 不可切换」的安全默认值处理。 */
export function normalizeWorkspaceView(view) {
  const source = view && typeof view === 'object' && !Array.isArray(view) ? view : {}
  const recent = Array.isArray(source.recent)
    ? source.recent.map(workspacePathOf).filter(Boolean)
    : []
  return {
    current: workspacePathOf(source.current),
    recent,
    // 只有服务端明确回 false 才算不可切换；旧服务端缺字段时按可切换处理。
    switchable: source.switchable !== false,
  }
}

/**
 * GET /POST /api/workspace 响应 → 归一化视图；形状不对返回 null，
 * 调用方保持「当前工作区未知」而不是把错误抛到渲染层。
 */
export function workspaceViewOf(result) {
  if (!result || result.ok !== true || !result.data || typeof result.data !== 'object') return null
  const view = result.data.workspace
  if (!view || typeof view !== 'object' || Array.isArray(view)) return null
  return normalizeWorkspaceView(view)
}

/**
 * 末尾两段路径用于顶栏展示（title 用全路径）。
 * 只有一段（盘符 / 根目录）时原样返回；分隔符跟随原路径风格。
 */
export function workspaceLabelOf(path) {
  const text = workspacePathOf(path)
  if (!text) return ''
  const separator = text.includes('\\') ? '\\' : '/'
  const parts = text.split(/[\\/]+/).filter(Boolean)
  if (parts.length <= 1) return text
  return parts.slice(-2).join(separator)
}
