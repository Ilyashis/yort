import { describe, expect, it } from 'vitest';
import type { Vec2 } from '../walk/localFrame';
import { formatMetres, midpoints, removeVertex, snapPoint } from './snapLine';

const neighbour: Vec2[] = [
  [0, 0],
  [20, 0],
  [20, 15],
];

describe('прилипание точек забора', () => {
  it('к углу соседнего забора', () => {
    expect(snapPoint([20.6, 0.4], [neighbour], 1.5)).toEqual({ point: [20, 0], kind: 'vertex' });
  });

  it('к линии соседнего забора, если угла рядом нет', () => {
    const s = snapPoint([8, 0.7], [neighbour], 1.5);
    expect(s?.kind).toBe('line');
    expect(s?.point[0]).toBeCloseTo(8, 6);
    expect(s?.point[1]).toBeCloseTo(0, 6);
  });

  it('под прямым углом к предыдущему отрезку', () => {
    // Предыдущий отрезок на восток, курсор чуть левее севера от последней точки.
    const s = snapPoint([39.4, 10], [], 1.5, [40, 0], [30, 0]);
    expect(s?.kind).toBe('angle');
    expect(s?.point[0]).toBeCloseTo(40, 1);
    expect(s?.point[1]).toBeGreaterThan(9.9);
  });

  it('далеко от всего и не под прямым углом — без прилипания', () => {
    expect(snapPoint([45, 6], [neighbour], 1.5, [40, 0], [30, 0])).toBeUndefined();
  });
});

describe('изломы готового забора', () => {
  it('середины отрезков', () => {
    expect(midpoints(neighbour)).toEqual([
      [10, 0],
      [20, 7.5],
    ]);
  });

  it('убрать излом — остаётся хотя бы две точки', () => {
    expect(removeVertex(neighbour, 1)).toEqual([
      [0, 0],
      [20, 15],
    ]);
    expect(removeVertex([[0, 0], [1, 0]], 0)).toBeUndefined();
  });

  it('у замкнутого участка излом убирается, контур остаётся замкнутым', () => {
    const ring: Vec2[] = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
    const out = removeVertex(ring, 0)!;
    expect(out).toHaveLength(4);
    expect(out[0]).toEqual(out[out.length - 1]);
  });

  it('метры по-русски', () => {
    expect(formatMetres(12.44)).toBe('12,4 м');
  });
});
