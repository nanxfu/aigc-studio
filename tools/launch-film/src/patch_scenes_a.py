import re

path = r'D:\document\development\aigc-studio\tools\launch-film\src\scenesA.tsx'
with open(path, 'r', encoding='utf-8') as f:
    c = f.read()

replacements = [
    ("{ text: '写中文就能画', sub: '8 款开源模型'", "{ text: '还在配环境？', sub: '打开就能用'"),
    ("{ text: '去背 · 转SVG · PBR', sub: '内置后处理工坊'", "{ text: '去背、转矢量、PBR', sub: '出图后直接用'"),
    ("{ text: '免费云端双卡', sub: 'KAGGLE / COLAB / API'", "{ text: 'Kaggle 免费 GPU', sub: '每周 30 小时'"),
    ("{ text: '本地桌面工作台', sub: '无 PYTHON 依赖'", "{ text: '本地运行', sub: '零 Python 依赖'"),
    ('无需独立显卡，也不用配置 Python 与 ComfyUI', '不用装 Python，不用配 ComfyUI，打开就能用'),
    ('section="01 / 直接生图" tag="普通创作者"', 'section="01 / 直接生图" tag="写中文直接出图"'),
    ('打开就能画，写中文就可以', '说个大概，AI 补齐细节'),
    ('内置 8 款开源生图模型与商业 API，省去本地部署流程', '内置 8 款常用模型，不用装 Python，不用配 ComfyUI'),
    ('自动存入工作区', '自动存进工作区'),
    ('支持局部涂抹重绘、', '支持局部重绘、'),
    ('整图高清放大与扩图', '高清放大与扩图'),
    ('tag="参数可改 · 模型可换"', 'tag="参数可改，模型可换"'),
    ('描述不够具体，让助手拆成可改参数', '描述模糊也没关系，助手帮你拆成可改的参数'),
    ('同一组结构化参数，随时切换模型重绘对比', '同一组参数，随时换模型重跑对比'),
    ('不自动改写原文，每一项均可手动微调', '不改原文，每一项都能手动调'),
    ('参数复用不重打', '参数不用重打'),
    ('tag="普通设计 & 全人群后处理"', 'tag="出图后不用开别的软件"'),
    ('内置工坊，出图后直接处理', '出完图，不用开别的软件'),
    ('出图后不用切换外部软件：去背透明底 · 本机离线转 SVG · 2×2 无缝平铺', '去背透明底、位图转矢量、无缝平铺，都在里面'),
    ('内置 @visioncortex/vtracer', '本机离线跑，不占显存'),
    ('Logo 与扁平插画离线导出可编辑路径', 'Logo 和扁平插画直接导出可编辑路径'),
    ('实时 2×2 拼图检测接缝', '实时 2×2 预览接缝'),
    ('余弦混边一键消除边界断层', '一键混边消除边界断层'),
]

for old, new in replacements:
    c = c.replace(old, new)

# ── steep-tilt-glide 变量（插在 pan 之后）──
PAN_LINE = "  const pan = interpolate(f, [0, 95], [0, -360], { extrapolateRight: 'clamp' });"
GLIDE_VARS = """  const pan = interpolate(f, [0, 95], [0, -360], { extrapolateRight: 'clamp' });
  // steep-tilt-glide: 孤立 UI 面板以 60° 大倾角从右侧贴面飞入 (f=52..84)
  const glideP = ramp(f, 52, 32, outCubic);
  const glideX = mix(1600, 180, glideP);
  const glideRotY = mix(-62, -18, glideP);
  const glideOpacity = glideP < 0.05 ? glideP * 20 : f > 80 ? 1 - ramp(f, 80, 6) : 1;"""
c = c.replace(PAN_LINE, GLIDE_VARS, 1)

# ── steep-tilt-glide JSX（插在 MaskOpen 结尾 </AbsoluteFill> 前）──
MASK_CLOSE = """      </AbsoluteFill>
    </Backdrop>
  );
};


/** 03 · aurora-bloom-bg"""
MASK_CLOSE_NEW = """      </AbsoluteFill>

      {/* steep-tilt-glide: 手绘孤立 UI 面板 */}
      {glideOpacity > 0 && (
        <div style={{ position: 'absolute', left: glideX, top: 148, width: 760, height: 580, perspective: '900px', pointerEvents: 'none', zIndex: 20, opacity: glideOpacity }}>
          <div style={{ width: '100%', height: '100%', transform: `rotateY(${glideRotY}deg) rotateX(6deg)`, transformStyle: 'preserve-3d', transformOrigin: 'left center' }}>
            <div style={{ width: '100%', height: '100%', background: '#f5f5f6', clipPath: CLIP.chamfer(20), boxShadow: '0 40px 100px -20px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.08)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              {/* 顶部工具栏 */}
              <div style={{ height: 44, background: '#ececee', display: 'flex', alignItems: 'center', padding: '0 16px', gap: 10, flexShrink: 0, borderBottom: '1px solid #d8d8de' }}>
                <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#ff5f56' }} />
                <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#febc2e' }} />
                <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#28c840' }} />
                <div style={{ marginLeft: 12, flex: 1, height: 22, background: '#dcdce0', borderRadius: 6 }} />
                <div style={{ width: 60, height: 22, background: C.accent, borderRadius: 5, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <span style={{ fontFamily: MONO, fontSize: 11, color: '#fff', fontWeight: 700 }}>生成</span>
                </div>
              </div>
              {/* 主体: 左侧面板 + 右侧画布 */}
              <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
                <div style={{ width: 200, background: '#fafafa', borderRight: '1px solid #dedee3', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {[{ label: '提示词', h: 54, accent: true }, { label: '模型', h: 28 }, { label: '步数', h: 28 }, { label: '尺寸', h: 28 }].map(({ label, h, accent }) => (
                    <div key={label}>
                      <div style={{ fontFamily: MONO, fontSize: 10, color: '#9898a2', marginBottom: 4 }}>{label}</div>
                      <div style={{ height: h, background: accent ? '#fff3f1' : '#ececee', borderRadius: 6, border: accent ? `1px solid ${C.accent}44` : '1px solid #dedee3' }} />
                    </div>
                  ))}
                </div>
                <div style={{ flex: 1, background: '#e8e8ec', display: 'grid', placeItems: 'center', position: 'relative' }}>
                  <Image src={BENCH.qwen_scifi} style={{ width: 320, height: 320, objectFit: 'cover', clipPath: CLIP.chamfer(12), boxShadow: '0 12px 36px rgba(0,0,0,0.25)' }} />
                  <div style={{ position: 'absolute', bottom: 16, right: 16, padding: '6px 12px', background: C.mint, color: '#fff', fontFamily: MONO, fontSize: 11, fontWeight: 700, clipPath: CLIP.chamfer(5) }}>✓ DONE · 1024×1024</div>
                </div>
              </div>
              {/* 底部胶片条 */}
              <div style={{ height: 54, background: '#ececee', borderTop: '1px solid #d8d8de', display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px', flexShrink: 0 }}>
                {[C.accent, '#dcdce0', '#dcdce0', '#dcdce0', '#dcdce0'].map((bg, i) => (
                  <div key={i} style={{ width: 44, height: 38, background: bg, borderRadius: 6, border: i === 0 ? `2px solid ${C.accent}` : '1px solid #c8c8ce' }} />
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </Backdrop>
  );
};


/** 03 · aurora-bloom-bg"""
c = c.replace(MASK_CLOSE, MASK_CLOSE_NEW, 1)

# ── freeze-annotate 变量（WorkshopGeneral, svgDraw 之后）──
SVG_DRAW = "  const svgDraw = ramp(f, 24, 48, outCubic);"
SVG_DRAW_NEW = """  const svgDraw = ramp(f, 24, 48, outCubic);
  const annotateIn = ramp(f, 100, 14, outCubic);
  const annotateOut = ramp(f, 132, 10, outCubic);"""
c = c.replace(SVG_DRAW, SVG_DRAW_NEW, 1)

# ── freeze-annotate JSX（插在 ALPHA 通道保留 div 结尾之后）──
ALPHA_TAG = """          ALPHA 通道保留
        </div>
      </div>

      {/* Right Top: Vectorize"""
ALPHA_TAG_NEW = """          ALPHA 通道保留
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

      {/* Right Top: Vectorize"""
c = c.replace(ALPHA_TAG, ALPHA_TAG_NEW, 1)

# ── title-demote-to-label（OrdinaryCreate 标题包装）──
TITLE_OPEN = "      {/* Headline with spotlight-sweep */}\n      <div style={{ position: 'absolute', left: 72, top: 92, opacity: ramp(f, 4, 12) }}>"
TITLE_OPEN_NEW = """      {/* Headline with spotlight-sweep + title-demote-to-label */}
      {(() => {
        const demote = ramp(f, 56, 18, outCubic);
        const titleScale = mix(1, 0.46, demote);
        const titleX = mix(0, -36, demote);
        const titleY = mix(0, -54, demote);
        const titleOpacity = ramp(f, 4, 12) * (f > 100 ? 1 - ramp(f, 100, 10) : 1);
        return (
      <div style={{ position: 'absolute', left: 72, top: 92, opacity: titleOpacity, transform: `translate(${titleX}px, ${titleY}px) scale(${titleScale})`, transformOrigin: 'left top', zIndex: 10 }}>"""
c = c.replace(TITLE_OPEN, TITLE_OPEN_NEW, 1)

TITLE_CLOSE = "        <div style={{ marginTop: 8, fontSize: 28, color: '#c8c8d4' }}>\n          内置 8 款常用模型，不用装 Python，不用配 ComfyUI\n        </div>\n      </div>"
TITLE_CLOSE_NEW = "        <div style={{ marginTop: 8, fontSize: 28, color: '#c8c8d4' }}>\n          内置 8 款常用模型，不用装 Python，不用配 ComfyUI\n        </div>\n      </div>\n        );\n      })()} "
c = c.replace(TITLE_CLOSE, TITLE_CLOSE_NEW, 1)

with open(path, 'w', encoding='utf-8') as f:
    f.write(c)
print('all patches applied')
