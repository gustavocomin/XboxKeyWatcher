"""Deterministic fictional thumbnails, split by seed for development and holdout."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import json, random, string

root = Path(__file__).resolve().parents[1]
alphabet = string.ascii_uppercase + string.digits
for split, seed in [('development', 5621), ('holdout', 8937), ('final', 17381), ('independent', 27833)]:
    target = root / 'fixtures' / ('validation-' + split)
    target.mkdir(parents=True, exist_ok=True)
    manifest = []
    for i in range(48):
        rng = random.Random(seed + i)
        category = ['full', 'near-edge', 'clipped', 'no-key'][i % 4]
        key = '-'.join(''.join(rng.choice(alphabet) for _ in range(5)) for _ in range(5))
        image = Image.new('RGB', (900, 240), (22, 24, 27))
        draw = ImageDraw.Draw(image)
        x0, y0, x1, y1 = 28, 24, 872, 216
        draw.rectangle((x0, y0, x1, y1), fill=tuple(rng.randrange(45, 110) for _ in range(3)))
        for _ in range(80):
            x, y = rng.randrange(x0 + 1, x1 - 20), rng.randrange(y0 + 1, y1 - 20)
            draw.rectangle((x, y, x + rng.randrange(4, 38), y + rng.randrange(4, 25)), fill=tuple(rng.randrange(35, 170) for _ in range(3)))
        font = ImageFont.truetype(str(Path('C:/Windows/Fonts') / ('arialbd.ttf' if i % 3 else 'consolab.ttf')), [14, 16, 20, 24][(i // 4) % 4])
        text = key if category != 'no-key' else 'IMAGEM SEM CODIGO 2026'
        bounds = draw.textbbox((0, 0), text, font=font, stroke_width=1)
        width = bounds[2] - bounds[0]
        x = x0 + 35 if category == 'full' or category == 'no-key' else x0 + 2 if category == 'near-edge' else x0 - max(4, width // 40)
        y = 60 + (i * 17) % 100
        layer = Image.new('RGBA', image.size)
        ImageDraw.Draw(layer).text((x, y), text, font=font, fill='white', stroke_width=1, stroke_fill='black')
        mask = Image.new('L', image.size); ImageDraw.Draw(mask).rectangle((x0, y0, x1, y1), fill=255)
        image.paste(layer, (0, 0), Image.composite(layer.getchannel('A'), Image.new('L', image.size), mask))
        filename = f'{i:02d}-{category}.' + ('jpg' if i % 3 == 0 else 'png')
        image.save(target / filename, quality=68) if filename.endswith('.jpg') else image.save(target / filename)
        manifest.append({'path': (target / filename).relative_to(root).as_posix(), 'expected': key if category in ('full', 'near-edge') else None, 'category': category})
    (target / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    print(split, len(manifest))
