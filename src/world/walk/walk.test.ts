import { describe, expect, it } from 'vitest';
import type { GroundFeature } from '../base/environment';
import type { BaseBuildingFeature } from '../base/types';
import { scatterTrees } from '../base/vegetation';
import type { LonLat } from '../user/plot';
import { Collider } from './collider';
import { createLocalFrame, type Vec2 } from './localFrame';
import { StreetIndex } from './streets';

const frame = createLocalFrame([55.946, 54.7225]);

/** Прямоугольник в локальных метрах → кольцо lon/lat (замкнутое). */
function rectRing(x: number, y: number, w: number, h: number): LonLat[] {
  const corners: Vec2[] = [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];
  return corners.map(frame.toLonLat);
}

function building(id: string, rings: LonLat[][], minHeight = 0): BaseBuildingFeature {
  return {
    type: 'Feature',
    id,
    properties: { id, building: 'yes', height: 12, minHeight, heightSource: 'default' },
    geometry: { type: 'Polygon', coordinates: rings },
  };
}

function ground(kind: GroundFeature['properties']['kind'], ring: LonLat[], name?: string): GroundFeature {
  return { type: 'Feature', properties: name ? { kind, name } : { kind }, geometry: { type: 'Polygon', coordinates: [ring] } };
}

const close = ([x1, y1]: Vec2, [x2, y2]: Vec2) => Math.hypot(x1 - x2, y1 - y2);

describe('Collider', () => {
  // Здание 10 × 10 м с юго-западным углом в (0, 0).
  const collider = new Collider([building('way/1', [rectRing(0, 0, 10, 10)])], frame);

  it('пропускает движение по свободному месту', () => {
    expect(close(collider.move([-5, -5], [0, -3]), [-5, -8])).toBeLessThan(1e-6);
  });

  it('не пускает внутрь здания', () => {
    const end = collider.move([-3, 5], [6, 0]);
    expect(end[0]).toBeLessThan(0);
    expect(collider.isBlocked(end)).toBe(false);
  });

  it('при движении под углом скользит вдоль стены', () => {
    // Идём на северо-восток вдоль западной стены: по x упираемся, по y продолжаем.
    const end = collider.move([-1, 2], [3, 3]);
    expect(end[0]).toBeLessThan(0);
    expect(end[1]).toBeGreaterThan(4.5);
  });

  it('даёт выйти, если старт оказался внутри здания', () => {
    const end = collider.move([5, 5], [0, 8]);
    expect(end[1]).toBeCloseTo(13, 5);
  });

  it('пропускает под зданием на опорах (арка, навес)', () => {
    const arch = new Collider([building('way/2', [rectRing(0, 0, 10, 10)], 3)], frame);
    expect(arch.isBlocked([5, 5])).toBe(false);
  });

  it('пускает во двор, но не в стены вокруг него', () => {
    const withYard = new Collider([building('way/3', [rectRing(0, 0, 30, 30), rectRing(10, 10, 10, 10)])], frame);
    expect(withYard.isBlocked([15, 15])).toBe(false);
    expect(withYard.isBlocked([5, 5])).toBe(true);
    expect(withYard.isBlocked([10.1, 15])).toBe(true);
  });
});

describe('StreetIndex', () => {
  const streets = new StreetIndex(
    [
      ground('road', rectRing(0, 0, 200, 12), 'улица Ленина'),
      ground('footway', rectRing(0, 12, 200, 3), 'дорожка'),
      ground('sidewalk', rectRing(0, -3, 200, 3)),
    ],
    frame,
  );

  it('находит улицу под ногами', () => {
    expect(streets.nameAt([50, 6])).toBe('улица Ленина');
  });

  it('на тротуаре без названия берёт ближайшую улицу', () => {
    expect(streets.nameAt([50, -2])).toBe('улица Ленина');
  });

  it('ничего не возвращает вдали от улиц', () => {
    expect(streets.nameAt([50, 200])).toBeUndefined();
  });
});

describe('scatterTrees', () => {
  const lawn = ground('green', rectRing(0, 0, 60, 60));
  const path = ground('footway', rectRing(0, 28, 60, 4));

  it('сажает деревья на газон, но не на дорожку, и одинаково при каждом запуске', () => {
    const trees = scatterTrees([lawn, path], []);
    expect(trees.length).toBeGreaterThan(10);
    for (const [lon, lat] of trees) {
      const [x, y] = frame.toLocal([lon, lat]);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(60);
      expect(y < 28 || y > 32).toBe(true);
    }
    expect(scatterTrees([lawn, path], [])).toEqual(trees);
  });

  it('не трогает маленькие газоны', () => {
    expect(scatterTrees([ground('green', rectRing(0, 0, 10, 10))], [])).toEqual([]);
  });
});
