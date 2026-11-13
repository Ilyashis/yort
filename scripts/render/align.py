#!/usr/bin/env python3
"""Привязка картинки-рендера деревни (вид сверху, без координат) к карте по дорогам OSM.

Дороги на рендере — светлые серо-бежевые полосы. Ищем масштаб, поворот и сдвиг, при которых оси дорог OSM
лучше всего ложатся на эти полосы: грубо — перебором масштаба и поворота со свёрткой по сдвигу, потом точно —
подгонкой аффинного преобразования. Пишет <картинка>.align.json: матрица «локальные метры → пиксели».

  python3 scripts/render/align.py <render.jpg> --territory itkulovo-1 [--preview check.jpg]
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage, optimize

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'drone'))
from common import Territory  # noqa: E402

Image.MAX_IMAGE_PIXELS = None


def road_mask(img: Image.Image) -> np.ndarray:
    a = np.asarray(img.convert('RGB'), np.float32)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    luma = 0.3 * r + 0.55 * g + 0.15 * b
    spread = a.max(-1) - a.min(-1)
    return ((luma > 135) & (spread < 38) & (g < r + 10)).astype(np.float32)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('image')
    p.add_argument('--territory', required=True)
    p.add_argument('--preview')
    a = p.parse_args()

    t = Territory(a.territory)
    full = Image.open(a.image)
    W, H = full.size
    roads = t.road_samples(2.0)

    # Грубо: на картинке в 8 раз меньше.
    k = 8
    small = road_mask(full.resize((W // k, H // k), Image.BILINEAR))
    small = ndimage.gaussian_filter(small, 1.5)
    small -= small.mean()
    n = 1 << int(np.ceil(np.log2(max(small.shape) * 2)))
    fmask = np.fft.rfft2(small, (n, n))
    best = (-1e9,)
    for scale in np.arange(0.30, 0.56, 0.005):  # метров в пикселе полной картинки
        for rot in np.radians(np.arange(-3, 3.01, 0.5)):
            c, s = np.cos(rot), np.sin(rot)
            x = (roads[:, 0] * c - roads[:, 1] * s) / (scale * k)
            y = -(roads[:, 0] * s + roads[:, 1] * c) / (scale * k)
            x -= x.min()
            y -= y.min()
            if x.max() >= n / 2 or y.max() >= n / 2:
                continue
            tpl = np.zeros((n, n), np.float32)
            np.add.at(tpl, (y.astype(int), x.astype(int)), 1)
            corr = np.fft.irfft2(fmask * np.conj(np.fft.rfft2(tpl)), (n, n))
            corr[small.shape[0]:, :] = -1e9
            corr[:, small.shape[1]:] = -1e9
            j, i = np.unravel_index(corr.argmax(), corr.shape)
            score = corr[j, i] / len(roads)
            if score > best[0]:
                # Пиксель полной картинки = M · (x, y, 1).
                x0 = (roads[:, 0] * c - roads[:, 1] * s).min() / scale
                y0 = (-(roads[:, 0] * s + roads[:, 1] * c)).min() / scale
                m = np.array([[c / scale, -s / scale, i * k - x0], [-s / scale, -c / scale, j * k - y0]])
                best = (score, scale, np.degrees(rot), m)
    score, scale, rot, m = best
    print(f'грубо: {scale:.3f} м/пиксель, поворот {rot:.1f}°, совпадение {score:.3f}')

    # Точно: аффинная подгонка по размытой маске в половину размера.
    k = 2
    mask = ndimage.gaussian_filter(road_mask(full.resize((W // k, H // k), Image.BILINEAR)), 3.0)
    pts = np.c_[roads, np.ones(len(roads))]

    def cost(v):
        q = pts @ v.reshape(2, 3).T / k
        return -ndimage.map_coordinates(mask, [q[:, 1], q[:, 0]], order=1, mode='constant').mean()

    for _ in range(3):
        res = optimize.minimize(cost, m.ravel(), method='Nelder-Mead', options={'xatol': 0.01, 'fatol': 1e-6, 'maxiter': 4000,
                                'initial_simplex': m.ravel() + np.vstack([np.zeros(6), np.diag([0.01, 0.01, 6, 0.01, 0.01, 6])])})
        m = res.x.reshape(2, 3)
    sx, sy = 1 / np.hypot(m[0, 0], m[1, 0]), 1 / np.hypot(m[0, 1], m[1, 1])
    print(f'точно: {sx:.4f} × {sy:.4f} м/пиксель, дороги на светлом: {-res.fun:.3f} (грубо было {-cost(best[3].ravel()):.3f})')
    out = Path(a.image).with_suffix('.align.json')
    out.write_text(json.dumps({'territory': t.id, 'size': [W, H], 'world_to_pixel': m.tolist(), 'metres_per_pixel': [sx, sy]}))

    if a.preview:
        base = full.convert('RGB').resize((W // 4, H // 4))
        d = ImageDraw.Draw(base)
        q = pts @ m.T / 4
        for x, y in q[::2]:
            d.ellipse([x - 1.5, y - 1.5, x + 1.5, y + 1.5], fill=(255, 40, 40))
        for _, ring, _ in t.buildings():
            r = np.c_[ring, np.ones(len(ring))] @ m.T / 4
            d.polygon([tuple(v) for v in r], outline=(255, 230, 0))
        base.save(a.preview, quality=88)


if __name__ == '__main__':
    main()
