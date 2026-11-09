#!/usr/bin/env python3
"""Находки по своей съёмке с дрона → public/data/territories/<id>/survey.json.

  1. Цвет кровли дома OSM — медианный цвет точек облака внутри контура выше земли на 2+ м,
     приведённый к ближайшему типичному цвету кровли (профнастил, шифер), если он близко.
  2. Цвет стен — точки у контура (полоса ±0,7 м) на высоте 0,5–2,5 м с «вертикальной» нормалью.
     С большой высоты стены в облако почти не попадают — тогда цвета нет (остаётся модельный).
  3. Постройки, которых нет в OSM, — компактные пятна выше земли на 2,2–12 м, не зелёные (не деревья), не тёмные
     (тени в лесу), не на самих домах OSM, но во дворе — не дальше --near м от них; контур — наименьший
     охватывающий прямоугольник. Находки стоит просмотреть (ortho.py --candidates) и лишние убрать (--drop).

  python3 scripts/drone/survey.py <проект ODM> --align align.json --territory itkulovo-1
Нужен <проект>/terrain-dtm.npz от terrain.py (земля и верх в высотах облака).
"""

import argparse
import datetime
import json
from pathlib import Path

import numpy as np
from matplotlib.path import Path as PolyPath
from PIL import Image, ImageDraw
from scipy import ndimage

from common import Alignment, Territory, load_cloud, save_json

ROOF_PALETTE = ['#3f6b4f', '#4a7a46', '#2f5f8f', '#5b8bb5', '#2f8f88', '#7c2e2e', '#a33a2e', '#5a3a2e',
                '#8a8f94', '#4a4f55', '#9a9a92', '#c8ccd0', '#6b6f73']
WALL_PALETTE = ['#8a6a48', '#a07a50', '#6f5a45', '#c9b48a', '#e8e2d2', '#f2efe6', '#5f8fbf', '#7fb0d8', '#3f7f5f',
                '#8fbf8f', '#d9c26a', '#a33a2e', '#c86a4a', '#d8d2c4', '#9aa0a6']


def hexcolor(rgb) -> str:
    return '#%02x%02x%02x' % tuple(int(max(0, min(255, round(v)))) for v in rgb)


def rgb_of(h: str):
    return np.array([int(h[i:i + 2], 16) for i in (1, 3, 5)], float)


def snap(rgb, palette, limit=60.0, gain=1.25):
    """К ближайшему типичному цвету, если он близко; иначе — свой цвет, чуть светлее (видео темнит)."""
    col = np.clip(np.asarray(rgb, float) * gain, 0, 255)
    best = min(palette, key=lambda h: np.linalg.norm(rgb_of(h) - col))
    return best if np.linalg.norm(rgb_of(best) - col) < limit else hexcolor(col)


def green(rgb) -> np.ndarray:
    r, g, b = rgb[:, 0].astype(int), rgb[:, 1].astype(int), rgb[:, 2].astype(int)
    return (g > r + 8) & (g > b + 4)


def edge_distance(points: np.ndarray, ring: np.ndarray) -> np.ndarray:
    """Расстояние от точек до ближайшей стороны контура, м."""
    best = np.full(len(points), np.inf)
    for a, b in zip(ring[:-1], ring[1:]):
        ab = b - a
        t = np.clip(((points - a) @ ab) / max(ab @ ab, 1e-9), 0, 1)
        best = np.minimum(best, np.linalg.norm(points - (a + t[:, None] * ab), axis=1))
    return best


def min_area_rect(points: np.ndarray) -> np.ndarray:
    """Наименьший охватывающий прямоугольник (по сторонам выпуклой оболочки), 4 угла против часовой."""
    from scipy.spatial import ConvexHull
    hull = points[ConvexHull(points).vertices]
    best = None
    for i in range(len(hull)):
        e = hull[(i + 1) % len(hull)] - hull[i]
        if np.hypot(*e) < 1e-6:
            continue
        u = e / np.hypot(*e)
        v = np.array([-u[1], u[0]])
        pu, pv = hull @ u, hull @ v
        area = (pu.max() - pu.min()) * (pv.max() - pv.min())
        if best is None or area < best[0]:
            best = (area, u, v, pu.min(), pu.max(), pv.min(), pv.max())
    _, u, v, a0, a1, b0, b1 = best
    return np.array([u * a0 + v * b0, u * a1 + v * b0, u * a1 + v * b1, u * a0 + v * b1])


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('project')
    p.add_argument('--align', required=True)
    p.add_argument('--territory', required=True)
    p.add_argument('--no-buildings', action='store_true', help='не искать новые постройки (только цвета домов OSM)')
    p.add_argument('--drop', default='', help='номера находок, которые убрать после просмотра листов: 2,8,49')
    p.add_argument('--near', type=float, default=10.0, help='новые постройки — не дальше стольких метров от домов OSM')
    a = p.parse_args()

    t = Territory(a.territory)
    align = Alignment(a.align)
    m = align.matrix
    grid = np.load(Path(a.project) / 'terrain-dtm.npz')
    dtm, top, cnt = grid['dtm'], grid['top'], grid['cnt']
    gx0, gy1, res = float(grid['x0']), float(grid['y1']), float(grid['res'])
    h, w = dtm.shape
    # Земля без «дыр» (под лесом и по краям — ближайшая известная), чтобы мерить высоту над ней.
    known = np.isfinite(dtm)
    gap, near = ndimage.distance_transform_edt(~known, return_distances=True, return_indices=True)
    ground = dtm[tuple(near)]

    xyz, normals, rgb = load_cloud(a.project, step=2)
    world = align(xyz)
    del xyz
    rot = m[:3, :3] / np.linalg.norm(m[:3, 0])
    nz = np.abs(normals @ rot[2])  # вертикальная составляющая нормали в осях карты
    ix = np.clip(((world[:, 0] - gx0) / res).astype(int), 0, w - 1)
    iy = np.clip(((gy1 - world[:, 1]) / res).astype(int), 0, h - 1)
    hag = world[:, 2] - ground[iy, ix]
    order = np.argsort(world[:, 0])
    xs = world[order, 0]

    def points_in(poly: np.ndarray, grow: float = 0.0):
        i0, i1 = np.searchsorted(xs, [poly[:, 0].min() - grow, poly[:, 0].max() + grow])
        idx = order[i0:i1]
        idx = idx[(world[idx, 1] >= poly[:, 1].min() - grow) & (world[idx, 1] <= poly[:, 1].max() + grow)]
        return idx

    # 1–2. Цвета домов OSM.
    houses = {}
    osm_mask = np.zeros((h, w), bool)
    roofs = walls = 0
    osm = t.buildings()
    centers = np.array([ring.mean(0) for _, ring, _ in osm])
    for oid, ring, _ in osm:
        cols = ((ring[:, 0] - gx0) / res).astype(int)
        rows = ((gy1 - ring[:, 1]) / res).astype(int)
        if cols.max() < 0 or rows.max() < 0 or cols.min() >= w or rows.min() >= h:
            continue
        # Земля рядом с домом должна быть известна (не дальше 8 м), иначе высоту над ней не измерить.
        cr = int(np.clip(rows.mean(), 0, h - 1))
        cc = int(np.clip(cols.mean(), 0, w - 1))
        if gap[cr, cc] * res > 8:
            continue
        idx = points_in(ring, 1.0)
        if len(idx) == 0:
            continue
        xy = world[idx, :2]
        dist = edge_distance(xy, ring)
        inside = PolyPath(ring).contains_points(xy) & (dist > 0.5)
        band = dist < 0.7
        entry = {}
        roof = idx[inside & (hag[idx] > 2.0) & ~green(rgb[idx])]
        if len(roof) >= 20 and len(roof) > 0.25 * max(inside.sum(), 1):
            entry['roof'] = snap(np.median(rgb[roof].astype(float), 0), ROOF_PALETTE)
            roofs += 1
        wall = idx[band & (hag[idx] > 0.5) & (hag[idx] < 2.5) & (nz[idx] < 0.45) & ~green(rgb[idx])]
        if len(wall) >= 30:
            entry['wall'] = snap(np.median(rgb[wall].astype(float), 0), WALL_PALETTE, limit=55)
            walls += 1
        if entry:
            houses[oid] = entry
        # Маска домов OSM с запасом 2 м — там новые постройки не ищем.
        im = Image.new('1', (w, h), 0)
        ImageDraw.Draw(im).polygon(list(zip(cols.tolist(), rows.tolist())), fill=1)
        osm_mask |= np.array(im, bool)
    osm_mask = ndimage.binary_dilation(osm_mask, iterations=int(round(2 / res)))
    print(f'дома OSM в снятом: цвет кровли у {roofs}, цвет стен у {walls}')

    # 3. Постройки, которых нет в OSM: высоко над землёй, не зелёное, компактное.
    if a.no_buildings:
        high = np.zeros((h, w), bool)
    else:
        high = np.isfinite(top) & (top - ground > 2.2) & (top - ground < 12) & (cnt >= 2) & ~osm_mask
    sel = (hag > 2.0) & (hag < 12)
    gcell = np.zeros(h * w)
    allc = np.zeros(h * w)
    np.add.at(allc, iy[sel] * w + ix[sel], 1)
    np.add.at(gcell, iy[sel] * w + ix[sel], green(rgb[sel]).astype(float))
    greenish = (gcell / np.maximum(allc, 1)).reshape(h, w) > 0.35
    candidates = ndimage.binary_opening(high & ~greenish, iterations=1)
    # Только в деревне: не дальше 60 м от домов OSM и там, где рельеф надёжный (не лес, не редкие края).
    village = ndimage.distance_transform_edt(~osm_mask) * res < 60
    candidates &= village & ndimage.binary_erosion(known, iterations=2)
    density = np.median(cnt[cnt > 0])
    labels, n = ndimage.label(candidates)
    found = []
    for k, sl in enumerate(ndimage.find_objects(labels), start=1):
        if sl is None:
            continue
        region = labels[sl] == k
        area = region.sum() * res * res
        if area < 9 or area > 250:
            continue
        # Крыша — ровная и плотно снятая (у кроны деревьев высота «гуляет», у шума — мало точек).
        roof_top = (top - ground)[sl][region]
        if np.std(roof_top) > 1.3 or np.mean(cnt[sl][region]) < 0.6 * density:
            continue
        rr, cc = np.nonzero(region)
        pts = np.stack([gx0 + (cc + sl[1].start + 0.5) * res, gy1 - (rr + sl[0].start + 0.5) * res], 1)
        rect = min_area_rect(pts)
        rect_area = np.linalg.norm(rect[1] - rect[0]) * np.linalg.norm(rect[3] - rect[0])
        if rect_area <= 0 or area / rect_area < 0.6:
            continue
        sides = sorted([np.linalg.norm(rect[1] - rect[0]), np.linalg.norm(rect[3] - rect[0])])
        if sides[0] < 2.2 or sides[1] / sides[0] > 4:
            continue
        height = float(np.percentile((top - ground)[sl][region], 80))
        idx = points_in(rect)
        idx = idx[PolyPath(rect).contains_points(world[idx, :2]) & (hag[idx] > 1.8)]
        if len(idx) < 15 or green(rgb[idx]).mean() > 0.3:
            continue
        # Сараи, бани, гаражи стоят во дворах — рядом с домом. Дальше от домов «находки» — почти всегда
        # кроны и тени леса, кучи, стога; тёмные — тени в лесу.
        nearest = np.argsort(((centers - rect.mean(0)) ** 2).sum(1))[:8]
        gap_m = min(edge_distance(rect, osm[k][1]).min() for k in nearest)
        colour = np.median(rgb[idx].astype(float), 0)
        if gap_m > a.near or colour.mean() < 70:
            continue
        kind = 'house' if area >= 45 and height >= 4.5 else 'shed'
        lon, lat = t.lonlat(rect[:, 0], rect[:, 1])
        found.append({'id': f'survey/{len(found) + 1}', 'kind': kind, 'footprint': [[float(x), float(y)] for x, y in zip(lon, lat)],
                      'height': round(max(2.5, min(height, 9.0)), 1), 'roof': snap(colour, ROOF_PALETTE)})
    print(f'построек, которых нет в OSM: {len(found)} (домов {sum(f["kind"] == "house" for f in found)}, '
          f'сараев, гаражей, бань {sum(f["kind"] == "shed" for f in found)})')

    drop = {f'survey/{n.strip()}' for n in a.drop.split(',') if n.strip()}
    if drop:
        found = [f for f in found if f['id'] not in drop]
        print(f'после просмотра убрано {len(drop)}, осталось {len(found)}')
    out = t.data / 'survey.json'
    save_json(out, {
        'metadata': {'source': 'Своя съёмка с дрона, OpenDroneMap', 'credit': 'Цвета домов и постройки: своя съёмка с дрона',
                     'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat()},
        'houses': houses,
        'buildings': found,
    })
    print(f'→ {out}')


if __name__ == '__main__':
    main()
