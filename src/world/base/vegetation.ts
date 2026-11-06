import { area, bbox, booleanPointInPolygon, polygon } from '@turf/turf';
import { hashString, random01 } from '../../utils/hash';
import { polygonsOfGround, type GroundFeature, type TreePoint } from './environment';
import type { Ring } from './types';

export interface ScatterOptions {
  /** Сколько м² газона приходится на одно дерево. */
  areaPerTree: number;
  /** Газоны меньше этой площади (м²) не засаживаем — это клумбы и полосы вдоль дорог. */
  minArea: number;
  /** Не сажаем ближе этого расстояния (м) к уже отмеченному в OSM дереву. */
  minDistanceToMapped: number;
}

const DEFAULTS: ScatterOptions = { areaPerTree: 180, minArea: 600, minDistanceToMapped: 4 };

const M_PER_DEG_LAT = 111_320;

/**
 * Досаживает деревья на крупные газоны и в парки, где в OSM деревья не отмечены.
 * Детерминированно (одинаково при каждом запуске) и не на дорожках, дорогах и площадках.
 */
export function scatterTrees(
  ground: readonly GroundFeature[],
  mappedTrees: readonly TreePoint[],
  /** Дополнительные запретные полигоны (например, здания). */
  blockers: readonly Ring[][] = [],
  options: Partial<ScatterOptions> = {},
): TreePoint[] {
  const opts = { ...DEFAULTS, ...options };
  const hardSurfaces = [
    ...ground.filter((f) => f.properties.kind !== 'green').flatMap(polygonsOfGround),
    ...blockers,
  ].map((rings) => {
    const shape = polygon(rings);
    return { shape, box: bbox(shape) };
  });

  const result: TreePoint[] = [];
  ground.forEach((feature, featureIndex) => {
    if (feature.properties.kind !== 'green') return;

    polygonsOfGround(feature).forEach((rings, polygonIndex) => {
      const shape = polygon(rings);
      const surface = area(shape);
      if (surface < opts.minArea) return;

      const [minX, minY, maxX, maxY] = bbox(shape);
      const target = Math.round(surface / opts.areaPerTree);
      const seed = hashString(`${featureIndex}:${polygonIndex}`);
      const mPerDegLon = M_PER_DEG_LAT * Math.cos((((minY + maxY) / 2) * Math.PI) / 180);
      const nearMapped = (lon: number, lat: number) =>
        mappedTrees.some(
          ([tLon, tLat]) =>
            Math.hypot((tLon - lon) * mPerDegLon, (tLat - lat) * M_PER_DEG_LAT) < opts.minDistanceToMapped,
        );

      let placed = 0;
      for (let attempt = 0; placed < target && attempt < target * 6; attempt++) {
        const lon = minX + random01(seed + attempt * 2) * (maxX - minX);
        const lat = minY + random01(seed + attempt * 2 + 1) * (maxY - minY);
        const point: [number, number] = [lon, lat];
        if (!booleanPointInPolygon(point, shape)) continue;
        const onHardSurface = hardSurfaces.some(
          ({ shape: s, box: [x0, y0, x1, y1] }) =>
            lon >= x0 && lon <= x1 && lat >= y0 && lat <= y1 && booleanPointInPolygon(point, s),
        );
        if (onHardSurface || nearMapped(lon, lat)) continue;
        result.push([lon, lat, 0]);
        placed++;
      }
    });
  });
  return result;
}
