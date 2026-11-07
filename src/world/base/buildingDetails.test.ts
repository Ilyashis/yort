import { describe, expect, it } from 'vitest';
import type { Vec2 } from '../walk/localFrame';
import { balconies, entrances, facadeEdges } from './buildingDetails';
import { assignParts } from './parts';
import type { BaseBuildingFeature } from './types';

/** Дом 40 × 12 м: длинные стены — южная (y = 0) и северная (y = 12). */
const house: Vec2[] = [[0, 0], [40, 0], [40, 12], [0, 12]];
const insideHouse = ([x, y]: Vec2) => x > 0 && x < 40 && y > 0 && y < 12;

describe('facadeEdges', () => {
  it('нормали смотрят наружу при любом направлении обхода', () => {
    for (const ring of [house, [...house].reverse()]) {
      for (const e of facadeEdges(ring)) {
        const mid: Vec2 = [(e.a[0] + e.b[0]) / 2 + e.normal[0], (e.a[1] + e.b[1]) / 2 + e.normal[1]];
        expect(insideHouse(mid)).toBe(false);
      }
    }
  });
});

describe('balconies', () => {
  const options = { floors: 9, floorHeight: 3, bay: 6, minEdge: 9, maxPerBuilding: 500 };

  it('стояки на двух длинных стенах, со 2-го этажа, снаружи дома', () => {
    const boxes = balconies(house, options);
    // (40 − 2) / 6 → 6 стояков × 8 этажей × 2 стены
    expect(boxes).toHaveLength(6 * 8 * 2);
    expect(Math.min(...boxes.map((b) => b.center[2]))).toBeCloseTo(3 + 1.05 / 2, 5);
    for (const b of boxes) expect(insideHouse([b.center[0], b.center[1]])).toBe(false);
    expect(new Set(boxes.map((b) => Math.round(b.center[1]))).size).toBe(2);
  });

  it('у низких и маленьких домов балконов нет, лимит соблюдается', () => {
    expect(balconies(house, { ...options, floors: 2 })).toEqual([]);
    expect(balconies([[0, 0], [6, 0], [6, 6], [0, 6]], options)).toEqual([]);
    expect(balconies(house, { ...options, maxPerBuilding: 10 })).toHaveLength(10);
  });
});

describe('entrances', () => {
  it('подъезды — во двор: на длинной стене, которая не выходит на улицу', () => {
    // Улица с юга (y < 0): южная стена «уличная».
    const result = entrances(house, ([, y]) => y < 6, 18);
    expect(result.doors).toHaveLength(2);
    expect(result.canopies).toHaveLength(2);
    for (const door of result.doors) expect(door.center[1]).toBeGreaterThan(12);
    expect(result.canopies[0]!.center[2]).toBeCloseTo(2.55, 5);
  });

  it('если все длинные стены уличные — подъездов нет', () => {
    expect(entrances(house, () => true).doors).toEqual([]);
  });
});

describe('assignParts', () => {
  const square = (id: string, x: number, y: number, size: number): BaseBuildingFeature => ({
    type: 'Feature',
    id,
    properties: { id, building: 'yes', height: 10, minHeight: 0, heightSource: 'default' },
    geometry: { type: 'Polygon', coordinates: [[[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]] },
  });

  it('часть внутри контура привязывается к зданию, вне — остаётся сама по себе', () => {
    const { byBuilding, orphans } = assignParts(
      [square('way/1', 0, 0, 10)],
      [square('way/2', 2, 2, 3), square('way/3', 20, 20, 3)],
    );
    expect(byBuilding.get('way/1')?.map((p) => p.id)).toEqual(['way/2']);
    expect(orphans.map((p) => p.id)).toEqual(['way/3']);
  });
});
