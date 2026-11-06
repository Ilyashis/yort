import { describe, expect, it } from 'vitest';
import type { GroundFeature } from '../world/base/environment';
import type { LonLat } from '../world/user/plot';
import { createLocalFrame, type Vec2 } from '../world/walk/localFrame';
import { SoundZones } from './soundZones';

const frame = createLocalFrame([55.946, 54.7225]);

function area(kind: GroundFeature['properties']['kind'], x: number, y: number, w: number, h: number): GroundFeature {
  const corners: Vec2[] = [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];
  const ring: LonLat[] = corners.map(frame.toLonLat);
  return { type: 'Feature', properties: { kind }, geometry: { type: 'Polygon', coordinates: [ring] } };
}

// Улица вдоль y = 0..12, парк к северу (y = 40..140) с дорожкой посередине, река далеко на юге.
const zones = new SoundZones(
  [
    area('road', -200, 0, 400, 12),
    area('green', -100, 40, 200, 100),
    area('footway', -100, 88, 200, 3),
    area('water', -300, -400, 600, 100),
  ],
  frame,
);

describe('SoundZones', () => {
  it('у дороги громко шумят машины, вдали — почти тихо', () => {
    expect(zones.levelsAt([0, 6], 1.7).traffic).toBeGreaterThan(0.95);
    expect(zones.levelsAt([0, 90], 1.7).traffic).toBeLessThan(0.3);
  });

  it('в парке слышны листва и птицы, у реки — вода', () => {
    expect(zones.levelsAt([0, 70], 1.7).park).toBeCloseTo(1, 5);
    expect(zones.levelsAt([0, 6], 1.7).park).toBeLessThan(0.2);
    // 10 м от воды: 1 − 10/150 ≈ 0,93.
    expect(zones.levelsAt([0, -290], 1.7).water).toBeGreaterThan(0.9);
    expect(zones.levelsAt([0, 70], 1.7).water).toBe(0);
  });

  it('сверху слышен только далёкий гул города', () => {
    expect(zones.levelsAt([0, 6], 1000)).toEqual({ traffic: 0.25, park: 0, water: 0 });
  });

  it('шаги: по газону — трава, по дорожке в парке и тротуару — плитка', () => {
    expect(zones.surfaceAt([0, 60])).toBe('grass');
    expect(zones.surfaceAt([0, 89])).toBe('pavement');
    expect(zones.surfaceAt([0, 6])).toBe('pavement');
  });
});
