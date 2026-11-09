import { describe, expect, it } from 'vitest';
import type { Vec2 } from '../walk/localFrame';
import { arcPosition, planEstates, simplify, type EstateBuilding } from './estates';

/** Дом w × h м с центром (x, y). */
const house = (id: string, x: number, y: number, w = 10, h = 8): EstateBuilding => ({
  id,
  ring: [
    [x - w / 2, y - h / 2],
    [x + w / 2, y - h / 2],
    [x + w / 2, y + h / 2],
    [x - w / 2, y + h / 2],
  ],
});

// Улица вдоль оси x на y = 0, шириной 7 м; дома по обе стороны через 24 м, в 12 м от оси.
const road = {
  coords: [
    [-150, 0],
    [250, 0],
  ] as Vec2[],
  width: 7,
};
const north = Array.from({ length: 6 }, (_, i) => house(`n${i}`, i * 24, 12));
const south = Array.from({ length: 6 }, (_, i) => house(`s${i}`, i * 24 + 12, -12));
const shed = house('shed', 0, 30, 4, 5);
const plan = planEstates({
  houses: [...north, ...south],
  sheds: [shed],
  blockers: [],
  roads: [road],
  tracks: [],
});

const inside = ([x, y]: Vec2, ring: readonly Vec2[]) => {
  let result = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) result = !result;
  }
  return result;
};

describe('planEstates', () => {
  it('у каждого дома — участок, и дом на нём', () => {
    expect(plan.plots.length).toBe(12);
    for (const plot of plan.plots) {
      const h = [...north, ...south].find((x) => x.id === plot.id)!;
      const c: Vec2 = [(h.ring[0]![0] + h.ring[2]![0]) / 2, (h.ring[0]![1] + h.ring[2]![1]) / 2];
      expect(inside(c, plot.ring)).toBe(true);
    }
  });

  it('участки не налезают на улицу и друг на друга', () => {
    for (const plot of plan.plots) {
      for (const [, y] of plot.ring) expect(Math.abs(y)).toBeGreaterThanOrEqual(3.5 + 1.5 - 1e-6);
    }
    // Центр каждого участка не внутри чужого.
    for (const a of plan.plots) {
      const c = a.ring.reduce<Vec2>((s, p) => [s[0] + p[0] / a.ring.length, s[1] + p[1] / a.ring.length], [0, 0]);
      for (const b of plan.plots) if (a !== b) expect(inside(c, b.ring)).toBe(false);
    }
  });

  it('соседи по улице — общим забором, вдоль улицы — уличный', () => {
    const shared = plan.runs.filter((r) => r.owners.length === 2);
    expect(shared.length).toBeGreaterThanOrEqual(10);
    for (const r of shared) expect(r.kind).toBe('side');
    const street = plan.runs.filter((r) => r.kind === 'street');
    expect(street.length).toBeGreaterThanOrEqual(12);
    // Уличный забор — у дороги (на углах крайних участков заворачивает на пару метров).
    for (const r of street) for (const [, y] of r.line) expect(Math.abs(y)).toBeLessThanOrEqual(3.5 + 4 + 3 + 1);
  });

  it('ворота — на уличном заборе, в заборе под них вырез', () => {
    const withGate = plan.plots.filter((p) => p.gate);
    expect(withGate.length).toBeGreaterThanOrEqual(10);
    for (const plot of withGate) {
      const run = plan.runs.find((r) => r.kind === 'street' && r.owners[0] === plot.id && arcPosition(r.line, plot.gate!.at).distance < 0.05);
      expect(run).toBeDefined();
      const s = arcPosition(run!.line, plot.gate!.at).s;
      expect(run!.cuts.some(([a, b]) => a <= s && b >= s)).toBe(true);
      // Внутрь участка — от улицы.
      expect(Math.sign(plot.gate!.inward[1])).toBe(Math.sign(plot.n[1]));
    }
  });

  it('во дворах постройки, и они на своём участке', () => {
    const count = plan.plots.reduce((s, p) => s + p.outbuildings.length, 0);
    expect(count).toBeGreaterThanOrEqual(24);
    for (const plot of plan.plots) {
      for (const b of plot.outbuildings) {
        const c = b.rect.reduce<Vec2>((s, p) => [s[0] + p[0] / 4, s[1] + p[1] / 4], [0, 0]);
        expect(inside(c, plot.ring)).toBe(true);
      }
      // Туалет — у всех; там, где уже стоит сарай, свой сарай не придумываем.
      expect(plot.outbuildings.some((b) => b.model === 'outhouse')).toBe(true);
    }
    const withShed = plan.plots.find((p) => inside([0, 30], p.ring))!;
    expect(withShed.outbuildings.some((b) => b.model === 'shed')).toBe(false);
  });

  it('детерминированно', () => {
    const again = planEstates({
      houses: [...north, ...south],
      sheds: [shed],
      blockers: [],
      roads: [road],
      tracks: [],
    });
    expect(JSON.stringify(again)).toBe(JSON.stringify(plan));
  });
});

describe('simplify', () => {
  it('лесенка растра — в прямую', () => {
    const stairs: Vec2[] = [];
    for (let k = 0; k <= 10; k++) stairs.push([k, k], [k + 1, k]);
    expect(simplify(stairs, 0.8)).toEqual([
      [0, 0],
      [11, 10],
    ]);
  });
});
