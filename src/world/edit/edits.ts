// Правки пользователя поверх Base World: добавленные, изменённые и убранные дома, дороги, заборы.
// Данные OSM не меняются — правки хранятся отдельно и накладываются при отрисовке.
// Здесь только чистые функции: модель, геометрия инструментов, упрощение линий.

import type { BaseBuildingFeature } from '../base/types';
import type { Vec2 } from '../walk/localFrame';
import { distanceToSegment } from '../walk/localFrame';
import { openRing, orientedBox, signedArea } from '../base/roofGeometry';

export type LonLat = [number, number];

/** Пресеты домов в редакторе (тип OSM, стиль фасада и крыши по умолчанию). */
export type EditBuildingKind = 'house' | 'apartments' | 'shop' | 'shed';
export type EditRoof = 'flat' | 'gabled' | 'hipped';
export type EditRoadKind = 'street' | 'lane' | 'track' | 'path';

export interface EditedBuilding {
  id: string;
  /** id здания OSM, которое заменяет эта правка (сдвинутое, перестроенное). */
  source?: string;
  kind: EditBuildingKind;
  /** Контур в lon/lat, без замыкающей точки. */
  footprint: LonLat[];
  floors: number;
  roof: EditRoof;
  facadeColor: string;
  roofColor: string;
}

export interface EditedRoad {
  id: string;
  kind: EditRoadKind;
  /** Ось дороги в lon/lat. */
  axis: LonLat[];
}

export interface EditedFence {
  id: string;
  line: LonLat[];
}

export interface Edits {
  buildings: EditedBuilding[];
  /** Убранные здания OSM (по id), в том числе заменённые правкой. */
  removedBuildings: string[];
  roads: EditedRoad[];
  /** Убранные дороги OSM (по ключу полигона проезжей части). */
  removedRoads: string[];
  fences: EditedFence[];
  /** Дворы (по id дома), чьи заборы убраны. */
  removedYards: string[];
}

export const EMPTY_EDITS: Edits = {
  buildings: [],
  removedBuildings: [],
  roads: [],
  removedRoads: [],
  fences: [],
  removedYards: [],
};

export const ROAD_KINDS: Record<EditRoadKind, { label: string; width: number }> = {
  street: { label: 'Улица', width: 7 },
  lane: { label: 'Переулок', width: 4.5 },
  track: { label: 'Просёлок', width: 3.5 },
  path: { label: 'Тропинка', width: 1.8 },
};

export const BUILDING_KINDS: Record<EditBuildingKind, { label: string; osm: string; floors: number; roof: EditRoof }> = {
  house: { label: 'Дом', osm: 'house', floors: 1, roof: 'gabled' },
  apartments: { label: 'Многоэтажка', osm: 'apartments', floors: 5, roof: 'flat' },
  shop: { label: 'Магазин', osm: 'retail', floors: 1, roof: 'flat' },
  shed: { label: 'Сарай, баня', osm: 'shed', floors: 1, roof: 'gabled' },
};

export const FACADE_COLORS = ['#e6dcc4', '#c4ad86', '#8a6a4a', '#7fa2b6', '#9fb48e', '#dcd7cb', '#b0644b', '#cdb874', '#f1e7d3'];
export const ROOF_COLORS = ['#3f6b4f', '#3d5f7f', '#843a2f', '#b0533a', '#6b7176', '#5b4636'];

/** Высота этажа и стен для отрисовки правок, м. */
export const EDIT_FLOOR_HEIGHT = 3.2;
export const SHED_WALL_HEIGHT = 2.6;

// --- операции над правками (неизменяемые) ------------------------------------------

export function upsertBuilding(edits: Edits, building: EditedBuilding): Edits {
  const others = edits.buildings.filter((b) => b.id !== building.id);
  const removed =
    building.source && !edits.removedBuildings.includes(building.source)
      ? [...edits.removedBuildings, building.source]
      : edits.removedBuildings;
  return { ...edits, buildings: [...others, building], removedBuildings: removed };
}

/** Убрать дом: свой — удаляется, дом OSM — скрывается (и его двор тоже). */
export function removeBuilding(edits: Edits, id: string): Edits {
  const own = edits.buildings.find((b) => b.id === id);
  if (own) {
    // Заменённый дом OSM остаётся скрытым: убрали — значит, убрали совсем.
    return { ...edits, buildings: edits.buildings.filter((b) => b.id !== id) };
  }
  return edits.removedBuildings.includes(id) ? edits : { ...edits, removedBuildings: [...edits.removedBuildings, id] };
}

export function upsertRoad(edits: Edits, road: EditedRoad): Edits {
  return { ...edits, roads: [...edits.roads.filter((r) => r.id !== road.id), road] };
}

export function removeRoad(edits: Edits, id: string): Edits {
  if (edits.roads.some((r) => r.id === id)) return { ...edits, roads: edits.roads.filter((r) => r.id !== id) };
  return edits.removedRoads.includes(id) ? edits : { ...edits, removedRoads: [...edits.removedRoads, id] };
}

export function addFence(edits: Edits, fence: EditedFence): Edits {
  return { ...edits, fences: [...edits.fences, fence] };
}

export function removeFence(edits: Edits, id: string): Edits {
  if (edits.fences.some((f) => f.id === id)) return { ...edits, fences: edits.fences.filter((f) => f.id !== id) };
  return edits.removedYards.includes(id) ? edits : { ...edits, removedYards: [...edits.removedYards, id] };
}

export function isEmpty(edits: Edits): boolean {
  return (
    !edits.buildings.length &&
    !edits.removedBuildings.length &&
    !edits.roads.length &&
    !edits.removedRoads.length &&
    !edits.fences.length &&
    !edits.removedYards.length
  );
}

/** Правки из файла: проверяем форму, лишнее отбрасываем. */
export function parseEdits(value: unknown): Edits | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Partial<Edits>;
  const arr = <T>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);
  const strings = (x: unknown) => arr<unknown>(x).filter((s): s is string => typeof s === 'string');
  const points = (x: unknown) =>
    arr<unknown>(x).filter(
      (p): p is LonLat => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number' && Number.isFinite(n)),
    );
  return {
    buildings: arr<EditedBuilding>(v.buildings)
      .filter((b) => b && typeof b.id === 'string' && b.kind in BUILDING_KINDS)
      .map((b) => ({ ...b, footprint: points(b.footprint), floors: clampFloors(Number(b.floors) || 1) }))
      .filter((b) => b.footprint.length >= 3),
    removedBuildings: strings(v.removedBuildings),
    roads: arr<EditedRoad>(v.roads)
      .filter((r) => r && typeof r.id === 'string' && r.kind in ROAD_KINDS)
      .map((r) => ({ ...r, axis: points(r.axis) }))
      .filter((r) => r.axis.length >= 2),
    removedRoads: strings(v.removedRoads),
    fences: arr<EditedFence>(v.fences)
      .filter((f) => f && typeof f.id === 'string')
      .map((f) => ({ ...f, line: points(f.line) }))
      .filter((f) => f.line.length >= 2),
    removedYards: strings(v.removedYards),
  };
}

export const clampFloors = (floors: number) => Math.min(Math.max(Math.round(floors), 1), 30);

// --- геометрия инструментов (локальные метры) ----------------------------------------

/**
 * Дом «растяжкой», как мебель: прямоугольник от точки нажатия a до курсора b, повёрнутый
 * вдоль улицы (dir — направление ближайшей оси дороги; нет улицы — по сторонам света).
 */
export function stretchRectangle(a: Vec2, b: Vec2, dir: Vec2 = [1, 0]): [Vec2, Vec2, Vec2, Vec2] {
  const length = Math.hypot(dir[0], dir[1]) || 1;
  const d: Vec2 = [dir[0] / length, dir[1] / length];
  const n: Vec2 = [-d[1], d[0]];
  const delta: Vec2 = [b[0] - a[0], b[1] - a[1]];
  const along = delta[0] * d[0] + delta[1] * d[1];
  const across = delta[0] * n[0] + delta[1] * n[1];
  const p1: Vec2 = [a[0] + d[0] * along, a[1] + d[1] * along];
  const p3: Vec2 = [a[0] + n[0] * across, a[1] + n[1] * across];
  const corners: [Vec2, Vec2, Vec2, Vec2] = [a, p1, [p1[0] + n[0] * across, p1[1] + n[1] * across], p3];
  return signedArea(corners) >= 0 ? corners : [corners[0], corners[3], corners[2], corners[1]];
}

/** Стороны прямоугольника, м. */
export function rectangleSize(corners: readonly Vec2[]): [number, number] {
  const [a, b, c] = corners as [Vec2, Vec2, Vec2];
  return [Math.hypot(b[0] - a[0], b[1] - a[1]), Math.hypot(c[0] - b[0], c[1] - b[1])];
}

export function centroidOf(points: readonly Vec2[]): Vec2 {
  const n = points.length || 1;
  return [points.reduce((s, p) => s + p[0], 0) / n, points.reduce((s, p) => s + p[1], 0) / n];
}

export function translate(points: readonly Vec2[], [dx, dy]: Vec2): Vec2[] {
  return points.map(([x, y]) => [x + dx, y + dy]);
}

export function rotate(points: readonly Vec2[], center: Vec2, angle: number): Vec2[] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return points.map(([x, y]) => {
    const dx = x - center[0];
    const dy = y - center[1];
    return [center[0] + dx * c - dy * s, center[1] + dx * s + dy * c];
  });
}

/**
 * Растяжка за угол: противоположный угол ориентированного прямоугольника остаётся на месте,
 * контур масштабируется вдоль своих осей так, чтобы угол оказался под курсором (не меньше minSize).
 */
export function resizeByCorner(points: readonly Vec2[], cornerIndex: number, target: Vec2, minSize = 3): Vec2[] {
  const box = orientedBox(openRing(points));
  const corners = boxCorners(box);
  const corner = corners[cornerIndex % 4]!;
  const fixed = corners[(cornerIndex + 2) % 4]!;
  const proj = (p: Vec2, axis: Vec2) => (p[0] - fixed[0]) * axis[0] + (p[1] - fixed[1]) * axis[1];
  const oldU = proj(corner, box.u);
  const oldV = proj(corner, box.v);
  const newU = withSign(proj(target, box.u), oldU, minSize);
  const newV = withSign(proj(target, box.v), oldV, minSize);
  const su = oldU ? newU / oldU : 1;
  const sv = oldV ? newV / oldV : 1;
  return points.map((p) => {
    const pu = proj(p, box.u) * su;
    const pv = proj(p, box.v) * sv;
    return [fixed[0] + box.u[0] * pu + box.v[0] * pv, fixed[1] + box.u[1] * pu + box.v[1] * pv];
  });
}

/** Углы ориентированного прямоугольника контура (порядок обхода — по осям u, v). */
export function footprintCorners(points: readonly Vec2[]): Vec2[] {
  return boxCorners(orientedBox(openRing(points)));
}

/** Ручка поворота: перед серединой первой стороны прямоугольника, на 2,5 м наружу. */
export function rotateHandle(corners: readonly Vec2[]): Vec2 {
  const [a, b] = corners as [Vec2, Vec2];
  const c: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const center = centroidOf(corners);
  const out: Vec2 = [c[0] - center[0], c[1] - center[1]];
  const length = Math.hypot(out[0], out[1]) || 1;
  return [c[0] + (out[0] / length) * 2.5, c[1] + (out[1] / length) * 2.5];
}

/** Высота стен дома из правки, м: сарай — низкий, у магазина и деревенского дома — цоколь повыше. */
export function wallHeightOf(b: Pick<EditedBuilding, 'kind' | 'floors'>, village: boolean): number {
  if (b.kind === 'shed') return SHED_WALL_HEIGHT;
  const extra = b.kind === 'shop' ? 0.6 : village && b.kind === 'house' ? 0.4 : 0;
  return b.floors * EDIT_FLOOR_HEIGHT + extra;
}

function boxCorners(box: ReturnType<typeof orientedBox>): Vec2[] {
  const at = (su: number, sv: number): Vec2 => [
    box.center[0] + box.u[0] * su + box.v[0] * sv,
    box.center[1] + box.u[1] * su + box.v[1] * sv,
  ];
  return [at(-box.halfU, -box.halfV), at(box.halfU, -box.halfV), at(box.halfU, box.halfV), at(-box.halfU, box.halfV)];
}

/** Не меньше minSize по модулю и с тем же знаком, что был (угол не «выворачивается»). */
function withSign(value: number, previous: number, minSize: number): number {
  const sign = Math.sign(previous) || 1;
  return sign * Math.max(value * sign, minSize);
}

/** Упрощение линии (Рамер — Дуглас — Пекер): ломаная от руки → несколько точных отрезков. */
export function simplifyLine(points: readonly Vec2[], tolerance: number): Vec2[] {
  if (points.length <= 2) return [...points];
  const first = points[0]!;
  const last = points[points.length - 1]!;
  let index = 0;
  let max = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = distanceToSegment(points[i]!, first, last);
    if (d > max) {
      max = d;
      index = i;
    }
  }
  if (max <= tolerance) return [first, last];
  const left = simplifyLine(points.slice(0, index + 1), tolerance);
  const right = simplifyLine(points.slice(index), tolerance);
  return [...left.slice(0, -1), ...right];
}

export function lineLength(points: readonly Vec2[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]);
  return total;
}

export interface Snap {
  point: Vec2;
  distance: number;
  /** Направление оси в этой точке (единичное). */
  dir: Vec2;
}

/** Ближайшая точка на осях дорог (для «тяни от дороги» и выравнивания домов). */
export function nearestOnLines(point: Vec2, lines: readonly (readonly Vec2[])[]): Snap | undefined {
  let best: Snap | undefined;
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1]!;
      const b = line[i]!;
      const ab: Vec2 = [b[0] - a[0], b[1] - a[1]];
      const length2 = ab[0] * ab[0] + ab[1] * ab[1];
      if (!length2) continue;
      const t = Math.min(Math.max(((point[0] - a[0]) * ab[0] + (point[1] - a[1]) * ab[1]) / length2, 0), 1);
      const q: Vec2 = [a[0] + ab[0] * t, a[1] + ab[1] * t];
      const distance = Math.hypot(point[0] - q[0], point[1] - q[1]);
      if (!best || distance < best.distance) {
        const length = Math.sqrt(length2);
        best = { point: q, distance, dir: [ab[0] / length, ab[1] / length] };
      }
    }
  }
  return best;
}

/** Концы нарисованной дороги притягиваются к существующим, если рядом (как в градостроителях). */
export function snapEnds(line: readonly Vec2[], roads: readonly (readonly Vec2[])[], radius: number): Vec2[] {
  if (line.length < 2) return [...line];
  const result = [...line];
  for (const index of [0, result.length - 1]) {
    const snap = nearestOnLines(result[index]!, roads);
    if (snap && snap.distance <= radius) result[index] = snap.point;
  }
  return result;
}

/** Площадь контура, м² (локальные метры). */
export const areaOf = (points: readonly Vec2[]) => Math.abs(signedArea(openRing(points)));

const HOUSE_TYPES = new Set(['house', 'detached', 'semidetached_house', 'bungalow', 'terrace', 'cabin']);
const SHED_TYPES = new Set(['shed', 'garage', 'garages', 'hut', 'service', 'barn', 'farm_auxiliary', 'greenhouse']);
const SHOP_TYPES = new Set(['retail', 'commercial', 'kiosk', 'supermarket']);

/** Дом OSM, каким его видно в сцене, — для перевода в правку. */
export interface OsmBuildingLook {
  id: string;
  building: string;
  levels?: number;
  /** Высота стен, м. */
  wallTop: number;
  roof: string;
  outline: LonLat[];
  facadeColor: string;
  roofColor?: string;
}

/** Дом OSM → правка с тем же видом: контур, этажность, крыша, цвета (дальше их меняют в редакторе). */
export function fromOsm(look: OsmBuildingLook): EditedBuilding {
  const kind: EditBuildingKind = SHED_TYPES.has(look.building)
    ? 'shed'
    : SHOP_TYPES.has(look.building)
      ? 'shop'
      : HOUSE_TYPES.has(look.building) || look.wallTop < 7
        ? 'house'
        : 'apartments';
  const roof: EditRoof =
    look.roof === 'gabled' || look.roof === 'skillion' ? 'gabled' : look.roof === 'hipped' || look.roof === 'pyramidal' ? 'hipped' : 'flat';
  return {
    id: look.id,
    source: look.id,
    kind,
    footprint: look.outline,
    floors: clampFloors(look.levels ?? Math.max(1, Math.round(look.wallTop / EDIT_FLOOR_HEIGHT))),
    roof,
    facadeColor: look.facadeColor,
    roofColor: look.roofColor ?? '#6b7176',
  };
}

/** Новый дом растяжкой: тип и этажность по размеру и по тому, город это или деревня. */
export function newBuilding(id: string, footprint: LonLat[], areaM2: number, village: boolean, seed: number): EditedBuilding {
  const kind: EditBuildingKind = areaM2 < 25 ? 'shed' : village || areaM2 < 150 ? 'house' : 'apartments';
  const preset = BUILDING_KINDS[kind];
  return {
    id,
    kind,
    footprint,
    floors: kind === 'house' && !village ? 2 : preset.floors,
    roof: kind === 'house' && !village ? 'hipped' : preset.roof,
    facadeColor: FACADE_COLORS[seed % FACADE_COLORS.length]!,
    roofColor: ROOF_COLORS[(seed >>> 3) % ROOF_COLORS.length]!,
  };
}

/** Свой дом как препятствие для пешехода и для новых участков. */
export function toFeature(b: EditedBuilding): BaseBuildingFeature {
  return {
    type: 'Feature',
    id: b.id,
    properties: {
      id: b.id,
      building: BUILDING_KINDS[b.kind].osm,
      levels: b.floors,
      height: b.kind === 'shed' ? SHED_WALL_HEIGHT : b.floors * EDIT_FLOOR_HEIGHT,
      minHeight: 0,
      heightSource: 'height',
    },
    geometry: { type: 'Polygon', coordinates: [[...b.footprint, b.footprint[0]!]] },
  };
}
