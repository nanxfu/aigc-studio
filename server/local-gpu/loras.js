import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { STYLE_LORAS, normalizeLoraSpec } from '../../shared/game-styles.js'
import { httpStream } from '../net-stream.js'

/**
 * 为本机 `sd-server --lora-model-dir` 生成扁平、安全的相对文件名，避免不同仓同名权重互相覆盖。
 */
export function localLoraFilename(lora) {
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
export async function ensureLocalLora(rawLora, { loraDir = '', download = httpStream, signal, log } = {}) {
  const dir = typeof loraDir === 'string' ? loraDir.trim() : ''
  if (!dir) throw new Error('本机 GPU 尚未配置 LoRA 目录')
  const norm = normalizeLoraSpec(rawLora)
  if (!norm.ok || !norm.value) {
    throw new Error(norm.ok ? 'LoRA 配置为空' : norm.message)
  }
  const lora = norm.value
  const relativePath = localLoraFilename(lora)
  const dest = join(dir, relativePath)
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
