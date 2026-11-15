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

describe('planEstates: лес и вода', () => {
  // Лес — круг на 4000 точек радиусом 600 м, в нём поляна радиусом 90 м, где и стоит деревня.
  const circle = (r: number, n: number): Vec2[] => Array.from({ length: n }, (_, k) => [60 + r * Math.cos((k / n) * 2 * Math.PI), r * Math.sin((k / n) * 2 * Math.PI)]);
  const forest = { rings: [circle(600, 4000), circle(90, 2000)], margin: 0 };

  it('огромный контур леса не тормозит, а на поляне участки есть', () => {
    const t0 = performance.now();
    const inForest = planEstates({ houses: [...north, ...south], sheds: [], blockers: [forest], roads: [road], tracks: [] });
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(inForest.plots.length).toBe(12);
    // Участки — только на поляне (лес — ничья земля).
    for (const plot of inForest.plots) for (const [x, y] of plot.ring) expect(Math.hypot(x - 60, y)).toBeLessThan(90 + 1.5);
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

describe('участки по кадастру', () => {
  it('дом на кадастровом участке получает ровно его, соседний — не заходит', () => {
    // Узкий длинный участок под n1 (x 18…30, от улицы до 70 м) и широкий под n2 (x 30…60).
    const narrow: Vec2[] = [
      [18, 5],
      [30, 5],
      [30, 70],
      [18, 70],
    ];
    const wide: Vec2[] = [
      [30, 5],
      [60, 5],
      [60, 40],
      [30, 40],
    ];
    const withParcels = planEstates({ houses: north.slice(0, 4), sheds: [], blockers: [], roads: [road], tracks: [], parcels: [narrow, wide] });
    const area = (ring: readonly Vec2[]) => Math.abs(ring.reduce((s, [x, y], i) => s + x * ring[(i + 1) % ring.length]![1] - ring[(i + 1) % ring.length]![0] * y, 0) / 2);
    const n1 = withParcels.plots.find((p) => p.id === 'n1:0' || p.id === 'n1')!;
    const n2 = withParcels.plots.find((p) => p.id === 'n2:0' || p.id === 'n2')!;
    // Площадь — как у кадастрового (растр 1 м даёт погрешность по краю).
    expect(Math.abs(area(n1.ring) - area(narrow)) / area(narrow)).toBeLessThan(0.12);
    expect(Math.abs(area(n2.ring) - area(wide)) / area(wide)).toBeLessThan(0.12);
    // Соседний n0 (без кадастра) не заходит на участок n1.
    const n0 = withParcels.plots.find((p) => p.id === 'n0:0' || p.id === 'n0')!;
    expect(n0.ring.every(([x]) => x <= 18.8)).toBe(true);
  });
});

describe('прямые заборы', () => {
  it('косая кадастровая граница — забор одной прямой по ней, без лесенки', () => {
    // Два участка с общей косой границей от (30, 5) до (40, 60).
    const left: Vec2[] = [
      [6, 5],
      [30, 5],
      [40, 60],
      [16, 60],
    ];
    const right: Vec2[] = [
      [30, 5],
      [56, 5],
      [66, 60],
      [40, 60],
    ];
    const plan = planEstates({ houses: [house('a', 22, 14), house('b', 46, 14)], sheds: [], blockers: [], roads: [road], tracks: [], parcels: [left, right] });
    const side = plan.runs.find((r) => r.kind === 'side' && r.owners.length === 2);
    expect(side).toBeDefined();
    // Все точки — на кадастровой линии (не дальше 0,3 м), а точек — немного: прямая, а не лесенка.
    const dist = ([x, y]: Vec2) => {
      const [ax, ay] = [30, 5];
      const [dx, dy] = [10, 55];
      return Math.abs((x - ax) * dy - (y - ay) * dx) / Math.hypot(dx, dy);
    };
    for (const p of side!.line) expect(dist(p)).toBeLessThan(0.3);
    expect(side!.line.length).toBeLessThanOrEqual(4);
  });

  it('без кадастра лесенка растра спрямляется: отрезки длиннее клетки', () => {
    const plan = planEstates({ houses: [...north, ...south], sheds: [], blockers: [], roads: [road], tracks: [] });
    const lens = plan.runs.flatMap((r) => r.line.slice(1).map((b, i) => Math.hypot(b[0] - r.line[i]![0], b[1] - r.line[i]![1])));
    const short = lens.filter((l) => l < 1.6).length;
    expect(short / lens.length).toBeLessThan(0.15);
  });
});
