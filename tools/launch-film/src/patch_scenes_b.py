path = r'D:\document\development\aigc-studio\tools\launch-film\src\scenesB.tsx'
with open(path, 'r', encoding='utf-8') as f:
    c = f.read()

# ── 文案补回 ──
copy_fixes = [
    ('tag="独立游戏开发"', 'tag="游戏资产从出图到导出"'),
    ('游戏开发所需资产，直接导出成包', '游戏资产从出图到导出，一套工具'),
    ('像素网格对齐 · 序列帧切片与 atlas.json · Marigold 四通道 PBR 贴图', '像素对齐、序列帧切片、PBR 四通道拆解'),
    ('tag="算力热切换 · MCP"', 'tag="算力随时切换"'),
    ('算力随时切换，控制面留在本地', 'Kaggle 每周给 30 小时免费 GPU'),
    ('接入 Kaggle、Colab、商业 API、私有 Worker 或本机 Vulkan · 支持 MCP 连接 Agent', '够跑 17,000 张，Colab、私有 Worker、本机 Vulkan 随时切'),
    ("{ role: '游戏开发者', line: '去背、像素对齐、序列帧与 PBR 一体导出' }", "{ role: '游戏开发者', line: '去背到 PBR，一套工具出完' }"),
    ("{ role: '技术极客', line: '算力自由切换，本地加密存储，支持 MCP' }", "{ role: '技术极客', line: 'Kaggle、Colab、本地，算力随时换' }"),
    ('界面留在本地，算力交给云端，文件留在你的硬盘。', '你只管描述，剩下的交给它。'),
    ('KAGGLE 2×T4 免费双卡（SDXL LIGHTNING 实测约 6.2 秒/张）', 'Kaggle 2×T4 双卡，SDXL Lightning 实测约 6 秒一张'),
]
for old, new in copy_fixes:
    c = c.replace(old, new)

# ── quad-split 逐格错开进场：只替换 opacity，加 transform ──
# Q1: ramp(f, 0, 10) -> enterP with burst
c = c.replace(
    "overflow: 'hidden', opacity: ramp(f, 0, 10) }}>",
    "overflow: 'hidden', opacity: ramp(f, 0, 12, backOut), transform: `scale(${1 + (f >= 0 && f <= 8 ? Math.sin((f / 8) * Math.PI) * 0.055 : 0)})` }}>",
    1
)
# Q2: ramp(f, 5, 10) -> staggered
c = c.replace(
    "overflow: 'hidden', opacity: ramp(f, 5, 10), padding: 28",
    "overflow: 'hidden', opacity: ramp(f, 8, 12, backOut), padding: 28, transform: `scale(${1 + (f >= 8 && f <= 16 ? Math.sin(((f - 8) / 8) * Math.PI) * 0.055 : 0)})`",
    1
)
# Q3: ramp(f, 10, 10) -> staggered
c = c.replace(
    "color: '#fff', clipPath: CLIP.chamfer(24), overflow: 'hidden', opacity: ramp(f, 10, 10) }}>",
    "color: '#fff', clipPath: CLIP.chamfer(24), overflow: 'hidden', opacity: ramp(f, 16, 12, backOut), transform: `scale(${1 + (f >= 16 && f <= 24 ? Math.sin(((f - 16) / 8) * Math.PI) * 0.055 : 0)})` }}>",
    1
)
# Q4: ramp(f, 15, 10) -> staggered
c = c.replace(
    "background: C.ink2, clipPath: CLIP.chamfer(24), overflow: 'hidden', opacity: ramp(f, 15, 10) }}>",
    "background: C.ink2, clipPath: CLIP.chamfer(24), overflow: 'hidden', opacity: ramp(f, 24, 12, backOut), transform: `scale(${1 + (f >= 24 && f <= 32 ? Math.sin(((f - 24) / 8) * Math.PI) * 0.055 : 0)})` }}>",
    1
)

with open(path, 'w', encoding='utf-8') as f:
    f.write(c)
print('scenesB patched')
