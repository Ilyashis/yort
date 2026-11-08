// Детали зданий в локальных метрах: балконы, подъезды, трубы, слуховые окна, будки на крышах.
// Чистые функции.

import { distanceToRing, pointInRing, type Vec2 } from '../walk/localFrame';
import { openRing, orientedBox, roofSurfaceZ, signedArea, type RoofFrame, type Vec3 } from './roofGeometry';

/** Коробка детали: center (z — от земли), size = [вдоль стены, наружу от стены, высота], angle — направление стены. */
export interface DetailBox {
  center: Vec3;
  size: Vec3;
  /** Угол направления стены от оси x (восток), рад, против часовой. */
  angle: number;
  /** Наклон вокруг своей оси «наружу», рад: ромб под 45° даёт двускатную крышу-призму. */
  tilt?: number;
}

export interface FacadeEdge {
  a: Vec2;
  b: Vec2;
  length: number;
  /** Единичный вектор вдоль стены. */
  dir: Vec2;
  /** Единичная нормаль наружу. */
  normal: Vec2;
}

/** Стены контура с нормалями наружу (с учётом направления обхода). */
export function facadeEdges(ringInput: readonly Vec2[]): FacadeEdge[] {
  const ring = openRing(ringInput);
  const ccw = signedArea(ring) > 0;
  const edges: FacadeEdge[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length < 1e-6) continue;
    const dir: Vec2 = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
    // Для обхода против часовой стрелки «наружу» — вправо от направления стены.
    const normal: Vec2 = ccw ? [dir[1], -dir[0]] : [-dir[1], dir[0]];
    edges.push({ a, b, length, dir, normal });
  }
  return edges;
}

export interface BalconyOptions {
  floors: number;
  floorHeight: number;
  /** Шаг балконов вдоль стены, м. */
  bay: number;
  /** Самая короткая стена, на которой бывают балконы, м. */
  minEdge: number;
  /** Не больше стольких балконов на дом (страховка от огромных контуров). */
  maxPerBuilding: number;
}

const BALCONY = { width: 2.5, depth: 1.1, height: 1.05 };

/**
 * Балконы «стояками» на двух длинных противоположных стенах (улица и двор),
 * со второго этажа и выше. Остеклённые лоджии — одна коробка на балкон.
 */
export function balconies(ring: readonly Vec2[], options: BalconyOptions): DetailBox[] {
  const edges = facadeEdges(ring).sort((x, y) => y.length - x.length);
  const main = edges[0];
  if (!main || main.length < options.minEdge || options.floors < 3) return [];
  const opposite = edges
    .slice(1)
    .filter((e) => e.length >= options.minEdge)
    .sort((x, y) => dot(x.dir, main.dir) - dot(y.dir, main.dir))[0];
  const walls = opposite && dot(opposite.dir, main.dir) < -0.8 ? [main, opposite] : [main];

  const boxes: DetailBox[] = [];
  for (const wall of walls) {
    const count = Math.floor((wall.length - 2) / options.bay);
    if (count < 1) continue;
    const start = (wall.length - (count - 1) * options.bay) / 2;
    const angle = Math.atan2(wall.dir[1], wall.dir[0]);
    for (let k = 0; k < count; k++) {
      const along = start + k * options.bay;
      const x = wall.a[0] + wall.dir[0] * along + wall.normal[0] * (BALCONY.depth / 2);
      const y = wall.a[1] + wall.dir[1] * along + wall.normal[1] * (BALCONY.depth / 2);
      for (let floor = 1; floor < options.floors; floor++) {
        if (boxes.length >= options.maxPerBuilding) return boxes;
        boxes.push({
          center: [x, y, floor * options.floorHeight + BALCONY.height / 2],
          size: [BALCONY.width, BALCONY.depth, BALCONY.height],
          angle,
        });
      }
    }
  }
  return boxes;
}

export interface Entrances {
  doors: DetailBox[];
  canopies: DetailBox[];
}

/**
 * Подъезды на самой длинной стене, которая не выходит на улицу (во двор):
 * дверь и козырёк над ней каждые spacing метров.
 */
export function entrances(
  ring: readonly Vec2[],
  isStreetSide: (point: Vec2) => boolean,
  spacing = 18,
  doorWidth = 1.4,
): Entrances {
  const wall = facadeEdges(ring)
    .filter((e) => e.length >= 8)
    .filter((e) => !isStreetSide([(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2]))
    .sort((x, y) => y.length - x.length)[0];
  const result: Entrances = { doors: [], canopies: [] };
  if (!wall) return result;

  const count = Math.max(1, Math.floor(wall.length / spacing));
  const step = wall.length / count;
  const angle = Math.atan2(wall.dir[1], wall.dir[0]);
  for (let k = 0; k < count; k++) {
    const along = step * (k + 0.5);
    const px = wall.a[0] + wall.dir[0] * along;
    const py = wall.a[1] + wall.dir[1] * along;
    result.doors.push({
      center: [px + wall.normal[0] * 0.08, py + wall.normal[1] * 0.08, 1.15],
      size: [doorWidth, 0.16, 2.3],
      angle,
    });
    result.canopies.push({
      center: [px + wall.normal[0] * 0.65, py + wall.normal[1] * 0.65, 2.55],
      size: [doorWidth + 0.9, 1.3, 0.12],
      angle,
    });
  }
  return result;
}

const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];

/**
 * Печные трубы на скатной крыше (z — от верха стен): в деревне одна, у больших домов до трёх
 * вдоль конька. Чуть в стороне от конька и выше него, низ утоплен в скат.
 */
export function chimneys(frame: RoofFrame, seed: number, village: boolean): DetailBox[] {
  const count = village ? 1 : Math.min(3, Math.max(1, Math.round((frame.ridgeHalf * 2) / 9)));
  const angle = Math.atan2(frame.a[1], frame.a[0]);
  const side = (seed >> 3) % 2 ? 1 : -1;
  const sb = 0.6 * side;
  const [w, d] = village ? [0.55, 0.55] : [0.7, 0.9];
  const result: DetailBox[] = [];
  for (let k = 0; k < count; k++) {
    const sa =
      count === 1
        ? (seed % 2 ? 1 : -1) * frame.ridgeHalf * 0.4
        : -frame.ridgeHalf * 0.7 + (k * 1.4 * frame.ridgeHalf) / (count - 1);
    const bottom = roofSurfaceZ(frame, sa, sb) - 0.3;
    const top = frame.height + (village ? 0.7 : 0.9);
    const [x, y] = onRoof(frame, sa, sb);
    result.push({ center: [x, y, (top + bottom) / 2], size: [w, d, top - bottom], angle });
  }
  return result;
}

export interface Dormers {
  bodies: DetailBox[];
  roofs: DetailBox[];
  /** Стекло на лицевой стороне (вниз по скату). */
  windows: DetailBox[];
}

const DORMER = { width: 1.3, depth: 1.8, height: 1.5, roof: 1.7, spacing: 5.5 };

/**
 * Слуховые окна на длинных скатах больших крыш: коробка с окном и двускатная крышечка
 * (ромб, повёрнутый на 45°). Стоят на середине ската, через 5–6 м, не заходя на вальмы.
 */
export function dormers(frame: RoofFrame): Dormers {
  const result: Dormers = { bodies: [], roofs: [], windows: [] };
  if (frame.halfA < 7 || frame.halfB < 4.5 || frame.height < 2.2) return result;
  const limit = frame.hipped ? frame.ridgeHalf + frame.halfB * 0.5 - 1.5 : frame.halfA - 1.5;
  const count = Math.floor((2 * limit) / DORMER.spacing);
  if (count < 1) return result;
  const angle = Math.atan2(frame.a[1], frame.a[0]);
  const s = DORMER.roof / Math.SQRT2;
  for (const side of [1, -1]) {
    const sb = side * frame.halfB * 0.5;
    for (let k = 0; k < count; k++) {
      const sa = (k - (count - 1) / 2) * DORMER.spacing;
      // Низ по переднему краю (ниже по скату), задняя часть утоплена в скат.
      const bottom = roofSurfaceZ(frame, sa, Math.abs(sb) + DORMER.depth / 2) - 0.1;
      const [x, y] = onRoof(frame, sa, sb);
      result.bodies.push({
        center: [x, y, bottom + DORMER.height / 2],
        size: [DORMER.width, DORMER.depth, DORMER.height],
        angle,
      });
      result.roofs.push({
        center: [x, y, bottom + DORMER.height],
        size: [s, DORMER.depth + 0.25, s],
        angle,
        tilt: Math.PI / 4,
      });
      const [wx, wy] = onRoof(frame, sa, sb + side * (DORMER.depth / 2 + 0.02));
      result.windows.push({ center: [wx, wy, bottom + 0.8], size: [0.75, 0.06, 0.85], angle });
    }
  }
  return result;
}

/**
 * Будки на плоских крышах высоких домов — машинные помещения лифтов и выходы на крышу (z — от верха стен):
 * по одной на «секцию» ~28 м вдоль дома, только там, где до края крыши не меньше 2,5 м.
 */
export function rooftopBoxes(ringInput: readonly Vec2[]): DetailBox[] {
  const ring = openRing(ringInput);
  const box = orientedBox(ring);
  const count = Math.min(4, Math.max(1, Math.round((2 * box.halfU) / 28)));
  const angle = Math.atan2(box.u[1], box.u[0]);
  const result: DetailBox[] = [];
  const closed = [...ring, ring[0]!];
  for (let k = 0; k < count; k++) {
    const sa = (k - (count - 1) / 2) * ((2 * box.halfU) / count);
    const p: Vec2 = [box.center[0] + box.u[0] * sa, box.center[1] + box.u[1] * sa];
    if (!pointInRing(p, closed) || distanceToRing(p, closed) < 2.5) continue;
    result.push({ center: [p[0], p[1], 1.15], size: [3.2, 2.6, 2.3], angle });
  }
  return result;
}

function onRoof(frame: RoofFrame, sa: number, sb: number): Vec2 {
  return [
    frame.center[0] + frame.a[0] * sa + frame.b[0] * sb,
    frame.center[1] + frame.a[1] * sa + frame.b[1] * sb,
  ];
}

/** Цвета заборов: некрашеные доски, серый штакетник, крашеные зелёным и синим, охра, морёное дерево. */
export const FENCE_COLOR_HEX = ['#8a6a48', '#857f73', '#5f7f4f', '#5b7b97', '#a8874f', '#7a5a3e'];

/** Забор: доски кусками не длиннее 5 м (каждый — на своей высоте земли) и столбы. */
export const FENCE = { street: 1.45, other: 1.3, thickness: 0.07, piece: 5, postEvery: 2.5, post: 0.12, postHeight: 1.7 };

export interface FenceBoxes {
  pieces: DetailBox[];
  posts: DetailBox[];
}

/** Коробки забора вдоль отрезка p→q (z — от земли в центре коробки); posts — со столбами. */
export function fenceBoxes(p: Vec2, q: Vec2, height: number, posts: boolean): FenceBoxes {
  const result: FenceBoxes = { pieces: [], posts: [] };
  const length = Math.hypot(q[0] - p[0], q[1] - p[1]);
  if (length < 0.3) return result;
  const dir: Vec2 = [(q[0] - p[0]) / length, (q[1] - p[1]) / length];
  const angle = Math.atan2(dir[1], dir[0]);
  const count = Math.ceil(length / FENCE.piece);
  for (let k = 0; k < count; k++) {
    const mid = (length * (k + 0.5)) / count;
    // Низ утоплен на 0,2 м — на склоне забор не повисает над землёй.
    result.pieces.push({
      center: [p[0] + dir[0] * mid, p[1] + dir[1] * mid, height / 2 - 0.1],
      size: [length / count, FENCE.thickness, height + 0.2],
      angle,
    });
  }
  if (posts) {
    for (let t = 0; t <= length + 1e-6; t += FENCE.postEvery) {
      result.posts.push({
        center: [p[0] + dir[0] * t, p[1] + dir[1] * t, FENCE.postHeight / 2 - 0.1],
        size: [FENCE.post, FENCE.post, FENCE.postHeight + 0.2],
        angle,
      });
    }
  }
  return result;
}
