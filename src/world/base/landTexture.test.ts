import { describe, expect, it } from 'vitest';
import { valueNoise } from './landTexture';

describe('valueNoise', () => {
  const size = 128;
  const noise = valueNoise(size, 8, 3);

  it('значения 0..1 и разные — не сплошная заливка', () => {
    const values = [...noise];
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...values)).toBeLessThanOrEqual(1);
    expect(Math.max(...values) - Math.min(...values)).toBeGreaterThan(0.3);
  });

  it('бесшовная плитка: правый край переходит в левый, нижний — в верхний', () => {
    for (let y = 0; y < size; y += 7) {
      expect(Math.abs(noise[y * size + size - 1]! - noise[y * size]!)).toBeLessThan(0.1);
    }
    for (let x = 0; x < size; x += 7) {
      expect(Math.abs(noise[(size - 1) * size + x]! - noise[x]!)).toBeLessThan(0.1);
    }
  });

  it('одинаковая при каждом запуске и разная для разных зёрен', () => {
    expect(valueNoise(size, 8, 3)).toEqual(noise);
    expect(valueNoise(size, 8, 4)).not.toEqual(noise);
  });
});
