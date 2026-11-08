import { describe, expect, it } from 'vitest';
import type { Vec2 } from '../walk/localFrame';
import { convexOverlap, planYards, type YardHouse } from './yards';

/** Дом w × h м с центром (x, y). */
const house = (id: string, x: number, y: number, w = 10, h = 8): YardHouse => ({
  id,
  ring: [
    [x - w / 2, y - h / 2],
    [x + w / 2, y - h / 2],
    [x + w / 2, y + h / 2],
    [x - w / 2, y + h / 2],
  ],
});

// Улица вдоль оси x на y = 0, шириной 7 м; дома по обе стороны, через 22 м, в 10 м от оси.
const road = { coords: [[-100, 0], [200, 0]] as Vec2[], width: 7 };
const north = Array.from({ length: 6 }, (_, i) => house(`n${i}`, i * 22, 14));
const south = Array.from({ length: 6 }, (_, i) => house(`s${i}`, i * 22 + 11, -14));
const shed = house('shed', 0, 30, 4, 4);
const yards = planYards([...north, ...south, shed], [road]);

describe('planYards', () => {
  it('у каждого дома (но не у сарая) — свой двор', () => {
    expect(yards.length).toBe(12);
    expect(yards.some((y) => y.houseId === 'shed')).toBe(false);
  });

  it('дворы не налезают друг на друга, на чужие дома и на улицу', () => {
    for (const yard of yards) {
      for (const other of yards) if (other !== yard) expect(convexOverlap(yard.corners, other.corners)).toBe(false);
      for (const h of [...north, ...south]) {
        if (h.id !== yard.houseId) expect(convexOverlap(yard.corners, h.ring)).toBe(false);
      }
      // Ось улицы — y = 0, полуширина 3,5 м: углы двора дальше от неё.
      for (const [, y] of yard.corners) expect(Math.abs(y)).toBeGreaterThan(3.5);
    }
  });

  it('двор смотрит на улицу: уличная сторона ближе к ней, чем дом; сзади — огород', () => {
    const yard = yards.find((y) => y.houseId === 'n2')!;
    const [c0, c1] = yard.corners;
    expect(Math.abs(c0[1])).toBeLessThan(10);
    expect(Math.abs(c1[1])).toBeLessThan(10);
    expect(yard.garden).toBeDefined();
    expect(Math.min(...yard.garden!.corners.map(([, y]) => y))).toBeGreaterThan(18);
  });

  it('в заборе есть ворота: уличная сторона прервана', () => {
    const yard = yards.find((y) => y.houseId === 'n2')!;
    const [c0, c1] = yard.corners;
    const streetLength = Math.hypot(c1[0] - c0[0], c1[1] - c0[1]);
    const streetFence = yard.fence.filter(([a, b]) => Math.abs(a[1] - c0[1]) < 1e-6 && Math.abs(b[1] - c0[1]) < 1e-6);
    const fenced = streetFence.reduce((sum, [a, b]) => sum + Math.hypot(b[0] - a[0], b[1] - a[1]), 0);
    expect(fenced).toBeLessThan(streetLength - 2.5);
    expect(fenced).toBeGreaterThan(0);
  });

  it('перед домом — палисадник от стены до улицы шириной с фасад; уличный забор напротив него вырезан, ворота — сбоку', () => {
    const yard = yards.find((y) => y.houseId === 'n2')!;
    const p = yard.palisade!;
    expect(p).toBeDefined();
    // Дом n2: центр (44, 14), 10 × 8 — фасад на y = 10, к улице — вниз.
    expect(p.origin[0]).toBeCloseTo(44, 6);
    expect(p.origin[1]).toBeCloseTo(10, 6);
    expect(p.toStreet[1]).toBeCloseTo(-1, 6);
    expect(p.width).toBeCloseTo(10, 6);
    const [c0] = yard.corners;
    expect(p.depth).toBeCloseTo(10 - c0[1], 6);
    expect(p.depth).toBeGreaterThanOrEqual(1);
    // Забор по улице не заходит на фасад: x от 39 до 49 свободен (там штакетник палисадника).
    const street = yard.fence.filter(([a, b]) => Math.abs(a[1] - c0[1]) < 1e-6 && Math.abs(b[1] - c0[1]) < 1e-6);
    for (const [a, b] of street) {
      const lo = Math.min(a[0], b[0]);
      const hi = Math.max(a[0], b[0]);
      expect(hi <= 39 + 1e-6 || lo >= 49 - 1e-6).toBe(true);
    }
    // Ворота остались: уличный забор по бокам от палисадника короче, чем сами бока.
    const sides = 2 * (Math.hypot(yard.corners[1][0] - yard.corners[0][0], yard.corners[1][1] - yard.corners[0][1]) / 2 - 5);
    const fenced = street.reduce((sum, [a, b]) => sum + Math.hypot(b[0] - a[0], b[1] - a[1]), 0);
    expect(fenced).toBeLessThan(sides - 1);
  });

  it('дом у самой дороги — без палисадника', () => {
    const close = planYards([house('c', 0, 4.6)], [road]);
    expect(close[0]?.palisade).toBeUndefined();
  });
});
