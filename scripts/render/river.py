#!/usr/bin/env python3
"""Речка как на картинке-рендере: русло со всеми изгибами и переменной шириной → water-render.json.

В OSM речка — грубая ломаная. На карте она видна тёмной сизой лентой, но такими же тёмными бывают тени
деревьев, поэтому по всей карте воду не выделить. Берём русло OSM как подсказку: в коридоре вокруг него
ищем путь от одного конца до другого, который идёт по самому «водному» цвету (тёмное, без зелени), —
это и есть настоящее русло с изгибами. Ширина в каждой точке — длина водной полоски поперёк русла.

  python3 scripts/render/river.py <render.jpg> --territory itkulovo-1 [--preview лист.jpg]
"""

import argparse
import datetime
import heapq
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'drone'))
from common import Territory, save_json  # noqa: E402

Image.MAX_IMAGE_PIXELS = None
CORRIDOR = 190.0  # насколько настоящее русло может уходить от линии OSM, м


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('image')
    p.add_argument('--territory', required=True)
    p.add_argument('--preview')
    a = p.parse_args()

    t = Territory(a.territory)
    align = json.load(open(Path(a.image).with_suffix('.align.json')))
    m = np.array(align['world_to_pixel'])
    inv = np.linalg.inv(np.vstack([m, [0, 0, 1]]))
    k = 2
    full = Image.open(a.image).convert('RGB')
    W, H = full.size
    img = np.asarray(full.resize((W // k, H // k), Image.BILINEAR), np.float32)
    mpp = float(np.mean(align['metres_per_pixel'])) * k
    r, g, b = img[..., 0], img[..., 1], img[..., 2]
    luma = 0.3 * r + 0.55 * g + 0.15 * b
    # Вода: тёмная и не зелёная (синего не меньше, чем зелёного); тень на траве — тёмно-зелёная.
    dark = np.clip((95 - luma) / 45, 0, 1)
    neutral = np.clip((b - g + 14) / 16, 0, 1)
    # Речка — узкая лента: широкие тёмные пятна (тень леса) водой не считаем.
    ribbon = dark * neutral
    blob = ndimage.uniform_filter(ribbon, int(22 / mpp))
    water = ndimage.gaussian_filter(ribbon * np.clip(1.6 - 2.6 * blob, 0, 1), 0.7)

    # Тёмные крыши похожи на воду: под домами (OSM и найденными по съёмке, с запасом 2 м) воды нет.
    roofs = Image.new('1', (W // k, H // k), 0)
    rd = ImageDraw.Draw(roofs)
    rings = [ring for _, ring, _ in t.buildings()]
    if (t.data / 'survey.json').exists():
        for bld in json.load(open(t.data / 'survey.json')).get('buildings', []):
            c = np.array(bld['footprint'], float)
            x, y = t.local(c[:, 0], c[:, 1])
            rings.append(np.stack([x, y], 1))
    for ring in rings:
        rd.polygon([tuple(v) for v in (np.c_[ring, np.ones(len(ring))] @ m.T) / k], fill=1)
    built = ndimage.binary_dilation(np.array(roofs, bool), iterations=max(1, int(2 / mpp)))
    water[built] = 0
    block = built

    rivers, sheet = [], []
    for f in json.load(open(t.data / 'ground.geojson'))['features']:
        if f['properties']['kind'] != 'water':
            continue
        polys = [f['geometry']['coordinates']] if f['geometry']['type'] == 'Polygon' else f['geometry']['coordinates']
        for poly in polys:
            c = np.array(poly[0], float)
            x, y = t.local(c[:, 0], c[:, 1])
            px = (np.c_[x, y, np.ones(len(x))] @ m.T) / k
            x0, y0 = np.floor(px.min(0) - CORRIDOR / mpp - 2).astype(int)
            x1, y1 = np.ceil(px.max(0) + CORRIDOR / mpp + 2).astype(int)
            x0, y0, x1, y1 = max(0, x0), max(0, y0), min(W // k, x1), min(H // k, y1)
            if x1 - x0 < 8 or y1 - y0 < 8:
                continue
            hint = Image.new('1', (x1 - x0, y1 - y0), 0)
            ImageDraw.Draw(hint).line([tuple(v) for v in px - [x0, y0]] + [tuple(px[0] - [x0, y0])], fill=1, width=2)
            away = ndimage.distance_transform_edt(~np.array(hint, bool)) * mpp
            allowed = (away < CORRIDOR) & ~block[y0:y1, x0:x1]
            # Концы: две самые далёкие друг от друга вершины контура OSM.
            d2 = ((px[:, None, :] - px[None, :, :]) ** 2).sum(-1)
            i, j = np.unravel_index(d2.argmax(), d2.shape)
            start = tuple(np.round(px[i] - [x0, y0]).astype(int)[::-1])
            goal = tuple(np.round(px[j] - [x0, y0]).astype(int)[::-1])
            w = water[y0:y1, x0:x1]
            # Идти по воде дёшево, по суше дорого; чем дальше от подсказки OSM, тем чуть дороже.
            cost = 1 + 30 * (1 - w) ** 2 + 1.0 * (away / CORRIDOR) ** 2
            hh, ww = cost.shape
            best = np.full((hh, ww), np.inf)
            prev = np.full((hh, ww, 2), -1, np.int32)
            best[start] = 0
            heap = [(0.0, start)]
            steps = [(-1, 0, 1), (1, 0, 1), (0, -1, 1), (0, 1, 1), (-1, -1, 1.414), (-1, 1, 1.414), (1, -1, 1.414), (1, 1, 1.414)]
            while heap:
                dist, (cy, cx) = heapq.heappop(heap)
                if (cy, cx) == goal:
                    break
                if dist > best[cy, cx]:
                    continue
                for dy, dx, length in steps:
                    ny, nx = cy + dy, cx + dx
                    if 0 <= ny < hh and 0 <= nx < ww and allowed[ny, nx]:
                        nd = dist + cost[ny, nx] * length
                        if nd < best[ny, nx]:
                            best[ny, nx] = nd
                            prev[ny, nx] = (cy, cx)
                            heapq.heappush(heap, (nd, (ny, nx)))
            if not np.isfinite(best[goal]):
                continue
            path = [goal]
            while path[-1] != start:
                path.append(tuple(prev[path[-1]]))
            path = np.array(path[::-1], float)
            # Сгладить «лесенку» клеток и взять точку каждые ~2 м.
            for _ in range(2):
                path[1:-1] = (path[:-2] + 2 * path[1:-1] + path[2:]) / 4
            keep = [0]
            for n in range(1, len(path)):
                if np.hypot(*(path[n] - path[keep[-1]])) * mpp >= 2.0:
                    keep.append(n)
            path = path[keep]
            # Ширина: сколько воды поперёк русла (до 7 м в каждую сторону).
            tang = np.gradient(path, axis=0)
            tang /= np.maximum(np.hypot(tang[:, 0], tang[:, 1]), 1e-6)[:, None]
            normal = np.stack([-tang[:, 1], tang[:, 0]], 1)
            offs = np.arange(-7, 7.01, 0.5) / mpp
            pts = path[:, None, :] + normal[:, None, :] * offs[None, :, None]
            across = ndimage.map_coordinates(w, [pts[..., 0], pts[..., 1]], order=1, mode='nearest') > 0.42
            mid = len(offs) // 2
            width = np.zeros(len(path))
            for n in range(len(path)):
                lo = hi = mid
                while lo > 0 and across[n, lo - 1]:
                    lo -= 1
                while hi < len(offs) - 1 and across[n, hi + 1]:
                    hi += 1
                width[n] = (hi - lo) * 0.5 if across[n, mid] or lo != hi else 0
            # Где воды не видно (под деревьями) — как у соседних участков; не уже 1,4 и не шире 9 м.
            seen = width > 0.9
            if seen.any():
                width = np.interp(np.arange(len(width)), np.nonzero(seen)[0], width[seen])
            width = np.clip(ndimage.median_filter(width, 5, mode='nearest'), 1.4, 9.0)
            width = ndimage.gaussian_filter1d(width, 1.5, mode='nearest')
            world = (np.c_[(path[:, 1] + x0 + 0.5) * k, (path[:, 0] + y0 + 0.5) * k, np.ones(len(path))] @ inv.T)[:, :2]
            lon, lat = t.lonlat(world[:, 0], world[:, 1])
            rivers.append([[round(float(lo_), 7), round(float(la_), 7), round(float(wd), 1)] for lo_, la_, wd in zip(lon, lat, width)])
            sheet.append((np.c_[(path[:, 1] + x0) * k, (path[:, 0] + y0) * k], width, px * k))
            print(f'русло: {len(path)} точек, {np.hypot(*np.diff(world, axis=0).T).sum():.0f} м, ширина {width.min():.1f}…{width.max():.1f} м (медиана {np.median(width):.1f}), воды видно на {seen.mean() * 100:.0f} %', flush=True)

    save_json(t.data / 'water-render.json', {
        'metadata': {'territory': t.id, 'source': 'Русло речки снято с картинки-рендера деревни (в коридоре вокруг русла OSM): осевая линия и ширина в каждой точке',
                     'generatedAt': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')},
        'rivers': rivers,
    })
    if a.preview:
        d = ImageDraw.Draw(full)
        for path, width, hint in sheet:
            d.line([tuple(v) for v in hint], fill=(255, 60, 60), width=2)
            for (x, y), wd in zip(path, width):
                rad = wd / 2 / (mpp / k)
                d.ellipse([x - rad, y - rad, x + rad, y + rad], outline=(0, 255, 255))
        full.save(a.preview, quality=88)


if __name__ == '__main__':
    main()
