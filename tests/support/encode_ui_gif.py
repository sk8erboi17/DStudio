"""Encode bounded browser screenshots, and an inspectable frame contact sheet."""
from pathlib import Path
import sys
from PIL import Image, ImageOps, ImageDraw

folder, target = Path(sys.argv[1]), Path(sys.argv[2])
paths = sorted(folder.glob('*.png'))
if not paths or len(paths) > 80:
    raise SystemExit('Expected 1–80 recorded frames')
frames = [Image.open(path).convert('RGB') for path in paths]
frames[0].save(target, save_all=True, append_images=frames[1:], duration=160, loop=0, optimize=False)
indices = sorted(set([0, len(frames)//4, len(frames)//2, 3*len(frames)//4, len(frames)-1]))
sheet = Image.new('RGB', (540*len(indices), 430), '#fafafa')
draw = ImageDraw.Draw(sheet)
for col, index in enumerate(indices):
    thumb = ImageOps.contain(frames[index], (530, 400))
    sheet.paste(thumb, (col*540, 20))
    draw.text((col*540+10, 410), f'Frame {index+1}/{len(frames)}', fill='#111111')
sheet.save(target.with_suffix('.frames.png'))
