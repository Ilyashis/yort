import { describe, expect, it } from 'vitest';
import type { Vec2 } from '../walk/localFrame';
import {
  defaultRoofHeight,
  orientedBox,
  rectangularity,
  roofFrame,
  roofSurfaceZ,
  roofTriangles,
  triangleNormal,
  type Triangle,
} from './roofGeometry';

/** Прямоугольник 20 × 10 м, повёрнутый на 30°. */
const angle = Math.PI / 6;
const rot = ([x, y]: Vec2): Vec2 => [x * Math.cos(angle) - y * Math.sin(angle), x * Math.sin(angle) + y * Math.cos(angle)];
const rect: Vec2[] = ([[0, 0], [20, 0], [20, 10], [0, 10]] as Vec2[]).map(rot);
const lShape: Vec2[] = [[0, 0], [30, 0], [30, 10], [10, 10], [10, 30], [0, 30]];

const maxZ = (ts: Triangle[]) => Math.max(...ts.flatMap((t) => t.map((p) => p[2])));
const facesUpOrOut = (ts: Triangle[], center: Vec2) =>
  ts.every((t) => {
    const n = triangleNormal(t);
    if (Math.abs(n[2]) > 1e-6) return n[2] > 0;
    const mid = [(t[0][0] + t[1][0] + t[2][0]) / 3 - center[0], (t[0][1] + t[1][1] + t[2][1]) / 3 - center[1]];
    return n[0] * mid[0]! + n[1] * mid[1]! > 0;
  });

describe('orientedBox', () => {
  it('находит повёрнутый прямоугольник: длинная ось — 20 м, короткая — 10 м', () => {
    const box = orientedBox(rect);
    expect(box.halfU).toBeCloseTo(10, 5);
    expect(box.halfV).toBeCloseTo(5, 5);
    expect(Math.abs(box.u[0] * Math.cos(angle) + box.u[1] * Math.sin(angle))).toBeCloseTo(1, 5);
    expect(rectangularity(rect, box)).toBeCloseTo(1, 5);
  });

  it('Г-образный контур — не прямоугольник', () => {
    expect(rectangularity(lShape)).toBeLessThan(0.6);
  });
});

describe('roofTriangles', () => {
  it('двускатная: 6 треугольников, конёк на заданной высоте, всё смотрит наружу', () => {
    const ts = roofTriangles(rect, 'gabled', 3)!;
    expect(ts).toHaveLength(6);
    expect(maxZ(ts)).toBeCloseTo(3, 5);
    expect(facesUpOrOut(ts, orientedBox(rect).center)).toBe(true);
    // Фронтоны вертикальные: у двух треугольников нормаль горизонтальная.
    expect(ts.filter((t) => Math.abs(triangleNormal(t)[2]) < 1e-6)).toHaveLength(2);
  });

  it('вальмовая: все грани — скаты (нет вертикальных фронтонов)', () => {
    const ts = roofTriangles(rect, 'hipped', 3)!;
    expect(ts.every((t) => triangleNormal(t)[2] > 0)).toBe(true);
  });

  it('на Г-образном доме — вальмовая крыша со срезанным верхом: накрывает весь контур, скаты вверх', () => {
    for (const shape of ['gabled', 'hipped', 'pyramidal'] as const) {
      const ts = roofTriangles(lShape, shape, 3)!;
      expect(ts).toBeDefined();
      expect(ts.every((t) => triangleNormal(t)[2] > 0)).toBe(true);
      // Проекция крыши на землю равна площади дома (500 м²): без дыр и наложений.
      const projected = ts.reduce((sum, t) => sum + triangleNormal(t)[2] / 2, 0);
      expect(projected).toBeCloseTo(500, 3);
      expect(maxZ(ts)).toBeGreaterThan(2);
      expect(maxZ(ts)).toBeLessThanOrEqual(3);
    }
    // Контур по часовой стрелке — то же самое.
    expect(roofTriangles([...lShape].reverse(), 'hipped', 3)).toBeDefined();
    expect(roofTriangles(rect, 'flat', 3)).toBeUndefined();
  });

  it('купол и луковица — тела вращения нужной высоты', () => {
    const square: Vec2[] = [[0, 0], [12, 0], [12, 12], [0, 12]];
    const dome = roofTriangles(square, 'dome', 5)!;
    const onion = roofTriangles(square, 'onion', 9)!;
    expect(maxZ(dome)).toBeCloseTo(5, 5);
    expect(maxZ(onion)).toBeCloseTo(9, 5);
    expect(dome.length).toBeGreaterThan(50);
  });
});

describe('defaultRoofHeight', () => {
  it('скаты ~30°, в разумных пределах', () => {
    const box = orientedBox(rect);
    expect(defaultRoofHeight('gabled', box, 200)).toBeCloseTo(5 * Math.tan(Math.PI / 6), 5);
    expect(defaultRoofHeight('flat', box, 200)).toBe(0);
  });
});

describe('свес крыши', () => {
  const minZ = (ts: Triangle[]) => Math.min(...ts.flatMap((t) => t.map((p) => p[2])));
  const projected = (ts: Triangle[]) => ts.reduce((sum, t) => sum + triangleNormal(t)[2] / 2, 0);

  for (const shape of ['gabled', 'hipped'] as const) {
    it(`${shape}: скаты выходят за стены и опускаются ниже их верха, снизу подшивка`, () => {
      const plain = roofTriangles(rect, shape, 3)!;
      const eaves = roofTriangles(rect, shape, 3, 'along', 0.5)!;
      expect(minZ(plain)).toBeCloseTo(0, 6);
      expect(minZ(eaves)).toBeLessThan(-0.1);
      expect(maxZ(eaves)).toBeCloseTo(3, 6); // конёк на прежней высоте
      // Подшивка смотрит вниз и закрывает свес: сумма проекций = площадь дома (200 м²).
      expect(eaves.some((t) => triangleNormal(t)[2] < 0)).toBe(true);
      expect(projected(eaves)).toBeCloseTo(200, 3);
    });
  }
});

describe('roofFrame', () => {
  it('конёк по длинной оси, высота ската падает к краям', () => {
    const frame = roofFrame(rect, 'gabled', 3)!;
    expect(frame.halfA).toBeCloseTo(10, 5);
    expect(frame.halfB).toBeCloseTo(5, 5);
    expect(roofSurfaceZ(frame, 0, 0)).toBeCloseTo(3, 6);
    expect(roofSurfaceZ(frame, 4, 2.5)).toBeCloseTo(1.5, 6);
    expect(roofSurfaceZ(frame, 0, 5)).toBeCloseTo(0, 6);
  });

  it('у вальмовой конёк короче, на торцах — скаты; у Г-образного дома каркаса нет', () => {
    const frame = roofFrame(rect, 'hipped', 3)!;
    expect(frame.ridgeHalf).toBeCloseTo(5, 5);
    expect(roofSurfaceZ(frame, 10, 0)).toBeCloseTo(0, 6);
    expect(roofSurfaceZ(frame, 7.5, 0)).toBeCloseTo(1.5, 6);
    expect(roofFrame(lShape, 'hipped', 3)).toBeUndefined();
  });
});
