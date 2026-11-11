import { describe, expect, it } from 'vitest';
import { Frame, hash01, insetRing, normalizeRing, obb, pointInPoly, signedArea, type P2 } from './geo';

const rect: P2[] = [[0, 0], [10, 0], [10, 4], [0, 4]];

describe('geo', () => {
  it('переводит градусы в метры и обратно', () => {
    const f = new Frame({ south: 54.71, west: 55.92, north: 54.73, east: 55.96 });
    const [x, z] = f.xz(55.95, 54.725);
    expect(f.lon(x)).toBeCloseTo(55.95, 9);
    expect(f.lat(z)).toBeCloseTo(54.725, 9);
    expect(z).toBeLessThan(0); // север — в сторону −z
  });

  it('приводит кольцо к нужному обходу и убирает замыкающую точку', () => {
    const ring = normalizeRing([...rect, rect[0]].reverse(), true);
    expect(ring).toHaveLength(4);
    expect(signedArea(ring)).toBeCloseTo(40);
  });

  it('находит описанный прямоугольник: длинная ось и заполнение', () => {
    const box = obb(rect);
    expect(box.L).toBeCloseTo(5);
    expect(box.W).toBeCloseTo(2);
    expect(box.fill).toBeCloseTo(1);
    expect(Math.abs(box.ux)).toBeCloseTo(1);
  });

  it('сдвигает контур внутрь и отказывается, когда он схлопывается', () => {
    const inner = insetRing(rect, 1)!;
    expect(signedArea(inner)).toBeCloseTo(8 * 2);
    expect(insetRing(rect, 2.5)).toBeNull();
  });

  it('учитывает дворы в проверке «точка внутри»', () => {
    const hole: P2[] = [[4, 1], [4, 3], [6, 3], [6, 1]];
    expect(pointInPoly(2, 2, [rect, hole])).toBe(true);
    expect(pointInPoly(5, 2, [rect, hole])).toBe(false);
  });

  it('даёт устойчивый хэш 0..1', () => {
    expect(hash01('way/1')).toBe(hash01('way/1'));
    expect(hash01('way/1')).not.toBe(hash01('way/1', 2));
    expect(hash01('way/1')).toBeGreaterThanOrEqual(0);
    expect(hash01('way/1')).toBeLessThan(1);
  });
});
