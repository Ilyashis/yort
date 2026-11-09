// Дома деревни → модели: какой модели быть каждому дому OSM — по размеру и форме контура и по тому,
// какой стороной он стоит к улице. Узким торцом к улице — изба, пятистенок или дом с верандой (фронтоном
// на улицу, как принято в башкирских деревнях); длинной стороной — вальмовый или кирпичный; маленькие
// постройки — бани. Фермы, школы и сложные по форме здания остаются простыми объёмами.

import { hashString, random01 } from '../../utils/hash';
import { openRing, orientedBox } from '../base/roofGeometry';
import { areaOf, modelFootprint, modelPlacement } from '../edit/edits';
import type { Vec2 } from '../walk/localFrame';
import { findHouseModel, type HouseModelId } from './houseModels';

export interface VillageHouse {
  /** id дома OSM. */
  id: string;
  model: HouseModelId;
  /** Вариант окраски (зерно модели), 1…VILLAGE_VARIANTS. */
  seed: number;
  /** Прямоугольник под модель: локальные метры, против часовой, первая сторона — уличный фасад. */
  rect: Vec2[];
  /** Цвета кровли и стен (#rrggbb) — из OSM (roof:colour, building:colour) или по съёмке с дрона. */
  colors?: { roof?: string; wall?: string };
}

/** Вариантов окраски у каждой модели в деревне: меньше вариантов — меньше разных геометрий. */
export const VILLAGE_VARIANTS = 4;
/** Меньше — не дом (будка, навес), больше — не жилой дом (ферма, школа, склад), м². */
const MIN_AREA = 9;
const MAX_AREA = 260;
/** Площадь до этой — баня или летняя кухня, м². */
const OUTBUILDING_AREA = 32;
/** Слишком вытянутые (коровник) и далёкие от прямоугольника (Г-образные) контуры не трогаем. */
const MAX_ASPECT = 3.2;
const MIN_FILL = 0.6;
/** Насколько контур может выйти за пределы размеров модели (её подгоняют масштабом). */
const SIZE_SLACK = 1.2;

function fits(id: HouseModelId, width: number, depth: number): boolean {
  const m = findHouseModel(id)!;
  return (
    width >= m.width.min / SIZE_SLACK && width <= m.width.max * SIZE_SLACK && depth >= m.depth.min / SIZE_SLACK && depth <= m.depth.max * SIZE_SLACK
  );
}

/** Типы building=* OSM, которым годятся жилые модели (в деревнях почти всё — просто building=yes). */
const HOUSE_TYPES = new Set(['yes', 'house', 'detached', 'residential', 'semidetached_house', 'bungalow', 'farm']);
/** Хозпостройки — сараи, гаражи, бани, в том числе найденные по съёмке с дрона: только баня, не жилой дом. */
const OUTBUILDING_TYPES = new Set(['shed', 'garage', 'garages', 'barn', 'hut', 'cabin', 'farm_auxiliary', 'service', 'sauna']);

/**
 * Модель для дома OSM (контур — локальные метры) или undefined — оставить простым объёмом.
 * building — тег building=* (школа, мечеть, магазин — не изба: простым объёмом).
 */
export function chooseVillageModel(
  id: string,
  outline: readonly Vec2[],
  roads: readonly (readonly Vec2[])[],
  building = 'yes',
): VillageHouse | undefined {
  const outbuilding = OUTBUILDING_TYPES.has(building);
  if (!outbuilding && !HOUSE_TYPES.has(building)) return undefined;
  const ring = openRing(outline);
  if (ring.length < 3) return undefined;
  const area = areaOf(ring);
  const box = orientedBox(ring);
  const long = box.halfU * 2;
  const short = box.halfV * 2;
  if (area < MIN_AREA || area > MAX_AREA || short < 2 || long / short > MAX_ASPECT || area / (long * short) < MIN_FILL) return undefined;

  const rect = modelFootprint(ring, roads);
  const { width, depth } = modelPlacement(rect);
  const seed = 1 + (hashString(`${id}:variant`) % VILLAGE_VARIANTS);
  if (outbuilding || area < OUTBUILDING_AREA) return { id, model: 'banya', seed, rect };

  // Торцом к улице — дома с фронтоном на улицу; длинной стороной — дома с длинным фасадом.
  const gableToStreet = width <= depth * 1.08;
  const options: [HouseModelId, number][] = gableToStreet
    ? [
        ['izba', 3],
        ['pyatistenok', depth / width >= 1.3 ? 3 : 0.5],
        ['veranda', 2],
      ]
    : [
        ['hipped', 3],
        ['brick', 2],
        ['izba', width / depth < 1.25 ? 2 : 0],
      ];
  const candidates = options.filter(([, weight]) => weight > 0);
  const fitting = candidates.filter(([model]) => fits(model, width, depth));
  const pool = fitting.length ? fitting : candidates;
  const total = pool.reduce((s, [, w]) => s + w, 0);
  let pick = random01(hashString(id)) * total;
  for (const [model, weight] of pool) {
    pick -= weight;
    if (pick <= 0) return { id, model, seed, rect };
  }
  return { id, model: pool[pool.length - 1]![0], seed, rect };
}

/** Три размера каждой модели (малый, средний, большой): дом берёт ближайший и подгоняется масштабом. */
export function sizePresets(id: HouseModelId): [number, number][] {
  const m = findHouseModel(id)!;
  return [0.2, 0.5, 0.82].map((t) => [m.width.min + (m.width.max - m.width.min) * t, m.depth.min + (m.depth.max - m.depth.min) * t]);
}

/** Пределы масштаба модели под контур: шире — заметно искажаются окна и брёвна. */
export const MIN_SCALE = 0.8;
export const MAX_SCALE = 1.25;

/** Какой размер модели взять для прямоугольника width × depth и как его растянуть. */
export function fitPreset(id: HouseModelId, width: number, depth: number): { preset: number; size: [number, number]; scale: [number, number] } {
  const presets = sizePresets(id);
  let best = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  presets.forEach(([w, d], i) => {
    const score = Math.abs(Math.log(width / w)) + Math.abs(Math.log(depth / d));
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  });
  const [w, d] = presets[best]!;
  const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
  return { preset: best, size: [w, d], scale: [clampScale(width / w), clampScale(depth / d)] };
}

/** Прямоугольник, раздвинутый на margin метров во все стороны (для расчистки деревьев у стен). */
export function growRect(rect: readonly Vec2[], margin: number): Vec2[] {
  const [p0, p1, p2] = rect as [Vec2, Vec2, Vec2];
  const unit = (a: Vec2, b: Vec2): Vec2 => {
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
  };
  const a = unit(p0, p1);
  const b = unit(p1, p2);
  const signs: [number, number][] = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  return rect.slice(0, 4).map((p, i) => {
    const [sa, sb] = signs[i]!;
    return [p[0] + (a[0] * sa + b[0] * sb) * margin, p[1] + (a[1] * sa + b[1] * sb) * margin];
  });
}

/** Толщина стены за осью сруба: лицо фасада модели — чуть дальше половины глубины, м. */
const WALL_FACE = 0.15;

/**
 * Насколько стена дома-модели выступает к улице дальше контура OSM (минус — утоплена) по направлению
 * toStreet от точки фасада origin: модель встаёт в прямоугольник по размерам ближайшей заготовки, и её
 * фасад может не совпасть с контуром — палисадник тогда короче или длиннее на эту величину.
 */
export function modelFacadeShift(house: VillageHouse, origin: Vec2, toStreet: Vec2): number {
  const place = modelPlacement(house.rect);
  const fit = fitPreset(house.model, place.width, place.depth);
  const w = fit.size[0] * fit.scale[0];
  const d = fit.size[1] * fit.scale[1];
  const along: Vec2 = [Math.cos(place.angle), Math.sin(place.angle)];
  const across: Vec2 = [-along[1], along[0]];
  const half = Math.abs(along[0] * toStreet[0] + along[1] * toStreet[1]) * (w / 2) + Math.abs(across[0] * toStreet[0] + across[1] * toStreet[1]) * (d / 2) + WALL_FACE;
  const edge = place.center[0] * toStreet[0] + place.center[1] * toStreet[1] + half;
  return edge - (origin[0] * toStreet[0] + origin[1] * toStreet[1]);
}
