// Уличные объекты из осей дорог OSM: фонари, скамейки, разметка, зебры.
// Чистые функции в локальных метрах — легко тестировать.

import type { LonLat } from '../user/plot';
import { distanceToPolygon, insidePolygon, type LocalFrame, type LocalPolygon, type Vec2 } from '../walk/localFrame';
import type { GroundFeature } from './environment';

export interface RoadAxis {
  highway: string;
  /** Ширина проезжей части, м. */
  width: number;
  name?: string;
  oneway?: boolean;
  lanes?: number;
  coords: LonLat[];
}

export interface PathAxis {
  highway: string;
  width: number;
  coords: LonLat[];
}

export interface StreetsData {
  roads: RoadAxis[];
  paths: PathAxis[];
  crossings: LonLat[][];
  lamps: LonLat[];
  benches: LonLat[];
}

export const EMPTY_STREETS: StreetsData = { roads: [], paths: [], crossings: [], lamps: [], benches: [] };

/** Объект на улице: точка и направление (рад, от севера по часовой). */
export interface Placed {
  position: LonLat;
  heading: number;
}

/** Улицы, вдоль которых ставим фонари. */
const LAMP_ROADS = new Set([
  'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street',
  'primary_link', 'secondary_link', 'tertiary_link', 'trunk', 'trunk_link',
]);

const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
const scale = (a: Vec2, k: number): Vec2 => [a[0] * k, a[1] * k];
const length = (a: Vec2) => Math.hypot(a[0], a[1]);
/** Направление вектора как heading: 0 — север, по часовой. */
const headingOf = ([x, y]: Vec2) => Math.atan2(x, y);

/** Точки через равные промежутки вдоль ломаной (с направлением в каждой). */
export function sampleAlong(line: readonly Vec2[], spacing: number, start = 0): { point: Vec2; dir: Vec2 }[] {
  const result: { point: Vec2; dir: Vec2 }[] = [];
  let next = start;
  let travelled = 0;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!;
    const segment = sub(line[i]!, a);
    const segmentLength = length(segment);
    if (segmentLength === 0) continue;
    const dir = scale(segment, 1 / segmentLength);
    while (next <= travelled + segmentLength) {
      result.push({ point: add(a, scale(dir, next - travelled)), dir });
      next += spacing;
    }
    travelled += segmentLength;
  }
  return result;
}

const inBox = ([x, y]: Vec2, p: LocalPolygon, margin = 0) =>
  x >= p.minX - margin && x <= p.maxX + margin && y >= p.minY - margin && y <= p.maxY + margin;

export interface LampOptions {
  spacing: number;
  /** С обеих сторон улицы (город) или с одной (деревня). */
  bothSides: boolean;
  /** Отступ от края проезжей части, м. */
  curbOffset: number;
  /**
   * Не ставить ближе этого расстояния к другому фонарю (перекрёстки, дубли осей), м.
   * Меньше ширины обычной улицы с тротуарами, иначе пропадёт противоположная сторона.
   */
  minGap: number;
}

const LAMP_DEFAULTS: LampOptions = { spacing: 32, bothSides: true, curbOffset: 0.8, minGap: 8 };

/**
 * Фонари по обеим сторонам улиц: не на проезжей части других дорог (перекрёстки),
 * не в зданиях и не слишком близко друг к другу. Плюс фонари, отмеченные в OSM.
 * heading — куда смотрит консоль с лампой (к оси дороги).
 */
export function placeLamps(
  streets: StreetsData,
  frame: LocalFrame,
  roadSurfaces: readonly LocalPolygon[],
  buildings: readonly LocalPolygon[],
  options: Partial<LampOptions> = {},
): Placed[] {
  const opts = { ...LAMP_DEFAULTS, ...options };
  const placed: Vec2[] = streets.lamps.map(frame.toLocal);
  const result: Placed[] = streets.lamps.map((position) => ({ position, heading: 0 }));

  for (const road of streets.roads) {
    if (!LAMP_ROADS.has(road.highway)) continue;
    const line = road.coords.map(frame.toLocal);
    for (const { point, dir } of sampleAlong(line, opts.spacing, opts.spacing / 2)) {
      const left: Vec2 = [-dir[1], dir[0]];
      for (const side of opts.bothSides ? [1, -1] : [1]) {
        const normal = scale(left, side);
        const lamp = add(point, scale(normal, road.width / 2 + opts.curbOffset));
        if (roadSurfaces.some((p) => inBox(lamp, p) && insidePolygon(lamp, p))) continue;
        if (buildings.some((p) => inBox(lamp, p, 1) && distanceToPolygon(lamp, p) < 1)) continue;
        if (placed.some((q) => length(sub(q, lamp)) < opts.minGap)) continue;
        placed.push(lamp);
        result.push({ position: frame.toLonLat(lamp), heading: headingOf(scale(normal, -1)) });
      }
    }
  }
  return result;
}

/** Скамейки из OSM, развёрнутые вдоль ближайшей дорожки (в OSM направления нет). */
export function orientBenches(streets: StreetsData, frame: LocalFrame, maxDistance = 15): Placed[] {
  const segments = streets.paths.flatMap((path) => {
    const line = path.coords.map(frame.toLocal);
    return line.slice(1).map((b, i) => [line[i]!, b] as [Vec2, Vec2]);
  });
  return streets.benches.map((position) => {
    const p = frame.toLocal(position);
    let best: { distance: number; dir: Vec2 } | undefined;
    for (const [a, b] of segments) {
      const ab = sub(b, a);
      const lengthSq = ab[0] ** 2 + ab[1] ** 2;
      if (lengthSq === 0) continue;
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / lengthSq));
      const distance = length(sub(p, add(a, scale(ab, t))));
      if (distance < maxDistance && (!best || distance < best.distance)) best = { distance, dir: ab };
    }
    return { position, heading: best ? headingOf(best.dir) : 0 };
  });
}

/** Прямоугольник: от точки start вдоль dir на along метров, шириной across. */
function rectangle(start: Vec2, dir: Vec2, along: number, across: number, frame: LocalFrame): LonLat[] {
  const half = scale([-dir[1], dir[0]], across / 2);
  const end = add(start, scale(dir, along));
  const corners = [sub(start, half), sub(end, half), add(end, half), add(start, half)];
  const ring = corners.map(frame.toLonLat);
  return [...ring, ring[0]!];
}

const marking = (ring: LonLat[]): GroundFeature => ({
  type: 'Feature',
  properties: { kind: 'marking' },
  geometry: { type: 'Polygon', coordinates: [ring] },
});

export interface MarkingOptions {
  /** Осевую рисуем на дорогах не уже этого, м. */
  minWidth: number;
  dash: number;
  gap: number;
  lineWidth: number;
  /** Зебра: ширина полосы, промежуток, длина полосы, м. */
  stripe: number;
  stripeGap: number;
  stripeLength: number;
}

const MARKING_DEFAULTS: MarkingOptions = {
  minWidth: 9,
  dash: 3,
  gap: 6,
  lineWidth: 0.15,
  stripe: 0.5,
  stripeGap: 0.6,
  stripeLength: 3,
};

/**
 * Разметка: прерывистая осевая на широких двусторонних улицах
 * и зебры на переходах (только полосы, попавшие на проезжую часть).
 */
export function roadMarkings(
  streets: StreetsData,
  frame: LocalFrame,
  roadSurfaces: readonly LocalPolygon[],
  options: Partial<MarkingOptions> = {},
): GroundFeature[] {
  const opts = { ...MARKING_DEFAULTS, ...options };
  const result: GroundFeature[] = [];

  for (const road of streets.roads) {
    if (road.oneway || road.width < opts.minWidth) continue;
    const line = road.coords.map(frame.toLocal);
    for (const { point, dir } of sampleAlong(line, opts.dash + opts.gap, opts.gap / 2)) {
      result.push(marking(rectangle(point, dir, opts.dash, opts.lineWidth, frame)));
    }
  }

  for (const crossing of streets.crossings) {
    const line = crossing.map(frame.toLocal);
    for (const { point, dir } of sampleAlong(line, opts.stripe + opts.stripeGap, opts.stripeGap / 2)) {
      const center = add(point, scale(dir, opts.stripe / 2));
      if (!roadSurfaces.some((p) => inBox(center, p) && insidePolygon(center, p))) continue;
      result.push(marking(rectangle(point, dir, opts.stripe, opts.stripeLength, frame)));
    }
  }
  return result;
}
