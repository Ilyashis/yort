import { describe, expect, it } from 'vitest';
import { polygonNormal, simplifyParts, type HousePart, type Vec3 } from './houseParts';
import { HOUSE_MODELS, type HousePlan } from './houseModels';

/** Все точки детали (для проверки габаритов). */
function pointsOf(p: HousePart): Vec3[] {
  if (p.type === 'slab') return p.points;
  if (p.type === 'cylinder') return [p.from, p.to];
  if (p.type === 'blob') {
    const r = Math.max(p.radii[0], p.radii[1]);
    return [
      [p.center[0] - r, p.center[1] - r, p.center[2] - p.radii[2]],
      [p.center[0] + r, p.center[1] + r, p.center[2] + p.radii[2]],
    ];
  }
  const [x, y, z] = p.center;
  const [sx, sy, sz] = p.size;
  const c = Math.cos(p.angle ?? 0);
  const s = Math.sin(p.angle ?? 0);
  const corners: Vec3[] = [];
  for (const i of [-1, 1]) for (const j of [-1, 1]) for (const k of [-1, 1]) {
    const lx = (i * sx) / 2;
    const ly = (j * sy) / 2;
    corners.push([x + lx * c - ly * s, y + lx * s + ly * c, z + (k * sz) / 2]);
  }
  return corners;
}

const allPoints = (plan: HousePlan) => plan.parts.flatMap(pointsOf);

describe('модели башкирских домов', () => {
  for (const model of HOUSE_MODELS) {
    describe(model.name, () => {
      const plan = model.plan();

      it('собирается по умолчанию: детали есть, числа конечные', () => {
        expect(plan.parts.length).toBeGreaterThan(model.group === 'small' ? 8 : model.id === 'yurt' ? 20 : 60);
        for (const p of allPoints(plan)) for (const v of p) expect(Number.isFinite(v)).toBe(true);
        expect(plan.width).toBe(model.width.value);
        expect(plan.depth).toBe(model.depth.value);
      });

      it('разумная высота и всё в пределах участка', () => {
        const [lo, hi, reach] = model.group === 'small' ? [1.5, 5, 2] : model.group === 'public' ? [3, 20, 7.5] : [3, 10, 4];
        expect(plan.height).toBeGreaterThan(lo);
        expect(plan.height).toBeLessThan(hi);
        for (const [x, y, z] of allPoints(plan)) {
          expect(Math.abs(x)).toBeLessThan(plan.width / 2 + Math.min(reach, 3.5));
          expect(Math.abs(y)).toBeLessThan(plan.depth / 2 + reach);
          expect(z).toBeGreaterThan(-0.05);
        }
      });

      it('плиты (скаты, фронтоны, резьба) смотрят наружу', () => {
        for (const p of plan.parts) {
          if (p.type !== 'slab') continue;
          const n = polygonNormal(p.points);
          const c = p.points.reduce<Vec3>((s, q) => [s[0] + q[0] / p.points.length, s[1] + q[1] / p.points.length, s[2] + q[2] / p.points.length], [0, 0, 0]);
          // От середины дома на высоте 1 м; горизонтальные плиты — вверх.
          const out: Vec3 = [c[0], c[1], c[2] - 1];
          expect(n[0] * out[0] + n[1] * out[1] + n[2] * out[2]).toBeGreaterThan(0);
        }
      });

      it('одно зерно — один дом, другое — другая окраска', () => {
        expect(model.plan({ seed: 7 })).toEqual(model.plan({ seed: 7 }));
        const colors = (seed: number) => new Set(model.plan({ seed }).parts.map((p) => ('color' in p ? p.color : '')));
        const variants = new Set([1, 2, 3, 4, 5, 6].map((seed) => [...colors(seed)].sort().join()));
        expect(variants.size).toBeGreaterThan(2);
      });

      it('размеры задаются и обрезаются до допустимых', () => {
        const big = model.plan({ width: 100, depth: 100 });
        expect(big.width).toBe(model.width.max);
        expect(big.depth).toBe(model.depth.max);
        const small = model.plan({ width: 1, depth: 1 });
        expect(small.width).toBe(model.width.min);
        expect(small.depth).toBe(model.depth.min);
      });
    });
  }

  it('на склоне цоколь, крыльцо и подол юрты уходят вниз до земли', () => {
    for (const model of HOUSE_MODELS) {
      const flat = model.plan({ seed: 2 });
      const slope = model.plan({ seed: 2, foundation: 1.2 });
      const lowest = Math.min(...allPoints(slope).map((p) => p[2]));
      expect(lowest).toBeCloseTo(-1.2, 5);
      // Всё, что выше земли, — на месте.
      expect(slope.height).toBeCloseTo(flat.height, 6);
      expect(slope.parts.length).toBe(flat.parts.length);
    }
  });

  it('дальний план проще, но с теми же стёклами, крышей и размерами', () => {
    for (const model of HOUSE_MODELS.filter((m) => m.group === 'house')) {
      const parts = model.plan({ seed: 3 }).parts;
      const far = simplifyParts(parts);
      const weight = (list: HousePart[]) => list.reduce((s, p) => s + (p.type === 'cylinder' ? (p.segments ?? 12) * 4 : p.type === 'slab' ? p.points.length * 2 : 12), 0);
      expect(weight(far)).toBeLessThan(weight(parts) * 0.85);
      expect(far.filter((p) => p.type === 'glass')).toHaveLength(parts.filter((p) => p.type === 'glass').length);
      // Скаты и фронтоны (большие плиты) — все на месте.
      const big = (list: HousePart[]) => list.filter((p) => p.type === 'slab' && Math.hypot(...polygonNormal(p.points)) / 2 >= 0.25).length;
      expect(big(far)).toBe(big(parts));
    }
  });

  it('у домов и общественных зданий есть окна, у юрты, остановки, туалета и колодца — нет', () => {
    for (const model of HOUSE_MODELS) {
      const glass = model.plan().parts.filter((p) => p.type === 'glass').length;
      if (['yurt', 'busstop', 'outhouse', 'well'].includes(model.id)) expect(glass).toBe(0);
      else expect(glass).toBeGreaterThan(model.id === 'banya' ? 0 : model.id === 'shop' ? 2 : 4);
    }
  });

  it('на общественных зданиях — вывески, у школы и конторы — флаги', () => {
    const signs = (id: string) =>
      HOUSE_MODELS.find((m) => m.id === id)!
        .plan()
        .parts.filter((p) => p.type === 'sign')
        .map((p) => (p.type === 'sign' ? p.text : ''));
    expect(signs('school')).toContain('ШКОЛА');
    expect(signs('museum')).toContain('МУЗЕЙ');
    expect(signs('club')).toContain('ДОМ КУЛЬТУРЫ');
    expect(signs('store')).toContain('УНИВЕРМАГ');
    expect(signs('busstop')).toContain('ОСТАНОВКА');
    expect(signs('office').join()).toMatch(/АДМИНИСТРАЦИЯ/);
    expect(signs('shop').join()).toMatch(/МАГАЗИН|ПРОДУКТЫ/);
    expect(HOUSE_MODELS.find((m) => m.id === 'school')!.plan({ width: 45 }).parts.some((p) => p.type === 'sign' && p.text === 'ЛИЦЕЙ')).toBe(true);
    // Флаг Башкортостана: синий, белый, зелёный.
    const colors = new Set(HOUSE_MODELS.find((m) => m.id === 'office')!.plan().parts.map((p) => ('color' in p ? p.color : '')));
    for (const c of ['#0a66b3', '#f4f4f2', '#0c9a4a', '#d52b1e']) expect(colors.has(c)).toBe(true);
  });

  it('ставни соседних окон не налезают друг на друга', () => {
    for (const model of HOUSE_MODELS.filter((m) => m.group === 'house')) {
      for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
        const plan = model.plan({ seed });
        // Стёкла уличного фасада (y ≈ −d/2): расстояние между окнами не меньше ширины окна со ставнями.
        const front = plan.parts.filter((p): p is Extract<HousePart, { type: 'glass' }> => p.type === 'glass' && p.center[1] < -plan.depth / 2 + 0.3 && p.size[0] > 0.7);
        const xs = front.map((p) => p.center[0]).sort((a, b) => a - b);
        for (let i = 1; i < xs.length; i++) expect(xs[i]! - xs[i - 1]!).toBeGreaterThan(front[0]!.size[0] + 0.6);
      }
    }
  });
});
