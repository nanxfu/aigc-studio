/**
 * 私有 Worker 地址的归一与安全校验（Host 侧唯一口径）。
 *
 * 规则（M3_PRIVATE_WORKER_AND_MCP_PLAN.md §5.1 的安全基线）：
 *  - 只接受 `http:` / `https:`；
 *  - 非回环地址必须 `https:`——公网明文 HTTP 直接拒绝，不给「我知道风险」开关；
 *  - 只允许 `127.0.0.1` / `::1` / `localhost` 使用 `http:`（本机 Docker / SSH 隧道）；
 *  - 拒绝 URL 里的用户名密码、query 与 hash：Token 只走 `Authorization` 头，
 *    地址里的凭据会进入日志与代理记录；
 *  - 去掉尾部斜杠，其余路径保留（反代可能挂在子路径）。
 *
 * 纯函数、不 import node 模块，provider 与路由（M3.1 的 /api/worker/probe）共用。
 *
 * @module server/providers/worker-url
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

/** 回环判断：`[::1]` 这种 URL 里的方括号形式也认。 */
export function isLoopbackHost(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '')
  return LOOPBACK_HOSTS.has(host)
}

/**
 * 归一并校验一个 Worker 地址。
 *
 * @param {unknown} raw 用户输入的地址
 * @returns {{ ok: true, endpointUrl: string } | { ok: false, message: string }}
 */
export function normalizeWorkerEndpoint(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) return { ok: false, message: '请填写私有 Worker 地址（例如 https://gpu.example.com:8765）' }
  let url
  try {
    url = new URL(text)
  } catch {
    return { ok: false, message: '地址格式不正确：需要完整的 http(s):// 地址' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, message: '地址只支持 http:// 或 https://' }
  }
  if (url.username || url.password) {
    return { ok: false, message: '地址里不要带用户名或密码：访问令牌请单独填写' }
  }
  if (url.search || url.hash) {
    return { ok: false, message: '地址里不要带查询参数或锚点（Token 会通过请求头传递）' }
  }
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    return {
      ok: false,
      message: '非本机地址必须使用 https://：公网明文 HTTP 会泄露 Token 与生成内容',
    }
  }
  const endpointUrl = url.toString().replace(/\/+$/, '')
  return { ok: true, endpointUrl }
}
