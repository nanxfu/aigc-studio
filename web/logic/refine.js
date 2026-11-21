/**
 * 润色标签的追加与撤销。
 *
 * 标签是独立短语，追加时与其他短语用分隔符隔开；撤销时只删「独立成段」的那一处，
 * 不碰用户句子里恰好包含同一个词的情况（例如原文「霓虹灯光效」里的「灯光」）。
 */

const SEPARATOR_CHARS = /[，,、;；\n\r\t ]/

const CJK = /[\u3400-\u9fff]/

function isBoundary(char) {
  return char === undefined || SEPARATOR_CHARS.test(char)
}

/** 找一个前后都是分隔符（或字符串边界）的完整短语；重复出现时取最后一次。 */
function findDelimited(text, term) {
  let index = text.lastIndexOf(term)
  while (index >= 0) {
    if (isBoundary(text[index - 1]) && isBoundary(text[index + term.length])) return index
    index = index > 0 ? text.lastIndexOf(term, index - 1) : -1
  }
  return -1
}

/** 中英文混排时用全角逗号，否则用半角逗号加空格。 */
export function refineSeparator(prompt) {
  return CJK.test(String(prompt ?? '')) ? '，' : ', '
}

export function isRefineApplied(prompt, term) {
  const text = String(prompt ?? '')
  const value = String(term ?? '').trim()
  if (!value) return false
  return findDelimited(text, value) >= 0
}

export function toggleRefineTerm(prompt, term, separator) {
  const text = String(prompt ?? '')
  const value = String(term ?? '').trim()
  if (!value) return text

  const sep = typeof separator === 'string' && separator ? separator : refineSeparator(text)
  const index = findDelimited(text, value)
  if (index >= 0) {
    let start = index
    let end = index + value.length
    // 连同紧邻的一组分隔符一起删掉，避免留下悬空逗号或多余空格。
    while (start > 0 && SEPARATOR_CHARS.test(text[start - 1])) start -= 1
    if (start === index) {
      while (end < text.length && SEPARATOR_CHARS.test(text[end])) end += 1
    }
    return (text.slice(0, start) + text.slice(end)).trim()
  }

  const trimmed = text.replace(/\s+$/, '')
  if (!trimmed) return value
  if (/[，,、;；]$/.test(trimmed)) return trimmed + value
  return trimmed + sep + value
}

/** 归一动态润色建议列表，兼容旧宿主仅返回 dimension 的情形。 */
export function normalizeRefineGroups(rawGroups) {
  if (!Array.isArray(rawGroups)) return []
  const groups = []
  for (let i = 0; i < rawGroups.length; i += 1) {
    const group = rawGroups[i]
    if (!group || !Array.isArray(group.options)) continue
    const dimension = typeof group.dimension === 'string' && group.dimension.trim()
      ? group.dimension.trim()
      : `group-${i + 1}`
    const label = typeof group.label === 'string' && group.label.trim() ? group.label.trim() : ''
    const options = []
    for (let j = 0; j < group.options.length; j += 1) {
      const option = group.options[j]
      const text = option && typeof option.text === 'string' ? option.text.trim() : ''
      if (!text) continue
      const optionLabel = option && typeof option.label === 'string' && option.label.trim()
        ? option.label.trim()
        : text
      const id = option && typeof option.id === 'string' && option.id.trim()
        ? option.id.trim()
        : `${dimension}-${j}`
      options.push({
        id,
        text,
        label: optionLabel,
        applied: Boolean(option && option.applied),
      })
    }
    if (options.length === 0) continue
    groups.push({ dimension, label, options })
  }
  return groups
}

/** 多选微调胶囊：点一下勾选，再点一下取消勾选。 */
export function toggleRefineSelection(selectedIds, id) {
  const target = typeof id === 'string' ? id.trim() : ''
  if (!target) return Array.isArray(selectedIds) ? [...selectedIds] : []
  const list = Array.isArray(selectedIds) ? selectedIds : []
  if (list.includes(target)) return list.filter((item) => item !== target)
  return [...list, target]
}

/** 从分组列表里按展示顺序收集已勾选的微调文本。 */
export function collectSelectedTweaks(groups, selectedIds) {
  const selected = new Set(Array.isArray(selectedIds) ? selectedIds : [])
  if (selected.size === 0 || !Array.isArray(groups)) return []
  const tweaks = []
  for (const group of groups) {
    if (!group || !Array.isArray(group.options)) continue
    for (const option of group.options) {
      if (!option || !selected.has(option.id)) continue
      const text = typeof option.text === 'string' ? option.text.trim() : ''
      if (text) tweaks.push(text)
    }
  }
  return tweaks
}

/** 将本轮已融入提示词的微调项标记为 applied。 */
export function markAppliedRefineOptions(groups, appliedIds) {
  const applied = new Set(Array.isArray(appliedIds) ? appliedIds : [])
  if (applied.size === 0 || !Array.isArray(groups)) return Array.isArray(groups) ? groups : []
  return groups.map((group) => ({
    ...group,
    options: Array.isArray(group.options)
      ? group.options.map((option) => (applied.has(option.id) ? { ...option, applied: true } : option))
      : [],
  }))
}