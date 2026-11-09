// Посёлок «как он мог бы выглядеть» (моя интерпретация): земля вдоль улиц нарезана на участки домов —
// вплотную, общими заборами. У каждого участка — уличный забор с воротами и калиткой, двор с подъездом,
// хозпостройки (сарай, баня, туалет, теплица, колодец), поленница и прочая мелочь, сад и огород до задов.
// В OSM участков нет — строим правдоподобные по домам и улицам. Чистые функции, локальные метры.
//
// Как режем. Растр с шагом 1 м вокруг деревни. Клетка достаётся дому с наименьшей «ценой»: вбок от дома
// цена — метры, вглубь участка за домом — в CHEAP_DEPTH раз дешевле, перед уличным забором — нельзя.
// Так участки вытягиваются от улицы вглубь, а граница соседей ложится посередине между домами. Дороги,
// тропы, вода, лес и общественные здания — ничьи. Границы клеток разных хозяев — цепочки, упрощённые до
// прямых: по ним и стоят заборы (у соседей забор один на двоих).

import { hashString, random01 } from '../../utils/hash';
import { openRing, orientedBox, signedArea } from '../base/roofGeometry';
import type { Vec2 } from '../walk/localFrame';

export interface EstateBuilding {
  id: string;
  ring: readonly Vec2[];
}

export interface EstateRoad {
  coords: readonly Vec2[];
  width: number;
}

export interface EstateInput {
  /** Жилые дома: у каждого — свой участок. */
  houses: readonly EstateBuilding[];
  /** Хозпостройки (OSM и съёмка): стоят внутри участков, заменяют часть придуманных построек. */
  sheds: readonly EstateBuilding[];
  /** Ничья земля: общественные здания, вода, лес (с запасом margin, м). */
  blockers: readonly { ring: readonly Vec2[]; margin: number }[];
  roads: readonly EstateRoad[];
  /** Просёлки и тропы: участки их не перегораживают. */
  tracks: readonly EstateRoad[];
}

export type OutbuildingModel = 'shed' | 'banya' | 'outhouse' | 'greenhouse' | 'well';
export type PropKind = 'woodpile' | 'beehive' | 'haystack' | 'doghouse' | 'bench' | 'compost';
export type FenceStyle = 'boards' | 'metal' | 'picket' | 'slats' | 'rails';
export type FenceKind = 'street' | 'side' | 'back';

/** Придуманная постройка двора: модель и прямоугольник под неё (против часовой, первая сторона — фасад с дверью). */
export interface EstateOutbuilding {
  id: string;
  model: OutbuildingModel;
  rect: Vec2[];
  seed: number;
}

/** Мелочь двора: точка, поворот (рад, ось x детали — вдоль length), длина, зерно. */
export interface EstateProp {
  kind: PropKind;
  at: Vec2;
  angle: number;
  length: number;
  seed: number;
}

/** Ворота с калиткой в уличном заборе. */
export interface EstateGate {
  /** Середина проёма на линии забора. */
  at: Vec2;
  /** Вдоль забора и внутрь участка (единичные). */
  along: Vec2;
  inward: Vec2;
  /** Ширина ворот (две створки) и калитки, м. */
  gate: number;
  wicket: number;
  /** С какой стороны (по along) калитка. */
  wicketSide: -1 | 1;
  /** Ворота под двускатным козырьком. */
  canopy: boolean;
  style: FenceStyle;
  color: string;
}

export interface Plot {
  /** id участка — id дома («id здания OSM:номер контура»). */
  id: string;
  seed: number;
  /** Контур участка (против часовой). */
  ring: Vec2[];
  area: number;
  /** Оси участка: origin — точка уличного забора напротив дома, t — вдоль улицы, n — вглубь участка. */
  origin: Vec2;
  t: Vec2;
  n: Vec2;
  /** Есть ли у участка улица (иначе — забор со всех сторон жердями). */
  street: boolean;
  gate?: EstateGate;
  /** Палисадник перед домом — как у старых дворов (FrontGardensLayer). */
  palisade?: { origin: Vec2; toStreet: Vec2; width: number; depth: number };
  /** Подъезд от ворот во двор (утоптанная земля). */
  driveway?: Vec2[];
  /** Огород: контур и направление грядок. */
  garden?: { ring: Vec2[]; rows: Vec2 };
  outbuildings: EstateOutbuilding[];
  props: EstateProp[];
  /** Деревья: сад и берёзы у забора с улицы. */
  trees: Vec2[];
  /** Уличный забор участка. */
  fence: { style: FenceStyle; color: string; height: number };
}

/** Забор: ломаная, чьи участки он разделяет, вырезы (дуга от начала, м) — ворота, палисадник, стены построек. */
export interface FenceRun {
  owners: string[];
  kind: FenceKind;
  line: Vec2[];
  cuts: [number, number][];
  style: FenceStyle;
  color: string;
  height: number;
  seed: number;
}

export interface EstatePlan {
  plots: Plot[];
  runs: FenceRun[];
}

const CELL = 1;
/** Вглубь участка за домом клетка в столько раз «дешевле», чем вбок: участки вытянуты от улицы. */
const CHEAP_DEPTH = 0.3;
/** Насколько участок шире дома с каждой стороны, если соседей нет, м. */
const SIDE: [number, number] = [6, 11];
/** Глубина участка от уличного забора, м. */
const DEPTH: [number, number] = [40, 62];
/** Обочина между проезжей частью и уличным забором, м (своя у каждой улицы). */
const VERGE: [number, number] = [2.5, 4];
const MIN_VERGE = 1.5;
/** Дальше этого от оси дороги до фасада — у дома нет улицы, м. */
const STREET_REACH = 45;
/** Клетки у дороги: забор там — уличный. */
const NEAR_ROAD = 3;
/** Дом меньше — не жилой (сарай), больше — ферма или склад, м². */
const HOUSE_AREA: [number, number] = [45, 320];
/** Запас растра вокруг домов, м. */
const MARGIN = 70;
/** Упрощение границ: отклонение не больше, м. */
const SIMPLIFY = 0.8;

const BLOCK = 1;
const ROADSIDE = 2;
const BUILDING = 4;

const STREET_STYLES: [FenceStyle, number][] = [
  ['boards', 0.36],
  ['metal', 0.36],
  ['picket', 0.28],
];
/** Цвета уличных заборов: доска (натуральная и крашеная), профнастил, штакетник. */
const COLORS: Record<FenceStyle, string[]> = {
  boards: ['#8a6a48', '#7a5a3e', '#9a7a52', '#4f7a54', '#4d6f93', '#8b7b5e'],
  metal: ['#3f6b4f', '#5a3e32', '#3a5f86', '#7c3a2e', '#2f6f6a', '#8a8f86'],
  picket: ['#3d8a58', '#2f8f88', '#2f68b0', '#5f9fcf', '#e7e2d4', '#7a5a3e'],
  slats: ['#8d8579', '#7f776b', '#958a76'],
  rails: ['#8a7a64', '#7d6f5c'],
};
const HEIGHTS: Record<FenceStyle, number> = {
  boards: 1.8,
  metal: 1.85,
  picket: 1.4,
  slats: 1.35,
  rails: 1.2,
};

const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];
const add = (a: Vec2, b: Vec2, k = 1): Vec2 => [a[0] + b[0] * k, a[1] + b[1] * k];

/** Участки и заборы посёлка. */
export function planEstates(input: EstateInput): EstatePlan {
  const houses = input.houses
    .map((h) => ({ id: h.id, ring: openRing(h.ring) }))
    .filter((h) => {
      const area = Math.abs(signedArea(h.ring));
      return h.ring.length >= 3 && area >= HOUSE_AREA[0] && area <= HOUSE_AREA[1];
    });
  if (!houses.length) return { plots: [], runs: [] };

  // Растр вокруг домов.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const h of houses) {
    for (const [x, y] of h.ring) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  const grid = new Grid(
    Math.floor(minX - MARGIN),
    Math.floor(minY - MARGIN),
    Math.ceil((maxX - minX + 2 * MARGIN) / CELL),
    Math.ceil((maxY - minY + 2 * MARGIN) / CELL),
  );

  // Дороги: обочина каждой улицы — своя; ось с шириной — для фасада дома.
  const segments = input.roads.flatMap((road, k) => {
    const verge = VERGE[0] + random01(hashString(`verge:${k}`)) * (VERGE[1] - VERGE[0]);
    return road.coords.slice(1).map((b, i) => ({ a: road.coords[i]!, b, half: road.width / 2, verge }));
  });
  for (const s of segments) {
    grid.nearSegment(s.a, s.b, s.half + VERGE[1] + NEAR_ROAD, (i, d) => {
      grid.flags[i]! |= ROADSIDE;
      if (d < s.half + MIN_VERGE) grid.flags[i]! |= BLOCK;
    });
  }
  for (const track of input.tracks) {
    for (let k = 1; k < track.coords.length; k++) {
      grid.nearSegment(track.coords[k - 1]!, track.coords[k]!, track.width / 2 + 0.8, (i) => (grid.flags[i]! |= BLOCK));
    }
  }
  for (const b of input.blockers) {
    grid.polygon(openRing(b.ring), b.margin, (i) => (grid.flags[i]! |= BLOCK));
  }
  const buildings = [...houses, ...input.sheds.map((s) => ({ id: s.id, ring: openRing(s.ring) }))];
  for (const b of buildings) grid.polygon(b.ring, 0.3, (i) => (grid.flags[i]! |= BUILDING));

  // Оси каждого дома: ближайшая улица, уличный забор, глубина.
  const sites = houses.map((house, index) => siteOf(house, index, segments));

  // Кому достаётся клетка.
  const owner = new Int32Array(grid.w * grid.h).fill(-1);
  const cost = new Float32Array(grid.w * grid.h).fill(Infinity);
  for (const site of sites) {
    const { origin, t, n, ac, hl, back, sideCap, depth } = site;
    const reach = hl + sideCap;
    const corners = [
      add(add(origin, t, ac - reach), n, -1),
      add(add(origin, t, ac + reach), n, -1),
      add(add(origin, t, ac + reach), n, depth),
      add(add(origin, t, ac - reach), n, depth),
    ];
    grid.box(corners, (i, p) => {
      if (grid.flags[i]! & BLOCK) return;
      const rel = sub(p, origin);
      const d = dot(rel, n);
      if (d < 0 || d > depth) return;
      const e = Math.max(0, Math.abs(dot(rel, t) - ac) - hl);
      if (e > sideCap) return;
      const c = e + CHEAP_DEPTH * Math.max(0, d - back);
      if (c < cost[i]!) {
        cost[i] = c;
        owner[i] = site.index;
      }
    });
  }
  // Под самим домом — всегда его участок.
  for (const site of sites) {
    grid.polygon(site.house.ring, 0.4, (i) => {
      owner[i] = site.index;
      cost[i] = -1;
    });
  }
  // Каждому — только связный кусок с домом (обрезки за чужими участками — ничьи).
  keepConnected(grid, owner, sites);

  // Границы клеток → цепочки → заборы.
  const chains = traceBoundaries(grid, owner, sites.length);
  const plots: Plot[] = [];
  const plotChains = new Map<number, Chain[]>();
  for (const chain of chains) {
    for (const p of chain.plots) {
      const list = plotChains.get(p) ?? [];
      list.push(chain);
      plotChains.set(p, list);
    }
  }

  const taken = new Uint8Array(grid.w * grid.h);
  for (const b of buildings) grid.polygon(b.ring, 0.8, (i) => (taken[i] = 1));

  // Глубина каждого участка (дальняя клетка от уличного забора) — одним проходом.
  const maxDepth = new Float64Array(sites.length);
  for (let i = 0; i < owner.length; i++) {
    const o = owner[i]!;
    if (o < 0) continue;
    const site = sites[o]!;
    const c = grid.center(i);
    const d = (c[0] - site.origin[0]) * site.n[0] + (c[1] - site.origin[1]) * site.n[1];
    if (d > maxDepth[o]!) maxDepth[o] = d;
  }
  // Сколько стоящих сараев и бань на каждом участке.
  const shedCount = new Map<number, number>();
  for (const shed of input.sheds) {
    const c = orientedBox(openRing(shed.ring)).center;
    const i = grid.at(c[0], c[1]);
    const o = i >= 0 ? owner[i]! : -1;
    if (o >= 0) shedCount.set(o, (shedCount.get(o) ?? 0) + 1);
  }

  const plotOf = new Map<number, Plot>();
  for (const site of sites) {
    const own = plotChains.get(site.index);
    if (!own?.length) continue;
    const ring = assembleRing(own);
    if (!ring || Math.abs(signedArea(ring)) < 120) continue;
    const plot = layoutPlot(site, ring, grid, owner, taken, maxDepth[site.index]!, shedCount.get(site.index) ?? 0);
    // Ворота — точно на линии уличного забора (растр и упрощение сдвигают её на полметра).
    if (plot.gate) {
      let best: { point: Vec2; dir: Vec2; distance: number } | undefined;
      for (const chain of own) {
        if (chain.kind !== 'street') continue;
        const at = arcPosition(chain.points, plot.gate.at);
        if (!best || at.distance < best.distance)
          best = {
            point: pointAt(chain.points, at.s).point,
            dir: at.dir,
            distance: at.distance,
          };
      }
      if (best && best.distance < 2.5) {
        const along: Vec2 = dot(best.dir, plot.t) >= 0 ? best.dir : [-best.dir[0], -best.dir[1]];
        const inward: Vec2 = [-along[1], along[0]];
        plot.gate = {
          ...plot.gate,
          at: best.point,
          along,
          inward: dot(inward, plot.n) >= 0 ? inward : [-inward[0], -inward[1]],
        };
      } else {
        delete plot.gate;
        delete plot.driveway;
      }
    }
    plots.push(plot);
    plotOf.set(site.index, plot);
  }

  // Заборы: улица — в стиле участка, между соседями — горбыль, на задах — жерди.
  const runs: FenceRun[] = [];
  for (const chain of chains) {
    const plotsHere = chain.plots.map((p) => plotOf.get(p)).filter((p): p is Plot => !!p);
    if (!plotsHere.length) continue;
    const first = plotsHere[0]!;
    const seed = hashString(`fence:${plotsHere.map((p) => p.id).join('|')}:${Math.round(chain.points[0]![0])}:${Math.round(chain.points[0]![1])}`);
    let style: FenceStyle;
    let color: string;
    let height: number;
    if (chain.kind === 'street' && first.street) {
      ({ style, color, height } = first.fence);
    } else {
      style = chain.kind === 'side' ? 'slats' : 'rails';
      color = COLORS[style][seed % COLORS[style].length]!;
      height = HEIGHTS[style];
    }
    const kind: FenceKind = chain.kind === 'street' && !first.street ? 'back' : chain.kind;
    const cuts = buildingCuts(chain.points, grid);
    if (kind === 'street') cuts.push(...gateCuts(chain.points, first));
    runs.push({
      owners: plotsHere.map((p) => p.id),
      kind,
      line: chain.points,
      cuts: mergeCuts(cuts),
      style,
      color,
      height,
      seed,
    });
  }
  return { plots, runs };
}

// --- растр ---------------------------------------------------------------------------------------

class Grid {
  readonly flags: Uint8Array;
  constructor(
    readonly x0: number,
    readonly y0: number,
    readonly w: number,
    readonly h: number,
  ) {
    this.flags = new Uint8Array(w * h);
  }

  /** Номер клетки под точкой (или −1). */
  at(x: number, y: number): number {
    const i = Math.floor((x - this.x0) / CELL);
    const j = Math.floor((y - this.y0) / CELL);
    return i < 0 || j < 0 || i >= this.w || j >= this.h ? -1 : j * this.w + i;
  }

  center(index: number): Vec2 {
    return [this.x0 + ((index % this.w) + 0.5) * CELL, this.y0 + (Math.floor(index / this.w) + 0.5) * CELL];
  }

  /** Клетки, чьи центры в габарите точек: fn(клетка, центр). */
  box(points: readonly Vec2[], fn: (index: number, center: Vec2) => void): void {
    let ax = Infinity;
    let ay = Infinity;
    let bx = -Infinity;
    let by = -Infinity;
    for (const [x, y] of points) {
      ax = Math.min(ax, x);
      ay = Math.min(ay, y);
      bx = Math.max(bx, x);
      by = Math.max(by, y);
    }
    const i0 = Math.max(0, Math.floor((ax - this.x0) / CELL));
    const i1 = Math.min(this.w - 1, Math.ceil((bx - this.x0) / CELL));
    const j0 = Math.max(0, Math.floor((ay - this.y0) / CELL));
    const j1 = Math.min(this.h - 1, Math.ceil((by - this.y0) / CELL));
    const p: Vec2 = [0, 0];
    for (let j = j0; j <= j1; j++) {
      p[1] = this.y0 + (j + 0.5) * CELL;
      for (let i = i0; i <= i1; i++) {
        p[0] = this.x0 + (i + 0.5) * CELL;
        fn(j * this.w + i, p);
      }
    }
  }

  /** Клетки не дальше reach от отрезка: fn(клетка, расстояние). */
  nearSegment(a: Vec2, b: Vec2, reach: number, fn: (index: number, distance: number) => void): void {
    this.box([add(a, [-reach, -reach]), add(a, [reach, reach]), add(b, [-reach, -reach]), add(b, [reach, reach])], (i, p) => {
      const d = segmentDistance(p, a, b);
      if (d < reach) fn(i, d);
    });
  }

  /** Клетки внутри контура или не дальше grow от него. */
  polygon(ring: readonly Vec2[], grow: number, fn: (index: number) => void): void {
    if (ring.length < 3) return;
    const pad: Vec2[] = ring.flatMap((p) => [add(p, [-grow, -grow]), add(p, [grow, grow])]);
    this.box(pad, (i, p) => {
      if (insidePolygon(p, ring) || (grow > 0 && ringDistance(p, ring) <= grow)) fn(i);
    });
  }
}

interface Site {
  index: number;
  house: { id: string; ring: Vec2[] };
  seed: number;
  /** Точка уличного забора напротив дома, оси t (вдоль улицы) и n (вглубь). */
  origin: Vec2;
  t: Vec2;
  n: Vec2;
  /** Где середина дома вдоль улицы (от origin), полуширина дома вдоль улицы. */
  ac: number;
  hl: number;
  /** От уличного забора до фасада и до задней стены дома, м. */
  front: number;
  back: number;
  sideCap: number;
  depth: number;
  street: boolean;
}

function siteOf(house: { id: string; ring: Vec2[] }, index: number, segments: readonly { a: Vec2; b: Vec2; half: number; verge: number }[]): Site {
  const seed = hashString(`estate:${house.id}`);
  const pick = ([lo, hi]: [number, number], k: number) => lo + random01(seed + k) * (hi - lo);
  const box = orientedBox(house.ring);
  let best: { point: Vec2; distance: number; half: number; verge: number; dir: Vec2 } | undefined;
  for (const s of segments) {
    const point = closestOnSegment(box.center, s.a, s.b);
    const distance = Math.hypot(point[0] - box.center[0], point[1] - box.center[1]);
    if (!best || distance < best.distance) {
      const len = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]) || 1;
      best = {
        point,
        distance,
        half: s.half,
        verge: s.verge,
        dir: [(s.b[0] - s.a[0]) / len, (s.b[1] - s.a[1]) / len],
      };
    }
  }
  // Оси: n — от улицы к дому; без улицы — по короткой оси дома.
  let n: Vec2;
  let roadPoint: Vec2;
  if (best && best.distance > 0.5) {
    n = [(box.center[0] - best.point[0]) / best.distance, (box.center[1] - best.point[1]) / best.distance];
    // Строго поперёк улицы — участки соседей параллельны.
    const t0: Vec2 = best.dir;
    const across: Vec2 = [-t0[1], t0[0]];
    n = dot(across, n) >= 0 ? across : [-across[0], -across[1]];
    roadPoint = best.point;
  } else {
    n = box.halfU < box.halfV ? box.u : box.v;
    roadPoint = add(box.center, n, -30);
  }
  const t: Vec2 = [n[1], -n[0]];
  let front = Infinity;
  let back = -Infinity;
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of house.ring) {
    const d = dot(sub(p, roadPoint), n);
    const a = dot(sub(p, roadPoint), t);
    front = Math.min(front, d);
    back = Math.max(back, d);
    lo = Math.min(lo, a);
    hi = Math.max(hi, a);
  }
  const street = !!best && front - best.half < STREET_REACH;
  // Уличный забор — на краю обочины; дом ближе к дороге — его стена и есть забор.
  let line: number;
  if (street && best) {
    const usual = best.half + best.verge;
    line = front - usual < 1 ? Math.max(front, best.half + 0.3) : usual;
  } else {
    line = front - 4;
  }
  const origin = add(roadPoint, n, line);
  return {
    index,
    house,
    seed,
    origin,
    t,
    n,
    ac: (lo + hi) / 2,
    hl: (hi - lo) / 2,
    front: Math.max(0, front - line),
    back: back - line,
    sideCap: pick(SIDE, 1),
    depth: Math.max(back - line + 12, pick(DEPTH, 2)),
    street,
  };
}

/** Оставить каждому дому только связный с ним кусок (по 4 соседям). */
function keepConnected(grid: Grid, owner: Int32Array, sites: readonly Site[]): void {
  const keep = new Uint8Array(owner.length);
  const queue: number[] = [];
  for (const site of sites) {
    const [cx, cy] = orientedBox(site.house.ring).center;
    const start = grid.at(cx, cy);
    if (start < 0 || owner[start] !== site.index) continue;
    queue.length = 0;
    queue.push(start);
    keep[start] = 1;
    while (queue.length) {
      const i = queue.pop()!;
      const x = i % grid.w;
      for (const j of [i - 1, i + 1, i - grid.w, i + grid.w]) {
        if (j < 0 || j >= owner.length || keep[j] || owner[j] !== site.index) continue;
        if ((j === i - 1 && x === 0) || (j === i + 1 && x === grid.w - 1)) continue;
        keep[j] = 1;
        queue.push(j);
      }
    }
  }
  for (let i = 0; i < owner.length; i++) if (owner[i]! >= 0 && !keep[i]) owner[i] = -1;
}

// --- границы -------------------------------------------------------------------------------------

interface Chain {
  /** Участки по сторонам (один — если с другой стороны ничья земля). */
  plots: number[];
  kind: FenceKind;
  points: Vec2[];
}

/**
 * Границы между клетками разных хозяев — цепочки с одной и той же парой хозяев, упрощённые до прямых.
 * Ничья земля у дороги и в стороне — разные «хозяева»: там уличный забор, тут — задний.
 */
function traceBoundaries(grid: Grid, owner: Int32Array, count: number): Chain[] {
  const K = count + 2;
  const STREET = K - 1;
  const OPEN = K - 2;
  const VW = grid.w + 1;
  const edgeA: number[] = [];
  const edgeB: number[] = [];
  const edgeLabel: number[] = [];
  const incident = new Map<number, number[]>();
  const cellOwner = (i: number, j: number) => (i < 0 || j < 0 || i >= grid.w || j >= grid.h ? -1 : owner[j * grid.w + i]!);
  const noneKind = (i: number, j: number) => (i < 0 || j < 0 || i >= grid.w || j >= grid.h ? OPEN : grid.flags[j * grid.w + i]! & ROADSIDE ? STREET : OPEN);
  const addEdge = (a: number, b: number, p: number, pi: number, pj: number, q: number, qi: number, qj: number) => {
    if (p === q) return;
    let label: number;
    if (p >= 0 && q >= 0) label = Math.min(p, q) * K + Math.max(p, q);
    else if (p >= 0) label = p * K + noneKind(qi, qj);
    else if (q >= 0) label = q * K + noneKind(pi, pj);
    else return;
    const e = edgeA.length;
    edgeA.push(a);
    edgeB.push(b);
    edgeLabel.push(label);
    for (const v of [a, b]) {
      const list = incident.get(v);
      if (list) list.push(e);
      else incident.set(v, [e]);
    }
  };
  for (let j = -1; j <= grid.h; j++) {
    for (let i = -1; i <= grid.w; i++) {
      const p = cellOwner(i, j);
      // Правая граница клетки (i, j): между ней и (i+1, j) — вертикальный отрезок.
      if (j >= 0 && j < grid.h && i < grid.w) {
        const q = cellOwner(i + 1, j);
        if (p !== q) addEdge(j * VW + (i + 1), (j + 1) * VW + (i + 1), p, i, j, q, i + 1, j);
      }
      // Верхняя граница: между (i, j) и (i, j+1) — горизонтальный.
      if (i >= 0 && i < grid.w && j < grid.h) {
        const q = cellOwner(i, j + 1);
        if (p !== q) addEdge((j + 1) * VW + i, (j + 1) * VW + (i + 1), p, i, j, q, i, j + 1);
      }
    }
  }

  const used = new Uint8Array(edgeA.length);
  const isNode = (v: number) => {
    const list = incident.get(v)!;
    return list.length !== 2 || edgeLabel[list[0]!] !== edgeLabel[list[1]!];
  };
  const point = (v: number): Vec2 => [grid.x0 + (v % VW) * CELL, grid.y0 + Math.floor(v / VW) * CELL];
  const chains: Chain[] = [];
  const walk = (start: number, from: number) => {
    const label = edgeLabel[start]!;
    const verts = [from];
    let e = start;
    let v = from;
    for (;;) {
      used[e] = 1;
      v = edgeA[e] === v ? edgeB[e]! : edgeA[e]!;
      verts.push(v);
      if (v === from || isNode(v)) break;
      const list = incident.get(v)!;
      const next = list[0] === e ? list[1]! : list[0]!;
      if (used[next]) break;
      e = next;
    }
    const lo = Math.floor(label / K);
    const hi = label % K;
    const plots = hi === STREET || hi === OPEN ? [lo] : [lo, hi];
    const kind: FenceKind = hi === STREET ? 'street' : hi === OPEN ? 'back' : 'side';
    chains.push({ plots, kind, points: simplify(verts.map(point), SIMPLIFY) });
  };
  for (const [v, list] of incident) {
    if (!isNode(v)) continue;
    for (const e of list) if (!used[e]) walk(e, v);
  }
  // Замкнутые границы без узлов (участок со всех сторон в ничьей земле).
  for (let e = 0; e < edgeA.length; e++) if (!used[e]) walk(e, edgeA[e]!);
  return chains;
}

/** Ломаная без лишних точек (Дуглас — Пекер); замкнутую делим на две половины. */
export function simplify(points: readonly Vec2[], tolerance: number): Vec2[] {
  if (points.length < 3) return [...points];
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (first[0] === last[0] && first[1] === last[1]) {
    let far = 1;
    let best = -1;
    points.forEach((p, i) => {
      const d = Math.hypot(p[0] - first[0], p[1] - first[1]);
      if (d > best) {
        best = d;
        far = i;
      }
    });
    const a = simplify(points.slice(0, far + 1), tolerance);
    const b = simplify(points.slice(far), tolerance);
    return [...a, ...b.slice(1)];
  }
  let index = -1;
  let max = tolerance;
  for (let i = 1; i < points.length - 1; i++) {
    const d = segmentDistance(points[i]!, first, last);
    if (d > max) {
      max = d;
      index = i;
    }
  }
  if (index < 0) return [first, last];
  const left = simplify(points.slice(0, index + 1), tolerance);
  const right = simplify(points.slice(index), tolerance);
  return [...left, ...right.slice(1)];
}

/** Контур участка из его цепочек (концы цепочек — общие узлы растра). */
function assembleRing(chains: readonly Chain[]): Vec2[] | undefined {
  const key = (p: Vec2) => `${p[0]},${p[1]}`;
  const ends = new Map<string, number[]>();
  chains.forEach((c, i) => {
    for (const p of [c.points[0]!, c.points[c.points.length - 1]!]) {
      const list = ends.get(key(p)) ?? [];
      list.push(i);
      ends.set(key(p), list);
    }
  });
  const used = new Set<number>();
  let best: Vec2[] | undefined;
  for (let s = 0; s < chains.length; s++) {
    if (used.has(s)) continue;
    const ring: Vec2[] = [...chains[s]!.points];
    used.add(s);
    for (let guard = 0; guard < chains.length; guard++) {
      const tail = ring[ring.length - 1]!;
      if (ring.length > 2 && key(tail) === key(ring[0]!)) break;
      const next = (ends.get(key(tail)) ?? []).find((i) => !used.has(i));
      if (next === undefined) break;
      used.add(next);
      const pts = chains[next]!.points;
      const forward = key(pts[0]!) === key(tail);
      ring.push(...(forward ? pts.slice(1) : [...pts].reverse().slice(1)));
    }
    const open = openRing(ring);
    if (open.length >= 3 && (!best || Math.abs(signedArea(open)) > Math.abs(signedArea(best)))) best = open;
  }
  if (!best) return undefined;
  return signedArea(best) >= 0 ? best : [...best].reverse();
}

/** Где забор упирается в постройку (её стена и есть забор): вырезы по дуге. */
function buildingCuts(line: readonly Vec2[], grid: Grid): [number, number][] {
  const cuts: [number, number][] = [];
  let s0 = 0;
  for (let k = 1; k < line.length; k++) {
    const a = line[k - 1]!;
    const b = line[k]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-6) continue;
    const u: Vec2 = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    const side: Vec2 = [-u[1] * 0.45, u[0] * 0.45];
    for (let s = 0.2; s < len; s += 0.4) {
      const p = add(a, u, s);
      const hit = [p, add(p, side), add(p, side, -1)].some((q) => {
        const i = grid.at(q[0], q[1]);
        return i >= 0 && (grid.flags[i]! & BUILDING) !== 0;
      });
      if (hit) cuts.push([s0 + s - 0.3, s0 + s + 0.3]);
    }
    s0 += len;
  }
  return cuts;
}

/** Вырезы уличного забора участка: ворота с калиткой и палисадник (у него свой штакетник). */
function gateCuts(line: readonly Vec2[], plot: Plot): [number, number][] {
  const cuts: [number, number][] = [];
  if (plot.gate) {
    const s = arcPosition(line, plot.gate.at);
    if (s.distance < 0.05) {
      const half = (plot.gate.gate + plot.gate.wicket + 0.2) / 2;
      cuts.push([s.s - half, s.s + half]);
    }
  }
  if (plot.palisade) {
    const { origin, toStreet, width, depth } = plot.palisade;
    const front = add(origin, toStreet, depth);
    const along: Vec2 = [-toStreet[1], toStreet[0]];
    const a = arcPosition(line, add(front, along, width / 2 + 0.05));
    const b = arcPosition(line, add(front, along, -width / 2 - 0.05));
    if (a.distance < 1.2 && b.distance < 1.2) cuts.push([Math.min(a.s, b.s), Math.max(a.s, b.s)]);
  }
  return cuts;
}

function mergeCuts(cuts: [number, number][]): [number, number][] {
  const sorted = [...cuts].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 0.6) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** Ближайшая к точке позиция на ломаной: дуга от начала и расстояние. */
export function arcPosition(line: readonly Vec2[], p: Vec2): { s: number; distance: number; dir: Vec2 } {
  let best = { s: 0, distance: Infinity, dir: [1, 0] as Vec2 };
  let s0 = 0;
  for (let k = 1; k < line.length; k++) {
    const a = line[k - 1]!;
    const b = line[k]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-6) continue;
    const u: Vec2 = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    const s = Math.min(Math.max(dot(sub(p, a), u), 0), len);
    const q = add(a, u, s);
    const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
    if (d < best.distance) best = { s: s0 + s, distance: d, dir: u };
    s0 += len;
  }
  return best;
}

/** Точка и направление на ломаной в дуге s от начала. */
export function pointAt(line: readonly Vec2[], s: number): { point: Vec2; dir: Vec2 } {
  let rest = s;
  for (let k = 1; k < line.length; k++) {
    const a = line[k - 1]!;
    const b = line[k]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-6) continue;
    const u: Vec2 = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    if (rest <= len || k === line.length - 1) return { point: add(a, u, Math.min(Math.max(rest, 0), len)), dir: u };
    rest -= len;
  }
  return { point: line[0] ?? [0, 0], dir: [1, 0] };
}

// --- двор ----------------------------------------------------------------------------------------

/**
 * Двор участка: ворота, палисадник, постройки, мелочь, сад и огород. existing — сколько сараев и бань
 * на участке уже стоит (в OSM и по съёмке): столько построек не придумываем.
 */
function layoutPlot(site: Site, ring: Vec2[], grid: Grid, owner: Int32Array, taken: Uint8Array, maxD: number, existing: number): Plot {
  const { origin, t, n, seed } = site;
  const dice = new Rand(seed);
  const toWorld = (a: number, d: number): Vec2 => [origin[0] + t[0] * a + n[0] * d, origin[1] + t[1] * a + n[1] * d];
  const mine = (p: Vec2) => {
    const i = grid.at(p[0], p[1]);
    return i >= 0 && owner[i] === site.index;
  };
  const free = (p: Vec2) => {
    const i = grid.at(p[0], p[1]);
    return i >= 0 && owner[i] === site.index && !taken[i] && !(grid.flags[i]! & BLOCK);
  };
  // Ширина участка по сторонам от дома (по клеткам).
  const edgeAt = (d: number, side: -1 | 1) => {
    let a = site.ac + side * site.hl;
    while (Math.abs(a - site.ac) < 60 && mine(toWorld(a + side * 0.5, d))) a += side * 0.5;
    return a;
  };
  /** Прямоугольник along × across (по t и n) с центром (a, d) — свободен ли (с запасом margin). */
  const fits = (a: number, d: number, wt: number, wn: number, margin = 0.6) => {
    for (let x = -wt / 2 - margin; x <= wt / 2 + margin + 1e-6; x += 0.5) {
      for (let y = -wn / 2 - margin; y <= wn / 2 + margin + 1e-6; y += 0.5) {
        if (!free(toWorld(a + x, d + y))) return false;
      }
    }
    return true;
  };
  const take = (a: number, d: number, wt: number, wn: number, margin = 0.7) => {
    for (let x = -wt / 2 - margin; x <= wt / 2 + margin + 1e-6; x += 0.5) {
      for (let y = -wn / 2 - margin; y <= wn / 2 + margin + 1e-6; y += 0.5) {
        const p = toWorld(a + x, d + y);
        const i = grid.at(p[0], p[1]);
        if (i >= 0) taken[i] = 1;
      }
    }
  };

  const plot: Plot = {
    id: site.house.id,
    seed,
    ring,
    area: Math.abs(signedArea(ring)),
    origin,
    t,
    n,
    street: site.street,
    outbuildings: [],
    props: [],
    trees: [],
    fence: streetFence(dice),
  };
  const houseFront = site.front;
  const houseBack = site.back;
  const court = houseBack + dice.range(10, 15);

  // Ворота — с той стороны дома, где шире; калитка — ближе к дому.
  const left = Math.abs(edgeAt(houseFront + 1, -1) - (site.ac - site.hl));
  const right = Math.abs(edgeAt(houseFront + 1, 1) - (site.ac + site.hl));
  const g: -1 | 1 = right > left + 0.5 ? 1 : left > right + 0.5 ? -1 : dice.chance(0.5) ? 1 : -1;
  const room = Math.max(left, right);
  const wicket = 1.0;
  const gateWidth = room >= 4.8 ? dice.range(3, 3.6) : 0;
  const total = gateWidth + wicket + (gateWidth ? 0.2 : 0);
  if (room >= total + 0.9) {
    const aGate = site.ac + g * (site.hl + 0.6 + total / 2);
    const at = toWorld(aGate, 0);
    plot.gate = {
      at,
      along: t,
      inward: n,
      gate: gateWidth,
      wicket,
      // Калитка — со стороны дома.
      wicketSide: (g === 1 ? -1 : 1) as -1 | 1,
      canopy: dice.chance(0.3),
      style: plot.fence.style === 'picket' ? 'boards' : plot.fence.style,
      color: plot.fence.color,
    };
    if (gateWidth) {
      const aDrive = aGate - ((g === 1 ? -1 : 1) * (wicket + 0.2)) / 2;
      const len = Math.max(houseBack + 3, 6);
      plot.driveway = [
        toWorld(aDrive - gateWidth / 2, 0),
        toWorld(aDrive + gateWidth / 2, 0),
        toWorld(aDrive + gateWidth / 2, len),
        toWorld(aDrive - gateWidth / 2, len),
      ];
      take(aDrive, len / 2, gateWidth, len, 0.3);
    }
  }

  // Палисадник: дом стоит в метре-шести от забора и фасадом к улице.
  const box = orientedBox(site.house.ring);
  const axes: { f: Vec2; halfF: number; halfL: number }[] = [
    { f: box.u, halfF: box.halfU, halfL: box.halfV },
    { f: [-box.u[0], -box.u[1]], halfF: box.halfU, halfL: box.halfV },
    { f: box.v, halfF: box.halfV, halfL: box.halfU },
    { f: [-box.v[0], -box.v[1]], halfF: box.halfV, halfL: box.halfU },
  ];
  const toStreet: Vec2 = [-n[0], -n[1]];
  const facing = axes.reduce((a, b) => (dot(b.f, toStreet) > dot(a.f, toStreet) ? b : a));
  const frontMid = add(box.center, facing.f, facing.halfF);
  const cos = dot(facing.f, toStreet);
  const gap = dot(sub(frontMid, origin), n) / Math.max(cos, 1e-3);
  if (site.street && cos > 0.985 && gap >= 1.2 && gap <= 6.5) {
    plot.palisade = {
      origin: frontMid,
      toStreet: facing.f,
      width: 2 * facing.halfL,
      depth: gap,
    };
  }

  // Постройки двора. Уже стоящие на участке сараи и бани — вместо придуманных.
  const wanted: OutbuildingModel[] = [];
  if (existing < 1) wanted.push('shed');
  if (existing < 2) wanted.push('banya');
  wanted.push('outhouse');
  if (maxD - court > 14 && dice.chance(0.55)) wanted.push('greenhouse');
  if (dice.chance(0.25)) wanted.push('well');

  const place = (model: OutbuildingModel): boolean => {
    const k = plot.outbuildings.length;
    const s = hashString(`${plot.id}:${model}`);
    for (const c of candidates(model)) {
      if (!fits(c.a, c.d, c.wt, c.wn)) continue;
      take(c.a, c.d, c.wt, c.wn);
      const center = toWorld(c.a, c.d);
      plot.outbuildings.push({
        id: `estate:${plot.id}:${k}`,
        model,
        rect: facingRect(center, c.face, c.width, c.depth),
        seed: 1 + (s % 4),
      });
      return true;
    }
    return false;
  };
  /** Кандидаты (a, d): места по порядку предпочтения; wt, wn — габарит по t и n, face — куда дверь. */
  const candidates = (model: OutbuildingModel) => {
    const list: {
      a: number;
      d: number;
      wt: number;
      wn: number;
      face: Vec2;
      width: number;
      depth: number;
    }[] = [];
    const along = (side: -1 | 1, dFrom: number, dTo: number, width: number, depth: number) => {
      // Длинной стороной вдоль бокового забора, дверью — во двор.
      for (let d = dFrom; d <= dTo; d += 1) {
        const a = edgeAt(d, side) - side * (width / 2 + 0.9);
        list.push({
          a,
          d,
          wt: width,
          wn: depth,
          face: side === 1 ? [-t[0], -t[1]] : t,
          width: depth,
          depth: width,
        });
      }
    };
    const across = (dFrom: number, dTo: number, width: number, depth: number) => {
      // Поперёк участка, дверью к дому.
      for (let d = dFrom; d <= dTo; d += 1) {
        for (const off of [0, 3, -3, 6, -6, 9, -9])
          list.push({
            a: site.ac + off,
            d,
            wt: width,
            wn: depth,
            face: [-n[0], -n[1]],
            width,
            depth,
          });
      }
    };
    if (model === 'shed') {
      const w = dice.range(3.2, 4.2);
      const l = dice.range(5, 7);
      along(g, houseBack + 2, houseBack + 10, w, l);
      across(houseBack + 4, houseBack + 14, l, w);
      along(-g as -1 | 1, houseBack + 2, houseBack + 10, w, l);
    } else if (model === 'banya') {
      const w = dice.range(3.4, 4);
      const l = dice.range(4.2, 5.2);
      along(-g as -1 | 1, houseBack + 9, houseBack + 24, w, l);
      across(houseBack + 10, houseBack + 26, l, w);
      along(g, houseBack + 12, houseBack + 26, w, l);
    } else if (model === 'outhouse') {
      along(g, court - 3, court + 6, 1.2, 1.3);
      along(-g as -1 | 1, court - 3, court + 6, 1.2, 1.3);
      across(houseBack + 6, court + 8, 1.2, 1.3);
    } else if (model === 'greenhouse') {
      const l = dice.range(4, 6);
      for (let d = court + 2; d <= court + 10; d += 1)
        for (const off of [0, -3, 3, -6, 6])
          list.push({
            a: site.ac + off,
            d,
            wt: 3,
            wn: l,
            face: [-n[0], -n[1]],
            width: 3,
            depth: l,
          });
    } else {
      // Колодец — во дворе за домом или сбоку.
      for (const d of [houseBack + 2.5, houseBack + 4, houseFront + 2])
        for (const off of [-g * (site.hl + 2), 0, g * 2, -g * 4])
          list.push({
            a: site.ac + off,
            d,
            wt: 1.7,
            wn: 1.7,
            face: [-n[0], -n[1]],
            width: 1.7,
            depth: 1.7,
          });
    }
    return list;
  };
  for (const model of wanted) place(model);

  // Мелочь двора.
  const prop = (kind: PropKind, a: number, d: number, angle: number, length: number) =>
    plot.props.push({
      kind,
      at: toWorld(a, d),
      angle,
      length,
      seed: hashString(`${plot.id}:${kind}:${plot.props.length}`),
    });
  /** Поворот детали, чей «перед» (дверь, торцы поленьев) смотрит в сторону f. */
  const faceTo = (f: Vec2) => Math.atan2(f[0], -f[1]);
  // Поленница: вдоль бокового забора во дворе.
  {
    const len = dice.range(2.2, 4);
    for (const side of [g, -g as -1 | 1]) {
      let done = false;
      for (let d = houseBack + 1; d <= court && !done; d += 1) {
        const a = edgeAt(d, side) - side * 0.95;
        if (fits(a, d + len / 2, 0.7, len, 0.2)) {
          take(a, d + len / 2, 0.7, len, 0.3);
          prop('woodpile', a, d + len / 2, faceTo([-side * t[0], -side * t[1]]), len);
          done = true;
        }
      }
      if (done) break;
    }
  }
  // Будка у ворот.
  if (plot.gate && dice.chance(0.4)) {
    const aGate = dot(sub(plot.gate.at, origin), t);
    for (const [da, dd] of [
      [g * 2.5, 2.5],
      [g * 3, 4],
      [-g * 0.5, 4.5],
    ] as [number, number][]) {
      if (fits(aGate + da, dd, 1, 1.2, 0.3)) {
        take(aGate + da, dd, 1, 1.2);
        prop('doghouse', aGate + da, dd, faceTo([-g * t[0], -g * t[1]]), 1);
        break;
      }
    }
  }
  // Лавочка за воротами, на обочине.
  if (plot.gate && site.street && dice.chance(0.45)) {
    const aGate = dot(sub(plot.gate.at, origin), t);
    const a = aGate + plot.gate.wicketSide * (total / 2 + 1.1);
    const p = toWorld(a, -0.6);
    const i = grid.at(p[0], p[1]);
    if (i >= 0 && !(grid.flags[i]! & (BLOCK | BUILDING)) && owner[i] !== site.index) prop('bench', a, -0.6, faceTo([-n[0], -n[1]]), 1.6);
  }
  // Сад между двором и огородом, ульи и стог — где есть место.
  const orchard = maxD - court > 22 ? dice.range(6, 11) : 0;
  const gardenFrom = court + orchard;
  if (orchard) {
    const count = 2 + dice.int(5);
    for (let k = 0, tries = 0; k < count && tries < 40; tries++) {
      const a = site.ac + dice.range(-site.hl - 6, site.hl + 6);
      const d = court + dice.range(1.5, orchard - 1);
      const p = toWorld(a, d);
      if (!fits(a, d, 0.6, 0.6, 0.9) || plot.trees.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 3.6)) continue;
      plot.trees.push(p);
      take(a, d, 0.6, 0.6, 0.6);
      k++;
    }
    if (dice.chance(0.2)) {
      const hives = 3 + dice.int(4);
      for (let d = court + 1.5; d < gardenFrom - 1; d += 1) {
        const a0 = site.ac + g * (site.hl + 1);
        if (!fits(a0 + (g * (hives - 1) * 1.4) / 2, d, hives * 1.4, 0.8, 0.2)) continue;
        for (let h = 0; h < hives; h++) prop('beehive', a0 + g * h * 1.4, d, faceTo([-n[0], -n[1]]), 0.5);
        take(a0 + (g * (hives - 1) * 1.4) / 2, d, hives * 1.4, 0.8);
        break;
      }
    }
  } else if (dice.chance(0.7)) {
    // Без сада — пара яблонь во дворе.
    for (let tries = 0, k = 0; tries < 20 && k < 2; tries++) {
      const a = site.ac + dice.range(-site.hl - 4, site.hl + 4);
      const d = dice.range(houseBack + 2, court);
      const p = toWorld(a, d);
      if (!fits(a, d, 0.6, 0.6, 0.9)) continue;
      plot.trees.push(p);
      take(a, d, 0.6, 0.6, 0.6);
      k++;
    }
  }
  if (maxD - gardenFrom > 18 && dice.chance(0.18)) {
    for (let d = maxD - 5; d > gardenFrom + 6; d -= 1) {
      const a = site.ac + dice.range(-3, 3);
      if (fits(a, d, 3.4, 3.4, 0.3)) {
        prop('haystack', a, d, dice.range(0, Math.PI), 1);
        take(a, d, 3.4, 3.4);
        break;
      }
    }
  }
  if (dice.chance(0.3)) {
    const side = -g as -1 | 1;
    for (let d = gardenFrom - 1; d > houseBack + 4; d -= 1) {
      const a = edgeAt(d, side) - side * 1.2;
      if (fits(a, d, 1.6, 1.1, 0.2)) {
        prop('compost', a, d, faceTo([-side * t[0], -side * t[1]]), 1.6);
        take(a, d, 1.6, 1.1);
        break;
      }
    }
  }
  // Берёза или рябина у забора с улицы.
  if (site.street && dice.chance(0.35)) {
    const a = site.ac + dice.range(-site.hl, site.hl);
    const p = toWorld(a, -1.3);
    const i = grid.at(p[0], p[1]);
    if (i >= 0 && !(grid.flags[i]! & (BLOCK | BUILDING)) && owner[i] === -1) plot.trees.push(p);
  }

  // Огород: всё за садом до задов участка.
  if (maxD - gardenFrom >= 9) {
    const garden = clipBehind(ring, origin, n, gardenFrom);
    if (garden.length >= 3 && Math.abs(signedArea(garden)) > 40) plot.garden = { ring: garden, rows: n };
  }
  return plot;
}

/** Уличный забор участка: стиль, цвет, высота. */
function streetFence(dice: Rand): Plot['fence'] {
  let r = dice.next();
  let style: FenceStyle = 'boards';
  for (const [s, w] of STREET_STYLES) {
    r -= w;
    if (r <= 0) {
      style = s;
      break;
    }
  }
  return {
    style,
    color: dice.pick(COLORS[style]),
    height: HEIGHTS[style] + dice.range(-0.1, 0.1),
  };
}

/** Прямоугольник модели: центр, куда дверь (face), ширина фасада и глубина; против часовой, первая сторона — фасад. */
export function facingRect(center: Vec2, face: Vec2, width: number, depth: number): Vec2[] {
  const along: Vec2 = [-face[1], face[0]];
  const front = add(center, face, depth / 2);
  const rear = add(center, face, -depth / 2);
  return [add(front, along, -width / 2), add(front, along, width / 2), add(rear, along, width / 2), add(rear, along, -width / 2)];
}

/** Часть многоугольника за линией (точки p с (p − origin)·n ≥ from). */
function clipBehind(ring: readonly Vec2[], origin: Vec2, n: Vec2, from: number): Vec2[] {
  const depth = (p: Vec2) => dot(sub(p, origin), n) - from;
  const out: Vec2[] = [];
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % ring.length]!;
    const dp = depth(p);
    const dq = depth(q);
    if (dp >= 0) out.push(p);
    if (dp >= 0 !== dq >= 0) {
      const k = dp / (dp - dq);
      out.push([p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k]);
    }
  }
  return out;
}

// --- мелкая геометрия ----------------------------------------------------------------------------

class Rand {
  private k = 0;
  constructor(private readonly seed: number) {}
  next(): number {
    return random01(this.seed * 7 + 13 * this.k++);
  }
  range(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo);
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(list: readonly T[]): T {
    return list[Math.floor(this.next() * list.length) % list.length]!;
  }
}

function closestOnSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const ab = sub(b, a);
  const length2 = dot(ab, ab);
  const t = length2 > 0 ? Math.min(Math.max(dot(sub(p, a), ab) / length2, 0), 1) : 0;
  return [a[0] + ab[0] * t, a[1] + ab[1] * t];
}

function segmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const q = closestOnSegment(p, a, b);
  return Math.hypot(p[0] - q[0], p[1] - q[1]);
}

function ringDistance(p: Vec2, ring: readonly Vec2[]): number {
  let min = Infinity;
  for (let i = 0; i < ring.length; i++) min = Math.min(min, segmentDistance(p, ring[i]!, ring[(i + 1) % ring.length]!));
  return min;
}

function insidePolygon([x, y]: Vec2, ring: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
