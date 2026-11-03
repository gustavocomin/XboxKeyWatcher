"""Create a repeatable, entirely fictional image corpus."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import json, random

root = Path(__file__).resolve().parents[1]
target = root / "fixtures" / "synthetic"
target.mkdir(parents=True, exist_ok=True)
key = "AAAAA-BBBBB-CCCCC-DDDDD-EEEEE"
cases = [
    ("large", "arialbd.ttf", 37, "plain", 1),
    ("medium", "arial.ttf", 23, "plain", 1),
    ("outlined", "arialbd.ttf", 24, "color", 2),
    ("complex", "consolab.ttf", 22, "noise", 2),
    ("small", "arialbd.ttf", 16, "color", 1),
    ("compressed", "arialbd.ttf", 23, "noise", 2),
]
manifest = []
for name, fontname, size, background, stroke in cases:
    random.seed(717)
    image = Image.new("RGB", (900, 150), (25, 25, 25))
    draw = ImageDraw.Draw(image)
    if background != "plain":
        for _ in range(180):
            x, y = random.randrange(900), random.randrange(150)
            color = tuple(random.randrange(40, 190) for _ in range(3))
            radius = random.randrange(5, 90) if background == "color" else random.randrange(1, 8)
            draw.rectangle((x, y, min(899, x+radius), min(149, y+radius)), fill=color)
    font = ImageFont.truetype(str(Path("C:/Windows/Fonts") / fontname), size)
    draw.text((20, 53), key, font=font, fill="white", stroke_width=stroke, stroke_fill="black")
    path = target / (name + (".jpg" if name == "compressed" else ".png"))
    if path.suffix == ".jpg": image.save(path, quality=58)
    else: image.save(path)
    # Decode the saved image so JPEG artifacts match the other benchmarks.
    with Image.open(path) as decoded:
        (target / (name + ".rgb")).write_bytes(decoded.convert("RGB").tobytes())
    manifest.append({"path": str(path.relative_to(root)).replace("\\", "/"), "expected": key})
(target / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
print(f"{len(manifest)} fixtures written to {target}")
