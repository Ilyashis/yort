/**
 * Подробный рельеф поверх общего (Copernicus, ~30 м): своя съёмка с дрона, шаг ~1 м, только там, где снято.
 * Внутри — высоты съёмки, к краям снятого и к «дыркам» (лес, где видны кроны, а не земля) — плавный переход
 * к общему рельефу на ширине fade метров, без ступенек. Чистые функции и классы, без движка.
 */

import type { HeightGridData, TerrainFile } from './heightGrid';

const M_PER_DEG_LAT = 111_320;

/** Файл подробного рельефа: как terrain.json, плюс «нет данных» и ширина перехода. */
export interface DetailTerrainFile extends TerrainFile {
  /** Значение Int16, означающее «здесь съёмки нет». */
  nodata: number;
  /** Ширина перехода к общему рельефу у краёв снятого, м. */
  fade: number;
}

export interface DetailGridData extends HeightGridData {
  /** NaN — нет данных. */
  values: Float32Array;
  fade: number;
}

/** Общий рельеф: высота в точке (долгота, широта). */
export type BaseHeights = (lon: number, lat: number) => number;

/** Улица, под которой рельеф выравнивается: ось (долгота, широта) и ширина проезжей части, м. */
export interface RoadAxis {
  coords: readonly (readonly [number, number])[];
  width: number;
}

/** Ещё столько метров за краем проезжей части — ровно, как полотно, м. */
const ROAD_FLAT_MARGIN = 1;
/** Дальше — плавный переход к рельефу съёмки, м. */
const ROAD_SHOULDER = 4;
/** Продольный профиль дороги сглаживается гауссом с такой сигмой, м. */
const ROAD_PROFILE_SIGMA = 6;
/** Шаг профиля вдоль оси дороги, м. */
const ROAD_PROFILE_STEP = 1;
/** За границей двора — переход от плоскости двора к съёмке, м. */
const YARD_SHOULDER = 3;
/** Ровная площадка под домом — на столько шире контура, м; дальше — переход на PAD_SHOULDER м. */
const PAD_MARGIN = 1;
const PAD_SHOULDER = 3;
/** Участки посёлка: на столько метров размывается переход между плоскостями соседей. */
const PLOT_BLEND = 3;

type XY = [number, number];

/** Скользящее среднее по окну 2·radius + 1 вдоль строк (along) или столбцов, на месте. */
function boxBlur(field: Float32Array, w: number, h: number, radius: number, along: boolean): void {
  const n = along ? w : h;
  const lines = along ? h : w;
  const line = new Float32Array(n);
  for (let l = 0; l < lines; l++) {
    const at = (k: number) => (along ? l * w + k : k * w + l);
    for (let k = 0; k < n; k++) line[k] = field[at(k)]!;
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += k >= 0 && k < n ? line[k]! : 0;
    for (let k = 0; k < n; k++) {
      field[at(k)] = sum / (2 * radius + 1);
      const out = k - radius;
      const into = k + radius + 1;
      if (out >= 0) sum -= line[out]!;
      if (into < n) sum += line[into]!;
    }
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const m = sorted.length >> 1;
  return sorted.length % 2 ? sorted[m]! : (sorted[m - 1]! + sorted[m]!) / 2;
}

/** Расстояние от точки до контура (замкнутого, без повтора первой точки): внутри — со знаком минус. */
function signedDistance(px: number, py: number, ring: readonly XY[]): number {
  let d = Infinity;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j]!;
    const [bx, by] = ring[i]!;
    if (by > py !== ay > py && px < ((ax - bx) * (py - by)) / (ay - by) + bx) inside = !inside;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    d = Math.min(d, Math.hypot(px - ax - dx * t, py - ay - dy * t));
  }
  return inside ? -d : d;
}

/**
 * Плоскость z = a + b·x + c·y по точкам (МНК с отбрасыванием выбросов: кусты, забор, шум съёмки).
 * Меньше 6 точек или вырожденный набор — горизонтальная плоскость по медиане; нет точек — undefined.
 */
function fitPlane(xs: number[], ys: number[], zs: number[]): ((x: number, y: number) => number) | undefined {
  const n = zs.length;
  if (!n) return undefined;
  const flat = median(zs);
  if (n < 6) return () => flat;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let keep = new Array<boolean>(n).fill(true);
  let a = flat;
  let b = 0;
  let c = 0;
  for (let iter = 0; iter < 4; iter++) {
    let sn = 0, sx = 0, sy = 0, sz = 0, sxx = 0, sxy = 0, syy = 0, sxz = 0, syz = 0;
    for (let k = 0; k < n; k++) {
      if (!keep[k]) continue;
      const x = xs[k]! - mx;
      const y = ys[k]! - my;
      const z = zs[k]!;
      sn++;
      sx += x;
      sy += y;
      sz += z;
      sxx += x * x;
      sxy += x * y;
      syy += y * y;
      sxz += x * z;
      syz += y * z;
    }
    // Нормальные уравнения 3×3 — по Крамеру.
    const det = sn * (sxx * syy - sxy * sxy) - sx * (sx * syy - sxy * sy) + sy * (sx * sxy - sxx * sy);
    if (sn < 6 || Math.abs(det) < 1e-9) return () => flat;
    a = (sz * (sxx * syy - sxy * sxy) - sx * (sxz * syy - sxy * syz) + sy * (sxz * sxy - sxx * syz)) / det;
    b = (sn * (sxz * syy - syz * sxy) - sz * (sx * syy - sxy * sy) + sy * (sx * syz - sxz * sy)) / det;
    c = (sn * (sxx * syz - sxy * sxz) - sx * (sx * syz - sxz * sy) + sz * (sx * sxy - sxx * sy)) / det;
    const res = zs.map((z, k) => z - (a + b * (xs[k]! - mx) + c * (ys[k]! - my)));
    const kept = res.filter((_, k) => keep[k]);
    const sd = Math.sqrt(kept.reduce((s, r) => s + r * r, 0) / kept.length);
    keep = res.map((r) => Math.abs(r) <= Math.max(0.25, 2.5 * sd));
  }
  return (x, y) => a + b * (x - mx) + c * (y - my);
}

export class DetailHeights {
  readonly bbox: HeightGridData['bbox'];
  /** Где подробный рельеф или поправки хоть что-то меняют: долгота/широта. */
  get coverage(): HeightGridData['bbox'] | undefined {
    if (this.coverageDirty) {
      this.coverageBox = this.coveredBox();
      this.coverageDirty = false;
    }
    return this.coverageBox;
  }
  private coverageBox: HeightGridData['bbox'] | undefined;
  private coverageDirty = true;
  /** Поправки к итоговой высоте в узлах (выравнивание дворов, домов, дорог), м; нет — поправок нет. */
  private delta: Float32Array | undefined;
  private readonly width: number;
  private readonly height: number;
  private readonly values: Float32Array;
  /** Вес подробного рельефа в узлах: 0 — общий рельеф, 1 — только съёмка. */
  private readonly weights: Float32Array;
  /** Метров в градусе долготы и шаг сетки по x и y, м. */
  private readonly mPerDegLon: number;
  private readonly cellX: number;
  private readonly cellY: number;

  constructor(
    data: DetailGridData,
    private readonly base: BaseHeights,
  ) {
    this.bbox = data.bbox;
    this.width = data.width;
    this.height = data.height;
    this.values = data.values;
    const lat = (data.bbox.south + data.bbox.north) / 2;
    this.mPerDegLon = M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
    this.cellX = ((data.bbox.east - data.bbox.west) / (data.width - 1)) * this.mPerDegLon;
    this.cellY = ((data.bbox.north - data.bbox.south) / (data.height - 1)) * M_PER_DEG_LAT;
    this.weights = fadeWeights(data.values, data.width, data.height, this.cellX, this.cellY, data.fade);
  }

  /**
   * Под улицами — ровное полотно: поперёк дороги одна высота (медиана съёмки по ширине), вдоль — плавный
   * профиль, к обочине — плавный переход к съёмке. Иначе неровности съёмки в пару десятков сантиметров
   * (кюветы, машины, шум) делают узкую дорогу волнистой.
   */
  flattenRoads(roads: readonly RoadAxis[]): void {
    // Для каждого узла у дорог — ближайшая дорога: насколько узел за краем полотна (м) и высота полотна.
    const best = new Map<number, { out: number; h: number }>();
    for (const road of roads) {
      const axis = road.coords.map(this.toGrid);
      const profile = this.roadProfile(axis, road.width);
      if (!profile) continue;
      const flat = road.width / 2 + ROAD_FLAT_MARGIN;
      const reach = flat + ROAD_SHOULDER;
      for (let k = 0; k + 1 < axis.length; k++) {
        const [ax, ay] = axis[k]!;
        const [bx, by] = axis[k + 1]!;
        const len = Math.hypot(bx - ax, by - ay);
        if (len < 1e-6) continue;
        const ux = (bx - ax) / len;
        const uy = (by - ay) / len;
        const c0 = Math.max(0, Math.floor((Math.min(ax, bx) - reach) / this.cellX));
        const c1 = Math.min(this.width - 1, Math.ceil((Math.max(ax, bx) + reach) / this.cellX));
        const r0 = Math.max(0, Math.floor((Math.min(ay, by) - reach) / this.cellY));
        const r1 = Math.min(this.height - 1, Math.ceil((Math.max(ay, by) + reach) / this.cellY));
        for (let r = r0; r <= r1; r++) {
          const py = r * this.cellY;
          for (let c = c0; c <= c1; c++) {
            const i = r * this.width + c;
            const px = c * this.cellX;
            const t = Math.min(len, Math.max(0, (px - ax) * ux + (py - ay) * uy));
            const out = Math.hypot(px - ax - ux * t, py - ay - uy * t) - flat;
            if (out >= ROAD_SHOULDER) continue;
            const prev = best.get(i);
            if (!prev || out < prev.out) best.set(i, { out, h: profile.at(profile.starts[k]! + t) });
          }
        }
      }
    }
    this.blend(best, ROAD_SHOULDER);
  }

  /**
   * Дворы — плоскостью: внутри участка земля ложится на плоскость, подобранную по съёмке (уклон двора
   * остаётся, бугры и ямки съёмки — нет), за границей участка — плавный переход к съёмке.
   */
  flattenYards(yards: readonly (readonly (readonly [number, number])[])[]): void {
    const best = new Map<number, { out: number; h: number }>();
    for (const yard of yards) {
      const ring = yard.map(this.toGrid);
      const xs: number[] = [];
      const ys: number[] = [];
      const zs: number[] = [];
      this.visit(ring, 0, (i, px, py, d) => {
        if (d > 0) return;
        xs.push(px);
        ys.push(py);
        zs.push(this.nodeHeight(i));
      });
      const plane = fitPlane(xs, ys, zs);
      if (!plane) continue;
      this.visit(ring, YARD_SHOULDER, (i, px, py, out) => {
        const prev = best.get(i);
        if (!prev || out < prev.out) best.set(i, { out, h: plane(px, py) });
      });
    }
    this.blend(best, YARD_SHOULDER);
  }

  /**
   * Участки посёлка вплотную друг к другу: каждый — плоскостью по своему уклону (бугры съёмки — кусты,
   * кучи, машины — уходят). Сами плоскости размыты на PLOT_BLEND м: у общего забора соседей — плавный
   * переход, а не ступенька, и за краем участков земля плавно возвращается к съёмке.
   */
  flattenPlots(plots: readonly (readonly (readonly [number, number])[])[]): void {
    const target = new Map<number, number>();
    for (const plot of plots) {
      const ring = plot.map(this.toGrid);
      const xs: number[] = [];
      const ys: number[] = [];
      const zs: number[] = [];
      const nodes: number[] = [];
      this.visit(ring, 0, (i, px, py, d) => {
        if (d > 0 || target.has(i)) return;
        xs.push(px);
        ys.push(py);
        zs.push(this.nodeHeight(i));
        nodes.push(i);
      });
      const plane = fitPlane(xs, ys, zs);
      if (!plane) continue;
      nodes.forEach((i, k) => target.set(i, plane(xs[k]!, ys[k]!)));
    }
    if (!target.size) return;
    // Плотный кусок сетки вокруг участков: высота плоскостей и «доля участков» — размытием (два прохода окна).
    const pad = PLOT_BLEND * 3;
    let c0 = Infinity;
    let r0 = Infinity;
    let c1 = -Infinity;
    let r1 = -Infinity;
    for (const i of target.keys()) {
      const c = i % this.width;
      const r = Math.floor(i / this.width);
      c0 = Math.min(c0, c);
      c1 = Math.max(c1, c);
      r0 = Math.min(r0, r);
      r1 = Math.max(r1, r);
    }
    const rx = Math.max(1, Math.round(PLOT_BLEND / this.cellX));
    const ry = Math.max(1, Math.round(PLOT_BLEND / this.cellY));
    c0 = Math.max(0, c0 - Math.ceil(pad / this.cellX));
    r0 = Math.max(0, r0 - Math.ceil(pad / this.cellY));
    c1 = Math.min(this.width - 1, c1 + Math.ceil(pad / this.cellX));
    r1 = Math.min(this.height - 1, r1 + Math.ceil(pad / this.cellY));
    const w = c1 - c0 + 1;
    const h = r1 - r0 + 1;
    const value = new Float32Array(w * h);
    const share = new Float32Array(w * h);
    for (const [i, v] of target) {
      const k = (Math.floor(i / this.width) - r0) * w + ((i % this.width) - c0);
      value[k] = v;
      share[k] = 1;
    }
    for (let pass = 0; pass < 2; pass++) {
      for (const field of [value, share]) {
        boxBlur(field, w, h, rx, true);
        boxBlur(field, w, h, ry, false);
      }
    }
    const delta = (this.delta ??= new Float32Array(this.width * this.height));
    this.coverageDirty = true;
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const k = r * w + c;
        const s = share[k]!;
        if (s < 1e-3) continue;
        // Внутри участков — сглаженные плоскости; за краем — плавно назад к съёмке.
        const i = (r + r0) * this.width + c + c0;
        const fade = Math.min(1, s / 0.5);
        delta[i]! += (value[k]! / s - this.nodeHeight(i)) * fade * fade * (3 - 2 * fade);
      }
    }
  }

  /**
   * Под домами и сараями — ровная площадка (контур и PAD_MARGIN вокруг) на уровне медианы земли под ней:
   * иначе бугры съёмки под домом поднимают пол и дом стоит на высоком цоколе.
   */
  flattenPads(footprints: readonly (readonly (readonly [number, number])[])[]): void {
    const best = new Map<number, { out: number; h: number }>();
    for (const footprint of footprints) {
      const ring = footprint.map(this.toGrid);
      const under: number[] = [];
      this.visit(ring, PAD_MARGIN, (i, _x, _y, d) => {
        if (d <= PAD_MARGIN) under.push(this.nodeHeight(i));
      });
      if (!under.length) continue;
      const level = median(under);
      this.visit(ring, PAD_MARGIN + PAD_SHOULDER, (i, _x, _y, d) => {
        const out = d - PAD_MARGIN;
        const prev = best.get(i);
        if (!prev || out < prev.out) best.set(i, { out, h: level });
      });
    }
    this.blend(best, PAD_SHOULDER);
  }

  /** Долгота/широта → метры сетки (x — на восток от west, y — на юг от north). */
  private readonly toGrid = ([lon, lat]: readonly [number, number]): XY => [(lon - this.bbox.west) * this.mPerDegLon, (this.bbox.north - lat) * M_PER_DEG_LAT];

  /** Узлы со съёмкой не дальше reach от контура ring (м сетки): fn(узел, x, y, расстояние; внутри — минус). */
  private visit(ring: XY[], reach: number, fn: (i: number, px: number, py: number, distance: number) => void): void {
    if (ring.length < 3) return;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [x, y] of ring) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    const c0 = Math.max(0, Math.floor((x0 - reach) / this.cellX));
    const c1 = Math.min(this.width - 1, Math.ceil((x1 + reach) / this.cellX));
    const r0 = Math.max(0, Math.floor((y0 - reach) / this.cellY));
    const r1 = Math.min(this.height - 1, Math.ceil((y1 + reach) / this.cellY));
    for (let r = r0; r <= r1; r++) {
      const py = r * this.cellY;
      for (let c = c0; c <= c1; c++) {
        const i = r * this.width + c;
        const px = c * this.cellX;
        const d = signedDistance(px, py, ring);
        if (d <= reach) fn(i, px, py, d);
      }
    }
  }

  /**
   * Узлы — к высоте h: вплотную (out ≤ 0) целиком, дальше — плавно до нуля на ширине shoulder. Меняется
   * поправка к итоговой высоте (а не сама съёмка): так ровно и там, где съёмка смешана с общим рельефом.
   */
  private blend(best: Map<number, { out: number; h: number }>, shoulder: number): void {
    const delta = (this.delta ??= new Float32Array(this.width * this.height));
    this.coverageDirty = true;
    for (const [i, { out, h }] of best) {
      const s = Math.min(Math.max(out / shoulder, 0), 1);
      const k = 1 - s * s * (3 - 2 * s);
      delta[i]! += (h - this.nodeHeight(i)) * k;
    }
  }

  /**
   * Высота полотна вдоль оси дороги (м сетки, y — на юг): медиана съёмки поперёк проезжей части через каждый
   * метр, сглаженная вдоль; где съёмки под дорогой нет — по соседним участкам. undefined — съёмки нет вовсе.
   */
  private roadProfile(axis: XY[], width: number): { starts: number[]; at: (s: number) => number } | undefined {
    const starts = [0];
    for (let k = 1; k < axis.length; k++) starts.push(starts[k - 1]! + Math.hypot(axis[k]![0] - axis[k - 1]![0], axis[k]![1] - axis[k - 1]![1]));
    const total = starts[starts.length - 1]!;
    if (total <= 0) return undefined;
    const n = Math.floor(total / ROAD_PROFILE_STEP) + 1;
    const half = Math.max(0.5, width / 2 - 0.5);
    const raw = new Float64Array(n).fill(Number.NaN);
    const cross: number[] = [];
    let k = 0;
    for (let j = 0; j < n; j++) {
      const s = Math.min(j * ROAD_PROFILE_STEP, total);
      while (k < axis.length - 2 && starts[k + 1]! < s) k++;
      const [ax, ay] = axis[k]!;
      const [bx, by] = axis[k + 1]!;
      const len = starts[k + 1]! - starts[k]! || 1;
      const ux = (bx - ax) / len;
      const uy = (by - ay) / len;
      const t = s - starts[k]!;
      cross.length = 0;
      for (let o = -half; o <= half + 1e-6; o += 1) {
        const c = Math.round((ax + ux * t - uy * o) / this.cellX);
        const r = Math.round((ay + uy * t + ux * o) / this.cellY);
        if (c < 0 || r < 0 || c >= this.width || r >= this.height) continue;
        cross.push(this.nodeHeight(r * this.width + c));
      }
      if (cross.length >= 2) {
        cross.sort((a, b) => a - b);
        const m = cross.length >> 1;
        raw[j] = cross.length % 2 ? cross[m]! : (cross[m - 1]! + cross[m]!) / 2;
      }
    }
    // Сглаживание вдоль: гаусс по имеющимся точкам.
    const sigma = ROAD_PROFILE_SIGMA / ROAD_PROFILE_STEP;
    const reach = Math.ceil(sigma * 3);
    const kernel = Array.from({ length: reach + 1 }, (_, d) => Math.exp(-(d * d) / (2 * sigma * sigma)));
    const smooth = new Float64Array(n).fill(Number.NaN);
    for (let j = 0; j < n; j++) {
      let sum = 0;
      let wsum = 0;
      for (let d = -reach; d <= reach; d++) {
        const v = raw[j + d];
        if (v === undefined || Number.isNaN(v)) continue;
        const w = kernel[Math.abs(d)]!;
        sum += v * w;
        wsum += w;
      }
      if (wsum > 0.5) smooth[j] = sum / wsum;
    }
    // Пропуски (под дорогой нет съёмки) — линейно между соседними участками, у концов — как у ближайшего.
    if (smooth.every(Number.isNaN)) return undefined;
    let prev = -1;
    for (let j = 0; j <= n; j++) {
      if (j < n && Number.isNaN(smooth[j]!)) continue;
      for (let g = prev + 1; g < j; g++) {
        if (prev < 0) smooth[g] = smooth[j]!;
        else if (j === n) smooth[g] = smooth[prev]!;
        else smooth[g] = smooth[prev]! + ((smooth[j]! - smooth[prev]!) * (g - prev)) / (j - prev);
      }
      prev = j;
    }
    const at = (s: number): number => {
      const f = Math.min(Math.max(s / ROAD_PROFILE_STEP, 0), n - 1);
      const j = Math.min(Math.floor(f), n - 2);
      if (j < 0) return smooth[0]!;
      return smooth[j]! + (smooth[j + 1]! - smooth[j]!) * (f - j);
    };
    return { starts, at };
  }

  /** Высота в точке: общий рельеф, подправленный съёмкой с её весом. */
  heightAt(lon: number, lat: number): number {
    const base = this.base(lon, lat);
    const { west, south, east, north } = this.bbox;
    if (lon <= west || lon >= east || lat <= south || lat >= north) return base;
    const fx = ((lon - west) / (east - west)) * (this.width - 1);
    const fy = ((north - lat) / (north - south)) * (this.height - 1);
    const x0 = Math.min(Math.floor(fx), this.width - 2);
    const y0 = Math.min(Math.floor(fy), this.height - 2);
    const tx = fx - x0;
    const ty = fy - y0;
    const corners = [
      [x0, y0, (1 - tx) * (1 - ty)],
      [x0 + 1, y0, tx * (1 - ty)],
      [x0, y0 + 1, (1 - tx) * ty],
      [x0 + 1, y0 + 1, tx * ty],
    ] as const;
    let weight = 0;
    let detail = 0;
    for (const [x, y, k] of corners) {
      const i = y * this.width + x;
      weight += this.weights[i]! * k;
      const v = this.values[i]!;
      // В «дырке» съёмки — общий рельеф (там и вес 0, переход начинается дальше).
      detail += (Number.isNaN(v) ? base : v) * k;
    }
    let delta = 0;
    if (this.delta) for (const [x, y, k] of corners) delta += this.delta[y * this.width + x]! * k;
    if (weight <= 0) return base + delta;
    return base + (detail - base) * weight + delta;
  }

  /** Высота в узле сетки — как у heightAt в этой точке, вместе с поправками. */
  private nodeHeight(i: number): number {
    const c = i % this.width;
    const r = (i - c) / this.width;
    const { west, south, east, north } = this.bbox;
    const base = this.base(west + ((east - west) * c) / (this.width - 1), north - ((north - south) * r) / (this.height - 1));
    const v = this.values[i]!;
    const h = Number.isNaN(v) ? base : base + (v - base) * this.weights[i]!;
    return h + (this.delta?.[i] ?? 0);
  }

  private coveredBox(): HeightGridData['bbox'] | undefined {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const i = y * this.width + x;
        if (this.weights[i]! <= 0 && !this.delta?.[i]) continue;
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
    }
    if (x0 > x1) return undefined;
    const { west, south, east, north } = this.bbox;
    const lonAt = (x: number) => west + ((east - west) * x) / (this.width - 1);
    const latAt = (y: number) => north - ((north - south) * y) / (this.height - 1);
    // С запасом в узел: билинейная выборка у края берёт и соседний узел.
    return { west: lonAt(Math.max(0, x0 - 1)), east: lonAt(Math.min(this.width - 1, x1 + 1)), north: latAt(Math.max(0, y0 - 1)), south: latAt(Math.min(this.height - 1, y1 + 1)) };
  }
}

/**
 * Вес съёмки в каждом узле: расстояние (м) до ближайшего узла без данных или до края сетки,
 * плавно (smoothstep) от 0 у края до 1 на расстоянии fade. Расстояние — двухпроходная «фаска» (chamfer).
 */
export function fadeWeights(values: Float32Array, width: number, height: number, cellX: number, cellY: number, fade: number): Float32Array {
  const INF = 1e9;
  const d = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const edge = x === 0 || y === 0 || x === width - 1 || y === height - 1;
      d[i] = Number.isNaN(values[i]!) || edge ? 0 : INF;
    }
  }
  const diag = Math.hypot(cellX, cellY);
  const relax = (i: number, j: number, cost: number) => {
    const v = d[j]! + cost;
    if (v < d[i]!) d[i] = v;
  };
  for (let y = 1; y < height; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      relax(i, i - 1, cellX);
      relax(i, i - width, cellY);
      relax(i, i - width - 1, diag);
      relax(i, i - width + 1, diag);
    }
  }
  for (let y = height - 2; y >= 0; y--) {
    for (let x = width - 2; x >= 1; x--) {
      const i = y * width + x;
      relax(i, i + 1, cellX);
      relax(i, i + width, cellY);
      relax(i, i + width + 1, diag);
      relax(i, i + width - 1, diag);
    }
  }
  const weights = new Float32Array(width * height);
  for (let i = 0; i < d.length; i++) {
    const t = Math.min(d[i]! / Math.max(fade, 1e-6), 1);
    weights[i] = t * t * (3 - 2 * t);
  }
  return weights;
}

export function decodeDetailFile(file: DetailTerrainFile): DetailGridData {
  const bytes = Uint8Array.from(atob(file.heights), (c) => c.charCodeAt(0));
  const raw = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  const values = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) values[i] = raw[i] === file.nodata ? Number.NaN : raw[i]! * file.scale + file.offset;
  return { bbox: file.bbox, width: file.width, height: file.height, values, fade: file.fade };
}
