import { describe, expect, it } from 'vitest';
import type { Vec2 } from '../walk/localFrame';
import {
  EDIT_FLOOR_HEIGHT,
  EMPTY_EDITS,
  SHED_WALL_HEIGHT,
  areaOf,
  centroidOf,
  footprintCorners,
  modelFootprint,
  modelPlacement,
  parseEdits,
  rectangleSize,
  removeBuilding,
  removeFence,
  removeRoad,
  resizeByCorner,
  rotate,
  rotateHandle,
  simplifyLine,
  snapEnds,
  stretchRectangle,
  turnFacade,
  upsertBuilding,
  upsertRoad,
  wallHeightOf,
  withModel,
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

  it('ручка поворота — снаружи, в 2,5 м от середины первой стороны', () => {
    const corners: Vec2[] = [
      [0, 0],
      [10, 0],
      [10, 6],
      [0, 6],
    ];
    expect(rotateHandle(corners)).toEqual([5, -2.5]);
  });

  it('высота стен: сарай низкий, у деревенского дома и магазина цоколь выше', () => {
    expect(wallHeightOf({ kind: 'shed', floors: 3 }, false)).toBe(SHED_WALL_HEIGHT);
    expect(wallHeightOf({ kind: 'apartments', floors: 5 }, false)).toBeCloseTo(5 * EDIT_FLOOR_HEIGHT, 6);
    expect(wallHeightOf({ kind: 'house', floors: 1 }, true)).toBeCloseTo(EDIT_FLOOR_HEIGHT + 0.4, 6);
    expect(wallHeightOf({ kind: 'house', floors: 1 }, false)).toBeCloseTo(EDIT_FLOOR_HEIGHT, 6);
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

describe('дома-модели', () => {
  // Дом 6 × 10 м: длинной стороной вдоль y, улица — восточнее (x = 20).
  const outline: Vec2[] = [
    [0, 0],
    [6, 0],
    [6, 10],
    [0, 10],
  ];
  const street: Vec2[] = [
    [20, -50],
    [20, 50],
  ];

  it('фасад — к ближайшей улице, обход против часовой', () => {
    const rect = modelFootprint(outline, [street]);
    expect(rect).toHaveLength(4);
    const [a, b] = rect as [Vec2, Vec2];
    // Первая сторона — восточная (x = 6).
    expect(a[0]).toBeCloseTo(6, 6);
    expect(b[0]).toBeCloseTo(6, 6);
    const place = modelPlacement(rect);
    expect(place.width).toBeCloseTo(10, 6);
    expect(place.depth).toBeCloseTo(6, 6);
    expect(place.center[0]).toBeCloseTo(3, 6);
    expect(place.center[1]).toBeCloseTo(5, 6);
    // Ось фасада идёт на север, значит дом смотрит на восток (направо от оси).
    expect(place.angle).toBeCloseTo(Math.PI / 2, 6);
  });

  it('без улицы рядом фасад смотрит на юг', () => {
    const rect = modelFootprint(outline, []);
    const [a, b] = rect as [Vec2, Vec2];
    expect(a[1]).toBeCloseTo(0, 6);
    expect(b[1]).toBeCloseTo(0, 6);
    expect(b[0]).toBeGreaterThan(a[0]);
  });

  it('«развернуть фасад» перебирает стороны по кругу', () => {
    const rect = modelFootprint(outline, [street]);
    let turned = rect;
    for (let i = 0; i < 4; i++) turned = turnFacade(turned);
    expect(turned).toEqual(rect);
    expect(modelPlacement(turnFacade(rect)).width).toBeCloseTo(6, 6);
  });

  it('модель в правке: тип, этажность; снять модель — простой объём', () => {
    const b = withModel(house('h'), { id: 'izba', seed: 3 });
    expect(b.model).toEqual({ id: 'izba', seed: 3 });
    expect(b.kind).toBe('house');
    expect(b.floors).toBe(1);
    expect(withModel(house('h'), { id: 'banya', seed: 1 }).kind).toBe('shed');
    expect(withModel(b, undefined).model).toBeUndefined();
  });

  it('правки с моделью переживают сохранение; чужие модели отбрасываются', () => {
    const footprint: [number, number][] = [
      [55.9, 54.7],
      [55.9001, 54.7],
      [55.9001, 54.7001],
      [55.9, 54.7001],
    ];
    const good = { ...house('a'), footprint, model: { id: 'pyatistenok', seed: 2 } };
    const bad = { ...house('b'), footprint, model: { id: 'castle', seed: 1 } };
    const parsed = parseEdits(JSON.parse(JSON.stringify({ ...EMPTY_EDITS, buildings: [good, bad] })))!;
    expect(parsed.buildings[0]!.model).toEqual({ id: 'pyatistenok', seed: 2 });
    expect(parsed.buildings[1]!.model).toBeUndefined();
  });
});
