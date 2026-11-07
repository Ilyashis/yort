import { describe, expect, it } from 'vitest';
import type { Vec2 } from '../walk/localFrame';
import {
  fitPerspective,
  fitTwoPoints,
  imageCorners,
  imageMatrix,
  imageToLocal,
  initialPlacement,
  isProjective,
  localToImage,
  translatePlacement,
  type ImageSize,
  type Mat3,
} from './underlay';

const size: ImageSize = [4000, 3000];
const placement = { center: [120, -40] as Vec2, metresPerPixel: 0.05, rotation: 0.6 };

describe('подложка', () => {
  it('пиксель → метры → пиксель — без потерь', () => {
    for (const p of [[0, 0], [4000, 3000], [1234, 2345]] as Vec2[]) {
      const back = localToImage(imageToLocal(p, size, placement), size, placement);
      expect(back[0]).toBeCloseTo(p[0], 6);
      expect(back[1]).toBeCloseTo(p[1], 6);
    }
  });

  it('центр снимка — в центре размещения; верх снимка — к северу без поворота', () => {
    const flat = { ...placement, rotation: 0 };
    expect(imageToLocal([2000, 1500], size, flat)).toEqual([120, -40]);
    const top = imageToLocal([2000, 0], size, flat);
    expect(top[1]).toBeGreaterThan(-40);
    const [nw, ne] = imageCorners(size, flat);
    expect(ne![0] - nw![0]).toBeCloseTo(200, 6); // 4000 px × 5 см
  });

  it('матрица для canvas совпадает с imageToLocal', () => {
    const [a, b, c, d, e, f] = imageMatrix(size, placement);
    for (const [u, v] of [[0, 0], [100, 2000], [4000, 3000]] as Vec2[]) {
      const expected = imageToLocal([u, v], size, placement);
      expect(a * u + c * v + e).toBeCloseTo(expected[0], 6);
      expect(b * u + d * v + f).toBeCloseTo(expected[1], 6);
    }
  });

  it('совмещение по двум точкам находит масштаб, поворот и сдвиг', () => {
    const truth = { center: [-35, 80] as Vec2, metresPerPixel: 0.08, rotation: -1.1 };
    const a: Vec2 = [500, 600];
    const b: Vec2 = [3500, 2200];
    const fit = fitTwoPoints(a, b, imageToLocal(a, size, truth), imageToLocal(b, size, truth), size)!;
    expect(fit.metresPerPixel).toBeCloseTo(0.08, 9);
    expect(Math.cos(fit.rotation - truth.rotation)).toBeCloseTo(1, 9);
    expect(fit.center[0]).toBeCloseTo(-35, 6);
    expect(fit.center[1]).toBeCloseTo(80, 6);
    expect(fitTwoPoints(a, a, [0, 0], [1, 1], size)).toBeUndefined();
  });

  it('стартовое размещение — заданной ширины', () => {
    const start = initialPlacement([0, 0], size, 150);
    const [nw, ne] = imageCorners(size, start);
    expect(ne![0] - nw![0]).toBeCloseTo(150, 6);
  });
});

describe('подложка с перспективой', () => {
  // «Кадр с дрона под углом»: настоящая гомография снимка в метры.
  const truth = { homography: [0.05, 0.012, -90, 0.004, -0.06, 70, 0.00002, 0.00004, 1] as Mat3, source: 'points' as const };
  const imagePoints: Vec2[] = [[300, 200], [3700, 350], [3600, 2800], [250, 2650]];

  it('по четырём точкам восстанавливает гомографию точно', () => {
    const maps = imagePoints.map((p) => imageToLocal(p, size, truth));
    const fit = fitPerspective(imagePoints, maps)!;
    for (const p of [[0, 0], [2000, 1500], [4000, 3000], [123, 2900]] as Vec2[]) {
      const expected = imageToLocal(p, size, truth);
      const got = imageToLocal(p, size, fit);
      expect(Math.hypot(got[0] - expected[0], got[1] - expected[1])).toBeLessThan(1e-6);
    }
  });

  it('по шести неточным точкам — по методу наименьших квадратов, ошибка порядка шума', () => {
    const points: Vec2[] = [...imagePoints, [2000, 1500], [1000, 2400]];
    const noise = [0.02, -0.03, 0.01, 0.025, -0.015, 0.03];
    const maps = points.map((p, i) => {
      const [x, y] = imageToLocal(p, size, truth);
      return [x + noise[i]!, y - noise[(i + 2) % 6]!] as Vec2;
    });
    const fit = fitPerspective(points, maps)!;
    const centre = imageToLocal([2000, 1500], size, fit);
    const expected = imageToLocal([2000, 1500], size, truth);
    expect(Math.hypot(centre[0] - expected[0], centre[1] - expected[1])).toBeLessThan(0.05);
  });

  it('туда и обратно, сдвиг и вырожденные точки', () => {
    const p: Vec2 = [1234, 567];
    const back = localToImage(imageToLocal(p, size, truth), size, truth);
    expect(back[0]).toBeCloseTo(p[0], 6);
    expect(back[1]).toBeCloseTo(p[1], 6);
    const moved = translatePlacement(truth, [5, -3]);
    const [x0, y0] = imageToLocal(p, size, truth);
    const [x1, y1] = imageToLocal(p, size, moved);
    expect(x1 - x0).toBeCloseTo(5, 6);
    expect(y1 - y0).toBeCloseTo(-3, 6);
    // Три точки на одной прямой — совместить нельзя.
    expect(fitPerspective([[0, 0], [10, 10], [20, 20], [0, 30]], [[0, 0], [1, 1], [2, 2], [0, 3]])).toBeUndefined();
    // Подобие тоже двигается.
    expect(translatePlacement(placement, [1, 2])).toMatchObject({ center: [121, -38] });
  });

  it('подобие — частный случай гомографии', () => {
    const corners: Vec2[] = [[0, 0], [4000, 0], [4000, 3000], [0, 3000]];
    const fit = fitPerspective(corners, corners.map((p) => imageToLocal(p, size, placement)))!;
    expect(isProjective(fit)).toBe(true);
    const got = imageToLocal([777, 888], size, fit);
    const expected = imageToLocal([777, 888], size, placement);
    expect(got[0]).toBeCloseTo(expected[0], 6);
    expect(got[1]).toBeCloseTo(expected[1], 6);
  });
});
