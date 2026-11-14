// Детали деревенских домов из простых частей — без привязки к движку: ящики, брёвна (цилиндры),
// плоские плиты (скаты крыш, фронтоны, резьба наличников) и стёкла окон.
// Оси дома: x — вдоль уличного фасада, y — вглубь двора (улица со стороны −y), z — вверх от земли,
// центр основного сруба — (0, 0). Размеры — в метрах.

import { random01 } from '../../utils/hash';

export type Vec3 = [number, number, number];

/** Рисунок поверхности (его рисует шейдер по координатам на поверхности, без текстур). */
export type Surface =
  | 'plain'
  | 'wood'
  | 'siding'
  | 'boards'
  | 'metal'
  | 'slate'
  | 'brick'
  | 'felt'
  | 'ornament'
  | 'endgrain'
  | 'plaster'
  | 'grass'
  | 'dirt'
  | 'logs';

export const SURFACE_CODES: Record<Surface, number> = {
  plain: 0,
  wood: 1,
  siding: 2,
  boards: 3,
  metal: 4,
  slate: 5,
  brick: 6,
  felt: 7,
  ornament: 8,
  endgrain: 9,
  plaster: 10,
  grass: 11,
  dirt: 12,
  logs: 13,
};

/**
 * Чем деталь окрашена в доме: кровля или стены и оттенок от основного цвета (конёк темнее кровли и т. п.).
 * По этой метке цвет можно заменить снятым с дрона, не пересобирая модель.
 */
export interface Paint {
  role: 'roof' | 'wall';
  tone: number;
}

/** Ящик: центр, размеры [вдоль, поперёк, высота], поворот вокруг вертикали (рад от оси x против часовой). */
export interface BoxPart {
  type: 'box';
  center: Vec3;
  size: Vec3;
  angle?: number;
  color: string;
  surface?: Surface;
  paint?: Paint;
}

/** Цилиндр или усечённый конус от from до to (бревно, труба, стена юрты). */
export interface CylinderPart {
  type: 'cylinder';
  from: Vec3;
  to: Vec3;
  radius: number;
  /** Радиус у to (конус); по умолчанию — как у from. */
  radiusTop?: number;
  segments?: number;
  color: string;
  surface?: Surface;
  /** Торцы: цвет (у брёвен — светлее, с годовыми кольцами); false — без торцов. */
  caps?: string | false;
  paint?: Paint;
}

/** Плоская плита: многоугольник в одной плоскости (лицевая сторона — по обходу) и толщина внутрь. */
export interface SlabPart {
  type: 'slab';
  points: Vec3[];
  thickness: number;
  color: string;
  surface?: Surface;
  paint?: Paint;
}

/** Стекло окна: ящик, как BoxPart; lit — с какой «доли вечера» горит свет, curtain — тюль. */
export interface GlassPart {
  type: 'glass';
  center: Vec3;
  size: Vec3;
  angle?: number;
  lit: number;
  curtain: boolean;
}

/** Табличка с надписью (рисуется текстурой): как тонкий ящик, лицом наружу от стены (по angle — вдоль). */
export interface SignPart {
  type: 'sign';
  center: Vec3;
  /** [ширина, толщина, высота]. */
  size: Vec3;
  angle: number;
  /** Строки — через «\n». */
  text: string;
  background: string;
  color: string;
}

/** Округлое тело (куст, крона, цветы): низкополигональный эллипсоид; radii — по x, y, z, angle — поворот вокруг вертикали. */
export interface BlobPart {
  type: 'blob';
  center: Vec3;
  radii: Vec3;
  angle?: number;
  color: string;
  /** Детальность: 0 — 20 граней (мелочь и даль), 1 — 80 граней. */
  detail?: 0 | 1;
  paint?: Paint;
}

export type HousePart = BoxPart | CylinderPart | SlabPart | GlassPart | SignPart | BlobPart;

// --- случайность и цвет -------------------------------------------------------------------------

/** Детерминированные «кости» от зерна: одно зерно — один и тот же дом. */
export class Dice {
  private n = 0;
  constructor(private readonly seed: number) {}
  next(): number {
    this.n += 1;
    return random01(Math.imul(this.seed, 7919) + this.n * 104_729);
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)] ?? items[0]!;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

const hexToRgb = (hex: string): [number, number, number] => [0, 2, 4].map((i) => parseInt(hex.slice(1 + i, 3 + i), 16)) as [number, number, number];
const rgbToHex = (rgb: number[]) => `#${rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;

/** Цвет светлее (k > 1) или темнее (k < 1). */
export function shade(hex: string, k: number): string {
  return rgbToHex(hexToRgb(hex).map((v) => v * k));
}

/**
 * Оттенок цвета color относительно base: k, если color ≈ base × k по всем каналам (k от 0,6 до 1,3), иначе undefined.
 * Так узнаём «тот же цвет, только темнее/светлее» — конёк кровли, тёмные доски фронтона из бревна стен.
 */
export function toneOf(color: string, base: string): number | undefined {
  if (!/^#[0-9a-f]{6}$/i.test(color) || !/^#[0-9a-f]{6}$/i.test(base)) return undefined;
  const c = hexToRgb(color);
  const b = hexToRgb(base);
  const sum = b[0] + b[1] + b[2];
  if (sum < 30) return color.toLowerCase() === base.toLowerCase() ? 1 : undefined;
  const k = (c[0] + c[1] + c[2]) / sum;
  if (k < 0.6 || k > 1.3) return undefined;
  // Каждый канал должен совпасть с base × k (с учётом округления до 0..255).
  return c.every((v, i) => Math.abs(v - Math.min(255, b[i]! * k)) <= 4) ? Number(k.toFixed(3)) : undefined;
}

/** Перекрасить кровлю и стены модели: деталь с меткой paint получает новый цвет с тем же оттенком. */
export function repaintParts(parts: readonly HousePart[], colors: { roof?: string; wall?: string }): HousePart[] {
  if (!colors.roof && !colors.wall) return parts as HousePart[];
  return parts.map((p) => {
    if (!('paint' in p) || !p.paint) return p;
    const base = colors[p.paint.role];
    if (!base || !/^#[0-9a-f]{6}$/i.test(base)) return p;
    const rgb = hexToRgb(base);
    return { ...p, color: rgbToHex(rgb.map((v) => Math.min(255, v * p.paint!.tone))) };
  });
}

export function mixColor(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  return rgbToHex(ca.map((v, i) => v + (cb[i]! - v) * t));
}

// --- геометрия ----------------------------------------------------------------------------------

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Нормаль многоугольника по обходу (метод Ньюэлла), не нормированная. */
export function polygonNormal(points: readonly Vec3[]): Vec3 {
  const n: Vec3 = [0, 0, 0];
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return n;
}

/** Плита лицом в сторону facing (обход разворачивается, если нужно). */
export function slab(points: Vec3[], facing: Vec3, thickness: number, color: string, surface?: Surface): SlabPart {
  const ordered = dot(polygonNormal(points), facing) >= 0 ? points : [points[0]!, ...points.slice(1).reverse()];
  return { type: 'slab', points: ordered, thickness, color, surface };
}

/** Стена: начало (x, y), направление вдоль стены (tx, ty), длина. Наружу — вправо от направления. */
export interface WallFrame {
  x: number;
  y: number;
  tx: number;
  ty: number;
  length: number;
}

/** Точка на стене: u — вдоль стены от начала, out — наружу от оси стены, z — высота. */
export function at(f: WallFrame, u: number, out: number, z: number): Vec3 {
  return [f.x + f.tx * u + f.ty * out, f.y + f.ty * u - f.tx * out, z];
}

export const outward = (f: WallFrame): Vec3 => [f.ty, -f.tx, 0];
export const wallAngle = (f: WallFrame) => Math.atan2(f.ty, f.tx);

/** Стены прямоугольника w × d с центром (cx, cy), обход против часовой: перед (−y), право, зад, лево. */
export function rectWalls(w: number, d: number, cx = 0, cy = 0): { front: WallFrame; right: WallFrame; back: WallFrame; left: WallFrame } {
  return {
    front: { x: cx - w / 2, y: cy - d / 2, tx: 1, ty: 0, length: w },
    right: { x: cx + w / 2, y: cy - d / 2, tx: 0, ty: 1, length: d },
    back: { x: cx + w / 2, y: cy + d / 2, tx: -1, ty: 0, length: w },
    left: { x: cx - w / 2, y: cy + d / 2, tx: 0, ty: -1, length: d },
  };
}

/** Ящик на стене: center — (u, out, z), размеры [вдоль, поперёк, высота]. */
export function wallBox(f: WallFrame, u: number, out: number, z: number, size: Vec3, color: string, surface?: Surface): BoxPart {
  return { type: 'box', center: at(f, u, out, z), size, angle: wallAngle(f), color, surface };
}

/** Плоская деталь на стене (резьба, фронтон): точки (u, z), лицом наружу. */
export function wallSlab(f: WallFrame, out: number, points: [number, number][], thickness: number, color: string, surface?: Surface): SlabPart {
  return slab(
    points.map(([u, z]) => at(f, u, out, z)),
    outward(f),
    thickness,
    color,
    surface,
  );
}

/** Проём в стене (u — вдоль стены, z — по высоте). */
export interface Opening {
  u0: number;
  u1: number;
  z0: number;
  z1: number;
}

// --- срубы и стены ------------------------------------------------------------------------------

export interface LogWallOptions {
  z0: number;
  rows: number;
  radius: number;
  /** Сдвиг рядов на полбревна (у соседних стен сруба венцы чередуются). */
  half: boolean;
  /** Выпуск брёвен за угол («в чашу»), м. */
  overhang: number;
  openings: readonly Opening[];
  color: string;
  dice: Dice;
  /** Дальний план: стена — плоскость с рисунком брёвен вместо цилиндров. */
  far?: boolean;
}

/** Шаг венцов: брёвна чуть врезаны друг в друга. */
export const logPitch = (radius: number) => radius * 1.8;
/** Высота сруба (верх последнего бревна). */
export const logWallTop = (z0: number, rows: number, radius: number, half = true) => z0 + radius + (rows - 1 + (half ? 0.5 : 0)) * logPitch(radius) + radius;

/** Бревенчатая стена: венцы, разрезанные проёмами окон и дверей; торцы светлее. */
export function logWall(f: WallFrame, o: LogWallOptions): HousePart[] {
  if (o.far) {
    const top = logWallTop(o.z0, o.rows, o.radius, o.half);
    return solidWall(f, o.z0, top - o.z0, o.radius * 1.8, o.openings, o.color, 'logs');
  }
  const parts: HousePart[] = [];
  const pitch = logPitch(o.radius);
  const ends = shade(mixColor(o.color, '#d9c39a', 0.45), 1.05);
  for (let i = 0; i < o.rows; i++) {
    const z = o.z0 + o.radius + (i + (o.half ? 0.5 : 0)) * pitch;
    // Отрезки бревна между проёмами.
    let cuts: [number, number][] = [[-o.overhang, f.length + o.overhang]];
    for (const op of o.openings) {
      if (z < op.z0 - o.radius * 0.35 || z > op.z1 + o.radius * 0.35) continue;
      cuts = cuts.flatMap(([a, b]) => {
        if (op.u1 <= a || op.u0 >= b) return [[a, b] as [number, number]];
        const out: [number, number][] = [];
        if (op.u0 - a > 0.05) out.push([a, op.u0]);
        if (b - op.u1 > 0.05) out.push([op.u1, b]);
        return out;
      });
    }
    const color = shade(o.color, o.dice.range(0.9, 1.07));
    for (const [a, b] of cuts) {
      parts.push({ type: 'cylinder', from: at(f, a, 0, z), to: at(f, b, 0, z), radius: o.radius, segments: 8, color, surface: 'wood', caps: ends });
    }
  }
  return parts;
}

/**
 * Сплошная стена (обшивка, кирпич) с проёмами: стена режется на вертикальные полосы по краям проёмов,
 * в каждой полосе — куски между проёмами по высоте (окна этажей друг над другом, дверь под окном).
 */
export function solidWall(
  f: WallFrame,
  z0: number,
  height: number,
  thickness: number,
  openings: readonly Opening[],
  color: string,
  surface: Surface,
): BoxPart[] {
  const parts: BoxPart[] = [];
  const z1 = z0 + height;
  // Стена заходит на половину толщины за углы — углы закрыты.
  const start = -thickness / 2;
  const end = f.length + thickness / 2;
  const cuts = [start, end, ...openings.flatMap((op) => [op.u0, op.u1])].filter((u) => u >= start && u <= end);
  const edges = [...new Set(cuts.map((u) => Math.round(u * 1000) / 1000))].sort((a, b) => a - b);
  for (let i = 1; i < edges.length; i++) {
    const a = edges[i - 1]!;
    const b = edges[i]!;
    if (b - a < 0.01) continue;
    // Проёмы, перекрывающие всю полосу, — по высоте снизу вверх.
    const holes = openings
      .filter((op) => op.u0 <= a + 2e-3 && op.u1 >= b - 2e-3)
      .map((op) => [Math.max(z0, op.z0), Math.min(z1, op.z1)] as const)
      .filter(([lo, hi]) => hi > lo)
      .sort((p, q) => p[0] - q[0]);
    let z = z0;
    for (const [lo, hi] of holes) {
      if (lo - z > 0.01) parts.push(wallBox(f, (a + b) / 2, 0, (z + lo) / 2, [b - a, thickness, lo - z], color, surface));
      z = Math.max(z, hi);
    }
    if (z1 - z > 0.01) parts.push(wallBox(f, (a + b) / 2, 0, (z + z1) / 2, [b - a, thickness, z1 - z], color, surface));
  }
  return parts;
}

// --- окна и двери -------------------------------------------------------------------------------

export interface WindowStyle {
  /** Наличник и подоконная доска. */
  trim: string;
  /** Второй цвет резьбы (кокошник, подзор). */
  accent: string;
  /** Рамы и переплёт. */
  frame: string;
  /** Ставни (цвет) — или без них. */
  shutters?: string;
  /** Навершие наличника: кокошник, арка, простая доска, без наличника. */
  top: 'kokoshnik' | 'crown' | 'arch' | 'simple' | 'none';
  /** Резной подзор под подоконником. */
  apron: boolean;
  /** Переплёт: Т-образный (деревенский) или створки с форточкой (пластиковые). */
  sash: 'cross' | 'modern';
}

export interface WindowPlace {
  f: WallFrame;
  /** Середина окна вдоль стены. */
  u: number;
  /** Низ и размер проёма. */
  z0: number;
  w: number;
  h: number;
  /** Где лицо стены (наличник ложится сверху) и где стекло. */
  wallOut: number;
  glassOut: number;
  /** Откосы проёма (окосячка в срубе, откосы в кирпиче): глубина или 0. */
  reveal: number;
  revealColor?: string;
  dice: Dice;
}

/** Окно: стекло, рама и переплёт, наличник с резьбой, ставни. */
export function windowParts(p: WindowPlace, s: WindowStyle): HousePart[] {
  const { f, u, z0, w, h, wallOut: o } = p;
  const parts: HousePart[] = [];
  const zc = z0 + h / 2;
  parts.push({
    type: 'glass',
    center: at(f, u, p.glassOut, zc),
    size: [w, 0.02, h],
    angle: wallAngle(f),
    lit: p.dice.next(),
    curtain: p.dice.chance(0.8),
  });
  // Откосы: доски по краям проёма на всю толщину стены.
  if (p.reveal > 0) {
    const rc = p.revealColor ?? s.frame;
    const mid = (o + p.glassOut) / 2 - 0.01;
    const depth = o - p.glassOut + 0.02;
    parts.push(wallBox(f, u - w / 2 - 0.035, mid, zc, [0.07, depth, h + 0.07], rc));
    parts.push(wallBox(f, u + w / 2 + 0.035, mid, zc, [0.07, depth, h + 0.07], rc));
    parts.push(wallBox(f, u, mid, z0 - 0.035, [w + 0.14, depth, 0.07], rc));
    parts.push(wallBox(f, u, mid, z0 + h + 0.035, [w + 0.14, depth, 0.07], rc));
  }
  // Рама и переплёт.
  const g = p.glassOut + 0.025;
  parts.push(wallBox(f, u - w / 2 + 0.03, g, zc, [0.06, 0.04, h], s.frame));
  parts.push(wallBox(f, u + w / 2 - 0.03, g, zc, [0.06, 0.04, h], s.frame));
  parts.push(wallBox(f, u, g, z0 + 0.03, [w, 0.04, 0.06], s.frame));
  parts.push(wallBox(f, u, g, z0 + h - 0.03, [w, 0.04, 0.06], s.frame));
  if (s.sash === 'cross') {
    parts.push(wallBox(f, u, g, zc, [0.05, 0.035, h], s.frame));
    parts.push(wallBox(f, u, g, z0 + h * 0.68, [w, 0.035, 0.05], s.frame));
  } else {
    parts.push(wallBox(f, u - w * 0.12, g, zc, [0.07, 0.035, h], s.frame));
    parts.push(wallBox(f, u + w * 0.2, g, z0 + h * 0.72, [w * 0.62, 0.035, 0.05], s.frame));
  }
  if (s.top === 'none') return parts;

  // Наличник: боковые доски, подоконная доска, верхняя доска и навершие.
  parts.push(wallBox(f, u - w / 2 - 0.065, o + 0.018, zc + 0.02, [0.13, 0.036, h + 0.16], s.trim, 'wood'));
  parts.push(wallBox(f, u + w / 2 + 0.065, o + 0.018, zc + 0.02, [0.13, 0.036, h + 0.16], s.trim, 'wood'));
  parts.push(wallBox(f, u, o + 0.04, z0 - 0.05, [w + 0.4, 0.08, 0.07], s.trim));
  if (s.apron) {
    parts.push(
      wallSlab(
        f,
        o + 0.006,
        [
          [u - w / 2 + 0.03, z0 - 0.27],
          [u, z0 - 0.37],
          [u + w / 2 - 0.03, z0 - 0.27],
          [u + w / 2 + 0.13, z0 - 0.085],
          [u - w / 2 - 0.13, z0 - 0.085],
        ],
        0.03,
        s.accent,
      ),
    );
  }
  // Накладки вторым цветом на боковых досках — как на резных наличниках.
  if (s.top === 'kokoshnik' || s.top === 'crown') {
    for (const side of [-1, 1]) for (const z of [z0 + 0.14, z0 + h - 0.1]) parts.push(wallBox(f, u + side * (w / 2 + 0.065), o + 0.04, z, [0.075, 0.016, 0.11], s.accent));
  }
  const zt = z0 + h + 0.13;
  parts.push(wallBox(f, u, o + 0.045, zt, [w + 0.44, 0.09, 0.08], s.trim));
  const zb = zt + 0.04;
  if (s.top === 'kokoshnik') {
    const half = w / 2 + 0.2;
    parts.push(
      wallSlab(
        f,
        o + 0.012,
        [
          [u - half, zb],
          [u + half, zb],
          [u, zb + 0.3],
        ],
        0.03,
        s.accent,
      ),
    );
    parts.push(
      wallSlab(
        f,
        o + 0.026,
        [
          [u - half * 0.55, zb + 0.04],
          [u + half * 0.55, zb + 0.04],
          [u, zb + 0.2],
        ],
        0.02,
        s.trim,
      ),
    );
    // Карнизик по скатам навершия.
    parts.push(wallBox(f, u, o + 0.05, zb + 0.33, [0.16, 0.06, 0.05], s.trim));
  } else if (s.top === 'crown') {
    // «Корона»: цветная доска с белой дугой, карниз и три резных навершия.
    const half = w / 2 + 0.2;
    parts.push(wallSlab(f, o + 0.012, [[u - half, zb], [u + half, zb], [u + half * 0.86, zb + 0.17], [u - half * 0.86, zb + 0.17]], 0.03, s.accent));
    const arc: [number, number][] = [];
    for (let i = 0; i <= 6; i++) {
      const a = (i / 6) * Math.PI;
      arc.push([u + Math.cos(a) * half * 0.6, zb + 0.025 + Math.sin(a) * 0.11]);
    }
    parts.push(wallSlab(f, o + 0.026, arc, 0.02, s.trim));
    parts.push(wallBox(f, u, o + 0.055, zb + 0.195, [w + 0.5, 0.11, 0.05], s.trim));
    for (const [du, hw, hh] of [[0, 0.17, 0.24], [-half * 0.78, 0.1, 0.15], [half * 0.78, 0.1, 0.15]] as const) {
      const z = zb + 0.22;
      parts.push(wallSlab(f, o + 0.02, [[u + du - hw, z], [u + du + hw, z], [u + du + hw * 0.55, z + hh * 0.55], [u + du, z + hh], [u + du - hw * 0.55, z + hh * 0.55]], 0.025, s.trim));
    }
    parts.push(wallSlab(f, o + 0.032, [[u - 0.07, zb + 0.25], [u + 0.07, zb + 0.25], [u, zb + 0.37]], 0.012, s.accent));
  } else if (s.top === 'arch') {
    const half = w / 2 + 0.2;
    const arc: [number, number][] = [
      [u - half, zb],
      [u + half, zb],
    ];
    for (let i = 1; i < 10; i++) {
      const a = (i / 10) * Math.PI;
      arc.push([u + Math.cos(a) * half, zb + Math.sin(a) * half * 0.55]);
    }
    parts.push(wallSlab(f, o + 0.012, arc, 0.03, s.accent));
    parts.push(wallBox(f, u, o + 0.03, zb + half * 0.3, [0.12, 0.03, 0.12], s.trim));
  } else {
    parts.push(wallBox(f, u, o + 0.06, zb + 0.03, [w + 0.52, 0.12, 0.05], s.trim));
  }

  if (s.shutters) {
    const lw = w / 2 + 0.03;
    for (const side of [-1, 1]) {
      const uc = u + side * (w / 2 + 0.16 + lw / 2);
      parts.push(wallBox(f, uc, o + 0.03, zc, [lw, 0.035, h + 0.06], s.shutters, 'boards'));
      const a = lw * 0.3;
      const b = Math.min(h * 0.22, a * 1.5);
      parts.push(
        wallSlab(
          f,
          o + 0.048,
          [
            [uc, zc - b],
            [uc + a, zc],
            [uc, zc + b],
            [uc - a, zc],
          ],
          0.012,
          s.trim,
        ),
      );
    }
  }
  return parts;
}

/** Дверь: полотно из досок, коробка и наличник; ручка. */
export function doorParts(f: WallFrame, u: number, z0: number, w: number, h: number, wallOut: number, leafOut: number, color: string, trim: string): HousePart[] {
  const parts: HousePart[] = [];
  parts.push(wallBox(f, u, leafOut, z0 + h / 2, [w, 0.05, h], color, 'boards'));
  const depth = wallOut - leafOut + 0.04;
  const mid = (wallOut + leafOut) / 2;
  parts.push(wallBox(f, u - w / 2 - 0.04, mid, z0 + h / 2, [0.08, depth, h + 0.08], trim));
  parts.push(wallBox(f, u + w / 2 + 0.04, mid, z0 + h / 2, [0.08, depth, h + 0.08], trim));
  parts.push(wallBox(f, u, mid, z0 + h + 0.04, [w + 0.16, depth, 0.08], trim));
  parts.push(wallBox(f, u, wallOut + 0.03, z0 + h + 0.12, [w + 0.36, 0.06, 0.12], trim));
  parts.push(wallBox(f, u + w / 2 - 0.12, leafOut + 0.05, z0 + h * 0.48, [0.04, 0.05, 0.16], '#2b2b2b'));
  return parts;
}

// --- крыши --------------------------------------------------------------------------------------

/**
 * На какой высоте класть крышу (высота кровли над осью стены): стена доходит до top, её лицо — в outer
 * от оси; кровля над лицом стены должна пройти выше верха стены (иначе верхний венец или угол стены
 * протыкает свес).
 */
export function roofSeat(top: number, outer: number, pitch: number): number {
  return top + outer * Math.tan((pitch * Math.PI) / 180) + 0.04;
}

export interface GableRoof {
  parts: HousePart[];
  /** Высота конька и свеса. */
  ridge: number;
  eave: number;
  /** Высота кровли над точкой (x, y) (для труб). */
  heightAt: (x: number, y: number) => number;
}

/**
 * Двускатная крыша с коньком вдоль y над прямоугольником w × d (центр cx, cy); стены доходят до top.
 * side — свес на скатах, front/back — свесы над фронтонами.
 */
export function gableRoof(o: {
  w: number;
  d: number;
  cx?: number;
  cy?: number;
  top: number;
  pitch: number;
  side: number;
  front: number;
  back: number;
  color: string;
  surface: Surface;
  ridgeColor?: string;
}): GableRoof {
  const cx = o.cx ?? 0;
  const cy = o.cy ?? 0;
  const tan = Math.tan((o.pitch * Math.PI) / 180);
  const X = o.w / 2 + o.side;
  const rise = (o.w / 2) * tan;
  const ridge = o.top + rise;
  const eave = o.top - o.side * tan;
  const y0 = cy - o.d / 2 - o.front;
  const y1 = cy + o.d / 2 + o.back;
  const t = 0.05;
  const parts: HousePart[] = [
    slab(
      [
        [cx - X, y0, eave],
        [cx - X, y1, eave],
        [cx, y1, ridge],
        [cx, y0, ridge],
      ],
      [-1, 0, 1],
      t,
      o.color,
      o.surface,
    ),
    slab(
      [
        [cx + X, y1, eave],
        [cx + X, y0, eave],
        [cx, y0, ridge],
        [cx, y1, ridge],
      ],
      [1, 0, 1],
      t,
      o.color,
      o.surface,
    ),
    // Конёк (ящик без поворота: size[1] — вдоль y).
    { type: 'box', center: [cx, (y0 + y1) / 2, ridge + 0.02], size: [0.2, y1 - y0 + 0.04, 0.08], color: o.ridgeColor ?? shade(o.color, 0.85) },
  ];
  return {
    parts,
    ridge,
    eave,
    heightAt: (x) => ridge - Math.abs(x - cx) * tan,
  };
}

/** Фронтон под двускатной крышей: треугольник обшивки на стене, причелины, полотенце, слуховое окно. */
export function gableEnd(
  f: WallFrame,
  o: {
    top: number;
    ridge: number;
    out: number;
    /** Свес крыши над фронтоном и боковой свес — для причелин. */
    overhang: number;
    side: number;
    eave: number;
    color: string;
    surface: Surface;
    trim: string;
    towel: boolean;
    /** Цветная полоса-подзор под причелинами. */
    accent?: string;
  },
): HousePart[] {
  const L = f.length;
  const parts: HousePart[] = [
    wallSlab(
      f,
      o.out,
      [
        [0, o.top],
        [L, o.top],
        [L / 2, o.ridge - 0.04],
      ],
      0.05,
      o.color,
      o.surface,
    ),
  ];
  // Причелины — доски по кромке скатов, чуть ниже кровли.
  const out = o.out + o.overhang;
  const b = 0.2;
  parts.push(
    wallSlab(
      f,
      out,
      [
        [-o.side, o.eave - b],
        [L / 2, o.ridge - b],
        [L / 2, o.ridge],
        [-o.side, o.eave],
      ],
      0.04,
      o.trim,
      'wood',
    ),
  );
  parts.push(
    wallSlab(
      f,
      out,
      [
        [L / 2, o.ridge - b],
        [L + o.side, o.eave - b],
        [L + o.side, o.eave],
        [L / 2, o.ridge],
      ],
      0.04,
      o.trim,
      'wood',
    ),
  );
  if (o.accent) {
    const c = b + 0.11;
    parts.push(wallSlab(f, out - 0.012, [[-o.side, o.eave - c], [L / 2, o.ridge - c], [L / 2, o.ridge - b], [-o.side, o.eave - b]], 0.02, o.accent, 'wood'));
    parts.push(wallSlab(f, out - 0.012, [[L / 2, o.ridge - c], [L + o.side, o.eave - c], [L + o.side, o.eave - b], [L / 2, o.ridge - b]], 0.02, o.accent, 'wood'));
  }
  if (o.towel) {
    const u = L / 2;
    parts.push(
      wallSlab(
        f,
        out + 0.01,
        [
          [u - 0.1, o.ridge - 0.78],
          [u, o.ridge - 0.95],
          [u + 0.1, o.ridge - 0.78],
          [u + 0.1, o.ridge - 0.12],
          [u - 0.1, o.ridge - 0.12],
        ],
        0.04,
        o.trim,
        'wood',
      ),
    );
  }
  return parts;
}

/**
 * Водоотлив — узкий скат поперёк фасада в основании фронтона: закрывает стык стены и фронтона,
 * отводит воду от окон. Концы уходят под скаты крыши. Возвращает высоту, с которой начинается фронтон.
 */
export function pentRoof(
  f: WallFrame,
  o: { top: number; out: number; reach: number; side: number; eave: number; pitch: number; color: string; surface: Surface; trim: string },
): { parts: HousePart[]; top: number } {
  const L = f.length;
  const tan = Math.tan((o.pitch * Math.PI) / 180);
  const zi = o.top + 0.3;
  const zo = o.top + 0.07;
  // Где скат крыши проходит выше кромок водоотлива.
  const under = (z: number) => Math.max(-o.side, (z + 0.03 - o.eave) / tan - o.side);
  const ui = under(zi);
  const uo = under(zo);
  const n = outward(f);
  const parts: HousePart[] = [
    slab([at(f, uo, o.out + o.reach, zo), at(f, L - uo, o.out + o.reach, zo), at(f, L - ui, o.out, zi), at(f, ui, o.out, zi)], [n[0] * 0.5, n[1] * 0.5, 1], 0.04, o.color, o.surface),
    wallBox(f, L / 2, o.out + o.reach - 0.03, zo - 0.07, [L - 2 * uo - 0.04, 0.03, 0.11], o.trim, 'wood'),
  ];
  return { parts, top: zi + 0.02 };
}

/**
 * Убранство фронтона: «ёлочка» из цветных полос (stripes) или пояс с белыми планками в основании (belt).
 * base — низ убранства (над водоотливом), top — где фронтон начинается на стене.
 */
export function gableDecor(
  f: WallFrame,
  o: { kind: 'stripes' | 'belt'; top: number; base: number; ridge: number; out: number; color: string; trim: string },
): HousePart[] {
  const L = f.length;
  const apex = o.ridge - 0.04;
  const H = apex - o.base;
  const hw = ((L / 2) * H) / (apex - o.top);
  const u = L / 2;
  const parts: HousePart[] = [];
  if (H < 0.6) return parts;
  if (o.kind === 'stripes') {
    for (const [a, b] of [[0.88, 0.74], [0.6, 0.46], [0.32, 0.18]] as const) {
      for (const side of [-1, 1]) {
        parts.push(wallSlab(f, o.out + 0.02, [[u + side * a * hw, o.base], [u + side * b * hw, o.base], [u, o.base + b * H], [u, o.base + a * H]], 0.02, o.color, 'boards'));
      }
    }
    return parts;
  }
  const h = 0.2;
  const len = 2 * hw * (1 - h / H) - 0.16;
  parts.push(wallBox(f, u, o.out + 0.012, o.base + h / 2, [len, 0.024, h], o.color, 'boards'));
  const count = Math.max(3, Math.round(len / 0.32));
  for (let i = 0; i < count; i++) parts.push(wallBox(f, u + ((i + 0.5) / count - 0.5) * len, o.out + 0.03, o.base + h / 2, [0.11, 0.016, h - 0.06], o.trim));
  parts.push(wallBox(f, u, o.out + 0.035, o.base + h + 0.02, [len + 0.1, 0.05, 0.04], o.trim, 'wood'));
  return parts;
}

export interface HipRoof {
  parts: HousePart[];
  ridge: number;
  eave: number;
  heightAt: (x: number, y: number) => number;
}

/** Вальмовая (четырёхскатная) крыша над прямоугольником w × d; конёк вдоль длинной стороны. */
export function hipRoof(o: { w: number; d: number; top: number; pitch: number; overhang: number; color: string; surface: Surface; ridgeColor?: string }): HipRoof {
  const tan = Math.tan((o.pitch * Math.PI) / 180);
  const swap = o.d > o.w;
  // Считаем для конька вдоль x, потом при необходимости поворачиваем на 90°.
  const W = swap ? o.d : o.w;
  const D = swap ? o.w : o.d;
  const X = W / 2 + o.overhang;
  const Y = D / 2 + o.overhang;
  const eave = o.top - o.overhang * tan;
  const rise = Y * tan;
  const ridge = eave + rise;
  const rx = Math.max(0, X - Y);
  const rot = (p: Vec3): Vec3 => (swap ? [-p[1], p[0], p[2]] : p);
  const rotN = (p: Vec3): Vec3 => (swap ? [-p[1], p[0], p[2]] : p);
  const t = 0.05;
  const color = o.color;
  const parts: HousePart[] = [];
  const add = (pts: Vec3[], facing: Vec3) => parts.push(slab(pts.map(rot), rotN(facing), t, color, o.surface));
  add(
    [
      [-X, -Y, eave],
      [X, -Y, eave],
      [rx, 0, ridge],
      [-rx, 0, ridge],
    ],
    [0, -1, 1],
  );
  add(
    [
      [X, Y, eave],
      [-X, Y, eave],
      [-rx, 0, ridge],
      [rx, 0, ridge],
    ],
    [0, 1, 1],
  );
  add(
    [
      [X, -Y, eave],
      [X, Y, eave],
      [rx, 0, ridge],
    ],
    [1, 0, 1],
  );
  add(
    [
      [-X, Y, eave],
      [-X, -Y, eave],
      [-rx, 0, ridge],
    ],
    [-1, 0, 1],
  );
  const ridgeColor = o.ridgeColor ?? shade(color, 0.85);
  // Конёк и рёбра вальм — накладные планки.
  if (rx > 0.01) parts.push({ type: 'cylinder', from: rot([-rx, 0, ridge + 0.02]), to: rot([rx, 0, ridge + 0.02]), radius: 0.07, segments: 6, color: ridgeColor });
  for (const [sx, sy] of [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ] as const) {
    parts.push({ type: 'cylinder', from: rot([sx * X, sy * Y, eave + 0.02]), to: rot([sx * rx, 0, ridge + 0.02]), radius: 0.05, segments: 6, color: ridgeColor });
  }
  const heightAt = (x: number, y: number) => {
    const [lx, ly] = swap ? [y, -x] : [x, y];
    const fromSide = Y - Math.abs(ly);
    const fromEnd = X - Math.abs(lx);
    return eave + Math.min(fromSide, fromEnd) * tan;
  };
  return { parts, ridge, eave, heightAt };
}

/** Односкатная крыша: верхний край a0–a1, нижний b0–b1 (параллельно). */
export function leanToRoof(a0: Vec3, a1: Vec3, b1: Vec3, b0: Vec3, color: string, surface: Surface): SlabPart {
  return slab([b0, b1, a1, a0], [0, 0, 1], 0.05, color, surface);
}

// --- прочее -------------------------------------------------------------------------------------

/** Кирпичная труба над крышей: ствол, оголовок, колпак. */
export function chimney(x: number, y: number, from: number, to: number, color: string): HousePart[] {
  return [
    { type: 'box', center: [x, y, (from + to) / 2], size: [0.5, 0.5, to - from], color, surface: 'brick' },
    { type: 'box', center: [x, y, to + 0.04], size: [0.64, 0.64, 0.08], color: shade(color, 0.9), surface: 'brick' },
    { type: 'box', center: [x, y, to + 0.32], size: [0.6, 0.6, 0.04], color: '#55595c' },
    { type: 'box', center: [x - 0.24, y - 0.24, to + 0.2], size: [0.04, 0.04, 0.24], color: '#55595c' },
    { type: 'box', center: [x + 0.24, y + 0.24, to + 0.2], size: [0.04, 0.04, 0.24], color: '#55595c' },
  ];
}

/** Металлическая труба (баня, котёл) с зонтиком. */
export function pipe(x: number, y: number, from: number, to: number): HousePart[] {
  return [
    { type: 'cylinder', from: [x, y, from], to: [x, y, to], radius: 0.1, segments: 10, color: '#6d7174' },
    { type: 'cylinder', from: [x, y, to + 0.08], to: [x, y, to + 0.3], radius: 0.26, radiusTop: 0.02, segments: 10, color: '#5b5f62' },
  ];
}

/** Козырёк крыльца: двускатный с фронтончиком (верх столбов — z) или односкатный от стены (high → low). */
export type Canopy = false | { kind: 'gable'; z: number } | { kind: 'lean'; high: number; low: number };

/** Крыльцо у стены: площадка, ступени, столбики и козырёк. */
export function porch(
  f: WallFrame,
  o: { u: number; width: number; depth: number; floor: number; wallOut: number; canopy: Canopy; wood: string; roof: string; roofSurface: Surface; trim: string },
): HousePart[] {
  const parts: HousePart[] = [];
  const { u, width, depth, floor, wallOut } = o;
  // Площадка и обшитое основание.
  parts.push(wallBox(f, u, wallOut + depth / 2, floor - 0.04, [width, depth, 0.08], o.wood, 'boards'));
  parts.push(wallBox(f, u, wallOut + depth / 2, (floor - 0.08) / 2, [width - 0.06, depth - 0.06, floor - 0.08], shade(o.wood, 0.8), 'boards'));
  // Ступени.
  const n = Math.max(1, Math.round(floor / 0.18));
  const step = floor / n;
  for (let k = 1; k < n; k++) {
    const top = floor - k * step;
    parts.push(wallBox(f, u, wallOut + depth + 0.28 * (k - 0.5), top / 2, [width - 0.12, 0.28, top], o.wood, 'boards'));
  }
  if (o.canopy === false) return parts;
  const out1 = wallOut + depth + 0.15;
  const e = width / 2 + 0.18;
  if (o.canopy.kind === 'lean') {
    const { high, low } = o.canopy;
    const postOut = wallOut + depth - 0.06;
    const postTop = high + ((postOut - wallOut) / (out1 - wallOut)) * (low - high) - 0.06;
    for (const side of [-1, 1]) {
      parts.push(wallBox(f, u + side * (width / 2 - 0.06), postOut, (floor + postTop) / 2, [0.1, 0.1, postTop - floor], o.trim));
    }
    parts.push(wallBox(f, u, postOut, postTop - 0.05, [width, 0.08, 0.1], o.trim));
    parts.push(slab([at(f, u - e, wallOut, high), at(f, u + e, wallOut, high), at(f, u + e, out1, low), at(f, u - e, out1, low)], [0, 0, 1], 0.04, o.roof, o.roofSurface));
    return parts;
  }
  const zc = o.canopy.z;
  for (const side of [-1, 1]) {
    parts.push(wallBox(f, u + side * (width / 2 - 0.06), wallOut + depth - 0.06, (floor + zc) / 2, [0.1, 0.1, zc - floor], o.trim));
  }
  parts.push(wallBox(f, u, wallOut + depth - 0.06, zc - 0.06, [width, 0.08, 0.12], o.trim));
  const rise = 0.42;
  const tx = f.tx;
  const ty = f.ty;
  parts.push(
    slab(
      [at(f, u - e, wallOut, zc), at(f, u - e, out1, zc), at(f, u, out1, zc + rise), at(f, u, wallOut, zc + rise)],
      [-tx, -ty, 1],
      0.04,
      o.roof,
      o.roofSurface,
    ),
  );
  parts.push(
    slab(
      [at(f, u + e, wallOut, zc), at(f, u + e, out1, zc), at(f, u, out1, zc + rise), at(f, u, wallOut, zc + rise)],
      [tx, ty, 1],
      0.04,
      o.roof,
      o.roofSurface,
    ),
  );
  parts.push(
    wallSlab(
      f,
      out1 - 0.02,
      [
        [u - e + 0.08, zc - 0.01],
        [u + e - 0.08, zc - 0.01],
        [u, zc + rise - 0.05],
      ],
      0.03,
      o.trim,
      'boards',
    ),
  );
  return parts;
}

/** Цоколь под стенами. */
export function plinth(w: number, d: number, h: number, color: string, cx = 0, cy = 0): BoxPart {
  return { type: 'box', center: [cx, cy, h / 2], size: [w, d, h], color, surface: 'plaster' };
}

/**
 * Дом для дальнего плана (от ~140 м — доска наличника там в пиксель): без рам и переплётов, досок
 * наличников, мелкой резьбы и накладок; брёвна и трубы — с вдвое меньшим числом граней. Стены, крыши,
 * стёкла (вечером они светятся) и ставни остаются.
 */
export function simplifyParts(parts: readonly HousePart[]): HousePart[] {
  return parts.flatMap((p): HousePart[] => {
    if (p.type === 'box') {
      const [a, b, c] = [...p.size].sort((x, y) => x - y);
      if (a! < 0.07 && (b! < 0.07 || c! < 0.7)) return [];
      // Мелкие ящики (доски наличников, подоконники, накладки) — меньше 0,015 м³ и не длиннее 1,6 м.
      return a! * b! * c! < 0.015 && c! < 1.6 ? [] : [p];
    }
    if (p.type === 'slab') {
      // Мелкая резьба (кокошники, подзоры, ромбы на ставнях) — меньше 0,25 м².
      const n = polygonNormal(p.points);
      return Math.hypot(n[0], n[1], n[2]) / 2 < 0.25 ? [] : [p];
    }
    if (p.type === 'cylinder') {
      const segments = Math.max(4, Math.round((p.segments ?? 12) / 2));
      return [{ ...p, segments }];
    }
    if (p.type === 'blob') {
      // Мелкие кустики и цветы вдали не видны; крупные — грубее.
      return Math.max(...p.radii) < 0.3 ? [] : [{ ...p, detail: 0 }];
    }
    return [p];
  });
}

// --- надписи и флаги ------------------------------------------------------------------------------

/** Табличка на стене: середина (u, z), лицом наружу, чуть отступив от лица стены out. */
export function wallSign(f: WallFrame, u: number, out: number, z: number, w: number, h: number, text: string, background: string, color: string): HousePart[] {
  return [
    wallBox(f, u, out + 0.02, z, [w + 0.08, 0.04, h + 0.08], shade(background, 0.7)),
    { type: 'sign', center: at(f, u, out + 0.045, z), size: [w, 0.01, h], angle: wallAngle(f), text, background, color },
  ];
}

export type FlagKind = 'bashkortostan' | 'russia';

/** Флаг: полосы сверху вниз; у Башкортостана посередине — жёлтый цветок курая. */
const FLAG_STRIPES: Record<FlagKind, string[]> = {
  bashkortostan: ['#0a66b3', '#f4f4f2', '#0c9a4a'],
  russia: ['#f4f4f2', '#1c4fa0', '#d52b1e'],
};

/** Флагшток с флагом, развёрнутым вдоль angle (рад от оси x), основание в (x, y, z). */
export function flagpole(x: number, y: number, z: number, height: number, kind: FlagKind, angle = 0): HousePart[] {
  const parts: HousePart[] = [
    { type: 'cylinder', from: [x, y, z], to: [x, y, z + height], radius: 0.045, segments: 8, color: '#c9ccd0' },
    { type: 'cylinder', from: [x, y, z + height], to: [x, y, z + height + 0.08], radius: 0.07, segments: 8, color: '#d8b04a' },
    { type: 'box', center: [x, y, z + 0.25], size: [0.4, 0.4, 0.5], color: '#9d9a92', surface: 'plaster' },
  ];
  const w = 1.5;
  const h = 1.0;
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const cx = x + dx * (w / 2 + 0.05);
  const cy = y + dy * (w / 2 + 0.05);
  FLAG_STRIPES[kind].forEach((color, i) => {
    parts.push({ type: 'box', center: [cx, cy, z + height - 0.1 - h / 6 - (i * h) / 3], size: [w, 0.02, h / 3], angle, color });
  });
  if (kind === 'bashkortostan') {
    // Курай: жёлтый кружок с «лепестками» посередине белой полосы.
    const zc = z + height - 0.1 - h / 2;
    const nx = -dy * 0.016;
    const ny = dx * 0.016;
    parts.push({ type: 'cylinder', from: [cx - nx, cy - ny, zc], to: [cx + nx, cy + ny, zc], radius: 0.11, segments: 12, color: '#e8b923' });
  }
  return parts;
}

/** Повернуть детали вокруг вертикали через (0, 0) на angle (рад, против часовой). */
/** Зеркальное отражение деталей слева направо (x → −x): веранда и крыльцо переезжают на другую сторону дома. */
export function mirrorPartsX(parts: readonly HousePart[]): HousePart[] {
  const m = (p: Vec3): Vec3 => [-p[0], p[1], p[2]];
  return parts.map((p): HousePart => {
    if (p.type === 'cylinder') return { ...p, from: m(p.from), to: m(p.to) };
    // У плиты лицевая сторона — по обходу: после отражения обход разворачиваем.
    if (p.type === 'slab') return { ...p, points: p.points.map(m).reverse() };
    return { ...p, center: m(p.center), ...('angle' in p && p.angle !== undefined ? { angle: -p.angle } : {}) } as HousePart;
  });
}

export function rotatePartsZ(parts: readonly HousePart[], angle: number): HousePart[] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const r = (p: Vec3): Vec3 => [p[0] * c - p[1] * s, p[0] * s + p[1] * c, p[2]];
  return parts.map((p): HousePart => {
    if (p.type === 'cylinder') return { ...p, from: r(p.from), to: r(p.to) };
    if (p.type === 'slab') return { ...p, points: p.points.map(r) };
    return { ...p, center: r(p.center), angle: (p.angle ?? 0) + angle };
  });
}
