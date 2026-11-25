/**
 * 顶栏任务队列弹层（.ofs-queue-popover）。
 *
 * 收纳原顶部横幅区里的生图流水线与排队卡住提示，并汇总所有活动中与近期任务：
 *  - 上段：当前会话与生成流水线（<PipelineBar>）及 10 分钟卡住重排提示（<QueueNotice>）；
 *  - 主列表：活动任务（运行中 / 等云端 / 排队中）排在前面，近期已完成 / 失败 / 已取消任务随后；
 *  - 任意任务行都支持点击回看：已完成任务直接预览成品，在途 / 失败任务回看源图或回填参数，
 *    不再因为排队而阻断回看；取消与重试按钮独立放在行尾。
 */

import React from 'react'

import { WORKSHOP } from '../../shared/contract.js'
import { useNow } from '../hooks/useNow.js'
import { formatDuration, formatSeconds, formatText, jobElapsed } from '../logic/format.js'
import { isJobCancellable, isJobCancelling, pendingJobsOf, stateJobs } from '../logic/jobs.js'
import { pipelineHoldOf } from '../logic/pipeline.js'
import { jobProgressText } from '../logic/status.js'
import { usePresence } from './hooks/usePresence.js'
import { Icon } from './icons.jsx'
import { PipelineBar } from './PipelineBar.jsx'
import { QueueNotice } from './QueueNotice.jsx'

function jobTimestamp(job) {
  const value = Date.parse(String((job && (job.finishedAt || job.startedAt || job.createdAt)) || ''))
  return Number.isFinite(value) ? value : 0
}

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
  } = props
  const presence = usePresence(open, 150)
  const pendingJobs = Array.isArray(compute?.pendingJobs) ? compute.pendingJobs : pendingJobsOf({ jobs: compute?.jobs })
  const focusedJob = compute?.focusedJob || null
  const ticking = open && (
    pendingJobs.length > 0
    || Boolean(compute?.status?.transient)
    || pipelineHoldOf(focusedJob, Date.now())
  )
  const now = useNow(ticking)

  if (!presence.mounted) return null

  const allJobs = Array.isArray(compute?.jobs) ? compute.jobs : stateJobs({ jobs: compute?.jobs })
  const pendingIds = new Set(pendingJobs.map((job) => job.id))
  const recentJobs = allJobs
    .filter((job) => job && job.id && !pendingIds.has(job.id))
    .sort((a, b) => jobTimestamp(b) - jobTimestamp(a))
    .slice(0, 12)
  const orderedJobs = [...pendingJobs, ...recentJobs]

  const presets = Array.isArray(compute?.presets) ? compute.presets : []
  const sessionState = compute?.sessionState || 'absent'
  const cancellingIds = Array.isArray(compute?.cancellingIds) ? compute.cancellingIds : []
  const cancelJob = typeof compute?.cancelJob === 'function' ? compute.cancelJob : null
  const reviewJob = actions && typeof actions.reviewJob === 'function' ? actions.reviewJob : null
  const retryFocusedJob = actions && typeof actions.retryFocusedJob === 'function' ? actions.retryFocusedJob : null
  const gallery = Array.isArray(library?.gallery) ? library.gallery : []

  const urlForPath = (targetPath) => {
    if (!targetPath) return ''
    const found = gallery.find((entry) => entry && entry.image && entry.image.path === targetPath)
    if (found && found.image && found.image.url) return found.image.url
    return `/api/file?path=${encodeURIComponent(targetPath)}`
  }

  const pipelineFocusedJob = focusedJob
    && (focusedJob.tool === WORKSHOP.cutout.op || focusedJob.tool === WORKSHOP.pbr.op)
    && focusedJob.status === 'failed'
    ? null
    : focusedJob
  const failureDismissed = Boolean(guidance && guidance.key)
    && (guidance.dismissed === true || dismissedKey === guidance.key)

  const queueSummary = pendingJobs.length > 0
    ? formatText(t('studio.queue.summaryActive'), { count: pendingJobs.length })
    : (orderedJobs.length > 0
        ? formatText(t('studio.queue.summaryRecent'), { count: orderedJobs.length })
        : t('studio.queue.summaryIdle'))

  return (
    <div
      className="ofs-popover ofs-queue-popover"
      id="ofs-queue-popover"
      data-exiting={presence.exiting ? 'true' : undefined}
      role="dialog"
      aria-label={t('studio.queue.title')}
    >
      <div className="ofs-popover-head ofs-queue-head">
        <span className="ofs-queue-head-title">
          <Icon name="clock" size={14} />
          <b>{t('studio.queue.title')}</b>
        </span>
        <span className="ofs-queue-head-count">{queueSummary}</span>
      </div>

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

      <div className="ofs-queue-list" role="list" aria-label={t('studio.queue.title')}>
        {orderedJobs.length === 0 ? (
          <div className="ofs-queue-empty">
            <p className="ofs-queue-empty-title">{t('studio.queue.emptyTitle')}</p>
            <p className="ofs-queue-empty-hint">{t('studio.queue.emptyHint')}</p>
          </div>
        ) : orderedJobs.map((job) => {
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
            ? (cancelling ? 'warn' : queued ? 'idle' : 'warn')
            : done
              ? 'ok'
              : failed
                ? 'error'
                : 'idle'

          return (
            <div
              key={job.id}
              role="listitem"
              className={`ofs-queue-item${active ? ' is-active' : ''}${queued ? ' is-queued' : ''}${failed ? ' is-failed' : ''}${done ? ' is-done' : ''}`}
            >
              <button
                type="button"
                className="ofs-queue-item-main"
                disabled={!canReview}
                title={reviewHint ? `${title} · ${reviewHint}` : title}
                onClick={() => {
                  if (reviewJob) reviewJob(job)
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
                    <i className={`ofs-dot is-${statusTone}${active && !queued && !cancelling ? ' is-live' : ''}`} aria-hidden="true" />
                    <span className="ofs-queue-status">{statusLabel}</span>
                    {presetName ? <span className="ofs-queue-preset">{presetName}</span> : null}
                    {timeText ? <span className="ofs-queue-time">{timeText}</span> : null}
                  </span>
                </span>
              </button>
              {isJobCancellable(job) && cancelJob ? (
                <button
                  type="button"
                  className="ofs-ghost-cancel ofs-queue-cancel"
                  aria-label={t(cancelling ? 'studio.job.cancelling' : 'studio.job.cancel')}
                  title={cancelling ? t('studio.job.cancelling') : t('studio.job.cancelHint')}
                  disabled={cancelling}
                  onClick={() => cancelJob(job.id)}
                >
                  {t(cancelling ? 'studio.job.cancelling' : 'studio.job.cancel')}
                </button>
              ) : failed && focusedJob && focusedJob.id === job.id && retryFocusedJob ? (
                <button
                  type="button"
                  className="ofs-ghost-cancel ofs-queue-retry"
                  onClick={() => retryFocusedJob()}
                >
                  {t('studio.guidance.generic.action')}
                </button>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}
