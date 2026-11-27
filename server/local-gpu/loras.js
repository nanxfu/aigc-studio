import { createHash } from 'node:crypto'
import { createReadStream, readFileSync, statSync } from 'node:fs'
import { copyFile, mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { STYLE_LORAS, normalizeLoraSpec } from '../../shared/game-styles.js'
import { httpStream } from '../net-stream.js'

/**
 * 为本机 `sd-server --lora-model-dir` 生成扁平、安全的相对文件名，避免不同仓同名权重互相覆盖。
 */
export function localLoraFilename(lora) {
  if (lora?.source === 'local') return `${lora.assetId}.safetensors`
  const repo = String(lora?.repo || '').trim().replace(/[^A-Za-z0-9._-]+/g, '_')
  const weight = basename(String(lora?.weight || '').trim())
  return `${repo}__${weight}`
}

/** 构造 Hugging Face 权重直链。 */
export function localLoraUrl(lora) {
  const repo = String(lora?.repo || '').trim()
  const weight = String(lora?.weight || '').trim().replace(/^\/+/, '')
  return `https://huggingface.co/${repo}/resolve/main/${weight}`
}

async function fileSize(path) {
  const info = await stat(path).catch(() => null)
  return info?.isFile() ? info.size : 0
}

async function fileSha256(path, signal) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk)
  return hash.digest('hex')
}

function builtinChecksumOf(lora) {
  const builtin = STYLE_LORAS.find(
    (item) => item && item.id !== 'none' && item.repo === lora.repo && item.weight === lora.weight,
  )
  if (!builtin || !Number.isFinite(Number(builtin.bytes)) || !builtin.sha256) return null
  return { bytes: Number(builtin.bytes), sha256: String(builtin.sha256).toLowerCase() }
}

/**
 * 确保本机 `--lora-model-dir` 内存在指定 LoRA `.safetensors` 文件。
 * 已就绪直接复用（内置 LoRA 核验字节与 SHA-256），缺失时流式下载并原子落盘。
 *
 * @param {object} rawLora `{ repo, weight, scale?, id? }`
 * @param {{ loraDir: string, download?: Function, signal?: AbortSignal, log?: object }} options
 * @returns {Promise<{ path: string, absolutePath: string, downloaded: boolean }>}
 */
export async function ensureLocalLora(rawLora, { loraDir = '', download = httpStream, signal, log, hfToken = '', store = null } = {}) {
  const dir = typeof loraDir === 'string' ? loraDir.trim() : ''
  if (!dir) throw new Error('本机 GPU 尚未配置 LoRA 目录')
  const norm = normalizeLoraSpec(rawLora)
  if (!norm.ok || !norm.value) {
    throw new Error(norm.ok ? 'LoRA 配置为空' : norm.message)
  }
  const lora = norm.value
  const relativePath = localLoraFilename(lora)
  const dest = join(dir, relativePath)
  if (lora.source === 'local') {
    const imported = store?.resolve(lora.assetId)
    if (!imported) throw new Error('本地 LoRA 资产不存在，请重新导入')
    if (await fileSize(dest) === imported.bytes && await fileSha256(dest, signal) === lora.assetId) return { path: relativePath, absolutePath: dest, downloaded: false }
    await mkdir(dir, { recursive: true })
    const part = `${dest}.part`
    await copyFile(imported.path, part)
    if (await fileSha256(part, signal) !== lora.assetId) { await rm(part, { force: true }); throw new Error('本地 LoRA 文件校验失败，请重新导入') }
    await rename(part, dest)
    return { path: relativePath, absolutePath: dest, downloaded: true }
  }
  const checksum = builtinChecksumOf(lora)

  const existingBytes = await fileSize(dest)
  if (existingBytes > 0) {
    if (!checksum) return { path: relativePath, absolutePath: dest, downloaded: false }
    if (existingBytes === checksum.bytes && (await fileSha256(dest, signal)) === checksum.sha256) {
      return { path: relativePath, absolutePath: dest, downloaded: false }
    }
  }

  await mkdir(dir, { recursive: true })
  const partPath = `${dest}.part`
  const url = localLoraUrl(lora)
  log?.info?.(`local_gpu_lora_download repo=${lora.repo} weight=${lora.weight} dest=${relativePath}`)
  const receipt = await download(null, url, {
    destPath: partPath,
    resume: true,
    ...(hfToken ? { headers: { Authorization: `Bearer ${hfToken}` } } : {}),
    ...(checksum ? { maxBytes: checksum.bytes } : {}),
    timeoutMs: 30 * 60 * 1000,
    signal,
  })
  if (checksum) {
    if (receipt.bytes !== checksum.bytes) throw new Error('LoRA 下载不完整，请重试')
    if (receipt.sha256 !== checksum.sha256) {
      await rm(partPath, { force: true })
      throw new Error('LoRA 文件 SHA-256 校验失败，已清理损坏文件')
    }
  } else if (!receipt || !(receipt.bytes > 0)) {
    throw new Error('LoRA 下载为空文件')
  }
  signal?.throwIfAborted?.()
  await rename(partPath, dest)
  return { path: relativePath, absolutePath: dest, downloaded: true }
}

/** Imported files belong to the app, so moving the user's original file does not break history. */
export function createLocalLoraStore({ root, modelsDir }) {
  const dir = () => join(root || modelsDir(), 'local-loras')
  function resolve(id) {
    if (!/^[a-f0-9]{64}$/.test(id || '')) return null
    try {
      const saved = JSON.parse(readFileSync(join(dir(), `${id}.json`), 'utf8'))
      const path = join(dir(), `${id}.safetensors`)
      if (statSync(path).size !== saved.bytes) return null
      return { ...saved, path }
    } catch { return null }
  }
  async function importFile({ path, family, basePresetId = '', compatibleModes = ['fast', 'quality'] }) {
    if (!/\.safetensors$/i.test(path || '') || !['sdxl', 'flux2', 'zimage'].includes(family)) throw new Error('请选择 .safetensors LoRA 并指定适用底座')
    const info = await stat(path)
    if (!info.isFile() || info.size < 16 || info.size > 2 * 1024 ** 3) throw new Error('LoRA 文件必须在 16 字节至 2 GB 之间')
    const file = await open(path, 'r')
    try {
      const prefix = Buffer.alloc(8)
      await file.read(prefix, 0, 8, 0)
      const headerBytes = Number(prefix.readBigUInt64LE())
      if (!Number.isSafeInteger(headerBytes) || headerBytes < 2 || headerBytes > 16 * 1024 ** 2 || headerBytes + 8 >= info.size) throw new Error('无效的 safetensors 文件头')
      const header = Buffer.alloc(headerBytes)
      await file.read(header, 0, headerBytes, 8)
      const parsed = JSON.parse(header.toString('utf8'))
      const tensors = Object.entries(parsed).filter(([key]) => key !== '__metadata__')
      if (!tensors.length || !tensors.some(([key]) => /lora|hada|lokr/i.test(key))) throw new Error('文件未包含可识别的 LoRA 张量')
      for (const [, tensor] of tensors) {
        const offsets = tensor?.data_offsets
        if (!Array.isArray(offsets) || offsets.length !== 2 || !offsets.every(Number.isSafeInteger) || offsets[0] < 0 || offsets[1] < offsets[0] || offsets[1] > info.size - headerBytes - 8) throw new Error('LoRA 张量偏移无效')
      }
    } finally { await file.close() }
    await mkdir(dir(), { recursive: true })
    const id = await fileSha256(path)
    const dest = join(dir(), `${id}.safetensors`)
    const part = `${dest}.part`
    await copyFile(path, part)
    if (await fileSha256(part) !== id) { await rm(part, { force: true }); throw new Error('导入期间文件发生变化，请重试') }
    await rename(part, dest)
    const descriptor = { id: 'local', source: 'local', assetId: id, name: basename(path), family, basePresetId, compatibleModes, bytes: info.size }
    await writeFile(join(dir(), `${id}.json`), JSON.stringify(descriptor), 'utf8')
    return descriptor
  }
  return { resolve, importFile }
}
