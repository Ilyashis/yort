#!/usr/bin/env python3
"""Привязка модели OpenDroneMap (съёмка без координат) к карте района — матрица 4×4 «модель → локальные метры».

Шаги:
  1. topview  — выровнять модель по плоскости земли (вверх — к камерам) и нарисовать вид сверху,
                чтобы найти на нём 3+ места, узнаваемых на карте (перекрёстки, большие дома).
  2. init     — первое приближение: по парам «пиксель вида сверху ↔ долгота/широта» (--pairs)
                или по уже привязанной модели из тех же кадров (--other, --other-align): совмещаем центры камер.
  3. refine   — уточнение по дорогам: оси улиц OSM ложатся на серые полосы дорог в облаке точек.
  4. houses   — плавная поправка по домам OSM (съёмка без GPS по длинной полосе чуть изгибается):
                нужен terrain-dtm.npz от terrain.py; после неё terrain.py и survey.py запускаются заново.
  5. overlay  — картинка проверки: облако на карте и поверх — дома (красные) и улицы (синие) OSM.

  python3 scripts/drone/align.py topview <проект ODM> --out level.json --image top.jpg
  python3 scripts/drone/align.py init <проект> --level level.json --pairs pairs.json --territory itkulovo-1 --out align.json
  python3 scripts/drone/align.py init <проект> --other <другой проект> --other-align align-other.json --out align.json
  python3 scripts/drone/align.py refine <проект> --align align.json --territory itkulovo-1 --out align.json
  python3 scripts/drone/align.py houses <проект> --align align.json --territory itkulovo-1 --out align.json
  python3 scripts/drone/align.py overlay <проект> --align align.json --territory itkulovo-1 --image check.jpg [--crop x0,y0,x1,y1 --px 3]
"""

import argparse
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage, optimize

from common import Alignment, Territory, apply, camera_centers, load_cloud, save_json, similarity_2d, similarity_3d


def topview(a):
    xyz, _, rgb = load_cloud(a.project, step=10)
    cams = np.array(list(camera_centers(a.project).values()))
    mu = xyz.mean(0)
    sample = xyz[np.random.default_rng(0).choice(len(xyz), min(300_000, len(xyz)), replace=False)] - mu
    _, _, vt = np.linalg.svd(sample, full_matrices=False)
    up = vt[2] if np.mean((cams - mu) @ vt[2]) > 0 else -vt[2]
    ex = vt[0] - up * (vt[0] @ up)
    ex /= np.linalg.norm(ex)
    ey = np.cross(up, ex)
    level = np.eye(4)
    level[:3, :3] = np.stack([ex, ey, up])
    level[:3, 3] = -level[:3, :3] @ mu
    p = apply(level, xyz)
    x0, x1 = np.percentile(p[:, 0], [0.5, 99.5])
    y0, y1 = np.percentile(p[:, 1], [0.5, 99.5])
    s = 3000 / max(x1 - x0, y1 - y0)
    w, h = int((x1 - x0) * s) + 1, int((y1 - y0) * s) + 1
    ix = ((p[:, 0] - x0) * s).astype(int)
    iy = ((y1 - p[:, 1]) * s).astype(int)
    ok = (ix >= 0) & (ix < w) & (iy >= 0) & (iy < h)
    order = np.argsort(p[ok, 2])
    img = np.full((h, w, 3), 255, np.uint8)
    img[iy[ok][order], ix[ok][order]] = rgb[ok][order]
    Image.fromarray(img).save(a.image, quality=90)
    lc = apply(level, cams)
    save_json(a.out, {'level': level.tolist(), 'image': {'x0': float(x0), 'y1': float(y1), 'pxPerUnit': float(s), 'width': w, 'height': h},
                      'cameraHeight': float(np.median(lc[:, 2]) - np.median(p[:, 2]))})
    print(f'вид сверху {w}×{h} → {a.image}; камеры выше земли на {np.median(lc[:, 2]) - np.median(p[:, 2]):.2f} ед. модели')


def init(a):
    if a.other:
        mine = camera_centers(a.project)
        theirs = camera_centers(a.other)
        names = sorted(set(mine) & set(theirs))
        if len(names) < 10:
            raise SystemExit('Мало общих кадров у моделей — нужны одни и те же кадры.')
        other = np.array(json.load(open(a.other_align))['matrix'])
        src = np.array([mine[n] for n in names])
        dst = apply(other, np.array([theirs[n] for n in names]))
        m = similarity_3d(src, dst)
        err = np.linalg.norm(apply(m, src) - dst, axis=1)
        print(f'по {len(names)} общим кадрам: расхождение камер {np.median(err):.2f} м (медиана), {err.max():.2f} м (наибольшее)')
    else:
        level = json.load(open(a.level))
        im = level['image']
        t = Territory(a.territory)
        pairs = json.load(open(a.pairs))
        src = np.array([[im['x0'] + px / im['pxPerUnit'], im['y1'] - py / im['pxPerUnit']] for px, py, _, _ in pairs])
        dst = np.array([t.local(lon, lat) for _, _, lon, lat in pairs], float)
        m2 = similarity_3d(np.c_[src, np.zeros(len(src))], np.c_[dst, np.zeros(len(dst))])
        scale = np.linalg.norm(m2[:3, 0])
        theta = math.atan2(m2[1, 0], m2[0, 0])
        m = similarity_2d(scale, theta, m2[0, 3], m2[1, 3]) @ np.array(level['level'])
        res = np.linalg.norm(apply(m2, np.c_[src, np.zeros(len(src))])[:, :2] - dst, axis=1)
        print(f'масштаб {scale:.2f} м/ед., поворот {math.degrees(theta):.1f}°, расхождение по парам: {np.round(res, 1)} м')
    save_json(a.out, {'matrix': m.tolist()})


def road_likelihood(world: np.ndarray, rgb: np.ndarray, px: float = 1.0):
    """«Дорожность» вида сверху: серые (малонасыщенные, средней яркости) пиксели там, где точек много."""
    x0, x1 = np.percentile(world[:, 0], [0.2, 99.8])
    y0, y1 = np.percentile(world[:, 1], [0.2, 99.8])
    w, h = int((x1 - x0) * px) + 1, int((y1 - y0) * px) + 1
    ix = ((world[:, 0] - x0) * px).astype(int)
    iy = ((y1 - world[:, 1]) * px).astype(int)
    ok = (ix >= 0) & (ix < w) & (iy >= 0) & (iy < h)
    order = np.argsort(world[ok, 2])
    img = np.zeros((h, w, 3), np.float32)
    filled = np.zeros((h, w), bool)
    img[iy[ok][order], ix[ok][order]] = rgb[ok][order]
    filled[iy[ok][order], ix[ok][order]] = True
    mx, mn = img.max(-1), img.min(-1)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1), 1)
    dens = ndimage.uniform_filter(filled.astype(np.float32), 9)
    road = ((sat < 0.16) & (mx > 105) & (mx < 235) & filled & (dens > 0.6)).astype(np.float32)
    return ndimage.gaussian_filter(road, 2.5), dens, (x0, y1, px)


def refine(a):
    t = Territory(a.territory)
    m0 = np.array(json.load(open(a.align))['matrix'])
    xyz, _, rgb = load_cloud(a.project, step=2)
    world = apply(m0, xyz)
    like, dens, (x0, y1, px) = road_likelihood(world, rgb)
    q = t.road_samples()
    cx, cy = np.median(world[:, 0]), np.median(world[:, 1])

    def to_image(v, pts):
        """Поправка v = (масштаб, поворот, сдвиг) вокруг середины облака: точки карты → пиксели вида с m0."""
        s, th, tx, ty = v
        c, sn = math.cos(-th), math.sin(-th)
        x, y = (pts[:, 0] - cx - tx) / s, (pts[:, 1] - cy - ty) / s
        return (c * x - sn * y + cx - x0) * px, (y1 - (sn * x + c * y + cy)) * px

    v0 = np.array([1.0, 0.0, 0.0, 0.0])
    ix, iy = to_image(v0, q)
    inside = (ix > 5) & (ix < like.shape[1] - 5) & (iy > 5) & (iy < like.shape[0] - 5)
    inside &= dens[np.clip(iy.astype(int), 0, dens.shape[0] - 1), np.clip(ix.astype(int), 0, dens.shape[1] - 1)] > 0.6
    q = q[inside]
    if len(q) < 200:
        raise SystemExit('Мало улиц OSM внутри снятого — уточнять не по чему.')

    def score(v):
        ix, iy = to_image(v, q)
        return -float(ndimage.map_coordinates(like, [iy, ix], order=1, mode='constant').mean())

    best = v0
    for dx in range(-40, 41, 4):
        for dy in range(-40, 41, 4):
            v = v0 + [0, 0, dx, dy]
            if score(v) < score(best):
                best = v
    res = optimize.minimize(score, best, method='Nelder-Mead', options=dict(xatol=1e-4, fatol=1e-6, maxiter=4000, initial_simplex=[
        best, best + [0.02, 0, 0, 0], best + [0, 0.01, 0, 0], best + [0, 0, 3, 0], best + [0, 0, 0, 3]]))
    s, th, tx, ty = res.x
    fix = similarity_2d(1, 0, cx + tx, cy + ty) @ similarity_2d(s, th, 0, 0) @ similarity_2d(1, 0, -cx, -cy)
    print(f'по {len(q)} точкам улиц: совпадение {-score(v0):.3f} → {-res.fun:.3f}; поправка: масштаб ×{s:.4f}, '
          f'поворот {math.degrees(th):+.2f}°, сдвиг {tx:+.1f} {ty:+.1f} м')
    save_json(a.out, {'matrix': (fix @ m0).tolist()})


def house_scores(t: Territory, grid, reach: int):
    """По каждому дому OSM в снятом: доля клеток контура, где облако выше земли на 2+ м, при сдвигах
    контура на −reach…+reach клеток. Возвращает центры домов (N×2) и карты (N × (2r+1) × (2r+1))."""
    dtm, top = grid['dtm'], grid['top']
    x0, y1, res = float(grid['x0']), float(grid['y1']), float(grid['res'])
    known = np.isfinite(dtm)
    gap, near = ndimage.distance_transform_edt(~known, return_distances=True, return_indices=True)
    high = (np.nan_to_num(top - dtm[tuple(near)], nan=0) > 2.0).astype(np.float32)
    h, w = high.shape
    n = 2 * reach + 1
    centers, maps = [], []
    for _, ring, _ in t.buildings():
        c = (ring[:, 0] - x0) / res
        r = (y1 - ring[:, 1]) / res
        if c.min() < reach + 2 or r.min() < reach + 2 or c.max() > w - reach - 2 or r.max() > h - reach - 2:
            continue
        if gap[int(r.mean()), int(c.mean())] * res > 8:
            continue
        r0, c0 = int(r.min()) - reach, int(c.min()) - reach
        r1, c1 = int(r.max()) + reach + 2, int(c.max()) + reach + 2
        im = Image.new('1', (c1 - c0, r1 - r0), 0)
        ImageDraw.Draw(im).polygon(list(zip(c - c0, r - r0)), fill=1)
        mask = np.array(im, bool)
        if mask.sum() < 20:
            continue
        sub = high[r0:r1, c0:c1]
        # Свёртка маски с «высоким»: S[dy, dx] — доля контура, сдвинутого на dx вправо и dy вниз, над постройками.
        rr, cc = np.nonzero(mask)
        score = np.zeros((n, n), np.float32)
        for dy in range(-reach, reach + 1):
            for dx in range(-reach, reach + 1):
                score[dy + reach, dx + reach] = sub[np.clip(rr + dy, 0, sub.shape[0] - 1), np.clip(cc + dx, 0, sub.shape[1] - 1)].mean()
        centers.append(ring.mean(0))
        maps.append(score)
    return np.array(centers), np.array(maps), res


def houses(a):
    """Плавная поправка по домам OSM: в каждой округе (σ) — сдвиг, при котором контуры домов лучше всего
    ложатся на крыши облака. Нужен terrain-dtm.npz от terrain.py, построенный с этой же привязкой."""
    t = Territory(a.territory)
    align = Alignment(a.align)
    grid = np.load(Path(a.project) / 'terrain-dtm.npz')
    reach = int(round(a.reach))
    centers, maps, res = house_scores(t, grid, reach)
    if len(centers) < 10:
        raise SystemExit('Мало домов OSM в снятом — поправку не по чему считать.')
    lo, hi = centers.min(0), centers.max(0)
    xs = np.arange(lo[0], hi[0] + a.spacing, a.spacing)
    ys = np.arange(lo[1], hi[1] + a.spacing, a.spacing)
    anchors = []
    before = after = 0.0
    for y in ys:
        for x in xs:
            wts = np.exp(-((centers - [x, y]) ** 2).sum(1) / (2 * a.sigma ** 2))
            if wts.sum() < 4 or np.hypot(*(centers - [x, y]).T).min() > a.spacing:
                continue
            score = (wts[:, None, None] * maps).sum(0) / wts.sum()
            k = np.unravel_index(np.argmax(score), score.shape)
            # Сдвиг контуров OSM к крышам облака (восток, север), м; поправка облака — обратная.
            sx, sy = (k[1] - reach) * res, -(k[0] - reach) * res
            before += score[reach, reach] * wts.sum()
            after += score[k] * wts.sum()
            anchors.append((x, y, -sx, -sy, wts.sum()))
    anchors = np.array(anchors)
    # Опорные точки найдены в нынешней (уже поправленной) раскладке: переводим в координаты после матрицы
    # и складываем с прежней поправкой.
    q = anchors[:, :2]
    p = q - align.at(q) if len(align.anchors) else q
    old = align.at(p) if len(align.anchors) else np.zeros_like(p)
    total = old + anchors[:, 2:4]
    out = dict(align.data)
    out['warp'] = {'anchors': np.c_[p, total].round(3).tolist(), 'sigma': a.sigma,
                   'note': 'сдвиги облака к домам OSM (align.py houses)'}
    save_json(a.out, out)
    weight = anchors[:, 4].sum()
    print(f'{len(centers)} домов, {len(anchors)} опорных точек; совпадение крыш с контурами {before / weight:.3f} → {after / weight:.3f}; '
          f'поправка в этот раз: {np.abs(anchors[:, 2:4]).max():.0f} м наибольшая, итог: от {total.min(0).round(1)} до {total.max(0).round(1)} м')


def overlay(a):
    t = Territory(a.territory)
    xyz, _, rgb = load_cloud(a.project, step=1 if a.crop else 3)
    world = Alignment(a.align)(xyz)
    if a.crop:
        x0, y0, x1, y1 = map(float, a.crop.split(','))
    else:
        x0, x1 = np.percentile(world[:, 0], [0.5, 99.5])
        y0, y1 = np.percentile(world[:, 1], [0.5, 99.5])
    px = a.px
    w, h = int((x1 - x0) * px), int((y1 - y0) * px)
    ix = ((world[:, 0] - x0) * px).astype(int)
    iy = ((y1 - world[:, 1]) * px).astype(int)
    ok = (ix >= 0) & (ix < w) & (iy >= 0) & (iy < h)
    order = np.argsort(world[ok, 2])
    img = np.full((h, w, 3), 255, np.uint8)
    img[iy[ok][order], ix[ok][order]] = rgb[ok][order]
    im = Image.fromarray(img)
    d = ImageDraw.Draw(im)
    to_px = lambda p: [((x - x0) * px, (y1 - y) * px) for x, y in p]
    for _, ring, _ in t.buildings():
        d.line(to_px(ring), fill=(255, 0, 0), width=max(1, int(px)))
    s = json.load(open(t.data / 'streets.json'))
    for r in s['roads']:
        c = np.array(r['coords'], float)
        x, y = t.local(c[:, 0], c[:, 1])
        d.line(to_px(zip(x, y)), fill=(0, 90, 255), width=max(1, int(px)))
    im.save(a.image, quality=90)
    print(f'{w}×{h} → {a.image}')


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest='cmd', required=True)
    s = sub.add_parser('topview'); s.add_argument('project'); s.add_argument('--out', required=True); s.add_argument('--image', required=True)
    s = sub.add_parser('init'); s.add_argument('project'); s.add_argument('--out', required=True)
    s.add_argument('--level'); s.add_argument('--pairs'); s.add_argument('--territory')
    s.add_argument('--other'); s.add_argument('--other-align')
    s = sub.add_parser('refine'); s.add_argument('project'); s.add_argument('--align', required=True); s.add_argument('--territory', required=True); s.add_argument('--out', required=True)
    s = sub.add_parser('houses'); s.add_argument('project'); s.add_argument('--align', required=True); s.add_argument('--territory', required=True); s.add_argument('--out', required=True)
    s.add_argument('--spacing', type=float, default=100.0); s.add_argument('--sigma', type=float, default=120.0); s.add_argument('--reach', type=float, default=12.0)
    s = sub.add_parser('overlay'); s.add_argument('project'); s.add_argument('--align', required=True); s.add_argument('--territory', required=True)
    s.add_argument('--image', required=True); s.add_argument('--crop'); s.add_argument('--px', type=float, default=1.0)
    a = p.parse_args()
    {'topview': topview, 'init': init, 'refine': refine, 'houses': houses, 'overlay': overlay}[a.cmd](a)


if __name__ == '__main__':
    main()
