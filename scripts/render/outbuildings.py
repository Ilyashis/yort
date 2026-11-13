#!/usr/bin/env python3
"""Дворовые постройки по картинке-рендеру: крыши у домов, которых нет ни в OSM, ни среди найденных по съёмке
→ outbuildings-render.json (прямоугольник и догадка, что это: гараж, баня или сарай).

Крыша на карте — небольшое пятно ровного «кровельного» цвета (серое или белое, синее, тёмно-сизое, рыжее),
прямоугольное, во дворе (не дальше 32 м от дома), не на дороге и не на уже известной постройке. Тёмные и бурые
крыши легко спутать с тенью и вскопанной землёй — от них требуется гладкость и почти точный прямоугольник.
Высоты со съёмки с дрона здесь не используются: её модель изогнута относительно карты на несколько метров.

Что это за постройка, сверху не видно — раскладываем по обычаю: ближняя к улице и не маленькая — гараж,
маленькая в глубине двора — баня, остальное — сарай.

  python3 scripts/render/outbuildings.py <render.jpg> --territory itkulovo-1 [--drone <проект ODM>] [--preview лист.jpg]
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


def min_rect(pts):
    """Наименьший охватывающий прямоугольник набора точек (перебором углов): углы и площадь."""
    c = pts.mean(0)
    best = None
    for ang in np.radians(np.arange(0, 90, 3)):
        u = np.array([np.cos(ang), np.sin(ang)])
        v = np.array([-u[1], u[0]])
        pu, pv = (pts - c) @ u, (pts - c) @ v
        u0, u1 = np.percentile(pu, [1.5, 98.5])
        v0, v1 = np.percentile(pv, [1.5, 98.5])
        area = (u1 - u0) * (v1 - v0)
        if best is None or area < best[0]:
            best = (area, np.array([c + u * a + v * b for a, b in ((u0, v0), (u1, v0), (u1, v1), (u0, v1))]), u1 - u0, v1 - v0)
    return best


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('image')
    p.add_argument('--territory', required=True)
    p.add_argument('--drone')
    p.add_argument('--preview')
    a = p.parse_args()

    t = Territory(a.territory)
    align = json.load(open(Path(a.image).with_suffix('.align.json')))
    m = np.array(align['world_to_pixel'])
    inv = np.linalg.inv(np.vstack([m, [0, 0, 1]]))
    mpp = float(np.mean(align['metres_per_pixel']))
    to_px = lambda xy: np.c_[xy, np.ones(len(xy))] @ m.T
    to_world = lambda px: (np.c_[px, np.ones(len(px))] @ inv.T)[:, :2]
    full = Image.open(a.image).convert('RGB')
    W, H = full.size
    img = ndimage.uniform_filter(np.asarray(full, np.float32), (3, 3, 1))
    r, g, b = img[..., 0], img[..., 1], img[..., 2]
    luma = 0.3 * r + 0.55 * g + 0.15 * b
    spread = img.max(-1) - img.min(-1)

    # Уже известные постройки и дороги.
    houses = [ring for _, ring, _ in t.buildings()]
    known = list(houses)
    for name, key in (('survey.json', 'buildings'),):
        if (t.data / name).exists():
            for bld in json.load(open(t.data / name)).get(key, []):
                c = np.array(bld['footprint'], float)
                x, y = t.local(c[:, 0], c[:, 1])
                known.append(np.stack([x, y], 1))
    if (t.data / 'buildings-fit.json').exists():
        for c in json.load(open(t.data / 'buildings-fit.json'))['footprints'].values():
            c = np.array(c, float)
            x, y = t.local(c[:, 0], c[:, 1])
            known.append(np.stack([x, y], 1))
    mask_known = Image.new('1', (W, H), 0)
    mask_house = Image.new('1', (W, H), 0)
    kd, hd = ImageDraw.Draw(mask_known), ImageDraw.Draw(mask_house)
    for ring in known:
        kd.polygon([tuple(v) for v in to_px(ring)], fill=1)
    for ring in houses:
        if True:
            hd.polygon([tuple(v) for v in to_px(ring)], fill=1)
    taken = ndimage.binary_dilation(np.array(mask_known, bool), iterations=int(1.2 / mpp))
    near_house = ndimage.distance_transform_edt(~np.array(mask_house, bool)) * mpp
    road = Image.new('1', (W, H), 0)
    rd = ImageDraw.Draw(road)
    streets = json.load(open(t.data / 'streets.json'))
    axes = []
    for way in streets['roads'] + streets.get('paths', []):
        c = np.array(way['coords'], float)
        x, y = t.local(c[:, 0], c[:, 1])
        axes.append(np.stack([x, y], 1))
        rd.line([tuple(v) for v in to_px(axes[-1])], fill=1, width=int((way['width'] + 4) / mpp))
    road = np.array(road, bool)
    road_axis = Image.new('1', (W, H), 0)
    ad = ImageDraw.Draw(road_axis)
    for way, axis in zip(streets['roads'], axes):
        ad.line([tuple(v) for v in to_px(axis)], fill=1, width=2)
    to_street = ndimage.distance_transform_edt(~np.array(road_axis, bool)) * mpp

    green = (g > r + 6) & (g > b + 6)
    light = (spread < 30) & (luma > 125)                       # шифер, оцинковка, белое
    blue = (b > r + 18) & (b > g + 4)                          # синий профнастил
    red = (r > g + 28) & (r > b + 28)                          # рыжая и красная кровля
    slate = (luma < 88) & (luma > 28) & (b >= g - 3) & (b >= r - 2) & (spread < 40)   # тёмно-сизая
    yard = (near_house < 32) & (near_house > 0.5) & ~taken & ~road & ~green

    hag = None
    if a.drone:
        gdt = np.load(Path(a.drone) / 'terrain-dtm.npz')
        dtm, top, cnt = gdt['dtm'], gdt['top'], gdt['cnt']
        gx0, gy1, res = float(gdt['x0']), float(gdt['y1']), float(gdt['res'])
        knownz = np.isfinite(dtm)
        dist, idx = ndimage.distance_transform_edt(~knownz, return_indices=True)
        hag = (np.where(np.isfinite(top) & (cnt >= 2), top - dtm[tuple(idx)], 0.0), dist * res, gx0, gy1, res)

    found = []

    def take(world, tone, checked, cy, cx):
        """Пятно (точки мира) → прямоугольник постройки, если оно на неё похоже."""
        rect_area, rect, su, sv = min_rect(world)
        short, long = sorted([su, sv])
        if short < 2.3 or long > 34 or long / short > 5 or rect_area < 7 or rect_area > 420:
            return False
        # Узкая светлая полоска вплотную к дому — его же освещённый скат или стена, а не пристройка.
        if near_house[cy, cx] < short / 2 + 1.8 and short < 4.2:
            return False
        # Светлое пятно на самой улице — машина или блик на дороге.
        if to_street[cy, cx] < 6:
            return False
        if tone in ('brown', 'slate') and rect_area > 190:
            return False
        found.append({'rect': rect, 'area': rect_area, 'street': float(to_street[cy, cx]), 'house': float(near_house[cy, cx]), 'tone': tone, 'checked': checked})
        return True

    covered_px = np.zeros((H, W), bool)
    # Крыши по цвету. Светлые, синие и рыжие отличаются от земли сами; тёмные (сизые и бурые) похожи на тень
    # и на вскопанный огород, поэтому от них требуется ещё гладкость и почти точный прямоугольник.
    mean = ndimage.uniform_filter(luma, 5)
    rough = np.sqrt(np.maximum(ndimage.uniform_filter(luma * luma, 5) - mean * mean, 0))
    flat = rough < 7.5
    brown = (luma > 35) & (luma < 105) & (r > g + 4) & (g > b + 2) & (r - b < 55) & flat
    dark = slate & flat
    for name, cls, fill, smallest in (('light', light, 0.8, 9), ('blue', blue, 0.8, 9), ('red', red, 0.8, 9), ('brown', brown, 0.86, 22), ('slate', dark, 0.86, 22)):
        blob = ndimage.binary_opening(cls & yard, iterations=1 if smallest < 20 else 2)
        blob = ndimage.binary_closing(blob, iterations=1)
        labels, n = ndimage.label(blob)
        for k, sl in enumerate(ndimage.find_objects(labels), start=1):
            region = labels[sl] == k
            area = region.sum() * mpp * mpp
            if area < smallest or area > 420:
                continue
            rr, cc = np.nonzero(region)
            world = to_world(np.c_[cc + sl[1].start + 0.5, rr + sl[0].start + 0.5])
            if area / max(min_rect(world)[0], 1e-6) < fill:
                continue
            take(world, name, False, int(rr.mean()) + sl[0].start, int(cc.mean()) + sl[1].start)

    # Что это: в каждом дворе ближняя к улице и не маленькая — гараж; маленькая в глубине — баня; прочее — сарай.
    for f in found:
        if 16 <= f['area'] <= 60 and f['street'] < 16:
            f['kind'] = 'garage'
        elif f['area'] <= 26 and f['street'] >= 16:
            f['kind'] = 'banya'
        else:
            f['kind'] = 'shed'
    out = []
    for n, f in enumerate(found, start=1):
        lon, lat = t.lonlat(f['rect'][:, 0], f['rect'][:, 1])
        out.append({'id': f'render/{n}', 'kind': f['kind'], 'footprint': [[round(float(x), 7), round(float(y), 7)] for x, y in zip(lon, lat)]})
    save_json(t.data / 'outbuildings-render.json', {
        'metadata': {'territory': t.id, 'source': 'Дворовые постройки сняты с картинки-рендера деревни (крыши у домов); назначение — догадка по размеру и месту во дворе',
                     'generatedAt': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')},
        'buildings': out,
    })
    kinds = {k: sum(f['kind'] == k for f in found) for k in ('garage', 'banya', 'shed')}
    print(f'построек {len(found)}: гаражей {kinds["garage"]}, бань {kinds["banya"]}, сараев {kinds["shed"]}; по цвету: ' + ', '.join(f'{k} {sum(f["tone"] == k for f in found)}' for k in ('light', 'blue', 'red', 'brown', 'slate')) + f'')

    if a.preview:
        d = ImageDraw.Draw(full)
        for ring in known:
            d.polygon([tuple(v) for v in to_px(ring)], outline=(150, 150, 150))
        colour = {'garage': (255, 60, 60), 'banya': (255, 235, 0), 'shed': (0, 255, 255)}
        for f in found:
            d.polygon([tuple(v) for v in to_px(f['rect'])], outline=colour[f['kind']], width=2)
        full.save(a.preview, quality=88)


if __name__ == '__main__':
    main()
