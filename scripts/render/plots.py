#!/usr/bin/env python3
"""Замкнутые заборы: вокруг каждого жилого дома — участок-четырёхугольник → fences-render.json.

Отдельные линии заборов с карты (fences-lines.json от extract.py) рвутся, и забор «в одну линию» не бывает.
Участок же почти всегда четырёхугольник: прямоугольник или трапеция. Поэтому для каждого дома ищем четыре
стороны: спереди (к улице), сзади, слева и справа. Сторона — ближайшая найденная линия забора, идущая в нужном
направлении напротив дома; её прямая продлевается. Если линии нет, сторона ставится по обычаю: спереди — у
дороги, по бокам — посередине до соседа, сзади — в 32 м. Четыре прямые пересекаются в четырёх углах —
контур замкнут. Затем участки разводятся: спорное место достаётся ближнему дому, дороги и речка — ничьи;
заборы — границы получившихся областей, так что они не пересекаются и на дорогу не выходят.

  python3 scripts/render/plots.py --territory itkulovo-1 [--image render.jpg --preview лист.jpg]
"""

import argparse
import datetime
import json
import sys
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'drone'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import Territory, save_json  # noqa: E402

HOUSE_TAGS = {'yes', 'house', 'detached', 'residential', 'semidetached_house', 'bungalow', 'farm'}


def cross(a, b):
    return a[0] * b[1] - a[1] * b[0]


def meet(p, d, q, e):
    """Точка пересечения прямых p + t·d и q + s·e."""
    den = cross(d, e)
    if abs(den) < 1e-6:
        return None
    return p + d * (cross(q - p, e) / den)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--territory', required=True)
    p.add_argument('--image')
    p.add_argument('--preview')
    a = p.parse_args()

    t = Territory(a.territory)
    local = lambda coords: np.stack(t.local(np.array(coords, float)[:, 0], np.array(coords, float)[:, 1]), 1)
    segs = []
    for line in json.load(open(t.data / 'fences-lines.json'))['fences']:
        pts = local(line)
        segs += [(u, v) for u, v in zip(pts[:-1], pts[1:]) if np.hypot(*(v - u)) >= 6]
    s0 = np.array([s[0] for s in segs])
    s1 = np.array([s[1] for s in segs])
    smid, sdir = (s0 + s1) / 2, s1 - s0
    slen = np.hypot(sdir[:, 0], sdir[:, 1])
    sdir = sdir / slen[:, None]
    seg_tree = cKDTree(smid)

    fits = json.load(open(t.data / 'buildings-fit.json'))['footprints'] if (t.data / 'buildings-fit.json').exists() else {}
    houses = []
    for oid, ring, props in t.buildings():
        if oid in fits:
            ring = local(fits[oid])
        ring = ring[:-1] if np.allclose(ring[0], ring[-1]) else ring
        area = abs(sum(cross(ring[i], ring[(i + 1) % len(ring)]) for i in range(len(ring)))) / 2
        if props.get('building') in HOUSE_TAGS and 32 <= area <= 400:
            houses.append((oid, ring, ring.mean(0)))
    centres = np.array([h[2] for h in houses])
    roads = t.road_samples(2.0)
    road_tree = cKDTree(roads)

    plots, stats = [], {'по заборам': 0, 'по обычаю': 0}
    for n, (oid, ring, c) in enumerate(houses):
        dist, i = road_tree.query(c)
        f = (roads[i] - c) / dist if 1 < dist < 70 else np.array([0.0, -1.0])
        s = np.array([-f[1], f[0]])
        hf = np.abs((ring - c) @ f).max()   # полуглубина дома к улице
        hs = np.abs((ring - c) @ s).max()   # полуширина вдоль улицы
        near = seg_tree.query_ball_point(c, 85)

        def side(normal, along, half_n, half_a, lo, hi, parallel):
            """Ближайшая линия забора со стороны normal: (точка, направление) или None."""
            best = None
            for j in near:
                if abs(sdir[j] @ along) < (0.9 if parallel else 0.0):
                    continue
                if abs(sdir[j] @ normal) > 0.42:
                    continue
                d = (smid[j] - c) @ normal
                if not (half_n + lo < d <= hi):
                    continue
                # Линия должна идти напротив дома: её проекция вдоль стороны перекрывает дом (с запасом).
                a0, a1 = sorted([(s0[j] - c) @ along, (s1[j] - c) @ along])
                if min(a1, half_a + 4) - max(a0, -half_a - 4) < 3:
                    continue
                if best is None or d < best[0]:
                    best = (d, smid[j], sdir[j], slen[j])
            return best

        found = 0
        lines = []
        rel = centres - c
        front_default = max(hf + 1.5, dist - 5.5) if dist < 70 else hf + 6
        # Спереди — у дороги; сзади — первая линия дальше 12 м за домом (ближе — перегородки двора).
        for normal, along, hn, ha, lo, hi, default in (
            (f, s, hf, hs, 0.8, min(28.0, front_default + 4), front_default),
            (s, f, hs, hf, 1.5, 34.0, hs + 12.0),
            (-f, s, hf, hs, 12.0, 75.0, hf + 32.0),
            (-s, f, hs, hf, 1.5, 34.0, hs + 12.0),
        ):
            # Участок не заходит за середину до соседнего дома в эту сторону.
            ahead = (rel @ normal > hn + 3) & (rel @ normal < 90) & (np.abs(rel @ along) < 18)
            limit = (rel[ahead] @ normal).min() / 2 + 1.0 if ahead.any() else 1e9
            got = side(normal, along, hn, ha, lo, min(hi, limit), True)
            if got:
                found += 1
                # Короткая или косая линия задаёт только место стороны, а направление — как у дома и улицы:
                # иначе участок перекашивает в треугольник.
                d = got[2] if got[2] @ along > 0 else -got[2]
                lines.append((got[1], d if got[3] >= 12 and d @ along > 0.966 else along))
                continue
            lines.append((c + normal * max(hn + 2.0, min(default, limit)), along))
        corners = [meet(*lines[i], *lines[(i + 1) % 4]) for i in range(4)]
        ok = all(q is not None for q in corners)
        if ok:
            q = np.array(corners)
            area = sum(cross(q[i], q[(i + 1) % 4]) for i in range(4)) / 2
            turns = [cross(q[(i + 1) % 4] - q[i], q[(i + 2) % 4] - q[(i + 1) % 4]) for i in range(4)]
            inside = all(cross(q[(i + 1) % 4] - q[i], c - q[i]) * np.sign(area) > 0 for i in range(4))
            ok = 140 <= abs(area) <= 7000 and (min(turns) > 0 or max(turns) < 0) and inside and np.abs(q - c).max() < 110
        if not ok:
            # Не сошлось в разумный четырёхугольник — прямоугольник из тех же сторон, но строго по осям дома.
            found = 0
            dn = [float((lines[i][0] - c) @ nrm) for i, nrm in enumerate((f, s, -f, -s))]
            q = np.array([c + f * dn[0] + s * dn[1], c - f * dn[2] + s * dn[1], c - f * dn[2] - s * dn[3], c + f * dn[0] - s * dn[3]])
        stats['по заборам' if found >= 2 else 'по обычаю'] += 1
        plots.append(q)

    # Участки не залезают ни на дорогу, ни друг на друга. Раскладываем их на сетку 0,5 м: спорная клетка
    # достаётся тому участку, чей дом ближе; клетки дорог и речки — ничьи. От участка остаётся связный кусок
    # с домом. Заборы — границы получившихся областей: общая граница соседей — один забор.
    from PIL import Image, ImageDraw
    from scipy import ndimage
    from extract import simplify, thin, trace
    cell = 0.5
    allq = np.vstack(plots)
    gx0, gy0 = allq.min(0) - 6
    gw, gh = (np.ceil((allq.max(0) - [gx0, gy0] + 6) / cell)).astype(int)
    to_grid = lambda xy: (np.asarray(xy) - [gx0, gy0]) / cell
    owner = np.zeros((gh, gw), np.int32)
    best = np.full((gh, gw), np.inf, np.float32)
    for n, (q, (_, _, c)) in enumerate(zip(plots, houses), start=1):
        g = to_grid(q)
        x0, y0 = np.maximum(np.floor(g.min(0)).astype(int), 0)
        x1, y1 = np.minimum(np.ceil(g.max(0)).astype(int) + 1, [gw, gh])
        if x1 <= x0 or y1 <= y0:
            continue
        mask = Image.new('1', (x1 - x0, y1 - y0), 0)
        ImageDraw.Draw(mask).polygon([tuple(v) for v in g - [x0, y0]], fill=1)
        mask = np.array(mask, bool)
        yy, xx = np.mgrid[y0:y1, x0:x1]
        cg = to_grid(c)
        d = np.hypot(xx - cg[0], yy - cg[1]).astype(np.float32)
        take = mask & (d < best[y0:y1, x0:x1])
        owner[y0:y1, x0:x1][take] = n
        best[y0:y1, x0:x1][take] = d[take]
    ban = Image.new('1', (gw, gh), 0)
    bd = ImageDraw.Draw(ban)
    streets = json.load(open(t.data / 'streets.json'))
    extra = json.load(open(t.data / 'streets-render.json')) if (t.data / 'streets-render.json').exists() else {}
    for i, way in enumerate(streets['roads']):
        width = extra.get('widths', {}).get(str(i), way['width'])
        bd.line([tuple(v) for v in to_grid(local(way['coords']))], fill=1, width=int((width + 3.0) / cell))
    for way in streets.get('paths', []) + extra.get('paths', []):
        bd.line([tuple(v) for v in to_grid(local(way['coords']))], fill=1, width=int((way['width'] + 1.5) / cell))
    if (t.data / 'water-render.json').exists():
        for river in json.load(open(t.data / 'water-render.json'))['rivers']:
            bd.line([tuple(v) for v in to_grid(local(river))], fill=1, width=int(6 / cell))
    owner[np.array(ban, bool)] = 0
    # Только связный кусок с домом; оторванные дорогой или соседом лоскуты — ничьи.
    kept = np.zeros_like(owner)
    slices = ndimage.find_objects(owner)
    for n, sl in enumerate(slices, start=1):
        if sl is None:
            continue
        part, count = ndimage.label(owner[sl] == n)
        if not count:
            continue
        cg = np.round(to_grid(houses[n - 1][2])).astype(int) - [sl[1].start, sl[0].start]
        inside = 0 <= cg[1] < part.shape[0] and 0 <= cg[0] < part.shape[1]
        want = part[cg[1], cg[0]] if inside and part[cg[1], cg[0]] else np.bincount(part.ravel())[1:].argmax() + 1
        region = part == want
        if region.sum() * cell * cell >= 80:
            kept[sl][region] = n
    owner = kept
    # Сгладить ступеньки сетки по краям.
    filled = ndimage.binary_opening(owner > 0, iterations=2)
    owner[~filled] = 0
    border = np.zeros(owner.shape, bool)
    border[:, :-1] |= owner[:, :-1] != owner[:, 1:]
    border[:-1, :] |= owner[:-1, :] != owner[1:, :]
    out_sides = []
    for line in trace(thin(border)):
        if len(line) < 5:
            continue
        path = simplify(line, 1.4 / cell)
        world = np.c_[path[:, 1], path[:, 0]] * cell + [gx0, gy0]
        if np.hypot(*np.diff(world, axis=0).T).sum() >= 2.5:
            out_sides.append(world)
    left = len(np.unique(owner)) - 1

    total = sum(np.hypot(*np.diff(sd, axis=0).T).sum() for sd in out_sides)
    fences = []
    for sd in out_sides:
        lon, lat = t.lonlat(sd[:, 0], sd[:, 1])
        fences.append([[round(float(x), 7), round(float(y), 7)] for x, y in zip(lon, lat)])
    save_json(t.data / 'fences-render.json', {
        'metadata': {'territory': t.id, 'source': 'Заборы — участки-четырёхугольники вокруг жилых домов: стороны по линиям заборов с картинки-рендера (fences-lines.json), а где линии нет — по обычаю; замкнуты по построению',
                     'generatedAt': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')},
        'fences': fences,
    })
    print(f'участков {left} из {len(plots)}: {stats["по заборам"]} по найденным заборам (2+ стороны), {stats["по обычаю"]} по обычаю; сторон-заборов {len(out_sides)}, {total:.0f} м')

    if a.preview and a.image:
        from PIL import Image, ImageDraw
        Image.MAX_IMAGE_PIXELS = None
        m = np.array(json.load(open(Path(a.image).with_suffix('.align.json')))['world_to_pixel'])
        to_px = lambda xy: np.c_[xy, np.ones(len(xy))] @ m.T
        im = Image.open(a.image).convert('RGB')
        d = ImageDraw.Draw(im)
        for u, v in segs:
            d.line([tuple(q) for q in to_px(np.array([u, v]))], fill=(0, 255, 255), width=1)
        for sd in out_sides:
            d.line([tuple(q) for q in to_px(sd)], fill=(255, 40, 200), width=3)
        im.save(a.preview, quality=88)


if __name__ == '__main__':
    main()
