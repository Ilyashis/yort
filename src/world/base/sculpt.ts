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
  /** «Выровнять» обводкой: к средней (медиане) высоте внутри — по умолчанию, к самой низкой или самой высокой точке. */
  levelBy?: SculptLevelBy;
}

export type SculptLevelBy = 'median' | 'low' | 'high';
export const SCULPT_LEVELS: Record<SculptLevelBy, { label: string; hint: string }> = {
  median: { label: 'Средний', hint: 'к средней высоте внутри' },
  low: { label: 'По нижней', hint: 'к самой низкой точке внутри (срезать)' },
  high: { label: 'По верхней', hint: 'к самой высокой точке внутри (подсыпать)' },
};

export interface SculptStroke extends SculptBrush {
  id: string;
  /** Касания кисти — центры в lon/lat. */
  dabs: [number, number][];
  /** Обведённая область (lon/lat): «выровнять» или «сгладить» всё внутри разом; тогда касаний нет. */
  area?: [number, number][];
}

export const SCULPT_MODES: Record<SculptMode, { label: string; hint: string }> = {
  raise: { label: 'Поднять', hint: 'Ведите по земле — она плавно поднимается; держите кнопку на месте — растёт холм.' },
  lower: { label: 'Опустить', hint: 'Ведите по земле — она плавно опускается; держите кнопку на месте — получится яма.' },
  flatten: { label: 'Выровнять', hint: 'Земля под кистью тянется к высоте точки, с которой начали: площадка, двор, дорога.' },
  smooth: { label: 'Сгладить', hint: 'Убирает бугры и ямки, общий уклон остаётся.' },
};
export const SCULPT_RADIUS = { min: 2, max: 200 };
/** Режимы, которые работают и обводкой. */
export const AREA_MODES: SculptMode[] = ['flatten', 'smooth'];
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
/** Сглаживание берёт соседей на таком расстоянии, м: у большой кисти — шире (иначе уходят только мелкие бугры). */
const smoothReach = (radius: number) => (radius <= 40 ? 2 : Math.round(radius / 20));
/** Обводка: край области — плавный переход такой ширины (внутрь), м. */
const AREA_FEATHER = 5;

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
    const pad = brush.mode === 'smooth' ? Math.round(smoothReach(r) / SCULPT_STEP) : 0;
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

  /**
   * Обведённая область (локальные метры) целиком: «выровнять» — к средней (медиане) высоте внутри (или к самой
   * низкой / высокой точке — levelBy), «сгладить» — к размытой земле (бугры уходят, общий уклон остаётся).
   * Сила — доля пути; у края — плавный переход на AREA_FEATHER м внутрь. Возвращает, что изменилось.
   */
  area(brush: SculptBrush, polygon: readonly Vec2[], ground: GroundHeight): SculptChange {
    const s = Math.min(Math.max(brush.strength, SCULPT_STRENGTH.min), SCULPT_STRENGTH.max);
    const xs = polygon.map((p) => p[0]);
    const ys = polygon.map((p) => p[1]);
    const i0 = Math.ceil(Math.min(...xs) / SCULPT_STEP);
    const j0 = Math.ceil(Math.min(...ys) / SCULPT_STEP);
    const ni = Math.max(0, Math.floor(Math.max(...xs) / SCULPT_STEP) - i0 + 1);
    const nj = Math.max(0, Math.floor(Math.max(...ys) / SCULPT_STEP) - j0 + 1);
    const values = new Float32Array(ni * nj);
    const change = { i0, j0, ni, nj, values };
    if (polygon.length < 3 || !ni || !nj) return change;
    // Насколько узел внутри (м до края; снаружи — 0).
    const depth = new Float32Array(ni * nj);
    for (let b = 0; b < nj; b++) {
      for (let a = 0; a < ni; a++) {
        const x = (i0 + a) * SCULPT_STEP;
        const y = (j0 + b) * SCULPT_STEP;
        if (!inside(x, y, polygon)) continue;
        let d = Infinity;
        for (let k = 0, m = polygon.length - 1; k < polygon.length; m = k++) d = Math.min(d, segDist(x, y, polygon[m]!, polygon[k]!));
        depth[b * ni + a] = Math.max(d, 1e-3);
      }
    }
    // Высоты — с запасом вокруг (для размытия).
    const area = Math.abs(polygon.reduce((acc, p, k) => acc + p[0] * polygon[(k + 1) % polygon.length]![1] - polygon[(k + 1) % polygon.length]![0] * p[1], 0)) / 2;
    const blur = Math.round(Math.min(12, Math.max(2, Math.sqrt(area) / 8)) / SCULPT_STEP);
    const pad = brush.mode === 'smooth' ? blur * 3 : 0;
    const gw = ni + 2 * pad;
    const gh = nj + 2 * pad;
    const heights = new Float32Array(gw * gh);
    for (let b = 0; b < gh; b++) {
      for (let a = 0; a < gw; a++) {
        const i = i0 + a - pad;
        const j = j0 + b - pad;
        heights[b * gw + a] = ground(i * SCULPT_STEP, j * SCULPT_STEP) + this.node(i, j);
      }
    }
    let target: (a: number, b: number) => number;
    if (brush.mode === 'smooth') {
      const smooth = Float32Array.from(heights);
      for (let pass = 0; pass < 3; pass++) {
        boxBlur(smooth, gw, gh, blur, true);
        boxBlur(smooth, gw, gh, blur, false);
      }
      target = (a, b) => smooth[(b + pad) * gw + a + pad]!;
    } else {
      const under: number[] = [];
      for (let k = 0; k < depth.length; k++) if (depth[k]) under.push(heights[Math.floor(k / ni) * gw + (k % ni)]!);
      under.sort((p, q) => p - q);
      const pick = brush.levelBy === 'low' ? under[0] : brush.levelBy === 'high' ? under[under.length - 1] : under[under.length >> 1];
      const level = brush.level ?? pick ?? 0;
      target = () => level;
    }
    for (let b = 0; b < nj; b++) {
      for (let a = 0; a < ni; a++) {
        const d = depth[b * ni + a]!;
        if (!d) continue;
        const t = Math.min(1, d / AREA_FEATHER);
        const w = t * t * (3 - 2 * t);
        values[b * ni + a] = (target(a, b) - heights[(b + pad) * gw + a + pad]!) * s * w;
      }
    }
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

  /**
   * Готовое поле для сайта (файл sculpt.json): участки сетки в base64 (Float32). key — подпись мазков и вида,
   * по которым поле посчитано: сайт берёт его, только если подпись совпала, иначе считает мазки заново.
   */
  bake(key: string): BakedSculpt {
    const tiles: [string, string][] = [];
    for (const [k, tile] of this.tiles) {
      if (tile.some((v) => v !== 0)) tiles.push([k, toBase64(new Uint8Array(tile.buffer, tile.byteOffset, tile.byteLength))]);
    }
    return { version: 1, key, step: SCULPT_STEP, tile: TILE, tiles };
  }

  /** Поле из готового файла; не тот формат — undefined. */
  static fromBaked(baked: unknown, key: string): SculptField | undefined {
    const b = baked as Partial<BakedSculpt> | null;
    if (!b || b.version !== 1 || b.key !== key || b.step !== SCULPT_STEP || b.tile !== TILE || !Array.isArray(b.tiles)) return undefined;
    const field = new SculptField();
    for (const entry of b.tiles) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string' || typeof entry[1] !== 'string') return undefined;
      const bytes = fromBase64(entry[1]);
      if (bytes.byteLength !== TILE * TILE * 4) return undefined;
      field.tiles.set(entry[0], new Float32Array(bytes.buffer, bytes.byteOffset, TILE * TILE));
    }
    return field;
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

/** Готовое поле правок рельефа (файл sculpt.json). */
export interface BakedSculpt {
  version: 1;
  key: string;
  step: number;
  tile: number;
  tiles: [string, string][];
}

/**
 * Подпись правок рельефа: мазки (их id и число касаний) и вид, от которого зависит земля под ними
 * (перепады, съёмка с дрона). Поменялось что-то — готовое поле не подходит.
 */
export function sculptKey(strokes: readonly SculptStroke[], view: string): string {
  let h = 2166136261;
  const text = `${view}|${strokes.map((s) => `${s.id}:${s.dabs.length}:${s.area?.length ?? 0}`).join(',')}`;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${strokes.length}-${(h >>> 0).toString(36)}`;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function inside(x: number, y: number, ring: readonly Vec2[]): boolean {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

function segDist(x: number, y: number, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const t = Math.min(1, Math.max(0, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(x - a[0] - dx * t, y - a[1] - dy * t);
}

/** Скользящее среднее по строкам (along) или столбцам, окно 2r + 1, края — повтором крайнего узла. */
function boxBlur(v: Float32Array, w: number, h: number, r: number, along: boolean): void {
  const n = along ? w : h;
  const lines = along ? h : w;
  const stride = along ? 1 : w;
  const tmp = new Float32Array(n);
  for (let l = 0; l < lines; l++) {
    const start = along ? l * w : l;
    let sum = 0;
    for (let q = -r; q <= r; q++) sum += v[start + Math.min(n - 1, Math.max(0, q)) * stride]!;
    for (let q = 0; q < n; q++) {
      tmp[q] = sum / (2 * r + 1);
      sum += v[start + Math.min(n - 1, q + r + 1) * stride]! - v[start + Math.max(0, q - r) * stride]!;
    }
    for (let q = 0; q < n; q++) v[start + q * stride] = tmp[q]!;
  }
}

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
  for (const stroke of strokes) {
    if (stroke.area) field.area(stroke, stroke.area.map(toLocal), ground);
    for (const dab of stroke.dabs) field.dab(stroke, toLocal(dab), ground);
  }
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
  const area = (Array.isArray(v.area) ? v.area : []).filter(
    (p): p is [number, number] => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number' && Number.isFinite(n)),
  );
  const isArea = area.length >= 3 && AREA_MODES.includes(v.mode);
  if (!dabs.length && !isArea) return undefined;
  const level = Number(v.level);
  return {
    id: v.id,
    mode: v.mode,
    radius: Math.min(Math.max(radius, SCULPT_RADIUS.min), SCULPT_RADIUS.max),
    strength: Math.min(Math.max(strength, SCULPT_STRENGTH.min), SCULPT_STRENGTH.max),
    ...(v.mode === 'flatten' && Number.isFinite(level) ? { level } : {}),
    ...(v.mode === 'flatten' && (v.levelBy === 'low' || v.levelBy === 'high') ? { levelBy: v.levelBy } : {}),
    dabs,
    ...(isArea ? { area } : {}),
  };
}
