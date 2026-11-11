import { describe, expect, it } from 'vitest';
import { sunAngles } from './sky';

const deg = (r: number) => (r * 180) / Math.PI;

describe('солнце над Уфой 15 июля', () => {
  const at = (h: number) => sunAngles(h, 54.72, 55.94);

  it('в солнечный полдень (около 13:20) стоит высоко на юге', () => {
    const noon = at(13.33);
    expect(deg(noon.elevation)).toBeGreaterThan(55);
    expect(deg(noon.elevation)).toBeLessThan(58);
    expect(Math.abs(Math.abs(deg(noon.azimuth)) - 180)).toBeLessThan(4);
  });

  it('садится около 21:50 и ночью уходит неглубоко под горизонт', () => {
    expect(deg(at(21.3).elevation)).toBeGreaterThan(0);
    expect(deg(at(22.3).elevation)).toBeLessThan(0);
    expect(deg(at(1.3).elevation)).toBeGreaterThan(-16);
  });
});
