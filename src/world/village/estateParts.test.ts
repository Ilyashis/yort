import { describe, expect, it } from 'vitest';
import type { EstateGate, FenceRun, FenceStyle } from './estates';
import { fenceParts, gateParts, propParts } from './estateParts';
import type { HousePart } from './houseParts';

const run = (style: FenceStyle, cuts: [number, number][] = []): FenceRun => ({
  owners: ['a'],
  kind: 'street',
  line: [
    [0, 0],
    [20, 0],
  ],
  cuts,
  style,
  color: '#8a6a48',
  height: 1.8,
  seed: 7,
});

/** Где деталь вдоль x (центр ящика или начало цилиндра). */
const xOf = (p: HousePart) => (p.type === 'cylinder' ? p.from[0] : p.type === 'slab' ? p.points[0]![0] : p.center[0]);

describe('заборы посёлка', () => {
  it('у каждого вида — свои детали, вблизи подробнее, чем вдали', () => {
    for (const style of ['boards', 'metal', 'picket', 'slats', 'rails'] as const) {
      const near = fenceParts(run(style), false);
      const far = fenceParts(run(style), true);
      expect(near.length).toBeGreaterThan(0);
      expect(far.length).toBeLessThanOrEqual(near.length);
    }
    // Штакетник вблизи — планками, вдали — сплошной полосой.
    expect(fenceParts(run('picket'), false).length).toBeGreaterThan(5 * fenceParts(run('picket'), true).length);
  });

  it('в вырезе (ворота, стена сарая) забора нет', () => {
    const parts = fenceParts(run('boards', [[8, 12]]), false);
    for (const p of parts) {
      const x = xOf(p);
      expect(x <= 8 + 1e-6 || x >= 12 - 1e-6).toBe(true);
    }
  });

  it('забор стоит на земле: низ чуть в земле, верх — на высоте забора', () => {
    for (const p of fenceParts(run('metal'), false)) {
      if (p.type !== 'box') continue;
      expect(p.center[2] - p.size[2] / 2).toBeLessThan(0);
      expect(p.center[2] + p.size[2] / 2).toBeLessThan(2.1);
    }
  });
});

describe('ворота и мелочь двора', () => {
  const gate: EstateGate = { at: [10, 0], along: [1, 0], inward: [0, 1], gate: 3.2, wicket: 1, wicketSide: -1, canopy: true, style: 'boards', color: '#4f7a54' };

  it('ворота — в своём проёме: три столба, створки и калитка, козырёк', () => {
    const parts = gateParts(gate, 1.8, false);
    const half = (3.2 + 0.2 + 1) / 2;
    for (const p of parts) {
      if (p.type !== 'box') continue;
      // Ничего не вылезает за проём дальше перекладины козырька.
      expect(Math.abs(p.center[0] - 10)).toBeLessThanOrEqual(half + 0.3);
    }
    const posts = parts.filter((p) => p.type === 'box' && p.size[0] === 0.18);
    expect(posts).toHaveLength(3);
    expect(parts.some((p) => p.type === 'slab')).toBe(true);
    // Без ворот — только калитка между двумя столбами.
    expect(gateParts({ ...gate, gate: 0, canopy: false }, 1.8, false).filter((p) => p.type === 'box' && p.size[0] === 0.18)).toHaveLength(2);
  });

  it('мелочь встаёт в свою точку', () => {
    for (const kind of ['woodpile', 'beehive', 'haystack', 'doghouse', 'bench', 'compost'] as const) {
      const parts = propParts({ kind, at: [50, -20], angle: 0.7, length: 2, seed: 3 }, false);
      expect(parts.length).toBeGreaterThan(0);
      for (const p of parts) expect(Math.hypot(xOf(p) - 50, (p.type === 'cylinder' ? p.from[1] : p.type === 'slab' ? p.points[0]![1] : p.center[1]) + 20)).toBeLessThan(2.5);
    }
  });
});
