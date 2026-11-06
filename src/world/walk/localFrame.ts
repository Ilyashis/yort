import type { LonLat } from '../user/plot';

/** Точка в локальных метрах: x — на восток, y — на север. */
export type Vec2 = [number, number];

export interface LocalFrame {
  origin: LonLat;
  toLocal: (point: LonLat) => Vec2;
  toLonLat: (point: Vec2) => LonLat;
}

const M_PER_DEG_LAT = 111_320;

/**
 * Плоская система координат в метрах вокруг точки. Для района в пару километров
 * погрешность — сантиметры, зато вся геометрия прогулки считается просто и быстро.
 */
export function createLocalFrame(origin: LonLat): LocalFrame {
  const [lon0, lat0] = origin;
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);
  return {
    origin,
    toLocal: ([lon, lat]) => [(lon - lon0) * mPerDegLon, (lat - lat0) * M_PER_DEG_LAT],
    toLonLat: ([x, y]) => [lon0 + x / mPerDegLon, lat0 + y / M_PER_DEG_LAT],
  };
}

export function pointInRing([x, y]: Vec2, ring: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function distanceToSegment([px, py]: Vec2, [ax, ay]: Vec2, [bx, by]: Vec2): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function distanceToRing(point: Vec2, ring: readonly Vec2[]): number {
  let min = Number.POSITIVE_INFINITY;
  for (let i = 1; i < ring.length; i++) min = Math.min(min, distanceToSegment(point, ring[i - 1]!, ring[i]!));
  return min;
}

/** Локальный полигон с габаритами для быстрого отсева. */
export interface LocalPolygon {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** Первое кольцо — внешнее, остальные — дыры (дворы). */
  rings: Vec2[][];
}

export function toLocalPolygon(rings: readonly (readonly LonLat[])[], frame: LocalFrame): LocalPolygon {
  const local = rings.map((ring) => ring.map(frame.toLocal));
  const xs = (local[0] ?? []).map(([x]) => x);
  const ys = (local[0] ?? []).map(([, y]) => y);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
    rings: local,
  };
}

/** Точка внутри полигона с учётом дыр. */
export function insidePolygon(point: Vec2, polygon: LocalPolygon): boolean {
  const [outer, ...holes] = polygon.rings;
  return !!outer && pointInRing(point, outer) && !holes.some((hole) => pointInRing(point, hole));
}

/** Расстояние до границы полигона (0 — если точка внутри). */
export function distanceToPolygon(point: Vec2, polygon: LocalPolygon): number {
  if (insidePolygon(point, polygon)) return 0;
  return Math.min(...polygon.rings.map((ring) => distanceToRing(point, ring)));
}
