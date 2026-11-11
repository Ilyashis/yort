// Здания: правила облика для города и деревни, геометрия стен и крыш одной сеткой,
// материал с процедурными фасадами (окна, наличники, витрины, свет ночью).

import { BufferAttribute, BufferGeometry, Color, Mesh, MeshStandardMaterial, ShapeUtils, Vector2 } from 'three';
import type { BuildingProps, Footprint, World } from '../core/data';
import { centroid, hash01, insetRing, obb, pointInRing, signedArea, clamp, type Obb, type P2 } from '../core/geo';
import type { RoadIndex } from '../core/spatial';
import { RingIndex } from '../core/spatial';
import { NOISE_GLSL, shared } from './shared';
import type { HeightMap } from './terrain';

type RoofKind = 'flat' | 'gabled' | 'hipped' | 'skillion' | 'mansard';

export interface Building {
  props: BuildingProps;
  rings: P2[][];
  /** Высота земли под домом. */
  base: number;
  minH: number;
  /** Высота стен до карниза и высота крыши над ним. */
  wallH: number;
  roofH: number;
  roof: RoofKind;
  levels: number;
  levelH: number;
  /** Раскладка окон: 0 нет, 1 классика, 2 ленточная, 3 деревенская, 4 панельная. */
  layout: number;
  /** Поверхность стен: 0 штукатурка, 1 бревно, 2 доска, 3 кирпич, 4 панель. */
  surface: number;
  shop: boolean;
  wall: Color;
  roofColour: Color;
  seed: number;
  box: Obb;
  area: number;
  /** Мешает пройти и проехать. */
  solid: boolean;
  /** Объём собран из частей (building:part) — сам контур не рисуем. */
  hasParts: boolean;
  /** Для части здания — номер здания-владельца. */
  parent: number;
  inset?: P2[];
  extra?: 'minaret';
}

const SURF_ROOF_METAL = 5, SURF_ROOF_FLAT = 6, SURF_PLAIN = 7;

const PAL = {
  plaster: ['#e8dcc0', '#e3cfa5', '#d9c2a0', '#e6d3bd', '#cfd6c4', '#d8dde0', '#e0c9b8', '#c9b79c', '#ead9a8', '#d5b9a0', '#bfc9cf', '#e9e2d3'],
  panel: ['#c9c7bf', '#d6d0c0', '#b9bdc0', '#cfc6b4', '#d9d6cf'],
  brick: ['#9c5a43', '#a8654a', '#8a4f3d', '#b07a5c'],
  modern: ['#9aa7b3', '#b8c0c8', '#7f8c99', '#c8ccd0', '#a3adb8'],
  blank: ['#8f8a80', '#a39d92', '#7d8288', '#96908a'],
  roofCity: ['#6e3b33', '#5a4a44', '#4f5a52', '#7a4a3a', '#565c63', '#3f5448'],
  roofFlat: ['#3a3c40', '#45464a', '#4d4b48', '#38393c'],
  log: ['#7a5a3c', '#6b4d33', '#8a6a48', '#5e4630', '#7a5a3c', '#5f8a6b', '#5b85a8', '#c9b25a'],
  plank: ['#6f95b8', '#7fae8c', '#d6c58a', '#e8e0cc', '#a8c4d0', '#b5876a', '#8fb0a0'],
  brickVillage: ['#e4e0d6', '#d9d2c4', '#a8654a'],
  roofVillage: ['#3b6ea5', '#2f7d5b', '#8a3b32', '#7b2d3a', '#8c9096', '#a0a4a8', '#5a6470', '#6b4a3a', '#3f8a8a'],
  shed: ['#8a7f70', '#7a6e60', '#9a9080', '#6e675c'],
  shedRoof: ['#8c8c86', '#777a78', '#9a958a'],
};
const pick = (list: string[], h: number) => new Color(list[Math.min(list.length - 1, Math.floor(h * list.length))]);

/** Цвет со съёмки: убираем кислотность и пересвет. */
export function tame(hex: string): Color {
  const c = new Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  // Пурпурные и розовые тона — артефакт съёмки: уводим в кирпично-красный.
  const hue = hsl.h > 0.72 && hsl.h < 0.97 ? 0.02 : hsl.h;
  return c.setHSL(hue, Math.min(hsl.s, 0.42), clamp(hsl.l, 0.22, 0.66));
}

const BLANK = new Set(['garage', 'garages', 'industrial', 'service', 'shed', 'roof', 'kiosk', 'warehouse', 'hangar', 'transformer_tower', 'carport', 'ruins', 'construction']);
const MODERN = new Set(['office', 'commercial']);
const HOUSING = new Set(['apartments', 'dormitory', 'residential']);

function groundUnder(ring: readonly P2[], hm: HeightMap): number {
  let lo = Infinity, hi = -Infinity;
  for (const p of ring) {
    const h = hm.at(p[0], p[1]);
    lo = Math.min(lo, h);
    hi = Math.max(hi, h);
  }
  return lo + (hi - lo) * 0.25;
}

/** Какая крыша получится на этом контуре: двускатная — только на прямоугольнике, и так далее. */
function fitRoof(want: RoofKind, b: Building): RoofKind {
  if (want === 'flat' || b.rings.length > 1) return 'flat';
  if ((want === 'gabled' || want === 'skillion') && b.box.fill > 0.9) return want;
  if (b.box.fill > 0.72) return 'hipped';
  const thickness = (2 * b.area) / perimeter(b.rings[0]);
  const inset = insetRing(b.rings[0], Math.min(thickness * 0.42, b.roofH / Math.tan(0.6)));
  if (!inset) return 'flat';
  b.inset = inset;
  return 'mansard';
}

function perimeter(ring: readonly P2[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    s += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return s;
}

function classify(world: World, fp: Footprint, hm: HeightMap, roads: RoadIndex): Building {
  const p = fp.props;
  const outer = fp.rings[0];
  const seed = hash01(p.id);
  const h = (salt: number) => hash01(p.id, salt);
  const area = signedArea(outer);
  const box = obb(outer);
  const b: Building = {
    props: p, rings: fp.rings, base: groundUnder(outer, hm), minH: p.minHeight || 0,
    wallH: p.height, roofH: 0, roof: 'flat', levels: 1, levelH: 3.2, layout: 1, surface: 0, shop: false,
    wall: new Color(), roofColour: new Color(), seed, box, area, solid: true, hasParts: false, parent: -1,
  };
  const type = p.building;
  let want: RoofKind = 'flat';

  if (world.territory.kind === 'village') {
    const survey = world.surveyColours[p.id];
    const shed = p.survey === 'shed' || area < 30 || BLANK.has(type);
    const mosque = type === 'mosque';
    const big = !shed && (area > 260 || type === 'school' || type === 'industrial' || mosque);
    if (shed) {
      b.wallH = clamp(p.survey ? p.height * 0.72 : 2.1 + 0.5 * h(2), 1.9, 2.9);
      want = h(3) < 0.45 ? 'skillion' : 'gabled';
      b.roofH = want === 'skillion' ? 0.5 + box.W * 0.12 : clamp(box.W * 0.4, 0.5, 1.6);
      b.layout = 0;
      b.surface = 2;
      b.wall = pick(PAL.shed, h(4));
      b.roofColour = pick(PAL.shedRoof, h(5));
      b.levels = 0;
    } else if (big) {
      b.wallH = mosque ? 5.2 : type === 'school' ? 6.8 : 4.4;
      b.levels = Math.max(1, Math.round(b.wallH / 3.3));
      b.levelH = b.wallH / b.levels;
      want = 'hipped';
      b.roofH = clamp(box.W * 0.36, 1.2, mosque ? 4.5 : 3);
      b.layout = type === 'industrial' ? 0 : 1;
      b.surface = mosque ? 0 : 3;
      b.wall = mosque ? new Color('#eeeae0') : pick(PAL.brickVillage, h(4));
      b.roofColour = mosque ? new Color('#2f7d5b') : pick(PAL.roofVillage, h(5));
      if (mosque) b.extra = 'minaret';
    } else {
      b.wallH = 2.7 + 0.6 * h(2);
      b.levels = 1;
      b.levelH = b.wallH;
      want = h(3) < 0.85 ? 'gabled' : 'hipped';
      b.roofH = clamp(box.W * Math.tan(0.56 + 0.18 * h(6)), 1.3, 4.2);
      b.layout = 3;
      const s = h(7);
      b.surface = s < 0.45 ? 1 : s < 0.8 ? 2 : 3;
      b.wall = pick(b.surface === 1 ? PAL.log : b.surface === 2 ? PAL.plank : PAL.brickVillage, h(4));
      b.roofColour = pick(PAL.roofVillage, h(5));
    }
    if (survey?.wall) b.wall = tame(survey.wall);
    const roofHex = survey?.roof ?? p.roofColour;
    if (roofHex) b.roofColour = tame(roofHex);
  } else {
    const blank = BLANK.has(type) || area < 30;
    let levels = p.levels ?? Math.max(1, Math.round(p.height / 3.2));
    const tagged = p.roofShape === 'gabled' || p.roofShape === 'hipped' || p.roofShape === 'pyramidal' || p.roofShape === 'skillion';
    if (tagged) {
      want = p.roofShape === 'pyramidal' ? 'hipped' : (p.roofShape as RoofKind);
      b.roofH = clamp(p.roofHeight ?? box.W * 0.55, 0.8, Math.max(1, p.height - 2.4));
      b.wallH = Math.max(2.4, p.height - b.roofH);
    } else if (!blank && levels <= 2 && area < 450 && fp.rings.length === 1 && h(1) < 0.65) {
      want = h(3) < 0.5 ? 'gabled' : 'hipped';
      b.roofH = clamp(box.W * 0.62, 1.2, 4.5);
    }
    levels = Math.max(1, Math.min(levels, Math.floor(b.wallH / 2.6)));
    b.levels = levels;
    b.levelH = clamp(b.wallH / levels, 2.6, 4.6);
    if (blank) {
      b.layout = 0;
      b.levels = 0;
      b.wall = pick(PAL.blank, h(4));
    } else if (MODERN.has(type) || (type === 'retail' && levels >= 3) || levels >= 10) {
      b.layout = 2;
      b.wall = pick(PAL.modern, h(4));
    } else if (HOUSING.has(type) && levels >= 5) {
      b.layout = 4;
      b.surface = 4;
      b.wall = pick(PAL.panel, h(4));
    } else {
      b.wall = pick(PAL.plaster, h(4));
    }
    if (p.material === 'brick') {
      b.surface = 3;
      b.wall = pick(PAL.brick, h(4));
    } else if (p.material === 'wood') {
      b.surface = 2;
      b.wall = pick(PAL.log, h(4));
    }
    if (p.colour) b.wall = tame(p.colour);
    b.roofColour = p.roofColour ? tame(p.roofColour) : pick(want === 'flat' ? PAL.roofFlat : PAL.roofCity, h(5));
    if (b.layout && levels >= 2 && b.minH === 0) {
      const c = centroid(outer);
      const street = roads.nearest(c[0], c[1], box.W + 16, (r) => r.highway !== 'service');
      b.shop = !!street && (type === 'retail' || type === 'commercial' || h(8) < 0.55);
    }
  }
  if (type === 'roof' || type === 'carport') {
    b.minH = Math.max(b.minH, b.wallH - 0.4);
    b.solid = false;
  }
  if (b.minH > 2.4) b.solid = false;
  b.roof = fitRoof(want, b);
  if (b.roof === 'flat') {
    b.wallH += want === 'flat' ? 0 : b.roofH * 0.4;
    b.roofH = 0;
    if (b.roofColour.getHSL({ h: 0, s: 0, l: 0 }).s > 0.25 && world.territory.kind === 'city') b.roofColour = pick(PAL.roofFlat, h(5));
  }
  return b;
}

type V = [number, number, number, number, number];

class Builder {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  uv: number[] = [];
  info: number[] = [];
  style: number[] = [];
  tris = 0;
  private i = [0, 0, 0, 0];
  private s = [0, 0, 0, 0];
  private c = new Color();

  set(c: Color, surface: number, layout = 0, info: number[] = [0, 0, 3, 0], levels = 0, shop = 0): this {
    this.c = c;
    this.i = info;
    this.s = [layout, surface, levels, shop];
    return this;
  }

  /** Выпуклая грань (3–4 вершины), повёрнутая лицом по подсказке hint. */
  face(pts: V[], hx: number, hy: number, hz: number, twoSided = false): void {
    const [a, b, c] = pts;
    let nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
    let ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    let nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-9) return;
    nx /= l;
    ny /= l;
    nz /= l;
    let order = pts;
    if (nx * hx + ny * hy + nz * hz < 0) {
      order = [...pts].reverse();
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    this.fan(order, nx, ny, nz);
    if (twoSided) this.fan([...order].reverse(), -nx, -ny, -nz);
  }

  private fan(p: V[], nx: number, ny: number, nz: number): void {
    for (let k = 1; k < p.length - 1; k++) {
      for (const v of [p[0], p[k], p[k + 1]]) {
        this.pos.push(v[0], v[1], v[2]);
        this.nrm.push(nx, ny, nz);
        this.col.push(this.c.r, this.c.g, this.c.b);
        this.uv.push(v[3], v[4]);
        this.info.push(this.i[0], this.i[1], this.i[2], this.i[3]);
        this.style.push(this.s[0], this.s[1], this.s[2], this.s[3]);
      }
      this.tris++;
    }
  }

  /** Коробка, повёрнутая вдоль (ux, uz): центр, полуразмеры, низ и верх. */
  box(cx: number, cz: number, ux: number, uz: number, hl: number, hw: number, y0: number, y1: number): void {
    const P = (su: number, sw: number, y: number, u: number, v: number): V => [cx + ux * su - uz * sw, y, cz + uz * su + ux * sw, u, v];
    const sides: [number, number, number, number][] = [[-1, -1, 1, -1], [1, -1, 1, 1], [1, 1, -1, 1], [-1, 1, -1, -1]];
    for (const [a, b, c, d] of sides) {
      const p0 = P(a * hl, b * hw, y0, 0, 0), p1 = P(c * hl, d * hw, y0, 1, 0);
      const p2 = P(c * hl, d * hw, y1, 1, 1), p3 = P(a * hl, b * hw, y1, 0, 1);
      this.face([p0, p1, p2, p3], (p0[0] + p1[0]) / 2 - cx, 0, (p0[2] + p1[2]) / 2 - cz);
    }
    this.face([P(-hl, -hw, y1, 0, 0), P(hl, -hw, y1, 1, 0), P(hl, hw, y1, 1, 1), P(-hl, hw, y1, 0, 1)], 0, 1, 0);
  }
}

function triangulate(rings: readonly P2[][]): { pts: P2[]; tris: number[][] } {
  const v = rings.map((r) => r.map((p) => new Vector2(p[0], p[1])));
  return { pts: rings.flat(), tris: ShapeUtils.triangulateShape(v[0], v.slice(1)) };
}

function meshBuilding(g: Builder, b: Building): void {
  const { base, box, wallH, roofH } = b;
  const flat = b.roof === 'flat';
  const parapet = flat && b.layout > 0 && b.layout !== 3 && b.area > 60 ? 0.55 : 0;
  const y0 = base + wallH;
  const top = wallH + parapet;
  const levels = Math.min(b.levels, Math.floor((wallH - b.minH) / b.levelH + 0.01) || (b.levels ? 1 : 0));
  const darker = b.wall.clone().multiplyScalar(0.72);

  // Стены.
  for (const ring of b.rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], c = ring[(i + 1) % ring.length];
      const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
      if (len < 0.05) continue;
      const nx = (c[1] - a[1]) / len, nz = -(c[0] - a[0]) / len;
      const v0 = b.minH > 0 ? b.minH : -4;
      g.set(b.wall, b.surface, b.minH > 0 ? 0 : b.layout, [len, wallH, b.levelH, b.seed], levels, b.shop ? 1 : 0);
      g.face([[a[0], base + v0, a[1], 0, v0], [c[0], base + v0, c[1], len, v0], [c[0], base + top, c[1], len, top], [a[0], base + top, a[1], 0, top]], nx, 0, nz);
      if (parapet) {
        g.set(darker, SURF_PLAIN);
        g.face([[a[0], y0, a[1], 0, 0], [c[0], y0, c[1], len, 0], [c[0], base + top, c[1], len, 1], [a[0], base + top, a[1], 0, 1]], -nx, 0, -nz);
      }
    }
  }
  // Низ навесов и частей на опорах.
  if (b.minH > 0) {
    const { pts, tris } = triangulate(b.rings);
    g.set(darker, SURF_PLAIN);
    for (const t of tris) g.face(t.map((k) => [pts[k][0], base + b.minH, pts[k][1], 0, 0] as V), 0, -1, 0);
  }

  const P = (su: number, sw: number, y: number, u: number, v: number): V => [box.cx + box.ux * su - box.uz * sw, y, box.cz + box.uz * su + box.ux * sw, u, v];
  const { L, W } = box;
  const yr = y0 + roofH;
  const wallInfo = [2 * W, wallH, b.levelH, b.seed];
  const metal = () => g.set(b.roofColour, SURF_ROOF_METAL);

  if (flat) {
    const { pts, tris } = triangulate(b.rings);
    g.set(b.roofColour, SURF_ROOF_FLAT, 0, [0, 0, 3, b.seed]);
    for (const t of tris) g.face(t.map((k) => [pts[k][0], y0, pts[k][1], pts[k][0], pts[k][1]] as V), 0, 1, 0);
    if (b.layout > 0 && b.layout !== 3 && b.levels >= 5 && b.area > 250) {
      const c = centroid(b.rings[0]);
      if (pointInRing(c[0], c[1], b.rings[0])) {
        g.set(new Color('#8d8f92'), SURF_PLAIN);
        g.box(c[0], c[1], box.ux, box.uz, 2.4, 1.7, y0, y0 + 2.6);
      }
    }
  } else if (b.roof === 'gabled') {
    const o = 0.4, og = 0.35;
    const ye = y0 - (o * roofH) / W;
    const sl = Math.hypot(W + o, yr - ye);
    metal();
    for (const s of [-1, 1]) {
      g.face([P(-(L + og), s * (W + o), ye, -(L + og), sl), P(L + og, s * (W + o), ye, L + og, sl), P(L + og, 0, yr, L + og, 0), P(-(L + og), 0, yr, -(L + og), 0)], 0, 1, 0, true);
    }
    for (const e of [-1, 1]) {
      g.set(b.wall, b.surface === 1 ? 2 : b.surface, 0, wallInfo);
      g.face([P(e * L, -W, y0, 0, wallH), P(e * L, W, y0, 2 * W, wallH), P(e * L, 0, yr, W, wallH + roofH)], e * box.ux, 0, e * box.uz);
    }
  } else if (b.roof === 'hipped') {
    const o = 0.4;
    const ye = y0 - (o * roofH) / W;
    const R = Math.max(0, L - W);
    const sl = Math.hypot(W + o, yr - ye);
    metal();
    for (const s of [-1, 1]) {
      g.face([P(-(L + o), s * (W + o), ye, -(L + o), sl), P(L + o, s * (W + o), ye, L + o, sl), P(R, 0, yr, R, 0), P(-R, 0, yr, -R, 0)], 0, 1, 0, true);
      g.face([P(s * (L + o), -(W + o), ye, -(W + o), sl), P(s * (L + o), W + o, ye, W + o, sl), P(s * R, 0, yr, 0, 0)], 0, 1, 0, true);
    }
  } else if (b.roof === 'skillion') {
    const o = 0.3;
    const k = roofH / (2 * W);
    metal();
    g.face([P(-(L + o), -(W + o), yr + o * k, -(L + o), 0), P(L + o, -(W + o), yr + o * k, L + o, 0), P(L + o, W + o, y0 - o * k, L + o, 2 * W), P(-(L + o), W + o, y0 - o * k, -(L + o), 2 * W)], 0, 1, 0, true);
    g.set(b.wall, b.surface, 0, [2 * L, wallH, b.levelH, b.seed]);
    g.face([P(-L, -W, y0, 0, wallH), P(L, -W, y0, 2 * L, wallH), P(L, -W, yr, 2 * L, wallH + roofH), P(-L, -W, yr, 0, wallH + roofH)], box.uz, 0, -box.ux);
    for (const e of [-1, 1]) {
      g.set(b.wall, b.surface, 0, wallInfo);
      g.face([P(e * L, -W, y0, 0, wallH), P(e * L, W, y0, 2 * W, wallH), P(e * L, -W, yr, 0, wallH + roofH)], e * box.ux, 0, e * box.uz);
    }
  } else if (b.inset) {
    const outer = b.rings[0];
    const inner = b.inset;
    metal();
    for (let i = 0; i < outer.length; i++) {
      const j = (i + 1) % outer.length;
      const len = Math.hypot(outer[j][0] - outer[i][0], outer[j][1] - outer[i][1]);
      g.face([[outer[i][0], y0, outer[i][1], 0, 2], [outer[j][0], y0, outer[j][1], len, 2], [inner[j][0], yr, inner[j][1], len, 0], [inner[i][0], yr, inner[i][1], 0, 0]], 0, 1, 0);
    }
    const { pts, tris } = triangulate([inner]);
    for (const t of tris) g.face(t.map((k) => [pts[k][0], yr, pts[k][1], pts[k][0], pts[k][1]] as V), 0, 1, 0);
  }

  // Печная труба у деревенских домов и малоэтажных городских под скатной крышей.
  if (!flat && b.roof !== 'skillion' && b.levels > 0 && b.levels <= 2 && b.area < 300) {
    g.set(new Color('#8a5a48'), 3, 0, [1, 0, 3, b.seed]);
    const side = b.seed > 0.5 ? 1 : -1;
    g.box(box.cx + box.ux * L * 0.3 * side - box.uz * W * 0.2, box.cz + box.uz * L * 0.3 * side + box.ux * W * 0.2, box.ux, box.uz, 0.3, 0.3, yr - roofH * 0.5, yr + 0.6);
  }

  if (b.extra === 'minaret') {
    const mx = box.cx + box.ux * (L + 1.6) - box.uz * (W * 0.6), mz = box.cz + box.uz * (L + 1.6) + box.ux * (W * 0.6);
    const r = 0.95, h = 15, n = 10;
    const at = (k: number, rad: number): [number, number] => [mx + Math.cos((k / n) * Math.PI * 2) * rad, mz + Math.sin((k / n) * Math.PI * 2) * rad];
    for (let k = 0; k < n; k++) {
      const [ax, az] = at(k, r), [bx, bz] = at(k + 1, r);
      g.set(b.wall, SURF_PLAIN);
      g.face([[ax, base - 2, az, 0, 0], [bx, base - 2, bz, 1, 0], [bx, base + h, bz, 1, 1], [ax, base + h, az, 0, 1]], ax + bx - 2 * mx, 0, az + bz - 2 * mz);
      const [cx, cz] = at(k, r + 0.35), [dx, dz] = at(k + 1, r + 0.35);
      g.set(b.roofColour, SURF_PLAIN);
      g.face([[cx, base + h, cz, 0, 0], [dx, base + h, dz, 1, 0], [mx, base + h + 4.2, mz, 0.5, 1]], cx + dx - 2 * mx, 0.5, cz + dz - 2 * mz, true);
    }
  }
}

export interface BuildingSet {
  mesh: Mesh;
  list: Building[];
  /** Номер здания по номеру треугольника (для выбора щелчком). */
  pick: (faceIndex: number) => Building | undefined;
  byId: (id: string) => Building | undefined;
  /** Не рисовать эти здания (убраны или изменены в редакторе). */
  setHidden: (ids: ReadonlySet<string>) => void;
  /** Земля поменялась: здания в прямоугольнике встают на новую высоту. */
  reseat: (hm: HeightMap, area: { x0: number; z0: number; x1: number; z1: number }) => void;
  dispose: () => void;
}

export function createBuildings(world: World, hm: HeightMap, roads: RoadIndex, skip: ReadonlySet<string> = new Set()): BuildingSet {
  const list = world.buildings.map((fp) => classify(world, fp, hm, roads));

  // Части зданий: объём берём из них, оформление — от здания-владельца.
  const index = new RingIndex();
  list.forEach((b) => index.add(b.rings[0]));
  const parents = list.length;
  for (const fp of world.parts) {
    const c = centroid(fp.rings[0]);
    const owner = index.find(c[0], c[1]);
    if (owner < 0 || owner >= parents) continue;
    const parent = list[owner];
    parent.hasParts = true;
    const part = classify(world, fp, hm, roads);
    Object.assign(part, { wall: parent.wall, layout: parent.layout, surface: parent.surface, base: parent.base, shop: false, solid: false, parent: owner });
    if (part.roof === 'flat') part.roofColour = parent.roofColour;
    list.push(part);
  }

  const g = new Builder();
  const owners: number[] = [];
  const ends: number[] = [];
  /** Вершины каждого нарисованного здания: [номер в list, первая вершина, число вершин]. */
  const spans: [number, number, number][] = [];
  list.forEach((b, i) => {
    if (b.hasParts || skip.has(b.props.id)) return;
    const first = g.tris * 3;
    meshBuilding(g, b);
    spans.push([i, first, g.tris * 3 - first]);
    owners.push(b.parent >= 0 ? b.parent : i);
    ends.push(g.tris);
  });

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(g.pos), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(g.nrm), 3));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(g.col), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(g.uv), 2));
  geometry.setAttribute('aInfo', new BufferAttribute(new Float32Array(g.info), 4));
  geometry.setAttribute('aStyle', new BufferAttribute(new Float32Array(g.style), 4));
  geometry.computeBoundingSphere();
  const material = createFacadeMaterial();
  const mesh = new Mesh(geometry, material);
  const position = geometry.getAttribute('position') as BufferAttribute;
  const live = position.array as Float32Array;
  const original = live.slice();
  let hidden: ReadonlySet<string> = new Set();
  const idOf = (i: number) => (list[i].parent >= 0 ? list[list[i].parent] : list[i]).props.id;
  /** Живые вершины здания — из исходных; спрятанное сводится в точку (исчезают и тени). */
  const write = (span: [number, number, number]) => {
    const [i, first, count] = span;
    const hide = hidden.has(idOf(i));
    for (let v = first; v < first + count; v++) {
      const src = (hide ? first : v) * 3;
      live[v * 3] = original[src];
      live[v * 3 + 1] = original[src + 1];
      live[v * 3 + 2] = original[src + 2];
    }
  };
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'buildings';

  return {
    mesh,
    list,
    pick: (face) => {
      let lo = 0, hi = ends.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (ends[mid] > face) hi = mid;
        else lo = mid + 1;
      }
      return list[owners[lo]];
    },
    byId: (id) => list.find((b) => b.props.id === id && b.parent < 0),
    setHidden: (ids) => {
      const before = hidden;
      hidden = ids;
      let changed = false;
      for (const span of spans) {
        const id = idOf(span[0]);
        if (before.has(id) === ids.has(id)) continue;
        write(span);
        changed = true;
      }
      if (changed) position.needsUpdate = true;
    },
    reseat: (heights, area) => {
      const moved = new Map<number, number>();
      list.forEach((b, i) => {
        if (b.parent >= 0) return;
        const { cx, cz, L } = b.box;
        if (cx + L < area.x0 || cx - L > area.x1 || cz + L < area.z0 || cz - L > area.z1) return;
        const base = groundUnder(b.rings[0], heights);
        if (Math.abs(base - b.base) < 1e-3) return;
        moved.set(i, base - b.base);
        b.base = base;
      });
      if (!moved.size) return;
      for (const span of spans) {
        const b = list[span[0]];
        const d = moved.get(b.parent >= 0 ? b.parent : span[0]);
        if (!d) continue;
        if (b.parent >= 0) b.base += d;
        for (let v = span[1]; v < span[1] + span[2]; v++) original[v * 3 + 1] += d;
        write(span);
      }
      position.needsUpdate = true;
    },
    dispose: () => {
      geometry.dispose();
      material.dispose();
    },
  };
}

function createFacadeMaterial(): MeshStandardMaterial {
  const material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.93, metalness: 0 });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWindows = shared.uWindows;
    shader.uniforms.uNight = shared.uNight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aInfo;\nattribute vec4 aStyle;\nvarying vec2 vUvW;\nvarying vec4 vInfo;\nvarying vec4 vStyle;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvUvW = uv;\nvInfo = aInfo;\nvStyle = aStyle;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\nvarying vec2 vUvW;\nvarying vec4 vInfo;\nvarying vec4 vStyle;\nuniform float uWindows;\nuniform float uNight;\n${NOISE_GLSL}`,
      )
      .replace('#include <color_fragment>', `#include <color_fragment>\n${FACADE_GLSL}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(fRough, 0.07, fGlass);')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix(fMetal, 0.85, fGlass);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += fGlow;');
  };
  return material;
}

const FACADE_GLSL = /* glsl */ `
float wl = vInfo.x, wh = vInfo.y, lh = max(vInfo.z, 1.0), seed = vInfo.w;
float lay = floor(vStyle.x + 0.5), surf = floor(vStyle.y + 0.5), levels = vStyle.z, shop = vStyle.w;
vec2 p = vUvW;
vec3 wallCol = diffuseColor.rgb;
float px = max(length(dFdx(p)), length(dFdy(p)));
float fGlass = 0.0, fRough = 0.93, fMetal = 0.0;
vec3 fGlow = vec3(0.0);

if (surf < 0.5) {
  wallCol *= 0.93 + 0.12 * vnoise(p * 0.6 + seed * 50.0);
} else if (surf < 1.5) {
  float r = p.y / 0.25;
  float g = fract(r);
  float groove = smoothstep(0.0, 0.16, g) * smoothstep(1.0, 0.84, g);
  float f = 1.0 - smoothstep(0.03, 0.12, px);
  wallCol *= mix(0.88, (0.6 + 0.44 * groove) * (0.9 + 0.2 * h21(vec2(floor(r), seed * 77.0))), f);
} else if (surf < 2.5) {
  float r = p.x / 0.16;
  float g = abs(fract(r) - 0.5);
  float f = 1.0 - smoothstep(0.02, 0.08, px);
  wallCol *= mix(0.94, (1.0 - 0.3 * smoothstep(0.4, 0.5, g)) * (0.9 + 0.16 * h21(vec2(floor(r), seed * 31.0))), f);
} else if (surf < 3.5) {
  vec2 q = vec2(p.x / 0.26, p.y / 0.085);
  q.x += 0.5 * mod(floor(q.y), 2.0);
  vec2 g = abs(fract(q) - 0.5);
  float f = 1.0 - smoothstep(0.008, 0.03, px);
  float mortar = max(smoothstep(0.44, 0.5, g.x), smoothstep(0.36, 0.5, g.y));
  wallCol *= mix(0.94, (1.0 - 0.3 * mortar) * (0.86 + 0.26 * h21(floor(q) + seed * 13.0)), f);
} else if (surf < 4.5) {
  wallCol *= 0.95 + 0.08 * vnoise(p * 0.4 + seed * 20.0);
} else if (surf < 5.5) {
  float g = abs(fract(p.x / 0.5) - 0.5);
  float f = 1.0 - smoothstep(0.04, 0.2, px);
  wallCol *= mix(0.96, 1.0 - 0.3 * smoothstep(0.42, 0.5, g) + 0.07 * smoothstep(0.3, 0.42, g), f);
  wallCol *= 0.9 + 0.2 * vnoise(p * 0.5 + seed * 30.0);
  fRough = 0.48;
  fMetal = 0.3;
} else if (surf < 6.5) {
  wallCol *= 0.9 + 0.2 * vnoise(p * 0.3 + seed * 9.0);
  fRough = 0.97;
}

if (surf < 4.5) {
  if (p.y < 0.0) wallCol = mix(wallCol, vec3(0.16), 0.6) * 0.75;
  else if (p.y < 0.45) wallCol *= 0.6;
  wallCol *= mix(0.74, 1.0, smoothstep(-0.5, 3.0, p.y)) * mix(1.0, 0.86, smoothstep(wh - 0.9, wh, p.y) * step(p.y, wh));
  if (lay > 0.5 && lay != 3.0 && p.y > wh - 0.32) wallCol = mix(wallCol, vec3(0.75), 0.3);

  if (lay > 0.5 && wl > 2.2 && p.y > 0.0 && p.y < levels * lh) {
    float bayW = lay < 1.5 ? 3.0 : lay < 2.5 ? 3.3 : lay < 3.5 ? 2.6 : 3.2;
    float nb = max(1.0, floor(wl / bayW + 0.5));
    float bw = wl / nb;
    float bi = floor(p.x / bw);
    float fx = (fract(p.x / bw) - 0.5) * bw;
    float fi = floor(p.y / lh);
    float fy = p.y - fi * lh;
    float halfW = 0.56 + 0.1 * step(0.5, fract(seed * 7.0)), sill = 0.95, head = sill + 1.65, trimW = 0.1;
    if (lay > 3.5) { halfW = 0.85; head = sill + 1.4; trimW = 0.0; }
    else if (lay > 2.5) { halfW = 0.5; sill = 0.85; head = sill + 1.15; trimW = 0.11; }
    else if (lay > 1.5) { halfW = bw * 0.5 - 0.12; sill = 0.9; head = lh - 0.55; trimW = 0.0; }
    bool shopF = shop > 0.5 && fi < 0.5;
    if (shopF) { halfW = bw * 0.5 - 0.3; sill = 0.4; head = lh - 0.95; trimW = 0.06; }
    head = min(head, lh - 0.3);
    halfW = min(halfW, bw * 0.5 - 0.1);
    float vis = 1.0 - smoothstep(0.5, 1.6, px);
    float nearF = 1.0 - smoothstep(0.05, 0.3, px);
    float d = max(abs(fx) - halfW, max(sill - fy, fy - head));
    float aa = px * 0.8 + 0.001;
    float win = (1.0 - smoothstep(-aa, aa, d)) * vis;
    bool village = lay > 2.5 && lay < 3.5;
    if (trimW > 0.0) {
      float trim = clamp((1.0 - smoothstep(-aa, aa, d - trimW)) * vis - win, 0.0, 1.0);
      wallCol = mix(wallCol, village ? vec3(0.88) : mix(wallCol, vec3(0.95), 0.55), trim);
    }
    if (village) {
      float ky = fy - (head + trimW);
      float kok = step(0.0, ky) * step(ky, 0.28) * step(abs(fx), (halfW + 0.2) * (1.0 - ky / 0.3));
      wallCol = mix(wallCol, vec3(0.88), kok * vis);
      float sdx = abs(fx) - (halfW + trimW);
      float shut = step(0.5, fract(seed * 5.3)) * step(0.0, sdx) * step(sdx, 0.3) * step(sill, fy) * step(fy, head);
      vec3 shutCol = fract(seed * 3.7) < 0.5 ? vec3(0.1, 0.27, 0.48) : vec3(0.09, 0.32, 0.18);
      wallCol = mix(wallCol, shutCol, shut * vis);
    }
    float mull = 1.0 - smoothstep(0.03, 0.03 + aa, abs(fx));
    if (!shopF && lay < 1.5 || village || lay > 3.5) mull = max(mull, 1.0 - smoothstep(0.03, 0.03 + aa, abs(fy - mix(sill, head, 0.7))));
    if (lay > 1.5 && lay < 2.5 && !shopF) mull = 0.0;
    mull *= nearF;
    fGlass = win * (1.0 - mull);
    wallCol = mix(wallCol, vec3(0.9), win * mull);
    vec3 glassCol = mix(vec3(0.2, 0.25, 0.31), vec3(0.42, 0.5, 0.58), smoothstep(sill, head, fy)) * (0.8 + 0.4 * h21(vec2(bi + seed * 11.0, fi)));
    wallCol = mix(wallCol, glassCol, fGlass);

    float h1 = h21(vec2(bi + seed * 37.0, fi + seed * 91.0));
    float h2 = fract(h1 * 57.3);
    float on = step(h1, uWindows * (shopF ? 1.5 : 0.34));
    vec3 lightCol = mix(vec3(1.0, 0.7, 0.36), vec3(0.8, 0.88, 1.0), step(0.84, h2));
    float curtain = mix(1.0, 0.5, step(0.5, fract(h1 * 13.7)) * step(fy, mix(sill, head, 0.55)));
    fGlow = lightCol * on * fGlass * (0.7 + 0.9 * h2) * curtain * 1.7;
    if (on > 0.5) wallCol = mix(wallCol, vec3(0.05), fGlass);

    if (shopF) {
      float sy = fy - (lh - 0.8);
      float sgn = step(0.0, sy) * step(sy, 0.5) * step(abs(fx), bw * 0.5 - 0.5) * step(0.35, fract(seed * 11.0 + bi * 0.37)) * vis;
      vec3 signCol = 0.5 + 0.5 * cos(6.2831 * (fract(seed * 17.0 + bi * 0.21) + vec3(0.0, 0.33, 0.67)));
      wallCol = mix(wallCol, signCol * 0.55, sgn);
      fGlow += signCol * sgn * uNight * 0.9;
    }
  }
}
diffuseColor.rgb = wallCol;
`;
