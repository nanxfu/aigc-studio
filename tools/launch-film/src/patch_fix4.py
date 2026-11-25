path_a = r'D:\document\development\aigc-studio\tools\launch-film\src\scenesA.tsx'
path_t = r'D:\document\development\aigc-studio\tools\launch-film\src\transitions.tsx'
path_tl = r'D:\document\development\aigc-studio\tools\launch-film\src\timeline.ts'

# ── 1. Bumper 第一张卡图片：botanical -> street (赛博朋克，和"还在配环境？"匹配) ──
with open(path_a, 'r', encoding='utf-8') as f:
    ca = f.read()

ca = ca.replace(
    "{ text: '还在配环境？', sub: '打开就能用', src: ART.botanical, bg: C.paper, fg: C.ink, clip: CLIP.slashLeft }",
    "{ text: '还在配环境？', sub: '打开就能用', src: ART.street, bg: C.ink, fg: C.paper, clip: CLIP.slashLeft }",
    1
)

# ── 2. MaskOpen：功能标签行加 Kaggle 免费额度高亮胶囊 ──
old_pill = """            <span style={{ color: C.accent }}>●</span>
            <span>图像生成</span>
            <span>·</span>
            <span>资产工坊</span>
            <span>·</span>
            <span>视频入口</span>
            <span>·</span>
            <span>MCP</span>"""

new_pill = """            <span style={{ color: C.accent }}>●</span>
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
            </span>"""

ca = ca.replace(old_pill, new_pill, 1)

with open(path_a, 'w', encoding='utf-8') as f:
    f.write(ca)
print('scenesA done')

# ── 3. ThemeSweep：转场延长到 32 帧，文字重新加回来且停留足够 ──
with open(path_t, 'r', encoding='utf-8') as f:
    ct = f.read()

# 文字加回来，透明度曲线改成更长的停留
ct = ct.replace(
    "ThemeSweepTransition: React.FC<{ label?: string }> = ({ label = '' }) => {\n  const f = useCurrentFrame(); // 16f total\n  const p = ramp(f, 0, 15, outCubic);\n  const x = mix(-220, 2140, p);\n  const tai",
    "ThemeSweepTransition: React.FC<{ label?: string }> = ({ label = '\u7b97\u529b\u514d\u8d39\uff0c\u8fd9\u662f\u5168\u90e8\u529f\u80fd' }) => {\n  const f = useCurrentFrame(); // 32f total\n  const p = ramp(f, 0, 28, outCubic);\n  const x = mix(-220, 2140, p);\n  const tai",
    1
)

# textIn/textOut 时机拉长：在 f=4 进，f=24 才开始退
ct = ct.replace(
    "  const textIn = clamp01((f - 2) / 5);\n  const textOut = clamp01(1 - (f - 10) / 4);",
    "  const textIn = clamp01((f - 4) / 6);\n  const textOut = clamp01(1 - (f - 22) / 6);",
    1
)

with open(path_t, 'w', encoding='utf-8') as f:
    f.write(ct)
print('transitions done')

# ── 4. timeline：sweep-dark 转场 duration 从 16 -> 32 ──
with open(path_tl, 'r', encoding='utf-8') as f:
    ctl = f.read()

ctl = ctl.replace(
    "{ id: 'sweep-dark', label: '\u659c\u8fb9\u6362\u80a4', from: beatF(54) - 8, duration: 16, component: ThemeSweepTransition }",
    "{ id: 'sweep-dark', label: '\u659c\u8fb9\u6362\u80a4', from: beatF(54) - 16, duration: 32, component: ThemeSweepTransition }",
    1
)

with open(path_tl, 'w', encoding='utf-8') as f:
    f.write(ctl)
print('timeline done')
