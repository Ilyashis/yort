import { describe, expect, it } from 'vitest';
import type { Vec2 } from '../walk/localFrame';
import {
  EMPTY_EDITS,
  areaOf,
  centroidOf,
  footprintCorners,
  parseEdits,
  rectangleSize,
  removeBuilding,
  removeFence,
  removeRoad,
  resizeByCorner,
  rotate,
  simplifyLine,
  snapEnds,
  stretchRectangle,
  upsertBuilding,
  upsertRoad,
  type EditedBuilding,
} from './edits';

const house = (id: string, source?: string): EditedBuilding => ({
  id,
  source,
  kind: 'house',
  footprint: [
    [0, 0],
    [1, 0],
    [1, 1],
  ],
  floors: 1,
  roof: 'gabled',
  facadeColor: '#fff',
  roofColor: '#000',
});

describe('правки', () => {
  it('изменённый дом OSM скрывает оригинал; удаление своего дома не возвращает оригинал', () => {
    let edits = upsertBuilding(EMPTY_EDITS, house('way/1', 'way/1'));
    expect(edits.removedBuildings).toEqual(['way/1']);
    edits = upsertBuilding(edits, { ...house('way/1', 'way/1'), floors: 2 });
    expect(edits.buildings).toHaveLength(1);
    edits = removeBuilding(edits, 'way/1');
    expect(edits.buildings).toHaveLength(0);
    expect(edits.removedBuildings).toEqual(['way/1']);
  });

  it('удаление дороги и забора: своё — удаляется, из OSM и сгенерированное — скрывается', () => {
    let edits = upsertRoad(EMPTY_EDITS, { id: 'r1', kind: 'lane', axis: [[0, 0], [1, 1]] });
    edits = removeRoad(edits, 'r1');
    expect(edits.roads).toHaveLength(0);
    edits = removeRoad(edits, 'road:abc');
    expect(edits.removedRoads).toEqual(['road:abc']);
    edits = removeFence(edits, 'way/5:0');
    expect(edits.removedYards).toEqual(['way/5:0']);
  });

  it('файл правок: неверное отбрасывается', () => {
    const parsed = parseEdits({
      buildings: [house('a'), { id: 'b', kind: 'castle', footprint: [] }, { ...house('c'), footprint: [[0, 0]] }],
      roads: [{ id: 'r', kind: 'street', axis: [[0, 0], [1, 'x'], [2, 2]] }],
      removedBuildings: ['way/1', 5],
    })!;
    expect(parsed.buildings.map((b) => b.id)).toEqual(['a']);
    expect(parsed.roads[0]!.axis).toEqual([[0, 0], [2, 2]]);
    expect(parsed.removedBuildings).toEqual(['way/1']);
    expect(parseEdits('nope')).toBeUndefined();
  });
});

describe('дом растяжкой', () => {
  it('прямоугольник вдоль улицы: стороны по направлению оси и поперёк', () => {
    const dir: Vec2 = [Math.SQRT1_2, Math.SQRT1_2]; // улица под 45°
    const rect = stretchRectangle([0, 0], [10, 0], dir);
    const [w, h] = rectangleSize(rect);
    expect(w * h).toBeCloseTo(areaOf(rect), 6);
    // Проекции (10, 0) на оси: по 7,07 м.
    expect(w).toBeCloseTo(7.071, 2);
    expect(h).toBeCloseTo(7.071, 2);
    expect(areaOf(rect)).toBeCloseTo(50, 3);
  });

  it('без улицы — по сторонам света; обход всегда против часовой', () => {
    const rect = stretchRectangle([5, 5], [0, 0]);
    expect(areaOf(rect)).toBeCloseTo(25, 6);
    const [a, b] = rect;
    const c = rect[2];
    expect((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])).toBeGreaterThan(0);
  });
});

describe('правка контура', () => {
  const square: Vec2[] = [
    [0, 0],
    [10, 0],
    [10, 6],
    [0, 6],
  ];

  it('поворот вокруг центра сохраняет площадь и центр', () => {
    const turned = rotate(square, centroidOf(square), Math.PI / 6);
    expect(areaOf(turned)).toBeCloseTo(60, 6);
    expect(centroidOf(turned)[0]).toBeCloseTo(5, 6);
  });

  it('растяжка за угол: противоположный угол на месте, размеры под курсор, не меньше минимума', () => {
    const corners = footprintCorners(square);
    const index = corners.findIndex(([x, y]) => x > 9 && y > 5); // (10, 6)
    const opposite = corners[(index + 2) % 4]!;
    const bigger = resizeByCorner(square, index, [14, 8]);
    expect(areaOf(bigger)).toBeCloseTo(14 * 8, 4);
    expect(bigger.some(([x, y]) => Math.abs(x - opposite[0]) < 1e-6 && Math.abs(y - opposite[1]) < 1e-6)).toBe(true);
    const tiny = resizeByCorner(square, index, [-5, -5]);
    expect(areaOf(tiny)).toBeCloseTo(9, 4); // 3 × 3 — минимум
  });
});

describe('линии от руки', () => {
  it('дрожащая прямая упрощается до двух точек, угол сохраняется', () => {
    const shaky: Vec2[] = Array.from({ length: 30 }, (_, i) => [i, Math.sin(i) * 0.2]);
    expect(simplifyLine(shaky, 0.5)).toHaveLength(2);
    const corner: Vec2[] = [...Array.from({ length: 10 }, (_, i): Vec2 => [i, 0]), ...Array.from({ length: 10 }, (_, i): Vec2 => [9, i + 1])];
    expect(simplifyLine(corner, 0.5)).toHaveLength(3);
  });

  it('концы притягиваются к ближайшей дороге в радиусе', () => {
    const road: Vec2[] = [
      [0, 0],
      [100, 0],
    ];
    const line: Vec2[] = [
      [20, 4],
      [20, 40],
    ];
    const snapped = snapEnds(line, [road], 6);
    expect(snapped[0]).toEqual([20, 0]);
    expect(snapped[1]).toEqual([20, 40]);
  });
});
