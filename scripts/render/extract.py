#!/usr/bin/env python3
"""С картинки-рендера деревни (вид сверху, привязана align.py) — заборы и деревья.

Заборы: тонкие тёмные линии. Берём всё, что темнее своего ближайшего окружения полосой в 1–3 пикселя,
утоньшаем до линий, спрямляем и оставляем длинные прямые куски во дворах (рядом с постройками). Борозды
огородов и края теней отсеиваются по длине, прямизне и «одиночности» (рядом нет пучка параллельных линий).

Деревья: зелёное, тёмное и «рябое» (кроны с тенями), в отличие от ровной светлой травы. Отдельные кроны —
пятна; в сплошном лесу деревья берутся с шагом, чтобы их число оставалось посильным. Высот на картинке нет:
высота — по ширине кроны. Рядом с деревьями, найденными своей съёмкой с дрона (trees-survey.json), не дублируем.

  python3 scripts/render/extract.py <render.jpg> --territory itkulovo-1 [--preview лист.jpg]
Пишет fences-render.json и trees-render.json в данные района.
"""

import argparse
import base64
import datetime
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'drone'))
from common import Territory, save_json  # noqa: E402

Image.MAX_IMAGE_PIXELS = None
COVER_CELL = 16


def thin(mask):
    """Утоньшение до линий в одну клетку (Чжан — Суэнь)."""
    img = np.pad(mask.astype(np.uint8), 1)
    while True:
        changed = False
        for step in (0, 1):
            p2, p3, p4 = img[:-2, 1:-1], img[:-2, 2:], img[1:-1, 2:]
            p5, p6, p7 = img[2:, 2:], img[2:, 1:-1], img[2:, :-2]
            p8, p9 = img[1:-1, :-2], img[:-2, :-2]
            ring = [p2, p3, p4, p5, p6, p7, p8, p9, p2]
            count = sum(ring[:8])
            turns = sum((ring[k] == 0) & (ring[k + 1] == 1) for k in range(8))
            cond = (img[1:-1, 1:-1] == 1) & (count >= 2) & (count <= 6) & (turns == 1)
            if step == 0:
                cond &= (p2 * p4 * p6 == 0) & (p4 * p6 * p8 == 0)
            else:
                cond &= (p2 * p4 * p8 == 0) & (p2 * p6 * p8 == 0)
            if cond.any():
                img[1:-1, 1:-1][cond] = 0
                changed = True
        if not changed:
            return img[1:-1, 1:-1].astype(bool)


def trace(skeleton):
    """Линии скелета: от концов, на развилке — прямо; ответвления становятся своими линиями."""
    pts = {(int(r), int(c)) for r, c in zip(*np.nonzero(skeleton))}
    near = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]
    nb = lambda p: [(p[0] + d[0], p[1] + d[1]) for d in near if (p[0] + d[0], p[1] + d[1]) in pts]
    lines = []
    ends = [p for p in pts if len(nb(p)) <= 1]
    while pts:
        while ends and ends[-1] not in pts:
            ends.pop()
        p = ends.pop() if ends else next(iter(pts))
        line = [p]
        pts.discard(p)
        while True:
            options = nb(p)
            if not options:
                break
            if len(line) >= 4:
                dr, dc = line[-1][0] - line[-4][0], line[-1][1] - line[-4][1]
                options.sort(key=lambda q: -((q[0] - p[0]) * dr + (q[1] - p[1]) * dc))
            for other in options[1:]:
                ends.append(other)
            p = options[0]
            line.append(p)
            pts.discard(p)
        lines.append(np.array(line, float))
    return lines


def simplify(points, tolerance):
    if len(points) < 3:
        return points
    a, b = points[0], points[-1]
    d = b - a
    length = np.hypot(*d) or 1.0
    dist = np.abs((points[:, 0] - a[0]) * d[1] - (points[:, 1] - a[1]) * d[0]) / length
    k = int(dist.argmax())
    if dist[k] <= tolerance:
        return np.array([a, b])
    return np.vstack([simplify(points[: k + 1], tolerance)[:-1], simplify(points[k:], tolerance)])


def join(fences, gap=7.0, reach=6.0):
    """Собрать отрезки в связные заборы: куски одной прямой с разрывом до gap метров сливаются (калитки,
    тень дерева), а свободный конец дотягивается по прямой до reach метров, если упирается в другой забор —
    так закрываются углы участков."""
    segs = [np.array(f, float) for f in fences]

    def unit(v):
        n = np.hypot(*v)
        return v / n if n else v

    # 1. Слить куски, лежащие на одной прямой.
    merged = True
    while merged:
        merged = False
        ends = np.array([p for f in segs for p in (f[0], f[-1])])
        from scipy.spatial import cKDTree
        tree = cKDTree(ends)
        for a_i, b_i in sorted(tree.query_pairs(gap)):
            fa, fb = a_i // 2, b_i // 2
            if fa == fb:
                continue
            A = segs[fa] if a_i % 2 else segs[fa][::-1]   # A кончается в общей точке
            B = segs[fb][::-1] if b_i % 2 else segs[fb]   # B начинается в общей точке
            da, db = unit(A[-1] - A[-2]), unit(B[1] - B[0])
            link = B[0] - A[-1]
            if da @ db > 0.96 and (np.hypot(*link) < 0.5 or abs(da[0] * link[1] - da[1] * link[0]) < 1.2) and link @ da > -0.5:
                segs[fa] = np.vstack([A, B])
                segs.pop(fb)
                merged = True
                break

    # 2. Дотянуть свободные концы до ближайшего забора.
    boxes = [(g.min(0) - reach, g.max(0) + reach) for g in segs]
    for k, f in enumerate(segs):
        for end in (0, -1):
            p = f[end]
            d = unit(p - f[1 if end == 0 else -2])
            near = [j for j, (lo, hi) in enumerate(boxes) if j != k and (p >= lo).all() and (p <= hi).all()]
            best = None
            for j in near:
                g = segs[j]
                for q0, q1 in zip(g[:-1], g[1:]):
                    e = q1 - q0
                    den = d[0] * e[1] - d[1] * e[0]
                    if abs(den) < 1e-9:
                        continue
                    w = q0 - p
                    t = (w[0] * e[1] - w[1] * e[0]) / den
                    s_ = (w[0] * d[1] - w[1] * d[0]) / den
                    if 0.05 < t <= reach and -0.05 <= s_ <= 1.05 and (best is None or t < best):
                        best = t
            if best is not None:
                f[end] = p + d * best
    return segs


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('image')
    p.add_argument('--territory', required=True)
    p.add_argument('--preview', help='лист для проверки: рендер с найденными заборами и деревьями')
    p.add_argument('--skip-fences', action='store_true')
    p.add_argument('--skip-trees', action='store_true')
    p.add_argument('--drone', help='проект ODM со своей съёмкой (terrain-dtm.npz) — проверять деревья в посёлке по высоте')
    a = p.parse_args()

    t = Territory(a.territory)
    align = json.load(open(Path(a.image).with_suffix('.align.json')))
    m = np.array(align['world_to_pixel'])
    inv = np.linalg.inv(np.vstack([m, [0, 0, 1]]))
    mpp = float(np.mean(align['metres_per_pixel']))
    to_px = lambda xy: np.c_[xy, np.ones(len(xy))] @ m.T
    to_world = lambda px: (np.c_[px, np.ones(len(px))] @ inv.T)[:, :2]

    img = np.asarray(Image.open(a.image).convert('RGB'), np.float32)
    H, W = img.shape[:2]
    r, g, b = img[..., 0], img[..., 1], img[..., 2]
    luma = 0.3 * r + 0.55 * g + 0.15 * b

    # Постройки: дома OSM и найденные по съёмке.
    rings = [ring for _, ring, _ in t.buildings()]
    survey = t.data / 'survey.json'
    if survey.exists():
        for bld in json.load(open(survey)).get('buildings', []):
            c = np.array(bld['footprint'], float)
            x, y = t.local(c[:, 0], c[:, 1])
            rings.append(np.stack([x, y], 1))
    roofs = Image.new('1', (W, H), 0)
    draw = ImageDraw.Draw(roofs)
    for ring in rings:
        draw.polygon([tuple(v) for v in to_px(ring)], fill=1)
    built = np.array(roofs, bool)
    yard = ndimage.distance_transform_edt(~built) * mpp  # расстояние до ближайшей постройки, м

    fences = []
    if not a.skip_fences:
        # Тёмное тоньше ~3 пикселей: «чёрная шляпа» — замыкание минус картинка. Таких точек полно и в зарослях,
        # поэтому забором считаем только то, что складывается в длинную прямую одиночную линию.
        hat = ndimage.grey_closing(luma, size=(7, 7)) - luma
        road = Image.new('1', (W, H), 0)
        rd = ImageDraw.Draw(road)
        for way in json.load(open(t.data / 'streets.json'))['roads']:
            c = np.array(way['coords'], float)
            x, y = t.local(c[:, 0], c[:, 1])
            rd.line([tuple(v) for v in to_px(np.stack([x, y], 1))], fill=1, width=int((way['width'] + 3) / mpp))
        dark = (hat > 22) & (ndimage.minimum_filter(luma, size=3) < 62) & (yard < 45)
        dark &= ~ndimage.binary_dilation(built, iterations=2) & ~np.array(road, bool)
        y0, y1 = np.nonzero(dark.any(1))[0][[0, -1]]
        x0, x1 = np.nonzero(dark.any(0))[0][[0, -1]]
        mk = ndimage.binary_dilation(dark[y0:y1 + 1, x0:x1 + 1]).astype(np.uint8)
        half = int(round(6 / mpp))  # линия длиной ~12 м
        steps = np.arange(-half, half + 1)
        found = np.zeros(mk.shape, bool)
        shift = lambda arr, dr, dc: np.roll(arr, (dr, dc), (0, 1))
        for theta in np.radians(np.arange(0, 180, 7.5)):
            dr, dc = np.round(steps * np.sin(theta)).astype(int), np.round(steps * np.cos(theta)).astype(int)
            resp = np.zeros(mk.shape, np.uint8)
            for r_, c_ in zip(dr, dc):
                resp += shift(mk, r_, c_)
            # Одиночная: в 2,5 м по обе стороны такой же линии нет (иначе это борозды огорода или заросли).
            off = 2.5 / mpp
            nr, nc = int(round(off * np.cos(theta))), int(round(-off * np.sin(theta)))
            n = len(steps)
            hit = (resp >= 0.9 * n) & (shift(resp, nr, nc) <= 0.4 * n) & (shift(resp, -nr, -nc) <= 0.4 * n)
            if not hit.any():
                continue
            support = np.zeros(mk.shape, bool)
            for r_, c_ in zip(dr, dc):
                support |= shift(hit, -r_, -c_)
            found |= support & (mk > 0)
        print(f'прямых тёмных линий: {int(found.sum())} пикселей в окне {x1 - x0}×{y1 - y0}', flush=True)
        fences = []
        for line in trace(thin(ndimage.binary_closing(found, iterations=1))):
            if len(line) < 12:
                continue
            path = simplify(line, 2.2) + [y0, x0]
            # Подряд идущие длинные куски — один забор; обрывки между ними отбрасываем.
            run = [path[0]]
            runs = []
            for u, v in zip(path[:-1], path[1:]):
                if np.hypot(*(v - u)) * mpp >= 3.5:
                    run.append(v)
                else:
                    runs.append(run)
                    run = [v]
            runs.append(run)
            for run in runs:
                pts = np.array(run)
                if len(pts) >= 2 and np.hypot(*np.diff(pts, axis=0).T).sum() * mpp >= 10:
                    fences.append(to_world(np.c_[pts[:, 1], pts[:, 0]]))
        fences = join(fences)
        total = sum(np.hypot(*np.diff(f, axis=0).T).sum() for f in fences)
        out = []
        for f in fences:
            lon, lat = t.lonlat(f[:, 0], f[:, 1])
            out.append([[round(float(x), 7), round(float(y), 7)] for x, y in zip(lon, lat)])
        save_json(t.data / 'fences-render.json', {
            'metadata': {'territory': t.id, 'source': 'Заборы сняты с картинки-рендера деревни (вид сверху, нейросеть по спутниковому снимку); могут быть неточны',
                         'generatedAt': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')},
            'fences': out,
        })
        print(f'заборы: {len(fences)} линий, {total:.0f} м')

    # --- Деревья -------------------------------------------------------------------------------
    world, ok, radius, spruce = np.zeros((0, 2)), np.zeros(0, bool), np.zeros(0), np.zeros(0, bool)
    if not a.skip_trees:
        k = 2  # считаем на картинке вдвое меньше: ~0,93 м в пикселе
        small = np.asarray(Image.fromarray(img.astype(np.uint8)).resize((W // k, H // k), Image.BILINEAR), np.float32)
        sr, sg, sb = small[..., 0], small[..., 1], small[..., 2]
        sl = 0.3 * sr + 0.55 * sg + 0.15 * sb
        mean = ndimage.uniform_filter(sl, 7)
        rough = np.sqrt(np.maximum(ndimage.uniform_filter(sl * sl, 7) - mean * mean, 0))
        wide = ndimage.uniform_filter(sl, 61)
        # Крона: рябая (свет и тень вперемешку), не бурая (огород) и не синяя (крыша, вода, чистая тень).
        leafy = (sg >= sr - 12) & (sg >= sb - 2)
        canopy = leafy & (rough > 10) & (mean < 150)
        canopy = ndimage.binary_closing(canopy, iterations=2)
        canopy = ndimage.binary_opening(canopy, iterations=1)
        built_s = np.array(roofs.resize((W // k, H // k)), bool)
        canopy &= ~ndimage.binary_dilation(built_s, iterations=2)
        step = mpp * k
        # Вершина кроны — самое светлое место пятна (тени и просветы темнее).
        bright = ndimage.gaussian_filter(sl, 1.0)
        depth = ndimage.distance_transform_edt(canopy) * step
        tops = canopy & (bright == ndimage.maximum_filter(bright, size=5)) & (depth >= 0.9)
        rows, cols = np.nonzero(tops)
        # Плотность крон вокруг: в сплошном лесу оставляем одно дерево на клетку ~8 м.
        share = ndimage.uniform_filter(canopy.astype(np.float32), int(30 / step))
        dense = share[rows, cols] > 0.55
        cell = np.maximum(1, int(8 / step))
        key = (rows // cell) * 100000 + cols // cell
        order = np.argsort(-bright[rows, cols])
        seen, keep = set(), np.zeros(len(rows), bool)
        for i in order:
            if not dense[i]:
                keep[i] = True
            elif key[i] not in seen:
                seen.add(key[i])
                keep[i] = True
        rows, cols, dense = rows[keep], cols[keep], dense[keep]
        world = to_world(np.c_[(cols + 0.5) * k, (rows + 0.5) * k])
        radius = np.clip(depth[rows, cols] * 1.15, 0.9, 4.5)
        radius[dense] = np.clip(radius[dense], 2.0, 4.0)
        height = np.where(dense, 9 + radius * 2.2, 1.5 + radius * 2.4)
        # Хвойные темнее и синее лиственных; порог — относительно всех крон.
        cl, cb = bright[rows, cols], (sb - sr)[rows, cols]
        spruce = (cl < np.percentile(cl, 35)) & (cb > np.median(cb)) & (height > 4.5)

        ax0, ay0, ax1, ay1 = t.area()
        pad = 250
        ok = (world[:, 0] > ax0 - pad) & (world[:, 0] < ax1 + pad) & (world[:, 1] > ay0 - pad) & (world[:, 1] < ay1 + pad)
        # В посёлке «рябое зелёное» — это ещё и бурьян, грядки, дворы. Поэтому там, где есть своя съёмка
        # с дрона (--drone), дерево с рендера берём, только если съёмка видит в этом месте что-то выше 1,5 м,
        # и если рядом (ближе 4 м) дрон сам дерева не нашёл: так добавляются кусты и пропущенные им деревья.
        near_house = yard[np.minimum(rows * k, H - 1), np.minimum(cols * k, W - 1)] < 60
        covered = np.zeros(len(world), bool)
        if a.drone:
            g = np.load(Path(a.drone) / 'terrain-dtm.npz')
            dtm, top, cnt = g['dtm'], g['top'], g['cnt']
            gx0, gy1, res = float(g['x0']), float(g['y1']), float(g['res'])
            known = np.isfinite(dtm)
            dist, idx = ndimage.distance_transform_edt(~known, return_indices=True)
            hag = np.where(np.isfinite(top) & (cnt >= 2), top - dtm[tuple(idx)], 0.0)
            ci, cj = ((world[:, 0] - gx0) / res).astype(int), ((gy1 - world[:, 1]) / res).astype(int)
            inside = (ci >= 0) & (ci < dtm.shape[1]) & (cj >= 0) & (cj < dtm.shape[0])
            # «Снято» — где дрон видит землю рядом (до 8 м). Под сплошным лесом он её не видит и деревья считает
            # плохо — там верим рендеру.
            covered[inside] = dist[cj[inside], ci[inside]] * res < 8
            tall = np.zeros(len(world), bool)
            tall[inside] = hag[cj[inside], ci[inside]] >= 1.5
            # И само место на рендере должно быть уверенно зелёным: иначе «высокое» — это сарай, которого нет в OSM.
            vivid = (sg > sr + 8) & (sg > sb + 10)
            vivid = ndimage.uniform_filter(vivid.astype(np.float32), 3)[rows, cols] > 0.6
            # Выше 2,2 м — дерево и без яркой зелени (тёмные ели и сосны); постройки из OSM и съёмки уже исключены.
            high = np.zeros(len(world), bool)
            high[inside] = hag[cj[inside], ci[inside]] >= 2.2
            ok &= ~covered | high | (tall & vivid)
            drone_file = t.data / 'trees-survey.json'
            if drone_file.exists():
                from scipy.spatial import cKDTree
                found = np.array([tr[:2] for tr in json.load(open(drone_file))['trees']], float)
                dx, dy = t.local(found[:, 0], found[:, 1])
                near, _ = cKDTree(np.stack([dx, dy], 1)).query(world, k=1)
                ok &= ~covered | (near > 4)
        # У домов за пределами съёмки проверить нечем — оставляем только крупные кроны (от ~2 м радиусом).
        ok &= covered | ~near_house | (depth[rows, cols] >= 2.0)
        lon, lat = t.lonlat(world[ok, 0], world[ok, 1])
        trees = [[round(float(lo), 6), round(float(la), 6), round(float(h), 1), round(float(rr), 1), 's' if s else 'b', 1 if d else 0]
                 for lo, la, h, rr, s, d in zip(lon, lat, height[ok], radius[ok], spruce[ok], dense[ok])]

        # Покрытие: весь район с запасом лежит внутри рендера — там деревья наугад больше не сажаем.
        cw, ch = int(np.ceil((ax1 - ax0 + 2 * pad) / COVER_CELL)), int(np.ceil((ay1 - ay0 + 2 * pad) / COVER_CELL))
        gx = ax0 - pad + (np.arange(cw) + 0.5) * COVER_CELL
        gy = ay1 + pad - (np.arange(ch) + 0.5) * COVER_CELL
        X, Y = np.meshgrid(gx, gy)
        q = to_px(np.c_[X.ravel(), Y.ravel()])
        cover = ((q[:, 0] >= 0) & (q[:, 0] < W) & (q[:, 1] >= 0) & (q[:, 1] < H)).reshape(ch, cw)
        west, north = t.lonlat(ax0 - pad, ay1 + pad)
        east, south = t.lonlat(ax1 + pad, ay0 - pad)
        save_json(t.data / 'trees-render.json', {
            'metadata': {'territory': t.id, 'source': 'Деревья сняты с картинки-рендера деревни (вид сверху, нейросеть по спутниковому снимку): места крон; высоты — оценка по ширине кроны',
                         'note': 'дерево: долгота, широта, высота (м), радиус кроны (м), порода (b/s — догадка по цвету), 1 — в сплошном лесу',
                         'generatedAt': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')},
            'trees': trees,
            'coverage': {'west': float(west), 'south': float(south), 'east': float(east), 'north': float(north), 'width': cw, 'height': ch,
                         'cells': base64.b64encode(np.packbits(cover.ravel())).decode()},
        })
        print(f'деревья: {len(trees)}, из них в лесу {int(dense[ok].sum())}, елей {int(spruce[ok].sum())}; рендер закрывает {cover.mean() * 100:.0f} % района с запасом')

    if a.preview:
        base = Image.fromarray(img.astype(np.uint8))
        d = ImageDraw.Draw(base)
        for f in fences:
            d.line([tuple(v) for v in to_px(f)], fill=(255, 40, 200), width=2)
        for (x, y), rr, s in zip(to_px(world[ok]), radius[ok], spruce[ok]):
            rp = rr / mpp
            d.ellipse([x - rp, y - rp, x + rp, y + rp], outline=(60, 220, 255) if s else (255, 235, 60))
        base.save(a.preview, quality=88)


if __name__ == '__main__':
    main()
