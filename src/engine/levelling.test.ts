import { describe, expect, it } from 'vitest';
import type { P2 } from '../core/geo';
import { applyLines, applyShapes, applySpots, computeLevels, fitPlaneAt, monotone, type LevelInput } from './levelling';

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
    // Далеко от дома площадки нет: земля только слегка сглажена (бугры), а не подтянута к высоте дома.
    expect(Math.abs(lev[0])).toBeLessThan(0.5);
    expect(Math.abs(g.natural[0] + lev[0] - level)).toBeGreaterThan(2);
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

  it('плоскость по области: ровно внутри, с заданным уклоном, за краем земля прежняя', () => {
    const g = grid(slope);
    const lev = new Float32Array(g.natural.length);
    const k = (x: number, z: number) => (z / 3) * g.nx + x / 3;
    // Поднимается на восток (90°) на 10 %.
    applyShapes(g, lev, [{ kind: 'plane', x: 60, z: 60, radius: 20, edge: 0.3, height: 7, slope: 10, bearing: 90 }]);
    const h = (x: number, z: number) => g.natural[k(x, z)] + lev[k(x, z)];
    expect(h(60, 60)).toBeCloseTo(7, 4);
    expect(h(66, 60)).toBeCloseTo(7.6, 4);
    expect(h(60, 66)).toBeCloseTo(7, 4);
    expect(lev[k(90, 60)]).toBe(0);
    // «Как было» возвращает естественную землю.
    applyShapes(g, lev, [{ kind: 'natural', x: 60, z: 60, radius: 30, edge: 0.1 }]);
    expect(Math.abs(lev[k(60, 60)])).toBeLessThan(1e-5);
  });

  it('сглаживание убирает рябь, плоскость по земле находит её уклон', () => {
    const g = grid(slope);
    const lev = new Float32Array(g.natural.length);
    const k = (x: number, z: number) => (z / 3) * g.nx + x / 3;
    const rough = (get: (x: number) => number) => Math.abs(get(57) - 2 * get(60) + get(63));
    applyShapes(g, lev, [{ kind: 'smooth', x: 60, z: 60, radius: 24, edge: 0.3 }]);
    expect(rough((x) => g.natural[k(x, 60)] + lev[k(x, 60)])).toBeLessThan(rough((x) => g.natural[k(x, 60)]));
    const plane = fitPlaneAt((x, z) => x * 0.08 + z * 0, 60, 60, 12);
    expect(plane.slope).toBeCloseTo(8, 3);
    expect(plane.bearing).toBeCloseTo(90, 3);
    expect(plane.height).toBeCloseTo(4.8, 3);
  });

  it('лассо: поднимает землю только внутри контура, у границы — плавно', () => {
    const g = grid(slope);
    const lev = new Float32Array(g.natural.length);
    const k = (x: number, z: number) => (z / 3) * g.nx + x / 3;
    const ring: P2[] = [[30, 30], [78, 30], [78, 54], [54, 54], [54, 78], [30, 78]];
    applyShapes(g, lev, [{ kind: 'lift', x: 50, z: 50, radius: 22, edge: 0.25, ring, lift: 2 }]);
    expect(lev[k(42, 42)]).toBeCloseTo(2, 4);
    expect(lev[k(33, 42)]).toBeGreaterThan(0);
    expect(lev[k(33, 42)]).toBeLessThan(2);
    // Вырез «буквы Г» и всё снаружи не тронуты.
    expect(lev[k(66, 66)]).toBe(0);
    expect(lev[k(90, 42)]).toBe(0);
  });

  it('проведённая горизонталь: вдоль линии — её высота, за радиусом земля прежняя', () => {
    const g = grid(slope);
    const lev = new Float32Array(g.natural.length);
    const k = (x: number, z: number) => (z / 3) * g.nx + x / 3;
    applyLines(g, lev, [{ pts: [[30, 60], [60, 45], [90, 60]], height: 5, radius: 12 }]);
    const h = (x: number, z: number) => g.natural[k(x, z)] + lev[k(x, z)];
    expect(h(30, 60)).toBeCloseTo(5, 3);
    expect(h(60, 45)).toBeCloseTo(5, 3);
    expect(h(90, 60)).toBeCloseTo(5, 3);
    expect(lev[k(60, 75)]).toBe(0);
    expect(lev[k(60, 21)]).toBe(0);
    // Рядом с линией земля между её высотой и прежней.
    const near = h(60, 51), was = g.natural[k(60, 51)];
    expect(Math.abs(near - 5)).toBeLessThan(Math.abs(was - 5));
  });

  it('соседние дома не стоят ступеньками, улица без бугров', () => {
    // Ровный уклон 4 % на восток и «шум» съёмки: бугры по полметра через каждые несколько метров.
    const bumpy = (x: number, z: number) => x * 0.04 + Math.sin(x * 0.9) * 0.5 + Math.cos(z * 1.1) * 0.5;
    const g = grid(bumpy, 180);
    const houses = [0, 1, 2, 3, 4].map((n) => ({ id: `h${n}`, ring: [[30 + n * 27, 60], [42 + n * 27, 60], [42 + n * 27, 70], [30 + n * 27, 70]] as P2[] }));
    const road = { pts: [[0, 90], [180, 90]] as P2[], width: 6 };
    const { lev, houseLevel } = computeLevels({ ...g, houses, roads: [road], water: [] });
    // Дома идут вверх по склону ровными шагами: каждый выше соседа примерно на уклон × расстояние (1,08 м).
    const levels = houses.map((h) => houseLevel.get(h.id)!);
    for (let n = 1; n + 1 < levels.length; n++) expect(Math.abs(levels[n + 1] - 2 * levels[n] + levels[n - 1])).toBeLessThan(0.25);
    // Полотно улицы: изломы между соседними узлами — сантиметры, а не дециметры, как у исходной земли.
    const k = (x: number) => (90 / 3) * g.nx + x / 3;
    const rough = (get: (x: number) => number) => Math.max(...[30, 60, 90, 120, 150].map((x) => Math.abs(get(x + 3) - 2 * get(x) + get(x - 3))));
    expect(rough((x) => g.natural[k(x)] + lev[k(x)])).toBeLessThan(0.08);
    expect(rough((x) => g.natural[k(x)])).toBeGreaterThan(0.3);
  });

  it('монотонная последовательность', () => {
    expect(monotone([1, 3, 2, 4])).toEqual([1, 2.5, 2.5, 4]);
  });
});
