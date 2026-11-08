import { describe, expect, it } from 'vitest';
import type { Vec2 } from '../walk/localFrame';
import { MAX_FLOOR_LIFT, siteOnSlope } from './siting';

const square: Vec2[] = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];

describe('посадка дома на склон', () => {
  it('на ровном месте пол — на земле', () => {
    expect(siteOnSlope(square, () => 120)).toEqual({ floor: 120, low: 120 });
  });

  it('на склоне пол — по верхней точке, низ стен — по нижней', () => {
    const site = siteOnSlope(square, (x) => 100 + x * 0.1);
    expect(site.low).toBeCloseTo(100, 6);
    expect(site.floor).toBeCloseTo(101, 6);
  });

  it('бугор посреди дома тоже учитывается', () => {
    const site = siteOnSlope(square, (x, y) => (Math.abs(x - 5) < 1 && Math.abs(y - 5) < 1 ? 50.6 : 50));
    expect(site.floor).toBeCloseTo(50.6, 6);
  });

  it('на круче пол поднимается не больше чем на MAX_FLOOR_LIFT', () => {
    const site = siteOnSlope(square, (x) => x);
    expect(site.low).toBe(0);
    expect(site.floor).toBe(MAX_FLOOR_LIFT);
  });

  it('без рельефа — ноль', () => {
    expect(siteOnSlope(square, () => Number.NaN)).toEqual({ floor: 0, low: 0 });
  });
});
