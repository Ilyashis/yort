#!/usr/bin/env python3
"""Картинка-рендер деревни → текстура земли для сайта (вариант «Карта» в переключателе «Земля»).

Картинка привязана align.py аффинным преобразованием; здесь она пересчитывается в ровную сетку «север вверху,
метры одинаковы по обеим осям» на весь район с запасом и сохраняется как render.webp + render.json (bbox).
Где картинки нет — прозрачно. Файлы кладутся в данные района, но в .gitignore: картинка сделана из чужого
спутникового снимка, в публичный репозиторий её не отправляем.

  python3 scripts/render/web_render.py <render.jpg> --territory itkulovo-1 [--width 5120]
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'drone'))
from common import Territory  # noqa: E402

Image.MAX_IMAGE_PIXELS = None


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('image')
    p.add_argument('--territory', required=True)
    p.add_argument('--width', type=int, default=5120)
    p.add_argument('--margin', type=float, default=250.0)
    a = p.parse_args()

    t = Territory(a.territory)
    m = np.array(json.load(open(Path(a.image).with_suffix('.align.json')))['world_to_pixel'])
    x0, y0, x1, y1 = t.area()
    x0, y0, x1, y1 = x0 - a.margin, y0 - a.margin, x1 + a.margin, y1 + a.margin
    step = (x1 - x0) / a.width
    w, h = a.width, int(round((y1 - y0) / step))
    # Пиксель результата (i, j) → мир (x0 + i·step, y1 − j·step) → пиксель исходника.
    to_world = np.array([[step, 0, x0 + step / 2], [0, -step, y1 - step / 2], [0, 0, 1]])
    c = m @ to_world
    src = Image.open(a.image).convert('RGBA')
    out = src.transform((w, h), Image.AFFINE, tuple(c.ravel()), resample=Image.BICUBIC, fillcolor=(0, 0, 0, 0))
    out.save(t.data / 'render.webp', quality=84, method=6)
    west, north = t.lonlat(x0, y1)
    east, south = t.lonlat(x1, y0)
    (t.data / 'render.json').write_text(json.dumps({'west': float(west), 'south': float(south), 'east': float(east), 'north': float(north), 'width': w, 'height': h}))
    alpha = np.asarray(out)[..., 3]
    print(f'{w}×{h}, {step:.2f} м/пиксель, картинка закрывает {(alpha > 0).mean() * 100:.0f} %, {(t.data / "render.webp").stat().st_size / 1e6:.1f} МБ')


if __name__ == '__main__':
    main()
