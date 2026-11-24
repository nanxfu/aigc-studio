/**
 * 本机端侧模型统一管理的 Host 接口访问层（web/api/localModels.js）。
 *
 * 路径唯一来源是 shared/contract.js 的 ROUTES；模型元数据单源来自 shared/local-models.js。
 */

import { apiUrl, authHeaders, request, routePath } from '../api.js'

function failureOf(result) {
  const status = result && Number.isFinite(Number(result.status)) ? Number(result.status) : 0
  return {
    ok: false,
    status,
    code: (result && result.code) || (status ? `http_${status}` : 'network'),
    message: (result && result.message) || '',
  }
}

/** 查询全部已登记本机模型、缓存目录与下载状态。 */
export async function fetchLocalModels() {
  const result = await request(routePath('localModels'), { method: 'GET' })
  if (!result.ok) return failureOf(result)
  const data = result.data && typeof result.data === 'object' ? result.data : {}
  return {
    ok: true,
    dir: typeof data.dir === 'string' ? data.dir : '',
    defaultDir: typeof data.defaultDir === 'string' ? data.defaultDir : '',
    customDir: typeof data.customDir === 'string' ? data.customDir : '',
    overrideDir: typeof data.overrideDir === 'string' ? data.overrideDir : '',
    models: Array.isArray(data.models) ? data.models : [],
  }
}

/** 触发指定模型的后台预下载 + SHA-256 校验。 */
export async function downloadLocalModel(id) {
  const result = await request(routePath('localModelDownload'), {
    method: 'POST',
    body: JSON.stringify({ id }),
  })
  if (!result.ok) return failureOf(result)
  return { ok: true, model: result.data?.model ?? null }
}

/** 删除指定模型的本机缓存文件释放磁盘。 */
export async function deleteLocalModel(id) {
  const result = await request(routePath('localModelDelete'), {
    method: 'POST',
    body: JSON.stringify({ id }),
  })
  if (!result.ok) return failureOf(result)
  return { ok: true, model: result.data?.model ?? null }
}

/** 启用或停用指定本机模型。 */
export async function toggleLocalModel(id, enabled) {
  const result = await request(routePath('localModelToggle'), {
    method: 'POST',
    body: JSON.stringify({ id, enabled: Boolean(enabled) }),
  })
  if (!result.ok) return failureOf(result)
  return { ok: true, model: result.data?.model ?? null }
}

/** 修改或清空（传空串恢复默认）自定义本机模型目录。 */
export async function saveLocalModelsDir(dir) {
  const result = await request(routePath('localModelsDir'), {
    method: 'POST',
    body: JSON.stringify({ dir: typeof dir === 'string' ? dir : '' }),
  })
  if (!result.ok) return failureOf(result)
  const data = result.data && typeof result.data === 'object' ? result.data : {}
  return {
    ok: true,
    dir: typeof data.dir === 'string' ? data.dir : '',
    defaultDir: typeof data.defaultDir === 'string' ? data.defaultDir : '',
    customDir: typeof data.customDir === 'string' ? data.customDir : '',
    overrideDir: typeof data.overrideDir === 'string' ? data.overrideDir : '',
    models: Array.isArray(data.models) ? data.models : [],
  }
}

/**
 * 从本机 Host 读取已校验的模型二进制（未缓存时 Host 会自动按需下载）。
 * @param {string} id
 * @param {{ signal?: AbortSignal }} [options]
 */
export async function fetchLocalModelBytes(id, options = {}) {
  const url = `${apiUrl(routePath('localModelFile'))}?id=${encodeURIComponent(id)}`
  const res = await fetch(url, {
    method: 'GET',
    cache: 'no-store',
    credentials: 'same-origin',
    signal: options.signal,
    headers: {
      ...authHeaders(),
    },
  })
  if (!res.ok) {
    let message = `HTTP ${res.status}`
    try {
      const json = await res.json()
      if (json?.error?.message) message = json.error.message
    } catch {}
    const error = new Error(message)
    error.status = res.status
    throw error
  }
  return new Uint8Array(await res.arrayBuffer())
}
