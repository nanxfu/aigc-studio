/** Compact workshop examples. */
import React from 'react'
import source from './examples/shield-source.webp'
import cutout from './examples/shield-cutout.webp'
import albedo from './examples/shield-albedo.webp'
import normal from './examples/shield-normal.webp'
import roughness from './examples/shield-roughness.webp'
import metallic from './examples/shield-metallic.webp'
import pixelBefore from './examples/pixel-before.webp'
import pixelAfter from './examples/pixel-after.webp'
import spriteSheet from './examples/sprite-sheet.webp'
import sprite0 from './examples/sprite-0.webp'
import sprite1 from './examples/sprite-1.webp'
import sprite2 from './examples/sprite-2.webp'
import sprite3 from './examples/sprite-3.webp'
import vectorBefore from './examples/vector-before.webp'
import vectorAfter from './examples/vector-after.svg'
import tileBefore from './examples/tile-seamed.svg'
import tileAfter from './examples/tile-seamless.svg'

const SAMPLES = {
  cutout: { before: source, after: cutout, checker: true },
  pbr: { before: source, channels: [albedo, normal, roughness, metallic] },
  'pixel-snap': { before: pixelBefore, after: pixelAfter, pixelated: true },
  'sprite-slice': { before: spriteSheet, frames: [sprite0, sprite1, sprite2, sprite3], pixelated: true },
  vectorize: { before: vectorBefore, after: vectorAfter },
  tile: { before: tileBefore, after: tileAfter },
}

const ROLES = ['albedo', 'normal', 'roughness', 'metallic']

function SampleImage({ src }) {
  return <img src={src} alt="" draggable={false} loading="lazy" decoding="async" />
}

export function WorkshopSample({ tool, t }) {
  const sample = SAMPLES[tool]
  if (!sample) return null
  return (
    <div className="ofs-ws-sample" data-tool={tool} aria-hidden="true">
      <div className={`ofs-ws-example-image${sample.pixelated || tool === 'vectorize' ? ' is-pixelated' : ''}${sample.frames ? ' is-sheet' : ''}`}>
        <SampleImage src={sample.before} />
      </div>
      <svg className="ofs-ws-sample-arrow" viewBox="0 0 24 24" focusable="false">
        <path d="M4 12h16" />
        <path d="m14 6 6 6-6 6" />
      </svg>
      {sample.channels ? (
        <div className="ofs-ws-example-channels">
          {sample.channels.map((src, index) => (
            <div className="ofs-ws-example-channel" key={src}>
              <SampleImage src={src} />
              <span>{t(`studio.workshop.channel.${ROLES[index]}`)}</span>
            </div>
          ))}
        </div>
      ) : sample.frames ? (
        <div className="ofs-ws-example-frames">
          {sample.frames.map(src => (
            <div className="ofs-ws-example-image is-pixelated" key={src}><SampleImage src={src} /></div>
          ))}
        </div>
      ) : (
        <div className={`ofs-ws-example-image${sample.checker ? ' is-checker' : ''}${sample.pixelated ? ' is-pixelated' : ''}`}>
          <SampleImage src={sample.after} />
        </div>
      )}
    </div>
  )
}

export function hasWorkshopSample(tool) {
  return Boolean(SAMPLES[tool])
}
