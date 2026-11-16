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
    expect(zones.levelsAt([0, -290], 1.7).water).toBeGreaterThan(0.8);
    expect(zones.levelsAt([0, 70], 1.7).water).toBe(0);
  });

  it('сверху слышен только далёкий гул города', () => {
    expect(zones.levelsAt([0, 6], 1000)).toEqual({ traffic: 0.25, park: 0, leaves: 0, water: 0 });
  });

  it('шаги: по газону — трава, по дорожке в парке и тротуару — плитка', () => {
    expect(zones.surfaceAt([0, 60])).toBe('grass');
    expect(zones.surfaceAt([0, 89])).toBe('pavement');
    expect(zones.surfaceAt([0, 6])).toBe('pavement');
  });
});

describe('SoundZones в деревне', () => {
  const village = new SoundZones([area('road', -200, 0, 400, 12), area('green', -100, 40, 200, 100)], frame, true);

  it('без гула машин и шипения листвы; птиц слышно везде, с высоты — тише', () => {
    expect(village.levelsAt([0, 6], 1.7).traffic).toBe(0);
    expect(village.levelsAt([0, 6], 1.7).leaves).toBe(0);
    expect(village.levelsAt([0, 6], 1000)).toEqual({ traffic: 0, park: 0.25, leaves: 0, water: 0 });
    expect(village.levelsAt([0, -150], 1.7).park).toBeGreaterThan(0.5);
  });

  it('у леса птиц больше, чем на пустом месте', () => {
    const trees: [number, number][] = [];
    for (let i = 0; i < 60; i++) trees.push([500 + (i % 8) * 6, 500 + Math.floor(i / 8) * 6]);
    const woods = new SoundZones([], frame, true, trees);
    expect(woods.woodsAt([520, 520])).toBe(1);
    expect(woods.woodsAt([0, 0])).toBe(0);
    expect(woods.levelsAt([520, 520], 1.7).park).toBeGreaterThan(woods.levelsAt([0, 0], 1.7).park + 0.3);
  });

  it('речку слышно только рядом', () => {
    const river = new SoundZones([area('water', -200, 200, 400, 30)], frame, true);
    expect(river.levelsAt([0, 210], 1.7).water).toBeGreaterThan(0.9);
    expect(river.levelsAt([0, 140], 1.7).water).toBeGreaterThan(0);
    expect(river.levelsAt([0, 100], 1.7).water).toBe(0);
  });

  it('шаги вне дороги — по траве', () => {
    expect(village.surfaceAt([0, -150])).toBe('grass');
    expect(village.surfaceAt([0, 6])).toBe('pavement');
  });
});

describe('SoundZones: ручей', () => {
  const stream: GroundFeature = { ...area('water', -200, 200, 400, 2.5), properties: { kind: 'water', stream: true } };
  const zones = new SoundZones([stream], frame);

  it('журчит рядом и не слышен за полсотни метров, в отличие от реки', () => {
    expect(zones.levelsAt([0, 195], 1.7).water).toBeGreaterThan(0.3);
    expect(zones.levelsAt([0, 150], 1.7).water).toBe(0);
  });
});

describe('SoundZones зимой', () => {
  const trees: [number, number][] = [];
  for (let i = 0; i < 60; i++) trees.push([500 + (i % 8) * 6, 500 + Math.floor(i / 8) * 6]);
  const zones = new SoundZones([area('water', -200, 200, 400, 30)], frame, true, trees);

  it('колокольчики только у ёлки, собаки — у домов, в лесу ветер тише и птиц больше', () => {
    const tree: [number, number] = [0, 0];
    expect(zones.winterAt([5, 0], 1.7, tree).bells).toBeGreaterThan(0.8);
    expect(zones.winterAt([100, 0], 1.7, tree).bells).toBe(0);
    expect(zones.winterAt([10, 0], 1.7, undefined, [[0, 0]]).village).toBeGreaterThan(0.9);
    expect(zones.winterAt([10, 0], 1.7).village).toBe(0);
    const woods = zones.winterAt([520, 520], 1.7);
    const open = zones.winterAt([-600, -600], 1.7);
    expect(woods.wind).toBeLessThan(open.wind);
    expect(woods.birds).toBeGreaterThan(open.birds);
  });

  it('ручей подо льдом слышен только рядом', () => {
    expect(zones.winterAt([0, 210], 1.7).water).toBeGreaterThan(0.6);
    expect(zones.winterAt([0, 100], 1.7).water).toBe(0);
  });
});
