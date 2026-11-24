/**
 * 创作助手空态欢迎区（The Monochrome Print Room 极简气质）。
 *
 * - 上段：克制徽章 + 3 条简洁专业的功能入口；
 * - 下段：「风格灵感」海报卡墙（5 张与 INSPIRE_KEYS 一一对应的预置风格参考图，
 *   第 1 张跨两列做宽幅头图 + 下方 2×2 齐平排布，直观展示 5 种风格方向）；
 * - 点击一律只填入对话草稿并聚焦输入框，不越过用户直接改表单。
 */

import React from 'react'

import { INSPIRE_KEYS } from '../../constants.js'
import { Icon } from '../icons.jsx'
import inspire1 from '../posters/inspire-1.webp'
import inspire2 from '../posters/inspire-2.webp'
import inspire3 from '../posters/inspire-3.webp'
import inspire4 from '../posters/inspire-4.webp'
import inspire5 from '../posters/inspire-5.webp'

const INSPIRE_POSTERS = Object.freeze({
  'studio.inspire.1': inspire1,
  'studio.inspire.2': inspire2,
  'studio.inspire.3': inspire3,
  'studio.inspire.4': inspire4,
  'studio.inspire.5': inspire5,
})

const STARTER_SCENES = Object.freeze([
  { id: 'draft', icon: 'sparkles', titleKey: 'studio.chat.empty.sceneDraftTitle', descKey: 'studio.chat.empty.sceneDraftDesc', promptKey: 'studio.chat.empty.sceneDraftPrompt' },
  { id: 'refine', icon: 'brush', titleKey: 'studio.chat.empty.sceneRefineTitle', descKey: 'studio.chat.empty.sceneRefineDesc', promptKey: 'studio.chat.empty.sceneRefinePrompt' },
  { id: 'explore', icon: 'images', titleKey: 'studio.chat.empty.sceneExploreTitle', descKey: 'studio.chat.empty.sceneExploreDesc', promptKey: 'studio.chat.empty.sceneExplorePrompt' },
])

export function ChatEmptyState({ t, locked, onPickPrompt }) {
  return (
    <div className="ofs-chat-empty">
      <div className="ofs-chat-empty-hero">
        <span className="ofs-chat-empty-badge" aria-hidden="true">
          <Icon name="sparkles" size={16} />
        </span>
        <h3 className="ofs-chat-empty-title">{t('studio.chat.empty.title')}</h3>
        <p className="ofs-chat-empty-text">{t('studio.chat.empty')}</p>
      </div>

      <div className="ofs-chat-starters">
        {STARTER_SCENES.map((scene) => {
          const prompt = t(scene.promptKey)
          return (
            <button
              type="button"
              key={scene.id}
              className="ofs-chat-starter"
              disabled={locked}
              onClick={() => onPickPrompt(prompt)}
              title={prompt}
            >
              <span className="ofs-chat-starter-icon" aria-hidden="true">
                <Icon name={scene.icon} size={13} />
              </span>
              <span className="ofs-chat-starter-body">
                <span className="ofs-chat-starter-title">{t(scene.titleKey)}</span>
                <span className="ofs-chat-starter-desc">{t(scene.descKey)}</span>
              </span>
            </button>
          )
        })}
      </div>

      <div className="ofs-chat-examples-wrap">
        <div className="ofs-chat-examples-head">
          <span className="ofs-chat-examples-label">{t('studio.chat.empty.examplesLabel')}</span>
          <span className="ofs-chat-examples-rule" aria-hidden="true" />
        </div>
        <div className="ofs-chat-examples">
          {INSPIRE_KEYS.map((key, index) => {
            const poster = INSPIRE_POSTERS[key]
            const label = t(`${key}.label`)
            const prompt = t(key)
            return (
              <button
                type="button"
                key={key}
                className={index === 0 ? 'ofs-chat-example is-featured' : 'ofs-chat-example'}
                onClick={() => onPickPrompt(prompt)}
                disabled={locked}
                title={prompt}
              >
                {poster ? (
                  <img
                    className="ofs-chat-example-poster"
                    src={poster}
                    alt=""
                    loading="lazy"
                    draggable={false}
                  />
                ) : null}
                <span className="ofs-chat-example-scrim" aria-hidden="true" />
                <span className="ofs-chat-example-label">{label}</span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
