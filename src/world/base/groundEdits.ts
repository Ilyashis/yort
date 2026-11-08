// Покрытия земли с учётом правок редактора — без привязки к движку: какие полигоны рисовать
// (убранные дороги OSM вместе с их тротуарами и разметкой — нет, новые дороги — полосой по оси),
// какая дорога под точкой, ключ дороги, границы района.

import { booleanPointInPolygon, buffer, lineString, polygon } from '@turf/turf';
import { hashString } from '../../utils/hash';
import { ROAD_KINDS, type EditRoadKind, type LonLat } from '../edit/edits';
import { polygonsOfGround, type GroundFeature, type GroundKind } from './environment';
import type { Ring } from './types';

/** Дорога, нарисованная в редакторе: ось и тип (ширина и покрытие). */
export interface RoadEdit {
  kind: EditRoadKind;
  axis: LonLat[];
}

/** Что редактор поменял на земле. */
export interface GroundEdits {
  /** Убранные дороги OSM (ключ полигона проезжей части, см. roadKey). */
  removedRoads: ReadonlySet<string>;
  addedRoads: readonly RoadEdit[];
  /** Дворы (id дома), чьи огороды больше не рисуем. */
  hiddenGardens: ReadonlySet<string>;
}

export const NO_GROUND_EDITS: GroundEdits = { removedRoads: new Set(), addedRoads: [], hiddenGardens: new Set() };
/** Тротуар вдоль новой городской улицы, м с каждой стороны. */
const NEW_SIDEWALK = 1.6;

export interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** Стабильный ключ дороги OSM: по первым точкам контура и названию (переживает перезагрузку). */
export function roadKey(feature: GroundFeature): string {
  const [first] = polygonsOfGround(feature);
  const head = (first?.[0] ?? []).slice(0, 3).map(([lon, lat]) => `${lon.toFixed(6)},${lat.toFixed(6)}`);
  return `road:${hashString(head.join(';') + (feature.properties.name ?? ''))}`;
}

interface RoadEntry {
  key: string;
  feature: GroundFeature;
  shapes: ReturnType<typeof polygon>[];
}

/** Покрытия района и правки к ним. */
export class GroundModel {
  private readonly roads: RoadEntry[];

  constructor(
    readonly features: readonly GroundFeature[],
    /** Город: у новых улиц — тротуары. */
    private readonly city: boolean,
  ) {
    this.roads = features
      .filter((f) => f.properties.kind === 'road')
      .map((feature) => ({ key: roadKey(feature), feature, shapes: polygonsOfGround(feature).map((rings) => polygon(rings)) }));
  }

  /** Дорога OSM под точкой (не убранная), для выбора в редакторе. */
  roadAt(lon: number, lat: number, removed: ReadonlySet<string>): { key: string; rings: Ring[][] } | undefined {
    const point: [number, number] = [lon, lat];
    const hit = this.roads.find((r) => !removed.has(r.key) && r.shapes.some((shape) => booleanPointInPolygon(point, shape)));
    return hit ? { key: hit.key, rings: polygonsOfGround(hit.feature) } : undefined;
  }

  /** Контур дороги OSM по ключу — для подсветки выделенной. */
  roadOutline(key: string): Ring[][] {
    const road = this.roads.find((r) => r.key === key);
    return road ? polygonsOfGround(road.feature) : [];
  }

  /** Полигоны по видам покрытия с учётом правок; dirt — просёлки (утоптанная земля). */
  effective(edits: GroundEdits): { byKind: Map<GroundKind, Ring[][]>; dirt: Ring[][] } {
    const removed = this.roads.filter((r) => edits.removedRoads.has(r.key));
    const removedShapes = removed.flatMap((r) => r.shapes);
    const removedFeatures = new Set(removed.map((r) => r.feature));
    // Тротуар и разметка «принадлежат» дороге, если её точки лежат внутри (тротуар шире дороги).
    const covers = (rings: Ring[]) => {
      const sample = (rings[0] ?? []).filter((_, i, all) => i % Math.max(1, Math.floor(all.length / 6)) === 0);
      return (shape: ReturnType<typeof polygon>) => sample.length > 0 && sample.every((p) => booleanPointInPolygon(p, shape));
    };

    const byKind = new Map<GroundKind, Ring[][]>();
    const push = (kind: GroundKind, rings: Ring[]) => {
      const list = byKind.get(kind) ?? [];
      list.push(rings);
      byKind.set(kind, list);
    };
    for (const feature of this.features) {
      if (removedFeatures.has(feature)) continue;
      const { kind } = feature.properties;
      for (const rings of polygonsOfGround(feature)) {
        if (removedShapes.length && kind === 'sidewalk') {
          const sidewalk = polygon(rings);
          if (removed.some((r) => polygonsOfGround(r.feature).some((roadRings) => covers(roadRings)(sidewalk)))) continue;
        }
        if (removedShapes.length && kind === 'marking' && removedShapes.some(covers(rings))) continue;
        push(kind, rings);
      }
    }

    const dirt: Ring[][] = [];
    for (const road of edits.addedRoads) {
      if (road.axis.length < 2) continue;
      const { width } = ROAD_KINDS[road.kind];
      const strip = (half: number) => {
        const result = buffer(lineString(road.axis), half, { units: 'meters', steps: 4 });
        const geometry = result?.geometry;
        if (!geometry) return [];
        return geometry.type === 'Polygon' ? [geometry.coordinates as Ring[]] : (geometry.coordinates as Ring[][]);
      };
      if (road.kind === 'track') dirt.push(...strip(width / 2));
      else if (road.kind === 'path') for (const rings of strip(width / 2)) push('footway', rings);
      else {
        if (this.city && road.kind === 'street') for (const rings of strip(width / 2 + NEW_SIDEWALK)) push('sidewalk', rings);
        for (const rings of strip(width / 2)) push('road', rings);
      }
    }
    return { byKind, dirt };
  }
}

export function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

/** Габариты покрытий (без разметки — по ней границы не считаем). */
export function groundBounds(features: readonly GroundFeature[]): Bounds | undefined {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const feature of features) {
    if (feature.properties.kind === 'marking') continue;
    for (const rings of polygonsOfGround(feature)) {
      for (const [lon, lat] of rings[0] ?? []) {
        west = Math.min(west, lon);
        east = Math.max(east, lon);
        south = Math.min(south, lat);
        north = Math.max(north, lat);
      }
    }
  }
  return Number.isFinite(west) ? { west, south, east, north } : undefined;
}
