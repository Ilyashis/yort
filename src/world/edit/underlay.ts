// Подложка — свой снимок сверху (с дрона, свой план участка), положенный на карту, чтобы обводить
// по нему дома и заборы. Здесь только геометрия: где лежит снимок и как перевести точку снимка
// в метры на карте и обратно. Ось y снимка смотрит вниз, ось y карты — на север.
//
// Два вида привязки:
//  • подобие (центр, масштаб, поворот) — по двум точкам или вручную;
//  • перспектива (гомография 3×3) — по четырём точкам или по координатам ортофото GeoTIFF:
//    снимает перспективу обычного кадра с дрона, и снимок ложится ровно по всему полю.

import type { Vec2 } from '../walk/localFrame';

/** Матрица 3×3 по строкам: пиксель снимка → локальные метры (в однородных координатах). */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

/** Подобие: центр (локальные метры), метров на пиксель, поворот (рад, против часовой). */
export interface SimilarityPlacement {
  center: Vec2;
  metresPerPixel: number;
  rotation: number;
}

/** Перспектива: гомография снимка; source — как получена (точки или координаты GeoTIFF). */
export interface ProjectivePlacement {
  homography: Mat3;
  source: 'points' | 'geotiff';
}

export type UnderlayPlacement = SimilarityPlacement | ProjectivePlacement;

export const isProjective = (p: UnderlayPlacement): p is ProjectivePlacement => 'homography' in p;

/** Размер снимка в пикселях. */
export type ImageSize = [width: number, height: number];

/** Пиксель снимка → локальные метры. */
export function imageToLocal([u, v]: Vec2, [w, h]: ImageSize, placement: UnderlayPlacement): Vec2 {
  if (isProjective(placement)) return applyH(placement.homography, [u, v]);
  const { center, metresPerPixel: s, rotation } = placement;
  const dx = (u - w / 2) * s;
  const dy = -(v - h / 2) * s;
  const c = Math.cos(rotation);
  const n = Math.sin(rotation);
  return [center[0] + dx * c - dy * n, center[1] + dx * n + dy * c];
}

/** Локальные метры → пиксель снимка. */
export function localToImage([x, y]: Vec2, [w, h]: ImageSize, placement: UnderlayPlacement): Vec2 {
  if (isProjective(placement)) {
    const inverse = invertH(placement.homography);
    return inverse ? applyH(inverse, [x, y]) : [Number.NaN, Number.NaN];
  }
  const { center, metresPerPixel: s, rotation } = placement;
  const dx = x - center[0];
  const dy = y - center[1];
  const c = Math.cos(-rotation);
  const n = Math.sin(-rotation);
  const rx = dx * c - dy * n;
  const ry = dx * n + dy * c;
  return [rx / s + w / 2, -ry / s + h / 2];
}

/** Углы снимка на карте (по часовой с левого верхнего). */
export function imageCorners(size: ImageSize, placement: UnderlayPlacement): Vec2[] {
  const [w, h] = size;
  return ([[0, 0], [w, 0], [w, h], [0, h]] as Vec2[]).map((p) => imageToLocal(p, size, placement));
}

/**
 * Матрица для canvas при подобии: пиксель снимка (u, v) → локальные метры, вида
 * x = a·u + c·v + e, y = b·u + d·v + f (как у CanvasRenderingContext2D.transform).
 */
export function imageMatrix([w, h]: ImageSize, { center, metresPerPixel: s, rotation }: SimilarityPlacement): [number, number, number, number, number, number] {
  const c = Math.cos(rotation);
  const n = Math.sin(rotation);
  const a = s * c;
  const b = s * n;
  const cc = s * n;
  const d = -s * c;
  return [a, b, cc, d, center[0] - a * (w / 2) - cc * (h / 2), center[1] - b * (w / 2) - d * (h / 2)];
}

/** Снимок по центру вида, шириной widthM метров, без поворота — дальше его подгоняют. */
export function initialPlacement(center: Vec2, [w]: ImageSize, widthM = 150): SimilarityPlacement {
  return { center, metresPerPixel: widthM / Math.max(w, 1), rotation: 0 };
}

/** Сдвиг подложки на delta метров (перетаскивание мышью). */
export function translatePlacement(placement: UnderlayPlacement, [dx, dy]: Vec2): UnderlayPlacement {
  if (!isProjective(placement)) return { ...placement, center: [placement.center[0] + dx, placement.center[1] + dy] };
  const h = placement.homography;
  // T·H: к результату прибавляется сдвиг, умноженный на w (третья строка).
  return {
    ...placement,
    homography: [h[0] + dx * h[6], h[1] + dx * h[7], h[2] + dx * h[8], h[3] + dy * h[6], h[4] + dy * h[7], h[5] + dy * h[8], h[6], h[7], h[8]],
  };
}

/**
 * Совмещение по двум точкам: точки снимка imageA, imageB (пиксели) должны лечь в точки карты
 * mapA, mapB (метры). Масштаб, поворот и сдвиг подбираются точно (подобие).
 * undefined — если точки совпадают (совместить нельзя).
 */
export function fitTwoPoints(imageA: Vec2, imageB: Vec2, mapA: Vec2, mapB: Vec2, size: ImageSize): SimilarityPlacement | undefined {
  // Вектор на снимке — в «метрическом» направлении (y вверх), как в imageToLocal.
  const di: Vec2 = [imageB[0] - imageA[0], -(imageB[1] - imageA[1])];
  const dm: Vec2 = [mapB[0] - mapA[0], mapB[1] - mapA[1]];
  const li = Math.hypot(di[0], di[1]);
  const lm = Math.hypot(dm[0], dm[1]);
  if (li < 1e-6 || lm < 1e-6) return undefined;
  const metresPerPixel = lm / li;
  const rotation = Math.atan2(dm[1], dm[0]) - Math.atan2(di[1], di[0]);
  // Центр: такой, чтобы imageA легла в mapA.
  const probe = imageToLocal(imageA, size, { center: [0, 0], metresPerPixel, rotation });
  return { center: [mapA[0] - probe[0], mapA[1] - probe[1]], metresPerPixel, rotation };
}

/**
 * Совмещение с перспективой по четырём и более точкам: гомография, переводящая точки снимка
 * в точки карты (при четырёх — точно, при большем числе — по методу наименьших квадратов).
 * undefined — если точки вырождены (три на одной прямой и т. п.) или снимок «выворачивается».
 */
export function fitPerspective(images: readonly Vec2[], maps: readonly Vec2[], source: ProjectivePlacement['source'] = 'points'): ProjectivePlacement | undefined {
  const homography = homographyFit(images, maps);
  if (!homography) return undefined;
  // Снимок не должен уходить «за горизонт»: знаменатель одного знака во всех точках.
  const w = images.map(([u, v]) => homography[6] * u + homography[7] * v + homography[8]);
  if (!w.every((x) => x > 0) && !w.every((x) => x < 0)) return undefined;
  return { homography, source };
}

// --- гомография ---------------------------------------------------------------

export function applyH(h: Mat3, [x, y]: Vec2): Vec2 {
  const w = h[6] * x + h[7] * y + h[8];
  return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
}

export function invertH(h: Mat3): Mat3 | undefined {
  const [a, b, c, d, e, f, g, i, k] = h;
  const A = e * k - f * i;
  const B = -(d * k - f * g);
  const C = d * i - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-18) return undefined;
  return [
    A / det, -(b * k - c * i) / det, (b * f - c * e) / det,
    B / det, (a * k - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * i - b * g) / det, (a * e - b * d) / det,
  ];
}

function multiply(x: Mat3, y: Mat3): Mat3 {
  const r = new Array<number>(9).fill(0);
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) for (let k = 0; k < 3; k++) r[row * 3 + col]! += x[row * 3 + k]! * y[k * 3 + col]!;
  return r as Mat3;
}

/** Нормализация Хартли: центр в нуле, среднее расстояние √2 — без неё система плохо обусловлена. */
function normalizer(points: readonly Vec2[]): Mat3 {
  const n = points.length;
  const cx = points.reduce((s, p) => s + p[0], 0) / n;
  const cy = points.reduce((s, p) => s + p[1], 0) / n;
  const mean = points.reduce((s, p) => s + Math.hypot(p[0] - cx, p[1] - cy), 0) / n || 1;
  const s = Math.SQRT2 / mean;
  return [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1];
}

/** Гомография src → dst по 4+ парам точек (DLT, h33 = 1, нормальные уравнения). */
export function homographyFit(src: readonly Vec2[], dst: readonly Vec2[]): Mat3 | undefined {
  if (src.length < 4 || src.length !== dst.length) return undefined;
  const ts = normalizer(src);
  const td = normalizer(dst);
  const s = src.map((p) => applyH(ts, p));
  const d = dst.map((p) => applyH(td, p));
  // Каждая пара даёт два уравнения на 8 неизвестных h0..h7 (h8 = 1).
  const ata = Array.from({ length: 8 }, () => new Array<number>(8).fill(0));
  const atb = new Array<number>(8).fill(0);
  const add = (row: number[], rhs: number) => {
    for (let i = 0; i < 8; i++) {
      atb[i]! += row[i]! * rhs;
      for (let j = 0; j < 8; j++) ata[i]![j]! += row[i]! * row[j]!;
    }
  };
  s.forEach(([x, y], i) => {
    const [u, v] = d[i]!;
    add([x, y, 1, 0, 0, 0, -u * x, -u * y], u);
    add([0, 0, 0, x, y, 1, -v * x, -v * y], v);
  });
  const solution = solve(ata, atb);
  if (!solution) return undefined;
  const hn = [...solution, 1] as Mat3;
  const tdInverse = invertH(td);
  if (!tdInverse) return undefined;
  const h = multiply(multiply(tdInverse, hn), ts);
  // Масштаб значения не имеет — приводим к h33 = 1 для удобства.
  const scale = h[8] || 1;
  return h.map((x) => x / scale) as Mat3;
}

/** Метод Гаусса с выбором главного элемента. */
function solve(a: number[][], b: number[]): number[] | undefined {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    if (Math.abs(m[pivot]![col]!) < 1e-12) return undefined;
    [m[col], m[pivot]] = [m[pivot]!, m[col]!];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = m[r]![col]! / m[col]![col]!;
      for (let k = col; k <= n; k++) m[r]![k]! -= factor * m[col]![k]!;
    }
  }
  return m.map((row, i) => row[n]! / row[i]!);
}
