// Дворы деревенских домов в локальных метрах: участок с забором, воротами и огородом.
// В OSM границ участков в деревне почти никогда нет — строим правдоподобные по дому и улице.
// Чистые функции.

import { hashString } from '../../utils/hash';
import { distanceToSegment, type Vec2 } from '../walk/localFrame';
import { openRing, orientedBox, signedArea } from './roofGeometry';

/** Типы зданий, у которых в деревне бывает свой двор. */
export const VILLAGE_HOUSE_TYPES = new Set(['yes', 'house', 'detached', 'residential', 'semidetached_house', 'bungalow']);

export interface YardHouse {
  id: string;
  ring: readonly Vec2[];
}

export interface YardRoad {
  coords: readonly Vec2[];
  width: number;
}

export interface Yard {
  houseId: string;
  /** Углы участка против часовой; первая сторона (0→1) — вдоль улицы. */
  corners: [Vec2, Vec2, Vec2, Vec2];
  /** Отрезки забора (ворота и стена дома на линии улицы — разрывы). */
  fence: [Vec2, Vec2][];
  /** Огород в глубине участка (если участок достаточно длинный) и направление грядок. */
  garden?: { corners: [Vec2, Vec2, Vec2, Vec2]; rows: Vec2 };
  /**
   * Палисадник перед домом: от стены до забора по улице, шириной с фасад. origin — середина фасада,
   * toStreet — единичный вектор к улице. Уличный забор напротив палисадника вырезан — там штакетник палисадника.
   */
  palisade?: { origin: Vec2; toStreet: Vec2; width: number; depth: number };
  /** Стабильное число для цвета забора. */
  seed: number;
}

export interface YardOptions {
  /** Дома меньше этой площади — сараи и бани: своих дворов у них нет, внутри чужих двор не мешают. */
  minHouseArea: number;
  /** Глубина участка за домом, м: [от, до]. */
  back: [number, number];
  /** Сколько участок шире дома с каждой стороны, м: [от, до]. */
  side: [number, number];
  /** Самый широкий палисадник между домом и улицей, м. */
  maxFront: number;
  gateWidth: number;
}

const DEFAULTS: YardOptions = { minHouseArea: 45, back: [20, 40], side: [3, 7], maxFront: 5, gateWidth: 3 };
/** Палисадник — если от дома до улицы хотя бы метр, а сбоку от дома хватает места на ворота. */
const PALISADE = { minFront: 1, minSide: 1.6 };
const SHRINK_STEPS = 6;
const ROAD_CLEARANCE = 0.6;

const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];

/**
 * Участок вокруг каждого дома: прямоугольник по осям дома, фасадом к ближайшей улице —
 * спереди палисадник до улицы (не шире maxFront), сзади длинный огород. Если участок налезает
 * на чужой дом, соседний участок или дорогу — ужимаем его, пока не перестанет; не вышло — без двора.
 */
export function planYards(
  houses: readonly YardHouse[],
  roads: readonly YardRoad[],
  options: Partial<YardOptions> = {},
): Yard[] {
  const opts = { ...DEFAULTS, ...options };
  const shapes = houses.map((h) => {
    const ring = openRing(h.ring);
    const area = Math.abs(signedArea(ring));
    return { house: h, ring, area, box: orientedBox(ring) };
  });
  const obstacles = shapes.map((s) => ({ id: s.house.id, area: s.area, poly: boxCorners(s.box) }));
  const segments = roads.flatMap((r) =>
    r.coords.slice(1).map((b, i) => ({ a: r.coords[i]!, b, half: r.width / 2 })),
  );

  const yards: Yard[] = [];
  const placed: Vec2[][] = [];
  const order = shapes.filter((s) => s.area >= opts.minHouseArea).sort((x, y) => y.area - x.area);
  for (const { house, box } of order) {
    // Ближайшая точка улицы задаёт, какая сторона дома — фасад.
    let best: { point: Vec2; distance: number; half: number } | undefined;
    for (const s of segments) {
      const d = distanceToSegment(box.center, s.a, s.b);
      if (!best || d < best.distance) best = { point: closestOnSegment(box.center, s.a, s.b), distance: d, half: s.half };
    }
    if (!best) continue;
    const toRoad = sub(best.point, box.center);
    const axes: { f: Vec2; halfF: number; halfL: number }[] = [
      { f: box.u, halfF: box.halfU, halfL: box.halfV },
      { f: [-box.u[0], -box.u[1]], halfF: box.halfU, halfL: box.halfV },
      { f: box.v, halfF: box.halfV, halfL: box.halfU },
      { f: [-box.v[0], -box.v[1]], halfF: box.halfV, halfL: box.halfU },
    ];
    const { f, halfF, halfL } = axes.reduce((a, b) => (dot(b.f, toRoad) > dot(a.f, toRoad) ? b : a));
    const l: Vec2 = [-f[1], f[0]];
    const seed = hashString(`yard:${house.id}`);
    const pick = ([lo, hi]: [number, number], k: number) => lo + (((seed >>> k) % 1000) / 1000) * (hi - lo);

    // До края проезжей части от фасада, минус небольшой запас.
    const gap = dot(toRoad, f) - halfF - best.half - 1;
    let front = Math.min(Math.max(gap, 0), opts.maxFront);
    let back = pick(opts.back, 0);
    let side = pick(opts.side, 10);

    let corners: [Vec2, Vec2, Vec2, Vec2] | undefined;
    for (let step = 0; step < SHRINK_STEPS; step++) {
      const candidate = rectangle(box.center, f, l, -halfF - back, halfF + front, -halfL - side, halfL + side);
      const blocked =
        obstacles.some((o) => o.id !== house.id && o.area >= opts.minHouseArea && convexOverlap(candidate, o.poly)) ||
        placed.some((p) => convexOverlap(candidate, p)) ||
        segments.some((s) => segmentPolygonDistance(s.a, s.b, candidate) < s.half + ROAD_CLEARANCE);
      if (!blocked) {
        corners = candidate;
        break;
      }
      back *= 0.7;
      side *= 0.7;
      front *= 0.6;
    }
    if (!corners) continue;
    placed.push(corners);

    // Забор: улица — с воротами у одного края (и без отрезка вдоль стены дома, если палисадника нет).
    const [c0, c1, c2, c3] = corners; // c0→c1 — по улице (слева направо, если смотреть с улицы на дом)
    const along = (t: number): Vec2 => [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t];
    const width = Math.hypot(c1[0] - c0[0], c1[1] - c0[1]);
    const houseFrom = side / width;
    const palisade = front >= PALISADE.minFront && side >= PALISADE.minSide;
    let gate = Math.min(opts.gateWidth / width, 0.4);
    let gateAt = seed % 2 ? 0.08 : 0.92 - gate;
    if (palisade) {
      // Ворота — сбоку от дома: напротив фасада палисадник.
      gate = Math.min(opts.gateWidth, side - 0.5) / width;
      gateAt = seed % 2 ? (houseFrom - gate) / 2 : 1 - houseFrom + (houseFrom - gate) / 2;
    }
    const fence: [Vec2, Vec2][] = [];
    const streetCuts: [number, number][] = [[gateAt, gateAt + gate]];
    // Дом стоит прямо на линии улицы — его стена и есть забор; перед палисадником — его штакетник.
    if (front < 0.8 || palisade) streetCuts.push([houseFrom, 1 - houseFrom]);
    for (const [t0, t1] of complement(streetCuts)) fence.push([along(t0), along(t1)]);
    fence.push([c1, c2], [c2, c3], [c3, c0]);

    const yard: Yard = { houseId: house.id, corners, fence, seed };
    if (palisade) {
      yard.palisade = { origin: [box.center[0] + f[0] * halfF, box.center[1] + f[1] * halfF], toStreet: f, width: 2 * halfL, depth: front };
    }
    if (back >= 14) {
      yard.garden = {
        corners: rectangle(box.center, f, l, -halfF - back + 1.5, -halfF - 5, -halfL - side + 1.2, halfL + side - 1.2),
        rows: f,
      };
    }
    yards.push(yard);
  }
  return yards;
}

/** Прямоугольник в осях (f — к улице, l — вбок) от точки c; обход против часовой, первая сторона — уличная. */
function rectangle(c: Vec2, f: Vec2, l: Vec2, f0: number, f1: number, l0: number, l1: number): [Vec2, Vec2, Vec2, Vec2] {
  const p = (sf: number, sl: number): Vec2 => [c[0] + f[0] * sf + l[0] * sl, c[1] + f[1] * sf + l[1] * sl];
  const corners: [Vec2, Vec2, Vec2, Vec2] = [p(f1, l1), p(f1, l0), p(f0, l0), p(f0, l1)];
  return signedArea(corners) >= 0 ? corners : [corners[1], corners[0], corners[3], corners[2]];
}

function boxCorners(box: ReturnType<typeof orientedBox>): Vec2[] {
  return rectangle(box.center, box.u, box.v, -box.halfU, box.halfU, -box.halfV, box.halfV);
}

/** Части [0, 1], не попавшие в вырезы. */
function complement(cuts: [number, number][]): [number, number][] {
  const sorted = cuts.map(([a, b]) => [Math.max(0, a), Math.min(1, b)] as [number, number]).sort((x, y) => x[0] - y[0]);
  const result: [number, number][] = [];
  let from = 0;
  for (const [a, b] of sorted) {
    if (a > from + 1e-3) result.push([from, a]);
    from = Math.max(from, b);
  }
  if (from < 1 - 1e-3) result.push([from, 1]);
  return result;
}

function closestOnSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const ab = sub(b, a);
  const length2 = dot(ab, ab);
  const t = length2 > 0 ? Math.min(Math.max(dot(sub(p, a), ab) / length2, 0), 1) : 0;
  return [a[0] + ab[0] * t, a[1] + ab[1] * t];
}

/** Пересекаются ли выпуклые многоугольники (теорема о разделяющей оси). */
export function convexOverlap(a: readonly Vec2[], b: readonly Vec2[]): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]!;
      const q = poly[(i + 1) % poly.length]!;
      const axis: Vec2 = [q[1] - p[1], p[0] - q[0]];
      const project = (pts: readonly Vec2[]) => pts.map((v) => dot(v, axis));
      const pa = project(a);
      const pb = project(b);
      // Касание по краю — не пересечение.
      if (Math.max(...pa) <= Math.min(...pb) + 1e-6 || Math.max(...pb) <= Math.min(...pa) + 1e-6) return false;
    }
  }
  return true;
}

/** Расстояние от отрезка до выпуклого многоугольника (0 — если пересекает или внутри). */
function segmentPolygonDistance(a: Vec2, b: Vec2, poly: readonly Vec2[]): number {
  if (convexOverlap([a, b], poly) || insideConvex(a, poly)) return 0;
  let min = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    min = Math.min(min, distanceToSegment(a, p, q), distanceToSegment(b, p, q), distanceToSegment(p, a, b));
  }
  return min;
}

function insideConvex(point: Vec2, poly: readonly Vec2[]): boolean {
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    if ((q[0] - p[0]) * (point[1] - p[1]) - (q[1] - p[1]) * (point[0] - p[0]) < 0) return false;
  }
  return true;
}
