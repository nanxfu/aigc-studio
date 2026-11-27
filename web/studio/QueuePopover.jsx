/**
 * 顶栏任务队列弹层（.ofs-queue-popover）。
 *
 * 收纳原顶部横幅区里的生图流水线与排队卡住提示，并汇总本次会话进入过队列的任务：
 *  - 上段：当前会话与生成流水线（<PipelineBar>）及 10 分钟卡住重排提示（<QueueNotice>）；
 *  - 主列表：活动任务（运行中 / 等云端 / 排队中）排在前面，只追加本次会话中已完成 / 失败的
 *    「待看」任务；主动取消与冷启动前的旧历史不进入列表。
 *  - 已完成 / 失败任务在查看、重试、手动移除或清空后移出；点击最后一条结束任务后自动收起面板。
 *  - 任意任务行都支持点击回看：已完成任务直接预览成品，失败任务回看源图或回填参数；
 *    取消、重试与移除按钮独立放在行尾。
 */

import React from 'react'

import { WORKSHOP } from '../../shared/contract.js'
import { routePath } from '../api.js'
import { useNow } from '../hooks/useNow.js'
import { formatDuration, formatSeconds, formatText, jobElapsed } from '../logic/format.js'
import { isJobCancellable, isJobCancelling, pendingJobsOf } from '../logic/jobs.js'
import { pipelineHoldOf } from '../logic/pipeline.js'
import { jobProgressText, jobStepOf } from '../logic/status.js'
import { usePresence } from './hooks/usePresence.js'
import { Icon } from './icons.jsx'
import { PipelineBar } from './PipelineBar.jsx'
import { QueueNotice } from './QueueNotice.jsx'

function sourcePathOfJob(job) {
  if (!job || typeof job !== 'object') return ''
  const params = job.params && typeof job.params === 'object' ? job.params : null
  if (typeof job.parentPath === 'string' && job.parentPath) return job.parentPath
  if (params && typeof params.parentPath === 'string' && params.parentPath) return params.parentPath
  if (params && params.reference && typeof params.reference.sourcePath === 'string' && params.reference.sourcePath) {
    return params.reference.sourcePath
  }
  if (params && Array.isArray(params.references) && typeof params.references[0] === 'string' && params.references[0]) {
    return params.references[0]
  }
  return ''
}

function outputImageOfJob(job) {
  const images = job && job.output && Array.isArray(job.output.images) ? job.output.images : []
  return images.find((img) => img && (img.url || img.path)) || null
}

function finishedDurationMs(job) {
  if (!job || typeof job !== 'object') return null
  if (Number.isFinite(Number(job.seconds)) && Number(job.seconds) > 0) return Number(job.seconds) * 1000
  const start = Date.parse(String(job.startedAt || job.createdAt || ''))
  const end = Date.parse(String(job.finishedAt || ''))
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) return end - start
  return null
}

function jobTitleOf(t, job, presets) {
  const prompt = job && job.params && typeof job.params.prompt === 'string' ? job.params.prompt.trim() : ''
  if (prompt) return prompt
  const tool = job && typeof job.tool === 'string' ? job.tool : ''
  if (tool === WORKSHOP.cutout.op) return t('studio.workshop.tool.cutout')
  if (tool === WORKSHOP.pbr.op) return t('studio.workshop.tool.pbr')
  if (tool === WORKSHOP.depth.op) return t('studio.workshop.tool.depth-fx')
  if (tool === WORKSHOP.relight.op) return t('studio.workshop.tool.relight')
  if (tool === 'inpaint') return t('studio.filmstrip.versionKind.inpaint')
  if (tool === 'img2img') return t('studio.filmstrip.versionKind.img2img')
  if (tool === 'upscale') return t('studio.filmstrip.versionKind.upscale')
  if (tool === 'outpaint') return t('studio.filmstrip.versionKind.outpaint')
  const presetId = (job && (job.presetId || (job.params && job.params.presetId))) || ''
  const preset = (Array.isArray(presets) ? presets : []).find((item) => item && item.id === presetId)
  return (preset && (preset.short || preset.label)) || presetId || t('studio.queue.untitled')
}

function presetLabelForJob(job, presets) {
  const presetId = (job && (job.presetId || (job.params && job.params.presetId))) || ''
  if (!presetId) return ''
  const preset = (Array.isArray(presets) ? presets : []).find((item) => item && item.id === presetId)
  return (preset && (preset.short || preset.label)) || presetId
}

export function QueuePopover(props) {
  const {
    t,
    open,
    compute,
    library,
    actions,
    guidance,
    dismissedKey = '',
    onClose,
  } = props
  const presence = usePresence(open, 150)
  const pendingJobs = Array.isArray(compute?.pendingJobs) ? compute.pendingJobs : pendingJobsOf({ jobs: compute?.jobs })
  const retainedJobs = Array.isArray(compute?.retainedJobs) ? compute.retainedJobs : []
  const orderedJobs = Array.isArray(compute?.queueJobs)
    ? compute.queueJobs
    : [...pendingJobs, ...retainedJobs]
  const focusedJob = compute?.focusedJob || null
  const ticking = open && (
    pendingJobs.length > 0
    || Boolean(compute?.status?.transient)
    || pipelineHoldOf(focusedJob, Date.now())
  )
  const now = useNow(ticking)

  if (!presence.mounted) return null

  const pendingIds = new Set(pendingJobs.map((job) => job.id))

  const presets = Array.isArray(compute?.presets) ? compute.presets : []
  const sessionState = compute?.sessionState || 'absent'
  const cancellingIds = Array.isArray(compute?.cancellingIds) ? compute.cancellingIds : []
  const cancelJob = typeof compute?.cancelJob === 'function' ? compute.cancelJob : null
  const removeQueueJob = typeof compute?.removeQueueJob === 'function' ? compute.removeQueueJob : null
  const clearFinishedQueue = typeof compute?.clearFinishedQueue === 'function' ? compute.clearFinishedQueue : null
  const reviewJob = actions && typeof actions.reviewJob === 'function' ? actions.reviewJob : null
  const retryFocusedJob = actions && typeof actions.retryFocusedJob === 'function' ? actions.retryFocusedJob : null
  const gallery = Array.isArray(library?.gallery) ? library.gallery : []

  const urlForPath = (targetPath) => {
    if (!targetPath) return ''
    const found = gallery.find((entry) => entry && entry.image && entry.image.path === targetPath)
    if (found && found.image && found.image.url) return found.image.url
    return `${routePath('file')}?path=${encodeURIComponent(targetPath)}`
  }

  const pipelineFocusedJob = focusedJob
    && [WORKSHOP.cutout.op, WORKSHOP.pbr.op, WORKSHOP.depth.op, WORKSHOP.relight.op].includes(focusedJob.tool)
    && focusedJob.status === 'failed'
    ? null
    : focusedJob
  const failureDismissed = Boolean(guidance && guidance.key)
    && (guidance.dismissed === true || dismissedKey === guidance.key)

  const finishedCount = orderedJobs.filter((job) => job.status === 'done' || job.status === 'failed').length
  const groups = [
    { key: 'active', jobs: orderedJobs.filter((job) => pendingIds.has(job.id) && job.status !== 'queued') },
    { key: 'queued', jobs: orderedJobs.filter((job) => pendingIds.has(job.id) && job.status === 'queued') },
    { key: 'review', jobs: orderedJobs.filter((job) => !pendingIds.has(job.id)) },
  ].filter((group) => group.jobs.length > 0)
  const queueSummary = pendingJobs.length > 0 && finishedCount > 0
    ? formatText(t('studio.queue.summaryMixed'), { active: pendingJobs.length, finished: finishedCount })
    : pendingJobs.length > 0
      ? formatText(t('studio.queue.summaryActive'), { count: pendingJobs.length })
      : (finishedCount > 0
          ? formatText(t('studio.queue.summaryRecent'), { count: finishedCount })
          : compute?.status?.transient && compute.status.label
            ? compute.status.label
            : t('studio.queue.summaryIdle'))

  function dismissFinishedJob(job) {
    if (!job || !removeQueueJob) return
    const lastVisible = orderedJobs.every((item) => item.id === job.id)
    removeQueueJob(job.id)
    if (lastVisible && typeof onClose === 'function') onClose()
  }

  return (
    <div
      className="ofs-popover ofs-queue-popover"
      id="ofs-queue-popover"
      data-exiting={presence.exiting ? 'true' : undefined}
      role="dialog"
      aria-labelledby="ofs-queue-title"
      aria-describedby="ofs-queue-summary"
    >
      <div className="ofs-popover-head ofs-queue-head">
        <div className="ofs-queue-heading">
          <h2 className="ofs-queue-head-title" id="ofs-queue-title">{t('studio.queue.title')}</h2>
          <p className="ofs-queue-head-count" id="ofs-queue-summary" role="status">{queueSummary}</p>
        </div>
        {typeof onClose === 'function' ? (
          <button type="button" className="ofs-queue-close" aria-label={t('studio.queue.close')} onClick={onClose}>
            <Icon name="close" size={15} />
          </button>
        ) : null}
      </div>

      <div className="ofs-queue-list">
        <div className="ofs-queue-pipeline-wrap">
          <PipelineBar
            t={t}
            session={compute?.session}
            provider={compute?.provider}
            activeJob={compute?.activeJob}
            focusedJob={pipelineFocusedJob}
            pendingCount={pendingJobs.length}
            queuePolicy={compute?.queue?.policy}
            failureDismissed={failureDismissed}
            transient={Boolean(compute?.status?.transient)}
          />
          <QueueNotice t={t} notice={compute?.queueNotice} />
        </div>
        {orderedJobs.length === 0 ? (
          <div className="ofs-queue-empty">
            <Icon name="clock" size={22} />
            <p className="ofs-queue-empty-title">{t('studio.queue.emptyTitle')}</p>
            <p className="ofs-queue-empty-hint">{t('studio.queue.emptyHint')}</p>
          </div>
        ) : groups.map((group) => (
          <section className="ofs-queue-group" key={group.key} aria-labelledby={`ofs-queue-group-${group.key}`}>
            <div className="ofs-queue-group-head">
              <h3 id={`ofs-queue-group-${group.key}`}>
                {t(`studio.queue.group.${group.key}`)}
                <span className="ofs-queue-group-count">{group.jobs.length}</span>
              </h3>
              {group.key === 'review' && finishedCount > 0 && clearFinishedQueue ? (
                <button
                  type="button"
                  className="ofs-queue-clear"
                  onClick={() => {
                    clearFinishedQueue()
                    if (pendingJobs.length === 0 && typeof onClose === 'function') onClose()
                  }}
                >
                  {t('studio.queue.clearFinished')}
                </button>
              ) : null}
            </div>
            <div className="ofs-queue-group-list" role="list" aria-labelledby={`ofs-queue-group-${group.key}`}>
              {group.jobs.map((job) => {
                const active = pendingIds.has(job.id)
                const queued = job.status === 'queued'
                const done = job.status === 'done'
                const failed = job.status === 'failed'
                const cancelled = job.status === 'cancelled'
                const cancelling = isJobCancelling(job, cancellingIds)
                const queueSlot = pendingJobs.findIndex((item) => item.id === job.id)
                const outImg = done ? outputImageOfJob(job) : null
                const srcPath = !outImg ? sourcePathOfJob(job) : ''
                const thumbUrl = (outImg && (outImg.url || urlForPath(outImg.path))) || (srcPath ? urlForPath(srcPath) : '')
                const title = jobTitleOf(t, job, presets)
                const presetName = presetLabelForJob(job, presets)
                const width = Number(job.params?.width)
                const height = Number(job.params?.height)
                const dimensions = width > 0 && height > 0 ? `${width} × ${height}` : ''
                const step = active && !queued && !cancelling
                  && (job.stageCode === 'running' || (!job.stageCode && job.status === 'running'))
                  ? jobStepOf(job)
                  : null
                const elapsedMs = active ? jobElapsed(job, now) : finishedDurationMs(job)
                const timeText = active
                  ? (Number.isFinite(elapsedMs) ? formatDuration(t, elapsedMs) : '')
                  : (Number.isFinite(elapsedMs) && elapsedMs > 0 ? formatSeconds(t, elapsedMs / 1000) : '')
                const statusLabel = active
                  ? (cancelling ? t('studio.job.cancelling') : jobProgressText(t, job, sessionState))
                  : done
                    ? t('studio.queue.status.done')
                    : failed
                      ? t('studio.queue.status.failed')
                      : cancelled
                        ? t('studio.queue.status.cancelled')
                        : t('studio.queue.status.done')
                const reviewHint = done && outImg
                  ? t('studio.queue.reviewOutput')
                  : srcPath
                    ? t('studio.queue.reviewSource')
                    : (job.params && job.params.prompt ? t('studio.queue.recallParams') : '')
                const canReview = Boolean(reviewJob && (outImg || srcPath || (job.params && job.params.prompt)))
                const statusTone = cancelling || queued || active
                  ? (cancelling || queued || job.status === 'waiting-session' ? 'idle' : 'pending')
                  : done
                    ? 'ok'
                    : failed
                      ? 'error'
                      : 'idle'

                return (
                  <div
                    key={job.id}
                    role="listitem"
                    className={`ofs-queue-item${active ? ' is-active' : ''}${queued ? ' is-queued' : ''}${failed ? ' is-failed' : ''}${done ? ' is-done' : ''}${cancelling ? ' is-cancelling' : ''}`}
                  >
                    <button
                      type="button"
                      className="ofs-queue-item-main"
                      disabled={!canReview}
                      title={reviewHint ? `${title} · ${reviewHint}` : title}
                      onClick={() => {
                        if (reviewJob) reviewJob(job)
                        if (done || failed) dismissFinishedJob(job)
                      }}
                    >
                      <span className="ofs-queue-thumb" aria-hidden="true">
                        {thumbUrl ? (
                          <img src={thumbUrl} alt="" loading="lazy" draggable={false} />
                        ) : active && !queued ? (
                          <span className="ofs-ghost-bar" />
                        ) : queued && queueSlot >= 0 ? (
                          <span className="ofs-ghost-slot">{queueSlot + 1}</span>
                        ) : (
                          <Icon name={failed ? 'alert' : 'image'} size={14} />
                        )}
                      </span>
                      <span className="ofs-queue-copy">
                        <span className="ofs-queue-prompt">{title}</span>
                        <span className="ofs-queue-meta">
                          <i className={`ofs-dot is-${statusTone}${statusTone === 'pending' ? ' is-live' : ''}`} aria-hidden="true" />
                          <span className="ofs-queue-status">{statusLabel}</span>
                          {timeText ? (
                            <span className="ofs-queue-time" aria-label={formatText(t(active ? 'studio.queue.elapsed' : 'studio.queue.duration'), { time: timeText })}>
                              {timeText}
                            </span>
                          ) : null}
                        </span>
                        {presetName || dimensions ? (
                          <span className="ofs-queue-details">
                            {presetName ? <span className="ofs-queue-preset" title={presetName}>{presetName}</span> : null}
                            {dimensions ? <span className="ofs-queue-dimensions">{dimensions}</span> : null}
                          </span>
                        ) : null}
                        {step ? (
                          <span
                            className="ofs-queue-progress"
                            role="progressbar"
                            aria-label={statusLabel}
                            aria-valuemin={0}
                            aria-valuemax={step.steps}
                            aria-valuenow={step.step}
                          >
                            <span style={{ width: `${step.step / step.steps * 100}%` }} />
                          </span>
                        ) : null}
                      </span>
                    </button>
                    {(isJobCancellable(job) && cancelJob
                      || (failed && focusedJob && focusedJob.id === job.id && retryFocusedJob)
                      || ((done || failed) && removeQueueJob)) ? (
                        <span className="ofs-queue-item-actions">
                          {isJobCancellable(job) && cancelJob ? (
                            <button
                              type="button"
                              className="ofs-ghost-cancel ofs-queue-cancel"
                              aria-label={`${t(cancelling ? 'studio.job.cancelling' : 'studio.job.cancel')} · ${title}`}
                              title={cancelling ? t('studio.job.cancelling') : t('studio.job.cancelHint')}
                              disabled={cancelling}
                              onClick={() => cancelJob(job.id)}
                            >
                              {t(cancelling ? 'studio.job.cancelling' : 'studio.job.cancel')}
                            </button>
                          ) : null}
                          {failed && focusedJob && focusedJob.id === job.id && retryFocusedJob ? (
                            <button
                              type="button"
                              className="ofs-queue-retry"
                              onClick={() => {
                                retryFocusedJob()
                                dismissFinishedJob(job)
                              }}
                            >
                              {t('studio.guidance.generic.action')}
                            </button>
                          ) : null}
                          {(done || failed) && removeQueueJob ? (
                            <button
                              type="button"
                              className="ofs-queue-remove"
                              aria-label={`${t('studio.queue.removeFinished')} · ${title}`}
                              title={t('studio.queue.removeFinishedHint')}
                              onClick={() => dismissFinishedJob(job)}
                            >
                              <Icon name="close" size={13} />
                            </button>
                          ) : null}
                        </span>
                      ) : null}
                  </div>
                )
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
