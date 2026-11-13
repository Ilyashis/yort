#!/usr/bin/env python3
"""Контуры домов OSM → под крыши на картинке-рендере: buildings-fit.json (id дома → новый прямоугольник).

У каждого дома берётся его контур из OSM и ищется крыша под ним: пиксели того же цвета, что в середине
контура (два оттенка — освещённый и теневой скат), связанные с этой серединой. Крыша меряется вдоль осей
контура OSM (угол не меняется — в OSM он обычно верный), получается новый прямоугольник: стороны только
раздвигаются наружу (до 2,6 м) — в OSM обычно обведён сруб без пристроек, и дом выходит меньше крыши. Подгонка применяется, только если крыша читается уверенно: пятно плотно заполняет свой
прямоугольник, размеры и сдвиг в разумных пределах. Остальные дома остаются как в OSM.

  python3 scripts/render/fit_houses.py <render.jpg> --territory itkulovo-1 [--preview лист.jpg]
"""

import argparse
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


def oriented_box(ring):
    """Наименьший охватывающий прямоугольник: центр, оси (u — длинная), полуразмеры."""
    best = None
    for i in range(len(ring)):
        d = ring[(i + 1) % len(ring)] - ring[i]
        n = np.hypot(*d)
        if n < 0.3:
            continue
        u = d / n
        v = np.array([-u[1], u[0]])
        pu, pv = ring @ u, ring @ v
        area = (pu.max() - pu.min()) * (pv.max() - pv.min())
        if best is None or area < best[0]:
            best = (area, u, v, (pu.max() + pu.min()) / 2, (pv.max() + pv.min()) / 2, (pu.max() - pu.min()) / 2, (pv.max() - pv.min()) / 2)
    _, u, v, cu, cv, hu, hv = best
    if hv > hu:
        u, v, cu, cv, hu, hv = v, -u, cv, -cu, hv, hu
    return u * cu + v * cv, u, v, hu, hv


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('image')
    p.add_argument('--territory', required=True)
    p.add_argument('--preview')
    a = p.parse_args()

    t = Territory(a.territory)
    align = json.load(open(Path(a.image).with_suffix('.align.json')))
    m = np.array(align['world_to_pixel'])
    mpp = float(np.mean(align['metres_per_pixel']))
    inv = np.linalg.inv(np.vstack([m, [0, 0, 1]]))
    to_px = lambda xy: np.c_[xy, np.ones(len(xy))] @ m.T
    img = np.asarray(Image.open(a.image).convert('RGB'), np.float32)
    H, W = img.shape[:2]
    smooth = ndimage.uniform_filter(img, (3, 3, 1))

    houses = [(oid, ring[:-1] if np.allclose(ring[0], ring[-1]) else ring, props) for oid, ring, props in t.buildings()]
    counts = {}
    for oid, _, _ in houses:
        counts[oid] = counts.get(oid, 0) + 1
    # Чужие дома: крыша соседа не должна прилипать к этому дому.
    others = Image.new('I', (W, H), 0)
    od = ImageDraw.Draw(others)
    for n, (_, ring, _) in enumerate(houses, start=1):
        od.polygon([tuple(v) for v in to_px(ring)], fill=n)
    others = np.asarray(others)

    fits, sheet = {}, []
    reasons = {}
    for n, (oid, ring, props) in enumerate(houses, start=1):
        if counts[oid] != 1 or len(ring) < 3:
            continue
        c, u, v, hu, hv = oriented_box(ring)
        if hu * hv * 4 < 12 or hu * hv * 4 > 600:
            continue
        # Каждая из четырёх сторон ищется отдельно: сдвигаем её поперёк на −3…+3 м и берём положение, где цвет
        # по обе стороны от линии отличается сильнее всего (стена/крыша против двора). Двухцветная крыша
        # (освещённый и теневой скат) этому не мешает: конёк далеко от края.
        def edge(origin, along, normal, half):
            """Лучший сдвиг стороны наружу (м) и контраст на нём; normal — наружу."""
            ts = np.linspace(-half * 0.8, half * 0.8, max(6, int(half * 1.6 / mpp)))
            offs = np.arange(-3.0, 3.01, mpp)
            line = origin[None, None, :] + along[None, None, :] * ts[None, :, None] + normal[None, None, :] * offs[:, None, None]
            def sample(shift):
                q = (np.c_[(line + normal * shift).reshape(-1, 2), np.ones(line.shape[0] * line.shape[1])] @ m.T)
                cols = np.stack([ndimage.map_coordinates(smooth[..., ch], [q[:, 1], q[:, 0]], order=1, mode='nearest') for ch in range(3)], 1)
                return cols.reshape(len(offs), len(ts), 3)
            inside = (sample(-0.5) + sample(-1.2)) / 2
            outside = (sample(0.5) + sample(1.2)) / 2
            contrast = np.sqrt(((inside.mean(1) - outside.mean(1)) ** 2).sum(-1))
            # Разница должна держаться вдоль всей стороны, а не в одном месте.
            steady = np.median(np.sqrt(((inside - outside) ** 2).sum(-1)), 1)
            score = np.minimum(contrast, steady * 1.5)
            k = int(score.argmax())
            return float(offs[k]), float(score[k]), float(score[len(offs) // 2])
        sides = [edge(c + u * hu, v, u, hv), edge(c - u * hu, v, -u, hv), edge(c + v * hv, u, v, hu), edge(c - v * hv, u, -v, hu)]
        # Сторона двигается, только если новый край явно чётче прежнего; иначе остаётся как в OSM.
        # Только наружу: внутрь край часто «прилипает» к границе светлого и тёмного ската, и дом выходит меньше.
        move = [off if (0.4 < off <= 2.6 and score > 34 and score > at_osm * 1.35) else 0.0 for off, score, at_osm in sides]
        u1, u0, v1, v0 = hu + move[0], -hu - move[1], hv + move[2], -hv - move[3]
        nhu, nhv = (u1 - u0) / 2, (v1 - v0) / 2
        shift = np.hypot((u0 + u1) / 2, (v0 + v1) / 2)
        why = None
        if not any(move):
            why = 'края не читаются или совпадают'
        elif not (0.75 <= nhu / hu <= 1.6 and 0.75 <= nhv / hv <= 1.6):
            why = 'размер вне пределов'
        elif max(abs(x) for x in move) < 0.5:
            why = 'и так совпадает'
        old = np.array([c + u * sx * hu + v * sy * hv for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))])
        if why:
            reasons[why] = reasons.get(why, 0) + 1
            sheet.append((old, None))
            continue
        nc = c + u * (u0 + u1) / 2 + v * (v0 + v1) / 2
        new = np.array([nc + u * sx * nhu + v * sy * nhv for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))])
        lon, lat = t.lonlat(new[:, 0], new[:, 1])
        fits[oid] = [[round(float(x), 7), round(float(y), 7)] for x, y in zip(lon, lat)]
        sheet.append((old, new))

    save_json(t.data / 'buildings-fit.json', {
        'metadata': {'territory': t.id, 'source': 'Контуры домов OSM, подогнанные под крыши на картинке-рендере деревни (сдвиг и размер; угол — как в OSM)',
                     'generatedAt': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')},
        'footprints': fits,
    })
    print(f'подогнано {len(fits)} из {len(houses)}; не тронуто: ' + ', '.join(f'{k} — {v}' for k, v in sorted(reasons.items(), key=lambda kv: -kv[1])))

    if a.preview:
        base = Image.fromarray(img.astype(np.uint8))
        d = ImageDraw.Draw(base)
        for old, new in sheet:
            d.polygon([tuple(q) for q in to_px(old)], outline=(255, 70, 70) if new is not None else (160, 160, 160))
            if new is not None:
                d.polygon([tuple(q) for q in to_px(new)], outline=(255, 240, 0), width=2)
        base.save(a.preview, quality=88)


if __name__ == '__main__':
    main()
