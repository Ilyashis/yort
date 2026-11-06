import { describe, expect, it } from 'vitest';
import type { LonLat } from '../user/plot';
import { Collider } from '../walk/collider';
import { createLocalFrame, insidePolygon, toLocalPolygon, type Vec2 } from '../walk/localFrame';
import type { GroundFeature } from './environment';
import { facadeStyle, findStreetFrontBuildings } from './facades';
import { landmarkObstacle } from './LandmarksLayer';
import { EMPTY_STREETS, orientBenches, placeLamps, roadMarkings, sampleAlong, type StreetsData } from './streetFurniture';
import type { BaseBuildingFeature, BaseBuildingProperties } from './types';

const frame = createLocalFrame([55.946, 54.7225]);
const ll = (p: Vec2): LonLat => frame.toLonLat(p);

/** Прямоугольник в локальных метрах → замкнутое кольцо lon/lat. */
function rectRing(x: number, y: number, w: number, h: number): LonLat[] {
  const corners: Vec2[] = [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];
  return corners.map(ll);
}

const props = (id: string, extra: Partial<BaseBuildingProperties> = {}): BaseBuildingProperties => ({
  id,
  building: 'apartments',
  height: 16,
  minHeight: 0,
  heightSource: 'levels',
  levels: 5,
  ...extra,
});

const building = (id: string, ring: LonLat[], extra: Partial<BaseBuildingProperties> = {}): BaseBuildingFeature => ({
  type: 'Feature',
  id,
  properties: props(id, extra),
  geometry: { type: 'Polygon', coordinates: [ring] },
});

// Улица шириной 12 м с востока на запад вдоль y = 0 (от x = 0 до x = 300).
const roadRing = rectRing(-5, -6, 310, 12);
const road: GroundFeature = { type: 'Feature', properties: { kind: 'road', name: 'улица Ленина' }, geometry: { type: 'Polygon', coordinates: [roadRing] } };
const roadSurfaces = [toLocalPolygon([roadRing], frame)];
const streets: StreetsData = {
  ...EMPTY_STREETS,
  roads: [{ highway: 'secondary', width: 12, name: 'улица Ленина', coords: [ll([0, 0]), ll([300, 0])] }],
};

describe('sampleAlong', () => {
  it('ставит точки через равные промежутки и с направлением отрезка', () => {
    const points = sampleAlong([[0, 0], [10, 0], [10, 10]], 5);
    expect(points.map((p) => p.point.map((v) => Math.round(v)))).toEqual([[0, 0], [5, 0], [10, 0], [10, 5], [10, 10]]);
    expect(points[3]!.dir).toEqual([0, 1]);
  });
});

describe('placeLamps', () => {
  it('ставит фонари по обе стороны улицы, на тротуаре, через ~32 м', () => {
    const lamps = placeLamps(streets, frame, roadSurfaces, []);
    expect(lamps.length).toBeGreaterThanOrEqual(16);
    for (const lamp of lamps) {
      const [, y] = frame.toLocal(lamp.position);
      expect(Math.abs(Math.abs(y) - 6.8)).toBeLessThan(0.05);
      // Консоль смотрит к оси дороги: на севере — на юг (π), на юге — на север (0).
      expect(Math.cos(lamp.heading)).toBeCloseTo(y > 0 ? -1 : 1, 5);
    }
  });

  it('не ставит фонарь в здание и на проезжую часть другой улицы', () => {
    const house = toLocalPolygon([rectRing(0, 6, 300, 20)], frame);
    const lamps = placeLamps(streets, frame, roadSurfaces, [house]);
    expect(lamps.every((l) => frame.toLocal(l.position)[1] < 0)).toBe(true);
    const crossStreet = toLocalPolygon([rectRing(-5, -30, 310, 60)], frame);
    expect(placeLamps(streets, frame, [crossStreet], [])).toEqual([]);
  });
});

describe('orientBenches', () => {
  it('разворачивает скамейку вдоль ближайшей дорожки', () => {
    const data: StreetsData = {
      ...EMPTY_STREETS,
      paths: [{ highway: 'footway', width: 2.5, coords: [ll([0, 0]), ll([0, 50])] }],
      benches: [ll([1.5, 20])],
    };
    const [bench] = orientBenches(data, frame);
    expect(Math.abs(Math.cos(bench!.heading))).toBeCloseTo(1, 5);
  });
});

describe('roadMarkings', () => {
  it('рисует прерывистую осевую на широкой двусторонней улице, но не на односторонней', () => {
    const dashes = roadMarkings(streets, frame, roadSurfaces);
    expect(dashes.length).toBe(Math.floor((300 - 3) / 9) + 1);
    const oneway = roadMarkings({ ...streets, roads: [{ ...streets.roads[0]!, oneway: true }] }, frame, roadSurfaces);
    expect(oneway).toEqual([]);
  });

  it('рисует зебру только на проезжей части', () => {
    const crossing: StreetsData = { ...EMPTY_STREETS, crossings: [[ll([100, -10]), ll([100, 10])]] };
    const stripes = roadMarkings(crossing, frame, roadSurfaces);
    expect(stripes.length).toBeGreaterThanOrEqual(9);
    expect(stripes.length).toBeLessThanOrEqual(12);
    for (const stripe of stripes) {
      const ring = stripe.geometry.type === 'Polygon' ? stripe.geometry.coordinates[0]! : [];
      const [cx, cy] = ring.slice(0, 4).map(frame.toLocal).reduce((a, b) => [a[0] + b[0] / 4, a[1] + b[1] / 4], [0, 0]);
      expect(insidePolygon([cx, cy], roadSurfaces[0]!)).toBe(true);
    }
  });
});

describe('facades', () => {
  it('витрины только у зданий вдоль улицы с названием', () => {
    const near = building('way/1', rectRing(10, 8, 30, 15));
    const far = building('way/2', rectRing(10, 60, 30, 15));
    const garage = building('way/3', rectRing(60, 8, 10, 10), { building: 'garages' });
    const ids = findStreetFrontBuildings([near, far, garage], [road], frame);
    expect([...ids]).toEqual(['way/1']);
    expect(facadeStyle(near.properties, true).shopfront).toBe(true);
    expect(facadeStyle(far.properties, false).shopfront).toBe(false);
  });

  it('высотки получают ленточные окна, остальные — стабильный тип по id', () => {
    expect(facadeStyle(props('way/9', { levels: 12, height: 38 }), false).variant).toBe(2);
    expect(facadeStyle(props('way/7'), false)).toEqual(facadeStyle(props('way/7'), false));
  });
});

describe('landmarkObstacle', () => {
  it('пьедестал памятника не пускает пешехода', () => {
    const position = ll([0, 0]);
    const obstacle = landmarkObstacle({ id: 'test', name: 'Тест', position, heading: 250, kind: 'equestrian-statue' });
    const collider = new Collider([obstacle], frame);
    expect(collider.isBlocked([0, 0])).toBe(true);
    expect(collider.isBlocked([0, 10])).toBe(false);
  });
});
