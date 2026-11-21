#!/usr/bin/env python3
"""生成应用图标资产（build/icon.png / icon.ico / icon.icns）。

设计沿用 Phase 1 的 256×256 图标：蓝色对角渐变圆角磁贴 + 白色圆角取景框 + 白色圆环
与深蓝圆心。这里改用参数化矢量方式在 4× 超采样下重绘，产出：

  build/icon.png   1024×1024  PNG（macOS / Linux 打包与运行时托盘图标源）
  build/icon.ico   16/24/32/48/64/128/256 多尺寸 Windows 图标（NSIS 与窗口图标）
  build/icon.icns  16/32/64/128/256/512/1024 多尺寸 macOS 图标

用法：
  python tools/build-icons.py           # 重新生成三份资产
  python tools/build-icons.py --check    # 只校验现有资产（尺寸 / 尺寸表 / 无缺失）

依赖：Pillow（本机 DSH 运行时自带；仓库的 electron-builder 打包不依赖本脚本）。
"""

from __future__ import annotations

import struct
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
BUILD_DIR = ROOT / "build"

# ---- 设计参数（1024 画布坐标系，数值按 256×256 原始图 ×4 量取） ----
CANVAS = 1024
SS = 4  # 超采样倍数，绘制完再 LANCZOS 降采样

MARGIN = 32
TILE = CANVAS - MARGIN * 2  # 960
TILE_RADIUS = 198  # ≈ 20.6% 磁贴边长

GRADIENT_FROM = (76, 73, 228)  # #4C49E4 左上
GRADIENT_TO = (8, 178, 212)  # #08B2D4 右下

FRAME_INSET = 184  # 磁贴内缩 46×4
FRAME = TILE - FRAME_INSET * 2  # 592
FRAME_RADIUS = 92
FRAME_STROKE = 56

CENTER = CANVAS // 2
RING_OUTER = 122
RING_INNER = 58
RING_HOLE_COLOR = (37, 99, 235)  # #2563EB

ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
ICNS_SIZES = [16, 32, 64, 128, 256, 512, 1024]
# ICNS 类型码（PNG 数据）。ic07~ic10 已是 128~1024，icp4~icp6 覆盖小图标。
ICNS_TYPES = {16: b"icp4", 32: b"icp5", 64: b"icp6", 128: b"ic07", 256: b"ic08", 512: b"ic09", 1024: b"ic10"}


def gradient_layer(size: int) -> Image.Image:
    """按 (x + y) 对角线生成渐变；t=0 在磁贴左上角，t=1 在右下角。

    渐变是 (x+y) 的线性函数，因此先在 256×256 的小图上算好再双线性放大到目标尺寸，
    结果与逐像素计算一致，但不用 Python 循环遍历上千万像素。
    """
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
            px[x, y] = tuple(round(a + (b - a) * t) for a, b in zip(GRADIENT_FROM, GRADIENT_TO))
    return layer.resize((size, size), Image.BILINEAR)


def rounded_mask(box, radius: int) -> Image.Image:
    mask = Image.new("L", (CANVAS * SS, CANVAS * SS), 0)
    ImageDraw.Draw(mask).rounded_rectangle(box, radius=radius, fill=255)
    return mask


def render_master() -> Image.Image:
    """在 SS 倍画布上绘制母图，降采样到 1024。"""
    size = CANVAS * SS
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    grad = gradient_layer(size).convert("RGBA")

    x0, y0 = MARGIN * SS, MARGIN * SS
    tile_box = (x0, y0, x0 + TILE * SS - 1, y0 + TILE * SS - 1)
    canvas.paste(grad, (0, 0), rounded_mask(tile_box, TILE_RADIUS * SS))

    draw = ImageDraw.Draw(canvas)
    fx0, fy0 = (MARGIN + FRAME_INSET) * SS, (MARGIN + FRAME_INSET) * SS
    frame_box = (fx0, fy0, fx0 + FRAME * SS - 1, fy0 + FRAME * SS - 1)
    draw.rounded_rectangle(frame_box, radius=FRAME_RADIUS * SS, outline=(255, 255, 255, 255), width=FRAME_STROKE * SS)

    # 取景框内部恢复渐变（描边只保留一圈白）。
    inner_inset = FRAME_STROKE
    inner_box = (
        fx0 + inner_inset * SS,
        fy0 + inner_inset * SS,
        fx0 + (FRAME - inner_inset) * SS - 1,
        fy0 + (FRAME - inner_inset) * SS - 1,
    )
    canvas.paste(grad, (0, 0), rounded_mask(inner_box, (FRAME_RADIUS - inner_inset) * SS))

    draw = ImageDraw.Draw(canvas)
    cx = cy = CENTER * SS
    draw.ellipse(
        (cx - RING_OUTER * SS, cy - RING_OUTER * SS, cx + RING_OUTER * SS - 1, cy + RING_OUTER * SS - 1),
        fill=(255, 255, 255, 255),
    )
    draw.ellipse(
        (cx - RING_INNER * SS, cy - RING_INNER * SS, cx + RING_INNER * SS - 1, cy + RING_INNER * SS - 1),
        fill=(*RING_HOLE_COLOR, 255),
    )

    return canvas.resize((CANVAS, CANVAS), Image.LANCZOS)


def render_size(master: Image.Image, size: int) -> Image.Image:
    return master.resize((size, size), Image.LANCZOS)


def write_ico(master: Image.Image, path: Path) -> None:
    master.save(path, format="ICO", sizes=[(s, s) for s in ICO_SIZES])


def write_icns(master: Image.Image, path: Path) -> None:
    import io

    chunks = []
    for size in ICNS_SIZES:
        buf = io.BytesIO()
        render_size(master, size).save(buf, format="PNG", optimize=True)
        payload = buf.getvalue()
        chunk = ICNS_TYPES[size] + struct.pack(">I", 8 + len(payload)) + payload
        chunks.append(chunk)
    body = b"".join(chunks)
    path.write_bytes(b"icns" + struct.pack(">I", 8 + len(body)) + body)


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


def build() -> int:
    BUILD_DIR.mkdir(parents=True, exist_ok=True)
    master = render_master()
    png, ico, icns = BUILD_DIR / "icon.png", BUILD_DIR / "icon.ico", BUILD_DIR / "icon.icns"
    master.save(png, format="PNG", optimize=True)
    write_ico(master, ico)
    write_icns(master, icns)
    print(f"已生成 {png.relative_to(ROOT)}（{CANVAS}×{CANVAS}）")
    print(f"已生成 {ico.relative_to(ROOT)}（{ico_entries(ico)}）")
    print(f"已生成 {icns.relative_to(ROOT)}（{icns_entries(icns)}）")
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
    return build()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
