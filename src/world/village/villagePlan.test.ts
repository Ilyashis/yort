import { describe, expect, it } from 'vitest';
import type { Vec2 } from '../walk/localFrame';
import { modelPlacement } from '../edit/edits';
import { MAX_SCALE, MIN_SCALE, chooseVillageModel, drawnRect, fitPreset, modelFacadeShift, sizePresets } from './villagePlan';
import { HOUSE_MODELS } from './houseModels';

/** Прямоугольник w (вдоль x) × d (вдоль y) с центром (cx, cy). */
const rect = (w: number, d: number, cx = 0, cy = 0): Vec2[] => [
  [cx - w / 2, cy - d / 2],
  [cx + w / 2, cy - d / 2],
  [cx + w / 2, cy + d / 2],
  [cx - w / 2, cy + d / 2],
];
/** Улица вдоль x южнее домов (y = −20). */
const street: Vec2[] = [
  [-500, -20],
  [500, -20],
];

describe('модели для домов деревни', () => {
  it('маленькая постройка — баня', () => {
    expect(chooseVillageModel('a', rect(4, 6), [street])?.model).toBe('banya');
  });

  it('сарай и гараж любого размера — хозпостройка, школа и мечеть — не изба', () => {
    expect(chooseVillageModel('s', rect(7, 9), [street], 'shed')?.model).toBe('banya');
    expect(chooseVillageModel('g', rect(6, 8), [street], 'garage')?.model).toBe('banya');
    expect(chooseVillageModel('h', rect(7, 9), [street], 'house')?.model).not.toBe('banya');
    expect(chooseVillageModel('k', rect(9, 12), [street], 'school')).toBeUndefined();
    expect(chooseVillageModel('m', rect(9, 12), [street], 'mosque')).toBeUndefined();
  });

  it('узким торцом к улице — дома с фронтоном на улицу', () => {
    for (let i = 0; i < 30; i++) {
      const house = chooseVillageModel(`n${i}`, rect(7, 10), [street])!;
      expect(['izba', 'pyatistenok', 'veranda']).toContain(house.model);
      // Фасад — короткая южная сторона.
      expect(modelPlacement(house.rect).width).toBeCloseTo(7, 6);
    }
  });

  it('длинной стороной к улице — дома с длинным фасадом', () => {
    for (let i = 0; i < 30; i++) {
      const house = chooseVillageModel(`w${i}`, rect(11, 8), [street])!;
      expect(['hipped', 'brick']).toContain(house.model);
      expect(modelPlacement(house.rect).width).toBeCloseTo(11, 6);
    }
  });

  it('фермы, длинные сараи и Г-образные дома остаются как есть', () => {
    expect(chooseVillageModel('farm', rect(60, 12), [street])).toBeUndefined();
    expect(chooseVillageModel('barn', rect(18, 4), [street])).toBeUndefined();
    const lShape: Vec2[] = [
      [0, 0],
      [12, 0],
      [12, 3],
      [3, 3],
      [3, 12],
      [0, 12],
    ];
    expect(chooseVillageModel('l', lShape, [street])).toBeUndefined();
  });

  it('по деревне — разные модели и окраски; один дом — всегда одна и та же', () => {
    const models = new Set<string>();
    const seeds = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const w = 5 + (i % 7);
      const d = 6 + ((i * 3) % 7);
      const house = chooseVillageModel(`h${i}`, rect(w, d), [street]);
      if (!house) continue;
      models.add(house.model);
      seeds.add(house.seed);
    }
    expect(models.size).toBeGreaterThanOrEqual(5);
    expect(seeds.size).toBeGreaterThanOrEqual(3);
    expect(chooseVillageModel('x', rect(7, 9), [street])).toEqual(chooseVillageModel('x', rect(7, 9), [street]));
  });

  it('размер модели — ближайший из трёх, растяжка в пределах', () => {
    for (const model of HOUSE_MODELS.filter((m) => m.group === 'house')) {
      const presets = sizePresets(model.id);
      expect(presets).toHaveLength(3);
      const [w, d] = presets[1]!;
      expect(fitPreset(model.id, w, d)).toEqual({ preset: 1, size: [w, d], scale: [1, 1] });
      const huge = fitPreset(model.id, 100, 100);
      expect(huge.preset).toBe(2);
      expect(huge.scale).toEqual([MAX_SCALE, MAX_SCALE]);
      expect(fitPreset(model.id, 1, 1).scale).toEqual([MIN_SCALE, MIN_SCALE]);
    }
  });

  it('фасад модели относительно контура OSM: палисадник начинается от стены модели', () => {
    // Изба по заготовке: стена модели — на толщину стены дальше контура (контур — по оси сруба модели).
    const house = chooseVillageModel('f', rect(7, 10), [street])!;
    const place = modelPlacement(house.rect);
    const fit = fitPreset(house.model, place.width, place.depth);
    const d = fit.size[1] * fit.scale[1];
    const shift = modelFacadeShift(house, [0, -5], [0, -1]);
    expect(shift).toBeCloseTo(d / 2 + 0.15 - 5, 6);
    // Огромный контур: модель не растягивается больше чем в 1,25 раза — её фасад глубже контура.
    const big = chooseVillageModel('big', rect(12, 21), [street]);
    expect(big).toBeDefined();
    expect(modelFacadeShift(big!, [0, -10.5], [0, -1])).toBeLessThan(-1);
  });
});

describe('прямоугольник модели', () => {
  it('сжимается к середине вдоль и поперёк фасада, углы — по порядку', () => {
    const rect: [number, number][] = [
      [0, 0],
      [20, 0],
      [20, 10],
      [0, 10],
    ];
    const out = drawnRect(rect, 10, 6);
    expect(out.map((p) => p.map((v) => Math.round(v * 1000) / 1000))).toEqual([
      [5, 2],
      [15, 2],
      [15, 8],
      [5, 8],
    ]);
  });
});
