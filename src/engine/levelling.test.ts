import { describe, expect, it } from 'vitest';
import type { P2 } from '../core/geo';
import { applySpots, computeLevels, monotone, type LevelInput } from './levelling';

/** Сетка 3 м на склоне: земля поднимается на восток, с рябью. */
function grid(height: (x: number, z: number) => number, size = 120): Omit<LevelInput, 'houses' | 'roads' | 'water'> {
  const step = 3, n = size / step + 1;
  const natural = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) natural[j * n + i] = height(i * step, j * step);
  return { rect: { x0: 0, z0: 0, x1: size, z1: size }, step, nx: n, nz: n, natural };
}
const slope = (x: number, z: number) => x * 0.08 + Math.sin(x * 0.7) * 0.3 + Math.cos(z * 0.9) * 0.3;
const house: P2[] = [[50, 50], [62, 50], [62, 60], [50, 60]];

describe('выравнивание земли', () => {
  it('под домом и вокруг него земля ровная', () => {
    const g = grid(slope);
    const { lev, houseLevel } = computeLevels({ ...g, houses: [{ id: 'a', ring: house }], roads: [], water: [] });
    const level = houseLevel.get('a')!;
    for (let x = 45; x <= 66; x += 3) for (let z = 45; z <= 63; z += 3) {
      const k = (z / 3) * g.nx + x / 3;
      expect(g.natural[k] + lev[k]).toBeCloseTo(level, 3);
    }
    // Далеко от дома земля не тронута.
    expect(lev[0]).toBe(0);
  });

  it('подъём участка поднимает двор и улицу рядом', () => {
    const g = grid(() => 10);
    const road = { pts: [[0, 75], [120, 75]] as P2[], width: 6 };
    const flat = computeLevels({ ...g, houses: [{ id: 'a', ring: house }], roads: [road], water: [] });
    const up = computeLevels({ ...g, houses: [{ id: 'a', ring: house, lift: 1 }], roads: [road], water: [] });
    const k = (75 / 3) * g.nx + 57 / 3;
    expect(up.houseLevel.get('a')! - flat.houseLevel.get('a')!).toBeCloseTo(1, 5);
    expect(up.lev[k] - flat.lev[k]).toBeGreaterThan(0.6);
    // В конце улицы, далеко от дома, полотно на прежней высоте.
    expect(Math.abs(up.lev[(75 / 3) * g.nx] - flat.lev[(75 / 3) * g.nx])).toBeLessThan(0.05);
  });

  it('река течёт только вниз и поперёк ровная', () => {
    const g = grid((x, z) => 20 - x * 0.05 + Math.sin(x * 0.5) * 0.6 + Math.sin(z * 1.3) * 0.4);
    const river: P2[] = [[6, 54], [114, 54], [114, 66], [6, 66]];
    const { lev } = computeLevels({ ...g, houses: [], roads: [], water: [[river]] });
    const h = (x: number, z: number) => g.natural[(z / 3) * g.nx + x / 3] + lev[(z / 3) * g.nx + x / 3];
    for (let x = 9; x <= 108; x += 3) {
      expect(h(x + 3, 60)).toBeLessThanOrEqual(h(x, 60) + 1e-4);
      expect(Math.abs(h(x, 57) - h(x, 63))).toBeLessThan(0.2);
    }
  });

  it('пруд — одна высота', () => {
    const g = grid(slope);
    const pond: P2[] = [[30, 30], [60, 30], [60, 60], [30, 60]];
    const { lev } = computeLevels({ ...g, houses: [], roads: [], water: [[pond]] });
    const h = (x: number, z: number) => g.natural[(z / 3) * g.nx + x / 3] + lev[(z / 3) * g.nx + x / 3];
    expect(h(33, 33)).toBeCloseTo(h(57, 57), 4);
  });

  it('земля проходит через опорные отметки и не меняется за их радиусом', () => {
    const g = grid(slope);
    const lev = new Float32Array(g.natural.length);
    const k = (x: number, z: number) => (z / 3) * g.nx + x / 3;
    applySpots(g, lev, [
      { x: 60, z: 60, height: g.natural[k(60, 60)] + 2, radius: 15 },
      { x: 69, z: 60, height: g.natural[k(69, 60)] - 1, radius: 15 },
    ]);
    expect(lev[k(60, 60)]).toBeCloseTo(2, 2);
    expect(lev[k(69, 60)]).toBeCloseTo(-1, 2);
    // Между отметками поправка — между их значениями, далеко от обеих — ноль.
    expect(lev[k(63, 60)]).toBeGreaterThan(-1);
    expect(lev[k(63, 60)]).toBeLessThan(2);
    expect(lev[k(60, 90)]).toBe(0);
    expect(lev[k(30, 60)]).toBe(0);
  });

  it('монотонная последовательность', () => {
    expect(monotone([1, 3, 2, 4])).toEqual([1, 2.5, 2.5, 4]);
  });
});
