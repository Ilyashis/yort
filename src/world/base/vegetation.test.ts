import { booleanPointInPolygon, polygon } from '@turf/turf';
import { describe, expect, it } from 'vitest';
import type { GroundFeature } from './environment';
import type { Ring } from './types';
import { scatterForest, scatterTrees, scatterYardTrees } from './vegetation';

const M_LAT = 1 / 111_320;
const M_LON = 1 / (111_320 * Math.cos((52.63 * Math.PI) / 180));
/** Прямоугольник w × h метров с юго-западным углом в (x, y) метрах от точки 57.96, 52.63. */
const rect = (x: number, y: number, w: number, h: number): Ring => {
  const p = (dx: number, dy: number): [number, number] => [57.96 + dx * M_LON, 52.63 + dy * M_LAT];
  return [p(x, y), p(x + w, y), p(x + w, y + h), p(x, y + h), p(x, y)];
};

const houses = Array.from({ length: 12 }, (_, i) => ({ id: `way/${i}`, rings: [rect((i % 4) * 30, Math.floor(i / 4) * 30, 9, 8)] }));
const shed = { id: 'way/shed', rings: [rect(200, 0, 4, 4)] };
const road: GroundFeature = {
  type: 'Feature',
  properties: { kind: 'road' },
  geometry: { type: 'Polygon', coordinates: [rect(-20, 20, 200, 6)] },
};

describe('scatterYardTrees', () => {
  const trees = scatterYardTrees([...houses, shed], [road]);

  it('сажает по нескольку деревьев у домов, но не у сараев', () => {
    expect(trees.length).toBeGreaterThanOrEqual(12);
    expect(trees.length).toBeLessThanOrEqual(36);
    const nearShed = trees.filter(([lon]) => lon > 57.96 + 150 * M_LON);
    expect(nearShed).toEqual([]);
  });

  it('деревья не в домах и не на дороге', () => {
    const blockers = [...houses.map((h) => h.rings), road.geometry.coordinates as Ring[]].map((r) => polygon(r));
    for (const [lon, lat] of trees) {
      expect(blockers.some((b) => booleanPointInPolygon([lon, lat], b))).toBe(false);
    }
  });

  it('одинаково при каждом запуске', () => {
    expect(scatterYardTrees([...houses, shed], [road])).toEqual(trees);
  });
});

describe('scatterForest', () => {
  const wood: GroundFeature = {
    type: 'Feature',
    properties: { kind: 'green', cover: 'wood' },
    geometry: { type: 'Polygon', coordinates: [rect(0, 0, 300, 200)] },
  };
  const meadow: GroundFeature = {
    type: 'Feature',
    properties: { kind: 'green', cover: 'meadow' },
    geometry: { type: 'Polygon', coordinates: [rect(400, 0, 300, 200)] },
  };
  const forestRoad: GroundFeature = {
    type: 'Feature',
    properties: { kind: 'road' },
    geometry: { type: 'Polygon', coordinates: [rect(0, 95, 300, 10)] },
  };

  it('густота по площади, но не больше бюджета', () => {
    // 60 000 м² по 90 м² — около 660 деревьев.
    const dense = scatterForest([wood], [], { areaPerTree: 90, maxTrees: 10_000 });
    expect(dense.length).toBeGreaterThan(550);
    expect(dense.length).toBeLessThan(720);
    expect(scatterForest([wood], [], { areaPerTree: 90, maxTrees: 200 }).length).toBeLessThanOrEqual(200);
  });

  it('не на лесной дороге и не на лугу; луга и леса не засаживаются как парки', () => {
    const trees = scatterForest([wood, meadow, forestRoad]);
    const roadShape = polygon(forestRoad.geometry.coordinates as Ring[]);
    expect(trees.some(([lon, lat]) => booleanPointInPolygon([lon, lat], roadShape))).toBe(false);
    expect(trees.some(([lon]) => lon > 57.96 + 350 * M_LON)).toBe(false);
    expect(scatterTrees([wood, meadow], [])).toEqual([]);
  });
});
