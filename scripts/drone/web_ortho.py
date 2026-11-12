#!/usr/bin/env python3
"""Ортофото для сайта: плитки GeoTIFF из ortho.py → одна текстура WebP с прозрачностью и её привязка.

Плитки (WGS 84, одинаковый размер пикселя) склеиваются в мозаику по своим углам и уменьшаются до --width
пикселей по ширине. Где съёмка редкая (края облака — «сито» и полосы), снимок плавно уходит в прозрачность:
там землю красит сам движок.

  python3 scripts/drone/web_ortho.py <папка с ortho-*.tif> --territory itkulovo-1 [--width 5120]
Пишет public/data/territories/<id>/ortho.webp и ortho.json (bbox мозаики и размер).
"""

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

Image.MAX_IMAGE_PIXELS = None
TIEPOINT, SCALE = 33922, 33550


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('source')
    p.add_argument('--territory', required=True)
    p.add_argument('--width', type=int, default=5120)
    p.add_argument('--quality', type=int, default=82)
    args = p.parse_args()

    tiles = []
    for path in sorted(Path(args.source).glob('ortho-*.tif')):
        im = Image.open(path)
        tie, scale = im.tag_v2[TIEPOINT], im.tag_v2[SCALE]
        tiles.append((im, tie[3], tie[4], scale[0], scale[1]))
    if not tiles:
        raise SystemExit('нет плиток ortho-*.tif')
    sx, sy = tiles[0][3], tiles[0][4]
    west = min(t[1] for t in tiles)
    north = max(t[2] for t in tiles)
    east = max(t[1] + t[0].width * sx for t in tiles)
    south = min(t[2] - t[0].height * sy for t in tiles)
    full_w, full_h = round((east - west) / sx), round((north - south) / sy)
    k = args.width / full_w
    w, h = args.width, round(full_h * k)

    rgb = np.zeros((h, w, 3), np.float32)
    weight = np.zeros((h, w), np.float32)
    for im, lon, lat, _, _ in tiles:
        x0, y0 = round((lon - west) / sx * k), round((north - lat) / sy * k)
        tw, th = round(im.width * k), round(im.height * k)
        a = np.asarray(im.convert('RGBA').resize((tw, th), Image.LANCZOS), np.float32)
        x1, y1 = min(w, x0 + tw), min(h, y0 + th)
        alpha = a[: y1 - y0, : x1 - x0, 3] / 255
        rgb[y0:y1, x0:x1] += a[: y1 - y0, : x1 - x0, :3] * alpha[..., None]
        weight[y0:y1, x0:x1] += alpha
    cover = np.clip(weight, 0, 1)
    rgb /= np.maximum(weight, 1e-3)[..., None]

    # Плотность съёмки вокруг пикселя (окно ~12 м): где она ниже 90 % — это край облака, его прячем.
    px_per_m = w / ((east - west) * 111_320 * np.cos(np.radians((north + south) / 2)))
    dense = ndimage.uniform_filter(cover, max(3, int(12 * px_per_m)))
    solid = ndimage.binary_erosion(dense > 0.9, iterations=max(1, int(4 * px_per_m)))
    alpha = np.clip(ndimage.gaussian_filter(solid.astype(np.float32), 5 * px_per_m) * 2 - 1, 0, 1) * (cover > 0.5)
    # Под прозрачными пикселями — цвет ближайшего снимка: иначе по краю при сглаживании текстуры лезет чёрное.
    near = ndimage.distance_transform_edt(cover < 0.5, return_distances=False, return_indices=True)
    rgb = rgb[tuple(near)]

    out = Path('public/data/territories') / args.territory
    rgba = np.dstack([np.clip(rgb, 0, 255), alpha * 255]).astype(np.uint8)
    Image.fromarray(rgba, 'RGBA').save(out / 'ortho.webp', quality=args.quality, method=6)
    (out / 'ortho.json').write_text(json.dumps({'west': west, 'south': south, 'east': east, 'north': north, 'width': w, 'height': h}))
    print(f'{w}×{h}, {px_per_m:.2f} px/м, снимок закрывает {alpha.mean() * 100:.0f} % мозаики, {(out / "ortho.webp").stat().st_size / 1e6:.1f} МБ')


if __name__ == '__main__':
    main()
