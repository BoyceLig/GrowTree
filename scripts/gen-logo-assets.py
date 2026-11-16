#!/usr/bin/env python3
"""满伴成长树 LOGO 资产生成：从源 LOGO 生成 web/favicon、安卓图标、启动图、fpk 图标。"""
import os
from PIL import Image, ImageDraw, ImageOps

SRC = '/Users/wdcasc/Downloads/成长树-logo-方形.png'
ROOT = '/Users/wdcasc/WorkBuddy/成长树/growtree-main'
logo = Image.open(SRC).convert('RGB')
BG = logo.getpixel((5, 5))  # 取左上角作为背景色 (207,224,197)


def paste_center(canvas, img, scale):
    w, h = canvas.size
    side = int(min(w, h) * scale)
    im = img.resize((side, side), Image.LANCZOS)
    canvas.paste(im, ((w - side) // 2, (h - side) // 2))
    return canvas


def circle_mask(img):
    mask = Image.new('L', img.size, 0)
    ImageDraw.Draw(mask).ellipse((0, 0, img.size[0] - 1, img.size[1] - 1), fill=255)
    out = img.convert('RGBA')
    out.putalpha(mask)
    return out


# ── 1. web/public：主 logo（512，favicon/appletouch 共用） ──────────────
pub = os.path.join(ROOT, 'web', 'public')
logo.resize((512, 512), Image.LANCZOS).save(os.path.join(pub, 'manalong.png'), optimize=True)
logo.resize((180, 180), Image.LANCZOS).save(os.path.join(pub, 'apple-touch-icon.png'), optimize=True)

# ── 2. 安卓 mipmap：legacy launcher 图标（全出血；round 加圆形蒙版） ──
res = os.path.join(ROOT, 'web', 'android', 'app', 'src', 'main', 'res')
for d in sorted(os.listdir(res)):
    if not d.startswith('mipmap-') or d == 'mipmap-anydpi-v26':
        continue
    mdir = os.path.join(res, d)
    for name in ('ic_launcher.png', 'ic_launcher_round.png', 'ic_launcher_foreground.png'):
        p = os.path.join(mdir, name)
        if not os.path.exists(p):
            continue
        size = Image.open(p).size[0]
        if name == 'ic_launcher_foreground.png':
            # 自适应前景：透明画布 + logo 占 62%（安全区内）
            canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
            paste_center(canvas, logo, 0.62).save(p)
        elif 'round' in name:
            circle_mask(logo.resize((size, size), Image.LANCZOS)).save(p)
        else:
            logo.resize((size, size), Image.LANCZOS).save(p)

# 自适应背景色 = logo 底色
bgxml = os.path.join(res, 'values', 'ic_launcher_background.xml')
with open(bgxml, 'w') as f:
    f.write('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
            f'    <color name="ic_launcher_background">#{BG[0]:02X}{BG[1]:02X}{BG[2]:02X}</color>\n</resources>\n')

# ── 3. 启动图：按原尺寸重绘（底色 = logo 背景 + 居中 logo 28%） ────────
for dirpath, _, files in os.walk(res):
    for name in files:
        if name != 'splash.png':
            continue
        p = os.path.join(dirpath, name)
        w, h = Image.open(p).size
        canvas = Image.new('RGB', (w, h), BG)
        paste_center(canvas, logo, 0.28 if w >= h else 0.24).save(p)

# ── 4. 飞牛 fpk 图标 ──────────────────────────────────────────────────
fpk = os.path.join(ROOT, 'deploy', 'fpk', 'com.manalong.app')
for name, size in (('ICON.PNG', 64), ('ICON_256.PNG', 256),
                   ('app/ui/images/icon_64.png', 64), ('app/ui/images/icon_256.png', 256)):
    p = os.path.join(fpk, name)
    if os.path.exists(p):
        logo.resize((size, size), Image.LANCZOS).save(p)

print('BG =', '#%02X%02X%02X' % BG)
for root in (pub, res, fpk):
    n = sum(len(fs) for _, _, fs in os.walk(root))
    print(root.replace(ROOT + '/', ''), '->', n, 'files')
