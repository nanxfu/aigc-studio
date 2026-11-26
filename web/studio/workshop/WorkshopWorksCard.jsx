/**
 * 工坊左侧「最近作品 + 版本切换」卡片。
 *
 * 同一根作品的多代加工（原图 → 抹除背景 → 无缝平铺…）在网格里折叠成一张卡片并带 `vN`
 * 角标，同时在网格下方提供紧凑版本条，让用户可随时切回任意历史版本查看或再加工。
 */

import React from 'react'

import { Icon } from '../icons.jsx'
import { workNameOf } from './workshopState.js'

export function WorkshopWorksCard(props) {
  const {
    t,
    recentWorks,
    selected,
    selectedRootKey,
    busy,
    library,
    onSelectWork,
    onFileChange,
  } = props

  return (
    <section className="ofs-workshop-works ofs-workshop-card--works">
      <div className="ofs-workshop-section-head">
        <h3>{t('studio.workshop.sideTitle')}</h3>
        <div className="ofs-workshop-section-tools">
          <span className="ofs-workshop-count">{recentWorks.length}</span>
          {/* 上传收进标题行：整行虚线按钮会把参数卡一路往下挤。 */}
          <label className="ofs-workshop-upload" title={t('studio.workshop.uploadHint')}>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={onFileChange}
              disabled={busy !== ''}
            />
            <Icon name="plus" size={12} />
            <span>{busy === 'upload' ? t('studio.workshop.uploading') : t('studio.workshop.upload')}</span>
          </label>
        </div>
      </div>
      <p className="ofs-workshop-hint">{t('studio.workshop.sideHint')}</p>
      {recentWorks.length === 0 ? (
        <p className="ofs-workshop-empty">{t('studio.workshop.sideEmpty')}</p>
      ) : (
        <div className="ofs-workshop-work-scroll">
          <div className="ofs-workshop-work-grid">
            {recentWorks.map((group) => {
              const active = Boolean(selectedRootKey && group.rootKey === selectedRootKey)
              const displayEntry = active && selected && selected.image ? selected : group.latest
              const title = workNameOf(displayEntry.image)
              return (
                <button
                  key={group.rootKey}
                  type="button"
                  className={active ? 'ofs-workshop-work is-on' : 'ofs-workshop-work'}
                  title={group.versionCount > 1 && title ? `${title} · v${group.versionCount}` : title}
                  aria-pressed={active ? 'true' : 'false'}
                  onClick={() => onSelectWork(group.latest)}
                >
                  <img src={displayEntry.image.url} alt={workNameOf(displayEntry.image)} draggable={false} />
                  {group.versionCount > 1 ? (
                    <span className="ofs-workshop-work-ver" aria-hidden="true">
                      {`v${group.versionCount}`}
                    </span>
                  ) : null}
                </button>
              )
            })}
          </div>
          {library && library.hasMore && typeof library.loadMore === 'function' ? (
            <button
              type="button"
              className="ofs-workshop-load-more"
              disabled={Boolean(library.loadingMore)}
              onClick={() => library.loadMore()}
            >
              {library.loadingMore ? t('studio.gallery.loadingMore') : t('studio.gallery.loadMore')}
            </button>
          ) : null}
        </div>
      )}
    </section>
  )
}
