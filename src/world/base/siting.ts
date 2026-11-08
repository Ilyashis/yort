// Посадка дома на склон: пол — по верхней точке земли под контуром, стены и цоколь — до нижней.
// Так ни одна сторона не уходит в землю (раньше дом ставили на нижнюю точку, и со стороны горы
// окна оказывались в земле), а с низовой стороны виден высокий цоколь — как у настоящих домов на склоне.

import type { Vec2 } from '../walk/localFrame';

/** Выше нижней точки пол не поднимаем больше чем на столько, м: на круче дом врезается в склон. */
export const MAX_FLOOR_LIFT = 3;
/** Стены и цоколь уходят чуть ниже нижней точки — без щели между домом и землёй. */
export const FOOTING_DEPTH = 0.3;

export interface Site {
  /** Уровень пола (от него — окна, двери, крыша). */
  floor: number;
  /** Нижняя точка земли под контуром (до неё — стены и цоколь). */
  low: number;
}

/** Где пол и где низ стен для контура outline (локальные метры) на рельефе heightAt. */
export function siteOnSlope(outline: readonly Vec2[], heightAt: (x: number, y: number) => number): Site {
  const samples: Vec2[] = [...outline];
  // Середины сторон и центр: рельеф между углами тоже бывает выше.
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i]!;
    const b = outline[(i + 1) % outline.length]!;
    samples.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
  }
  if (outline.length) {
    samples.push([outline.reduce((s, p) => s + p[0], 0) / outline.length, outline.reduce((s, p) => s + p[1], 0) / outline.length]);
  }
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const [x, y] of samples) {
    const h = heightAt(x, y);
    if (!Number.isFinite(h)) continue;
    low = Math.min(low, h);
    high = Math.max(high, h);
  }
  if (!Number.isFinite(low)) return { floor: 0, low: 0 };
  return { floor: Math.min(high, low + MAX_FLOOR_LIFT), low };
}
