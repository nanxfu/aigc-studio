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

import { TIMEOUTS, VERSION } from '../shared/contract.js'
import { createAgentRuntime } from './agent/runtime.js'
import { createColabLogin } from './colab/oauth.js'
import { buildDiagnosticEnv } from './diagnostics.js'
import { JobQueue } from './jobs.js'
import { createKaggleLogin } from './kaggle-oauth.js'
import { createKaggleTransport } from './kaggle-transport.js'
import { createLogger, installFileLog } from './log.js'
import { DEFAULT_PRESET, presetById, publicPresets } from './presets.js'
import { registerRoutes, toInt } from './route-kit.js'
import { createAgentRoutes } from './routes/agent.js'
import { createAppSettingsRoutes } from './routes/app-settings.js'
import { createColabRoutes } from './routes/colab.js'
import { createFileRoutes } from './routes/files.js'
import { createImportRoutes } from './routes/import.js'
import { createJobRoutes } from './routes/jobs.js'
import { createKaggleRoutes } from './routes/kaggle.js'
import { createLibraryRoutes } from './routes/library.js'
import { createLogRoutes } from './routes/logs.js'
import { createPromptRoutes } from './routes/prompts.js'
import { createSessionRoutes } from './routes/session.js'
import { createSettingsRoutes } from './routes/settings.js'
import { createUiStateRoutes } from './routes/ui-state.js'
import { createWorkspaceRoutes } from './routes/workspace.js'
import { SessionManager } from './session.js'
import { createSettingsStore } from './settings.js'
import { registerTools } from './tools.js'
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
 *   - `version`：对外展示的应用版本（缺省用契约 VERSION）
 * @returns {object} `{ routes, tools, statePayload, probes, dispose, settings, session, queue,
 *   updateChecker, kaggleLogin, colabLogin, workspaceManager, appConfig }`
 */
export function createApp({ ctx, config = {}, extra = {} } = {}) {
  const workspaceManager = extra.workspaceManager ?? null
  const appConfig = extra.appConfig ?? null
  const llm = extra.llm ?? null
  const toolRegistry = extra.tools ?? null
  const appVersion = typeof extra.version === 'string' && extra.version ? extra.version : VERSION

  // 本地滚动日志：尽早安装，保证后续模块（含模块级 createLogger）的日志都能落盘。
  const fileLog = installFileLog(ctx)
  const defaultPreset = presetById(config.defaultPreset ?? DEFAULT_PRESET).id
  const devEndpoint = config.devEndpoint ?? process.env.AIGC_STUDIO_ENDPOINT ?? process.env.OUR_IMAGEN_ENDPOINT ?? null
  const devToken = config.devToken ?? process.env.AIGC_STUDIO_DEV_TOKEN ?? process.env.OUR_IMAGEN_TOKEN ?? 'dev-token'

  // probe：当前探测状态；lastGood：最近一次成功结果（配额不可用时客户端回退展示）。
  const cache = { probe: null, probeAt: 0, probing: null, lastGood: null, lastGoodAt: null }

  // 运行设置：磁盘覆盖项（工作台设置抽屉保存）与静态 config 合并后的生效值。
  // 构造时立即异步加载 `<workspace>/.aigc-studio/settings.json`；读取失败静默降级为仅静态 config。
  const settings = createSettingsStore({ ctx, config })
  void settings.whenReady()

  // Kaggle 访问方式（v0.9 M2 试验特性）：cli = 本机 CLI（默认）；direct = Node 直连 Kaggle API。
  // 传输层每次调用都读最新设置，因此在工作台里切换后，下一次探测 / 唤醒 / 状态轮询即生效。
  const kaggleTransport = createKaggleTransport({ ctx, getSettings: () => settings.current(), log })

  // 内置 OAuth 登录（直连模式用）：单实例，成功凭据写入 ~/.kaggle/credentials.json（与 CLI 同格式）。
  // 与传输方式解耦：CLI 模式下也能调用（两者写同一份凭据文件）。
  const kaggleLogin = createKaggleLogin({ ctx, log })

  // 内置 Colab Google OAuth 登录：单实例，成功凭据写入 ~/.aigc-studio/colab-credentials.json（0600）。
  // 启动时异步读一次本地授权摘要（不联网、不暴露令牌）供顶栏与设置抽屉展示。
  const colabLogin = createColabLogin({ ctx, log })
  void colabLogin.refreshAuth()

  // 客户端自身版本检查（只读 npm 注册表，结果缓存在 .aigc-studio/update-check.json）：
  // 只做「有新版本」提示，不下载、不安装、不影响出图链路。
  // 开发模式（devEndpoint）与 config.updateCheck=false（测试 / 想静默的用户）不发起任何请求。
  const updateChecker = createUpdateChecker({
    ctx,
    currentVersion: appVersion,
    enabled: config.updateCheck !== false && !devEndpoint,
  })
  updateChecker.start()

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
      // 冷启动可靠性（P1.2）：可选 HuggingFace Token、依赖约束、备用隧道命令。
      hfToken: typeof config.hfToken === 'string' && config.hfToken.trim() ? config.hfToken.trim() : null,
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

  const statePayload = () => ({
    version: appVersion,
    defaultPreset,
    presets: publicPresets(),
    session: session.snapshot(),
    // 排队分级提示阈值：客户端据此决定「软提示 / 重排卡片」的触发时机（旧 Host 无此字段）。
    queuePolicy: session.queuePolicy(),
    // 客户端自身版本检查结果：客户端只在 hasUpdate 时提示（不下载、不安装）。
    update: updateChecker.snapshot(),
    probe: cache.probe,
    probeAt: cache.probeAt,
    probeLastGood: cache.lastGood,
    probeLastGoodAt: cache.lastGoodAt,
    jobs: queue.list(10),
    lastJob: queue.lastFinished,
    queue: queue.queueStats(),
    devMode: Boolean(devEndpoint),
    // 当前生效的 Kaggle 访问方式（客户端据此把「CLI」字样切为「直连」、决定指引卡主操作）。
    kaggleTransport: kaggleTransport.id(),
    // 当前配置的算力来源与 Colab 本地授权摘要（只含 authorized / email，不含任何令牌）。
    provider: settings.current().provider,
    colabAuth: colabLogin.authSummary(),
    // 桌面端多工作区：TopBar 优先读这份字段，缺失时才回退 GET /api/workspace。
    workspace: workspaceView(),
  })

  const probes = {
    async run() {
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
    // 提示词路由（润色 / 意图解析）：意图的模型推荐按当前算力来源过滤，
    // 与 JobQueue 的 getProvider 同一份设置读数，切换来源后下一次解析即生效。
    ...createPromptRoutes({ ctx, log, getProvider: () => settings.current().provider }),
    // 运行设置：GET 读脱敏视图 / POST 保存覆盖项（hfToken 只回布尔与来源）。
    ...createSettingsRoutes({ settings, session, log }),
    // 工作台界面状态：GET 读归一化视图 / POST 合并白名单字段（同一 path、method 分发）。
    ...createUiStateRoutes({ ctx, log }),
    // Kaggle 直连登录（试验特性）：GET 读登录态 / POST 发起、取消或提交授权码（同一 path、method 分发）。
    ...createKaggleRoutes({ login: kaggleLogin, log }),
    // Colab Google OAuth 登录：GET 读登录态与授权摘要 / POST 发起、取消或提交回调（同一 path、method 分发）。
    ...createColabRoutes({ login: colabLogin, log }),
    // 桌面端多工作区：GET 读当前工作区，POST 切换（有活跃任务时 409 workspace_busy）。
    // 切换成功后由路由 `await settings.reload()`，让设置存储跟随新工作区。
    ...createWorkspaceRoutes({ workspaceManager, session, queue, settings, log }),
    // 全局应用设置：ui / llm / clearLlmApiKey / workspace（LLM Key 只回布尔与来源）。
    ...createAppSettingsRoutes({ appConfig, workspaceManager, session, queue, version: appVersion, log }),
    // 创作 Agent 对话（SSE）：仅在装配层注入 llm + tools 时注册，测试替身环境自动跳过。
    ...(llm && toolRegistry
      ? createAgentRoutes({
          llm,
          tools: toolRegistry,
          runtime: createAgentRuntime({ llm, tools: toolRegistry, log }),
        })
      : []),
  ]
  registerRoutes(ctx, routes)

  registerTools(ctx, { queue, session, defaultPreset })

  // 服务重启或热重载后：
  //  1. 先补发上次卸载失败的关机（释放 Kernel 占用的每周 GPU 配额）；
  //  2. 再尝试从 <workspace>/.aigc-studio/session.json 恢复仍在运行的会话（restore 自行清理记录）。
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
  })()

  const dispose = () => {
    session.dispose()
    queue.dispose()
    updateChecker.dispose()
    // 登录管理器可能正在等待浏览器回调：卸载时取消并释放回环端口（不阻塞卸载）。
    const loginShutdown = [kaggleLogin.dispose(), colabLogin.dispose()]
    // 等会话把「待清理会话 / 关机通知」尽力处理完，再关文件日志；整体由调用方限时。
    const settle = [session.disposeCleanup, fileLog.dispose(), ...loginShutdown].filter((item) => item && typeof item.then === 'function')
    return Promise.allSettled(settle)
  }

  ctx.effect(
    () => dispose,
    'aigc-studio:dispose',
  )

  return {
    routes,
    tools: typeof ctx.tools?.list === 'function' ? ctx.tools.list() : [],
    statePayload,
    probes,
    dispose,
    settings,
    session,
    queue,
    updateChecker,
    kaggleLogin,
    colabLogin,
    workspaceManager,
    appConfig,
  }
}
