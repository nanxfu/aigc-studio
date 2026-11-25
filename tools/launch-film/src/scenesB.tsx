import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import {
  ART,
  BENCH,
  Backdrop,
  BlurredBackdrop,
  BrandIcon,
  C,
  CLIP,
  Checkerboard,
  FONT,
  GridField,
  Image,
  MONO,
  NINE_DIM,
  ReticleBrackets,
  SheenSweep,
  TEXTURES,
  TopTagBar,
  WORKSHOP_ART,
  backOut,
  clamp,
  inQuad,
  mix,
  outCubic,
  outQuint,
  ramp,
} from './visuals';
import type { SceneProps } from './scenesA';

/** 06 · comic-panel-split + scanline-annotate-focus (Game Dev Assets & PBR) */
export const WorkshopGameScene: React.FC<SceneProps> = () => {
  const f = useCurrentFrame(); // 176f
  const { fps } = useVideoConfig();

  // Phase A (0..82): 3 diagonal comic panels slamming in
  // Phase B (82..176): PBR 4-channel deck + scanline-annotate-focus
  const expandPbr = ramp(f, 76, 18, outQuint);

  const p1In = ramp(f, 0, 12, outQuint);
  const p2In = ramp(f, 12, 12, outQuint);
  const p3In = ramp(f, 24, 12, outQuint);

  // Pixel snap toggle in Panel 1 & Sprite frame in Panel 2
  const pixelSnapped = f >= 32;
  const spriteIdx = Math.floor(f / 6) % 4;

  // Scanline y sweep across PBR row in Phase B (f=94..152)
  const scanP = ramp(f, 92, 54, outCubic);
  const scanX = mix(40, 1880, scanP);
  const pbrMaps = [
    { key: '01/04', name: 'ALBEDO', label: '基础反照率', src: WORKSHOP_ART.albedo, trigger: 0.12 },
    { key: '02/04', name: 'NORMAL', label: '法线凹凸贴图', src: WORKSHOP_ART.normal, trigger: 0.34 },
    { key: '03/04', name: 'ROUGHNESS', label: '粗糙度通道', src: WORKSHOP_ART.roughness, trigger: 0.56 },
    { key: '04/04', name: 'METALLIC', label: '金属度通道', src: WORKSHOP_ART.metallic, trigger: 0.78 },
  ];
  const lockedCount = pbrMaps.filter((m) => scanP >= m.trigger).length;

  return (
    <Backdrop bg={expandPbr > 0.5 ? C.ink : C.paper}>
      <GridField dark={expandPbr > 0.5} opacity={0.06} />
      <TopTagBar dark={expandPbr > 0.5} section="04 / 游戏与材质资产" tag="游戏资产从出图到导出" />

      <div style={{ position: 'absolute', left: 72, top: 88, zIndex: 25, opacity: ramp(f, 0, 10) }}>
        <div
          style={{
            fontSize: 60,
            fontWeight: 840,
            letterSpacing: -2,
            color: expandPbr > 0.5 ? C.paper : C.ink,
          }}
        >
          游戏资产从出图到导出，一套工具
        </div>
        <div style={{ marginTop: 6, fontSize: 27, color: expandPbr > 0.5 ? C.gray : C.secondary }}>
          像素对齐、序列帧切片、PBR 四通道拆解
        </div>
      </div>

      {/* Phase A: Diagonal 3-Slash Comic Panels */}
      {expandPbr < 0.99 && (
        <div
          style={{
            position: 'absolute',
            left: 72,
            right: 72,
            top: 235,
            bottom: 58,
            opacity: 1 - expandPbr,
          }}
        >
          {/* Slash 1: Pixel Art Snap */}
          <div
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: 670,
              height: '100%',
              clipPath: 'polygon(0 0, 100% 0, 78% 100%, 0 100%)',
              background: '#1c1c22',
              transform: `translateY(${mix(160, 0, p1In)}px)`,
              opacity: p1In,
              overflow: 'hidden',
            }}
          >
            <div style={{ position: 'absolute', left: 56, top: 96, width: 420, height: 420, borderRadius: 16, overflow: 'hidden', border: `2px solid ${pixelSnapped ? C.mint : C.accent}` }}>
              <Image
                src={pixelSnapped ? WORKSHOP_ART.pixelAfter : WORKSHOP_ART.pixelBefore}
                style={{ width: '100%', height: '100%', objectFit: 'contain', imageRendering: 'pixelated' }}
              />
            </div>
            <div style={{ position: 'absolute', left: 48, bottom: 44, right: 160 }}>
              <div style={{ fontFamily: MONO, fontSize: 18, color: pixelSnapped ? C.mint : C.accent }}>
                {pixelSnapped ? 'PIXEL SNAPPED // OKLAB' : 'RAW AI PIXEL'}
              </div>
              <div style={{ marginTop: 6, fontSize: 34, fontWeight: 800, color: '#fff' }}>像素网格对齐</div>
              <div style={{ marginTop: 4, fontSize: 21, color: '#a8a8b4' }}>消除斜边虚影与杂色</div>
            </div>
          </div>

          {/* Slash 2: Sprite Sheet + Live Frame Playback */}
          <div
            style={{
              position: 'absolute',
              left: 530,
              top: 0,
              width: 720,
              height: '100%',
              clipPath: 'polygon(20% 0, 100% 0, 80% 100%, 0 100%)',
              background: '#ffffff',
              border: '1px solid #d4d4dc',
              transform: `translateY(${mix(-160, 0, p2In)}px)`,
              opacity: p2In,
              overflow: 'hidden',
            }}
          >
            <div style={{ position: 'absolute', left: 165, top: 76, width: 340, height: 340, display: 'grid', placeItems: 'center' }}>
              <Checkerboard size={22} />
              <Image
                src={WORKSHOP_ART.spriteFrames[spriteIdx]}
                style={{ position: 'relative', width: 280, height: 280, objectFit: 'contain', imageRendering: 'pixelated' }}
              />
            </div>
            <div style={{ position: 'absolute', left: 155, top: 434, display: 'flex', gap: 10 }}>
              {WORKSHOP_ART.spriteFrames.map((s, idx) => (
                <div
                  key={s}
                  style={{
                    width: 68,
                    height: 68,
                    borderRadius: 8,
                    overflow: 'hidden',
                    border: `2.5px solid ${idx === spriteIdx ? C.accent : '#d6d6de'}`,
                    background: '#f5f5f6',
                  }}
                >
                  <Image src={s} style={{ width: '100%', height: '100%', objectFit: 'contain', imageRendering: 'pixelated' }} />
                </div>
              ))}
            </div>
            <div style={{ position: 'absolute', left: 145, bottom: 44 }}>
              <div style={{ fontFamily: MONO, fontSize: 18, color: C.accent }}>FRAME 0{spriteIdx + 1}/04 · ATLAS.JSON</div>
              <div style={{ marginTop: 6, fontSize: 34, fontWeight: 800, color: C.ink }}>序列帧切片回放</div>
            </div>
          </div>

          {/* Slash 3: PBR Teaser before eating screen */}
          <div
            style={{
              position: 'absolute',
              right: 0,
              top: 0,
              width: 660,
              height: '100%',
              clipPath: 'polygon(22% 0, 100% 0, 100% 100%, 0 100%)',
              background: C.accent,
              color: '#fff',
              transform: `translateY(${mix(160, 0, p3In)}px)`,
              opacity: p3In,
              overflow: 'hidden',
            }}
          >
            <div style={{ position: 'absolute', left: 170, top: 96, width: 410, height: 410, clipPath: CLIP.chamfer(24), overflow: 'hidden', background: C.ink }}>
              <Image src={WORKSHOP_ART.normal} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            </div>
            <div style={{ position: 'absolute', left: 150, bottom: 44 }}>
              <div style={{ fontFamily: MONO, fontSize: 18, color: '#ffe4df' }}>MARIGOLD // 4 MAPS</div>
              <div style={{ marginTop: 6, fontSize: 34, fontWeight: 800 }}>PBR 四通道拆解</div>
            </div>
          </div>
        </div>
      )}

      {/* Phase B: Full-width PBR 4-Channel Scanline Annotate Focus */}
      {expandPbr > 0.02 && (
        <div
          style={{
            position: 'absolute',
            left: 72,
            right: 72,
            top: 242,
            bottom: 62,
            opacity: expandPbr,
            transform: `scale(${mix(0.92, 1, expandPbr)})`,
          }}
        >
          {/* Machine counter bar */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              paddingBottom: 20,
              borderBottom: '1px solid #2e2e38',
              fontFamily: MONO,
              fontSize: 20,
              color: '#a0a0ac',
            }}
          >
            <span>PBR PIPELINE // MARIGOLD INTRINSICS</span>
            <span style={{ color: lockedCount === 4 ? C.mint : C.accent }}>
              LOCKED {String(lockedCount).padStart(2, '0')}/04 · EXPORT ZIP
            </span>
          </div>

          <div style={{ marginTop: 34, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 28 }}>
            {pbrMaps.map((m, i) => {
              const hitP = spring({
                frame: Math.max(0, f - (92 + Math.round(m.trigger * 54))),
                fps,
                config: { damping: 12, stiffness: 200 },
              });
              const active = scanP >= m.trigger;
              return (
                <div
                  key={m.name}
                  style={{
                    position: 'relative',
                    background: '#1b1b21',
                    border: `1px solid ${active ? '#4a4a58' : '#2b2b34'}`,
                    clipPath: CLIP.chamfer(22),
                    padding: 18,
                    boxSizing: 'border-box',
                  }}
                >
                  <div style={{ position: 'relative', width: '100%', height: 420, overflow: 'hidden', clipPath: CLIP.chamfer(14) }}>
                    <Image src={m.src} style={{ width: '100%', height: '100%', objectFit: 'cover', filter: active ? 'none' : 'brightness(0.45)' }} />
                    {active && <ReticleBrackets progress={hitP} color={i === 1 ? C.cobalt : C.accent} size={28} spread={44} />}
                  </div>
                  <div style={{ marginTop: 18, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <span style={{ fontFamily: MONO, fontSize: 22, fontWeight: 700, color: active ? '#fff' : '#6c6c78' }}>
                      {m.name}
                    </span>
                    <span style={{ fontFamily: MONO, fontSize: 17, color: active ? C.mint : '#585862' }}>
                      {active ? m.key : 'WAIT'}
                    </span>
                  </div>
                  <div style={{ marginTop: 4, fontSize: 22, color: active ? '#b4b4c0' : '#585862' }}>{m.label}</div>
                </div>
              );
            })}
          </div>

          {/* Vertical Laser Scanline sweeping Left -> Right */}
          {f >= 90 && f <= 156 && (
            <div
              style={{
                position: 'absolute',
                left: scanX - 72,
                top: 52,
                bottom: 0,
                width: 4,
                background: '#fff',
                boxShadow: `0 0 28px 6px ${C.accent}`,
                pointerEvents: 'none',
              }}
            />
          )}
        </div>
      )}
    </Backdrop>
  );
};

/** 07 · bezier-source-converge-merge + terminal-3d (Tech Geeks: Compute & MCP) */
export const ComputeGeekScene: React.FC<SceneProps> = () => {
  const f = useCurrentFrame(); // 175f
  const sources = [
    { name: 'Kaggle 2×T4', note: '免费 30h/周', color: C.cobalt },
    { name: 'Google Colab', note: 'T4 / L4 / A100', color: C.mint },
    { name: '商业 API', note: '硅基 / fal / OpenAI', color: C.amber },
    { name: '私有 Worker', note: 'Docker / RunPod', color: '#c084fc' },
    { name: '本机 Vulkan', note: 'GGUF 零 Python', color: C.accent },
  ];
  const nodeY = [0, 126, 252, 378, 504];

  const mergePulse = ramp(f, 64, 16, backOut);
  const termTravel = interpolate(f, [0, 42, 68, 100, 128, 165], [0, 0, 740, 740, 1480, 1480], {
    easing: outCubic,
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const terminals = [
    {
      title: 'mcp/server.mjs',
      tag: 'STDIO · AGENT',
      cmd: 'imagen_generate --model qwen-2.1',
      lines: ['> Claude / Cursor connected', '> shared runtime.json token', '✓ image saved to outputs/'],
    },
    {
      title: 'worker/daemon.py',
      tag: 'GPU · SSE v2',
      cmd: 'switch backend=kaggle',
      lines: ['> 2x Tesla T4 · 30GB VRAM', '> step 8/8 streamed', '✓ idle auto-shutdown armed'],
    },
    {
      title: '127.0.0.1:5130',
      tag: 'LOCAL · SAFE',
      cmd: 'encrypt keys -> safeStorage',
      lines: ['> AES-256-GCM key vault', '> meta.json + channels[]', '✓ assets stay on your disk'],
    },
  ];

  return (
    <Backdrop dark>
      <GridField dark opacity={0.07} />
      <TopTagBar dark section="05 / 算力与极客工作流" tag="算力随时切换" />

      <div style={{ position: 'absolute', left: 72, top: 92, opacity: ramp(f, 4, 12) }}>
        <div style={{ fontSize: 60, fontWeight: 840, letterSpacing: -2 }}>
          Kaggle 每周给 30 小时免费 GPU
        </div>
        <div style={{ marginTop: 8, fontSize: 27, color: C.gray }}>
          够跑 17,000 张，Colab、私有 Worker、本机 Vulkan 随时切
        </div>
      </div>

      {/* Left: bezier-source-converge-merge */}
      <div style={{ position: 'absolute', left: 72, top: 268, width: 830, height: 610 }}>
        <svg width="830" height="610" viewBox="0 0 830 610" style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
          {sources.map((s, i) => {
            const y = nodeY[i] + 44;
            const draw = ramp(f, 10 + i * 5, 24, outCubic);
            const path = `M 276 ${y} C 430 ${y}, 430 296, 560 296`;
            const t = clamp((f - (24 + i * 6)) / 36);
            const q = t * t * (3 - 2 * t);
            const px = (1 - q) ** 3 * 276 + 3 * (1 - q) ** 2 * q * 430 + 3 * (1 - q) * q ** 2 * 430 + q ** 3 * 560;
            const py = (1 - q) ** 3 * y + 3 * (1 - q) ** 2 * q * y + 3 * (1 - q) * q ** 2 * 296 + q ** 3 * 296;
            return (
              <g key={s.name}>
                <path
                  d={path}
                  fill="none"
                  stroke={s.color}
                  strokeWidth="2.5"
                  pathLength="1"
                  strokeDasharray="1"
                  strokeDashoffset={1 - draw}
                  opacity={0.78}
                />
                {t > 0 && t < 1 && <circle cx={px} cy={py} r="7" fill="#fff" stroke={s.color} strokeWidth="3" />}
              </g>
            );
          })}
        </svg>

        {sources.map((s, i) => {
          const pop = ramp(f, 4 + i * 5, 14, backOut);
          return (
            <div
              key={s.name}
              style={{
                position: 'absolute',
                left: 0,
                top: nodeY[i],
                width: 276,
                height: 88,
                background: C.ink2,
                border: `1.5px solid ${s.color}88`,
                clipPath: CLIP.chamfer(16),
                padding: '14px 22px',
                boxSizing: 'border-box',
                opacity: pop,
                transform: `translateX(${mix(-40, 0, pop)}px)`,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ width: 9, height: 9, borderRadius: '50%', background: s.color }} />
                <span style={{ fontSize: 23, fontWeight: 750, color: '#fff' }}>{s.name}</span>
              </div>
              <div style={{ marginTop: 4, fontFamily: MONO, fontSize: 16, color: '#a0a0ae' }}>{s.note}</div>
            </div>
          );
        })}

        {/* Central 127.0.0.1 Control Hub */}
        <div
          style={{
            position: 'absolute',
            left: 560,
            top: 206,
            width: 260,
            height: 180,
            background: '#fff',
            color: C.ink,
            clipPath: CLIP.chamfer(28),
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            transform: `scale(${1 + 0.06 * Math.sin(mergePulse * Math.PI)})`,
            boxShadow: '0 24px 70px rgba(0,0,0,0.65)',
          }}
        >
          <BrandIcon size={40} />
          <div style={{ marginTop: 10, fontSize: 28, fontWeight: 850 }}>AIGC Studio</div>
          <div style={{ marginTop: 4, fontFamily: MONO, fontSize: 16, color: C.accent }}>127.0.0.1 · LOCAL</div>
        </div>
      </div>

      {/* Right: terminal-3d 3-window camera flyover */}
      <div
        style={{
          position: 'absolute',
          left: 940,
          right: 60,
          top: 268,
          height: 620,
          overflow: 'hidden',
          perspective: 1400,
          maskImage: 'linear-gradient(90deg, transparent 0%, black 7%, black 93%, transparent 100%)',
          WebkitMaskImage: 'linear-gradient(90deg, transparent 0%, black 7%, black 93%, transparent 100%)',
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: 120,
            top: 30,
            width: 2400,
            height: 540,
            transform: `translateX(${-termTravel}px)`,
            transformStyle: 'preserve-3d',
          }}
        >
          {terminals.map((term, i) => {
            const cardIn = ramp(f, 10 + i * 24, 14, outCubic);
            return (
              <div
                key={term.title}
                style={{
                  position: 'absolute',
                  left: i * 740,
                  top: 10,
                  width: 680,
                  height: 490,
                  background: '#101014',
                  border: `1.5px solid ${i === 0 ? C.cobalt : i === 1 ? C.mint : C.accent}`,
                  clipPath: CLIP.chamfer(24),
                  padding: 36,
                  boxSizing: 'border-box',
                  transform: `rotateY(${(i - 1) * -6}deg)`,
                  opacity: cardIn,
                  boxShadow: '0 30px 70px rgba(0,0,0,0.6)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: MONO, fontSize: 17, color: C.gray }}>
                  <span>{term.title}</span>
                  <span style={{ color: i === 0 ? C.cobalt : i === 1 ? C.mint : C.accent }}>{term.tag}</span>
                </div>
                <div style={{ marginTop: 28, fontFamily: MONO, fontSize: 24, color: '#fff', fontWeight: 700 }}>
                  <span style={{ color: C.accent }}>$ </span>
                  {term.cmd}
                </div>
                <div style={{ marginTop: 30, display: 'grid', gap: 18, fontFamily: MONO, fontSize: 20, color: '#b4b4c2' }}>
                  {term.lines.map((line, j) => (
                    <div key={line} style={{ opacity: ramp(f, 28 + i * 32 + j * 10, 10) }}>
                      {line}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Backdrop>
  );
};

/** 08 · quad-split-parallel-scenes + segmented-thumb-hero + crash-zoom-punch + reticle-lock-on */
export const QuadWorkflowScene: React.FC<SceneProps> = () => {
  const f = useCurrentFrame(); // 146f
  const { fps } = useVideoConfig();

  // Crash zoom punch on f=114..146
  const zoomP = ramp(f, 112, 8, inQuad);
  const scale = mix(1, 1.38, zoomP);
  const reticleP = spring({ frame: Math.max(0, f - 118), fps, config: { damping: 11, stiffness: 220 } });

  // Segmented toggle in Q2 (Video)
  const vidSwitch = ramp(f, 38, 10, outCubic);
  const playhead = ramp(f, 48, 56, outCubic);

  // Q3 Explore variants highlight
  const expIdx = Math.floor(f / 22) % 3;

  return (
    <Backdrop dark>
      <AbsoluteFill style={{ transform: `scale(${scale})`, transformOrigin: '50% 50%' }}>
        {/* 2x2 Parallel Grid */}
        <div
          style={{
            position: 'absolute',
            inset: 28,
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gridTemplateRows: '1fr 1fr',
            gap: 20,
          }}
        >
          {/* Q1: Inpaint & 2x Upscale */}
          <div style={{ position: 'relative', background: C.ink2, clipPath: CLIP.chamfer(24), overflow: 'hidden', opacity: ramp(f, 0, 12, backOut), transform: `scale(${1 + (f >= 0 && f <= 8 ? Math.sin((f / 8) * Math.PI) * 0.055 : 0)})` }}>
            <Image
              src={ART.clock}
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                transform: `scale(${mix(1.04, 1.28, ramp(f, 12, 70))})`,
              }}
            />
            <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, transparent 28%, rgba(16,16,20,0.78) 68%, rgba(16,16,20,0.98) 100%)' }} />
            <div style={{ position: 'absolute', left: 30, bottom: 26 }}>
              <div style={{ display: 'inline-block', padding: '4px 10px', background: C.accent, color: '#fff', fontFamily: MONO, fontSize: 16, fontWeight: 700, borderRadius: 4 }}>
                01 // INPAINT & ×2 UPSCALE
              </div>
              <div style={{ marginTop: 8, fontSize: 34, fontWeight: 800, color: '#fff' }}>局部重绘与高清放大</div>
            </div>
          </div>

          {/* Q2: Video Entry + segmented-thumb-hero */}
          <div style={{ position: 'relative', background: '#18181f', clipPath: CLIP.chamfer(24), overflow: 'hidden', opacity: ramp(f, 8, 12, backOut), padding: 28, transform: `scale(${1 + (f >= 8 && f <= 16 ? Math.sin(((f - 8) / 8) * Math.PI) * 0.055 : 0)})`, boxSizing: 'border-box' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontFamily: MONO, fontSize: 17, color: C.cobalt }}>02 // MINIMAX H3 VIDEO</span>
              <div style={{ position: 'relative', display: 'flex', width: 250, padding: 4, background: '#101014', borderRadius: 10, border: '1px solid #353542' }}>
                <div style={{ position: 'absolute', left: 4, top: 4, bottom: 4, width: 121, background: '#fff', borderRadius: 7, transform: `translateX(${vidSwitch * 121}px)` }} />
                <span style={{ flex: 1, textAlign: 'center', fontSize: 18, fontWeight: 700, zIndex: 1, color: vidSwitch < 0.5 ? C.ink : C.gray, padding: '6px 0' }}>首帧</span>
                <span style={{ flex: 1, textAlign: 'center', fontSize: 18, fontWeight: 700, zIndex: 1, color: vidSwitch >= 0.5 ? C.ink : C.gray, padding: '6px 0' }}>首尾帧</span>
              </div>
            </div>
            <div style={{ position: 'relative', marginTop: 18, height: 295, borderRadius: 14, overflow: 'hidden' }}>
              <Image src={ART.anime} style={{ width: '100%', height: '100%', objectFit: 'cover', transform: `scale(${mix(1, 1.12, playhead)})` }} />
              <div style={{ position: 'absolute', left: `${playhead * 96}%`, top: 0, bottom: 0, width: 3, background: C.accent, boxShadow: `0 0 12px ${C.accent}` }} />
            </div>
            <div style={{ marginTop: 16, fontSize: 32, fontWeight: 800 }}>抽帧延续文生 / 图生视频</div>
          </div>

          {/* Q3: 9dim Model Benchmark Waterfall Wall (page-waterfall-wall) */}
          <div style={{ position: 'relative', background: '#141418', color: '#fff', clipPath: CLIP.chamfer(24), overflow: 'hidden', opacity: ramp(f, 16, 12, backOut), transform: `scale(${1 + (f >= 16 && f <= 24 ? Math.sin(((f - 16) / 8) * Math.PI) * 0.055 : 0)})` }}>
            <div
              style={{
                position: 'absolute',
                inset: -30,
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: 12,
                transform: 'perspective(900px) rotateX(10deg) rotateZ(-4deg)',
                opacity: 0.9,
              }}
            >
              {[0, 1, 2].map((col) => {
                const dir = col % 2 === 0 ? -1 : 1;
                const shift = (f * 2.2 * dir) - (col === 1 ? 180 : 0);
                return (
                  <div key={col} style={{ display: 'flex', flexDirection: 'column', gap: 12, transform: `translateY(${shift}px)` }}>
                    {NINE_DIM.wall.slice(col * 6, col * 6 + 6).map((src, idx) => (
                      <Image key={idx} src={src} style={{ width: '100%', height: 220, objectFit: 'cover', borderRadius: 10 }} />
                    ))}
                  </div>
                );
              })}
            </div>
            <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(16,16,20,0.05) 30%, rgba(16,16,20,0.82) 72%, rgba(16,16,20,0.98) 100%)' }} />
            <div style={{ position: 'absolute', left: 30, bottom: 26 }}>
              <div style={{ display: 'inline-block', padding: '4px 10px', background: C.ink2, border: `1px solid ${C.accent}`, color: C.accent, fontFamily: MONO, fontSize: 16, fontWeight: 700, borderRadius: 4 }}>
                03 // 9-DIM BENCHMARK & EXPLORE
              </div>
              <div style={{ marginTop: 8, fontSize: 34, fontWeight: 800, color: '#fff' }}>多模型 9 维同题实测与自动探索</div>
            </div>
          </div>

          {/* Q4: Local Gallery & Version Tree */}
          <div style={{ position: 'relative', background: C.ink2, clipPath: CLIP.chamfer(24), overflow: 'hidden', opacity: ramp(f, 24, 12, backOut), transform: `scale(${1 + (f >= 24 && f <= 32 ? Math.sin(((f - 24) / 8) * Math.PI) * 0.055 : 0)})` }}>
            <Image src={TEXTURES.studioGallery} style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center top', opacity: 0.85 }} />
            <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(16,16,20,0.08) 25%, rgba(16,16,20,0.88) 64%, rgba(16,16,20,0.99) 84%)' }} />
            <div style={{ position: 'absolute', left: 30, bottom: 26 }}>
              <div style={{ display: 'inline-block', padding: '4px 10px', background: '#19352a', border: `1px solid ${C.mint}`, color: C.mint, fontFamily: MONO, fontSize: 16, fontWeight: 700, borderRadius: 4 }}>
                04 // LOCAL ARCHIVE
              </div>
              <div style={{ marginTop: 8, fontSize: 34, fontWeight: 800, color: '#fff' }}>画廊版本树与参数本地归档</div>
            </div>
          </div>
        </div>

        {/* Center Floating Core Pill locked by crash-zoom-punch + reticle-lock-on */}
        <div
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            transform: `translate(-50%, -50%) scale(${mix(0.82, 1.08, zoomP)})`,
            background: '#fff',
            color: C.ink,
            padding: '26px 46px',
            clipPath: CLIP.chamfer(20),
            boxShadow: '0 28px 90px rgba(0,0,0,0.75)',
            zIndex: 20,
            textAlign: 'center',
          }}
        >
          <div style={{ fontFamily: MONO, fontSize: 18, color: C.accent, fontWeight: 700 }}>ALL IN ONE DESKTOP WORKBENCH</div>
          <div style={{ marginTop: 10, fontSize: 36, fontWeight: 860, letterSpacing: -0.5, lineHeight: 1.3 }}>
            生图 &nbsp;·&nbsp; 工坊 &nbsp;·&nbsp; 视频
            <br />
            画廊 &nbsp;·&nbsp; MCP
          </div>
          {f >= 116 && <ReticleBrackets progress={reticleP} color={C.accent} size={30} thickness={4} spread={72} />}
        </div>
      </AbsoluteFill>
    </Backdrop>
  );
};

/** 09 · beat-step-list-theme-cycle: 3-beat audience lock-in with synchronized theme switch */
export const AudienceBeatScene: React.FC<SceneProps> = () => {
  const f = useCurrentFrame(); // 117f -> 39f per beat block
  const step = Math.min(2, Math.floor(f / 39));
  const local = f - step * 39;
  const slide = ramp(local, 0, 6, outQuint);

  const themes = [
    { bg: C.paper, fg: C.ink, pillBg: C.ink, pillFg: '#fff', accent: C.accent },
    { bg: C.ink, fg: C.paper, pillBg: C.accent, pillFg: '#fff', accent: '#fff' },
    { bg: C.accent, fg: '#fff', pillBg: '#fff', pillFg: C.ink, accent: C.ink },
  ];
  const th = themes[step];

  const rows = [
    { role: '个人创作者', line: '不用配置环境，写中文直接出图' },
    { role: '游戏开发者', line: '去背到 PBR，一套工具出完' },
    { role: '技术极客', line: 'Kaggle、Colab、本地，算力随时换' },
  ];

  const rowH = 184;
  const yOffset = mix((step - 1) * -rowH, step * -rowH, step === 0 ? 1 : slide);

  return (
    <Backdrop bg={th.bg}>
      <GridField dark={step > 0} opacity={0.06} />
      <TopTagBar dark={step > 0} section="06 / 适用人群" />

      <div style={{ position: 'absolute', left: 96, right: 96, top: 192 }}>
        <div style={{ fontFamily: MONO, fontSize: 22, letterSpacing: 2, color: th.accent, marginBottom: 22 }}>
          BUILT FOR // 0{step + 1} / 03
        </div>

        {/* Clipped list window with soft top/bottom fade so inactive rows never collide with header */}
        <div
          style={{
            position: 'relative',
            height: 552,
            overflow: 'hidden',
            maskImage: 'linear-gradient(180deg, transparent 0%, black 26%, black 74%, transparent 100%)',
            WebkitMaskImage: 'linear-gradient(180deg, transparent 0%, black 26%, black 74%, transparent 100%)',
          }}
        >
          {/* Stationary focus capsule in the middle (top: 184, height: 184) */}
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: 184,
              height: 184,
              background: th.pillBg,
              clipPath: CLIP.chamfer(24),
              transform: `scaleY(${interpolate(local, [0, 4, 10], [0.95, 1.03, 1], { extrapolateRight: 'clamp' })})`,
            }}
          />

          <div style={{ position: 'relative', top: 184, transform: `translateY(${yOffset}px)` }}>
            {rows.map((r, i) => {
              const active = i === step;
              return (
                <div
                  key={r.role}
                  style={{
                    height: rowH,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '0 36px',
                    color: active ? th.pillFg : th.fg,
                    opacity: active ? 1 : 0.22,
                    transform: `scale(${active ? 1 : 0.94})`,
                  }}
                >
                  <span style={{ fontSize: 62, fontWeight: 860, letterSpacing: -2, lineHeight: 1 }}>{r.role}</span>
                  <span style={{ fontSize: 33, fontWeight: 600, lineHeight: 1.15 }}>{r.line}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </Backdrop>
  );
};

/** 10 · ui-strip-away-outro + ui-to-brand-morph + outro-group-photo-launch + 30h/17000+ highlight */
export const OutroMorphScene: React.FC<SceneProps> = () => {
  const f = useCurrentFrame(); // 117f
  const { fps } = useVideoConfig();

  // Phase 2 (26..66): Center prompt bar morphs into BrandIcon
  const morphP = ramp(f, 26, 26, outCubic);
  const lockLeft = ramp(f, 52, 18, outCubic);
  const wordmarkIn = ramp(f, 58, 16, outCubic);
  const holdIn = ramp(f, 68, 16, outCubic);
  const quotaIn = ramp(f, 74, 16, backOut);
  const haloIn = ramp(f, 64, 24, outCubic);

  const satellites = [
    { label: 'Qwen-Image 2.1', x: 180, y: 170, dx: -520, dy: -280 },
    { label: 'BiRefNet Cutout', x: 1440, y: 180, dx: 520, dy: -280 },
    { label: 'Marigold PBR', x: 150, y: 770, dx: -520, dy: 280 },
    { label: 'Pixel & Atlas', x: 1470, y: 770, dx: 520, dy: 280 },
    { label: 'Kaggle 2×T4', x: 820, y: 120, dx: 0, dy: -360 },
    { label: 'MCP Server', x: 820, y: 840, dx: 0, dy: 360 },
  ];

  // Blurred periphery 9dim art cards framing the finale (outro-group-photo-launch)
  const haloArts = [
    { src: NINE_DIM.flux9b, x: 70, y: 90, w: 240, rot: -8 },
    { src: NINE_DIM.qwen, x: 1610, y: 100, w: 240, rot: 7 },
    { src: NINE_DIM.anima, x: 85, y: 730, w: 230, rot: 6 },
    { src: NINE_DIM.zimage, x: 1605, y: 720, w: 230, rot: -7 },
  ];

  const boxW = mix(540, 104, morphP);
  const boxH = mix(82, 104, morphP);
  const boxX = 960 - boxW / 2;
  const boxY = mix(540, 340, lockLeft) - boxH / 2;

  return (
    <Backdrop dark>
      <BlurredBackdrop
        src={BENCH.qwen_scifi}
        frame={f}
        blurPx={58}
        brightness={0.22}
        orbColorA="rgba(232,83,63,0.28)"
        orbColorB="rgba(76,124,255,0.22)"
      />
      <GridField dark opacity={0.04} />

      {/* Soft depth-of-field periphery 9dim prints settling at the outer corners */}
      {haloArts.map((a, i) => (
        <div
          key={a.src}
          style={{
            position: 'absolute',
            left: a.x,
            top: a.y,
            width: a.w,
            height: a.w,
            clipPath: CLIP.chamfer(16),
            overflow: 'hidden',
            opacity: haloIn * 0.34,
            filter: 'blur(3px) saturate(1.15)',
            transform: `translateY(${mix(40, 0, haloIn)}px) rotate(${a.rot}deg)`,
            border: '1px solid rgba(255,255,255,0.16)',
          }}
        >
          <Image src={a.src} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        </div>
      ))}

      {/* ui-strip-away-outro */}
      {satellites.map((s, i) => {
        const localStrip = ramp(f, i * 2, 24, inQuad);
        return (
          <div
            key={s.label}
            style={{
              position: 'absolute',
              left: s.x,
              top: s.y,
              padding: '16px 28px',
              background: C.ink2,
              border: '1px solid #353542',
              clipPath: CLIP.chamfer(14),
              fontFamily: MONO,
              fontSize: 21,
              color: '#b8b8c4',
              opacity: 1 - localStrip,
              transform: `translate(${s.dx * localStrip}px, ${s.dy * localStrip}px) scale(${mix(1, 0.72, localStrip)})`,
            }}
          >
            {s.label}
          </div>
        );
      })}

      {/* Morphing Prompt Input -> Viewfinder Brand Mark */}
      {morphP < 0.99 && (
        <div
          style={{
            position: 'absolute',
            left: boxX,
            top: boxY,
            width: boxW,
            height: boxH,
            borderRadius: mix(16, 20, morphP),
            background: `rgba(245,245,246,${1 - morphP})`,
            border: '3px solid #f5f5f6',
            display: 'flex',
            alignItems: 'center',
            padding: '0 24px',
            boxSizing: 'border-box',
            opacity: 1 - morphP * 0.9,
          }}
        >
          <span style={{ fontFamily: MONO, fontSize: 24, color: '#6b6b76', opacity: 1 - ramp(f, 22, 10) }}>
            输入中文描述，开始创作...
          </span>
        </div>
      )}

      {/* Centered Brand Lockup */}
      {morphP > 0.35 && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 256,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            gap: 28,
            opacity: clamp((morphP - 0.35) * 2),
          }}
        >
          <div
            style={{
              display: 'grid',
              placeItems: 'center',
              transform: `translateX(${mix(295, 0, lockLeft)}px) translateY(${mix(140, 4, lockLeft)}px) scale(${spring({ frame: Math.max(0, f - 40), fps, config: { damping: 12, stiffness: 180 } })})`,
            }}
          >
            <BrandIcon size={102} dark />
          </div>
          <div
            style={{
              fontSize: 108,
              fontWeight: 860,
              letterSpacing: -3.5,
              color: '#f5f5f6',
              lineHeight: 1,
              opacity: wordmarkIn,
              transform: `translateX(${mix(36, 0, wordmarkIn)}px)`,
            }}
          >
            AIGC Studio
          </div>
        </div>
      )}

      {/* Tagline + 30h / 17,000+ Free GPU Quota Highlight + MIT Repo */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 432,
          textAlign: 'center',
        }}
      >
        <div
          style={{
            fontSize: 40,
            fontWeight: 620,
            color: '#e8e8ee',
            opacity: holdIn,
            transform: `translateY(${mix(22, 0, holdIn)}px)`,
          }}
        >
          你只管描述，剩下的交给它。
        </div>

        {/* 30h Free GPU -> 17,000+ images highlight card */}
        <div
          style={{
            marginTop: 42,
            display: 'inline-block',
            position: 'relative',
            padding: '24px 48px',
            background: 'rgba(255,255,255,0.08)',
            backdropFilter: 'blur(18px)',
            border: `1.5px solid ${C.accent}`,
            clipPath: CLIP.chamfer(20),
            overflow: 'hidden',
            opacity: quotaIn,
            transform: `scale(${mix(0.88, 1, quotaIn)})`,
          }}
        >
          <div style={{ fontSize: 40, fontWeight: 840, color: '#fff', letterSpacing: -1 }}>
            每周 <span style={{ color: C.accent }}>30h</span> 免费 GPU 额度 · 最高生成{' '}
            <span style={{ color: C.accent }}>17,000+</span> 张图
          </div>
          <div style={{ marginTop: 10, fontFamily: MONO, fontSize: 19, color: '#b4b4c4' }}>
            Kaggle 2×T4 双卡，SDXL Lightning 实测约 6 秒一张
          </div>
          <SheenSweep frame={f} start={86} duration={22} />
        </div>

        <div style={{ marginTop: 36, opacity: holdIn }}>
          <div
            style={{
              display: 'inline-flex',
              gap: 18,
              alignItems: 'center',
              padding: '12px 30px',
              background: '#1e1e26',
              border: '1px solid #3c3c48',
              clipPath: CLIP.chamfer(12),
              fontFamily: MONO,
              fontSize: 22,
              color: '#c2c2ce',
            }}
          >
            <span style={{ color: C.accent, fontWeight: 700 }}>MIT 开源</span>
            <span>·</span>
            <span>github.com/nanxfu/aigc-studio</span>
          </div>
        </div>
      </div>
    </Backdrop>
  );
};
