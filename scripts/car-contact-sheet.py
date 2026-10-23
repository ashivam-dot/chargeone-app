# Before/after contact sheet of car-lab shots (dev only; needs Pillow).
# Usage: python3 scripts/car-contact-sheet.py <dir with before/ and after/> [ids...]
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root = Path(sys.argv[1])
cars = sys.argv[2:] or ["tata-nexon-ev", "tata-punch-ev", "mahindra-xev9s"]
views = ["front34", "side", "rear34", "front"]
cw, ch = 450, 260
label_w = 150
font = ImageFont.load_default()
sheet = Image.new("RGB", (label_w + cw * len(views), 30 + ch * 2 * len(cars)), "white")
d = ImageDraw.Draw(sheet)
for j, v in enumerate(views):
    d.text((label_w + j * cw + 8, 8), v, fill="black", font=font)
for i, car in enumerate(cars):
    for k, stage in enumerate(["before", "after"]):
        y = 30 + (i * 2 + k) * ch
        d.text((8, y + ch // 2 - 10), car, fill="black", font=font)
        d.text((8, y + ch // 2 + 6), stage, fill="#c00" if stage == "before" else "#060", font=font)
        for j, v in enumerate(views):
            p = root / stage / f"{car}_{v}.png"
            if not p.exists():
                continue
            im = Image.open(p).convert("RGB")
            w, h = im.size
            # The side view is shot with a long lens and lots of margin; crop it in.
            box = (int(w * 0.2), int(h * 0.2), int(w * 0.8), int(h * 0.8)) if v == "side" else (0, 0, w, h)
            sheet.paste(im.crop(box).resize((cw, ch)), (label_w + j * cw, y))
        d.line([(0, y + ch - 1), (sheet.width, y + ch - 1)], fill="#ddd")
out = root / "contact-sheet.png"
sheet.save(out)
print(out)
