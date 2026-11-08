import { describe, expect, it } from 'vitest';
import { rectWalls, solidWall, type Opening } from './houseParts';

describe('сплошная стена с проёмами', () => {
  const wall = rectWalls(10, 6).front;
  /** Есть ли стена в точке (u, z) фасада. */
  const solidAt = (parts: ReturnType<typeof solidWall>, u: number, z: number) =>
    parts.some((p) => {
      const cu = p.center[0] + 5; // фасад — от x = −5
      return Math.abs(u - cu) < p.size[0] / 2 && Math.abs(z - p.center[2]) < p.size[2] / 2;
    });

  it('края проёмов с дробными координатами не закрывают окна', () => {
    const u = 1 / 3;
    const openings: Opening[] = [
      { u0: 2 + u, u1: 3 + u, z0: 1, z1: 2.5 },
      { u0: 2 + u, u1: 3 + u, z0: 4, z1: 5.5 },
    ];
    const parts = solidWall(wall, 0, 7, 0.4, openings, '#fff', 'brick');
    expect(solidAt(parts, 2.8, 1.7)).toBe(false);
    expect(solidAt(parts, 2.8, 4.7)).toBe(false);
  });

  it('окна этажей друг над другом и дверь под окном — все проёмы открыты', () => {
    const openings: Opening[] = [
      { u0: 2, u1: 3, z0: 1, z1: 2.5 },
      { u0: 2, u1: 3, z0: 4, z1: 5.5 },
      { u0: 6, u1: 7.5, z0: 0, z1: 2.4 },
      { u0: 6.2, u1: 7.3, z0: 3.5, z1: 5 },
    ];
    const parts = solidWall(wall, 0, 7, 0.4, openings, '#fff', 'brick');
    for (const [u, z] of [
      [2.5, 1.7],
      [2.5, 4.7],
      [6.8, 1.2],
      [6.8, 4.2],
    ]) {
      expect(solidAt(parts, u!, z!)).toBe(false);
    }
    // Простенки и перемычки — на месте.
    for (const [u, z] of [
      [2.5, 3.2],
      [2.5, 6.2],
      [1, 3],
      [6.8, 3],
      [6.1, 4],
      [9, 6.5],
    ]) {
      expect(solidAt(parts, u!, z!)).toBe(true);
    }
  });
});
