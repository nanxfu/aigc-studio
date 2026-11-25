#!/usr/bin/env node
/**
 * SaladCloud Provider（M3.6）离线回归。
 *
 * 覆盖：
 *  - 加密凭据：API Key 不进入 app-config / 公开视图，重启后仍能读回；
 *  - 选卡与容器规格：默认档位、显存兜底、欧美区域、镜像缓存、临时盘容量；
 *  - 生命周期：创建前落待清理记录 → poll 状态 / 慢节点 reallocate → running 返回地址；
 *  - 停止 / 崩溃补清理：删除容器组并清空待清理记录；
 *  - API 客户端：Salad-Api-Key 请求头、401 归一为 auth_required、错误信息不泄露 Key。
 *
 * 全部使用本机 fake API，不创建真实容器、不出外网。
 *
 * 运行：node test/salad-provider.mjs
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SALAD } from '../shared/contract.js'
import { createAppConfig } from '../server/app-config.js'
import {
  buildSaladContainerSpec,
  createSaladApi,
  createSaladProvider,
  pickSaladGpu,
  probeSaladAccount,
  requiredVramGbOf,
} from '../server/providers/salad.js'
import {
  pendingCleanupPath,
  readPendingCleanup,
  writePendingCleanup,
} from '../server/session/pending-cleanup.js'
import { SessionManager } from '../server/session.js'
import { createCheckRunner } from './helpers/check.mjs'
import { workspaceContext } from './helpers/fake-context.mjs'

const { check, summary } = createCheckRunner()
const silentLog = { debug() {}, info() {}, warn() {}, error() {} }
const tempDirs = []

async function makeDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

const GPU_DOC = {
  items: [
    { id: 'gpu-3060', name: 'RTX 3060 (12 GB)', prices: [{ priority: 'batch', price: 0.04 }, { priority: 'medium', price: 0.067 }] },
    { id: 'gpu-4060ti', name: 'RTX 4060 Ti (16 GB)', prices: [{ priority: 'medium', price: 0.12 }, { priority: 'low', price: 0.1 }] },
    { id: 'gpu-3090', name: 'RTX 3090 (24 GB)', prices: [{ priority: 'high', price: 0.2 }, { priority: 'medium', price: 0.163 }] },
    { id: 'gpu-4090', name: 'RTX 4090 (24 GB)', prices: [{ priority: 'high', price: 0.44 }] },
    { id: 'gpu-a6000', name: 'RTX A6000 (48 GB)', prices: [{ priority: 'medium', price: 0.397 }] },
  ],
}

function createFakeApi() {
  const calls = {
    create: [],
    delete: [],
    reallocate: [],
  }
  const state = {
    current_state: { status: 'provisioning' },
    networking: { dns: 'gw.salad.test' },
  }
  const instances = {
    instances: [{ id: 'instance-1', machine_id: 'machine-1', state: 'downloading' }],
  }
  return {
    calls,
    state,
    instances,
    async listGpuClasses() {
      return GPU_DOC
    },
    async getQuotas() {
      return { container_groups_quotas: { container_replicas_used: 0, container_replicas_quota: 50 } }
    },
    async createContainer(input) {
      calls.create.push(input)
      return state
    },
    async getContainer() {
      return state
    },
    async listInstances() {
      return instances
    },
    async deleteContainer(input) {
      calls.delete.push(input)
      return null
    },
    async reallocateInstance(input) {
      calls.reallocate.push(input)
      return null
    },
  }
}

try {
  await check('凭据：Salad API Key 加密落盘，公开视图只回布尔，重启后可读回', async () => {
    const dataDir = await makeDir('aigc-salad-config-')
    const credentialKey = 'd'.repeat(64)
    const appConfig = createAppConfig({ dataDir, credentialKey, log: silentLog })
    await appConfig.whenReady()
    const saved = await appConfig.saveSaladSettings({
      org: 'AIGC-Studio',
      project: 'Studio',
      tier: 'high',
      apiKey: 'salad-secret-key',
    })
    assert.equal(saved.ok, true)
    assert.deepEqual(appConfig.publicSaladView(), {
      org: 'aigc-studio',
      project: 'studio',
      tier: 'high',
      hasApiKey: true,
    })
    assert.equal(appConfig.getSaladConfig().apiKey, 'salad-secret-key')

    const configRaw = await readFile(join(dataDir, 'app-config.json'), 'utf8')
    assert.ok(!configRaw.includes('salad-secret-key'), 'app-config 不得包含 Key 原文')
    const credentialRaw = await readFile(join(dataDir, 'credentials', 'salad.json'), 'utf8')
    assert.ok(!credentialRaw.includes('salad-secret-key'), 'salad.json 应为密文')
    assert.equal(JSON.parse(credentialRaw).enc, 'aes-256-gcm')

    const reopened = createAppConfig({ dataDir, credentialKey, log: silentLog })
    await reopened.whenReady()
    assert.equal(reopened.getSaladConfig().apiKey, 'salad-secret-key')

    const invalidOrg = await appConfig.saveSaladSettings({ org: 'bad_org' })
    assert.equal(invalidOrg.ok, false)
    assert.equal(invalidOrg.code, 'invalid_request')
    const invalidTier = await appConfig.saveSaladSettings({ tier: 'gold' })
    assert.equal(invalidTier.ok, false)
    const cleared = await appConfig.saveSaladSettings({ clearApiKey: true })
    assert.equal(cleared.ok, true)
    assert.equal(appConfig.publicSaladView().hasApiKey, false)
  })

  await check('选卡：默认 medium 命中隐藏卡池，双卡模型按总显存跳过 16GB，48GB 模型回落到 A6000', () => {
    assert.equal(requiredVramGbOf('flux2-klein-4b'), 18)
    const flux4 = pickSaladGpu(GPU_DOC.items, {
      tier: 'low',
      requiredVramGb: requiredVramGbOf('flux2-klein-4b'),
    })
    assert.equal(flux4.name, 'RTX 3090 (24 GB)', '4060 Ti 16GB 跑 2×T4 估算模型会 OOM，low 档也应跳过它')
    assert.equal(requiredVramGbOf('qwen-image-2.1'), 19)
    assert.equal(
      pickSaladGpu(GPU_DOC.items, { tier: 'low', requiredVramGb: requiredVramGbOf('qwen-image-2.1') }).name,
      'RTX 3090 (24 GB)',
    )
    assert.equal(
      pickSaladGpu(GPU_DOC.items, { tier: 'batch', requiredVramGb: 48 }).name,
      'RTX A6000 (48 GB)',
    )
  })

  await check('容器规格：无持久卷 hf-xet 环境、欧美区域、镜像缓存与按模型分档资源', () => {
    const light = buildSaladContainerSpec({
      groupName: 'aigc-studio-light',
      gpu: { id: 'gpu-3090' },
      tier: 'medium',
      workerToken: 'worker-token',
      presetId: 'sdxl-lightning',
    })
    assert.equal(light.priority, 'medium')
    assert.deepEqual(light.country_codes, [...SALAD.countryCodes])
    assert.equal(light.container.image_caching, true)
    assert.equal(light.container.image, SALAD.workerImage)
    assert.equal(light.container.resources.storage_amount, SALAD.lightStorageGb * 1024 * 1024 * 1024)
    assert.equal(light.container.resources.memory, SALAD.memoryMb)
    assert.deepEqual(light.container.resources.gpu_classes, ['gpu-3090'])
    assert.equal(light.container.environment_variables.HF_XET_HIGH_PERFORMANCE, '1')
    assert.equal(light.container.environment_variables.HF_HOME, '/tmp/hf')
    assert.equal(light.container.environment_variables.AIGC_WORKER_TOKEN, 'worker-token')
    assert.equal(light.networking.port, 8765)
    assert.equal(light.startup_probe.http.path, '/healthz')

    const heavy = buildSaladContainerSpec({
      groupName: 'aigc-studio-heavy',
      gpu: { id: 'gpu-3090' },
      tier: 'medium',
      workerToken: 'worker-token',
      presetId: 'qwen-image-2.1',
    })
    assert.equal(heavy.container.resources.storage_amount, SALAD.storageGb * 1024 * 1024 * 1024)
    assert.equal(heavy.container.resources.memory, SALAD.heavyMemoryMb)
  })

  await check('生命周期：创建前落待清理记录 → 慢节点 reallocate → running 返回 Gateway', async () => {
    const workspace = await makeDir('aigc-salad-lifecycle-')
    const ctx = workspaceContext(workspace)
    const api = createFakeApi()
    let now = 1000
    const provider = createSaladProvider({
      ctx,
      log: silentLog,
      api,
      options: {
        getSaladConfig: () => ({
          apiKey: 'secret-api-key',
          org: 'aigc-studio',
          project: 'default',
          tier: 'medium',
        }),
        now: () => now,
        reallocateAfterMs: 1000,
      },
    })

    const result = await provider.provision(
      { signal: new AbortController().signal, isCurrent: () => true },
      { presetId: 'flux2-klein-4b' },
    )
    assert.ok(result.handle.groupName.startsWith('aigc-studio-'))
    assert.equal(result.handle.awaitEndpoint, true)
    assert.equal(result.handle.endpointUrl, 'https://gw.salad.test')
    assert.ok(result.token.length >= 32)
    assert.ok(!JSON.stringify(result.handle).includes(result.token), 'Worker Token 不得进入 handle')
    assert.equal(api.calls.create.length, 1)

    const pending = await readPendingCleanup(ctx)
    assert.equal(pending.provider, 'salad')
    assert.equal(pending.groupName, result.handle.groupName)

    api.instances.instances[0].pulling_progress = 0.1
    assert.equal(await provider.pollEndpoint({}, result.handle), null)
    now += 1500
    api.instances.instances[0].pulling_progress = 0.2
    assert.equal(await provider.pollEndpoint({}, result.handle), null)
    assert.equal(api.calls.reallocate.length, 1, '满 1 轮仍低于 25%（龟速节点）应触发 reallocate')

    api.instances.instances = [{ id: 'instance-2', machine_id: 'machine-2', state: 'downloading', pulling_progress: 0.35 }]
    now += 100
    assert.equal(await provider.pollEndpoint({}, result.handle), null)
    now += 1100
    api.instances.instances[0].pulling_progress = 0.75
    assert.equal(await provider.pollEndpoint({}, result.handle), null)
    assert.equal(api.calls.reallocate.length, 1, '稳步拉取且已达 75% 时不得误杀换机')

    now += 1500
    assert.equal(await provider.pollEndpoint({}, result.handle), null)
    assert.equal(api.calls.reallocate.length, 2, '超过 65% 后若连续停滞超阈值也应换机')

    // 瞬时网络抖动（前 4 次容忍返回 null，第 5 次仍失败才上抛）
    api.getContainer = async () => {
      const err = new Error('ECONNRESET')
      err.name = 'ProviderError'
      err.code = 'worker_unreachable'
      throw err
    }
    for (let i = 0; i < 4; i += 1) {
      assert.equal(await provider.pollEndpoint({}, result.handle), null)
    }
    await assert.rejects(() => provider.pollEndpoint({}, result.handle), (err) => err.code === 'worker_unreachable')
    api.getContainer = async () => api.state

    api.state.current_state.status = 'running'
    assert.deepEqual(await provider.pollEndpoint({}, result.handle), {
      endpointUrl: 'https://gw.salad.test',
    })

    const stopped = await provider.teardown({}, result.handle)
    assert.equal(stopped.ok, true)
    assert.equal(api.calls.delete.length, 1)
    assert.equal(await readPendingCleanup(ctx), null)
  })

  await check('补清理：启动时删除遗留容器组并清空记录', async () => {
    const workspace = await makeDir('aigc-salad-cleanup-')
    const ctx = workspaceContext(workspace)
    const api = createFakeApi()
    const provider = createSaladProvider({
      ctx,
      log: silentLog,
      api,
      options: {
        getSaladConfig: () => ({
          apiKey: 'secret-api-key',
          org: 'aigc-studio',
          project: 'default',
          tier: 'medium',
        }),
      },
    })
    const record = {
      version: 2,
      provider: 'salad',
      savedAt: new Date().toISOString(),
      groupName: 'aigc-studio-orphan1',
      endpointUrl: null,
      attempts: 0,
    }
    await writePendingCleanup(ctx, record)
    assert.ok(await readFile(pendingCleanupPath(ctx), 'utf8'))
    const ok = await provider.cleanupPending(record)
    assert.equal(ok, true)
    assert.equal(api.calls.delete[0].name, 'aigc-studio-orphan1')
    assert.equal(await readPendingCleanup(ctx), null)
  })

  await check('会话集成：awaitEndpoint 先停在 provisioning，Gateway 就绪后完成握手并进入 ready', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          phase: 'ready',
          protocol_version: '2.0.0',
          device: 'Mock Salad RTX 3090',
          capabilities: { tools: ['generate'], result_modes: ['binary'], events: true },
        }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const endpointUrl = `http://127.0.0.1:${server.address().port}`
    const workspace = await makeDir('aigc-salad-session-')
    let polls = 0
    let deleted = 0
    const provider = {
      id: 'salad',
      kind: 'worker',
      async provision() {
        return {
          handle: {
            kind: 'worker',
            provider: 'salad',
            workerId: 'aigc-studio-session1',
            groupName: 'aigc-studio-session1',
            endpointUrl: null,
            awaitEndpoint: true,
          },
          token: 'worker-token',
        }
      },
      async pollEndpoint() {
        polls += 1
        return polls >= 2 ? { endpointUrl } : null
      },
      async checkAlive() {
        return { alive: true, status: 'running' }
      },
      async keepAlive() {
        return { ok: true }
      },
      async teardown() {
        deleted += 1
        return { ok: true }
      },
      buildPendingCleanupRecord() {
        return null
      },
      async cleanupPending() {
        return null
      },
    }
    const session = new SessionManager({
      ctx: workspaceContext(workspace),
      defaultPreset: 'sdxl-lightning',
      deps: { provider, log: silentLog },
      options: {
        tickMs: 10,
        healthyIntervalMs: 10,
        kernelPollMs: 1000,
        provisionTimeoutMs: 5000,
      },
    })
    try {
      const initial = await session.start('sdxl-lightning')
      assert.equal(initial.state, 'provisioning')
      assert.equal(initial.endpointUrl, null)
      let state = initial.state
      for (let attempt = 0; attempt < 100 && state !== 'ready'; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20))
        state = session.snapshot().state
      }
      assert.equal(state, 'ready')
      assert.equal(session.snapshot().endpointUrl, endpointUrl)
      assert.ok(polls >= 2)
      await session.stop()
      assert.equal(deleted, 1)
    } finally {
      session.dispose()
      await new Promise((resolve) => server.close(resolve))
    }
  })

  await check('API 客户端：Salad-Api-Key 只走请求头；401 归一 auth_required 且不回显 Key', async () => {
    let seen = null
    const api = createSaladApi({
      fetchText: async (_ctx, url, options) => {
        seen = { url, options }
        return { ok: false, status: 401, text: '{"detail":"bad key"}', via: 'fetch' }
      },
    })
    await assert.rejects(
      () => api.getQuotas({ org: 'aigc-studio', apiKey: 'top-secret-key' }),
      (error) => {
        assert.equal(error.name, 'ProviderError')
        assert.equal(error.code, 'auth_required')
        assert.ok(!error.message.includes('top-secret-key'))
        return true
      },
    )
    assert.equal(seen.options.headers['Salad-Api-Key'], 'top-secret-key')
    assert.ok(!seen.url.includes('top-secret-key'))
    assert.ok(seen.url.endsWith('/organizations/aigc-studio/quotas'))
  })

  await check('账号探测：只读汇总配额 / 容器 / 显卡数，缺 Key 明确报 auth_required', async () => {
    const api = createFakeApi()
    api.listContainers = async () => ({ items: [{ name: 'aigc-studio-1' }] })
    const probe = await probeSaladAccount({
      config: { apiKey: 'secret', org: 'aigc-studio', project: 'default' },
      api,
    })
    assert.equal(probe.ok, true)
    assert.deepEqual(probe.quota, { replicasUsed: 0, replicasQuota: 50 })
    assert.equal(probe.existingContainers, 1)
    assert.equal(probe.gpuClasses, 5)

    const missing = await probeSaladAccount({ config: { org: 'aigc-studio' }, api })
    assert.equal(missing.ok, false)
    assert.equal(missing.error.code, 'auth_required')
  })
} finally {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => {})
}

summary()
