import { describe, expect, it } from 'vitest';
import { planFrontGarden, shiftParts, type GardenStyle } from './frontGarden';
import type { HousePart } from './houseParts';

/** Штакетины фронтального забора: узкие высокие ящики на линии улицы. */
const pickets = (parts: HousePart[], depth: number) =>
  parts.filter((p) => p.type === 'box' && Math.abs(p.center[1] + depth) < 0.01 && p.size[0] < 0.1 && p.size[1] < 0.03 && p.size[2] > 0.5);

const footY = (p: HousePart): number => (p.type === 'cylinder' ? p.from[1] : p.type === 'slab' ? p.points[0]![1] : p.center[1]);
const footX = (p: HousePart): number => (p.type === 'cylinder' ? p.from[0] : p.type === 'slab' ? p.points[0]![0] : p.center[0]);

describe('палисадник', () => {
  it('штакетник прозрачный: штакетины с просветами вдоль всей улицы', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const { parts } = planFrontGarden({ width: 8, depth: 2.5, seed });
      const list = pickets(parts, 2.5).sort((a, b) => footX(a) - footX(b));
      expect(list.length).toBeGreaterThan(35);
      // Доля штакетин по длине — около половины: сквозь забор видно сад.
      const solid = list.reduce((s, p) => s + (p.type === 'box' ? p.size[0] : 0), 0) / 8;
      expect(solid).toBeGreaterThan(0.3);
      expect(solid).toBeLessThan(0.6);
      for (let i = 1; i < list.length; i++) expect(footX(list[i]!) - footX(list[i - 1]!)).toBeGreaterThan(0.1);
    }
  });

  it('всё стоит внутри палисадника (кроме лавочки снаружи у забора и крон над забором)', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const W = 6 + (seed % 5);
      const D = 1 + (seed % 6) * 0.8;
      const { parts } = planFrontGarden({ width: W, depth: D, seed });
      for (const p of parts) {
        const x = footX(p);
        const y = footY(p);
        expect(Math.abs(x)).toBeLessThanOrEqual(W / 2 + 0.1);
        // Лавочка — снаружи у забора, до 0,6 м.
        expect(y).toBeGreaterThanOrEqual(-D - 0.6);
        expect(y).toBeLessThanOrEqual(0);
        // В стену дома (y > 0) не залезают ни кусты, ни цветы, ни кроны.
        if (p.type === 'blob') expect(p.center[1] + p.radii[1] * 0.7).toBeLessThanOrEqual(0.05);
      }
    }
  });

  it('разные сады и заборы по зерну; одно зерно — один и тот же палисадник', () => {
    const styles = new Set<GardenStyle>();
    const colors = new Set<string>();
    for (let seed = 1; seed <= 60; seed++) {
      const g = planFrontGarden({ width: 9, depth: 3, seed });
      styles.add(g.style);
      const first = pickets(g.parts, 3)[0];
      if (first?.type === 'box') colors.add(first.color);
    }
    expect(styles.size).toBe(4);
    expect(colors.size).toBeGreaterThanOrEqual(5);
    expect(planFrontGarden({ width: 7, depth: 2, seed: 5 })).toEqual(planFrontGarden({ width: 7, depth: 2, seed: 5 }));
  });

  it('вдали — тот же сад, но легче: забор полосой, без мелких цветов', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const near = planFrontGarden({ width: 8, depth: 3, seed });
      const far = planFrontGarden({ width: 8, depth: 3, seed, far: true });
      expect(far.style).toBe(near.style);
      expect(far.parts.length).toBeLessThan(near.parts.length / 4);
      expect(far.parts.filter((p) => p.type === 'blob' && Math.max(...p.radii) < 0.25)).toHaveLength(0);
      // Крупные кроны и кусты вдали стоят там же, где вблизи.
      const big = (g: typeof near) => g.parts.filter((p) => p.type === 'blob' && Math.max(...p.radii) >= 0.5).map((p) => (p.type === 'blob' ? p.center.join() : ''));
      const nearBig = new Set(big(near));
      for (const c of big(far)) expect(nearBig.has(c)).toBe(true);
    }
  });

  it('узкая полоса у стены — только штакетник', () => {
    const { parts } = planFrontGarden({ width: 7, depth: 0.6, seed: 3 });
    expect(parts.some((p) => p.type === 'blob')).toBe(false);
    expect(pickets(parts, 0.6).length).toBeGreaterThan(30);
  });

  it('сдвиг к фасаду переносит все детали', () => {
    const { parts } = planFrontGarden({ width: 7, depth: 2, seed: 2 });
    const moved = shiftParts(parts, 1, -4);
    moved.forEach((p, i) => {
      expect(footX(p)).toBeCloseTo(footX(parts[i]!) + 1, 9);
      expect(footY(p)).toBeCloseTo(footY(parts[i]!) - 4, 9);
    });
  });
});
