import React from 'react';
import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import {
  ART,
  BENCH,
  Backdrop,
  BlurredBackdrop,
  C,
  CLIP,
  Checkerboard,
  FONT,
  GridField,
  Image,
  MONO,
  NINE_DIM,
  RisoHitText,
  SheenSweep,
  TEXTURES,
  TopTagBar,
  WORKSHOP_ART,
  backOut,
  clamp,
  inQuad,
  mix,
  out,
  outCubic,
  outQuint,
  ramp,
} from './visuals';

export type SceneProps = { title?: string; subtitle?: string; duration?: number; hideNarrativeCaption?: boolean };

/** 01 · trailer-bumper + anime-impact: 4 micro-cuts in 48f + 11f hard beat pause */
export const TrailerBumperScene: React.FC<SceneProps> = () => {
  const f = useCurrentFrame();
  // 4 cuts x 12f = 48f, then 48..59 dark pause for beat drop
  const cut = Math.floor(f / 12);
  const local = f % 12;
  const pause = f >= 48;
  const punch = interpolate(local, [0, 5, 11], [1.14, 1.0, 1.02], { easing: outQuint, extrapolateRight: 'clamp' });
  const impactInvert = (f >= 24 && f <= 25) || (f >= 36 && f <= 37);

  const cards = [
    { text: '还在配环境？', sub: '打开就能用', src: ART.street, bg: C.ink, fg: C.paper, clip: CLIP.slashLeft },
    { text: '去背、转矢量、PBR', sub: '出图后直接用', src: WORKSHOP_ART.cutout, bg: C.ink, fg: C.paper, clip: CLIP.chamfer(40) },
    { text: 'Kaggle 免费 GPU', sub: '每周 30 小时', src: BENCH.flux4b_scifi, bg: C.accent, fg: '#fff', clip: CLIP.slashRight },
    { text: '本地运行', sub: '零 Python 依赖', src: ART.crane, bg: C.ink, fg: C.paper, clip: 'none' },
  ];

  if (pause) {
    const pulse = interpolate(f, [48, 58], [0.4, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    return (
      <Backdrop dark>
        <AbsoluteFill style={{ display: 'grid', placeItems: 'center' }}>
          <div
            style={{
              width: 18,
              height: 18,
              borderRadius: '50%',
              background: C.accent,
              transform: `scale(${mix(0.6, 1.5, pulse)})`,
              boxShadow: `0 0 36px ${C.accent}`,
            }}
          />
        </AbsoluteFill>
      </Backdrop>
    );
  }

  const item = cards[Math.min(3, cut)];
  return (
    <Backdrop bg={item.bg}>
      <GridField dark={item.bg !== C.paper} opacity={0.03} />
      <AbsoluteFill
        style={{
          transform: `scale(${punch})`,
          filter: impactInvert ? 'invert(1) contrast(1.25)' : undefined,
        }}
      >
        <div
          style={{
            position: 'absolute',
            right: -40,
            top: 80,
            width: 1120,
            height: 920,
            clipPath: item.clip,
            overflow: 'hidden',
            boxShadow: '0 30px 90px rgba(0,0,0,0.45)',
          }}
        >
          {cut === 1 && <Checkerboard size={28} dark />}
          <Image
            src={item.src}
            style={{
              width: '100%',
              height: '100%',
              objectFit: cut === 1 ? 'contain' : 'cover',
              transform: cut === 1 ? 'scale(1.16)' : undefined,
              padding: cut === 1 ? 36 : 0,
              boxSizing: 'border-box',
            }}
          />
        </div>

        {/* Diagonal heavy text block */}
        <div
          style={{
            position: 'absolute',
            left: 84,
            top: 310,
            maxWidth: 820,
            padding: '28px 40px',
            background: item.bg === C.accent ? C.ink : item.bg === C.paper ? C.ink : '#fff',
            color: item.bg === C.paper || item.bg === C.accent ? '#fff' : C.ink,
            clipPath: CLIP.chamfer(24),
          }}
        >
          <div style={{ fontFamily: MONO, fontSize: 22, letterSpacing: 2, color: item.bg === C.accent ? C.accent : '#9ea0aa' }}>
            0{cut + 1} // {item.sub}
          </div>
          <div style={{ marginTop: 10, fontSize: 78, fontWeight: 850, letterSpacing: -2, lineHeight: 1.08 }}>
            {item.text}
          </div>
        </div>
      </AbsoluteFill>
    </Backdrop>
  );
};

/** 02 · text-as-mask + misregistration-hit: giant knockout wordmark zooms 38x into studio */
export const MaskOpenScene: React.FC<SceneProps> = () => {
  const f = useCurrentFrame(); // 117f
  const { fps } = useVideoConfig();
  const enter = spring({ frame: f, fps, config: { damping: 14, stiffness: 150 } });
  const zoomThrough = f < 86 ? 1 : 1 + Math.pow((f - 86) / 31, 3.2) * 38;
  const subIn = ramp(f, 18, 12, outCubic);
  const pan = interpolate(f, [0, 95], [0, -360], { extrapolateRight: 'clamp' });
  // steep-tilt-glide: 孤立 UI 面板以 60° 大倾角从右侧贴面飞入 (f=52..84)
  const glideP = ramp(f, 52, 32, outCubic);
  const glideX = mix(1600, 180, glideP);
  const glideRotY = mix(-62, -18, glideP);
  const glideOpacity = glideP < 0.05 ? glideP * 20 : f > 80 ? 1 - ramp(f, 80, 6) : 1;

  return (
    <Backdrop bg={C.paper}>
      <GridField opacity={0.025} />
      <AbsoluteFill
        style={{
          transform: `scale(${zoomThrough})`,
          transformOrigin: '50% 44%',
        }}
      >
        {/* SVG Text Mask revealing moving collage of real generated outputs */}
        <div
          style={{
            position: 'absolute',
            left: 60,
            right: 60,
            top: 165,
            height: 480,
            transform: `scale(${mix(0.88, 1, enter)})`,
            opacity: clamp(enter * 1.4),
          }}
        >
          <svg width="1800" height="480" viewBox="0 0 1800 480" style={{ display: 'block' }}>
            <defs>
              <mask id="aigc-knockout-mask">
                <rect width="1800" height="480" fill="black" />
                <text
                  x="900"
                  y="225"
                  textAnchor="middle"
                  fill="white"
                  fontFamily="Segoe UI, Microsoft YaHei, sans-serif"
                  fontWeight="900"
                  fontSize="215"
                  letterSpacing="-6"
                >
                  AIGC
                </text>
                <text
                  x="900"
                  y="435"
                  textAnchor="middle"
                  fill="white"
                  fontFamily="Segoe UI, Microsoft YaHei, sans-serif"
                  fontWeight="900"
                  fontSize="215"
                  letterSpacing="-4"
                >
                  STUDIO
                </text>
              </mask>
            </defs>
          </svg>
          <div
            style={{
              position: 'absolute',
              inset: 0,
              mask: 'url(#aigc-knockout-mask)',
              WebkitMask: 'url(#aigc-knockout-mask)',
              background: C.ink,
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <div style={{ display: 'flex', gap: 12, width: 3400, height: 235, transform: `translateX(${pan}px)` }}>
              {NINE_DIM.wall.slice(0, 9).map((src, i) => (
                <Image key={`r1-${i}`} src={src} style={{ width: 360, height: 235, objectFit: 'cover' }} />
              ))}
            </div>
            <div style={{ display: 'flex', gap: 12, width: 3400, height: 235, transform: `translateX(${-360 - pan * 0.9}px)` }}>
              {NINE_DIM.wall.slice(9, 18).map((src, i) => (
                <Image key={`r2-${i}`} src={src} style={{ width: 360, height: 235, objectFit: 'cover' }} />
              ))}
            </div>
          </div>
        </div>

        {/* Clean written Chinese positioning */}
        <div
          style={{
            position: 'absolute',
            left: 110,
            right: 110,
            top: 685,
            textAlign: 'center',
            opacity: subIn * (f < 88 ? 1 : 1 - ramp(f, 88, 8)),
            transform: `translateY(${mix(28, 0, subIn)}px)`,
          }}
        >
          <RisoHitText frame={f} hitAt={20}>
            <div style={{ fontSize: 64, fontWeight: 800, letterSpacing: -1.8, color: C.ink }}>
              开源桌面端 AI 创作工作台
            </div>
          </RisoHitText>
          <div style={{ marginTop: 18, fontSize: 32, fontWeight: 500, color: C.secondary }}>
            不用装 Python，不用配 ComfyUI，打开就能用
          </div>
          <div
            style={{
              marginTop: 28,
              display: 'inline-flex',
              gap: 14,
              alignItems: 'center',
              padding: '10px 26px',
              background: C.ink,
              color: '#fff',
              fontFamily: MONO,
              fontSize: 20,
              clipPath: CLIP.chamfer(12),
            }}
          >
            <span style={{ color: C.accent }}>●</span>
            <span>图像生成</span>
            <span>·</span>
            <span>资产工坊</span>
            <span>·</span>
            <span>视频入口</span>
            <span>·</span>
            <span>MCP</span>
            <span style={{ display: 'inline-block', margin: '0 6px 0 10px', width: 1, height: 16, background: 'rgba(255,255,255,0.3)', verticalAlign: 'middle' }} />
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              padding: '2px 10px', borderRadius: 20,
              background: `rgba(232,83,63,${0.18 + Math.sin(f * 0.28) * 0.12})`,
              border: `1px solid ${C.accent}`,
              color: C.accent, fontWeight: 800,
            }}>
              <span style={{ fontSize: 16, lineHeight: 1 }}>⚡</span>
              <span>Kaggle 免费 30h/周</span>
            </span>
          </div>
        </div>
      </AbsoluteFill>
    </Backdrop>
  );
};

/** 03 · aurora-bloom-bg + depth-layer + kanada-perspective-snap + impact-burst-kit + bento-light-up */
export const OrdinaryCreateScene: React.FC<SceneProps> = () => {
  const f = useCurrentFrame(); // 146f
  const snapP = ramp(f, 0, 18, outCubic);
  const overshoot = interpolate(f, [14, 18, 24], [0, 4.2, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const persp = mix(340, 1400, snapP);
  const rotY = mix(-36, 0, snapP) + overshoot;
  const rotX = mix(18, 0, snapP);
  const cardScale = mix(1.56, 1, snapP);

  // Typing in frosted glass pill
  const promptText = '赛博都市高空全息建筑，雨夜反光';
  const typed = Math.min(promptText.length, Math.max(0, Math.floor((f - 22) / 1.8)));
  const warmGlow = ramp(f, 20, 14) * (1 - ramp(f, 62, 20));
  const btnPress = f >= 66 && f <= 71 ? 0.93 : 1;

  // Shockwave hitting 8 model bento cards at f=18
  const waveRadius = f < 18 ? 0 : (f - 18) * 34;
  const waveRing = ramp(f, 18, 22, outCubic);
  const resultIn = ramp(f, 72, 16, backOut);
  const spotlightSweep = interpolate(f, [10, 62], [-25, 125], { easing: outCubic, extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  const models = [
    ['SDXL Lightning', '4 步极速', NINE_DIM.sdxl],
    ['SANA-Sprint 1.6B', '2 步构思', NINE_DIM.sana],
    ['FLUX.2 Klein 4B', '中英双语', NINE_DIM.flux4b],
    ['FLUX.2 Klein 9B', '材质精绘', NINE_DIM.flux9b],
    ['Qwen-Image 2.1', '文字排版', NINE_DIM.qwen],
    ['Z-Image Turbo', '写实场景', NINE_DIM.zimage],
    ['Anima Turbo v1.1', '二次元立绘', NINE_DIM.anima],
    ['RealVisXL V5', '本机 Vulkan', NINE_DIM.realvis],
  ];

  return (
    <Backdrop dark>
      {/* Rich blurred 9dim artwork + drifting ambient glow orbs */}
      <BlurredBackdrop
        src={BENCH.flux9b_material}
        frame={f}
        blurPx={42}
        brightness={0.42}
        orbColorA="rgba(232,83,63,0.42)"
        orbColorB="rgba(76,124,255,0.34)"
      />
      <GridField dark opacity={0.025} />
      <TopTagBar dark tag="写中文直接出图" />

      {/* Headline with spotlight-sweep */}
      <div style={{ position: 'absolute', left: 72, top: 92, opacity: ramp(f, 4, 12) }}>
        <div style={{ position: 'relative', fontSize: 64, fontWeight: 840, letterSpacing: -2 }}>
          <span style={{ color: 'rgba(255,255,255,0.28)' }}>说个大概，AI 补齐细节</span>
          <span
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              color: '#ffffff',
              WebkitMaskImage: `radial-gradient(ellipse 360px 140px at ${spotlightSweep}% 50%, #000 40%, transparent 100%)`,
              maskImage: `radial-gradient(ellipse 360px 140px at ${spotlightSweep}% 50%, #000 40%, transparent 100%)`,
            }}
          >
            说个大概，AI 补齐细节
          </span>
          {f > 56 && (
            <span style={{ position: 'absolute', left: 0, top: 0, color: '#ffffff', opacity: ramp(f, 56, 12) }}>
              说个大概，AI 补齐细节
            </span>
          )}
        </div>
        <div style={{ marginTop: 8, fontSize: 28, color: '#c8c8d4' }}>
          内置 8 款常用模型，不用装 Python，不用配 ComfyUI
        </div>
      </div>

      {/* Shockwave ring on snap landing */}
      {f >= 18 && f <= 46 && (
        <div
          style={{
            position: 'absolute',
            left: 520 - waveRadius / 2,
            top: 570 - waveRadius / 2,
            width: waveRadius,
            height: waveRadius,
            borderRadius: '50%',
            border: `3px solid ${C.accent}`,
            opacity: (1 - waveRing) * 0.6,
            pointerEvents: 'none',
          }}
        />
      )}

      {/* Left isolated Frosted Glass Studio Prompt Card (kanada-perspective-snap) */}
      <div
        style={{
          position: 'absolute',
          left: 72,
          top: 248,
          width: 900,
          height: 750,
          perspective: `${persp}px`,
          zIndex: 5,
        }}
      >
        <div
          style={{
            width: '100%',
            height: '100%',
            background: 'rgba(255, 255, 255, 0.93)',
            backdropFilter: 'blur(24px)',
            clipPath: CLIP.chamfer(34),
            border: '1px solid rgba(255,255,255,0.65)',
            boxShadow: `0 ${mix(60, 32, snapP)}px ${mix(110, 72, snapP)}px -22px rgba(0,0,0,0.65)`,
            transform: `rotateY(${rotY}deg) rotateX(${rotX}deg) scale(${cardScale})`,
            transformOrigin: 'center center',
            padding: 36,
            boxSizing: 'border-box',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: MONO, fontSize: 18, color: C.secondary }}>
            <span>PROMPT WORKBENCH</span>
            <span style={{ color: C.mint, fontWeight: 700 }}>● READY · KAGGLE GPU</span>
          </div>

          {/* glass-pill-dictation-typing */}
          <div
            style={{
              marginTop: 22,
              padding: '22px 26px',
              borderRadius: 18,
              background: `linear-gradient(90deg, rgba(232,83,63,${0.18 * warmGlow}) 0%, rgba(245,245,248,0.95) 75%)`,
              border: `2px solid ${warmGlow > 0.1 ? C.accent : '#d6d6de'}`,
              boxShadow: `0 12px 34px -18px rgba(232,83,63,${0.45 * warmGlow})`,
            }}
          >
            <div style={{ fontFamily: MONO, fontSize: 16, color: C.secondary, marginBottom: 8 }}>中文提示词</div>
            <div style={{ fontSize: 33, fontWeight: 680, color: C.ink, minHeight: 46 }}>
              {promptText.slice(0, typed)}
              <span
                style={{
                  display: 'inline-block',
                  width: 3,
                  height: 32,
                  marginLeft: 4,
                  background: f < 66 && Math.floor(f / 6) % 2 === 0 ? C.accent : 'transparent',
                  verticalAlign: -5,
                }}
              />
            </div>
          </div>

          <div style={{ marginTop: 20, display: 'flex', gap: 14, alignItems: 'center' }}>
            <div
              style={{
                padding: '13px 32px',
                background: C.ink,
                color: '#fff',
                fontSize: 24,
                fontWeight: 700,
                clipPath: CLIP.chamfer(12),
                transform: `scale(${btnPress})`,
              }}
            >
              生成图像
            </div>
            <div style={{ padding: '12px 20px', border: '1px solid #d6d6de', borderRadius: 10, fontSize: 21, color: C.secondary }}>
              1 : 1 · 9 步 · Z-Image Turbo
            </div>
          </div>

          {/* Result card popping out with 9dim hero art */}
          <div
            style={{
              marginTop: 26,
              display: 'flex',
              gap: 24,
              alignItems: 'center',
              opacity: resultIn,
              transform: `translateY(${mix(40, 0, resultIn)}px) scale(${mix(0.86, 1, resultIn)})`,
            }}
          >
            <div
              style={{
                position: 'relative',
                width: 420,
                height: 410,
                clipPath: CLIP.chamfer(22),
                overflow: 'hidden',
                boxShadow: '0 24px 50px -20px rgba(20,20,22,0.45)',
              }}
            >
              <Image src={BENCH.z_scifi} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: MONO, fontSize: 18, color: C.accent, fontWeight: 700 }}>OUTPUT // 1024×1024</div>
              <div style={{ marginTop: 10, fontSize: 32, fontWeight: 800, color: C.ink }}>
                原图与参数
                <br />
                自动存进工作区
              </div>
              <div style={{ marginTop: 14, fontSize: 22, color: C.secondary, lineHeight: 1.5 }}>
                支持局部重绘、
                <br />
                高清放大与扩图
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Right 8 Model Bento Cards with real 9dim thumbnails (bento-light-up + impact-burst-kit) */}
      <div style={{ position: 'absolute', left: 1006, right: 72, top: 248, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {models.map(([name, note, thumb], i) => {
          const hitDelay = 20 + i * 2;
          const bump = f >= hitDelay && f <= hitDelay + 14 ? Math.sin(((f - hitDelay) / 14) * Math.PI) : 0;
          const show = ramp(f, 8 + i * 2, 12, outCubic);
          const selected = i === 5 && f > 54;
          return (
            <div
              key={name}
              style={{
                position: 'relative',
                height: 175,
                background: selected ? 'rgba(232,83,63,0.92)' : 'rgba(22,22,28,0.78)',
                backdropFilter: 'blur(18px)',
                color: '#fff',
                border: `1.5px solid ${selected ? '#fff' : 'rgba(255,255,255,0.16)'}`,
                clipPath: CLIP.chamfer(18),
                opacity: show,
                transform: `translate(${bump * 24}px, ${bump * ((i % 2 === 0 ? -1 : 1) * 10)}px) rotate(${bump * ((i % 2 === 0 ? -1 : 1) * 3)}deg)`,
                boxShadow: selected ? '0 20px 44px -12px rgba(232,83,63,0.65)' : '0 14px 32px -16px rgba(0,0,0,0.55)',
                display: 'flex',
                alignItems: 'center',
                gap: 16,
                padding: 14,
                boxSizing: 'border-box',
                overflow: 'hidden',
              }}
            >
              <div style={{ width: 126, height: 145, flex: 'none', clipPath: CLIP.chamfer(10), overflow: 'hidden' }}>
                <Image src={thumb} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: MONO, fontSize: 15, color: selected ? '#ffe4df' : C.accent, fontWeight: 700 }}>
                  0{i + 1} // {note}
                </div>
                <div style={{ marginTop: 8, fontSize: 23, fontWeight: 800, lineHeight: 1.2 }}>{name}</div>
              </div>
            </div>
          );
        })}
      </div>
    </Backdrop>
  );
};

/** 04 · error-retype + pill-slot-cycle + carousel-3d + card-flip-reveal */
export const AssistantModelsScene: React.FC<SceneProps> = () => {
  const f = useCurrentFrame(); // 146f

  // error-retype timeline inside isolated assistant box
  const badText = '一张好看的植物画，清楚一点';
  const goodText = '阴天雨后玻璃温室，顶部留白，构图克制';
  let shownText = '';
  if (f < 26) {
    shownText = badText.slice(0, Math.min(badText.length, Math.floor(f / 1.5)));
  } else if (f < 42) {
    const left = Math.max(0, badText.length - Math.floor((f - 26) * 1.8));
    shownText = badText.slice(0, left);
  } else {
    shownText = goodText.slice(0, Math.min(goodText.length, Math.floor((f - 42) / 1.4)));
  }

  const slots = [
    ['主体', ['植物', '雨后玻璃温室']],
    ['光线', ['柔和光', '阴天自然散射']],
    ['构图', ['居中', '留白海报构图']],
    ['模型', ['默认', 'Qwen-Image 2.1']],
  ] as const;

  // Right 3D carousel + card flip
  const orbit = interpolate(f, [0, 38, 70], [-65, -20, 0], { easing: outQuint, extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const flipToBack = ramp(f, 66, 20, outCubic);
  const flipBack = ramp(f, 114, 20, outCubic);
  const flipDeg = -180 * (flipToBack - flipBack);

  const cards = [
    { name: 'Z-Image Turbo', src: BENCH.z_portrait, spec: '9 步 · 写实人像', license: 'Apache-2.0' },
    { name: 'Qwen-Image 2.1', src: BENCH.qwen_diorama, spec: '8 步 · 中文排版强', license: '7B DiT' },
    { name: 'FLUX.2 Klein 9B', src: BENCH.flux9b_material, spec: '4 步 · 高精度材质', license: '9B Distilled' },
    { name: 'Anima Turbo', src: BENCH.anima_anime, spec: '10 步 · 二次元立绘', license: '2B DiT' },
  ];

  return (
    <Backdrop dark>
      <BlurredBackdrop src={BENCH.qwen_diorama} frame={f} blurPx={52} brightness={0.28} />
      <GridField dark opacity={0.025} />
      <TopTagBar dark tag="参数可改，模型可换" />

      <div style={{ position: 'absolute', left: 72, top: 96, opacity: ramp(f, 0, 12) }}>
        <div style={{ fontSize: 62, fontWeight: 820, letterSpacing: -2 }}>
          描述模糊也没关系，助手帮你拆成可改的参数
        </div>
        <div style={{ marginTop: 8, fontSize: 28, color: C.gray }}>
          同一组参数，随时换模型重跑对比
        </div>
      </div>

      {/* Left: error-retype + pill-slot-cycle */}
      <div
        style={{
          position: 'absolute',
          left: 72,
          top: 255,
          width: 790,
          background: C.ink2,
          border: '1px solid #353540',
          clipPath: CLIP.chamfer(30),
          padding: 34,
          boxSizing: 'border-box',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: MONO, fontSize: 17, color: C.gray }}>
          <span>ASSISTANT // REWRITE</span>
          <span style={{ color: f >= 42 ? C.mint : C.accent }}>
            {f < 26 ? '草稿输入' : f < 42 ? '清除模糊描述' : '生成可编辑提案'}
          </span>
        </div>

        <div
          style={{
            marginTop: 20,
            padding: '20px 24px',
            borderRadius: 14,
            background: '#121216',
            border: `1.5px solid ${f >= 26 && f < 42 ? C.accent : '#3b3b47'}`,
            fontSize: 30,
            minHeight: 44,
            color: f < 42 ? '#b4b4c0' : '#fff',
          }}
        >
          {shownText}
          <span style={{ display: 'inline-block', width: 3, height: 28, marginLeft: 4, background: C.accent, verticalAlign: -4 }} />
        </div>

        {/* 4 Pill Slots rolling from draft -> structured */}
        <div style={{ marginTop: 26, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          {slots.map(([k, [v0, v1]], i) => {
            const roll = ramp(f, 52 + i * 7, 14, backOut);
            return (
              <div
                key={k}
                style={{
                  background: '#17171c',
                  border: `1px solid ${roll > 0.6 ? C.accent : '#32323c'}`,
                  padding: '16px 20px',
                  clipPath: CLIP.chamfer(14),
                }}
              >
                <div style={{ fontFamily: MONO, fontSize: 15, color: C.gray }}>{k}</div>
                <div style={{ position: 'relative', height: 38, overflow: 'hidden', marginTop: 6 }}>
                  <div style={{ position: 'absolute', inset: 0, fontSize: 25, color: '#70707c', transform: `translateY(${mix(0, -40, roll)}px)`, opacity: 1 - roll }}>
                    {v0}
                  </div>
                  <div style={{ position: 'absolute', inset: 0, fontSize: 25, fontWeight: 700, color: '#fff', transform: `translateY(${mix(40, 0, roll)}px)`, opacity: roll }}>
                    {v1}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ marginTop: 26, display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 22, color: C.gray }}>
          <span>不改原文，每一项都能手动调</span>
          <span style={{ padding: '10px 24px', background: C.accent, color: '#fff', fontWeight: 700, clipPath: CLIP.chamfer(10) }}>
            确认生成
          </span>
        </div>
      </div>

      {/* Right: carousel-3d + card-flip-reveal */}
      <div
        style={{
          position: 'absolute',
          left: 910,
          right: 60,
          top: 230,
          height: 760,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          perspective: 1400,
          transformStyle: 'preserve-3d',
        }}
      >
        {cards.map((card, i) => {
          const angle = (i - 1) * 90 + orbit;
          const rad = (angle * Math.PI) / 180;
          const x = Math.sin(rad) * 375;
          const z = Math.cos(rad) * 180;
          const active = i === 1;
          const center = (Math.cos(rad) + 1) / 2;
          return (
            <div
              key={card.name}
              style={{
                position: 'absolute',
                width: 340,
                height: 490,
                transform: `translateX(${x}px) translateZ(${z + (active ? 64 : 0)}px) rotateY(${-Math.sin(rad) * 18}deg) scale(${0.74 + 0.28 * center})`,
                opacity: active ? 1 : 0.22 + 0.45 * center,
                zIndex: Math.round(10 + 10 * center),
              }}
            >
              <div style={{ position: 'absolute', inset: 0, transform: `rotateY(${active ? flipDeg : 0}deg)`, transformStyle: 'preserve-3d' }}>
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    backfaceVisibility: 'hidden',
                    background: '#fff',
                    color: C.ink,
                    padding: 14,
                    boxSizing: 'border-box',
                    clipPath: CLIP.chamfer(20),
                    boxShadow: active ? `0 28px 65px rgba(0,0,0,0.65), 0 0 0 3px ${C.accent}` : '0 20px 50px rgba(0,0,0,0.45)',
                  }}
                >
                  <Image src={card.src} style={{ width: '100%', height: 345, objectFit: 'cover', clipPath: CLIP.chamfer(12) }} />
                  <div style={{ padding: '16px 6px 0' }}>
                    <div style={{ fontFamily: MONO, fontSize: 15, color: active ? C.accent : C.gray }}>{card.license}</div>
                    <div style={{ marginTop: 4, fontSize: 28, fontWeight: 800 }}>{card.name}</div>
                    <div style={{ marginTop: 2, fontSize: 20, color: C.secondary }}>{card.spec}</div>
                  </div>
                </div>
                {active && (
                  <div
                    style={{
                      position: 'absolute',
                      inset: 0,
                      backfaceVisibility: 'hidden',
                      transform: 'rotateY(180deg)',
                      background: C.accent,
                      color: '#fff',
                      padding: 36,
                      boxSizing: 'border-box',
                      clipPath: CLIP.chamfer(20),
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'space-between',
                    }}
                  >
                    <div style={{ fontFamily: MONO, fontSize: 18 }}>MODEL SPEC // VERIFIED</div>
                    <div>
                      <div style={{ fontSize: 44, fontWeight: 850 }}>{card.name}</div>
                      <div style={{ marginTop: 18, fontSize: 26, lineHeight: 1.5 }}>
                        {card.spec}
                        <br />
                        支持多图参考与 RGBA
                        <br />
                        参数不用重打
                      </div>
                    </div>
                    <div style={{ fontFamily: MONO, fontSize: 18 }}>SWITCH & RERUN</div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Backdrop>
  );
};

/** 05 · before-after-slider-scrub + draw-svg-trace + contact-shadow-lift (General Workshop) */
export const WorkshopGeneralScene: React.FC<SceneProps> = () => {
  const f = useCurrentFrame(); // 146f
  // Fast scrub then slow inspection then lift cutout
  const slider = f < 34 ? mix(0.08, 0.88, ramp(f, 8, 26, outQuint)) : f < 74 ? mix(0.88, 0.42, ramp(f, 38, 30, outCubic)) : 1;
  const lift = ramp(f, 78, 22, backOut);
  const svgDraw = ramp(f, 24, 48, outCubic);
  const annotateIn = ramp(f, 100, 14, outCubic);
  const annotateOut = ramp(f, 132, 10, outCubic);
  const tileMix = ramp(f, 68, 36, outCubic);

  return (
    <Backdrop bg={C.paper}>
      <GridField opacity={0.025} />
      <TopTagBar tag="出图后不用开别的软件" />

      <div style={{ position: 'absolute', left: 72, top: 92, opacity: ramp(f, 2, 12) }}>
        <div style={{ fontSize: 62, fontWeight: 820, letterSpacing: -2, color: C.ink }}>
          出完图，不用开别的软件
        </div>
        <div style={{ marginTop: 8, fontSize: 28, color: C.secondary }}>
          去背透明底、位图转矢量、无缝平铺，都在里面
        </div>
      </div>

      {/* Left: BiRefNet Cutout scrub + contact-shadow-lift */}
      <div
        style={{
          position: 'absolute',
          left: 72,
          top: 245,
          width: 860,
          height: 750,
          background: '#fff',
          clipPath: CLIP.chamfer(32),
          border: '1px solid #d6d6de',
          overflow: 'hidden',
        }}
      >
        <Checkerboard size={32} />
        <div style={{ position: 'absolute', inset: 48, clipPath: `inset(0 0 0 ${slider * 100}%)`, opacity: 1 - lift }}>
          <Image src={WORKSHOP_ART.source} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
        </div>
        {/* Shadow beneath lifted cutout */}
        <div
          style={{
            position: 'absolute',
            left: '20%',
            right: '20%',
            bottom: 64,
            height: 44,
            borderRadius: '50%',
            background: '#141416',
            opacity: mix(0.08, 0.24, lift),
            filter: `blur(${mix(8, 24, lift)}px)`,
            transform: `scale(${mix(0.85, 1.15, lift)})`,
          }}
        />
        <div
          style={{
            position: 'absolute',
            inset: 48,
            clipPath: `inset(0 ${100 - slider * 100}% 0 0)`,
            transform: `translateY(${mix(0, -24, lift)}px) scale(${mix(1, 1.05, lift)})`,
          }}
        >
          <Image src={WORKSHOP_ART.cutout} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
        </div>

        {/* Scrub bar */}
        <div
          style={{
            position: 'absolute',
            left: slider * 860 - 2,
            top: 0,
            bottom: 0,
            width: 4,
            background: C.accent,
            boxShadow: `0 0 20px ${C.accent}`,
            opacity: 1 - lift,
          }}
        />

        <div style={{ position: 'absolute', left: 26, top: 24, padding: '8px 16px', background: C.ink, color: '#fff', fontFamily: MONO, fontSize: 18, clipPath: CLIP.chamfer(8) }}>
          BiRefNet / RMBG-2.0 · 去背透明底 PNG
        </div>
        <div style={{ position: 'absolute', right: 26, bottom: 24, padding: '8px 16px', background: '#fff', border: '1px solid #d4d4dc', fontFamily: MONO, fontSize: 18, color: C.ink }}>
          ALPHA 通道保留
        </div>

        {/* freeze-annotate: 去背完成后浮出孤立导出信息卡 */}
        {annotateIn > 0 && (
          <div style={{ position: 'absolute', left: 60, top: 60, opacity: annotateIn * (1 - annotateOut), transform: `translateY(${mix(18, 0, annotateIn)}px)`, pointerEvents: 'none', zIndex: 10 }}>
            <div style={{ background: C.ink, color: '#fff', clipPath: CLIP.chamfer(14), padding: '18px 26px', display: 'flex', flexDirection: 'column', gap: 10, minWidth: 320, boxShadow: '0 20px 60px rgba(0,0,0,0.5)' }}>
              <div style={{ fontFamily: MONO, fontSize: 15, color: C.accent, fontWeight: 700, letterSpacing: 1 }}>EXPORT // PNG-32</div>
              <div style={{ display: 'flex', gap: 24, alignItems: 'center' }}>
                <div style={{ width: 72, height: 72, clipPath: CLIP.chamfer(10), flexShrink: 0, position: 'relative', background: '#d8d8de', backgroundImage: 'linear-gradient(45deg,#b0b0b8 25%,transparent 25%),linear-gradient(-45deg,#b0b0b8 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#b0b0b8 75%),linear-gradient(-45deg,transparent 75%,#b0b0b8 75%)', backgroundSize: '14px 14px', backgroundPosition: '0 0, 0 7px, 7px -7px, -7px 0' }}>
                  <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(circle at 40% 40%, rgba(255,255,255,0.9) 0%, rgba(255,255,255,0.3) 60%, transparent 100%)' }} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ fontFamily: MONO, fontSize: 13, color: '#8888a0' }}>CHANNELS</span>
                    <span style={{ fontFamily: MONO, fontSize: 15, color: '#fff', fontWeight: 700 }}>R · G · B · A</span>
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ fontFamily: MONO, fontSize: 13, color: '#8888a0' }}>ALPHA</span>
                    <div style={{ display: 'flex', gap: 3 }}>
                      {([1,1,1,1,0.6,0.1,0,0] as number[]).map((op, i) => (
                        <div key={i} style={{ width: 14, height: 14, borderRadius: 2, background: `rgba(255,255,255,${op})`, border: '1px solid rgba(255,255,255,0.15)' }} />
                      ))}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ fontFamily: MONO, fontSize: 13, color: '#8888a0' }}>SIZE</span>
                    <span style={{ fontFamily: MONO, fontSize: 15, color: C.mint, fontWeight: 700 }}>1024 × 1024</span>
                  </div>
                </div>
              </div>
              <div style={{ height: 4, background: '#2e2e38', borderRadius: 2, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${Math.min(100, annotateIn * 110)}%`, background: `linear-gradient(90deg, ${C.mint}, ${C.cobalt})`, borderRadius: 2 }} />
              </div>
            </div>
            <svg width="90" height="28" viewBox="0 0 90 28" style={{ display: 'block', marginLeft: 32 }}>
              <path d="M4 14 L78 14 M64 4 L82 14 L64 24" stroke={C.accent} strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="90" strokeDashoffset={`${mix(90, 0, annotateIn)}`} />
            </svg>
          </div>
        )}
      </div>

      {/* Right Top: Vectorize (VTracer WASM) + draw-svg-trace */}
      <div
        style={{
          position: 'absolute',
          left: 968,
          right: 72,
          top: 245,
          height: 360,
          background: C.ink,
          color: '#fff',
          clipPath: CLIP.chamfer(28),
          padding: 32,
          boxSizing: 'border-box',
          display: 'flex',
          alignItems: 'center',
          gap: 32,
        }}
      >
        <div style={{ position: 'relative', width: 250, height: 250, background: '#1e1e24', borderRadius: 20, display: 'grid', placeItems: 'center', overflow: 'hidden' }}>
          <Image src={WORKSHOP_ART.vectorBefore} style={{ position: 'absolute', width: 170, height: 170, imageRendering: 'pixelated', opacity: 1 - ramp(f, 36, 16) }} />
          <Image src={WORKSHOP_ART.vectorAfter} style={{ position: 'absolute', width: 190, height: 190, opacity: ramp(f, 36, 16) }} />
          {/* draw-svg-trace perimeter ring */}
          <svg width="250" height="250" viewBox="0 0 250 250" style={{ position: 'absolute', inset: 0 }}>
            <rect
              x="12"
              y="12"
              width="226"
              height="226"
              rx="16"
              fill="none"
              stroke={C.accent}
              strokeWidth="4"
              pathLength="1"
              strokeDasharray="1"
              strokeDashoffset={1 - svgDraw}
            />
          </svg>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: MONO, fontSize: 17, color: C.accent }}>LOCAL WASM // 0 显存</div>
          <div style={{ marginTop: 10, fontSize: 38, fontWeight: 800 }}>位图转 SVG 矢量</div>
          <div style={{ marginTop: 12, fontSize: 22, color: '#b4b4c0', lineHeight: 1.45 }}>
            本机离线跑，不占显存
            <br />
            Logo 和扁平插画直接导出可编辑路径
          </div>
        </div>
      </div>

      {/* Right Bottom: 2x2 Seamless Tile Check */}
      <div
        style={{
          position: 'absolute',
          left: 968,
          right: 72,
          top: 635,
          height: 360,
          background: '#fff',
          border: '1px solid #d6d6de',
          clipPath: CLIP.chamfer(28),
          padding: 32,
          boxSizing: 'border-box',
          display: 'flex',
          alignItems: 'center',
          gap: 32,
        }}
      >
        <div style={{ position: 'relative', width: 250, height: 250, display: 'flex', alignItems: 'center', gap: 10 }}>
          {/* 有缝 SVG */}
          <div style={{ flex: 1, position: 'relative', opacity: 1 - tileMix * 0.5 }}>
            <Image src="art/tile-seamed.svg" style={{ width: 100, height: 100, clipPath: CLIP.chamfer(10), display: 'block' }} />
            <div style={{ marginTop: 6, fontFamily: MONO, fontSize: 11, color: C.secondary, textAlign: 'center' }}>有缝</div>
          </div>
          {/* 箭头 */}
          <svg width="28" height="20" viewBox="0 0 28 20" style={{ flexShrink: 0 }}>
            <path d={`M2 10 L${mix(2, 22, tileMix)} 10 M${mix(14, 18, tileMix)} 4 L${mix(14, 26, tileMix)} 10 L${mix(14, 18, tileMix)} 16`}
              stroke={tileMix > 0.5 ? C.mint : C.accent} strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round"
              opacity={Math.max(0.3, tileMix)}
            />
          </svg>
          {/* 无缝 SVG */}
          <div style={{ flex: 1, position: 'relative', opacity: 0.3 + tileMix * 0.7 }}>
            <Image src="art/tile-seamless.svg" style={{ width: 100, height: 100, clipPath: CLIP.chamfer(10), display: 'block' }} />
            <div style={{ marginTop: 6, fontFamily: MONO, fontSize: 11, color: tileMix > 0.5 ? C.mint : C.secondary, textAlign: 'center' }}>无缝</div>
          </div>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: MONO, fontSize: 17, color: tileMix > 0.6 ? C.mint : C.accent }}>
            {tileMix > 0.6 ? 'SEAM BLENDED // 2×2 PASS' : '2×2 SEAM CHECK'}
          </div>
          <div style={{ marginTop: 10, fontSize: 38, fontWeight: 800, color: C.ink }}>无缝平铺校验</div>
          <div style={{ marginTop: 12, fontSize: 22, color: C.secondary, lineHeight: 1.45 }}>
            实时 2×2 预览接缝
            <br />
            一键混边消除边界断层
          </div>
        </div>
      </div>
    </Backdrop>
  );
};
