"""Generate high-res workshop WebP assets and 1200x630 darkroom OG cover."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[2]
SITE_ASSETS = ROOT / "site" / "public" / "assets"
WORKSHOP_DIR = SITE_ASSETS / "workshop"
GPU_LIVE = ROOT / "bench-results" / "gpu-live" / "2026-11-23T15-36-01"


def export_workshop_hd() -> None:
    WORKSHOP_DIR.mkdir(parents=True, exist_ok=True)
    mapping = {
        "01-workshop-source.png": "shield-source.webp",
        "02-cutout-birefnet.png": "shield-cutout.webp",
        "03-pbr-albedo.png": "shield-albedo.webp",
        "03-pbr-normal.png": "shield-normal.webp",
        "03-pbr-roughness.png": "shield-roughness.webp",
        "03-pbr-metallic.png": "shield-metallic.webp",
    }
    for src_name, dst_name in mapping.items():
        src = GPU_LIVE / src_name
        if not src.exists():
            print(f"[skip] missing {src}")
            continue
        img = Image.open(src)
        # Preserve RGBA alpha channel for cutout; RGB for opaque maps
        if "cutout" in dst_name:
            img = img.convert("RGBA")
        else:
            img = img.convert("RGB")
        if img.width > 768 or img.height > 768:
            img.thumbnail((768, 768), Image.Resampling.LANCZOS)
        out = WORKSHOP_DIR / dst_name
        img.save(out, "WEBP", quality=88, method=6)
        print(f"[ok] {dst_name} {img.size} {out.stat().st_size // 1024}KB")


def load_font(name: str, size: int, variation: str | None = None):
    path = Path("C:/Windows/Fonts") / name
    font = ImageFont.truetype(str(path), size=size)
    if variation and hasattr(font, "set_variation_by_axes"):
        try:
            font.set_variation_by_axes([int(variation)])
        except Exception:
            pass
    return font


def fit_cover(im: Image.Image, tw: int, th: int) -> Image.Image:
    im = im.convert("RGB")
    sw, sh = im.size
    scale = max(tw / sw, th / sh)
    nw, nh = int(sw * scale), int(sh * scale)
    resized = im.resize((nw, nh), Image.Resampling.LANCZOS)
    left = (nw - tw) // 2
    top = (nh - th) // 2
    return resized.crop((left, top, left + tw, top + th))


def paste_print_card(canvas: Image.Image, img_path: Path, box: tuple[int, int, int, int], angle: float) -> None:
    x, y, w, h = box
    border = 10
    card = Image.new("RGBA", (w + border * 2, h + border * 2), (244, 243, 239, 255))
    photo = fit_cover(Image.open(img_path), w, h).convert("RGBA")
    card.paste(photo, (border, border))

    # Drop shadow
    pad = 40
    layer = Image.new("RGBA", (card.width + pad * 2, card.height + pad * 2), (0, 0, 0, 0))
    shadow = Image.new("RGBA", card.size, (0, 0, 0, 185))
    layer.paste(shadow, (pad, pad + 14))
    layer = layer.filter(ImageFilter.GaussianBlur(18))
    layer.paste(card, (pad, pad), card)

    rotated = layer.rotate(angle, resample=Image.Resampling.BICUBIC, expand=True)
    canvas.alpha_composite(rotated, (x - pad, y - pad))


def build_og_cover() -> None:
    W, H = 1200, 630
    canvas = Image.new("RGBA", (W, H), (10, 10, 12, 255))
    draw = ImageDraw.Draw(canvas)

    # Subtle darkroom grid & warm safelight glow
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(glow)
    gdraw.ellipse((620, -140, 1340, 580), fill=(230, 97, 62, 34))
    gdraw.ellipse((-160, 320, 480, 820), fill=(230, 97, 62, 18))
    glow = glow.filter(ImageFilter.GaussianBlur(90))
    canvas = Image.alpha_composite(canvas, glow)
    draw = ImageDraw.Draw(canvas)

    # Hairline registration marks & frame
    line_col = (255, 255, 255, 24)
    draw.rectangle((28, 28, W - 28, H - 28), outline=line_col, width=1)
    draw.line((680, 28, 680, H - 28), fill=(255, 255, 255, 16), width=1)

    # Film sprocket holes along right edge
    for sy in range(48, H - 48, 34):
        draw.rounded_rectangle((W - 22, sy, W - 10, sy + 16), radius=3, fill=(255, 255, 255, 22))

    # Right column: stacked real showcase prints
    prints = [
        (SITE_ASSETS / "showcase" / "z-image-turbo-alley-bookstore.webp", (735, 62, 230, 285), -4.5),
        (SITE_ASSETS / "showcase" / "flux2-klein-4b-kyoto-poster.webp", (875, 290, 255, 175), 3.2),
        (SITE_ASSETS / "showcase" / "sdxl-lightning-cyberpunk-street.webp", (705, 225, 275, 195), -1.8),
    ]
    for path, box, angle in prints:
        if path.exists():
            paste_print_card(canvas, path, box, angle)

    draw = ImageDraw.Draw(canvas)
    # Left column typography
    f_mono_sm = load_font("consola.ttf", 16)
    f_mono_xs = load_font("consola.ttf", 14)
    f_serif_lg = load_font("NotoSerifSC-VF.ttf", 64, "700")
    f_sans_md = load_font("NotoSansSC-VF.ttf", 22, "400")
    f_sans_bd = load_font("NotoSansSC-VF.ttf", 18, "600")

    # Brand row
    logo_path = SITE_ASSETS / "logo.png"
    lx = 68
    if logo_path.exists():
        logo = Image.open(logo_path).convert("RGBA").resize((28, 28), Image.Resampling.LANCZOS)
        canvas.alpha_composite(logo, (lx, 64))
        lx += 40
    draw.text((lx, 66), "AIGC Studio", font=f_sans_bd, fill=(243, 243, 240, 255))
    draw.text((lx + 116, 69), "v0.15.0  ·  MIT OPEN SOURCE", font=f_mono_xs, fill=(140, 140, 150, 255))

    # Safelight kicker
    draw.ellipse((68, 146, 78, 156), fill=(230, 97, 62, 255))
    draw.text((90, 142), "LOCAL WORKBENCH  +  CLOUD GPU", font=f_mono_sm, fill=(230, 97, 62, 230))

    # Display headline
    draw.text((66, 186), "免显卡，免配置，", font=f_serif_lg, fill=(244, 243, 239, 255))
    draw.text((66, 266), "运行主流开源模型。", font=f_serif_lg, fill=(244, 243, 239, 255))

    # Lead copy
    draw.text((68, 368), "默认接入 Kaggle 每周 30 小时免费双卡，", font=f_sans_md, fill=(168, 168, 178, 255))
    draw.text((68, 404), "原图与资产工坊产物全部留在本地硬盘。", font=f_sans_md, fill=(168, 168, 178, 255))

    # Bottom technical strip
    draw.line((68, 500, 636, 500), fill=(255, 255, 255, 28), width=1)
    tags = ["7 款实测开源模型", "本地资产工坊", "内置 MCP Server"]
    tx = 68
    for tag in tags:
        tw = int(draw.textlength(tag, font=f_sans_bd))
        draw.rounded_rectangle((tx, 522, tx + tw + 26, 558), radius=18, outline=(255, 255, 255, 48), width=1)
        draw.text((tx + 13, 529), tag, font=f_sans_bd, fill=(235, 235, 232, 255))
        tx += tw + 38

    draw.text((712, 540), "DARKROOM LIGHT TABLE  ·  7 MODELS BENCHMARKED", font=f_mono_xs, fill=(130, 130, 140, 255))

    out = SITE_ASSETS / "og-cover.png"
    canvas.convert("RGB").save(out, "PNG", optimize=True)
    print(f"[ok] og-cover.png {canvas.size} {out.stat().st_size // 1024}KB")


if __name__ == "__main__":
    export_workshop_hd()
    build_og_cover()
