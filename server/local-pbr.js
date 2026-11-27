/**
 * PBR 本机执行的薄兼容层（M4.2f）。
 *
 * 真正的 uv 环境、进程树清理与模型缓存已迁到 `local-cuda-runner.js`；这里保留旧导出，
 * 让已有 Host 测试和第三方注入点不用同步改签名。
 */

import { createLocalWorkshop, runCudaProcess } from './local-cuda-runner.js'

const LEGACY_REASON = Object.freeze({
  'local-ample': 'ready',
  'edge-ready': 'ready',
  checking: 'checking',
  platform: 'platform',
  gpu: 'gpu',
  busy: 'busy',
  memory: 'memory',
  disk: 'disk',
  model: 'model',
  'cloud-only': 'model',
})

/** @deprecated 新代码请直接使用 `runCudaProcess`。 */
export const runPbrProcess = runCudaProcess

/**
 * 创建 PBR 单算子视图；内部仍与 depth / relight 共用同一个通用 Runner。
 */
export function createLocalPbr(options = {}) {
  const engine = options.engine || createLocalWorkshop(options)
  return {
    async capability({ force = false } = {}) {
      const evaluation = await engine.capability({ op: 'pbr', model: 'marigold', force })
      return {
        available: evaluation.localEligible,
        defaultExecution: evaluation.recommended,
        reason: LEGACY_REASON[evaluation.reasonCode] ?? 'model',
        gpuIndex: evaluation.gpuIndex,
        ...(evaluation.gpuName ? { device: evaluation.gpuName } : {}),
      }
    },
    run({ sourcePath, steps, signal, onEvent, options: workshopOptions } = {}) {
      return engine.run({
        op: 'pbr',
        model: 'marigold',
        sourcePath,
        steps,
        options: workshopOptions,
        signal,
        onEvent,
      })
    },
    readInfo: () => engine.readInfo(),
    getCachedInfo: () => engine.getCachedInfo(),
  }
}
