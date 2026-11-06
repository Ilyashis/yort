import { booleanPointInPolygon, polygon } from '@turf/turf';
import { describe, expect, it } from 'vitest';
import { createLocalFrame, type Vec2 } from '../walk/localFrame';
import { defaultSpec, generateBuilding, insetPolygon, isConvex, validateSpec } from './building';
import type { LonLat } from './plot';

const frame = createLocalFrame([55.946, 54.7225]);
const plotFrom = (points: Vec2[]): LonLat[] => points.map(frame.toLonLat);
/** Участок 30 × 40 м. */
const rect = plotFrom([[0, 0], [30, 0], [30, 40], [0, 40]]);
/** Г-образный (вогнутый) участок. */
const lShape = plotFrom([[0, 0], [40, 0], [40, 15], [15, 15], [15, 40], [0, 40]]);

describe('generateBuilding', () => {
  it('строит жилой дом с отступом 3 м: пятно внутри участка, площадь и высота считаются', () => {
    const { building, issues, warnings } = generateBuilding(defaultSpec('residential'), rect);
    expect(issues).toEqual([]);
    expect(warnings).toEqual([]);
    expect(building).toBeDefined();
    // (30 − 6) × (40 − 6) = 816 м²
    expect(building!.footprintArea).toBeGreaterThan(800);
    expect(building!.footprintArea).toBeLessThan(830);
    expect(building!.wallHeight).toBeCloseTo(27, 5);
    expect(building!.grossArea).toBeCloseTo(building!.footprintArea * 9, 5);
    const plotShape = polygon([[...rect, rect[0]!]]);
    expect(building!.footprint.every((p) => booleanPointInPolygon(p, plotShape))).toBe(true);
  });

  it('скатная крыша добавляет конёк, на вогнутом контуре — плоская с предупреждением', () => {
    const house = generateBuilding({ ...defaultSpec('house'), setback: 2 }, rect);
    expect(house.building!.roof).toBe('pitched');
    expect(house.building!.ridgeHeight).toBeGreaterThan(1.5);
    expect(house.building!.totalHeight).toBeCloseTo(house.building!.wallHeight + house.building!.ridgeHeight, 5);

    const onL = generateBuilding({ ...defaultSpec('house'), setback: 1 }, lShape);
    expect(onL.building!.roof).toBe('flat');
    expect(onL.warnings).toHaveLength(1);
  });

  it('слишком большой отступ — ошибка, здание не строится', () => {
    const result = generateBuilding({ ...defaultSpec('residential'), setback: 16 }, rect);
    expect(result.building).toBeUndefined();
    expect(result.issues.map((i) => i.code)).toEqual(['setback-too-large']);
  });

  it('слишком высокое здание — ошибка', () => {
    const result = generateBuilding({ ...defaultSpec('tower'), floors: 40, floorHeight: 4.5 }, rect);
    expect(result.issues.map((i) => i.code)).toContain('too-tall');
  });
});

describe('validateSpec', () => {
  it('ловит значения вне допустимых границ (например, из ответа ИИ)', () => {
    const codes = validateSpec({ ...defaultSpec('office'), floors: 0, floorHeight: 9, setback: -1, facadeColor: 'red' }).map(
      (i) => i.code,
    );
    expect(codes).toEqual(['floors-out-of-range', 'floor-height-out-of-range', 'setback-out-of-range', 'bad-color']);
    expect(validateSpec({ ...defaultSpec('office'), floors: 2.5 }).map((i) => i.code)).toEqual(['floors-out-of-range']);
  });
});

describe('insetPolygon / isConvex', () => {
  it('нулевой отступ возвращает участок как есть', () => {
    expect(insetPolygon(rect, 0)).toEqual(rect);
  });

  it('отличает выпуклый контур от вогнутого', () => {
    expect(isConvex(rect)).toBe(true);
    expect(isConvex(lShape)).toBe(false);
  });
});
