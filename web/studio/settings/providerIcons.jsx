/**
 * 11 家 LLM 服务商的单色矢量品牌图标（18×18 视口）。
 *
 * 遵循黑白灰工作室设计立场：全部使用 `currentColor` 矢量路径与适度透明层，
 * 在浅色与深色主题下保持一致的锐利度与克制感，不引入外部图片或彩色糖果块。
 */

import React from 'react'

const PROVIDER_SHAPES = {
  deepseek: (
    <>
      <path d="M3.5 11.2c1.6-3.7 4.7-5.7 8.1-5.7 2.4 0 4.2.9 5.4 2.5-1.1.3-1.9.8-2.4 1.6 1.2.4 2.1 1.2 2.4 2.4-1.7 1.9-4.1 2.9-7.1 2.9-3.1 0-5.4-1.3-6.4-3.7z" />
      <circle cx="11.6" cy="9.2" r="1" fill="currentColor" stroke="none" />
      <path d="M2.6 13.8c1.5.9 3.6 1.4 6.2 1.4" />
    </>
  ),
  moonshot: (
    <>
      <path d="M13.8 4.4a6.8 6.8 0 1 0 3.7 10.1A5.4 5.4 0 0 1 13.8 4.4z" />
      <circle cx="15.2" cy="6.2" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
  qwen: (
    <>
      <path d="M10 2.8 16.2 6.4v7.2L10 17.2 3.8 13.6V6.4z" />
      <path d="M10 6.2 13.3 8.1v3.8L10 13.8 6.7 11.9V8.1z" />
    </>
  ),
  siliconflow: (
    <>
      <path d="M3.8 7.5 10 4l6.2 3.5L10 11z" />
      <path d="M3.8 11.2 10 14.7l6.2-3.5" />
      <path d="M5.6 14.4 10 16.9l4.4-2.5" />
    </>
  ),
  opencode: (
    <>
      <rect x="2.8" y="4" width="14.4" height="12" rx="2.6" />
      <path d="M6.4 8.2 9 10l-2.6 1.8" />
      <path d="M10.4 12.2h3.2" />
    </>
  ),
  openrouter: (
    <>
      <circle cx="4.8" cy="10" r="1.8" />
      <circle cx="15.2" cy="5.4" r="1.8" />
      <circle cx="15.2" cy="14.6" r="1.8" />
      <path d="M6.6 10h2.4c1.6 0 2.1-4.6 4.4-4.6" />
      <path d="M9 10c1.6 0 2.1 4.6 4.4 4.6" />
    </>
  ),
  gemini: (
    <path d="M10 2.4c.5 4.2 3.4 7.1 7.6 7.6-4.2.5-7.1 3.4-7.6 7.6-.5-4.2-3.4-7.1-7.6-7.6 4.2-.5 7.1-3.4 7.6-7.6z" />
  ),
  openai: (
    <>
      <circle cx="10" cy="10" r="2.1" />
      <path d="M10 3.2v2.4M10 14.4v2.4M4.1 6.6l2.1 1.2M13.8 12.2l2.1 1.2M15.9 6.6l-2.1 1.2M6.2 12.2l-2.1 1.2" />
      <circle cx="10" cy="10" r="6.6" strokeDasharray="3.2 2.4" />
    </>
  ),
  anthropic: (
    <>
      <path d="M7.6 15.2 11.4 4.8h1.8l3.8 10.4" />
      <path d="M8.8 11.8h6.4" />
      <path d="M3.2 15.2 7 4.8h1.8" />
    </>
  ),
  ollama: (
    <>
      <path d="M6.8 6.4V3.8l2 1.8h2.4l2-1.8v2.6a4.4 4.4 0 0 1 1.4 3.2v3.6a3 3 0 0 1-3 3H8.4a3 3 0 0 1-3-3V9.6a4.4 4.4 0 0 1 1.4-3.2z" />
      <circle cx="8.4" cy="10.2" r=".8" fill="currentColor" stroke="none" />
      <circle cx="11.6" cy="10.2" r=".8" fill="currentColor" stroke="none" />
      <path d="M9.2 12.6h1.6" />
    </>
  ),
  custom: (
    <>
      <path d="M7.4 6.8h5.2v3.4a2.6 2.6 0 0 1-5.2 0z" />
      <path d="M8.6 4v2.8M11.4 4v2.8M10 12.8v3.4" />
    </>
  ),
}

export function ProviderIcon({ id, size = 16, className = '' }) {
  const shape = PROVIDER_SHAPES[id] || PROVIDER_SHAPES.custom
  return (
    <svg
      className={className ? `ofs-provider-icon ${className}` : 'ofs-provider-icon'}
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {shape}
    </svg>
  )
}
