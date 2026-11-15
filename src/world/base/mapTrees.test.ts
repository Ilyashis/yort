import { describe, expect, it } from 'vitest';
import { BlockedGrid, findTreeSpots, isCanopy } from './mapTrees';

/** Снимок w × h: слева — пёстрая тёмная крона, справа — ровная светлая трава. */
function picture(w: number, h: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const tree = x < w / 2;
      const light = tree ? ((x * 7 + y * 13) % 5) * 18 : 0;
      rgba.set(tree ? [30 + light, 40 + light, 22 + light / 2, 255] : [92, 100, 62, 255], i);
    }
  return rgba;
}

describe('деревья по карте', () => {
  it('крона — тёмная зелень, трава, пашня и крыша — нет', () => {
    expect(isCanopy(48, 56, 35)).toBe(true);
    expect(isCanopy(37, 43, 26)).toBe(true);
    expect(isCanopy(128, 124, 89)).toBe(false);
    expect(isCanopy(90, 99, 60)).toBe(false);
    expect(isCanopy(70, 55, 45)).toBe(false);
    expect(isCanopy(60, 70, 120)).toBe(false);
  });

  it('деревья — только на кроне, не на траве и не в занятых местах', () => {
    const w = 40;
    const h = 20;
    const spots = findTreeSpots(picture(w, h), w, h, (px, py) => [px, py], { spacing: 5, cover: 0.3, pixel: 1, allowed: () => true });
    expect(spots.length).toBeGreaterThan(4);
    for (const [x, , height] of spots) {
      expect(x).toBeLessThan(w / 2);
      expect(height).toBeGreaterThan(4);
    }
    const blocked = new BlockedGrid(1);
    blocked.polygon(
      [
        [0, 0],
        [10, 0],
        [10, 20],
        [0, 20],
      ],
      0,
    );
    const free = findTreeSpots(picture(w, h), w, h, (px, py) => [px, py], { spacing: 5, cover: 0.3, pixel: 1, allowed: (x, y) => !blocked.has(x, y) });
    expect(free.every(([x]) => x > 10)).toBe(true);
    expect(free.length).toBeLessThan(spots.length);
  });
});
