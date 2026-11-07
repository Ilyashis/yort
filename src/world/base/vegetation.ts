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
    // Лес засаживает scatterForest, на лугах деревьев нет.
    if (feature.properties.kind !== 'green' || feature.properties.cover) return;

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

export interface YardTreeOptions {
  /** Дома меньше этой площади (м²) — сараи и бани, у них деревья не сажаем. */
  minHouseArea: number;
  /** Расстояние от стены дома до дерева, м: [от, до]. */
  distance: [number, number];
  /** Деревья не ближе этого расстояния друг к другу, м. */
  spacing: number;
}

const YARD_DEFAULTS: YardTreeOptions = { minHouseArea: 45, distance: [3, 10], spacing: 4 };

/**
 * Деревья во дворах деревенских домов (в OSM их почти никогда не отмечают): одно–три у каждого
 * дома, в нескольких метрах от стен, не на дорогах и не в соседних постройках. Детерминированно.
 */
export function scatterYardTrees(
  houses: readonly { id: string; rings: Ring[] }[],
  ground: readonly GroundFeature[],
  options: Partial<YardTreeOptions> = {},
): TreePoint[] {
  const opts = { ...YARD_DEFAULTS, ...options };
  const blockers = [
    ...ground.filter((f) => f.properties.kind !== 'green').flatMap(polygonsOfGround),
    ...houses.map((h) => h.rings),
  ].map((rings) => {
    const shape = polygon(rings);
    return { shape, box: bbox(shape) };
  });
  const blocked = (point: [number, number]) =>
    blockers.some(
      ({ shape, box: [x0, y0, x1, y1] }) =>
        point[0] >= x0 && point[0] <= x1 && point[1] >= y0 && point[1] <= y1 && booleanPointInPolygon(point, shape),
    );

  const result: TreePoint[] = [];
  for (const house of houses) {
    const shape = polygon(house.rings);
    const surface = area(shape);
    if (surface < opts.minHouseArea) continue;
    const seed = hashString(`yard:${house.id}`);
    const wanted = random01(seed) < 0.15 ? 0 : 1 + (seed % 3);
    const [minX, minY, maxX, maxY] = bbox(shape);
    const center: [number, number] = [(minX + maxX) / 2, (minY + maxY) / 2];
    const mPerDegLon = M_PER_DEG_LAT * Math.cos((center[1] * Math.PI) / 180);
    // Радиус дома — половина диагонали габарита: от него и отмеряем расстояние до дерева.
    const radius = Math.hypot((maxX - minX) * mPerDegLon, (maxY - minY) * M_PER_DEG_LAT) / 2;

    let placed = 0;
    for (let attempt = 0; placed < wanted && attempt < wanted * 6; attempt++) {
      const angle = random01(seed + attempt * 3 + 1) * Math.PI * 2;
      const [near, far] = opts.distance;
      const distance = radius + near + random01(seed + attempt * 3 + 2) * (far - near);
      const point: [number, number] = [
        center[0] + (Math.cos(angle) * distance) / mPerDegLon,
        center[1] + (Math.sin(angle) * distance) / M_PER_DEG_LAT,
      ];
      const crowded = result.some(
        ([lon, lat]) =>
          Math.hypot((lon - point[0]) * mPerDegLon, (lat - point[1]) * M_PER_DEG_LAT) < opts.spacing,
      );
      if (crowded || blocked(point)) continue;
      result.push([point[0], point[1], 0]);
      placed++;
    }
  }
  return result;
}

export interface ForestOptions {
  /** Сколько м² леса на одно дерево, если укладываемся в бюджет. */
  areaPerTree: number;
  /** Не больше стольких деревьев на весь лес района: дальше редеем, а не тормозим. */
  maxTrees: number;
}

const FOREST_DEFAULTS: ForestOptions = { areaPerTree: 90, maxTrees: 24_000 };

/**
 * Деревья в лесных массивах (cover = wood): равномерно, но не на дорогах и не в зданиях.
 * Густота падает, если весь лес не помещается в бюджет. Детерминированно.
 */
export function scatterForest(
  ground: readonly GroundFeature[],
  blockers: readonly Ring[][] = [],
  options: Partial<ForestOptions> = {},
): TreePoint[] {
  const opts = { ...FOREST_DEFAULTS, ...options };
  const woods = ground
    .filter((f) => f.properties.kind === 'green' && f.properties.cover === 'wood')
    .flatMap(polygonsOfGround)
    .map((rings) => {
      const shape = polygon(rings);
      return { shape, box: bbox(shape), surface: area(shape) };
    });
  const total = woods.reduce((sum, w) => sum + w.surface, 0);
  if (!total) return [];
  const areaPerTree = Math.max(opts.areaPerTree, total / opts.maxTrees);

  const hard = [
    ...ground.filter((f) => f.properties.kind !== 'green').flatMap(polygonsOfGround),
    ...blockers,
  ].map((rings) => {
    const shape = polygon(rings);
    return { shape, box: bbox(shape) };
  });

  const result: TreePoint[] = [];
  woods.forEach(({ shape, box: [minX, minY, maxX, maxY] }, index) => {
    // Сетка с разбросом внутри ячейки: лес ровный по густоте, без «полян» и кучек от чистого рандома.
    const mPerDegLon = M_PER_DEG_LAT * Math.cos((((minY + maxY) / 2) * Math.PI) / 180);
    const step = Math.sqrt(areaPerTree);
    const stepLon = step / mPerDegLon;
    const stepLat = step / M_PER_DEG_LAT;
    const seed = hashString(`forest:${index}`);
    let cell = 0;
    for (let lat = minY; lat < maxY && result.length < opts.maxTrees; lat += stepLat) {
      for (let lon = minX; lon < maxX; lon += stepLon, cell++) {
        const point: [number, number] = [
          lon + random01(seed + cell * 2) * stepLon,
          lat + random01(seed + cell * 2 + 1) * stepLat,
        ];
        if (!booleanPointInPolygon(point, shape)) continue;
        const onHard = hard.some(
          ({ shape: s, box: [x0, y0, x1, y1] }) =>
            point[0] >= x0 && point[0] <= x1 && point[1] >= y0 && point[1] <= y1 && booleanPointInPolygon(point, s),
        );
        if (!onHard) result.push([point[0], point[1], 0]);
      }
    }
  });
  return result.slice(0, opts.maxTrees);
}
