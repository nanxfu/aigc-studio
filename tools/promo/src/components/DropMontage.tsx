import React from 'react';
import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { FONT_STACK } from './KineticHook';

const BEAT_SHOTS = [
  {
    src: 'showcase/flux2-klein-4b-kyoto-poster.webp',
    model: 'FLUX.2 Klein 4B',
    title: '京都旅行海报',
    time: '6.8s',
    frames: 30,
    pos: '50% 45%',
  },
  {
    src: 'showcase/sdxl-lightning-cyberpunk-street.webp',
    model: 'SDXL Lightning',
    title: '雨夜霓虹街景',
    time: '9.8s',
    frames: 15,
    pos: '50% 50%',
  },
  {
    src: 'showcase/anima-turbo-v1.1-seaside-station.webp',
    model: 'Anima Turbo v1.1',
    title: '黄昏海边站台',
    time: '9.8s',
    frames: 15,
    pos: '50% 8%',
  },
  {
    src: 'showcase/z-image-turbo-alley-bookstore.webp',
    model: 'Z-Image Turbo',
    title: '雨巷旧书店',
    time: '29.2s',
    frames: 15,
    pos: '50% 32%',
  },
  {
    src: 'showcase/qwen-image-2.1-botanica-poster.webp',
    model: 'Qwen-Image 2.1',
    title: '温室植物志海报',
    time: '39.2s',
    frames: 15,
    pos: '50% 4%',
  },
];

const GRID_FOUR = [
  { src: 'showcase/flux2-klein-9b-clockmaker-bench.webp', label: '商业静物 · FLUX.2 9B', pos: '50% 50%', corner: { left: 20, top: 18 } },
  { src: 'showcase/anima-turbo-v1.1-seaside-station.webp', label: '二次元 · Anima Turbo', pos: '50% 8%', corner: { right: 20, top: 18 } },
  { src: 'showcase/sana-sprint-1.6b-crane-pond.webp', label: '水墨国风 · SANA 4.1s', pos: '50% 45%', corner: { left: 20, bottom: 18 } },
  { src: 'showcase/z-image-turbo-alley-bookstore.webp', label: '街景光影 · Z-Image', pos: '50% 42%', corner: { right: 20, bottom: 18 } },
];

export const DropMontage: React.FC<{ resultFrames: number }> = ({ resultFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Phase A (0 .. resultFrames): 落舞台瞬间 + "6.8s · 费用 ¥0"
  if (frame < resultFrames) {
    const idx = Math.min(resultFrames, Math.max(1, frame + 1));
    const flash = interpolate(frame, [0, 8], [0.92, 0], { extrapolateRight: 'clamp' });
    const badgeSpring = spring({ frame: frame - 3, fps, config: { damping: 14, stiffness: 220 } });

    return (
      <AbsoluteFill
        style={{
          backgroundColor: '#0c0d12',
          fontFamily: FONT_STACK,
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        <div
          style={{
            width: 1440,
            height: 900,
            transform: `scale(${interpolate(frame, [0, resultFrames], [0.95, 0.98])})`,
            borderRadius: 18,
            overflow: 'hidden',
            boxShadow: '0 32px 96px rgba(0,0,0,0.65)',
          }}
        >
          <Img
            src={staticFile(`frames/result/${String(idx).padStart(4, '0')}.jpg`)}
            style={{ width: 1440, height: 900, display: 'block', objectFit: 'cover' }}
          />
        </div>

        {/* 右下角醒目数据标签 */}
        <div
          style={{
            position: 'absolute',
            right: 96,
            bottom: 72,
            display: 'flex',
            alignItems: 'center',
            gap: 18,
            padding: '18px 32px',
            borderRadius: 18,
            background: 'rgba(12, 13, 18, 0.88)',
            border: '1px solid rgba(255,255,255,0.16)',
            boxShadow: '0 24px 60px rgba(0,0,0,0.45)',
            backdropFilter: 'blur(12px)',
            transform: `scale(${interpolate(badgeSpring, [0, 1], [0.85, 1])})`,
            opacity: badgeSpring,
          }}
        >
          <span style={{ fontSize: 32, fontWeight: 700, color: '#ffffff' }}>出图完成</span>
          <span
            style={{
              padding: '6px 16px',
              borderRadius: 10,
              background: '#10b981',
              color: '#ffffff',
              fontSize: 32,
              fontWeight: 900,
            }}
          >
            费用 ¥0
          </span>
        </div>

        {flash > 0 ? (
          <AbsoluteFill style={{ backgroundColor: '#ffffff', opacity: flash, pointerEvents: 'none' }} />
        ) : null}
      </AbsoluteFill>
    );
  }

  // Phase B: Beat-synced single artwork cuts (90 frames = 6 beats = 3.0s)
  const bFrame = frame - resultFrames;
  let cursor = 0;
  for (const shot of BEAT_SHOTS) {
    if (bFrame < cursor + shot.frames) {
      const f = bFrame - cursor;
      const kenBurns = interpolate(f, [0, shot.frames], [1.03, 1.1], {
        extrapolateRight: 'clamp',
        easing: Easing.out(Easing.quad),
      });
      return (
        <AbsoluteFill style={{ backgroundColor: '#090a0d', fontFamily: FONT_STACK }}>
          <AbsoluteFill style={{ overflow: 'hidden' }}>
            <Img
              src={staticFile(shot.src)}
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                objectPosition: shot.pos,
                transform: `scale(${kenBurns})`,
              }}
            />
            <AbsoluteFill
              style={{
                background: 'linear-gradient(180deg, rgba(0,0,0,0) 58%, rgba(9,10,13,0.82) 100%)',
              }}
            />
          </AbsoluteFill>

          <div
            style={{
              position: 'absolute',
              left: 72,
              right: 72,
              bottom: 58,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-end',
            }}
          >
            <div>
              <div style={{ fontSize: 24, fontWeight: 600, color: 'rgba(255,255,255,0.72)' }}>
                {shot.model}
              </div>
              <div style={{ fontSize: 54, fontWeight: 800, color: '#ffffff', marginTop: 4 }}>
                {shot.title}
              </div>
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                padding: '12px 24px',
                borderRadius: 14,
                background: 'rgba(16, 185, 129, 0.94)',
                color: '#ffffff',
                fontSize: 32,
                fontWeight: 800,
              }}
            >
              <span>{shot.time}</span>
              <span>·</span>
              <span>¥0</span>
            </div>
          </div>
        </AbsoluteFill>
      );
    }
    cursor += shot.frames;
  }

  // Phase C: 4-split grid finale of montage (remaining 45 frames = 1.5s)
  const gridFrame = bFrame - cursor;
  const gridSpring = spring({ frame: gridFrame, fps, config: { damping: 16, stiffness: 180 } });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: '#090a0d',
        fontFamily: FONT_STACK,
        padding: 28,
      }}
    >
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gridTemplateRows: '1fr 1fr',
          gap: 18,
        }}
      >
        {GRID_FOUR.map((item) => (
          <div
            key={item.src}
            style={{
              position: 'relative',
              borderRadius: 16,
              overflow: 'hidden',
              border: '1px solid rgba(255,255,255,0.12)',
            }}
          >
            <Img
              src={staticFile(item.src)}
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                objectPosition: item.pos,
                transform: `scale(${interpolate(gridFrame, [0, 45], [1.02, 1.08])})`,
              }}
            />
            <span
              style={{
                position: 'absolute',
                ...item.corner,
                padding: '6px 14px',
                borderRadius: 8,
                background: 'rgba(9,10,13,0.78)',
                color: '#ffffff',
                fontSize: 22,
                fontWeight: 600,
              }}
            >
              {item.label}
            </span>
          </div>
        ))}
      </div>

      {/* 中央悬浮标语 */}
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          transform: `translate(-50%, -50%) scale(${interpolate(gridSpring, [0, 1], [0.85, 1])})`,
          padding: '22px 44px',
          borderRadius: 20,
          background: 'rgba(9, 10, 13, 0.9)',
          border: '1px solid rgba(255,255,255,0.2)',
          boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
          color: '#ffffff',
          fontSize: 44,
          fontWeight: 800,
          whiteSpace: 'nowrap',
        }}
      >
        7 款开源模型 · 全程 <span style={{ color: '#10b981' }}>¥0</span>
      </div>
    </AbsoluteFill>
  );
};
