#!/usr/bin/env python3
"""Ортофото деревни по своей съёмке с дрона → GeoTIFF (WGS 84) для подложки в редакторе.

Облако OpenDroneMap переносится на карту (матрица из align.py) и рисуется сверху: в каждом пикселе — цвет
самой высокой точки, мелкие дыры (до --fill пикселей) заливаются ближайшим цветом, дальше — прозрачно.
Снимок режется на квадраты --tile метров (редактор уменьшает подложку до 4096 px по длинной стороне,
так что 1 км при 4 px/м — без потерь), берутся только квадраты с домами OSM.

Локальные метры приложения — равномерная сетка по долготе и широте, поэтому квадрат ложится в WGS 84
без перепроецирования: углы — долгота/широта, пиксели — как есть. GeoTIFF пишет GDAL из образа OpenDroneMap.

  python3 scripts/drone/ortho.py <проект ODM> --align align.json --territory itkulovo-1 --out <папка> [--px 4] [--tile 900]
С --candidates survey.json рядом кладётся candidates.jpg — листы с найденными постройками для отбора.
"""

import argparse
import json
import math
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

from common import Alignment, Territory, load_cloud

GDAL = '/code/SuperBuild/install/bin/gdal_translate'


def render(world: np.ndarray, rgb: np.ndarray, x0: float, y1: float, w: int, h: int, px: float, fill: int):
    """Вид сверху RGBA: верхняя точка в пикселе, дыры до fill пикселей — ближайшим цветом."""
    ix = ((world[:, 0] - x0) * px).astype(np.int64)
    iy = ((y1 - world[:, 1]) * px).astype(np.int64)
    ok = (ix >= 0) & (ix < w) & (iy >= 0) & (iy < h)
    ix, iy, z, col = ix[ok], iy[ok], world[ok, 2], rgb[ok]
    order = np.argsort(z)
    img = np.zeros((h, w, 3), np.uint8)
    hit = np.zeros((h, w), bool)
    img[iy[order], ix[order]] = col[order]
    hit[iy[order], ix[order]] = True
    gap, near = ndimage.distance_transform_edt(~hit, return_distances=True, return_indices=True)
    img = img[tuple(near)]
    alpha = np.where(gap <= fill, 255, 0).astype(np.uint8)
    # Края облака (редкие точки) — тоже прозрачно: там вместо снимка «сито».
    dens = ndimage.uniform_filter(hit.astype(np.float32), int(6 * px))
    alpha[dens < 0.12] = 0
    return np.dstack([img, alpha])


def write_geotiff(rgba: np.ndarray, path: Path, bounds):
    """RGBA → GeoTIFF EPSG:4326 (west, south, east, north — по краям пикселей) через GDAL в Docker."""
    west, south, east, north = bounds
    png = path.with_suffix('.png')
    Image.fromarray(rgba, 'RGBA').save(png)
    folder = path.parent.resolve()
    subprocess.run([
        'docker', 'run', '--rm', '--entrypoint', GDAL, '-v', f'{folder}:/work', 'opendronemap/odm:latest',
        '-q', '-of', 'GTiff', '-a_srs', 'EPSG:4326', '-a_ullr', repr(west), repr(north), repr(east), repr(south),
        '-co', 'COMPRESS=DEFLATE', '-co', 'PREDICTOR=2', '-co', 'TILED=YES', f'/work/{png.name}', f'/work/{path.name}',
    ], check=True)
    png.unlink()


def candidates_sheet(world, rgb, t: Territory, survey: dict, px: float, out: Path, size: float = 44.0):
    """Листы для отбора: вокруг каждой найденной постройки — снимок, она жёлтая (сарай) или голубая (дом), дома OSM — красные."""
    found = survey.get('buildings', [])
    if not found:
        return
    cell = int(size * px)
    cols = 8
    rows = math.ceil(len(found) / cols)
    sheet = Image.new('RGB', (cols * cell, rows * (cell + 16)), (255, 255, 255))
    draw = ImageDraw.Draw(sheet)
    houses = t.buildings()
    order = np.argsort(world[:, 0])
    xs = world[order, 0]
    for k, b in enumerate(found):
        f = np.array(b['footprint'], float)
        x, y = t.local(f[:, 0], f[:, 1])
        cx, cy = float(np.mean(x)), float(np.mean(y))
        bx0, by1 = cx - size / 2, cy + size / 2
        i0, i1 = np.searchsorted(xs, [bx0, bx0 + size])
        idx = order[i0:i1]
        idx = idx[(world[idx, 1] <= by1) & (world[idx, 1] >= by1 - size)]
        tile = render(world[idx], rgb[idx], bx0, by1, cell, cell, px, fill=int(2 * px))
        im = Image.fromarray(tile[:, :, :3])
        d = ImageDraw.Draw(im)
        to_px = lambda pts: [((a - bx0) * px, (by1 - c) * px) for a, c in pts]
        for _, ring, _ in houses:
            if abs(ring[:, 0].mean() - cx) < size and abs(ring[:, 1].mean() - cy) < size:
                d.line(to_px(ring), fill=(255, 0, 0), width=2)
        pts = list(zip(x, y))
        d.line(to_px(pts + [pts[0]]), fill=(0, 255, 255) if b['kind'] == 'house' else (255, 220, 0), width=3)
        ox, oy = (k % cols) * cell, (k // cols) * (cell + 16)
        sheet.paste(im, (ox, oy + 16))
        draw.text((ox + 4, oy + 2), f"{b['id'].split('/')[1]}  {b['kind']}  {b['height']} м", fill=(0, 0, 0))
    sheet.save(out, quality=88)
    print(f'листы для отбора: {len(found)} → {out}')


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('project')
    p.add_argument('--align', required=True)
    p.add_argument('--territory', required=True)
    p.add_argument('--out', required=True)
    p.add_argument('--px', type=float, default=4.0, help='пикселей на метр')
    p.add_argument('--tile', type=float, default=900.0, help='сторона квадрата, м')
    p.add_argument('--fill', type=int, default=6, help='заливать дыры до стольких пикселей')
    p.add_argument('--candidates', help='survey.json — нарисовать листы с найденными постройками')
    a = p.parse_args()

    t = Territory(a.territory)
    xyz, _, rgb = load_cloud(a.project)
    world = Alignment(a.align)(xyz)
    del xyz
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    # Квадраты по снятому, только с домами OSM внутри.
    centers = np.array([ring.mean(0) for _, ring, _ in t.buildings()])
    x0, x1 = np.percentile(world[:, 0], [0.5, 99.5])
    y0, y1 = np.percentile(world[:, 1], [0.5, 99.5])
    step = a.tile - 60  # квадраты внахлёст на 60 м
    count = 0
    for ty in np.arange(y1, y0, -step):
        for tx in np.arange(x0, x1, step):
            inside = (centers[:, 0] > tx) & (centers[:, 0] < tx + a.tile) & (centers[:, 1] < ty) & (centers[:, 1] > ty - a.tile)
            if inside.sum() < 10:
                continue
            n = int(a.tile * a.px)
            rgba = render(world, rgb, tx, ty, n, n, a.px, a.fill)
            if (rgba[:, :, 3] > 0).mean() < 0.15:
                continue
            west, north = t.lonlat(tx, ty)
            east, south = t.lonlat(tx + a.tile, ty - a.tile)
            count += 1
            path = out / f'ortho-{count}.tif'
            write_geotiff(rgba, path, (float(west), float(south), float(east), float(north)))
            Image.fromarray(rgba[::4, ::4, :3]).save(out / f'ortho-{count}-preview.jpg', quality=85)
            print(f'{path.name}: {inside.sum()} домов OSM, {path.stat().st_size / 1e6:.1f} МБ')

    if a.candidates:
        candidates_sheet(world, rgb, t, json.load(open(a.candidates)), a.px, out / 'candidates.jpg')


if __name__ == '__main__':
    main()
