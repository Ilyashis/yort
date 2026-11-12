#!/usr/bin/env python3
"""Настоящие деревья по своей съёмке с дрона → public/data/territories/<id>/trees-survey.json.

Высота растительности = «верх» облака − земля (сетка terrain-dtm.npz от terrain.py, шаг 1 м). Дерево — вершина
кроны: местный максимум сглаженной высоты там, где сверху зелено (цвет берём из ortho.webp), выше --min метров
и не на постройке. Крона — клетки, для которых эта вершина ближайшая; по её площади считается ширина.
Порода — догадка по цвету кроны: тёмные и сине-зелёные — ели, остальные — берёзы.

Вместе с деревьями пишется грубая сетка «где съёмка есть»: там приложение не сажает деревья наугад.

  python3 scripts/drone/trees.py <проект ODM> --territory itkulovo-1 [--min 2.5] [--preview trees.jpg]
Нужны <проект>/terrain-dtm.npz и ortho.webp/ortho.json района (web_ortho.py).
"""

import argparse
import base64
import datetime
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

from common import Territory, save_json

Image.MAX_IMAGE_PIXELS = None
COVER_CELL = 16


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('project')
    p.add_argument('--territory', required=True)
    p.add_argument('--min', type=float, default=2.5, help='ниже этого — кусты и трава, м')
    p.add_argument('--preview', help='куда положить картинку для проверки: снимок с точками деревьев')
    a = p.parse_args()

    t = Territory(a.territory)
    grid = np.load(Path(a.project) / 'terrain-dtm.npz')
    dtm, top, cnt = grid['dtm'], grid['top'], grid['cnt']
    gx0, gy1, res = float(grid['x0']), float(grid['y1']), float(grid['res'])
    h, w = dtm.shape
    known = np.isfinite(dtm)
    near = ndimage.distance_transform_edt(~known, return_distances=False, return_indices=True)
    ground = dtm[tuple(near)]
    # Под лесом земля не снята: её высота — от ближайшей поляны; дальше 25 м от известной земли не верим.
    reach = ndimage.distance_transform_edt(~known) * res
    height = np.where(np.isfinite(top) & (cnt >= 2) & (reach < 25), top - ground, 0.0)
    height = np.clip(height, 0, 40)

    # Цвет сверху — из ортофото: центр каждой клетки сетки высот → пиксель снимка.
    meta = json.load(open(t.data / 'ortho.json'))
    photo = np.asarray(Image.open(t.data / 'ortho.webp').convert('RGBA'), np.float32)
    ph, pw = photo.shape[:2]
    cx = gx0 + (np.arange(w) + 0.5) * res
    cy = gy1 - (np.arange(h) + 0.5) * res
    lon, _ = t.lonlat(cx, 0)
    _, lat = t.lonlat(0, cy)
    px = np.clip(((lon - meta['west']) / (meta['east'] - meta['west']) * pw).astype(int), 0, pw - 1)
    py = np.clip(((meta['north'] - lat) / (meta['north'] - meta['south']) * ph).astype(int), 0, ph - 1)
    inside = ((lon >= meta['west']) & (lon <= meta['east']))[None, :] & ((lat >= meta['south']) & (lat <= meta['north']))[:, None]
    rgba = photo[py][:, px]
    r, g, b = rgba[..., 0], rgba[..., 1], rgba[..., 2]
    seen = inside & (rgba[..., 3] > 128)
    greenish = seen & (g > r + 6) & (g > b + 4)

    # Постройки (OSM и найденные по съёмке) с запасом 1 м — там не деревья, а крыши.
    roofs = Image.new('1', (w, h), 0)
    draw = ImageDraw.Draw(roofs)
    rings = [ring for _, ring, _ in t.buildings()]
    survey = t.data / 'survey.json'
    if survey.exists():
        for bld in json.load(open(survey)).get('buildings', []):
            c = np.array(bld['footprint'], float)
            x, y = t.local(c[:, 0], c[:, 1])
            rings.append(np.stack([x, y], 1))
    for ring in rings:
        draw.polygon([((x - gx0) / res, (gy1 - y) / res) for x, y in ring], fill=1)
    built = ndimage.binary_dilation(np.array(roofs, bool), iterations=max(1, int(round(1 / res))))

    canopy = (height > a.min) & greenish & ~built
    canopy = ndimage.binary_opening(canopy, iterations=1)
    smooth = ndimage.gaussian_filter(np.where(canopy, height, 0.0), 1.2 / res)
    # Вершина — максимум в окне, которое растёт с высотой: у большого дерева крона шире.
    tops = np.zeros_like(canopy)
    for lo, hi, size in ((0, 6, 5), (6, 12, 7), (12, 100, 9)):
        band = canopy & (smooth >= lo) & (smooth < hi)
        tops |= band & (smooth == ndimage.maximum_filter(smooth, size=size))
    labels, count = ndimage.label(tops)
    centres = np.array(ndimage.center_of_mass(tops, labels, np.arange(1, count + 1))) if count else np.zeros((0, 2))
    rows, cols = centres[:, 0].round().astype(int), centres[:, 1].round().astype(int)

    # Крона — клетки растительности, для которых эта вершина ближайшая (не дальше 7 м).
    marker = np.zeros((h, w), np.int32)
    marker[rows, cols] = np.arange(1, count + 1)
    dist, (ir, ic) = ndimage.distance_transform_edt(marker == 0, return_indices=True)
    owner = np.where(canopy & (dist * res < 7), marker[ir, ic], 0)
    area = np.bincount(owner.ravel(), minlength=count + 1)[1:] * res * res
    index = np.arange(1, count + 1)
    tall = ndimage.maximum(height, owner, index)
    luma = 0.3 * r + 0.55 * g + 0.15 * b
    crown_luma = ndimage.mean(luma, owner, index)
    crown_blue = ndimage.mean(b - r, owner, index)

    keep = (area >= 4) & (tall >= a.min) & np.isfinite(crown_luma)
    # Ели (хвойные): тёмная крона с синевой, не ниже 5 м. Порог — по самим кронам: темнее 25-го перцентиля
    # и синее медианы.
    dark = crown_luma < np.percentile(crown_luma[keep], 25) if keep.any() else keep
    spruce = dark & (tall >= 5) & (crown_blue > np.median(crown_blue[keep]) if keep.any() else False)
    x = gx0 + (cols + 0.5) * res
    y = gy1 - (rows + 0.5) * res
    tlon, tlat = t.lonlat(x, y)
    trees = [
        [round(float(tlon[k]), 7), round(float(tlat[k]), 7), round(float(tall[k]), 1), round(float(np.sqrt(area[k] / np.pi)), 1), 's' if spruce[k] else 'b']
        for k in np.nonzero(keep)[0]
    ]

    # Где съёмка есть (земля или верх известны) — сеткой COVER_CELL метров на весь район.
    ax0, ay0, ax1, ay1 = t.area()
    cw, ch = int(np.ceil((ax1 - ax0) / COVER_CELL)), int(np.ceil((ay1 - ay0) / COVER_CELL))
    cover = np.zeros((ch, cw), bool)
    have = seen & (reach < 25)
    hr, hc = np.nonzero(have)
    ci = ((gx0 + (hc + 0.5) * res - ax0) / COVER_CELL).astype(int)
    cj = ((ay1 - (gy1 - (hr + 0.5) * res)) / COVER_CELL).astype(int)
    ok = (ci >= 0) & (ci < cw) & (cj >= 0) & (cj < ch)
    share = np.zeros((ch, cw))
    np.add.at(share, (cj[ok], ci[ok]), 1)
    cover = share > 0.5 * (COVER_CELL / res) ** 2
    west, north = t.lonlat(ax0, ay1)
    east, south = t.lonlat(ax1, ay0)

    save_json(t.data / 'trees-survey.json', {
        'metadata': {
            'territory': t.id,
            'source': 'Своя съёмка с дрона (июль 2023), OpenDroneMap: высота растительности над землёй и цвет крон',
            'note': 'дерево: долгота, широта, высота (м), радиус кроны (м), порода (b — берёза, s — ель; догадка по цвету)',
            'generatedAt': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        },
        'trees': trees,
        'coverage': {
            'west': float(west), 'south': float(south), 'east': float(east), 'north': float(north), 'width': cw, 'height': ch,
            'cells': base64.b64encode(np.packbits(cover.ravel())).decode(),
        },
    })
    heights = np.array([tr[2] for tr in trees]) if trees else np.zeros(1)
    print(f'деревьев {len(trees)}: елей {sum(tr[4] == "s" for tr in trees)}, высота 10–50–90 %: '
          f'{np.percentile(heights, 10):.1f} / {np.percentile(heights, 50):.1f} / {np.percentile(heights, 90):.1f} м; '
          f'съёмка закрывает {cover.mean() * 100:.0f} % района')

    if a.preview:
        k = 3
        base = Image.fromarray(photo[py][:, px][..., :3].astype(np.uint8)).resize((w * k, h * k), Image.BILINEAR)
        d = ImageDraw.Draw(base)
        for n in np.nonzero(keep)[0]:
            cxp, cyp, rad = (cols[n] + 0.5) * k, (rows[n] + 0.5) * k, max(2.0, np.sqrt(area[n] / np.pi) * k)
            d.ellipse([cxp - rad, cyp - rad, cxp + rad, cyp + rad], outline=(60, 200, 255) if spruce[n] else (255, 230, 60), width=1)
        base.save(a.preview, quality=88)


if __name__ == '__main__':
    main()
