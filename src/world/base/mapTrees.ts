// Деревья по карте (снимку с дрона): где на снимке кроны — тёмно-зелёные пятна (трава светлее и желтее,
// пашни и огороды бурые, тени — почти чёрные), — сажаем деревья. Снимок режем на клетки со стороной в шаг
// посадки: в клетке, где доля «кронных» пикселей не меньше порога, — одно дерево в середине кроны.
// Высота — по тому, насколько клетка заросла. Чистые функции: пиксели и преобразования — снаружи.

import type { Vec2 } from '../walk/localFrame';

/** Пышность посадки: шаг (м) и какая доля клетки должна быть кроной. */
export type MapTreesMode = 'off' | 'sparse' | 'normal' | 'lush';

export const MAP_TREE_MODES: Record<Exclude<MapTreesMode, 'off'>, { label: string; spacing: number; cover: number }> = {
  sparse: { label: 'Редко', spacing: 9, cover: 0.5 },
  normal: { label: 'Средне', spacing: 6, cover: 0.4 },
  lush: { label: 'Пышно', spacing: 4.2, cover: 0.3 },
};

/** Крона пёстрая (листва и тени в ней): разброс яркости в клетке не меньше этого. Трава — ровнее. */
const MIN_TEXTURE = 14;

/**
 * Пиксель снимка похож на крону дерева: тёмная зелень (яркость кроны на снимке — 40…65, травы — 80…120;
 * пашни и крыши — не зелёные).
 */
export function isCanopy(r: number, g: number, b: number): boolean {
  const lum = 0.3 * r + 0.59 * g + 0.11 * b;
  return lum >= 18 && lum <= 72 && g >= r && g >= b * 1.1;
}

export interface MapTreeOptions {
  spacing: number;
  cover: number;
  /** Сторона пикселя снимка, м. */
  pixel: number;
  /** Можно ли сажать в этой точке (не на доме, дороге, не в лесу из OSM, не вплотную к другим деревьям). */
  allowed: (x: number, y: number) => boolean;
}

/**
 * Места для деревьев по снимку: rgba — пиксели (w × h), toLocal — середина пикселя (px, py) в локальные метры.
 * Возвращает [x, y, высота].
 */
export function findTreeSpots(rgba: Uint8ClampedArray, w: number, h: number, toLocal: (px: number, py: number) => Vec2, o: MapTreeOptions): [number, number, number][] {
  const step = Math.max(1, Math.round(o.spacing / o.pixel));
  const out: [number, number, number][] = [];
  for (let cy = 0; cy + step <= h; cy += step) {
    for (let cx = 0; cx + step <= w; cx += step) {
      let n = 0;
      let sx = 0;
      let sy = 0;
      let sum = 0;
      let sum2 = 0;
      let empty = false;
      for (let y = cy; y < cy + step && !empty; y++) {
        let i = (y * w + cx) * 4;
        for (let x = cx; x < cx + step; x++, i += 4) {
          // Край снимка (прозрачное) — клетку пропускаем.
          if (rgba[i + 3]! < 200) {
            empty = true;
            break;
          }
          const r = rgba[i]!;
          const g = rgba[i + 1]!;
          const b = rgba[i + 2]!;
          const lum = 0.3 * r + 0.59 * g + 0.11 * b;
          sum += lum;
          sum2 += lum * lum;
          if (!isCanopy(r, g, b)) continue;
          n++;
          sx += x;
          sy += y;
        }
      }
      const count = step * step;
      const share = n / count;
      if (empty || share < o.cover) continue;
      const mean = sum / count;
      if (Math.sqrt(Math.max(0, sum2 / count - mean * mean)) < MIN_TEXTURE) continue;
      const [x, y] = toLocal(sx / n, sy / n);
      if (!o.allowed(x, y)) continue;
      // Чем гуще клетка, тем выше дерево: 4,5…9 м (плюс немного случайности по месту).
      const jitter = ((Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1 + 1) % 1;
      out.push([x, y, 4.5 + Math.min(1, (share - o.cover) / (1 - o.cover)) * 3.5 + jitter * 1.2]);
    }
  }
  return out;
}

/** Растр занятых мест (шаг cell м): дома, дороги, уже стоящие деревья — туда деревья по карте не сажаем. */
export class BlockedGrid {
  private readonly cells = new Set<number>();
  constructor(private readonly cell = 1.5) {}

  private key(i: number, j: number): number {
    return (i + 50000) * 100000 + (j + 50000);
  }

  /** Круг радиусом r вокруг точки. */
  circle(x: number, y: number, r: number): void {
    const c = this.cell;
    for (let i = Math.floor((x - r) / c); i <= Math.floor((x + r) / c); i++)
      for (let j = Math.floor((y - r) / c); j <= Math.floor((y + r) / c); j++) if (Math.hypot((i + 0.5) * c - x, (j + 0.5) * c - y) <= r + c * 0.71) this.cells.add(this.key(i, j));
  }

  /** Полоса вдоль ломаной полушириной half. */
  line(points: readonly Vec2[], half: number): void {
    for (let k = 1; k < points.length; k++) {
      const [ax, ay] = points[k - 1]!;
      const [bx, by] = points[k]!;
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / this.cell));
      for (let s = 0; s <= n; s++) this.circle(ax + ((bx - ax) * s) / n, ay + ((by - ay) * s) / n, half);
    }
  }

  /** Многоугольник с запасом margin. */
  polygon(ring: readonly Vec2[], margin: number): void {
    if (ring.length < 3) return;
    const xs = ring.map((p) => p[0]);
    const ys = ring.map((p) => p[1]);
    const c = this.cell;
    for (let i = Math.floor((Math.min(...xs) - margin) / c); i <= Math.floor((Math.max(...xs) + margin) / c); i++) {
      for (let j = Math.floor((Math.min(...ys) - margin) / c); j <= Math.floor((Math.max(...ys) + margin) / c); j++) {
        const x = (i + 0.5) * c;
        const y = (j + 0.5) * c;
        if (inside(x, y, ring) || nearRing(x, y, ring) <= margin + c * 0.71) this.cells.add(this.key(i, j));
      }
    }
  }

  has(x: number, y: number): boolean {
    return this.cells.has(this.key(Math.floor(x / this.cell), Math.floor(y / this.cell)));
  }
}

export function inside(x: number, y: number, ring: readonly Vec2[]): boolean {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

function nearRing(x: number, y: number, ring: readonly Vec2[]): number {
  let d = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j]!;
    const [bx, by] = ring[i]!;
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    d = Math.min(d, Math.hypot(x - ax - dx * t, y - ay - dy * t));
  }
  return d;
}
