// Геометрия крыш в локальных метрах (x — восток, y — север, z — вверх от верха стен).
// Чистые функции: легко тестировать, в Cesium переводим отдельно.

import type { Vec2 } from '../walk/localFrame';

export type RoofShape = 'flat' | 'gabled' | 'hipped' | 'pyramidal' | 'skillion' | 'dome' | 'onion';
export type Vec3 = [number, number, number];
export type Triangle = [Vec3, Vec3, Vec3];

/** Минимальный по площади прямоугольник вокруг контура; u — длинная ось. */
export interface OrientedBox {
  center: Vec2;
  u: Vec2;
  v: Vec2;
  halfU: number;
  halfV: number;
}

const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const add2 = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
const mul = (a: Vec2, k: number): Vec2 => [a[0] * k, a[1] * k];
const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];
const at = (p: Vec2, z: number): Vec3 => [p[0], p[1], z];

/** Контур без повторной замыкающей точки. */
export function openRing(ring: readonly Vec2[]): Vec2[] {
  const last = ring[ring.length - 1];
  const first = ring[0];
  return last && first && last[0] === first[0] && last[1] === first[1] ? ring.slice(0, -1) : [...ring];
}

export function signedArea(ring: readonly Vec2[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i]!;
    const [x2, y2] = ring[(i + 1) % ring.length]!;
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

export function centroid(ring: readonly Vec2[]): Vec2 {
  const n = ring.length || 1;
  return ring.reduce<Vec2>((acc, p) => [acc[0] + p[0] / n, acc[1] + p[1] / n], [0, 0]);
}

export function isConvexRing(ring: readonly Vec2[]): boolean {
  let sign = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const c = ring[(i + 2) % ring.length]!;
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) < 1e-6) continue;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** Ориентированный описанный прямоугольник: перебираем направления сторон контура. */
export function orientedBox(ring: readonly Vec2[]): OrientedBox {
  let best: OrientedBox | undefined;
  let bestArea = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const edge = sub(ring[(i + 1) % ring.length]!, ring[i]!);
    const length = Math.hypot(edge[0], edge[1]);
    if (length < 1e-6) continue;
    const a: Vec2 = [edge[0] / length, edge[1] / length];
    const b: Vec2 = [-a[1], a[0]];
    let minA = Infinity;
    let maxA = -Infinity;
    let minB = Infinity;
    let maxB = -Infinity;
    for (const p of ring) {
      const pa = dot(p, a);
      const pb = dot(p, b);
      minA = Math.min(minA, pa);
      maxA = Math.max(maxA, pa);
      minB = Math.min(minB, pb);
      maxB = Math.max(maxB, pb);
    }
    const area = (maxA - minA) * (maxB - minB);
    if (area < bestArea) {
      bestArea = area;
      const center = add2(mul(a, (minA + maxA) / 2), mul(b, (minB + maxB) / 2));
      const halfA = (maxA - minA) / 2;
      const halfB = (maxB - minB) / 2;
      best = halfA >= halfB
        ? { center, u: a, v: b, halfU: halfA, halfV: halfB }
        : { center, u: b, v: [-b[1], b[0]], halfU: halfB, halfV: halfA };
    }
  }
  return best ?? { center: centroid(ring), u: [1, 0], v: [0, 1], halfU: 0, halfV: 0 };
}

/** Насколько контур «прямоугольный»: площадь / площадь описанного прямоугольника. */
export function rectangularity(ring: readonly Vec2[], box = orientedBox(ring)): number {
  const boxArea = 4 * box.halfU * box.halfV;
  return boxArea > 0 ? Math.abs(signedArea(ring)) / boxArea : 0;
}

/** Высота крыши по умолчанию для формы и размеров, м (~30° для скатов). */
export function defaultRoofHeight(shape: RoofShape, box: OrientedBox, area: number): number {
  const radius = Math.sqrt(area / Math.PI);
  switch (shape) {
    case 'flat':
      return 0;
    case 'dome':
      return Math.min(radius, 25);
    case 'onion':
      return Math.min(radius * 1.6, 30);
    case 'skillion':
      return Math.min(Math.max(box.halfV * 0.5, 1), 5);
    default:
      return Math.min(Math.max(box.halfV * Math.tan(Math.PI / 6), 1.5), 10);
  }
}

/**
 * Треугольники крыши над контуром (z = 0 — верх стен).
 * undefined — форму на этом контуре построить нельзя, крыша будет плоской.
 * Скатные крыши строятся над ориентированным прямоугольником и годятся для почти прямоугольных домов.
 */
export function roofTriangles(
  ringInput: readonly Vec2[],
  shape: RoofShape,
  height: number,
  orientation: 'along' | 'across' = 'along',
  /** Свес скатов за стены, м (только у прямоугольных двускатных и вальмовых крыш). */
  overhang = 0,
): Triangle[] | undefined {
  const ring = openRing(ringInput);
  if (shape === 'flat' || height <= 0 || ring.length < 3) return undefined;
  const box = orientedBox(ring);
  const rect = rectangularity(ring, box);
  const convex = isConvexRing(ring);

  let triangles: Triangle[];
  switch (shape) {
    case 'gabled':
    case 'hipped':
    case 'skillion': {
      if (rect < 0.8) {
        const fallback = convex ? pyramid(ring, height) : insetHip(ring, height);
        if (!fallback) return undefined;
        triangles = fallback;
        break;
      }
      if (shape === 'skillion') {
        triangles = skillion(box, height);
        break;
      }
      // Свес: скаты продолжаются за стены тем же уклоном, снизу — подшивка (смотрит вниз, не разворачиваем).
      const hipped = shape === 'hipped';
      const roof = pitched(box, height, hipped, orientation, overhang);
      return [...roof.map((t) => orientOutward(t, box.center)), ...soffit(box, height, hipped, orientation, overhang)];
    }
    case 'pyramidal': {
      const fallback = convex ? pyramid(ring, height) : rect >= 0.8 ? pitched(box, height, true, 'along') : insetHip(ring, height);
      if (!fallback) return undefined;
      triangles = fallback;
      break;
    }
    case 'dome':
    case 'onion': {
      const radius = Math.min(Math.sqrt(Math.abs(signedArea(ring)) / Math.PI), box.halfU);
      // Тело вращения уже собрано «лицом наружу» (у луковицы низ смотрит вниз-наружу — так и надо).
      return revolve(box.center, radius, height, shape === 'dome' ? DOME_PROFILE : ONION_PROFILE);
    }
    default:
      return undefined;
  }
  const center = box.center;
  return triangles.map((t) => orientOutward(t, center));
}

function corners(box: OrientedBox, across: boolean) {
  const a = across ? box.v : box.u;
  const b = across ? mul(box.u, -1) : box.v;
  const halfA = across ? box.halfV : box.halfU;
  const halfB = across ? box.halfU : box.halfV;
  const c = box.center;
  return {
    a,
    halfA,
    halfB,
    p1: add2(add2(c, mul(a, -halfA)), mul(b, -halfB)),
    p2: add2(add2(c, mul(a, halfA)), mul(b, -halfB)),
    p3: add2(add2(c, mul(a, halfA)), mul(b, halfB)),
    p4: add2(add2(c, mul(a, -halfA)), mul(b, halfB)),
  };
}

/** Свес вдоль конька у двускатной крыши меньше: фронтон лишь чуть выступает над торцом. */
const GABLE_OVERHANG_SHARE = 0.6;

/** Насколько опускается край ската со свесом, чтобы уклон не менялся. */
function eaveDrop(halfB: number, height: number, overhang: number): number {
  return halfB > 0 ? (height * overhang) / halfB : 0;
}

/** Двускатная (фронтоны на торцах) или вальмовая (четыре ската) крыша; со свесом — шире стен. */
function pitched(
  box: OrientedBox,
  height: number,
  hipped: boolean,
  orientation: 'along' | 'across',
  overhang = 0,
): Triangle[] {
  const base = corners(box, orientation === 'across');
  const oA = hipped ? overhang : overhang * GABLE_OVERHANG_SHARE;
  const drop = eaveDrop(base.halfB, height, overhang);
  const { a, halfA, halfB, p1, p2, p3, p4 } = corners(
    { ...box, halfU: box.halfU + (orientation === 'across' ? overhang : oA), halfV: box.halfV + (orientation === 'across' ? oA : overhang) },
    orientation === 'across',
  );
  const inset = hipped ? Math.min(halfB, halfA) : 0;
  const r1 = at(add2(box.center, mul(a, -(halfA - inset))), height);
  const r2 = at(add2(box.center, mul(a, halfA - inset)), height);
  const [q1, q2, q3, q4] = [at(p1, -drop), at(p2, -drop), at(p3, -drop), at(p4, -drop)];
  return [
    [q1, q2, r2],
    [q1, r2, r1],
    [q3, q4, r1],
    [q3, r1, r2],
    // торцы: фронтоны (вертикальные) у двускатной, скаты у вальмовой
    [q2, q3, r2],
    [q4, q1, r1],
  ];
}

/**
 * Подшивка свеса: горизонтальная «рамка» снизу между стенами и краем свеса, лицом вниз —
 * чтобы с улицы под свесом не просвечивало небо.
 */
function soffit(box: OrientedBox, height: number, hipped: boolean, orientation: 'along' | 'across', overhang: number): Triangle[] {
  if (overhang <= 0) return [];
  const { a, halfA, halfB } = corners(box, orientation === 'across');
  const b: Vec2 = [-a[1], a[0]];
  const oA = hipped ? overhang : overhang * GABLE_OVERHANG_SHARE;
  const z = -eaveDrop(halfB, height, overhang);
  const point = (sa: number, sb: number) => at(add2(box.center, add2(mul(a, sa), mul(b, sb))), z);
  // Прямоугольник [a0, a1] × [b0, b1] двумя треугольниками, лицом вниз.
  const quad = (a0: number, a1: number, b0: number, b1: number): Triangle[] => {
    const tris: Triangle[] = [
      [point(a0, b0), point(a1, b0), point(a1, b1)],
      [point(a0, b0), point(a1, b1), point(a0, b1)],
    ];
    return tris.map((t) => (triangleNormal(t)[2] > 0 ? [t[0], t[2], t[1]] : t));
  };
  const outerA = halfA + oA;
  const outerB = halfB + overhang;
  return [
    ...quad(-outerA, outerA, halfB, outerB),
    ...quad(-outerA, outerA, -outerB, -halfB),
    ...quad(halfA, outerA, -halfB, halfB),
    ...quad(-outerA, -halfA, -halfB, halfB),
  ];
}

/** Конёк и скаты прямоугольной крыши — для труб и слуховых окон. */
export interface RoofFrame {
  center: Vec2;
  /** Вдоль конька и поперёк (вниз по скату — ±b). */
  a: Vec2;
  b: Vec2;
  halfA: number;
  halfB: number;
  /** Половина длины конька (у вальмовой короче дома). */
  ridgeHalf: number;
  height: number;
  hipped: boolean;
}

/** Каркас крыши, если она строится по прямоугольнику (двускатная, вальмовая); иначе undefined. */
export function roofFrame(
  ringInput: readonly Vec2[],
  shape: RoofShape,
  height: number,
  orientation: 'along' | 'across' = 'along',
): RoofFrame | undefined {
  if (shape !== 'gabled' && shape !== 'hipped') return undefined;
  const ring = openRing(ringInput);
  if (ring.length < 3 || height <= 0) return undefined;
  const box = orientedBox(ring);
  if (rectangularity(ring, box) < 0.8) return undefined;
  const { a, halfA, halfB } = corners(box, orientation === 'across');
  const hipped = shape === 'hipped';
  return {
    center: box.center,
    a,
    b: [-a[1], a[0]],
    halfA,
    halfB,
    ridgeHalf: hipped ? halfA - Math.min(halfA, halfB) : halfA,
    height,
    hipped,
  };
}

/** Высота ската над верхом стен в точке (sa вдоль конька, sb поперёк). */
export function roofSurfaceZ(frame: RoofFrame, sa: number, sb: number): number {
  let z = frame.height * (1 - Math.abs(sb) / frame.halfB);
  if (frame.hipped && Math.abs(sa) > frame.ridgeHalf) {
    z = Math.min(z, frame.height * (1 - (Math.abs(sa) - frame.ridgeHalf) / frame.halfB));
  }
  return Math.max(z, 0);
}

/** Односкатная: низкий край с одной длинной стороны, высокий — с другой, торцы закрыты. */
function skillion(box: OrientedBox, height: number): Triangle[] {
  const { p1, p2, p3, p4 } = corners(box, false);
  const [l1, l2] = [at(p1, 0), at(p2, 0)];
  const [h3, h4] = [at(p3, height), at(p4, height)];
  const [b3, b4] = [at(p3, 0), at(p4, 0)];
  return [
    [l1, l2, h3],
    [l1, h3, h4],
    [l2, b3, h3],
    [b4, l1, h4],
    [b3, b4, h4],
    [b3, h4, h3],
  ];
}

/** Шатёр к центру выпуклого контура. */
function pyramid(ring: readonly Vec2[], height: number): Triangle[] {
  const apex = at(centroid(ring), height);
  return ring.map((p, i) => [at(p, 0), at(ring[(i + 1) % ring.length]!, 0), apex]);
}

/** Профиль купола: (доля радиуса, доля высоты) снизу вверх. */
const DOME_PROFILE: Vec2[] = Array.from({ length: 7 }, (_, i) => {
  const phi = (i / 6) * (Math.PI / 2);
  return [Math.cos(phi), Math.sin(phi)];
});
/** Луковица: расширяется, затем сходится к острию. */
const ONION_PROFILE: Vec2[] = [
  [0.85, 0],
  [1.12, 0.18],
  [1.1, 0.36],
  [0.82, 0.56],
  [0.45, 0.72],
  [0.16, 0.86],
  [0.04, 0.95],
  [0, 1],
];
const REVOLVE_SEGMENTS = 18;

/** Тело вращения по профилю: купола и луковицы. */
function revolve(center: Vec2, radius: number, height: number, profile: readonly Vec2[]): Triangle[] {
  const ring = (k: number) =>
    Array.from({ length: REVOLVE_SEGMENTS }, (_, s): Vec3 => {
      const angle = (s / REVOLVE_SEGMENTS) * Math.PI * 2;
      const [rf, zf] = profile[k]!;
      return [center[0] + Math.cos(angle) * radius * rf, center[1] + Math.sin(angle) * radius * rf, zf * height];
    });
  const triangles: Triangle[] = [];
  for (let k = 0; k < profile.length - 1; k++) {
    const lower = ring(k);
    const upper = ring(k + 1);
    for (let s = 0; s < REVOLVE_SEGMENTS; s++) {
      const n = (s + 1) % REVOLVE_SEGMENTS;
      triangles.push([lower[s]!, lower[n]!, upper[n]!]);
      if (profile[k + 1]![0] > 1e-6) triangles.push([lower[s]!, upper[n]!, upper[s]!]);
    }
  }
  return triangles;
}

/** Нормаль треугольника (по порядку вершин). */
/** Самый крутой скат «срезанной» вальмовой крыши: подъём на метр отступа (~42°). */
const INSET_MAX_SLOPE = 0.9;

/**
 * Вальмовая крыша со срезанным верхом для контуров любой формы (Г-, П-образные дома):
 * скаты от стен к контуру, отодвинутому внутрь на d, сверху — плоская площадка.
 * Отступ подбирается наибольший, при котором внутренний контур остаётся правильным.
 */
function insetHip(ringInput: readonly Vec2[], height: number): Triangle[] | undefined {
  const ring = signedArea(ringInput) < 0 ? [...ringInput].reverse() : [...ringInput];
  const area = signedArea(ring);
  let perimeter = 0;
  for (let i = 0; i < ring.length; i++) perimeter += Math.hypot(...sub(ring[(i + 1) % ring.length]!, ring[i]!));
  if (area <= 0 || perimeter <= 0) return undefined;

  // 2A/P — ширина «узкого места» для вытянутых частей контура; дальше — уменьшаем, пока не получится.
  for (let d = (2 * area) / perimeter; d >= 0.6; d *= 0.8) {
    const inner = insetRing(ring, d);
    if (!inner) continue;
    const cap = triangulate(inner);
    if (!cap) continue;
    const rise = Math.min(height, d * INSET_MAX_SLOPE);
    const triangles: Triangle[] = [];
    for (let i = 0; i < ring.length; i++) {
      const j = (i + 1) % ring.length;
      triangles.push([at(ring[i]!, 0), at(ring[j]!, 0), at(inner[j]!, rise)]);
      triangles.push([at(ring[i]!, 0), at(inner[j]!, rise), at(inner[i]!, rise)]);
    }
    for (const [a, b, c] of cap) triangles.push([at(inner[a]!, rise), at(inner[b]!, rise), at(inner[c]!, rise)]);
    return triangles;
  }
  return undefined;
}

/** Контур (против часовой), сдвинутый внутрь на d; undefined — если при таком сдвиге он «ломается». */
function insetRing(ring: readonly Vec2[], d: number): Vec2[] | undefined {
  const n = ring.length;
  const inwardNormal = (a: Vec2, b: Vec2): Vec2 => {
    const [dx, dy] = sub(b, a);
    const length = Math.hypot(dx, dy) || 1;
    return [-dy / length, dx / length];
  };
  const inner: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const prev = ring[(i + n - 1) % n]!;
    const point = ring[i]!;
    const next = ring[(i + 1) % n]!;
    const n1 = inwardNormal(prev, point);
    const n2 = inwardNormal(point, next);
    const bisector = add2(n1, n2);
    const cos = dot(bisector, n1);
    if (cos < 1e-3) return undefined;
    // Длина «усика» на острых углах ограничена, иначе вершина улетит за пределы дома.
    const scale = Math.min(d / cos, d * 4) / Math.hypot(...bisector);
    inner.push(add2(point, mul(bisector, scale)));
  }

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    // Сторона не схлопнулась и не перевернулась.
    if (dot(sub(inner[j]!, inner[i]!), sub(ring[j]!, ring[i]!)) <= 0) return undefined;
    // Вершина осталась внутри дома.
    if (!pointInside(inner[i]!, ring)) return undefined;
  }
  // Новый контур без самопересечений.
  for (let i = 0; i < n; i++) {
    for (let k = i + 2; k < n; k++) {
      if (i === 0 && k === n - 1) continue;
      if (segmentsCross(inner[i]!, inner[(i + 1) % n]!, inner[k]!, inner[(k + 1) % n]!)) return undefined;
    }
  }
  return signedArea(inner) > 0 ? inner : undefined;
}

function pointInside([x, y]: Vec2, ring: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const cross2 = (o: Vec2, a: Vec2, b: Vec2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

function segmentsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const d1 = cross2(c, d, a);
  const d2 = cross2(c, d, b);
  const d3 = cross2(a, b, c);
  const d4 = cross2(a, b, d);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** Триангуляция простого контура против часовой стрелки отсечением «ушей» (контуры маленькие). */
export function triangulate(ring: readonly Vec2[]): [number, number, number][] | undefined {
  const indices = ring.map((_, i) => i);
  const result: [number, number, number][] = [];
  let guard = ring.length * ring.length;
  while (indices.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let k = 0; k < indices.length; k++) {
      const ia = indices[(k + indices.length - 1) % indices.length]!;
      const ib = indices[k]!;
      const ic = indices[(k + 1) % indices.length]!;
      const [a, b, c] = [ring[ia]!, ring[ib]!, ring[ic]!];
      if (cross2(a, b, c) <= 1e-9) continue; // вогнутая вершина
      const blocked = indices.some(
        (ip) => ip !== ia && ip !== ib && ip !== ic && cross2(a, b, ring[ip]!) >= 0 && cross2(b, c, ring[ip]!) >= 0 && cross2(c, a, ring[ip]!) >= 0,
      );
      if (blocked) continue;
      result.push([ia, ib, ic]);
      indices.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) return undefined;
  }
  if (indices.length === 3) result.push([indices[0]!, indices[1]!, indices[2]!]);
  return result;
}

export function triangleNormal([a, b, c]: Triangle): Vec3 {
  const u: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
}

/** Разворачивает треугольник «лицом наружу»: скаты — вверх, вертикальные грани — от центра здания. */
function orientOutward(triangle: Triangle, center: Vec2): Triangle {
  const n = triangleNormal(triangle);
  const length = Math.hypot(n[0], n[1], n[2]) || 1;
  let outward: number;
  if (Math.abs(n[2]) / length > 0.05) {
    outward = n[2];
  } else {
    const mid: Vec2 = [(triangle[0][0] + triangle[1][0] + triangle[2][0]) / 3, (triangle[0][1] + triangle[1][1] + triangle[2][1]) / 3];
    outward = dot([n[0], n[1]], sub(mid, center));
  }
  return outward >= 0 ? triangle : [triangle[0], triangle[2], triangle[1]];
}
