// User World: участок под будущий объект. Хранится отдельно от Base World
// и проверяется против него (пересечения с существующими зданиями).

import { area, bbox, booleanIntersects, distance, kinks, polygon } from '@turf/turf';
import type { BaseBuildingFeature } from '../base/types';

/** [долгота, широта] в градусах. */
export type LonLat = [number, number];

export interface Bbox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export type PlotIssueCode =
  | 'too-few-points'
  | 'self-intersection'
  | 'too-small'
  | 'too-large'
  | 'outside-territory'
  | 'overlaps-buildings';

export interface PlotIssue {
  code: PlotIssueCode;
  message: string;
}

export interface PlotAnalysis {
  /** Вершины контура по порядку, без повторной замыкающей точки. */
  polygon: LonLat[];
  areaM2: number;
  perimeterM: number;
  /** Здания Base World, которые задевает участок. */
  conflictingBuildingIds: string[];
  issues: PlotIssue[];
  valid: boolean;
}

export const PLOT_LIMITS = {
  minAreaM2: 100,
  maxAreaM2: 20_000,
} as const;

const closeRing = (points: LonLat[]): LonLat[] => [...points, points[0]!];

/** Площадь контура в м² (0, если точек меньше трёх). */
export function plotArea(points: LonLat[]): number {
  return points.length < 3 ? 0 : area(polygon([closeRing(points)]));
}

export function plotPerimeter(points: LonLat[]): number {
  if (points.length < 2) return 0;
  const ring = points.length < 3 ? points : closeRing(points);
  let meters = 0;
  for (let i = 1; i < ring.length; i++) {
    meters += distance(ring[i - 1]!, ring[i]!, { units: 'meters' });
  }
  return meters;
}

export function analyzePlot(
  points: LonLat[],
  buildings: readonly BaseBuildingFeature[],
  territoryBbox: Bbox,
): PlotAnalysis {
  const issues: PlotIssue[] = [];
  const base = { polygon: points, perimeterM: plotPerimeter(points) };

  if (points.length < 3) {
    issues.push({ code: 'too-few-points', message: 'Нужно минимум 3 угла участка' });
    return { ...base, areaM2: 0, conflictingBuildingIds: [], issues, valid: false };
  }

  const shape = polygon([closeRing(points)]);
  const areaM2 = area(shape);

  if (kinks(shape).features.length > 0) {
    issues.push({ code: 'self-intersection', message: 'Контур участка пересекает сам себя' });
  }
  if (areaM2 < PLOT_LIMITS.minAreaM2) {
    issues.push({ code: 'too-small', message: `Площадь меньше ${PLOT_LIMITS.minAreaM2} м²` });
  } else if (areaM2 > PLOT_LIMITS.maxAreaM2) {
    issues.push({
      code: 'too-large',
      message: `Площадь больше ${PLOT_LIMITS.maxAreaM2.toLocaleString('ru-RU')} м² (${PLOT_LIMITS.maxAreaM2 / 10_000} га)`,
    });
  }

  const { south, west, north, east } = territoryBbox;
  if (points.some(([lon, lat]) => lon < west || lon > east || lat < south || lat > north)) {
    issues.push({ code: 'outside-territory', message: 'Участок выходит за границы района с данными' });
  }

  const conflictingBuildingIds = findConflicts(shape, buildings);
  if (conflictingBuildingIds.length > 0) {
    issues.push({
      code: 'overlaps-buildings',
      message: `Участок задевает существующие здания: ${conflictingBuildingIds.length}`,
    });
  }

  return { ...base, areaM2, conflictingBuildingIds, issues, valid: issues.length === 0 };
}

function findConflicts(
  shape: ReturnType<typeof polygon>,
  buildings: readonly BaseBuildingFeature[],
): string[] {
  const [minX, minY, maxX, maxY] = bbox(shape);
  const ids: string[] = [];
  for (const building of buildings) {
    // Быстрый отсев по габаритам, точная проверка — только для соседей.
    const [bMinX, bMinY, bMaxX, bMaxY] = bbox(building.geometry);
    if (bMaxX < minX || bMinX > maxX || bMaxY < minY || bMinY > maxY) continue;
    if (booleanIntersects(shape, building.geometry)) ids.push(building.properties.id);
  }
  return ids;
}
