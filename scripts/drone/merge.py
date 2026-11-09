#!/usr/bin/env python3
"""Дополнить облако проекта точками запасного облака там, где у основного дыры.

На высоком качестве OpenDroneMap может пропустить части сцены (не хватило памяти на слияние карт глубины) —
там берутся точки облака пониже качеством из тех же кадров: модель OpenSfM та же, координаты совпадают.
Дыра — клетка cell × cell м (по привязке к карте), где у основного облака нет точек ни в ней, ни рядом.

  python3 scripts/drone/merge.py <проект> --align align.json --fill <запасное point_cloud.ply> [--cell 2]

Итог — <проект>/odm_filterpoints/point_cloud.ply; основное облако без дополнения остаётся рядом
(point_cloud.main.ply), так что повторный запуск берёт его, а не уже дополненное.
"""
import argparse
from pathlib import Path

import numpy as np
from scipy.ndimage import binary_dilation

from common import PLY_DTYPE, Alignment


def read_ply(path: Path) -> tuple[bytes, np.ndarray]:
    head = path.open('rb').read(4000)
    end = head.index(b'end_header\n') + len(b'end_header\n')
    header = head[:end].decode()
    if 'property float x' not in header or 'property uchar views' not in header:
        raise SystemExit(f'Неожиданный формат облака: {path}')
    return head[:end], np.memmap(path, dtype=PLY_DTYPE, mode='r', offset=end)


def world_xy(align: Alignment, pts: np.ndarray, chunk: int = 5_000_000) -> np.ndarray:
    out = np.empty((len(pts), 2), np.float32)
    for i in range(0, len(pts), chunk):
        p = pts[i : i + chunk]
        xyz = np.stack([p['x'], p['y'], p['z']], 1).astype(np.float64)
        out[i : i + chunk] = align(xyz)[:, :2]
    return out


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('project')
    p.add_argument('--align', required=True)
    p.add_argument('--fill', required=True, help='запасное облако (тот же проект, качество пониже)')
    p.add_argument('--cell', type=float, default=2.0, help='размер клетки для поиска дыр, м')
    a = p.parse_args()

    folder = Path(a.project) / 'odm_filterpoints'
    main_path = folder / 'point_cloud.main.ply'
    if not main_path.exists():
        (folder / 'point_cloud.ply').rename(main_path)
    header, main_pts = read_ply(main_path)
    _, fill_pts = read_ply(Path(a.fill))
    align = Alignment(a.align)

    xy_main = world_xy(align, main_pts)
    xy_fill = world_xy(align, fill_pts)
    lo = np.minimum(xy_main.min(0), xy_fill.min(0)) - a.cell
    hi = np.maximum(xy_main.max(0), xy_fill.max(0)) + a.cell
    shape = tuple(np.ceil((hi - lo) / a.cell).astype(int) + 1)

    def cell(xy: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        return ((xy[:, 0] - lo[0]) // a.cell).astype(np.int64), ((xy[:, 1] - lo[1]) // a.cell).astype(np.int64)

    covered = np.zeros(shape, bool)
    covered[cell(xy_main)] = True
    covered = binary_dilation(covered, iterations=1)
    holes = ~covered[cell(xy_fill)]
    added = fill_pts[holes]
    hole_cells = np.zeros(shape, bool)
    hole_cells[tuple(c[holes] for c in cell(xy_fill))] = True

    n = len(main_pts) + len(added)
    out = folder / 'point_cloud.ply'
    text = header.decode()
    start = text.index('element vertex ') + len('element vertex ')
    text = text[:start] + str(n) + text[text.index('\n', start) :]
    with out.open('wb') as f:
        f.write(text.encode())
        for i in range(0, len(main_pts), 5_000_000):
            f.write(np.ascontiguousarray(main_pts[i : i + 5_000_000]).tobytes())
        f.write(np.ascontiguousarray(added).tobytes())
    area = hole_cells.sum() * a.cell**2
    print(f'основное облако: {len(main_pts):,} точек; добавлено из запасного: {len(added):,} ({area / 1e4:.1f} га дыр) → {out}')


if __name__ == '__main__':
    main()
