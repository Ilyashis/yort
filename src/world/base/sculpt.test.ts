import { describe, expect, it } from 'vitest';
import { SculptField, changeAt, parseStroke, replayStrokes, type SculptStroke } from './sculpt';

const flat = () => 100;
/** Склон 5 % на восток с буграми ±0,4 м. */
const bumpy = (x: number, y: number) => 100 + 0.05 * x + 0.4 * Math.sin(x * 1.3) * Math.cos(y * 1.1);

describe('кисть рельефа', () => {
  it('«поднять» — холм с плавными краями: в центре больше всего, за радиусом — ничего', () => {
    const field = new SculptField();
    for (let k = 0; k < 5; k++) field.dab({ mode: 'raise', radius: 8, strength: 1 }, [10, 10], flat);
    const center = field.offsetAt(10, 10);
    expect(center).toBeGreaterThan(0.5);
    expect(field.offsetAt(14, 10)).toBeGreaterThan(0);
    expect(field.offsetAt(14, 10)).toBeLessThan(center);
    expect(field.offsetAt(10, 18.5)).toBe(0);
    // Симметрично во все стороны.
    expect(field.offsetAt(6, 10)).toBeCloseTo(field.offsetAt(14, 10), 6);
    expect(field.offsetAt(10, 6)).toBeCloseTo(field.offsetAt(10, 14), 6);
  });

  it('«опустить» — то же со знаком минус', () => {
    const up = new SculptField();
    const down = new SculptField();
    up.dab({ mode: 'raise', radius: 6, strength: 0.5 }, [0, 0], flat);
    down.dab({ mode: 'lower', radius: 6, strength: 0.5 }, [0, 0], flat);
    expect(down.offsetAt(1, 2)).toBeCloseTo(-up.offsetAt(1, 2), 6);
  });

  it('«выровнять» — земля под кистью тянется к уровню начала мазка', () => {
    const field = new SculptField();
    const level = bumpy(20, 20);
    for (let k = 0; k < 12; k++) field.dab({ mode: 'flatten', radius: 10, strength: 1, level }, [20, 20], bumpy);
    for (const [x, y] of [[20, 20], [23, 18], [17, 22]] as const) {
      expect(Math.abs(bumpy(x, y) + field.offsetAt(x, y) - level)).toBeLessThan(0.05);
    }
  });

  it('«сгладить» — бугров меньше, уклон остаётся', () => {
    const field = new SculptField();
    for (let k = 0; k < 10; k++) field.dab({ mode: 'smooth', radius: 12, strength: 1 }, [30, 30], bumpy);
    const residual = (h: (x: number, y: number) => number) => {
      let sum = 0;
      for (let x = 26; x <= 34; x++) for (let y = 26; y <= 34; y++) sum += (h(x, y) - (100 + 0.05 * x)) ** 2;
      return Math.sqrt(sum / 81);
    };
    const smoothed = (x: number, y: number) => bumpy(x, y) + field.offsetAt(x, y);
    expect(residual(smoothed)).toBeLessThan(residual(bumpy) * 0.5);
    // Средний уклон на месте: разница высот на 8 м — около 0,4 м, как у склона.
    const slope = (smoothed(34, 30) - smoothed(26, 30)) / 8;
    expect(slope).toBeGreaterThan(0.02);
    expect(slope).toBeLessThan(0.08);
  });

  it('мазки при повторе дают ту же землю; изменения между полями складываются в разницу', () => {
    const toLocal = ([x, y]: [number, number]): [number, number] => [x, y];
    const strokes: SculptStroke[] = [
      { id: 'a', mode: 'raise', radius: 6, strength: 0.8, dabs: [[0, 0], [2, 1], [4, 2]] },
      { id: 'b', mode: 'flatten', radius: 5, strength: 0.7, level: 100.3, dabs: [[3, 3], [5, 3]] },
      { id: 'c', mode: 'smooth', radius: 7, strength: 1, dabs: [[2, 2]] },
    ];
    const live = new SculptField();
    const changes = strokes.flatMap((s) => s.dabs.map((d) => live.dab(s, toLocal(d), bumpy)));
    const replayed = replayStrokes(strokes, toLocal, bumpy);
    for (const [x, y] of [[0, 0], [3.5, 2.2], [5, 3], [-3, 1]] as const) expect(replayed.offsetAt(x, y)).toBeCloseTo(live.offsetAt(x, y), 6);
    // Сумма изменений касаний — это и есть поправка.
    const summed = (x: number, y: number) => changes.reduce((s, c) => s + changeAt(c, x, y), 0);
    expect(summed(3.5, 2.2)).toBeCloseTo(live.offsetAt(3.5, 2.2), 5);
    // Отмена последнего мазка: изменения «было → стало» переводят одно поле в другое.
    const without = replayStrokes(strokes.slice(0, 2), toLocal, bumpy);
    for (const c of replayed.changesTo(without)) replayed.add(c);
    expect(replayed.offsetAt(2, 2)).toBeCloseTo(without.offsetAt(2, 2), 6);
  });

  it('мазок из файла: проверяется форма, радиус и сила — в пределах', () => {
    expect(parseStroke({ id: 'x', mode: 'raise', radius: 500, strength: 3, dabs: [[57, 52]] })).toEqual({
      id: 'x',
      mode: 'raise',
      radius: 40,
      strength: 1,
      dabs: [[57, 52]],
    });
    expect(parseStroke({ id: 'x', mode: 'dig', radius: 5, strength: 1, dabs: [[57, 52]] })).toBeUndefined();
    expect(parseStroke({ id: 'x', mode: 'raise', radius: 5, strength: 1, dabs: [] })).toBeUndefined();
    expect(parseStroke({ id: 'x', mode: 'flatten', radius: 5, strength: 1, level: 120, dabs: [[57, 52]] })?.level).toBe(120);
  });
});
