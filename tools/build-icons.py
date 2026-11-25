#!/usr/bin/env python3
"""生成应用图标资产（build/icon.png / icon.ico / icon.icns）。

设计采用「暗房光桌 · 裁切 A 与安全灯点」方案（对齐工作室黑白灰 + #E6613E 视觉语言）：
墨黑渐变圆角磁贴（#19191D → #101013）+ 细微倒角高光框 + 两页斜切相纸构成的几何「A」
（#FFFFFF → #DFDFDA）+ 右上角暗房安全灯校准圆点（#E6613E）。

使用参数化矢量坐标在 4× 超采样下重绘并 LANCZOS 降采样，产出：

  build/icon.png   1024×1024  PNG（macOS / Linux 打包与运行时托盘图标源）
  build/icon.ico   16/24/32/48/64/128/256 多尺寸 Windows 图标（NSIS 与窗口图标）
  build/icon.icns  16/32/64/128/256/512/1024 多尺寸 macOS 图标

用法：
  python tools/build-icons.py           # 重新生成三份资产
  python tools/build-icons.py --check    # 只校验现有资产（尺寸 / 尺寸表 / 无缺失）
  python tools/build-icons.py --sync-site  # 同步生成官网 site/public/assets/logo.png

依赖：Pillow（本机 DSH 运行时自带；仓库的 electron-builder 打包不依赖本脚本）。
"""

from __future__ import annotations

import base64
import io
import struct
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
BUILD_DIR = ROOT / "build"
SITE_LOGO_PATH = ROOT / "site" / "public" / "assets" / "logo.png"

# ---- 设计参数（1024 画布坐标系，与前端 web/index.html favicon 同源） ----
CANVAS = 1024
SS = 4  # 超采样倍数，绘制完再 LANCZOS 降采样

MARGIN = 32
TILE = CANVAS - MARGIN * 2  # 960
TILE_RADIUS = 204

TILE_GRADIENT_FROM = (25, 25, 29)  # #19191D 左上
TILE_GRADIENT_TO = (16, 16, 19)  # #101013 右下
RIM_COLOR = (255, 255, 255, 26)  # 10% 细微金属倒角边框
RIM_STROKE = 6

# 两页斜切相纸构成的「A」字形（左侧翼+横梁 / 右侧分离折脚）
PAPER_TOP = (255, 255, 255)  # #FFFFFF
PAPER_BOTTOM = (223, 223, 218)  # #DFDFDA
PAPER_GRADIENT_Y0 = 220
PAPER_GRADIENT_Y1 = 780
LEFT_WING_POLY = [
    (236, 772),
    (462, 232),
    (572, 232),
    (434, 562),
    (584, 562),
    (542, 662),
    (392, 662),
    (346, 772),
]
RIGHT_LEG_POLY = [
    (582, 326),
    (776, 772),
    (662, 772),
    (528, 456),
]

# 暗房安全灯校准点
SAFELIGHT_CENTER = (728, 296)
SAFELIGHT_RADIUS = 54
SAFELIGHT_COLOR = (230, 97, 62, 255)  # #E6613E

ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
ICNS_SIZES = [16, 32, 64, 128, 256, 512, 1024]
# ICNS 类型码（PNG 数据）。ic07~ic10 已是 128~1024，icp4~icp6 覆盖小图标。
ICNS_TYPES = {16: b"icp4", 32: b"icp5", 64: b"icp6", 128: b"ic07", 256: b"ic08", 512: b"ic09", 1024: b"ic10"}


def diagonal_gradient_layer(size: int, c_from: tuple[int, int, int], c_to: tuple[int, int, int]) -> Image.Image:
    """按 (x + y) 对角线生成线性渐变；t=0 在磁贴左上角，t=1 在右下角。"""
    small = 256
    step = size / small
    span = 2 * TILE * SS
    x0 = MARGIN * SS
    layer = Image.new("RGB", (small, small))
    px = layer.load()
    for y in range(small):
        yf = (y + 0.5) * step
        for x in range(small):
            xf = (x + 0.5) * step
            t = ((xf - x0) + (yf - x0)) / span
            t = 0.0 if t < 0 else (1.0 if t > 1 else t)
            px[x, y] = tuple(round(a + (b - a) * t) for a, b in zip(c_from, c_to))
    return layer.resize((size, size), Image.BILINEAR)


def vertical_gradient_layer(size: int, c_from: tuple[int, int, int], c_to: tuple[int, int, int], y0: int, y1: int) -> Image.Image:
    """按 y 生成纵向相纸明度渐变。"""
    small_h = 256
    step = size / small_h
    span = (y1 - y0) * SS
    y_start = y0 * SS
    strip = Image.new("RGB", (1, small_h))
    px = strip.load()
    for y in range(small_h):
        yf = (y + 0.5) * step
        t = (yf - y_start) / span
        t = 0.0 if t < 0 else (1.0 if t > 1 else t)
        px[0, y] = tuple(round(a + (b - a) * t) for a, b in zip(c_from, c_to))
    return strip.resize((size, size), Image.BILINEAR)


def rounded_mask(box, radius: int) -> Image.Image:
    mask = Image.new("L", (CANVAS * SS, CANVAS * SS), 0)
    ImageDraw.Draw(mask).rounded_rectangle(box, radius=radius, fill=255)
    return mask


def scale_poly(points: list[tuple[int, int]], factor: int) -> list[tuple[int, int]]:
    return [(x * factor, y * factor) for x, y in points]


def render_master() -> Image.Image:
    """在 SS 倍画布上绘制母图，降采样到 1024。"""
    size = CANVAS * SS
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    tile_grad = diagonal_gradient_layer(size, TILE_GRADIENT_FROM, TILE_GRADIENT_TO).convert("RGBA")

    x0, y0 = MARGIN * SS, MARGIN * SS
    tile_box = (x0, y0, x0 + TILE * SS - 1, y0 + TILE * SS - 1)
    canvas.paste(tile_grad, (0, 0), rounded_mask(tile_box, TILE_RADIUS * SS))

    # 细微倒角高光边框，保证在深色任务栏/暗房背景上也有清晰边缘
    rim_inset = (RIM_STROKE // 2) * SS
    rim_box = (
        x0 + rim_inset,
        y0 + rim_inset,
        x0 + TILE * SS - 1 - rim_inset,
        y0 + TILE * SS - 1 - rim_inset,
    )
    rim_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(rim_layer).rounded_rectangle(
        rim_box,
        radius=(TILE_RADIUS - RIM_STROKE // 2) * SS,
        outline=RIM_COLOR,
        width=RIM_STROKE * SS,
    )
    canvas = Image.alpha_composite(canvas, rim_layer)

    # 两页斜切相纸构成 Monogram A
    paper_grad = vertical_gradient_layer(size, PAPER_TOP, PAPER_BOTTOM, PAPER_GRADIENT_Y0, PAPER_GRADIENT_Y1).convert("RGBA")
    paper_mask = Image.new("L", (size, size), 0)
    mask_draw = ImageDraw.Draw(paper_mask)
    mask_draw.polygon(scale_poly(LEFT_WING_POLY, SS), fill=255)
    mask_draw.polygon(scale_poly(RIGHT_LEG_POLY, SS), fill=255)
    canvas.paste(paper_grad, (0, 0), paper_mask)

    # 暗房安全灯校准点
    dot_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    dx, dy = SAFELIGHT_CENTER[0] * SS, SAFELIGHT_CENTER[1] * SS
    dr = SAFELIGHT_RADIUS * SS
    ImageDraw.Draw(dot_layer).ellipse((dx - dr, dy - dr, dx + dr - 1, dy + dr - 1), fill=SAFELIGHT_COLOR)
    canvas = Image.alpha_composite(canvas, dot_layer)

    return canvas.resize((CANVAS, CANVAS), Image.LANCZOS)


def render_size(master: Image.Image, size: int) -> Image.Image:
    return master.resize((size, size), Image.LANCZOS)


def write_ico(master: Image.Image, path: Path) -> None:
    master.save(path, format="ICO", sizes=[(s, s) for s in ICO_SIZES])


def write_icns(master: Image.Image, path: Path) -> None:
    chunks = []
    for size in ICNS_SIZES:
        buf = io.BytesIO()
        render_size(master, size).save(buf, format="PNG", optimize=True)
        payload = buf.getvalue()
        chunk = ICNS_TYPES[size] + struct.pack(">I", 8 + len(payload)) + payload
        chunks.append(chunk)
    body = b"".join(chunks)
    path.write_bytes(b"icns" + struct.pack(">I", 8 + len(body)) + body)


def render_tray_data_url(master: Image.Image, size: int = 64) -> str:
    buf = io.BytesIO()
    render_size(master, size).save(buf, format="PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def ico_entries(path: Path) -> list[int]:
    data = path.read_bytes()
    reserved, kind, count = struct.unpack("<HHH", data[:6])
    assert reserved == 0 and kind == 1, "不是合法 ICO"
    sizes = []
    for i in range(count):
        raw, = struct.unpack("<B", data[6 + i * 16 : 7 + i * 16])
        sizes.append(256 if raw == 0 else raw)
    return sorted(sizes)


def icns_entries(path: Path) -> list[str]:
    data = path.read_bytes()
    assert data[:4] == b"icns", "不是合法 ICNS"
    total, = struct.unpack(">I", data[4:8])
    assert total == len(data), "ICNS 长度字段与文件大小不符"
    entries, pos = [], 8
    while pos < len(data):
        code = data[pos : pos + 4]
        length, = struct.unpack(">I", data[pos + 4 : pos + 8])
        assert length >= 8, f"ICNS 块 {code!r} 长度非法"
        entries.append(code.decode("ascii"))
        pos += length
    return entries


def build(sync_site: bool = False) -> int:
    BUILD_DIR.mkdir(parents=True, exist_ok=True)
    master = render_master()
    png, ico, icns = BUILD_DIR / "icon.png", BUILD_DIR / "icon.ico", BUILD_DIR / "icon.icns"
    master.save(png, format="PNG", optimize=True)
    write_ico(master, ico)
    write_icns(master, icns)
    print(f"已生成 {png.relative_to(ROOT)}（{CANVAS}×{CANVAS}）")
    print(f"已生成 {ico.relative_to(ROOT)}（{ico_entries(ico)}）")
    print(f"已生成 {icns.relative_to(ROOT)}（{icns_entries(icns)}）")
    if sync_site:
        SITE_LOGO_PATH.parent.mkdir(parents=True, exist_ok=True)
        master.save(SITE_LOGO_PATH, format="PNG", optimize=True)
        print(f"已同步 {SITE_LOGO_PATH.relative_to(ROOT)}（{CANVAS}×{CANVAS}）")
    return 0


def check() -> int:
    ok = True
    png, ico, icns = BUILD_DIR / "icon.png", BUILD_DIR / "icon.ico", BUILD_DIR / "icon.icns"
    if not png.exists():
        print(f"缺少 {png.relative_to(ROOT)}")
        ok = False
    else:
        with Image.open(png) as im:
            size = im.size
        if size != (CANVAS, CANVAS):
            print(f"{png.relative_to(ROOT)} 尺寸 {size[0]}×{size[1]}，应为 {CANVAS}×{CANVAS}")
            ok = False
        else:
            print(f"PASS {png.relative_to(ROOT)}：{CANVAS}×{CANVAS}")
    if not ico.exists():
        print(f"缺少 {ico.relative_to(ROOT)}")
        ok = False
    else:
        sizes = ico_entries(ico)
        if sizes != ICO_SIZES:
            print(f"{ico.relative_to(ROOT)} 尺寸表 {sizes}，应为 {ICO_SIZES}")
            ok = False
        else:
            print(f"PASS {ico.relative_to(ROOT)}：{sizes}")
    if not icns.exists():
        print(f"缺少 {icns.relative_to(ROOT)}")
        ok = False
    else:
        entries = icns_entries(icns)
        expected = [ICNS_TYPES[s].decode() for s in ICNS_SIZES]
        if entries != expected:
            print(f"{icns.relative_to(ROOT)} 块 {entries}，应为 {expected}")
            ok = False
        else:
            print(f"PASS {icns.relative_to(ROOT)}：{entries}")
    return 0 if ok else 1


def main(argv: list[str]) -> int:
    if "--check" in argv:
        return check()
    if "--tray-data-url" in argv:
        print(render_tray_data_url(render_master()))
        return 0
    return build(sync_site="--sync-site" in argv)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
