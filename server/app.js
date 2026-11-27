/**
 * 业务装配层（原 DSH 插件 index.js 的工厂化改造）。
 *
 * 职责（协议见 docs/SPEC.md）：
 *  - 维护单例远端会话（Kaggle Kernel + Cloudflare 隧道 / Colab 实例）的生命周期；
 *  - 串行执行出图任务并把图片落到 `<workspace>/outputs/`（兼容旧 `imagen-output/`）；
 *  - 向 Web Client 暴露状态/任务/历史/文件路由（实现在 server/routes/，本文件只装配）；
 *  - 向 Agent 暴露生图 / 放大 / 会话 / 历史等工具（见 server/tools.js 的工具清单）。
 *
 * 与 DSH 版本的差异只在宿主边界（docs/MIGRATION_SPEC.md §3.4）：
 *  - 从 `apply(ctx, config)` 改为 `createApp({ ctx, config, extra })`，便于 standalone
 *    与测试直接实例化多个 App；
 *  - 新增工作区 / 全局应用设置 / Agent 对话三组桌面端路由；
 *  - 静态默认 config 来自 `server/defaults.js`，这里的逻辑与拆分前逐行一致。
 */

import { join } from 'node:path'

import { APP_VERSION, PROTOCOL_VERSION, SETTINGS, TIMEOUTS } from '../shared/contract.js'
import {
  allCloudPresetsFor,
  cloudPresetIdOf,
  imageApiVendorOf,
} from '../shared/image-providers.js'
import { createAgentRuntime } from './agent/runtime.js'
import { registerAguiTools } from './agent/agui.js'
import { accessToken as colabAccessToken, ccuInfo as colabCcuInfo } from './colab/client.js'
import { createColabLogin } from './colab/oauth.js'
import { buildDiagnosticEnv } from './diagnostics.js'
import { JobQueue } from './jobs.js'
import { hasLocalKaggleCredentials } from './kaggle-client.js'
import { createKaggleLogin } from './kaggle-oauth.js'
import { createKaggleTransport } from './kaggle-transport.js'
import { createHardwareProbe } from './hardware-probe.js'
import { createLogger, installFileLog } from './log.js'
import { createLocalModelManager } from './local-models.js'
import { publicLocalGpuView, readLocalGpuConfig } from './local-gpu/config.js'
import { createLocalGpuSetup } from './local-gpu/setup.js'
import { DEFAULT_PRESET, presetById, publicPresets } from './presets.js'
import { registerRoutes, toInt } from './route-kit.js'
import { createAgentRoutes } from './routes/agent.js'
import { createAppSettingsRoutes } from './routes/app-settings.js'
import { createChatRoutes } from './routes/chat.js'
import { createColabRoutes } from './routes/colab.js'
import { createFileRoutes } from './routes/files.js'
import { createImportRoutes } from './routes/import.js'
import { createJobRoutes } from './routes/jobs.js'
import { createKaggleRoutes } from './routes/kaggle.js'
import { createLibraryRoutes } from './routes/library.js'
import { createLocalGpuRoutes } from './routes/local-gpu.js'
import { createLocalModelsRoutes } from './routes/local-models.js'
import { createLlmModelRoutes } from './routes/llm-models.js'
import { createLogRoutes } from './routes/logs.js'
import { createPromptRoutes } from './routes/prompts.js'
import { createSaladRoutes } from './routes/salad.js'
import { createSessionRoutes } from './routes/session.js'
import { createSettingsRoutes } from './routes/settings.js'
import { createUiStateRoutes } from './routes/ui-state.js'
import { createUpdateRoutes } from './routes/update.js'
import { createWorkerRoutes } from './routes/worker.js'
import { createWorkshopRoutes } from './routes/workshop.js'
import { createLocalPbr } from './local-pbr.js'
import { createWorkspaceRoutes } from './routes/workspace.js'
import { SessionManager } from './session.js'
import { createSettingsStore } from './settings.js'
import { registerTools } from './tools.js'
import { createTelemetry } from './telemetry.js'
import { createUpdateChecker } from './update-check.js'

const log = createLogger({ scope: 'app' })

/**
 * 创建并装配一个 App 实例。
 *
 * @param {object} input
 * @param {object} input.ctx 宿主上下文（server/host-context.js 或测试替身）
 * @param {object} [input.config] 静态配置（默认见 server/defaults.js；由 app-config 的 compute 覆盖）
 * @param {object} [input.extra] 桌面端装配依赖：
 *   - `workspaceManager`：多工作区管理器（缺省则不注册工作区路由、state 里 workspace 为 null）
 *   - `appConfig`：全局应用配置（缺省则不注册 /api/app-settings）
 *   - `llm` / `tools`：Agent 与 LLM 服务（缺省则跳过 Agent 路由）
 *   - `version`：对外展示的应用版本（缺省用契约 APP_VERSION）
 * @returns {object} `{ routes, tools, statePayload, probes, dispose, settings, session, queue,
 *   updateChecker, kaggleLogin, colabLogin, workspaceManager, appConfig }`
 */
export function createApp({ ctx, config = {}, extra = {} } = {}) {
  const workspaceManager = extra.workspaceManager ?? null
  const appConfig = extra.appConfig ?? null
  const llm = extra.llm ?? null
  const toolRegistry = extra.tools ?? null
  const appVersion = typeof extra.version === 'string' && extra.version ? extra.version : APP_VERSION
  const localModels = extra.localModels ?? createLocalModelManager({ ctx, appConfig, log })
  const localGpuSetup = createLocalGpuSetup({ appConfig, localModels, log })
  const hardwareProbe = extra.hardwareProbe ?? createHardwareProbe()
  const localPbr = extra.localPbr ?? createLocalPbr({ ctx, appConfig, localModels, hardwareProbe })

  // 本地滚动日志：尽早安装，保证后续模块（含模块级 createLogger）的日志都能落盘。
  const fileLog = installFileLog(ctx)
  const defaultPreset = presetById(config.defaultPreset ?? DEFAULT_PRESET).id
  const devEndpoint = config.devEndpoint ?? process.env.AIGC_STUDIO_ENDPOINT ?? process.env.OUR_IMAGEN_ENDPOINT ?? null
  const devToken = config.devToken ?? process.env.AIGC_STUDIO_DEV_TOKEN ?? process.env.OUR_IMAGEN_TOKEN ?? 'dev-token'

  // probe：当前探测状态；lastGood：最近一次成功结果（配额不可用时客户端回退展示）。
  // colabUsage / colabProbe：无需唤醒 GPU 即可拉取的 Colab CCU 余额与授权探测缓存。
  const cache = {
    probe: null,
    probeAt: 0,
    probing: null,
    lastGood: null,
    lastGoodAt: null,
    colabUsage: null,
    colabUsageAt: 0,
    colabProbe: null,
    colabProbing: null,
    localKaggleCreds: false,
  }
  void hasLocalKaggleCredentials(ctx)
    .then((ok) => {
      cache.localKaggleCreds = Boolean(ok)
    })
    .catch(() => {})

  // 运行设置：磁盘覆盖项（工作台设置抽屉保存）与静态 config 合并后的生效值。
  // 构造时立即异步加载 `<workspace>/.aigc-studio/settings.json`；读取失败静默降级为仅静态 config。
  const settings = createSettingsStore({ ctx, config })
  void settings.whenReady()

  // Kaggle 访问方式（v0.9 M2 试验特性）：cli = 本机 CLI（默认）；direct = Node 直连 Kaggle API。
  // 传输层每次调用都读最新设置，因此在工作台里切换后，下一次探测 / 唤醒 / 状态轮询即生效。
  const kaggleTransport = createKaggleTransport({ ctx, getSettings: () => settings.current(), log })

  const getUiLocale = () => appConfig?.publicSettingsView?.().ui?.lang ?? null

  // 内置 OAuth 登录（直连模式用）：单实例，成功凭据写入 ~/.kaggle/credentials.json（与 CLI 同格式）。
  // 与传输方式解耦：CLI 模式下也能调用（两者写同一份凭据文件）。
  const kaggleLogin = createKaggleLogin({ ctx, log, getLocale: getUiLocale })

  // 内置 Colab Google OAuth 登录：单实例，成功凭据写入 ~/.aigc-studio/colab-credentials.json（0600）。
  // 启动时异步读一次本地授权摘要（不联网、不暴露令牌）供顶栏与设置抽屉展示。
  const colabLogin = createColabLogin({ ctx, log, getLocale: getUiLocale })
  void colabLogin.refreshAuth()

  // 客户端版本检查（M2.8 阶段 B）：只读检查器。
  //  - 默认源 GitHub Releases；可在应用设置里切到自定义 https 镜像（读取 latest.yml）；
  //  - NSIS 安装态由主进程 electron-updater 独占更新（环境变量 AIGC_STUDIO_UPDATE_OWNER=electron），
  //    此时服务端不发起任何请求，/api/state.update 只回占位，避免双源互相覆盖；
  //  - 开发模式（devEndpoint）与 updateCheck=false 不自动检查，但手动「立即检查」仍可用。
  const updateOwner = (config.updateOwner === 'electron' || process.env.AIGC_STUDIO_UPDATE_OWNER === 'electron')
    ? 'electron'
    : 'local'
  const initialUpdate = appConfig?.getUpdate?.() ?? {
    updateCheck: config.updateCheck !== false,
    updateSource: config.updateSource,
    updateMirrorUrl: config.updateMirrorUrl,
  }
  const updateChecker = createUpdateChecker({
    ctx,
    currentVersion: appVersion,
    cacheFile: appConfig?.root ? join(appConfig.root, 'update-check.json') : undefined,
    enabled: updateOwner !== 'electron' && initialUpdate.updateCheck !== false && !devEndpoint,
    source: initialUpdate.updateSource,
    mirrorUrl: initialUpdate.updateMirrorUrl,
    allowInsecure: config.updateAllowInsecure === true,
    getOptions: appConfig?.getUpdate
      ? () => {
          const current = appConfig.getUpdate()
          return {
            enabled: updateOwner !== 'electron' && current.updateCheck === true && !devEndpoint,
            source: current.updateSource,
            mirrorUrl: current.updateMirrorUrl,
            allowInsecure: config.updateAllowInsecure === true,
          }
        }
      : null,
  })
  updateChecker.start()

  const telemetry = extra.telemetry ?? createTelemetry({
    ctx,
    appConfig,
    version: appVersion,
    getLang: getUiLocale,
    enabled: config.telemetryEnabled !== false && !devEndpoint,
    log,
  })
  const trackTelemetry = (event, props) => telemetry.track(event, props)

  const session = new SessionManager({
    ctx,
    defaultPreset,
    options: {
      devEndpoint,
      devToken,
      accelerator: config.accelerator ?? 'NvidiaTeslaT4',
      provider: config.provider,
      colabGpu: config.colabGpu,
      colabHighRam: config.colabHighRam,
      idleTimeoutSec: toInt(config.idleTimeoutSec, TIMEOUTS.idleShutdownSec, 300, 10800),
      provisionTimeoutMs: toInt(config.provisionTimeoutMinutes, TIMEOUTS.provisionMs / 60000, 5, 240) * 60 * 1000,
      // 排队分级提示阈值：超过慢档只做状态提示，超过卡住档才建议换新实例重排。
      queueSlowMs: toInt(config.queueSlowMinutes, TIMEOUTS.queueSlowMs / 60000, 1, 60) * 60 * 1000,
      queueStalledMs: toInt(config.queueStalledMinutes, TIMEOUTS.queueStalledMs / 60000, 2, 120) * 60 * 1000,
      // 冷启动可靠性（P1.2）：可选 HuggingFace Token、模型下载源、依赖约束、备用隧道命令。
      hfToken: typeof config.hfToken === 'string' && config.hfToken.trim() ? config.hfToken.trim() : null,
      modelSource: config.modelSource,
      pipConstraints: Array.isArray(config.pipConstraints) ? config.pipConstraints.filter((item) => typeof item === 'string') : [],
      fallbackTunnelCommand: Array.isArray(config.fallbackTunnelCommand)
        ? config.fallbackTunnelCommand.filter((item) => typeof item === 'string')
        : [],
      // 备用通道的输出格式千差万别（frpc / bore / 自建脚本），允许用户给提取正则。
      fallbackTunnelUrlRegex:
        typeof config.fallbackTunnelUrlRegex === 'string' && config.fallbackTunnelUrlRegex.trim()
          ? config.fallbackTunnelUrlRegex.trim()
          : null,
      // 权重预挂载（P2.1）：kernel 的 dataset_sources 与本地权重目录映射。
      datasetSources: Array.isArray(config.datasetSources) ? config.datasetSources.filter((item) => typeof item === 'string') : [],
      localModels:
        config.localModels && typeof config.localModels === 'object' && !Array.isArray(config.localModels)
          ? config.localModels
          : null,
      // 备用隧道（P2.2）：用户自建通道的域名后缀，用于 Host 侧校验会合地址可信。
      trustedTunnelDomains: Array.isArray(config.trustedTunnelDomains)
        ? config.trustedTunnelDomains.filter((item) => typeof item === 'string')
        : [],
      // 私有 Worker 连接参数（M3.1）：endpoint 来自 app-config，Token 来自加密凭据。
      // 用 getter 读取，设置抽屉保存后下一次「连接」立即生效；Token 不进入任何快照。
      getWorkerConfig: () => appConfig?.getWorkerConfig?.() ?? null,
      // 商业生图 API 配置（M3.5）：同样用 getter，保存后下一个任务立即生效。
      getImageApiConfig: () => appConfig?.getImageApiConfig?.() ?? null,
      // SaladCloud（M3.6）：API Key / org / project / 档位，保存后下次连接生效。
      getSaladConfig: () => appConfig?.getSaladConfig?.() ?? null,
      // 本机 GPU（M3.4）：local-gpu.json + AIGC_STUDIO_LOCAL_GPU_* 环境变量；
      // 配置在会话启动 / 断开后重新读取，改文件后重新点「连接」即可生效。
      getLocalGpuConfig: () => readLocalGpuConfig({ root: appConfig?.root ?? '', env: process.env }),
      allowInsecureEndpoint: config.imageApiAllowInsecure === true || process.env.AIGC_STUDIO_IMAGE_API_DEV === '1',
    },
    // 每次启动会话前读取最新合并设置（工作台修改后无需重启服务即可在下次唤醒生效）。
    // Kaggle 相关调用统一经传输层分发：cli / direct 同形状，SessionManager 状态机不感知差异。
    deps: {
      getSettings: () => settings.current(),
      kaggleUsername: (context) => kaggleTransport.kaggleUsername(context),
      pushKernel: (context, folder, options) => kaggleTransport.pushKernel(context, folder, options),
      kernelStatus: (context, kernelId) => kaggleTransport.kernelStatus(context, kernelId),
      kernelLogs: (context, kernelId) => kaggleTransport.kernelLogs(context, kernelId),
      // 放弃排队 / 换新实例重排时清理旧 Kernel：直连与 CLI 两种传输都有 deleteKernel。
      deleteKernel: (context, kernelId) => kaggleTransport.deleteKernel(context, kernelId),
    },
  })

  const queue = new JobQueue({
    ctx,
    session,
    defaultPreset,
    options: {
      sessionWaitMs: toInt(config.sessionWaitMinutes, TIMEOUTS.sessionWaitMs / 60000, 5, 240) * 60 * 1000,
      generateTimeoutMs: toInt(config.generateTimeoutSeconds, TIMEOUTS.remoteJobMs / 1000, 30, 1800) * 1000,
      // 模型算力来源能力位（如 9B 仅 Colab）的 Host 侧兜底：每次入队按当前设置判断，切换 provider 即时生效。
      getProvider: () => settings.current().provider,
      localPbr,
      getLocalGpuPresets: () => publicLocalGpuView(readLocalGpuConfig({ root: appConfig?.root ?? '', env: process.env })).configuredPresets,
      // 商业生图 API 的连接配置（含 Key，仅进程内使用）。
      getImageApiConfig: () => appConfig?.getImageApiConfig?.() ?? null,
      onJobTelemetry: trackTelemetry,
    },
  })

  /** 当前工作区视图（桌面端 TopBar 依赖；没有 workspaceManager 时为 null）。 */
  const workspaceView = () => {
    if (!workspaceManager) return null
    const snapshot = workspaceManager.snapshot?.() ?? { current: null, recent: [] }
    let busy = false
    try {
      const stats = queue.queueStats()
      busy = Boolean(session.isActive) || Boolean(stats.running) || (Number(stats.pending) || 0) > 0
    } catch {}
    return {
      current: snapshot.current ?? null,
      recent: Array.isArray(snapshot.recent) ? snapshot.recent : [],
      switchable: !busy,
    }
  }

  /**
   * 已配置后端摘要（M2.7，只给创作 Agent 的 Layer 2 用）。
   *
   * 判定只用宿主「确知的证据」，不猜用户可能有的凭据：
   *  - 当前生效来源：一定放进目录（用户正在用它），备注标注探测 / 会话证据；
   *  - 其它来源：Kaggle 除探测/会话外，还本地检查凭据文件/环境变量（纯本地读盘、无网络请求），
   *    避免在 Colab 下从未探测 Kaggle 时误报「未配置」；Colab 看 OAuth 授权摘要。
   * 只回 id / 布尔 / 一句状态说明，不含任何凭据原文。
   */
  const backendSummaries = async () => {
    const currentProvider = settings.current().provider
    const snapshot = (() => {
      try {
        return session.snapshot() || {}
      } catch {
        return {}
      }
    })()
    const probeAuthOk = Boolean(cache.probe && cache.probe.auth && cache.probe.auth.ok === true)
    const hadGoodProbe = Boolean(cache.lastGood)
    const sessionProvesKaggle = snapshot.provider === 'kaggle' && ['provisioning', 'connecting', 'warming', 'ready', 'stopping'].includes(snapshot.state)
    const localKaggleCreds = probeAuthOk || hadGoodProbe || sessionProvesKaggle
      ? true
      : await hasLocalKaggleCredentials(ctx)
    cache.localKaggleCreds = Boolean(localKaggleCreds)
    const colabAuthorized = colabLogin.authSummary()?.authorized === true
    const kaggleNote = probeAuthOk || hadGoodProbe
      ? '账号可用'
      : sessionProvesKaggle
        ? '会话运行中'
        : localKaggleCreds
          ? '已发现本地凭据（尚未探测）'
          : '尚未探测'
    // 只列「当前可选」的来源：私有 Worker / 本机 GPU 在开放选择前不进入 Agent 目录，
    // 避免模型看到一堆「未配置凭据」的选项而乱推荐。新增来源时在这里补一条证据判断。
    return SETTINGS.providers.map((id) => {
      if (id === 'kaggle') {
        return { id, configured: currentProvider === 'kaggle' || localKaggleCreds, note: kaggleNote }
      }
      if (id === 'colab') {
        return {
          id,
          configured: currentProvider === 'colab' || colabAuthorized,
          note: colabAuthorized ? 'Google 账号已授权' : '未完成 Google 授权',
        }
      }
      if (id === 'private-worker') {
        const worker = appConfig?.publicWorkerView?.() ?? null
        const hasEndpoint = Boolean(worker?.endpointUrl)
        return {
          id,
          configured: hasEndpoint,
          note: !hasEndpoint
            ? '未填写 Worker 地址'
            : worker.tokenConfigured
              ? '已配置地址与 Token'
              : '已配置地址，缺少 Token',
        }
      }
      if (id === 'cloud-api') {
        const imageApi = appConfig?.publicImageView?.() ?? null
        const configuredKeys = Array.isArray(imageApi?.apiKeysConfigured) ? imageApi.apiKeysConfigured : []
        const configured = configuredKeys.length > 0 || Boolean(imageApi?.hasApiKey)
        const names = configuredKeys
          .map((vendorId) => imageApiVendorOf(vendorId)?.short ?? vendorId)
          .filter(Boolean)
        return {
          id,
          configured,
          note: !configured
            ? '未填写生图 API Key'
            : `已配置：${names.join(' / ')}`,
        }
      }
      if (id === 'salad') {
        const salad = appConfig?.publicSaladView?.() ?? null
        const configured = Boolean(salad?.org && salad?.hasApiKey)
        return {
          id,
          configured,
          note: !salad?.hasApiKey
            ? '未填写 Salad API Key'
            : !salad?.org
              ? '已填写 Key，缺少组织 id'
              : `已配置：${salad.org} / ${salad.project} · ${salad.tier}`,
        }
      }
      if (id === 'local-gpu') {
        const localGpuResult = readLocalGpuConfig({ root: appConfig?.root ?? '', env: process.env })
        const localGpu = publicLocalGpuView(localGpuResult)
        const configured = localGpu.engineReady
        return {
          id,
          configured,
          note: configured
            ? `本机引擎已就绪（${localGpu.engineBackend === 'cuda' ? 'CUDA' : 'Vulkan'}）`
            : '本机推理引擎尚未准备',
        }
      }
      return { id, configured: currentProvider === id, note: currentProvider === id ? '长驻服务连接中' : '未配置' }
    })
  }

  const statePayload = () => {
    const currentProvider = settings.current().provider
    const imageApi = appConfig?.publicImageView?.() ?? null
    // 统一把「本地模型 + 全部内置商业 API 精选模型」一起下发给工作台模型胶囊：
    // 未接入/未配置 Key 的模型在胶囊里置灰展示并引导去设置，避免用户在模型列表里“找不到入口”；
    // 当前算力来源可直接使用的模型排在前面，defaultPreset 始终落在当前来源默认模型上。
    const localPresets = publicPresets()
    const cloudPresets = allCloudPresetsFor(imageApi, { includeAllBuiltins: true })
    const configuredCloudSet = new Set(Array.isArray(imageApi?.apiKeysConfigured) ? imageApi.apiKeysConfigured : [])
    const readyCloudPresets = cloudPresets.filter((item) => configuredCloudSet.has(item?.cloud?.vendor))
    const pendingCloudPresets = cloudPresets.filter((item) => !configuredCloudSet.has(item?.cloud?.vendor))
    const orderedCloudPresets = [...readyCloudPresets, ...pendingCloudPresets]
    const presets = currentProvider === 'cloud-api'
      ? [...orderedCloudPresets, ...localPresets]
      : [...localPresets, ...orderedCloudPresets]
    const configuredCloudPreset = currentProvider === 'cloud-api' && imageApi
      ? cloudPresetIdOf(imageApi.vendor, imageApi.model)
      : ''
    const activeDefaultPreset = currentProvider === 'cloud-api'
      ? (orderedCloudPresets.some((item) => item.id === configuredCloudPreset)
        ? configuredCloudPreset
        : orderedCloudPresets[0]?.id ?? defaultPreset)
      : defaultPreset
    const configuredProvidersOf = () => {
      const snapshot = (() => {
        try {
          return session.snapshot() || {}
        } catch {
          return {}
        }
      })()
      const activeSessionProvider = ['provisioning', 'connecting', 'warming', 'ready', 'stopping'].includes(snapshot.state)
        ? snapshot.provider
        : ''
      const configured = []
      const hasKaggle = currentProvider === 'kaggle'
        || activeSessionProvider === 'kaggle'
        || Boolean(cache.probe?.auth?.ok)
        || Boolean(cache.lastGood)
        || Boolean(cache.localKaggleCreds)
      if (hasKaggle) configured.push('kaggle')
      const hasColab = currentProvider === 'colab'
        || activeSessionProvider === 'colab'
        || colabLogin.authSummary()?.authorized === true
      if (hasColab) configured.push('colab')
      const worker = appConfig?.publicWorkerView?.() ?? null
      if (currentProvider === 'private-worker' || activeSessionProvider === 'private-worker' || Boolean(worker?.endpointUrl)) {
        configured.push('private-worker')
      }
      const localGpuResult = readLocalGpuConfig({ root: appConfig?.root ?? '', env: process.env })
      if (currentProvider === 'local-gpu' || activeSessionProvider === 'local-gpu' || localGpuResult.ok) {
        configured.push('local-gpu')
      }
      if (currentProvider === 'cloud-api' || configuredCloudSet.size > 0 || Boolean(imageApi?.hasApiKey)) {
        configured.push('cloud-api')
      }
      const salad = appConfig?.publicSaladView?.() ?? null
      if (currentProvider === 'salad' || activeSessionProvider === 'salad' || (salad?.org && salad?.hasApiKey)) {
        configured.push('salad')
      }
      return configured
    }
    const localGpu = publicLocalGpuView(readLocalGpuConfig({ root: appConfig?.root ?? '', env: process.env }))
    return {
      version: appVersion,
      protocol: PROTOCOL_VERSION,
      defaultPreset: activeDefaultPreset,
      presets,
      session: session.snapshot(),
      queuePolicy: session.queuePolicy(),
      update: updateOwner === 'electron' ? { mode: 'electron' } : updateChecker.snapshot(),
      probe: cache.probe,
      probeAt: cache.probeAt,
      probeLastGood: cache.lastGood,
      probeLastGoodAt: cache.lastGoodAt,
      colabUsage: cache.colabUsage,
      colabUsageAt: cache.colabUsageAt,
      colabProbe: cache.colabProbe,
      jobs: queue.list(10),
      lastJob: queue.lastFinished,
      queue: queue.queueStats(),
      devMode: Boolean(devEndpoint),
      kaggleTransport: kaggleTransport.id(),
      provider: currentProvider,
      configuredProviders: configuredProvidersOf(),
      colabAuth: colabLogin.authSummary(),
      privateWorker: appConfig?.publicWorkerView?.() ?? null,
      localGpu,
      hardware: hardwareProbe.getCached()
        ? { ...hardwareProbe.getCached(), localPbr: localPbr.getCachedInfo?.() ?? { prepared: false } }
        : null,
      // 商业生图 API 的脱敏摘要（服务商 / 模型 / 端点 + 是否已配置 Key）。
      imageApi,
      salad: appConfig?.publicSaladView?.() ?? null,
      hfTokenConfigured: Boolean(settings.current().hfToken),
      workspace: workspaceView(),
      llmConfigured: Boolean(llm?.getSelection?.()),
    }
  }

  const probes = {
    async run(options = {}) {
      const targetProvider = options?.provider || settings.current().provider
      // 商业生图 API：没有可探测的会话端点，只回报「是否已配置 Key」，不发任何付费请求。
      if (targetProvider === 'cloud-api') {
        const imageApi = appConfig?.publicImageView?.() ?? null
        const configuredKeys = Array.isArray(imageApi?.apiKeysConfigured) ? imageApi.apiKeysConfigured : []
        const configured = configuredKeys.length > 0 || Boolean(imageApi?.hasApiKey)
        const names = configuredKeys.map((id) => imageApiVendorOf(id)?.label ?? id)
        return {
          provider: 'cloud-api',
          auth: configured
            ? { ok: true, checkedAt: new Date().toISOString() }
            : { ok: false, checkedAt: new Date().toISOString(), errorCode: 'auth_required' },
          usage: null,
          notes: configured
            ? [`已配置服务商：${names.join('、')}`]
            : ['尚未填写商业生图 API Key'],
        }
      }
      if (targetProvider === 'colab') {
        if (cache.colabProbing) return cache.colabProbing
        cache.colabProbing = (async () => {
          const checkedAt = new Date().toISOString()
          try {
            const auth = await colabLogin.refreshAuth().catch(() => colabLogin.authSummary())
            if (!auth || auth.authorized !== true) {
              const probe = {
                provider: 'colab',
                auth: { ok: false, checkedAt, errorCode: 'auth_required' },
                usage: null,
                notes: ['Colab 尚未授权'],
              }
              cache.colabProbe = probe
              cache.colabUsage = null
              cache.colabUsageAt = Date.now()
              return probe
            }
            const token = await colabAccessToken({ log })
            const info = await colabCcuInfo(token)
            const balance = Number(info?.currentBalance)
            const rate = Number(info?.consumptionRateHourly)
            const assignments = Number(info?.assignmentsCount ?? 0)
            const usage = Number.isFinite(balance)
              ? {
                  balance,
                  rate: Number.isFinite(rate) ? rate : null,
                  assignments: Number.isFinite(assignments) ? assignments : 0,
                }
              : null
            cache.colabUsage = usage
            cache.colabUsageAt = Date.now()
            const probe = {
              provider: 'colab',
              auth: { ok: true, checkedAt },
              usage,
              notes: [],
            }
            cache.colabProbe = probe
            return probe
          } catch (error) {
            const message = String(error?.message ?? error).slice(0, 300)
            const isAuth = error?.status === 401 || /未授权|刷新|refresh_token|expired/i.test(message)
            log.warn('Colab 额度/授权探测异常', message)
            const probe = {
              provider: 'colab',
              auth: { ok: false, checkedAt, errorCode: isAuth ? 'auth_required' : 'unknown' },
              usage: cache.colabUsage,
              notes: [message],
            }
            cache.colabProbe = probe
            return probe
          } finally {
            cache.colabProbing = null
          }
        })()
        return cache.colabProbing
      }

      if (cache.probing) return cache.probing
      cache.probing = (async () => {
        try {
          const probe = await kaggleTransport.probeKaggle(ctx)
          cache.probe = probe
          cache.probeAt = Date.now()
          // 配额接口偶发不可用：保留最近一次成功结果，客户端可回退展示配额与检查时间。
          if (probe?.auth?.ok === true) {
            cache.lastGood = probe
            cache.lastGoodAt = new Date().toISOString()
          }
          return probe
        } catch (error) {
          // 探测崩溃不等于「环境不可用」，必须留 warn 才能和真正的鉴权失败区分开。
          log.warn('Kaggle 环境探测异常', error?.message ?? error)
          const probe = {
            provider: 'kaggle',
            cli: { present: false },
            auth: { ok: false, checkedAt: new Date().toISOString(), errorCode: 'unknown' },
            notes: [String(error?.message ?? error).slice(0, 300)],
          }
          cache.probe = probe
          cache.probeAt = Date.now()
          return probe
        } finally {
          cache.probing = null
        }
      })()
      return cache.probing
    },
  }

  const routes = [
    ...createSessionRoutes({ session, probes, statePayload, defaultPreset, log }),
    // 诊断环境指纹只在 /logs 响应里下发：只含布尔开关、版本号与毫秒耗时，不含配置原文。
    ...createLogRoutes({
      session,
      log,
      ctx,
      env: () => buildDiagnosticEnv({ config, session, settings: settings.current() }),
    }),
    ...createJobRoutes({ ctx, queue, log }),
    ...createFileRoutes({ ctx, log }),
    // 本地图片导入：拖入 / 选择 / 粘贴的 PNG、JPEG 落盘成与生成产物同构的「导入作品」。
    ...createImportRoutes({ ctx, log }),
    ...createLibraryRoutes({ ctx, log }),
    // 资产工坊（M4.2a/b）：复合资产包保存 / ZIP 导出 / SVG 矢量 / 抹除背景与 PBR 的算子提交。
    // 三条本地能力直接落盘，op 路由走同一个串行任务队列（queue 由装配层注入）。
    ...createWorkshopRoutes({ ctx, log, queue, localModels, onTelemetry: trackTelemetry }),
    // 本机端侧模型统一管理（视觉感知 / 本机抠图）：清单、预下载、清理、目录设置与流式读取。
    ...createLocalModelsRoutes({ ctx, appConfig, localModels, hardwareProbe, localPbr, log }),
    // 本机 GPU 可视化配置与探测（M3.4 架构收敛）：读写 local-gpu.json + 设备探测。
    ...createLocalGpuRoutes({ appConfig, log, setup: localGpuSetup }),
    // 提示词路由（润色 / 意图解析）：意图的模型推荐按当前算力来源过滤，
    // 与 JobQueue 的 getProvider 同一份设置读数，切换来源后下一次解析即生效。
    ...createPromptRoutes({ ctx, log, getProvider: () => settings.current().provider, getPresets: () => statePayload().presets }),
    // 运行设置：GET 读脱敏视图 / POST 保存覆盖项（hfToken 只回布尔与来源）。
    ...createSettingsRoutes({ settings, session, log, onTelemetry: trackTelemetry }),
    // 工作台界面状态：GET 读归一化视图 / POST 合并白名单字段（同一 path、method 分发）。
    ...createUiStateRoutes({ ctx, log }),
    // 创作助手对话历史：GET 读 / POST 写 `<workspace>/.aigc-studio/chat.json`（跨重启保留）。
    ...createChatRoutes({ ctx, log }),
    // Kaggle 直连登录（试验特性）：GET 读登录态 / POST 发起、取消或提交授权码（同一 path、method 分发）。
    ...createKaggleRoutes({ login: kaggleLogin, log }),
    // Colab Google OAuth 登录：GET 读登录态与授权摘要 / POST 发起、取消或提交回调（同一 path、method 分发）。
    ...createColabRoutes({ login: colabLogin, log }),
    // 桌面端多工作区：GET 读当前工作区，POST 切换（有活跃任务时 409 workspace_busy）。
    // 切换成功后由路由 `await settings.reload()`，让设置存储跟随新工作区。
    ...createWorkspaceRoutes({ workspaceManager, session, queue, settings, log }),
    // 全局应用设置：ui / llm / clearLlmApiKey / workspace / update（LLM Key 只回布尔与来源）。
    ...createAppSettingsRoutes({
      appConfig,
      workspaceManager,
      session,
      queue,
      version: appVersion,
      log,
      // 更新配置保存后立即按新源重新排期（关闭 / 换镜像都不需要重启）。
      onUpdateChanged: () => updateChecker.refresh(),
      onTelemetry: trackTelemetry,
    }),
    // 版本检查（只读）：POST 手动触发一次；NSIS 安装态回占位。
    ...createUpdateRoutes({ updateChecker, owner: updateOwner, log }),
    // 模型列表：Host 代理各厂商 /models（避免 CORS 与 Key 前置），失败降级内置目录。
    ...createLlmModelRoutes({ appConfig, log }),
    // 私有 Worker 连接探测（M3.1）：设置抽屉「测试连接」，只回脱敏诊断。
    ...createWorkerRoutes({ appConfig, ctx, log }),
    // SaladCloud 连接探测（M3.6）：只读校验 API Key / org / project 与配额。
    ...createSaladRoutes({ appConfig, ctx, log }),
    // 创作 Agent 对话（SSE）：仅在装配层注入 llm + tools 时注册，测试替身环境自动跳过。
    ...(llm && toolRegistry
      ? createAgentRoutes({
          llm,
          tools: toolRegistry,
          runtime: createAgentRuntime({ llm, tools: toolRegistry, log }),
          getProvider: () => settings.current().provider,
          // GPU 会话与队列摘要进系统提示词（冷启动 / 排队预期），避免 Agent 盲目提交任务。
          getSession: () => session.snapshot(),
          getQueue: () => queue.queueStats(),
          // 多后端凭据账本与 HF Token 门控（M2.7）：让 Agent 在提案时能权衡跨后端切换。
          getBackends: backendSummaries,
          getHfTokenConfigured: () => Boolean(settings.current().hfToken),
          // 当前来源的模型目录（商业 API 下是云端预设），与 /state.presets 同源。
          getPresets: () => statePayload().presets,
        })
      : []),
  ]
  registerRoutes(ctx, routes)

  registerTools(ctx, { queue, session, defaultPreset })
  // AGUI 交互工具（提案 / 澄清）与舞台上下文工具：与业务工具同一注册表，
  // 由 Agent 运行时把 `data.ui` 翻译成 proposal / clarify SSE 事件。
  if (ctx.tools) registerAguiTools(ctx.tools, { ctx })

  // 服务重启或热重载后：
  //  1. 先补发上次卸载失败的关机（释放 Kernel 占用的每周 GPU 配额）；
    //  2. 恢复或清理挂起的本机 GPU 准备与旧会话记录。
  // 两步顺序执行、各自吞掉异常，都不阻塞装配。
  void (async () => {
    try {
      await session.cleanupPendingSession()
    } catch (error) {
      log.warn('启动补清理待关机会话异常（已忽略）', error?.message ?? error)
    }
    try {
      await session.restore()
    } catch (error) {
      log.warn('启动恢复会话异常（已忽略）', error?.message ?? error)
    }
    try {
      await localGpuSetup.restore()
    } catch (error) {
      log.warn('恢复本机 GPU 准备状态异常（可重新验证）', error?.message ?? error)
    }
  })()

  const dispose = () => {
    telemetry.dispose()
    session.dispose()
    queue.dispose()
    updateChecker.dispose()
    // 登录管理器可能正在等待浏览器回调：卸载时取消并释放回环端口（不阻塞卸载）。
    const loginShutdown = [kaggleLogin.dispose(), colabLogin.dispose()]
    // 等会话把「待清理会话 / 关机通知」尽力处理完，再关文件日志；整体由调用方限时。
    const settle = [session.disposeCleanup, fileLog.dispose(), localGpuSetup.dispose(), ...loginShutdown].filter((item) => item && typeof item.then === 'function')
    return Promise.allSettled(settle)
  }

  ctx.effect(
    () => dispose,
    'aigc-studio:dispose',
  )

  void settings.whenReady()
    .then(() => {
      telemetry.track('app_launch', {
        provider: settings.current().provider,
        updateOwner,
      })
    })
    .catch(() => {})

  return {
    routes,
    tools: typeof ctx.tools?.list === 'function' ? ctx.tools.list() : [],
    statePayload,
    probes,
    dispose,
    settings,
    session,
    queue,
    telemetry,
    updateChecker,
    kaggleLogin,
    colabLogin,
    workspaceManager,
    appConfig,
  }
}
