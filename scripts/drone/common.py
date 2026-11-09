"""Общее для обработки своей съёмки с дрона (OpenDroneMap → приложение).

Модель OpenDroneMap без координат лежит «в своих единицах». Преобразование в локальные метры района
(x — восток, y — север, z — вверх; центр — середина района, как в приложении) храним матрицей 4×4.

Нужны numpy, scipy, Pillow (и matplotlib для попадания точек в контуры).
"""

import base64
import json
import math
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
M_PER_DEG_LAT = 111_320.0

PLY_DTYPE = np.dtype([
    ('x', '<f4'), ('y', '<f4'), ('z', '<f4'),
    ('nx', '<f4'), ('ny', '<f4'), ('nz', '<f4'),
    ('r', 'u1'), ('b', 'u1'), ('g', 'u1'), ('v', 'u1'),
])


def load_cloud(project: str, step: int = 1):
    """Плотное облако OpenDroneMap (odm_filterpoints/point_cloud.ply): xyz, нормали, цвета."""
    path = Path(project) / 'odm_filterpoints' / 'point_cloud.ply'
    head = path.open('rb').read(4000)
    header = head[: head.index(b'end_header\n')].decode()
    if 'property float x' not in header or 'property uchar red' not in header:
        raise SystemExit(f'Неожиданный формат облака: {path}')
    start = head.index(b'end_header\n') + len(b'end_header\n')
    pts = np.memmap(path, dtype=PLY_DTYPE, mode='r', offset=start)[::step]
    xyz = np.stack([pts['x'], pts['y'], pts['z']], 1).astype(np.float64)
    normals = np.stack([pts['nx'], pts['ny'], pts['nz']], 1).astype(np.float32)
    rgb = np.stack([pts['r'], pts['g'], pts['b']], 1)
    return xyz, normals, rgb


def camera_centers(project: str) -> dict:
    """Где был дрон в каждом кадре (по OpenSfM): имя кадра → центр камеры в координатах модели."""
    rec = json.load(open(Path(project) / 'opensfm' / 'reconstruction.json'))[0]
    out = {}
    for name, shot in rec['shots'].items():
        r = np.array(shot['rotation'], float)
        t = np.array(shot['translation'], float)
        theta = np.linalg.norm(r)
        k = r / theta if theta > 0 else r
        kx = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
        rot = np.eye(3) + math.sin(theta) * kx + (1 - math.cos(theta)) * kx @ kx
        out[name] = -rot.T @ t
    return out


def apply(m: np.ndarray, xyz: np.ndarray) -> np.ndarray:
    """Точки (N×3) через матрицу 4×4."""
    return xyz @ m[:3, :3].T + m[:3, 3]


class Alignment:
    """Привязка из align.py: матрица 4×4 «модель → локальные метры» и, если есть, плавная поправка по плану
    (warp): съёмка без GPS по длинной полосе чуть изгибается, и подобием всё не совместить. Поправка —
    сдвиги (dx, dy) в опорных точках (в метрах после матрицы), между ними — гауссово сглаживание."""

    def __init__(self, path: str):
        data = json.load(open(path))
        self.data = data
        self.matrix = np.array(data['matrix'], float)
        warp = data.get('warp')
        self.anchors = np.array(warp['anchors'], float) if warp else np.zeros((0, 4))
        self.sigma = float(warp['sigma']) if warp else 0.0

    def __call__(self, xyz: np.ndarray) -> np.ndarray:
        world = apply(self.matrix, xyz)
        if len(self.anchors):
            world[:, :2] += self.shift(world[:, :2])
        return world

    def shift(self, xy: np.ndarray) -> np.ndarray:
        """Поправка в точках (N×2, метры после матрицы): по сетке 5 м, между узлами — билинейно."""
        if not len(self.anchors):
            return np.zeros_like(xy)
        from scipy import ndimage
        pad = 3 * self.sigma
        gx0, gy0 = self.anchors[:, 0].min() - pad, self.anchors[:, 1].min() - pad
        gx1, gy1 = self.anchors[:, 0].max() + pad, self.anchors[:, 1].max() + pad
        step = 5.0
        xs = np.arange(gx0, gx1 + step, step)
        ys = np.arange(gy0, gy1 + step, step)
        X, Y = np.meshgrid(xs, ys)
        grid = self.at(np.stack([X.ravel(), Y.ravel()], 1)).reshape(len(ys), len(xs), 2)
        fx = (xy[:, 0] - gx0) / step
        fy = (xy[:, 1] - gy0) / step
        return np.stack([ndimage.map_coordinates(grid[:, :, k], [fy, fx], order=1, mode='nearest') for k in range(2)], 1)

    def at(self, xy: np.ndarray) -> np.ndarray:
        """Поправка прямо по опорным точкам (гауссовы веса; вдали от них плавно уходит в ноль)."""
        d2 = ((xy[:, None, :] - self.anchors[None, :, :2]) ** 2).sum(-1)
        wts = np.exp(-d2 / (2 * self.sigma ** 2))
        den = wts.sum(1, keepdims=True) + 0.05
        return (wts @ self.anchors[:, 2:4]) / den


def similarity_3d(src: np.ndarray, dst: np.ndarray) -> np.ndarray:
    """Подобие (масштаб, поворот, сдвиг) src → dst по парам точек (Умеяма), матрица 4×4."""
    ms, md = src.mean(0), dst.mean(0)
    a, b = src - ms, dst - md
    u, s, vt = np.linalg.svd(b.T @ a / len(src))
    d = np.eye(3)
    if np.linalg.det(u @ vt) < 0:
        d[2, 2] = -1
    rot = u @ d @ vt
    scale = np.trace(np.diag(s) @ d) / (a ** 2).sum(1).mean()
    m = np.eye(4)
    m[:3, :3] = scale * rot
    m[:3, 3] = md - scale * rot @ ms
    return m


def similarity_2d(scale: float, theta: float, tx: float, ty: float) -> np.ndarray:
    """Подобие в плоскости (z — тем же масштабом) матрицей 4×4."""
    c, s = math.cos(theta), math.sin(theta)
    m = np.eye(4)
    m[:2, :2] = scale * np.array([[c, -s], [s, c]])
    m[2, 2] = scale
    m[:2, 3] = [tx, ty]
    return m


class Territory:
    """Район приложения: границы, локальные метры (как createLocalFrame), данные OSM и Copernicus."""

    def __init__(self, territory_id: str):
        items = json.load(open(ROOT / 'src' / 'config' / 'territories.json'))
        found = [t for t in items if t['id'] == territory_id]
        if not found:
            raise SystemExit(f'Нет района {territory_id} в src/config/territories.json')
        self.id = territory_id
        self.bbox = found[0]['bbox']
        b = self.bbox
        self.lon0 = (b['west'] + b['east']) / 2
        self.lat0 = (b['south'] + b['north']) / 2
        self.mlon = M_PER_DEG_LAT * math.cos(math.radians(self.lat0))
        self.data = ROOT / 'public' / 'data' / 'territories' / territory_id

    def local(self, lon, lat):
        return (np.asarray(lon) - self.lon0) * self.mlon, (np.asarray(lat) - self.lat0) * M_PER_DEG_LAT

    def lonlat(self, x, y):
        return self.lon0 + np.asarray(x) / self.mlon, self.lat0 + np.asarray(y) / M_PER_DEG_LAT

    def area(self):
        """Границы района в локальных метрах: x0, y0, x1, y1."""
        x0, y0 = self.local(self.bbox['west'], self.bbox['south'])
        x1, y1 = self.local(self.bbox['east'], self.bbox['north'])
        return float(x0), float(y0), float(x1), float(y1)

    def buildings(self):
        """Дома OSM: (id, контур в локальных метрах N×2, свойства)."""
        out = []
        for f in json.load(open(self.data / 'buildings.geojson'))['features']:
            geo = f['geometry']
            polys = [geo['coordinates']] if geo['type'] == 'Polygon' else geo['coordinates']
            for poly in polys:
                ring = np.array(poly[0], float)
                x, y = self.local(ring[:, 0], ring[:, 1])
                out.append((f['properties']['id'], np.stack([x, y], 1), f['properties']))
        return out

    def road_samples(self, every: float = 2.0) -> np.ndarray:
        """Точки вдоль осей улиц и просёлков OSM через every метров (локальные метры)."""
        s = json.load(open(self.data / 'streets.json'))
        samples = []
        for r in s['roads'] + [p for p in s['paths'] if p['highway'] == 'track']:
            c = np.array(r['coords'], float)
            x, y = self.local(c[:, 0], c[:, 1])
            for a0, a1, b0, b1 in zip(x[:-1], y[:-1], x[1:], y[1:]):
                n = max(1, int(math.hypot(b0 - a0, b1 - a1) / every))
                for k in range(n):
                    samples.append((a0 + (b0 - a0) * k / n, a1 + (b1 - a1) * k / n))
        return np.array(samples)

    def copernicus(self):
        """Высоты Copernicus (terrain.json) — функция (x, y локальные метры) → высота, билинейно."""
        from scipy import ndimage
        t = json.load(open(self.data / 'terrain.json'))
        raw = np.frombuffer(base64.b64decode(t['heights']), '<i2').reshape(t['height'], t['width']) * t['scale'] + t['offset']
        tb = t['bbox']

        def sample(x, y):
            lon, lat = self.lonlat(x, y)
            fx = (lon - tb['west']) / (tb['east'] - tb['west']) * (t['width'] - 1)
            fy = (tb['north'] - lat) / (tb['north'] - tb['south']) * (t['height'] - 1)
            return ndimage.map_coordinates(raw, [fy, fx], order=1, mode='nearest')
        return sample


def save_json(path, data):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, 'w') as f:
        json.dump(data, f)
