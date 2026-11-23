/**
 * 工坊工具引导卡的「处理前 → 处理后」示意图（M4.2c）。
 *
 * 刻意用内联 SVG 而不是位图：零额外请求、零运行时推理成本、天然跟随深浅色主题
 * （颜色全部走 `workshop.css` 里定义的类，不在这里硬编码色值）。
 *
 * 六张图只解释「这个工具到底改变了什么」，不做美术级还原：
 *  - pixel-snap：歪斜的半像素伪格子 → 对齐到整格；
 *  - sprite-slice：多格大图 → 单帧放大 + 切分线；
 *  - tile：可见的接缝断层 → 混边后的连续过渡；
 *  - vectorize：锯齿边 → 平滑曲线；
 *  - cutout：白底主体 → 透明底主体；
 *  - pbr：单张材质 → 反照率 / 法线 / 粗糙度 / 金属度四通道。
 *
 * 装饰性图形，统一 `aria-hidden`：语义说明由引导卡的正文承担。
 */

import React from 'react'

const VIEW = { width: 128, height: 56 }

/** 外框：把每张子图圈在圆角底板里，避免图形在卡片里显得散。 */
function Plate(props) {
  return (
    <rect
      className={props.className || 'ofs-ws-sample-plate'}
      x={props.x}
      y={props.y}
      width={props.width}
      height={props.height}
      rx="5"
    />
  )
}

/** 中间的箭头：用折线画，保证 `stroke` 跟随文字色。 */
function Arrow(props) {
  const x = props.x
  return (
    <g className="ofs-ws-sample-arrow">
      <path d={`M${x} 28h10`} />
      <path d={`M${x + 5.6} 23.6  ${x + 10} 28  ${x + 5.6} 32.4`} />
    </g>
  )
}

/** 像素对齐：左侧格子每行错开 1.5px，右侧严格对齐。 */
function PixelSnapSample() {
  const sizes = 9
  const cells = 4
  const before = []
  const after = []
  for (let row = 0; row < cells; row += 1) {
    for (let column = 0; column < cells; column += 1) {
      const shade = (row + column) % 2 === 0
      const jitter = row % 2 === 0 ? 1.6 : -1.2
      before.push(
        <rect
          key={`b-${row}-${column}`}
          className={shade ? 'ofs-ws-sample-cell is-dark' : 'ofs-ws-sample-cell'}
          x={8 + column * (sizes + 1) + jitter}
          y={8 + row * (sizes + 1) + 1.1}
          width={sizes}
          height={sizes}
          rx="0.8"
        />,
      )
      after.push(
        <rect
          key={`a-${row}-${column}`}
          className={shade ? 'ofs-ws-sample-cell is-dark' : 'ofs-ws-sample-cell'}
          x={74 + column * (sizes + 1)}
          y={8 + row * (sizes + 1)}
          width={sizes}
          height={sizes}
          rx="0"
        />,
      )
    }
  }
  return (
    <g>
      <Plate x="2" y="4" width={48} height={48} />
      {before}
      <Arrow x={56} />
      <Plate x="70" y="4" width={48} height={48} />
      {after}
      <path className="ofs-ws-sample-grid" d="M70 13h48M70 23h48M70 33h48M70 43h48M79 4v48M89 4v48M99 4v48M109 4v48" />
    </g>
  )
}

/** 序列帧切片：左侧 4 格大图，右侧单帧放大 + 其余淡出并加切分线。 */
function SpriteSliceSample() {
  return (
    <g>
      <Plate x="2" y="4" width={48} height={48} />
      {[0, 1, 2, 3].map((index) => (
        <rect
          key={`sheet-${index}`}
          className="ofs-ws-sample-cell"
          x={6 + index * 11}
          y="14"
          width="9"
          height="28"
          rx="1"
        />
      ))}
      <path className="ofs-ws-sample-guide" d="M17.5 6v44M28.5 6v44M39.5 6v44" />
      <Arrow x={56} />
      <Plate x="70" y="4" width={48} height={48} />
      <rect className="ofs-ws-sample-cell is-accent" x="74" y="12" width="18" height="32" rx="1.5" />
      {[0, 1, 2].map((index) => (
        <rect
          key={`frame-${index}`}
          className="ofs-ws-sample-cell is-dim"
          x={96 + index * 0}
          y={12 + index * 12}
          width="18"
          height="9"
          rx="1"
        />
      ))}
    </g>
  )
}

/** 无缝平铺：左侧接缝处有明显色差断层，右侧用渐变坡过渡掉。 */
function TileSample() {
  return (
    <g>
      <Plate x="2" y="4" width={48} height={48} />
      <rect className="ofs-ws-sample-cell is-mid" x="4" y="6" width="22" height="44" />
      <rect className="ofs-ws-sample-cell is-light" x="26" y="6" width="22" height="44" />
      <path className="ofs-ws-sample-seam" d="M26 6v44" />
      <Arrow x={56} />
      <Plate x="70" y="4" width={48} height={48} />
      <defs>
        <linearGradient id="ofs-ws-blend" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" className="ofs-ws-sample-stop-mid" />
          <stop offset="100%" className="ofs-ws-sample-stop-light" />
        </linearGradient>
      </defs>
      <rect className="ofs-ws-sample-cell is-mid" x="72" y="6" width="20" height="44" />
      <rect x="92" y="6" width="4" height="44" fill="url(#ofs-ws-blend)" />
      <rect className="ofs-ws-sample-cell is-light" x="96" y="6" width="20" height="44" />
      <path className="ofs-ws-sample-guide" d="M94 6v44" />
    </g>
  )
}

/** 矢量化：左侧锯齿阶梯，右侧平滑曲线。 */
function VectorSample() {
  return (
    <g>
      <Plate x="2" y="4" width={48} height={48} />
      <path
        className="ofs-ws-sample-cell is-dark"
        d="M10 42h8V34h8V26h8V18h8V10h-8v8h-8v8h-8v8h-8z"
      />
      <Arrow x={56} />
      <Plate x="70" y="4" width={48} height={48} />
      <path className="ofs-ws-sample-curve" d="M76 42c16 0 16-32 34-32" />
      <circle className="ofs-ws-sample-knot" cx="76" cy="42" r="2.2" />
      <circle className="ofs-ws-sample-knot" cx="110" cy="10" r="2.2" />
    </g>
  )
}

/** 抠图：左侧白底主体，右侧棋盘格（透明）主体。 */
function CutoutSample() {
  return (
    <g>
      <Plate x="2" y="4" width={48} height={48} />
      <ellipse className="ofs-ws-sample-subject" cx="26" cy="28" rx="13" ry="16" />
      <Arrow x={56} />
      <Plate x="70" y="4" width={48} height={48} />
      <path
        className="ofs-ws-sample-checker"
        d="M74 8h8v8h-8zM90 8h8v8h-8zM82 16h8v8h-8zM98 16h8v8h-8zM74 24h8v8h-8zM90 24h8v8h-8zM82 32h8v8h-8zM98 32h8v8h-8zM74 40h8v8h-8zM90 40h8v8h-8z"
      />
      {/* 先垫一层实心底色：棋盘格不能从半透明主体里透出来，否则主体看着像马赛克。 */}
      <ellipse className="ofs-ws-sample-subject-backing" cx="94" cy="28" rx="13" ry="16" />
      <ellipse className="ofs-ws-sample-subject" cx="94" cy="28" rx="13" ry="16" />
    </g>
  )
}

/** PBR 拆解：左侧单张材质，右侧四通道小图。 */
function PbrSample() {
  const roles = ['albedo', 'normal', 'roughness', 'metallic']
  return (
    <g>
      <Plate x="2" y="4" width={48} height={48} />
      <rect className="ofs-ws-sample-cell is-mid" x="8" y="12" width="36" height="32" rx="2" />
      <path className="ofs-ws-sample-guide" d="M8 22h36M8 32h36M20 12v32M32 12v32" />
      <Arrow x={56} />
      <Plate x="70" y="4" width={48} height={48} />
      {roles.map((role, index) => (
        <rect
          key={role}
          className={`ofs-ws-sample-channel is-${role}`}
          x={74 + (index % 2) * 21}
          y={7 + Math.floor(index / 2) * 21}
          width="18"
          height="18"
          rx="2"
        />
      ))}
    </g>
  )
}

const SAMPLES = {
  'pixel-snap': PixelSnapSample,
  'sprite-slice': SpriteSliceSample,
  tile: TileSample,
  vectorize: VectorSample,
  cutout: CutoutSample,
  pbr: PbrSample,
}

/**
 * 渲染一个工具的处理前 / 处理后示意图。
 *
 * @param {{ tool: string, title?: string }} props `tool` 不在白名单内时返回 null（不渲染空框）
 */
export function WorkshopSample(props) {
  const Sample = SAMPLES[props.tool]
  if (!Sample) return null
  return (
    <svg
      className="ofs-ws-sample"
      viewBox={`0 0 ${VIEW.width} ${VIEW.height}`}
      aria-hidden="true"
      focusable="false"
    >
      <Sample />
    </svg>
  )
}

/** 引导卡是否具备某个工具的示意图（供测试与外部判断）。 */
export function hasWorkshopSample(tool) {
  return Boolean(SAMPLES[tool])
}

