/**
 * 工坊工具引导卡的「处理前 → 处理后」示意图（M4.2c）。
 *
 * 刻意用内联 SVG 而不是位图：零额外请求、零运行时推理成本、天然跟随深浅色主题
 * （颜色全部走 `workshop.css` 里定义的类，不在这里硬编码色值）。
 *
 * 六张图保持相同的比例和视觉语言，说明工具改变了什么：
 *  - pixel-snap：歪斜的半像素伪格子 → 对齐到整格；
 *  - sprite-slice：多格大图 → 独立的四张序列帧；
 *  - tile：接缝处错位的纹理 → 连续纹理；
 *  - vectorize：锯齿边 → 平滑曲线；
 *  - cutout：带背景的几何标志 → 透明底标志；
 *  - pbr：单张材质 → 反照率 / 法线 / 粗糙度 / 金属度四通道。
 *
 * 装饰性图形，统一 `aria-hidden`：语义说明由引导卡的正文承担。
 */

import React from 'react'

const VIEW = { width: 120, height: 56 }

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

/** 序列帧切片：同一张图集里的四帧，切分后各自保留完整画面。 */
function SpriteSliceSample() {
  return (
    <g>
      <Plate x="2" y="4" width={48} height={48} />
      {[0, 1, 2, 3].map((index) => (
        <g key={`sheet-${index}`} transform={`translate(${6 + (index % 2) * 23} ${8 + Math.floor(index / 2) * 23})`}>
          <path className="ofs-ws-sample-subject" d={`M4 ${7 - index}h4v-3h4v3h3v8H4z`} />
          <rect className="ofs-ws-sample-subject-detail" x="10" y="8" width="2" height="2" />
        </g>
      ))}
      <path className="ofs-ws-sample-guide" d="M26 5v46M3 28h46" />
      <Arrow x={56} />
      {[0, 1, 2, 3].map((index) => (
        <g key={`frame-${index}`} transform={`translate(${70 + (index % 2) * 26} ${4 + Math.floor(index / 2) * 26})`}>
          <Plate x="0" y="0" width={22} height={22} />
          <path className="ofs-ws-sample-subject" d={`M4 ${9 - index}h4v-3h4v3h3v8H4z`} />
          <rect className="ofs-ws-sample-subject-detail" x="10" y="10" width="2" height="2" />
        </g>
      ))}
    </g>
  )
}

/** 无缝平铺：两片纹理在边缘错位，处理后接成连续的波纹。 */
function TileSample() {
  const id = React.useId()
  const beforeClip = `${id}-before`
  const afterClip = `${id}-after`
  const waves = (x, offset) => [0, 1, 2, 3, 4, 5].map((row) => (
    <path
      key={row}
      className="ofs-ws-sample-texture"
      d={`M${x} ${row * 11 + offset}q6-7 12 0t12 0`}
    />
  ))
  return (
    <g>
      <defs>
        <clipPath id={beforeClip}><rect x="3" y="5" width="46" height="46" rx="4" /></clipPath>
        <clipPath id={afterClip}><rect x="71" y="5" width="46" height="46" rx="4" /></clipPath>
      </defs>
      <Plate x="2" y="4" width={48} height={48} />
      <g clipPath={`url(#${beforeClip})`}>
        {waves(2, 6)}
        {waves(26, 11)}
        <path className="ofs-ws-sample-seam" d="M26 5v46" />
      </g>
      <Arrow x={56} />
      <Plate x="70" y="4" width={48} height={48} />
      <g clipPath={`url(#${afterClip})`}>
        {waves(70, 6)}
        {waves(94, 6)}
      </g>
    </g>
  )
}

/** 矢量化：同一条轮廓从像素阶梯变成可编辑的平滑曲线。 */
function VectorSample() {
  return (
    <g>
      <Plate x="2" y="4" width={48} height={48} />
      <path
        className="ofs-ws-sample-cell is-dark"
        d="M10 42h7V35h7V28h7V21h7V14h-5v7h-7v7h-7v7h-9z"
      />
      <Arrow x={56} />
      <Plate x="70" y="4" width={48} height={48} />
      <path className="ofs-ws-sample-guide" d="M79 42V14h28" />
      <path className="ofs-ws-sample-curve" d="M79 42c16 0 12-28 28-28" />
      <rect className="ofs-ws-sample-knot" x="77.5" y="40.5" width="3" height="3" rx="0.4" />
      <rect className="ofs-ws-sample-knot" x="105.5" y="12.5" width="3" height="3" rx="0.4" />
    </g>
  )
}

/** 抠图：完整棋盘格表达透明区域，实心标志在处理前后保持一致。 */
function CutoutSample() {
  const id = React.useId()
  const checkerId = `${id}-checker`
  const clipId = `${id}-clip`
  const mark = 'M26 11l5 12 12 5-12 5-5 12-5-12-12-5 12-5z'
  return (
    <g>
      <defs>
        <pattern id={checkerId} width="8" height="8" patternUnits="userSpaceOnUse">
          <rect className="ofs-ws-sample-subject-detail" width="8" height="8" />
          <path className="ofs-ws-sample-checker" d="M0 0h4v4H0zM4 4h4v4H4z" />
        </pattern>
        <clipPath id={clipId}>
          <rect x="70" y="4" width="48" height="48" rx="5" />
        </clipPath>
      </defs>
      <Plate x="2" y="4" width={48} height={48} />
      <path className="ofs-ws-sample-subject" d={mark} />
      <path className="ofs-ws-sample-subject-detail" d="M26 24l4 4-4 4-4-4z" />
      <Arrow x={56} />
      <rect x="70" y="4" width="48" height="48" fill={`url(#${checkerId})`} clipPath={`url(#${clipId})`} />
      <g transform="translate(68 0)">
        <path className="ofs-ws-sample-subject" d={mark} />
        <path className="ofs-ws-sample-subject-detail" d="M26 24l4 4-4 4-4-4z" />
      </g>
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

