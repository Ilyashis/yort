#!/usr/bin/env python3
"""Модель земли по своей съёмке с дрона → public/data/territories/<id>/terrain-detail.json.

Облако OpenDroneMap переносится на карту (матрица из align.py), раскладывается по сетке 1 м: в каждой клетке —
20-й перцентиль высот. Дома и деревья снимаются «открытием» (минимум, потом максимум по окну 13 м), землю
под ними заполняем гладко по соседней земле. Крупную форму (наклон, «купол» — частая ошибка съёмки без
координат) берём у Copernicus: из разницы вычитаем гладкую поверхность 2-й степени. Где мало точек
или явно лес (на 6+ м выше Copernicus) — «нет данных»; приложение там плавно переходит к Copernicus.

  python3 scripts/drone/terrain.py <проект ODM> --align align.json --territory itkulovo-1 [--res 1] [--fade 40]
Рядом с файлом рельефа кладётся <проект>/terrain-dtm.npz — его берёт survey.py (высота над землёй).
"""

import argparse
import base64
import datetime
import json
from pathlib import Path

import numpy as np
from scipy import ndimage

from common import Alignment, Territory, load_cloud, save_json


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('project')
    p.add_argument('--align', required=True)
    p.add_argument('--territory', required=True)
    p.add_argument('--res', type=float, default=1.0)
    p.add_argument('--fade', type=float, default=40.0)
    p.add_argument('--source', default='Своя съёмка с дрона, OpenDroneMap; привязка по улицам OSM')
    a = p.parse_args()

    t = Territory(a.territory)
    xyz, _, _ = load_cloud(a.project)
    world = Alignment(a.align)(xyz)
    del xyz
    res = a.res
    ax0, ay0, ax1, ay1 = t.area()
    x0 = max(np.percentile(world[:, 0], 0.5), ax0)
    x1 = min(np.percentile(world[:, 0], 99.5), ax1)
    y0 = max(np.percentile(world[:, 1], 0.5), ay0)
    y1 = min(np.percentile(world[:, 1], 99.5), ay1)
    w, h = int((x1 - x0) / res) + 1, int((y1 - y0) / res) + 1
    ix = np.floor((world[:, 0] - x0) / res).astype(np.int64)
    iy = np.floor((y1 - world[:, 1]) / res).astype(np.int64)
    ok = (ix >= 0) & (ix < w) & (iy >= 0) & (iy < h)
    cell = (iy * w + ix)[ok]
    z = world[ok, 2]
    del world
    order = np.lexsort((z, cell))
    cell, z = cell[order], z[order]
    starts = np.flatnonzero(np.r_[True, cell[1:] != cell[:-1]])
    counts = np.diff(np.r_[starts, len(cell)])
    surf = np.full(w * h, np.nan)
    surf[cell[starts]] = z[starts + (counts * 0.2).astype(np.int64)]
    top = np.full(w * h, np.nan)
    top[cell[starts]] = z[starts + (counts * 0.9).astype(np.int64)]
    cnt = np.zeros(w * h)
    cnt[cell[starts]] = counts
    surf, top, cnt = surf.reshape(h, w), top.reshape(h, w), cnt.reshape(h, w)

    # Мало точек (дальние края, наклонные лучи) — не верим.
    dens = ndimage.uniform_filter((cnt > 0).astype(float), 7)
    valid = (dens > 0.6) & (ndimage.uniform_filter(cnt, 9) >= 3)
    valid = ndimage.binary_opening(valid, iterations=3)
    idx = ndimage.distance_transform_edt(~np.isfinite(surf), return_distances=False, return_indices=True)
    filled = surf[tuple(idx)]
    # Дома и деревья: выше «открытой» поверхности (окно 13 м) больше чем на 0,8 м — землю там достраиваем.
    opened = ndimage.grey_opening(filled, size=(13, 13))
    obj = ndimage.binary_dilation((filled - opened) > 0.8, iterations=2)
    free = valid & ~obj
    num = ndimage.gaussian_filter(np.where(free, filled, 0), 5)
    den = ndimage.gaussian_filter(free.astype(float), 5)
    ground = np.where(obj, np.where(den > 0.05, num / np.maximum(den, 1e-6), opened), filled)
    num = ndimage.gaussian_filter(np.where(valid, ground, 0), 1.5)
    den = ndimage.gaussian_filter(valid.astype(float), 1.5)
    ground = np.where((den > 0.3) & valid, num / np.maximum(den, 1e-6), np.nan)

    # Крупная форма — у Copernicus.
    gx, gy = np.meshgrid(x0 + (np.arange(w) + 0.5) * res, y1 - (np.arange(h) + 0.5) * res)
    cop = t.copernicus()(gx, gy)
    sel = np.flatnonzero(np.isfinite(ground).ravel())[::25]
    xs, ys = gx.ravel()[sel] / 1000, gy.ravel()[sel] / 1000
    diff = (ground - cop).ravel()[sel]
    design = np.stack([np.ones_like(xs), xs, ys, xs * xs, xs * ys, ys * ys], 1)
    keep = np.ones(len(diff), bool)
    for _ in range(6):
        coef, *_ = np.linalg.lstsq(design[keep], diff[keep], rcond=None)
        r = diff - design @ coef
        keep = np.abs(r) < 2.5 * np.std(r[keep])
    X, Y = gx / 1000, gy / 1000
    trend = coef[0] + coef[1] * X + coef[2] * Y + coef[3] * X * X + coef[4] * X * Y + coef[5] * Y * Y
    dtm = ground - trend
    dtm[np.abs(dtm - cop) > 6] = np.nan
    print(f'сетка {w}×{h} по {res} м; снято {np.isfinite(dtm).mean() * 100:.0f}%; '
          f'съёмка − Copernicus после подгонки: 10–90% {np.nanpercentile(dtm - cop, 10):.2f}…{np.nanpercentile(dtm - cop, 90):.2f} м')

    # Для survey.py: земля и «верх» (90-й перцентиль) в высотах самого облака (без подгонки к Copernicus) —
    # чтобы мерить высоту построек над землёй прямо по точкам.
    np.savez_compressed(Path(a.project) / 'terrain-dtm.npz', dtm=(dtm + trend).astype(np.float32), top=top.astype(np.float32),
                        cnt=cnt.astype(np.float32), x0=x0, y1=y1, res=res)

    # Обрезка по снятому и запись в формате приложения (дециметры Int16, «нет данных» — −32768).
    rows = np.flatnonzero(np.isfinite(dtm).any(1))
    cols = np.flatnonzero(np.isfinite(dtm).any(0))
    r0, r1 = max(rows[0] - 2, 0), min(rows[-1] + 2, h - 1)
    c0, c1 = max(cols[0] - 2, 0), min(cols[-1] + 2, w - 1)
    dtm = dtm[r0:r1 + 1, c0:c1 + 1]
    cx0, cy1 = x0 + c0 * res, y1 - r0 * res
    hh, ww = dtm.shape
    west, north = t.lonlat(cx0 + 0.5 * res, cy1 - 0.5 * res)
    east, south = t.lonlat(cx0 + (ww - 0.5) * res, cy1 - (hh - 0.5) * res)
    offset = float(round(np.nanmean(dtm)))
    ints = np.where(np.isfinite(dtm), np.clip(np.round((dtm - offset) / 0.1), -32767, 32767), -32768).astype('<i2')
    out = t.data / 'terrain-detail.json'
    save_json(out, {
        'metadata': {'source': a.source, 'license': 'Собственная съёмка', 'credit': 'Рельеф деревни: своя съёмка с дрона',
                     'resolution': res, 'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat()},
        'bbox': {'west': float(west), 'south': float(south), 'east': float(east), 'north': float(north)},
        'width': ww, 'height': hh, 'scale': 0.1, 'offset': offset, 'nodata': -32768, 'fade': a.fade,
        'heights': base64.b64encode(ints.tobytes()).decode(),
    })
    print(f'→ {out.relative_to(t.data.parents[3])} ({out.stat().st_size / 1e6:.1f} МБ)')


if __name__ == '__main__':
    main()
