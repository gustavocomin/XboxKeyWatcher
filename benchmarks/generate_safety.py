"""Safety corpus for the channel bot OCR: fictitious keys in the channel style (one large
white line with a black outline) drawn on clean art, over text-heavy promo art (the case
where two reads can agree on a wrong character), cut by the image edge, plus images with
no key and near-key decoys. Writes <out>/manifest.json; keys are random and fictitious.

Usage: python generate_safety.py <out-dir> <clean-background.jpg> <promo-folder> [seed]
"""
import json, os, random, sys, glob
from PIL import Image, ImageDraw, ImageFont, ImageFilter

out, clean_bg, promo_dir = sys.argv[1], sys.argv[2], sys.argv[3]
rnd = random.Random(int(sys.argv[4]) if len(sys.argv) > 4 else 7)
os.makedirs(out, exist_ok=True)
# Xbox 5x5 codes never use A E I L O S U 0 1 5 (N and Z do occur).
ALPHA = 'BCDFGHJKMNPQRTVWXYZ2346789'
FONTS = [r'C:\Windows\Fonts\segoeuib.ttf', r'C:\Windows\Fonts\arialbd.ttf', r'C:\Windows\Fonts\verdanab.ttf', r'C:\Windows\Fonts\impact.ttf']
promos = sorted(p for p in glob.glob(os.path.join(promo_dir, '*.jpg'))
                if not p.endswith(('-thumb.jpg', '-preview.jpg')) and not os.path.basename(p).split('-')[1].startswith(('10', '11')))
manifest = []

def new_key(groups=5, size=5):
    return '-'.join(''.join(rnd.choice(ALPHA) for _ in range(size)) for _ in range(groups))

def background(kind):
    if kind == 'clean':
        img = Image.open(clean_bg).convert('RGB')
        w, h = img.size
        cw, ch = int(w * rnd.uniform(0.6, 1.0)), int(h * rnd.uniform(0.6, 1.0))
        x, y = rnd.randint(0, w - cw), rnd.randint(0, h - ch)
        img = img.crop((x, y, x + cw, y + ch))
    else:
        img = Image.open(rnd.choice(promos)).convert('RGB')
    target = rnd.choice([(1440, 1079), (1599, 899), (1080, 1080), (1280, 960)])
    return img.resize(target, Image.LANCZOS)

def draw_key(img, text, width_frac, ypos, xshift=0.0):
    w, h = img.size
    font_path = rnd.choice(FONTS)
    size = 100
    font = ImageFont.truetype(font_path, size)
    tw = ImageDraw.Draw(img).textlength(text, font=font)
    size = max(12, int(size * width_frac * w / tw))
    font = ImageFont.truetype(font_path, size)
    d = ImageDraw.Draw(img)
    left, top, right, bottom = d.textbbox((0, 0), text, font=font, stroke_width=max(2, size // 12))
    x = (w - (right - left)) / 2 - left + xshift * w
    y = ypos * h - (bottom - top) / 2 - top
    d.text((x, y), text, font=font, fill='white', stroke_width=max(2, size // 12), stroke_fill='black')
    return (x + left, y + top, x + right, y + bottom)

def save(img, name, expected, category, truth=None):
    if rnd.random() < 0.3: img = img.filter(ImageFilter.GaussianBlur(rnd.uniform(0.3, 0.9)))
    path = os.path.join(out, name)
    img.save(path, quality=rnd.choice([72, 80, 88]))
    manifest.append({'path': path, 'expected': expected, 'category': category, 'truth': truth or expected})

n = 0
for i in range(80):   # clean art, varied size and position
    img = background('clean'); k = new_key()
    draw_key(img, k, rnd.uniform(0.7, 0.96), rnd.uniform(0.2, 0.85)); save(img, f'{n:03d}-clean.jpg', k, 'clean'); n += 1
for i in range(240):  # over text-heavy promo art: overlaps with other text
    img = background('busy'); k = new_key()
    draw_key(img, k, rnd.uniform(0.7, 0.96), rnd.uniform(0.1, 0.9)); save(img, f'{n:03d}-busy.jpg', k, 'busy'); n += 1
for i in range(60):   # cut by the left or right edge: must never be filled
    img = background(rnd.choice(['clean', 'busy'])); k = new_key()
    bb = draw_key(img, k, rnd.uniform(0.8, 0.96), rnd.uniform(0.2, 0.8), xshift=rnd.choice([-1, 1]) * rnd.uniform(0.06, 0.2))
    inside = bb[0] >= 0 and bb[2] <= img.size[0]
    save(img, f'{n:03d}-{"shifted" if inside else "clipped"}.jpg', k if inside else None, 'shifted' if inside else 'clipped', k); n += 1
for i in range(30):   # cut by the top or bottom edge
    img = background(rnd.choice(['clean', 'busy'])); k = new_key()
    bb = draw_key(img, k, rnd.uniform(0.8, 0.96), rnd.choice([0.03, 0.97]))
    save(img, f'{n:03d}-clipped-v.jpg', None if bb[1] < 0 or bb[3] > img.size[1] else k, 'clipped-v', k); n += 1
for p in promos:      # real promo posts without key
    img = Image.open(p).convert('RGB'); save(img, f'{n:03d}-nokey.jpg', None, 'no-key'); n += 1
for i in range(40):   # decoys: 4 groups, a 4-char group, 6 groups
    img = background(rnd.choice(['clean', 'busy']))
    text = rnd.choice([new_key(4), new_key()[:-1], new_key(6), new_key().replace('-', ' ', 1)[:23]])
    draw_key(img, text, rnd.uniform(0.6, 0.96), rnd.uniform(0.2, 0.8)); save(img, f'{n:03d}-decoy.jpg', None, 'decoy'); n += 1
json.dump(manifest, open(os.path.join(out, 'manifest.json'), 'w'), indent=1)
print(len(manifest), 'imagens em', out)
