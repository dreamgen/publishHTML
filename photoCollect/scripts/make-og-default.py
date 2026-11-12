#!/usr/bin/env python3
"""產生分享預覽用的預設圖 public/assets/og-default.png（1200x630，深青綠底、白色線條相機，內容置中於中央 630×630 安全區）。
用法：python3 scripts/make-og-default.py
字型：優先用 Noto Sans CJK TC（/usr/share/fonts/opentype/noto/），沒有就用 fc-list 找。"""
import subprocess
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

W, H, S = 1200, 630, 2  # 以 2 倍尺寸繪製再縮小，線條邊緣較平滑
TEAL = (14, 111, 106)   # #0E6F6A
WHITE = (255, 255, 255)
OUT = Path(__file__).resolve().parent.parent / 'public' / 'assets' / 'og-default.png'


def find_font(bold):
    cands = [f'/usr/share/fonts/opentype/noto/NotoSansCJK-{"Bold" if bold else "Medium"}.ttc']
    try:
        out = subprocess.run(['fc-list', ':lang=zh-tw', 'file', 'family', 'style'], capture_output=True, text=True).stdout
        cands += [l.split(':')[0] for l in out.splitlines() if 'CJK' in l or 'Noto Sans' in l]
    except Exception:
        pass
    for path in cands:
        if not Path(path).exists():
            continue
        for idx in (3, 0, 1, 2, 4):  # TTC 內順序通常為 JP KR SC TC HK，優先取 TC
            try:
                f = ImageFont.truetype(path, 40, index=idx)
                if 'TC' in ''.join(f.getname()) or path.endswith('.ttf'):
                    return path, idx
            except Exception:
                continue
        return path, 0
    raise SystemExit('找不到中文字型，請安裝 Noto Sans CJK')


def font(bold, size):
    path, idx = find_font(bold)
    return ImageFont.truetype(path, size * S, index=idx)


img = Image.new('RGB', (W * S, H * S), TEAL)
d = ImageDraw.Draw(img)

# 中央安全區（x=285–915）版面：LINE 常把預覽圖從中央裁成正方形小縮圖，關鍵內容都置中放在這裡
cx = (W // 2) * S


def camera(cx, cy, k):
    lw = max(4, int(12 * k * S))
    bw, bh = int(330 * k * S), int(236 * k * S)
    x0, y0 = cx - bw // 2, cy - bh // 2 + int(14 * k * S)
    d.rounded_rectangle((x0, y0, x0 + bw, y0 + bh), radius=int(36 * k * S), outline=WHITE, width=lw)
    d.line([(cx - int(76 * k * S), y0), (cx - int(52 * k * S), y0 - int(40 * k * S)),
            (cx + int(52 * k * S), y0 - int(40 * k * S)), (cx + int(76 * k * S), y0)], fill=WHITE, width=lw, joint='curve')
    r = int(70 * k * S)
    cyy = cy + int(14 * k * S)
    d.ellipse((cx - r, cyy - r, cx + r, cyy + r), outline=WHITE, width=lw)
    r2 = int(26 * k * S)
    d.ellipse((cx - r2, cyy - r2, cx + r2, cyy + r2), outline=WHITE, width=max(3, lw // 2 + 1))
    fr = int(10 * k * S)
    d.ellipse((x0 + bw - int(60 * k * S) - fr, y0 + int(40 * k * S) - fr, x0 + bw - int(60 * k * S) + fr, y0 + int(40 * k * S) + fr), fill=WHITE)


camera(cx, 190 * S, 0.5)
d.text((cx, 300 * S), '活動照片募集', font=font(True, 64), fill=WHITE, anchor='mt')
d.rounded_rectangle((cx - 28 * S, 392 * S, cx + 28 * S, 397 * S), radius=2 * S, fill=WHITE)
d.text((cx, 420 * S), '上傳你拍到的精彩瞬間', font=font(False, 34), fill=(214, 235, 233), anchor='mt')

img = img.resize((W, H), Image.LANCZOS)
img.save(OUT, optimize=True)
print('wrote', OUT, img.size, OUT.stat().st_size, 'bytes')
