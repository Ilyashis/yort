// Выравнивание земли под жизнь: площадка под каждым домом и его двором, улица — по высотам домов вдоль
// неё, вода — ровно поперёк русла и только вниз по течению. Считает поправку к естественному рельефу
// на сетке высот; ничего не знает про сцену, поэтому проверяется тестами.

import { pointInRing, segDist2, type P2 } from '../core/geo';
import type { Rect } from './shared';

export interface LevelHouse {
  id: string;
  /** Контур дома. */
  ring: readonly P2[];
  /** Дворовые постройки того же хозяина — встают на ту же высоту. */
  pads?: readonly (readonly P2[])[];
  /** Насколько участок поднят (+) или опущен (−) относительно своей естественной высоты, м. */
  lift?: number;
}

export interface LevelInput {
  rect: Rect;
  step: number;
  nx: number;
  nz: number;
  /** Естественные высоты в узлах (строка за строкой, с севера на юг). */
  natural: Float32Array;
  houses: readonly LevelHouse[];
  roads: readonly { pts: readonly P2[]; width: number }[];
  /** Контуры воды: у каждого первое кольцо — берег, остальные — острова. */
  water: readonly (readonly (readonly P2[])[])[];
}

export interface Levels {
  /** Поправка к естественной высоте в каждом узле, м. */
  lev: Float32Array;
  /** Высота площадки каждого дома (с учётом подъёма), м. */
  houseLevel: Map<string, number>;
}

/** Площадка ровная на столько метров от стен дома, дальше плавно сходит к естественной земле. */
const HOUSE_FLAT = 7;
const HOUSE_FADE = 19;
const PAD_FLAT = 2.5;
const PAD_FADE = 8;
/** Дом влияет на улицу, если он не дальше этого от её оси, м. */
const STREET_NEAR = 16;
const STREET_FAR = 42;
/** Вдоль улицы влияние дома затухает на этой длине, м. */
const STREET_SPAN = 13;
/** Вес естественного профиля улицы: держит её там, где домов рядом нет. */
const STREET_ANCHOR = 0.3;
/** Двор чуть выше проезжей части. */
const YARD_ABOVE_ROAD = 0.12;
/** Обочина: от края полотна до естественной земли, м. */
const ROAD_SHOULDER = 6;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function median(values: number[]): number {
  values.sort((a, b) => a - b);
  const m = values.length >> 1;
  return values.length % 2 ? values[m] : (values[m - 1] + values[m]) / 2;
}

/** Расстояние до контура: внутри — 0. */
function outside(x: number, z: number, ring: readonly P2[]): number {
  if (pointInRing(x, z, ring)) return 0;
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    best = Math.min(best, segDist2(x, z, a[0], a[1], b[0], b[1])[0]);
  }
  return Math.sqrt(best);
}

/** Возрастающая последовательность, ближайшая к данной (изотоническая регрессия). */
export function monotone(values: readonly number[]): number[] {
  const sum: number[] = [], count: number[] = [];
  for (const v of values) {
    sum.push(v);
    count.push(1);
    while (sum.length > 1 && sum[sum.length - 2] / count[count.length - 2] > sum[sum.length - 1] / count[count.length - 1]) {
      const s = sum.pop()!, c = count.pop()!;
      sum[sum.length - 1] += s;
      count[count.length - 1] += c;
    }
  }
  return sum.flatMap((s, i) => Array.from({ length: count[i] }, () => s / count[i]));
}

export function computeLevels(input: LevelInput): Levels {
  const { rect, step, nx, nz, natural } = input;
  const target = Float32Array.from(natural);
  const col = (x: number) => (x - rect.x0) / step, row = (z: number) => (z - rect.z0) / step;
  const at = (x: number, z: number): number => {
    const fx = Math.min(nx - 1.001, Math.max(0, col(x))), fz = Math.min(nz - 1.001, Math.max(0, row(z)));
    const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j, k = j * nx + i;
    return (natural[k] * (1 - tx) + natural[k + 1] * tx) * (1 - tz) + (natural[k + nx] * (1 - tx) + natural[k + nx + 1] * tx) * tz;
  };
  /** Узлы в прямоугольнике вокруг контура с запасом reach. */
  const around = (ring: readonly P2[], reach: number, fn: (k: number, x: number, z: number) => void) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of ring) {
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      z0 = Math.min(z0, z);
      z1 = Math.max(z1, z);
    }
    const i0 = Math.max(0, Math.floor(col(x0 - reach))), i1 = Math.min(nx - 1, Math.ceil(col(x1 + reach)));
    const j0 = Math.max(0, Math.floor(row(z0 - reach))), j1 = Math.min(nz - 1, Math.ceil(row(z1 + reach)));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) fn(j * nx + i, rect.x0 + i * step, rect.z0 + j * step);
  };

  // 1. Дома: высота площадки — медиана естественной земли под домом, плюс подъём, заданный в редакторе.
  const houseLevel = new Map<string, number>();
  const sumL = new Map<number, number>(), sumW = new Map<number, number>(), maxW = new Map<number, number>();
  const sites: { x: number; z: number; level: number; weight: number }[] = [];
  for (const house of input.houses) {
    if (house.ring.length < 3) continue;
    const under: number[] = [];
    around(house.ring, 2, (k, x, z) => {
      if (outside(x, z, house.ring) <= 2) under.push(natural[k]);
    });
    let cx = 0, cz = 0;
    for (const [x, z] of house.ring) {
      cx += x / house.ring.length;
      cz += z / house.ring.length;
    }
    const level = (under.length ? median(under) : at(cx, cz)) + (house.lift ?? 0);
    houseLevel.set(house.id, level);
    sites.push({ x: cx, z: cz, level, weight: house.lift ? 4 : 1 });
    const spread = (ring: readonly P2[], flat: number, fade: number) =>
      around(ring, fade, (k, x, z) => {
        const w = 1 - smooth(flat, fade, outside(x, z, ring));
        if (w <= 0) return;
        sumL.set(k, (sumL.get(k) ?? 0) + w * w * level);
        sumW.set(k, (sumW.get(k) ?? 0) + w * w);
        maxW.set(k, Math.max(maxW.get(k) ?? 0, w));
      });
    spread(house.ring, HOUSE_FLAT, HOUSE_FADE);
    for (const pad of house.pads ?? []) if (pad.length >= 3) spread(pad, PAD_FLAT, PAD_FADE);
  }
  for (const [k, w] of maxW) target[k] = natural[k] + (sumL.get(k)! / sumW.get(k)! - natural[k]) * w;

  // 2. Улицы: вдоль оси — профиль, который тянется к высотам домов рядом; поперёк полотно ровное.
  const best = new Map<number, { out: number; h: number }>();
  for (const road of input.roads) {
    const pts = road.pts;
    if (pts.length < 2) continue;
    const starts = [0];
    for (let i = 1; i < pts.length; i++) starts.push(starts[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const total = starts[starts.length - 1];
    if (total < 1) continue;
    // Дома у этой улицы: где они вдоль неё и с каким весом.
    const near: { s: number; level: number; weight: number }[] = [];
    for (const site of sites) {
      let d2 = Infinity, s = 0;
      for (let i = 0; i + 1 < pts.length; i++) {
        const [q, t] = segDist2(site.x, site.z, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
        if (q < d2) {
          d2 = q;
          s = starts[i] + t * (starts[i + 1] - starts[i]);
        }
      }
      const w = 1 - smooth(STREET_NEAR, STREET_FAR, Math.sqrt(d2));
      if (w > 0) near.push({ s, level: site.level - YARD_ABOVE_ROAD, weight: w * site.weight });
    }
    const n = Math.max(2, Math.ceil(total / step) + 1);
    const ds = total / (n - 1);
    let profile = new Float64Array(n);
    let seg = 0;
    for (let j = 0; j < n; j++) {
      const s = j * ds;
      while (seg < pts.length - 2 && starts[seg + 1] < s) seg++;
      const t = (s - starts[seg]) / (starts[seg + 1] - starts[seg] || 1);
      let sum = STREET_ANCHOR * at(pts[seg][0] + (pts[seg + 1][0] - pts[seg][0]) * t, pts[seg][1] + (pts[seg + 1][1] - pts[seg][1]) * t), wsum = STREET_ANCHOR;
      for (const h of near) {
        const g = Math.exp(-(((s - h.s) / STREET_SPAN) ** 2)) * h.weight;
        sum += g * h.level;
        wsum += g;
      }
      profile[j] = sum / wsum;
    }
    for (let pass = 0; pass < 2; pass++) {
      const next = new Float64Array(n);
      for (let j = 0; j < n; j++) next[j] = (profile[Math.max(0, j - 1)] + 2 * profile[j] + profile[Math.min(n - 1, j + 1)]) / 4;
      profile = next;
    }
    const flat = road.width / 2 + 1, reach = flat + ROAD_SHOULDER;
    for (let i = 0; i + 1 < pts.length; i++) {
      around([pts[i], pts[i + 1]] as P2[], reach, (k, x, z) => {
        const [q, t] = segDist2(x, z, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
        const out = Math.sqrt(q) - flat;
        if (out >= ROAD_SHOULDER) return;
        const prev = best.get(k);
        if (prev && prev.out <= out) return;
        const f = (starts[i] + t * (starts[i + 1] - starts[i])) / ds;
        const j = Math.min(n - 2, Math.floor(f));
        best.set(k, { out, h: profile[j] + (profile[j + 1] - profile[j]) * (f - j) });
      });
    }
  }
  for (const [k, { out, h }] of best) target[k] += (h - target[k]) * (1 - smooth(0, ROAD_SHOULDER, out));
  // На перекрёстках профили двух улиц расходятся на сантиметры — сглаживаем полотно.
  for (let pass = 0; pass < 2; pass++) {
    const next = new Map<number, number>();
    for (const k of best.keys()) {
      const i = k % nx, j = (k - i) / nx;
      if (i < 1 || j < 1 || i > nx - 2 || j > nz - 2) continue;
      next.set(k, (target[k] * 4 + target[k - 1] + target[k + 1] + target[k - nx] + target[k + nx]) / 8);
    }
    for (const [k, v] of next) target[k] = v;
  }

  // 3. Вода: поперёк русла одна высота, вдоль — только вниз; озёра и пруды — ровные.
  const wet = new Uint8Array(nx * nz);
  for (const rings of input.water) {
    let z0 = Infinity, z1 = -Infinity;
    for (const [, z] of rings[0] ?? []) {
      z0 = Math.min(z0, z);
      z1 = Math.max(z1, z);
    }
    const xs: number[] = [];
    for (let j = Math.max(0, Math.ceil(row(z0))); j <= Math.min(nz - 1, Math.floor(row(z1))); j++) {
      const z = rect.z0 + j * step;
      xs.length = 0;
      for (const ring of rings) {
        for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
          if (ring[a][1] > z !== ring[b][1] > z) xs.push(ring[a][0] + ((z - ring[a][1]) * (ring[b][0] - ring[a][0])) / (ring[b][1] - ring[a][1]));
        }
      }
      xs.sort((p, q) => p - q);
      for (let m = 0; m + 1 < xs.length; m += 2) {
        for (let i = Math.max(0, Math.ceil(col(xs[m]))); i <= Math.min(nx - 1, Math.floor(col(xs[m + 1]))); i++) wet[j * nx + i] = 1;
      }
    }
    // Узкий ручей может пройти между узлами — отмечаем узлы вдоль берега, чтобы русло не рвалось.
    const bank = rings[0] ?? [];
    for (let a = 0; a < bank.length; a++) {
      const p = bank[a], q = bank[(a + 1) % bank.length];
      const count = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / (step / 2)));
      for (let m = 0; m <= count; m++) {
        const i = Math.round(col(p[0] + ((q[0] - p[0]) * m) / count)), j = Math.round(row(p[1] + ((q[1] - p[1]) * m) / count));
        if (i >= 0 && j >= 0 && i < nx && j < nz) wet[j * nx + i] = 1;
      }
    }
  }
  const NEAR = [-nx - 1, -nx, -nx + 1, -1, 1, nx - 1, nx, nx + 1];
  const neighbours = (k: number, fn: (m: number) => void) => {
    const i = k % nx;
    for (const d of NEAR) {
      const m = k + d, mi = m % nx;
      if (m >= 0 && m < wet.length && Math.abs(mi - i) <= 1) fn(m);
    }
  };
  /** Расстояние по воде (в шагах сетки) от узла до остальных узлов того же водоёма. */
  const hops = new Int32Array(nx * nz).fill(-1);
  const flood = (from: number): number[] => {
    const order = [from];
    hops[from] = 0;
    for (let head = 0; head < order.length; head++) {
      const k = order[head];
      neighbours(k, (m) => {
        if (!wet[m] || hops[m] >= 0) return;
        hops[m] = hops[k] + 1;
        order.push(m);
      });
    }
    return order;
  };
  const done = new Uint8Array(nx * nz);
  const BIN = 3;
  for (let seed = 0; seed < wet.length; seed++) {
    if (!wet[seed] || done[seed]) continue;
    // Два конца водоёма: самый дальний узел от любого, потом самый дальний от него.
    let body = flood(seed);
    const endA = body[body.length - 1];
    for (const k of body) hops[k] = -1;
    body = flood(endA);
    const endB = body[body.length - 1];
    const length = hops[endB];
    for (const k of body) done[k] = 1;
    const heights = body.map((k) => natural[k]);
    let level: (k: number) => number;
    if (body.length < 4 || body.length > 0.35 * length * length) {
      // Пруд или широкая вода: одна высота, по нижнему краю берега.
      const flat = [...heights].sort((a, b) => a - b)[Math.floor(heights.length * 0.15)];
      level = () => flat;
    } else {
      const bins: number[][] = Array.from({ length: Math.floor(length / BIN) + 1 }, () => []);
      for (const k of body) bins[Math.floor(hops[k] / BIN)].push(natural[k]);
      let line = bins.map((b) => (b.length ? median(b) : NaN));
      for (let i = 0; i < line.length; i++) if (Number.isNaN(line[i])) line[i] = line[i - 1] ?? line.find((v) => !Number.isNaN(v)) ?? 0;
      // Течёт от высокого конца к низкому: делаем профиль монотонным в эту сторону.
      const third = Math.max(1, Math.floor(line.length / 3));
      const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
      const rising = mean(line.slice(-third)) >= mean(line.slice(0, third));
      line = rising ? monotone(line) : monotone([...line].reverse()).reverse();
      for (let pass = 0; pass < 2; pass++) line = line.map((v, i) => (line[Math.max(0, i - 1)] + 2 * v + line[Math.min(line.length - 1, i + 1)]) / 4);
      level = (k) => {
        const f = Math.min(line.length - 1, hops[k] / BIN);
        const i = Math.min(line.length - 2, Math.floor(f));
        return i < 0 ? line[0] : line[i] + (line[i + 1] - line[i]) * (f - i);
      };
    }
    for (const k of body) target[k] = level(k) - 0.1;
    // Берег: не ниже воды и без ступеньки у самой кромки.
    for (const k of body) {
      neighbours(k, (m) => {
        if (wet[m]) return;
        const water = target[k] + 0.1;
        target[m] = target[m] < water ? water + 0.05 : Math.min(target[m], (target[m] + water) / 2 + 0.4);
      });
    }
    for (const k of body) hops[k] = -1;
  }

  const lev = new Float32Array(nx * nz);
  for (let k = 0; k < lev.length; k++) lev[k] = target[k] - natural[k];
  return { lev, houseLevel };
}

export interface LevelSpot {
  x: number;
  z: number;
  /** Высота, которую земля должна иметь в этой точке (в метрах сетки высот). */
  height: number;
  /** Дальше этого от отметки земля не меняется, м. */
  radius: number;
}

/**
 * Опорные отметки: земля проходит точно через каждую, между ними поправка плавно перетекает от одной
 * к другой (чем ближе отметка, тем больше её вес), а к краю радиуса сходит на нет. Меняет lev на месте.
 */
export function applySpots(grid: Pick<LevelInput, 'rect' | 'step' | 'nx' | 'nz' | 'natural'>, lev: Float32Array, spots: readonly LevelSpot[]): void {
  if (!spots.length) return;
  const { rect, step, nx, nz, natural } = grid;
  const ground = (k: number) => natural[k] + lev[k];
  // Насколько каждая отметка выше или ниже уже выровненной земли под ней.
  const need = spots.map((s) => {
    const fx = Math.min(nx - 1.001, Math.max(0, (s.x - rect.x0) / step)), fz = Math.min(nz - 1.001, Math.max(0, (s.z - rect.z0) / step));
    const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j, k = j * nx + i;
    return s.height - ((ground(k) * (1 - tx) + ground(k + 1) * tx) * (1 - tz) + (ground(k + nx) * (1 - tx) + ground(k + nx + 1) * tx) * tz);
  });
  const touched = new Map<number, [number, number, number]>();
  spots.forEach((s, n) => {
    const i0 = Math.max(0, Math.floor((s.x - s.radius - rect.x0) / step)), i1 = Math.min(nx - 1, Math.ceil((s.x + s.radius - rect.x0) / step));
    const j0 = Math.max(0, Math.floor((s.z - s.radius - rect.z0) / step)), j1 = Math.min(nz - 1, Math.ceil((s.z + s.radius - rect.z0) / step));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const d = Math.hypot(rect.x0 + i * step - s.x, rect.z0 + j * step - s.z);
        const fade = 1 - smooth(0.25, 1, d / s.radius);
        if (fade <= 0) continue;
        const w = fade / (d * d + 0.05);
        const acc = touched.get(j * nx + i) ?? [0, 0, 0];
        acc[0] += w * need[n];
        acc[1] += w;
        acc[2] = Math.max(acc[2], fade);
        touched.set(j * nx + i, acc);
      }
    }
  });
  for (const [k, [sum, weight, fade]] of touched) lev[k] += (sum / weight) * fade;
}

export interface LevelShape {
  kind: 'plane' | 'smooth' | 'natural' | 'lift';
  /** Контур области (лассо); нет — круг радиуса radius вокруг (x, z). */
  ring?: readonly P2[];
  /** Для «lift»: на сколько поднять (+) или опустить (−) землю внутри, м. */
  lift?: number;
  x: number;
  z: number;
  radius: number;
  /** Какая доля радиуса уходит на плавный переход к земле вокруг: 0,12 — терраса с крутым краем, 0,4 — мягко. */
  edge: number;
  /** Плоскость: высота в центре (в метрах сетки высот), уклон в процентах и куда она поднимается (градусы от севера по часовой). */
  height?: number;
  slope?: number;
  bearing?: number;
}

/**
 * Правки рельефа по областям, по порядку: плоскость с заданной высотой и уклоном (ровная площадка и
 * терраса — она же с нулевым уклоном), сглаживание, возврат к естественной земле. Меняет lev на месте.
 */
export function applyShapes(grid: Pick<LevelInput, 'rect' | 'step' | 'nx' | 'nz' | 'natural'>, lev: Float32Array, shapes: readonly LevelShape[]): void {
  const { rect, step, nx, nz, natural } = grid;
  for (const shape of shapes) {
    const ring = shape.ring && shape.ring.length >= 3 ? shape.ring : undefined;
    const bx0 = ring ? Math.min(...ring.map((p) => p[0])) : shape.x - shape.radius, bx1 = ring ? Math.max(...ring.map((p) => p[0])) : shape.x + shape.radius;
    const bz0 = ring ? Math.min(...ring.map((p) => p[1])) : shape.z - shape.radius, bz1 = ring ? Math.max(...ring.map((p) => p[1])) : shape.z + shape.radius;
    const i0 = Math.max(0, Math.floor((bx0 - rect.x0) / step)), i1 = Math.min(nx - 1, Math.ceil((bx1 - rect.x0) / step));
    const j0 = Math.max(0, Math.floor((bz0 - rect.z0) / step)), j1 = Math.min(nz - 1, Math.ceil((bz1 - rect.z0) / step));
    const edge = Math.min(0.9, Math.max(0.05, shape.edge));
    /** Вес правки в точке: 1 в глубине области, плавно до 0 у её границы. */
    const weight = (x: number, z: number): number => {
      if (!ring) return 1 - smooth(1 - edge, 1, Math.hypot(x - shape.x, z - shape.z) / shape.radius);
      if (!pointInRing(x, z, ring)) return 0;
      let d2 = Infinity;
      for (let n = 0; n < ring.length; n++) {
        const a = ring[n], b = ring[(n + 1) % ring.length];
        d2 = Math.min(d2, segDist2(x, z, a[0], a[1], b[0], b[1])[0]);
      }
      return smooth(0, Math.max(step * 0.5, edge * shape.radius), Math.sqrt(d2));
    };
    const b = ((shape.bearing ?? 0) * Math.PI) / 180;
    const ux = Math.sin(b), uz = -Math.cos(b);
    // Сглаживание берёт среднее по соседям из земли «до» — поэтому сначала снимок.
    const reach = Math.max(1, Math.round((shape.radius * 0.3) / step));
    const before = shape.kind === 'smooth' ? Float32Array.from(lev) : lev;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = rect.x0 + i * step, z = rect.z0 + j * step;
        const w = weight(x, z);
        if (w <= 0) continue;
        const k = j * nx + i;
        if (shape.kind === 'lift') {
          lev[k] += (shape.lift ?? 0) * w;
          continue;
        }
        let target: number;
        if (shape.kind === 'natural') target = natural[k];
        else if (shape.kind === 'plane') target = (shape.height ?? natural[k] + lev[k]) + ((shape.slope ?? 0) / 100) * ((x - shape.x) * ux + (z - shape.z) * uz);
        else {
          let sum = 0, count = 0;
          for (let dj = -reach; dj <= reach; dj++) {
            for (let di = -reach; di <= reach; di++) {
              const ii = i + di, jj = j + dj;
              if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue;
              sum += natural[jj * nx + ii] + before[jj * nx + ii];
              count++;
            }
          }
          target = sum / count;
        }
        lev[k] += (target - natural[k] - lev[k]) * w;
      }
    }
  }
}

/** Плоскость, лучше всего ложащаяся на землю в круге: высота в центре, уклон (%) и куда поднимается (° от севера). */
export function fitPlaneAt(heightAt: (x: number, z: number) => number, x: number, z: number, radius: number): { height: number; slope: number; bearing: number } {
  let n = 0, sx = 0, sz = 0, sh = 0, sxx = 0, szz = 0, sxz = 0, sxh = 0, szh = 0;
  const cell = radius / 8;
  for (let dz = -radius; dz <= radius; dz += cell) {
    for (let dx = -radius; dx <= radius; dx += cell) {
      if (dx * dx + dz * dz > radius * radius) continue;
      const h = heightAt(x + dx, z + dz);
      n++;
      sx += dx;
      sz += dz;
      sh += h;
      sxx += dx * dx;
      szz += dz * dz;
      sxz += dx * dz;
      sxh += dx * h;
      szh += dz * h;
    }
  }
  // Точки стоят симметрично вокруг центра, поэтому суммы sx, sz ≈ 0 и уравнения распадаются.
  const det = sxx * szz - sxz * sxz;
  const gx = det ? ((sxh - (sx * sh) / n) * szz - (szh - (sz * sh) / n) * sxz) / det : 0;
  const gz = det ? ((szh - (sz * sh) / n) * sxx - (sxh - (sx * sh) / n) * sxz) / det : 0;
  const slope = Math.hypot(gx, gz) * 100;
  const bearing = slope < 0.05 ? 0 : (((Math.atan2(gx, -gz) * 180) / Math.PI) + 360) % 360;
  return { height: sh / n, slope, bearing };
}

export interface LevelLine {
  /** Линия на земле (мир). */
  pts: readonly P2[];
  /** Высота, которую земля должна иметь вдоль линии (в метрах сетки высот). */
  height: number;
  /** Дальше этого от линии земля не меняется, м. */
  radius: number;
}

/**
 * Проведённые горизонтали: вдоль каждой линии земля встаёт на её высоту — горизонталь этой высоты проходит
 * по линии, — а в стороны поправка плавно сходит на нет к краю радиуса. Меняет lev на месте.
 */
export function applyLines(grid: Pick<LevelInput, 'rect' | 'step' | 'nx' | 'nz' | 'natural'>, lev: Float32Array, lines: readonly LevelLine[]): void {
  const { rect, step, nx, nz, natural } = grid;
  for (const line of lines) {
    if (line.pts.length < 2) continue;
    const xs = line.pts.map((p) => p[0]), zs = line.pts.map((p) => p[1]);
    const i0 = Math.max(0, Math.floor((Math.min(...xs) - line.radius - rect.x0) / step)), i1 = Math.min(nx - 1, Math.ceil((Math.max(...xs) + line.radius - rect.x0) / step));
    const j0 = Math.max(0, Math.floor((Math.min(...zs) - line.radius - rect.z0) / step)), j1 = Math.min(nz - 1, Math.ceil((Math.max(...zs) + line.radius - rect.z0) / step));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = rect.x0 + i * step, z = rect.z0 + j * step;
        let d2 = Infinity;
        for (let n = 0; n + 1 < line.pts.length; n++) {
          const a = line.pts[n], b = line.pts[n + 1];
          d2 = Math.min(d2, segDist2(x, z, a[0], a[1], b[0], b[1])[0]);
        }
        // Вплотную к линии (до полушага сетки) — точно её высота, дальше — плавно к прежней земле.
        const w = 1 - smooth(Math.min(step * 0.5, line.radius * 0.3) / line.radius, 1, Math.sqrt(d2) / line.radius);
        if (w <= 0) continue;
        const k = j * nx + i;
        lev[k] += (line.height - natural[k] - lev[k]) * w;
      }
    }
  }
}
