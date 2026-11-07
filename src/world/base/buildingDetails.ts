// Детали фасадов в локальных метрах: балконы и подъезды с козырьками. Чистые функции.

import type { Vec2 } from '../walk/localFrame';
import { openRing, signedArea, type Vec3 } from './roofGeometry';

/** Коробка детали: center (z — от земли), size = [вдоль стены, наружу от стены, высота], angle — направление стены. */
export interface DetailBox {
  center: Vec3;
  size: Vec3;
  /** Угол направления стены от оси x (восток), рад, против часовой. */
  angle: number;
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
