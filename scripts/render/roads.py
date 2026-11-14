#!/usr/bin/env python3
"""Дороги по картинке-рендеру → streets-render.json: ширина дорог OSM, как на карте, и просёлки, лесные и
полевые дороги, которых в OSM нет.

Оси дорог OSM с картой совпадают (по ним карта и привязана), поэтому их геометрию не трогаем — меряем только
ширину: поперёк оси ищем светлую полосу полотна, берём медиану по длине дороги.

Новые дороги: колея на карте — узкая полоска «менее зелёная», чем трава вокруг, и не темнее её. Такие полоски
утоньшаются до линий; дорогой считается длинная (от 70 м) и не петляющая линия вдали от уже известных дорог,
домов и воды. Куски одной дороги сливаются через разрывы, концы дотягиваются до ближайшей дороги.

  python3 scripts/render/roads.py <render.jpg> --territory itkulovo-1 [--preview лист.jpg]
"""

import argparse
import datetime
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from scipy.spatial import cKDTree

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'drone'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import Territory, save_json  # noqa: E402
from extract import join, simplify, thin, trace  # noqa: E402

Image.MAX_IMAGE_PIXELS = None


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('image')
    p.add_argument('--territory', required=True)
    p.add_argument('--min-length', type=float, default=70.0)
    p.add_argument('--preview')
    a = p.parse_args()

    t = Territory(a.territory)
    align = json.load(open(Path(a.image).with_suffix('.align.json')))
    m = np.array(align['world_to_pixel'])
    inv = np.linalg.inv(np.vstack([m, [0, 0, 1]]))
    k = 2
    full = Image.open(a.image).convert('RGB')
    W, H = full.size
    w, h = W // k, H // k
    mpp = float(np.mean(align['metres_per_pixel'])) * k
    img = np.asarray(full.resize((w, h), Image.BILINEAR), np.float32)
    r, g, b = img[..., 0], img[..., 1], img[..., 2]
    luma = 0.3 * r + 0.55 * g + 0.15 * b
    spread = img.max(-1) - img.min(-1)
    to_px = lambda xy: (np.c_[xy, np.ones(len(xy))] @ m.T) / k
    to_world = lambda px: (np.c_[(px + 0.5) * k, np.ones(len(px))] @ inv.T)[:, :2]

    streets = json.load(open(t.data / 'streets.json'))
    local = lambda coords: np.stack(t.local(np.array(coords, float)[:, 0], np.array(coords, float)[:, 1]), 1)
    osm_roads = [local(way['coords']) for way in streets['roads']]
    known = osm_roads + [local(way['coords']) for way in streets.get('paths', [])]
    if (t.data / 'streets-survey.json').exists():
        known += [local(way['coords']) for way in json.load(open(t.data / 'streets-survey.json')).get('paths', [])]

    # 1. Ширина дорог OSM: светлое полотно поперёк оси.
    surface = (luma > 118) & (spread < 48) & (g < r + 14)
    widths = {}
    offs = np.arange(-12, 12.01, 0.5)
    for n, axis in enumerate(osm_roads):
        seg = np.diff(axis, axis=0)
        length = np.hypot(seg[:, 0], seg[:, 1])
        got = []
        for a0, d, ln in zip(axis[:-1], seg, length):
            if ln < 1:
                continue
            u = d / ln
            nrm = np.array([-u[1], u[0]])
            for s in np.arange(2, ln, 4.0):
                px = to_px(a0 + u * s + nrm[None, :] * offs[:, None])
                ok = (px[:, 0] >= 0) & (px[:, 0] < w - 1) & (px[:, 1] >= 0) & (px[:, 1] < h - 1)
                if not ok.all():
                    continue
                row = surface[px[:, 1].astype(int), px[:, 0].astype(int)]
                # Самая длинная светлая полоса, задевающая середину (±3 м).
                best, start = 0, None
                for i, v in enumerate(np.r_[row, False]):
                    if v and start is None:
                        start = i
                    elif not v and start is not None:
                        if offs[start] <= 3 and offs[i - 1] >= -3:
                            best = max(best, i - start)
                        start = None
                if best:
                    got.append(best * 0.5)
        if len(got) >= 6 and len(got) * 4.0 > 0.3 * length.sum():
            widths[n] = round(float(np.clip(np.median(got), 3.0, 12.0)), 1)
    print(f'ширина по карте: у {len(widths)} дорог OSM из {len(osm_roads)}; '
          + ', '.join(f'{streets["roads"][n]["width"]}→{v}' for n, v in list(widths.items())[:8]), flush=True)

    # 2. Новые дороги: «менее зелёная» узкая полоска, не темнее травы вокруг.
    e = ndimage.gaussian_filter(r - g, 0.8)
    ridge = e - ndimage.grey_opening(e, size=(9, 9))
    around = ndimage.uniform_filter(luma, 15)
    track = (ridge > 4.2) & (luma > around - 8) & (luma > 62)
    block = Image.new('1', (w, h), 0)
    bd = ImageDraw.Draw(block)
    for _, ring, _ in t.buildings():
        bd.polygon([tuple(v) for v in to_px(ring)], fill=1)
    houses = ndimage.distance_transform_edt(~np.array(block, bool)) * mpp
    roads_img = Image.new('1', (w, h), 0)
    rd = ImageDraw.Draw(roads_img)
    for axis in known:
        rd.line([tuple(v) for v in to_px(axis)], fill=1, width=1)
    to_known = ndimage.distance_transform_edt(~np.array(roads_img, bool)) * mpp
    track &= (houses > 14) & (to_known > 9)
    if (t.data / 'water-render.json').exists():
        wimg = Image.new('1', (w, h), 0)
        wd = ImageDraw.Draw(wimg)
        for river in json.load(open(t.data / 'water-render.json'))['rivers']:
            c = np.array(river, float)
            wd.line([tuple(v) for v in to_px(np.stack(t.local(c[:, 0], c[:, 1]), 1))], fill=1, width=max(1, int(9 / mpp)))
        track &= ~np.array(wimg, bool)
    track = ndimage.binary_closing(track, iterations=1)
    labels, n = ndimage.label(track, np.ones((3, 3)))
    extent = np.array([0] + [max(sl[0].stop - sl[0].start, sl[1].stop - sl[1].start) for sl in ndimage.find_objects(labels)])
    track = (extent * mpp >= 22)[labels]
    half = ndimage.distance_transform_edt(track) * mpp
    print(f'полосок колеи: {int(track.sum())} пикселей', flush=True)
    lines = trace(thin(track))
    print(f'линий {len(lines)}', flush=True)

    pieces = []
    for line in lines:
        if len(line) < 12:
            continue
        path = simplify(line, 2.0)
        world = to_world(np.c_[path[:, 1], path[:, 0]])
        if np.hypot(*np.diff(world, axis=0).T).sum() >= 25:
            pieces.append(world)
    pieces = join(pieces, gap=16.0, reach=10.0)
    known_pts = np.vstack([np.vstack([a0 + (a1 - a0) * s for s in np.linspace(0, 1, max(2, int(np.hypot(*(a1 - a0)) / 2)))]) for axis in known for a0, a1 in zip(axis[:-1], axis[1:])])
    tree = cKDTree(known_pts)
    found = []
    for world in pieces:
        length = float(np.hypot(*np.diff(world, axis=0).T).sum())
        chord = float(np.hypot(*(world[-1] - world[0])))
        if length < a.min_length or chord < 0.5 * length:
            continue
        # Концы — к ближайшей известной дороге, если она рядом.
        for end in (0, -1):
            d, i = tree.query(world[end])
            if d < 16:
                world = np.vstack([known_pts[i], world]) if end == 0 else np.vstack([world, known_pts[i]])
        px = to_px(world).astype(int)
        px[:, 0] = np.clip(px[:, 0], 0, w - 1)
        px[:, 1] = np.clip(px[:, 1], 0, h - 1)
        wide = float(np.clip(np.median(half[px[:, 1], px[:, 0]]) * 2 + 1.0, 2.2, 4.5))
        found.append((world, wide, length))

    paths = []
    for world, wide, _ in found:
        lon, lat = t.lonlat(world[:, 0], world[:, 1])
        paths.append({'highway': 'track', 'width': round(wide, 1), 'coords': [[round(float(x), 7), round(float(y), 7)] for x, y in zip(lon, lat)]})
    save_json(t.data / 'streets-render.json', {
        'metadata': {'territory': t.id, 'source': 'С картинки-рендера деревни: ширина дорог OSM по светлому полотну и просёлки (полевые и лесные дороги), которых в OSM нет',
                     'generatedAt': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')},
        'widths': {str(n): v for n, v in widths.items()},
        'paths': paths,
    })
    print(f'новых дорог {len(found)}, {sum(f[2] for f in found):.0f} м')

    if a.preview:
        d = ImageDraw.Draw(full)
        for axis in known:
            d.line([tuple(v * k) for v in to_px(axis)], fill=(255, 255, 255), width=2)
        for world, wide, _ in found:
            d.line([tuple(v * k) for v in to_px(world)], fill=(255, 40, 200), width=4)
        full.save(a.preview, quality=88)


if __name__ == '__main__':
    main()
