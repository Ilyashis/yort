// Геометрия на плоскости мира: x — восток, z — юг (как в three.js, y — вверх).

export type P2 = [number, number];

export interface BBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

const M_PER_DEG_LAT = 111_320;

/** Плоская система координат в метрах вокруг центра района. */
export class Frame {
  readonly lon0: number;
  readonly lat0: number;
  readonly kx: number;
  readonly kz = M_PER_DEG_LAT;

  constructor(bbox: BBox) {
    this.lon0 = (bbox.west + bbox.east) / 2;
    this.lat0 = (bbox.south + bbox.north) / 2;
    this.kx = M_PER_DEG_LAT * Math.cos((this.lat0 * Math.PI) / 180);
  }
  x(lon: number): number {
    return (lon - this.lon0) * this.kx;
  }
  z(lat: number): number {
    return -(lat - this.lat0) * this.kz;
  }
  xz(lon: number, lat: number): P2 {
    return [this.x(lon), this.z(lat)];
  }
  lon(x: number): number {
    return this.lon0 + x / this.kx;
  }
  lat(z: number): number {
    return this.lat0 - z / this.kz;
  }
}

export function signedArea(ring: readonly P2[]): number {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    s += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return s / 2;
}

/** Убирает замыкающую и повторные точки и приводит обход к нужному знаку площади. */
export function normalizeRing(ring: readonly P2[], positive: boolean): P2[] {
  const out: P2[] = [];
  for (const p of ring) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.02) out.push([p[0], p[1]]);
  }
  if (out.length > 1) {
    const a = out[0];
    const b = out[out.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) <= 0.02) out.pop();
  }
  if (signedArea(out) > 0 !== positive) out.reverse();
  return out;
}

export function pointInRing(x: number, z: number, ring: readonly P2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const zi = ring[i][1];
    const xj = ring[j][0];
    const zj = ring[j][1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPoly(x: number, z: number, rings: readonly P2[][]): boolean {
  if (!rings.length || !pointInRing(x, z, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) if (pointInRing(x, z, rings[i])) return false;
  return true;
}

/** Квадрат расстояния до отрезка и параметр ближайшей точки. */
export function segDist2(px: number, pz: number, ax: number, az: number, bx: number, bz: number): [number, number] {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0;
  const ex = px - ax - dx * t;
  const ez = pz - az - dz * t;
  return [ex * ex + ez * ez, t];
}

export function centroid(ring: readonly P2[]): P2 {
  let x = 0;
  let z = 0;
  for (const p of ring) {
    x += p[0];
    z += p[1];
  }
  return [x / ring.length, z / ring.length];
}

export interface Obb {
  cx: number;
  cz: number;
  /** Единичный вектор вдоль длинной стороны. */
  ux: number;
  uz: number;
  /** Полудлина и полуширина. */
  L: number;
  W: number;
  /** Доля прямоугольника, занятая контуром (1 — контур и есть прямоугольник). */
  fill: number;
}

/** Описанный прямоугольник наименьшей площади среди выровненных по сторонам контура. */
export function obb(ring: readonly P2[]): Obb {
  let best: Obb | undefined;
  let bestArea = Infinity;
  const area = Math.abs(signedArea(ring));
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.3) continue;
    const ux = (b[0] - a[0]) / len;
    const uz = (b[1] - a[1]) / len;
    let u0 = Infinity, u1 = -Infinity, w0 = Infinity, w1 = -Infinity;
    for (const p of ring) {
      const u = p[0] * ux + p[1] * uz;
      const w = -p[0] * uz + p[1] * ux;
      if (u < u0) u0 = u;
      if (u > u1) u1 = u;
      if (w < w0) w0 = w;
      if (w > w1) w1 = w;
    }
    const boxArea = (u1 - u0) * (w1 - w0);
    if (boxArea < bestArea) {
      bestArea = boxArea;
      const cu = (u0 + u1) / 2;
      const cw = (w0 + w1) / 2;
      const cx = cu * ux - cw * uz;
      const cz = cu * uz + cw * ux;
      const lu = (u1 - u0) / 2;
      const lw = (w1 - w0) / 2;
      best =
        lu >= lw
          ? { cx, cz, ux, uz, L: lu, W: lw, fill: 0 }
          : { cx, cz, ux: -uz, uz: ux, L: lw, W: lu, fill: 0 };
    }
  }
  if (!best) {
    const c = centroid(ring);
    return { cx: c[0], cz: c[1], ux: 1, uz: 0, L: 1, W: 1, fill: 0 };
  }
  best.fill = bestArea > 0 ? area / bestArea : 0;
  return best;
}

function segmentsCross(a: P2, b: P2, c: P2, d: P2): boolean {
  const o = (p: P2, q: P2, r: P2) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}

/** Контур, сдвинутый внутрь на d (обход с положительной площадью). null — если сдвиг ломает форму. */
export function insetRing(ring: readonly P2[], d: number): P2[] | null {
  const n = ring.length;
  if (n < 3) return null;
  const out: P2[] = [];
  for (let i = 0; i < n; i++) {
    const p = ring[i];
    const a = ring[(i + n - 1) % n];
    const b = ring[(i + 1) % n];
    const l0 = Math.hypot(p[0] - a[0], p[1] - a[1]) || 1;
    const l1 = Math.hypot(b[0] - p[0], b[1] - p[1]) || 1;
    // Нормаль внутрь для обхода с положительной площадью.
    const n0x = -(p[1] - a[1]) / l0, n0z = (p[0] - a[0]) / l0;
    const n1x = -(b[1] - p[1]) / l1, n1z = (b[0] - p[0]) / l1;
    const k = d / Math.max(0.25, 1 + n0x * n1x + n0z * n1z);
    out.push([p[0] + (n0x + n1x) * k, p[1] + (n0z + n1z) * k]);
  }
  const area = signedArea(ring);
  const insetArea = signedArea(out);
  if (insetArea <= 0 || insetArea < area * 0.06) return null;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dot = (ring[j][0] - ring[i][0]) * (out[j][0] - out[i][0]) + (ring[j][1] - ring[i][1]) * (out[j][1] - out[i][1]);
    if (dot <= 0) return null;
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segmentsCross(out[i], out[(i + 1) % n], out[j], out[(j + 1) % n])) return null;
    }
  }
  return out;
}

/** Детерминированное число 0..1 из строки или числа. */
export function hash01(key: string | number, salt = 0): number {
  let h = 2166136261 ^ salt;
  const s = typeof key === 'number' ? String(key) : key;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Генератор псевдослучайных чисел с зерном. */
export function rng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export function smoothstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}
