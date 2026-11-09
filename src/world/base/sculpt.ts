// Ручная правка рельефа кистью: «поднять», «опустить», «выровнять», «сгладить» поверх рельефа района.
// Поправки к высоте — на своей сетке с шагом 1 м и только там, где рисовали (участками 32 × 32 узла).
// Мазок хранится как цепочка касаний кисти (центры в lon/lat): при загрузке и после отмены мазки
// повторяются по порядку и дают ту же землю. Чистые функции и классы, без движка.

import type { Vec2 } from '../walk/localFrame';

export type SculptMode = 'raise' | 'lower' | 'flatten' | 'smooth';

export interface SculptBrush {
  mode: SculptMode;
  /** Радиус кисти, м. */
  radius: number;
  /** Сила, от SCULPT_STRENGTH.min до 1. */
  strength: number;
  /** Для «выровнять» — высота, к которой тянется земля (там, где начали мазок), м. */
  level?: number;
}

export interface SculptStroke extends SculptBrush {
  id: string;
  /** Касания кисти — центры в lon/lat. */
  dabs: [number, number][];
}

export const SCULPT_MODES: Record<SculptMode, { label: string; hint: string }> = {
  raise: { label: 'Поднять', hint: 'Ведите по земле — она плавно поднимается; держите кнопку на месте — растёт холм.' },
  lower: { label: 'Опустить', hint: 'Ведите по земле — она плавно опускается; держите кнопку на месте — получится яма.' },
  flatten: { label: 'Выровнять', hint: 'Земля под кистью тянется к высоте точки, с которой начали: площадка, двор, дорога.' },
  smooth: { label: 'Сгладить', hint: 'Убирает бугры и ямки, общий уклон остаётся.' },
};
export const SCULPT_RADIUS = { min: 2, max: 40 };
export const SCULPT_STRENGTH = { min: 0.05, max: 1 };

/** Шаг сетки поправок, м, и сторона участка сетки в узлах. */
export const SCULPT_STEP = 1;
const TILE = 32;
/** «Поднять» на полной силе: столько метров за одно касание в центре кисти. */
const RAISE_PER_DAB = 0.12;
/** «Выровнять» на полной силе: такая доля разницы с уровнем уходит за касание. */
const FLATTEN_RATE = 0.6;
/** «Сгладить»: доля разницы со средним по соседям (в 2 м) за касание на полной силе. */
const SMOOTH_RATE = 0.5;
const SMOOTH_REACH = 2;

/** Прибавка к поправкам от касания: узлы i0…i0+ni−1 по x и j0…j0+nj−1 по y (узел — i·SCULPT_STEP м). */
export interface SculptChange {
  i0: number;
  j0: number;
  ni: number;
  nj: number;
  values: Float32Array;
}

/** Высота земли без ручных поправок в локальных метрах (x — восток, y — север). */
export type GroundHeight = (x: number, y: number) => number;

export class SculptField {
  private readonly tiles = new Map<string, Float32Array>();

  get empty(): boolean {
    return this.tiles.size === 0;
  }

  /** Поправка к высоте в точке (локальные метры), м. */
  offsetAt(x: number, y: number): number {
    if (!this.tiles.size) return 0;
    const fx = x / SCULPT_STEP;
    const fy = y / SCULPT_STEP;
    const i = Math.floor(fx);
    const j = Math.floor(fy);
    const tx = fx - i;
    const ty = fy - j;
    return (
      this.node(i, j) * (1 - tx) * (1 - ty) + this.node(i + 1, j) * tx * (1 - ty) + this.node(i, j + 1) * (1 - tx) * ty + this.node(i + 1, j + 1) * tx * ty
    );
  }

  /** Одно касание кисти с центром center; ground — земля без ручных поправок. Возвращает, что изменилось. */
  dab(brush: SculptBrush, center: Vec2, ground: GroundHeight): SculptChange {
    const r = Math.max(brush.radius, SCULPT_STEP);
    const s = Math.min(Math.max(brush.strength, SCULPT_STRENGTH.min), SCULPT_STRENGTH.max);
    const i0 = Math.ceil((center[0] - r) / SCULPT_STEP);
    const j0 = Math.ceil((center[1] - r) / SCULPT_STEP);
    const ni = Math.floor((center[0] + r) / SCULPT_STEP) - i0 + 1;
    const nj = Math.floor((center[1] + r) / SCULPT_STEP) - j0 + 1;
    const values = new Float32Array(Math.max(ni, 0) * Math.max(nj, 0));
    // Высоты узлов под кистью (для сглаживания — с запасом на соседей) — один раз, а не на каждый узел.
    const pad = brush.mode === 'smooth' ? Math.round(SMOOTH_REACH / SCULPT_STEP) : 0;
    const gw = ni + 2 * pad;
    const heights = brush.mode === 'flatten' || brush.mode === 'smooth' ? new Float64Array(Math.max(gw, 0) * Math.max(nj + 2 * pad, 0)) : undefined;
    if (heights) {
      for (let b = -pad; b < nj + pad; b++) {
        for (let a = -pad; a < ni + pad; a++) {
          const i = i0 + a;
          const j = j0 + b;
          heights[(b + pad) * gw + a + pad] = ground(i * SCULPT_STEP, j * SCULPT_STEP) + this.node(i, j);
        }
      }
    }
    const height = (a: number, b: number) => heights![(b + pad) * gw + a + pad]!;
    // Сначала считаем прибавки для всех узлов (сглаживание читает соседей), потом прибавляем.
    for (let b = 0; b < nj; b++) {
      for (let a = 0; a < ni; a++) {
        const x = (i0 + a) * SCULPT_STEP;
        const y = (j0 + b) * SCULPT_STEP;
        const d = Math.hypot(x - center[0], y - center[1]);
        if (d >= r) continue;
        const q = 1 - (d / r) ** 2;
        const f = q * q;
        let dv = 0;
        if (brush.mode === 'raise') dv = RAISE_PER_DAB * s * f;
        else if (brush.mode === 'lower') dv = -RAISE_PER_DAB * s * f;
        else if (brush.mode === 'flatten') {
          if (brush.level !== undefined) dv = (brush.level - height(a, b)) * Math.min(1, FLATTEN_RATE * s) * f;
        } else {
          let sum = 0;
          for (let u = -pad; u <= pad; u += pad) for (let v = -pad; v <= pad; v += pad) sum += height(a + u, b + v);
          dv = (sum / 9 - height(a, b)) * SMOOTH_RATE * s * f;
        }
        values[b * ni + a] = dv;
      }
    }
    const change = { i0, j0, ni: Math.max(ni, 0), nj: Math.max(nj, 0), values };
    this.add(change);
    return change;
  }

  /** Прибавить изменение (например, обратное — для отмены). */
  add(change: SculptChange): void {
    for (let b = 0; b < change.nj; b++) {
      for (let a = 0; a < change.ni; a++) {
        const v = change.values[b * change.ni + a]!;
        if (v) this.addNode(change.i0 + a, change.j0 + b, v);
      }
    }
  }

  /** Изменения, которые превращают это поле в other (other − this), — по участкам сетки. */
  changesTo(other: SculptField): SculptChange[] {
    const keys = new Set([...this.tiles.keys(), ...other.tiles.keys()]);
    const out: SculptChange[] = [];
    for (const key of keys) {
      const [ti, tj] = key.split(',').map(Number) as [number, number];
      const mine = this.tiles.get(key);
      const theirs = other.tiles.get(key);
      const values = new Float32Array(TILE * TILE);
      let any = false;
      for (let k = 0; k < values.length; k++) {
        values[k] = (theirs?.[k] ?? 0) - (mine?.[k] ?? 0);
        if (values[k]) any = true;
      }
      if (any) out.push({ i0: ti * TILE, j0: tj * TILE, ni: TILE, nj: TILE, values });
    }
    return out;
  }

  private node(i: number, j: number): number {
    const tile = this.tiles.get(`${Math.floor(i / TILE)},${Math.floor(j / TILE)}`);
    return tile ? tile[mod(i, TILE) + mod(j, TILE) * TILE]! : 0;
  }

  private addNode(i: number, j: number, v: number): void {
    const key = `${Math.floor(i / TILE)},${Math.floor(j / TILE)}`;
    let tile = this.tiles.get(key);
    if (!tile) {
      tile = new Float32Array(TILE * TILE);
      this.tiles.set(key, tile);
    }
    tile[mod(i, TILE) + mod(j, TILE) * TILE]! += v;
  }
}

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** Прибавка изменения в точке (локальные метры), м: билинейно между узлами; вне изменения — 0. */
export function changeAt(change: SculptChange, x: number, y: number): number {
  const fx = x / SCULPT_STEP - change.i0;
  const fy = y / SCULPT_STEP - change.j0;
  if (fx <= -1 || fy <= -1 || fx >= change.ni || fy >= change.nj) return 0;
  const a = Math.floor(fx);
  const b = Math.floor(fy);
  const tx = fx - a;
  const ty = fy - b;
  const at = (u: number, v: number) => (u < 0 || v < 0 || u >= change.ni || v >= change.nj ? 0 : change.values[v * change.ni + u]!);
  return at(a, b) * (1 - tx) * (1 - ty) + at(a + 1, b) * tx * (1 - ty) + at(a, b + 1) * (1 - tx) * ty + at(a + 1, b + 1) * tx * ty;
}

/** Где изменение что-то меняет (локальные метры, с запасом в шаг сетки). */
export function changeRect(change: SculptChange): { x0: number; y0: number; x1: number; y1: number } {
  return {
    x0: (change.i0 - 1) * SCULPT_STEP,
    y0: (change.j0 - 1) * SCULPT_STEP,
    x1: (change.i0 + change.ni) * SCULPT_STEP,
    y1: (change.j0 + change.nj) * SCULPT_STEP,
  };
}

/** Поле поправок по мазкам (по порядку); toLocal — lon/lat → локальные метры. */
export function replayStrokes(strokes: readonly SculptStroke[], toLocal: (p: [number, number]) => Vec2, ground: GroundHeight): SculptField {
  const field = new SculptField();
  for (const stroke of strokes) for (const dab of stroke.dabs) field.dab(stroke, toLocal(dab), ground);
  return field;
}

/** Мазок из файла правок: проверяем форму, лишнее отбрасываем; негодный — undefined. */
export function parseStroke(value: unknown): SculptStroke | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Partial<SculptStroke>;
  if (typeof v.id !== 'string' || !v.mode || !(v.mode in SCULPT_MODES)) return undefined;
  const radius = Number(v.radius);
  const strength = Number(v.strength);
  if (!Number.isFinite(radius) || !Number.isFinite(strength)) return undefined;
  const dabs = (Array.isArray(v.dabs) ? v.dabs : []).filter(
    (p): p is [number, number] => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number' && Number.isFinite(n)),
  );
  if (!dabs.length) return undefined;
  const level = Number(v.level);
  return {
    id: v.id,
    mode: v.mode,
    radius: Math.min(Math.max(radius, SCULPT_RADIUS.min), SCULPT_RADIUS.max),
    strength: Math.min(Math.max(strength, SCULPT_STRENGTH.min), SCULPT_STRENGTH.max),
    ...(v.mode === 'flatten' && Number.isFinite(level) ? { level } : {}),
    dabs,
  };
}
