import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { rename, rm, stat } from 'node:fs/promises'

import { httpStream } from '../net-stream.js'

export async function fileBytes(path) {
  const info = await stat(path).catch(() => null)
  return info?.isFile() ? info.size : 0
}

export async function validAsset(path, asset, signal) {
  signal?.throwIfAborted()
  if (await fileBytes(path) !== asset.bytes) return false
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk)
  return hash.digest('hex') === asset.sha256
}

export async function prepareAsset(asset, path, { signal, onProgress, download = httpStream } = {}) {
  if (await validAsset(path, asset, signal)) {
    onProgress?.(asset.bytes)
    return
  }
  const partial = `${path}.part`
  const partialBytes = await fileBytes(partial)
  if (partialBytes >= asset.bytes) {
    if (await validAsset(partial, asset, signal)) {
      signal?.throwIfAborted()
      await rename(partial, path)
      onProgress?.(asset.bytes)
      return
    }
    await rm(partial, { force: true })
  }
  onProgress?.(partialBytes < asset.bytes ? partialBytes : 0)
  const receipt = await download(null, asset.url, {
    destPath: partial,
    resume: true,
    maxBytes: asset.bytes,
    timeoutMs: 4 * 60 * 60 * 1000,
    signal,
    onProgress,
  })
  if (receipt.bytes !== asset.bytes) throw new Error('下载不完整，请重试以继续下载。')
  if (receipt.sha256 !== asset.sha256) {
    await rm(partial, { force: true })
    throw new Error('下载文件校验失败，请重试。')
  }
  signal?.throwIfAborted()
  await rename(partial, path)
}
