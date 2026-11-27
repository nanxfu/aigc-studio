/**
 * dataURL / base64 图片解码的共享入口。
 *
 * `/api/import`、本机超分落盘与后续本机算子保存都接受浏览器导出的 dataURL；
 * 这里只做格式归一，不判断图片类型（魔数与尺寸由调用方用 image-meta 校验）。
 */

/**
 * @param {unknown} data dataURL 或裸 base64
 * @returns {{ ok: true, buffer: Buffer } | { ok: false, message: string }}
 */
export function decodeImageData(data) {
  if (typeof data !== 'string') return { ok: false, message: '缺少 data（dataURL 或 base64 字符串）' }
  let text = data.trim()
  if (!text) return { ok: false, message: 'data 不能为空' }
  if (/^data:/i.test(text)) {
    const match = /^data:([^,]*);base64,([\s\S]*)$/i.exec(text)
    if (!match) return { ok: false, message: 'data 不是合法的 dataURL（需要 ...;base64,... 形式）' }
    text = match[2]
  }
  const payload = text.replace(/\s+/g, '')
  if (!payload || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) {
    return { ok: false, message: 'data 不是合法的 base64 图片' }
  }
  const buffer = Buffer.from(payload, 'base64')
  if (buffer.length === 0) return { ok: false, message: 'data 解码后为空' }
  return { ok: true, buffer }
}
