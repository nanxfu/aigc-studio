/**
 * 会合隧道监听器（Tunnel Watcher）：从 `SessionManager` 拆出的 ntfy 会合轮询与超时收敛协作器。
 * 负责监控 provisioning/connecting 阶段超时、拉取 ntfy NDJSON 会合消息、校验可信隧道域名，
 * 并在收到 `ready` 后切换 `SessionManager` 到健康轮询阶段。
 */

import { TIMEOUTS } from '../../shared/contract.js'
import { httpText } from '../net.js'
import { logText } from '../redact.js'
import { isTrustedEndpoint } from '../remote.js'
import { describeProvisionTimeout, mapRendezvousError, parseRendezvousLine, rendezvousUrl } from './rendezvous.js'
import { formatDuration, normalizeTunnelProvider } from './state.js'

/**
 * 执行一次隧道会合轮询（对应 `SessionManager.pollTunnel`）。
 *
 * @param {import('../session.js').SessionManager} mgr
 */
export async function pollTunnel(mgr) {
  if (mgr.disposed || mgr.session.state === 'error' || mgr.session.endpointUrl) return
  const epoch = mgr.epoch
  // ready 之后隧道重建失败时不能一直挂在 connecting 状态（旧逻辑要等 60 分钟）。
  // 恢复窗口按轮续期：Kernel 状态轮询确认仍 RUNNING 就续一轮（renewRecoveryWindow），
  // 只有续期用尽后仍连不上才判定 health_failed。
  if (mgr.recoveringFromReady && mgr.recoveryWindowExpired()) {
    if (mgr.isStale(epoch)) return
    mgr.log.warn(
      `tunnel_recovery_timeout renewals=${mgr.recoveryRenewals}/${mgr.options.recoveryMaxRenewals} ` +
        `elapsedMs=${Date.now() - mgr.recoveryStartedAt} kernelStatus=${mgr.session.kernelStatus ?? 'unknown'}`,
    )
    mgr.fail(
      'health_failed',
      `隧道失联后已等待 ${formatDuration(Date.now() - mgr.recoveryBeganAt)}，恢复窗口续期已用尽` +
        `（Kernel 状态 ${mgr.session.kernelStatus ?? '未知'}），请点「唤醒」重新启动会话`,
    )
    return
  }

  if (mgr.session.state === 'provisioning' && mgr.elapsedMs() > mgr.options.provisionTimeoutMs) {
    const kernelId = mgr.session.kernelId
    const logs = kernelId
      ? await mgr.provider.logs(kernelId).catch((error) => {
          mgr.log.debug('拉取 Kernel 日志失败（只影响超时原因文案）', logText(error?.message ?? error, 200))
          return null
        })
      : null
    if (mgr.isStale(epoch)) return
    const tail = logs?.tail ? `\n${logs.tail.slice(-400)}` : ''
    const decision = describeProvisionTimeout({
      kernelStatus: mgr.session.kernelStatus,
      provisionTimeoutMs: mgr.options.provisionTimeoutMs,
      logTail: tail,
    })
    mgr.fail(decision.code, decision.message, { logsTail: logs?.tail })
    // 超时即放弃这条排队：删掉仍留在 Kaggle 队列里的旧 Kernel，避免它之后被调度到空转。
    if (kernelId) void mgr.discardStaleKernel(kernelId, decision.code)
    return
  }

  if (mgr.session.state === 'connecting' && mgr.elapsedMs() > mgr.options.provisionTimeoutMs + mgr.options.tunnelTimeoutMs) {
    if (mgr.isStale(epoch)) return
    mgr.log.warn(`tunnel_timeout elapsedMs=${mgr.elapsedMs()} kernelStatus=${mgr.session.kernelStatus ?? 'unknown'}`)
    mgr.fail('tunnel_timeout', '隧道握手超时：Kernel 已启动但未拿到可访问地址，请点「唤醒」重试或查看远端日志')
    // Kernel 已启动却没有可访问地址：本次会话放弃，删除 Kernel 释放资源。
    const kernelId = mgr.session.kernelId
    if (kernelId) void mgr.discardStaleKernel(kernelId, 'tunnel_timeout')
    return
  }

  const url = rendezvousUrl(mgr.options.ntfyBase, mgr.secret.topic)
  const res = await httpText(mgr.ctx, url, {
    timeoutMs: TIMEOUTS.ntfyPollMs,
    headers: { accept: 'application/x-ndjson' },
  }).catch((error) => {
    // 会合阶段单次轮询失败是常态（ntfy 慢 / 暂无消息），交给下一拍重试。
    mgr.log.debug('ntfy 会合轮询失败（预期内）', logText(error?.message ?? error, 200))
    return null
  })
  if (!mgr.canPoll(epoch) || mgr.session.endpointUrl) return
  if (!res?.ok) return

  let latestReady = null
  let latestReadyIndex = -1
  let latestError = null
  let latestErrorIndex = -1
  const lines = res.text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim()
    if (!trimmed) continue
    const parsed = parseRendezvousLine(trimmed)
    if (parsed.kind === 'invalid-event') {
      mgr.log.warn('会合消息不是合法 JSON（协议可能已漂移）', logText(parsed.error?.message ?? parsed.error, 200))
      continue
    }
    if (parsed.kind === 'skip') continue
    if (parsed.kind === 'invalid-payload') {
      mgr.log.warn('会合消息负载解析失败（协议可能已漂移）', logText(parsed.error?.message ?? parsed.error, 200))
      continue
    }
    const payload = parsed.payload
    if (payload?.type === 'error') {
      latestError = payload
      latestErrorIndex = index
      continue
    }
    if (payload?.type !== 'ready') continue
    if (!isTrustedEndpoint(payload.endpoint, mgr.options.trustedTunnelDomains)) continue
    latestReady = payload
    latestReadyIndex = index
  }

  if (latestError && latestErrorIndex > latestReadyIndex) {
    // daemon 在隧道/依赖/预加载失败时会先发 error 事件再退出。
    const decision = mapRendezvousError(latestError)
    mgr.fail(decision.code, decision.message)
    return
  }
  if (!latestReady) return
  // 幂等：并发的两次轮询可能拿到同一条 ready，已在握手中的 endpoint 不重复处理。
  if (mgr.session.endpointUrl === latestReady.endpoint) return
  // 冷却保护：若该隧道地址刚连续心跳失败，等待冷却到期或远端重播新地址后再重试，
  // 避免 since=all 反复取同一条死地址造成「隧道已建立 ↔ 心跳丢失」25 秒死循环。
  const failed = mgr.failedTunnelEndpoints?.get(latestReady.endpoint)
  if (failed && Date.now() < failed.nextRetryAt) {
    if (failed.count >= 2) {
      mgr.session.detail = '隧道握手多次失败（可能被代理/网络阻断），正等待重试或新隧道地址'
    }
    return
  }

  mgr.session.endpointUrl = latestReady.endpoint
  mgr.session.modelId = latestReady.model_id ?? mgr.session.modelId
  mgr.session.device = latestReady.device ?? mgr.session.device
  mgr.session.tunnelProvider = normalizeTunnelProvider(latestReady.provider)
  mgr.log.info(`tunnel_ready provider=${mgr.session.tunnelProvider ?? 'unknown'} elapsedMs=${mgr.elapsedMs()}`)
  mgr.transition('connecting', { phase: 'tunnel' })
  mgr.session.detail = '隧道已建立，正在握手'
  mgr.persistSession({ force: true })
  mgr.startHealthLoop()
}
