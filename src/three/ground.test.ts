import { describe, expect, it } from 'vitest';
import { fitPerspective, imageCorners, localToImage, type ImageSize, type Mat3 } from '../world/edit/underlay';
import type { Vec2 } from '../world/walk/localFrame';
import { localToImageMatrix } from './ground';

const size: ImageSize = [4000, 3000];

/** Как в шейдере: p = M · (x, y, 1), пиксель = p.xy / p.z. */
function shade(m: Mat3, [x, y]: Vec2): { pixel: Vec2; w: number } {
  const w = m[6] * x + m[7] * y + m[8];
  return { pixel: [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w], w };
}

describe('подложка в шейдере земли', () => {
  it('подобие: матрица шейдера даёт тот же пиксель, что localToImage', () => {
    const placement = { center: [120, -40] as Vec2, metresPerPixel: 0.05, rotation: 0.6 };
    const m = localToImageMatrix(size, placement)!;
    for (const p of [[120, -40], [0, 0], [150, 10]] as Vec2[]) {
      const { pixel, w } = shade(m, p);
      const expected = localToImage(p, size, placement);
      expect(w).toBeCloseTo(1, 9);
      expect(pixel[0]).toBeCloseTo(expected[0], 6);
      expect(pixel[1]).toBeCloseTo(expected[1], 6);
    }
  });

  it('перспектива: углы снимка — в углы текстуры, внутри снимка w > 0', () => {
    const images: Vec2[] = [[0, 0], [4000, 0], [4000, 3000], [0, 3000]];
    const maps: Vec2[] = [[-60, 40], [70, 55], [90, -70], [-80, -50]];
    const placement = fitPerspective(images, maps)!;
    const m = localToImageMatrix(size, placement)!;
    imageCorners(size, placement).forEach((corner, i) => {
      const { pixel, w } = shade(m, corner);
      expect(w).toBeGreaterThan(0);
      expect(pixel[0]).toBeCloseTo(images[i]![0], 4);
      expect(pixel[1]).toBeCloseTo(images[i]![1], 4);
    });
  });
});
