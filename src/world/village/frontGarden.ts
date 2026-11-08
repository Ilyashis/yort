// Палисадник перед деревенским домом: прозрачный штакетник от стены до улицы и сад за ним —
// клумбы с цветами, кусты (бывает сирень), живая изгородь, деревца (берёза, рябина, яблоня),
// иногда лавочка у забора со стороны улицы.
// Оси палисадника: x — вдоль фасада (0 — середина), y — от стены дома (0) к улице (−depth), z — вверх.
// Без движка: только части (ящики, цилиндры, эллипсоиды), как у моделей домов.

import { Dice, mixColor, shade, type BlobPart, type BoxPart, type HousePart, type Vec3 } from './houseParts';

export type GardenStyle = 'flowers' | 'hedge' | 'tree' | 'orchard';

export interface FrontGardenOptions {
  width: number;
  depth: number;
  seed: number;
  /** Вдали: штакетник — сплошной полосой, без мелких цветов. */
  far?: boolean;
  /** Подобрать именно этот сад (в мастерской); иначе — по зерну. */
  style?: GardenStyle;
}

export interface FrontGarden {
  parts: HousePart[];
  style: GardenStyle;
}

/** Цвета штакетника: зелёный, бирюзовый, синий, голубой, белый, коричневый. */
const FENCE_COLORS = ['#3d8a58', '#2f8f88', '#2f68b0', '#5f9fcf', '#ece8dc', '#7a5a3e', '#4a9a4f'];
const FLOWERS = ['#d8352f', '#efc531', '#e57fb0', '#f3f0e8', '#8d5bc4', '#ec8a35', '#5b7fd6'];
const LEAVES = ['#5b8f3e', '#6a9a45', '#4f8237', '#76a64e'];
const DIRT = '#6b4f3a';

const PICKET = { width: 0.075, thick: 0.022, step: 0.155, lift: 0.08, tip: 0.11 };
const POST = { size: 0.09, every: 2.2 };

const box = (center: Vec3, size: Vec3, color: string, angle = 0, surface?: BoxPart['surface']): BoxPart => ({
  type: 'box',
  center,
  size,
  angle,
  color,
  ...(surface ? { surface } : {}),
});
const blob = (center: Vec3, radii: Vec3, color: string, detail: 0 | 1 = 1, angle = 0): BlobPart => ({ type: 'blob', center, radii, color, detail, angle });

interface FenceLook {
  color: string;
  /** Через один — второй цвет. */
  second?: string;
  /** Белые кончики. */
  tips?: string;
  /** Верх волной между столбами. */
  wave: boolean;
  height: number;
}

export function planFrontGarden(o: FrontGardenOptions): FrontGarden {
  const dice = new Dice(o.seed * 31 + 7);
  const W = Math.max(o.width, 1);
  const D = Math.max(o.depth, 0.3);
  const color = dice.pick(FENCE_COLORS);
  const fence: FenceLook = {
    color,
    second: dice.chance(0.2) ? dice.pick(FENCE_COLORS.filter((c) => c !== color && c !== '#ece8dc')) : undefined,
    tips: color !== '#ece8dc' && dice.chance(0.4) ? '#f1eee6' : undefined,
    wave: dice.chance(0.25),
    height: dice.range(1.0, 1.25),
  };
  const parts: HousePart[] = [];

  // Штакетник: спереди по улице и два бока — от улицы до стены.
  const corners: [number, number][] = [
    [-W / 2, -0.05],
    [-W / 2, -D],
    [W / 2, -D],
    [W / 2, -0.05],
  ];
  for (let i = 1; i < corners.length; i++) fenceRun(parts, corners[i - 1]!, corners[i]!, fence, !!o.far);

  let style: GardenStyle = o.style ?? pickStyle(dice, W, D);
  if (style === 'orchard' && (D < 2.4 || W < 5)) style = 'tree';
  if (style === 'tree' && D < 1.8) style = 'flowers';
  if (D < 0.9) return { parts, style };

  // Сад внутри: от забора отступ 0,25 м, от стены — 0,35 м.
  const x0 = -W / 2 + 0.25;
  const x1 = W / 2 - 0.25;
  const yStreet = -D + 0.25;
  const yWall = -0.35;
  const palette = [dice.pick(FLOWERS), dice.pick(FLOWERS), dice.pick(FLOWERS)];
  const bedDepth = Math.min(0.75, (yWall - yStreet) * 0.45);
  // У каждого элемента сада — свои «кости»: вблизи и вдали (где мелочь пропускаем) сад одинаковый.
  const own = (k: number) => new Dice(o.seed * 31 + 100 + k);
  const sideOf = dice.chance(0.5) ? -1 : 1;
  const both = dice.chance(0.45);
  const kind = dice.pick(['birch', 'rowan', 'apple'] as const);

  const far = !!o.far;
  if (style === 'flowers') {
    flowerBed(parts, x0, x1, yStreet, bedDepth, palette, own(1), far);
    if (D >= 1.8) tallFlowers(parts, x0 + 1.2, x1 - 1.2, yWall - 0.35, own(4), far);
    if (D >= 1.6) for (const side of both ? [-1, 1] : [sideOf]) shrub(parts, side < 0 ? x0 : x1, side, yWall, own(2 + side), far, true);
  } else if (style === 'hedge') {
    hedge(parts, x0, x1, yStreet, own(1), far);
    if (D >= 1.7) flowerBed(parts, x0 + 0.4, x1 - 0.4, yWall - bedDepth, bedDepth * 0.8, palette, own(2), far);
  } else if (style === 'tree') {
    const side = sideOf;
    tree(parts, side * (W / 2 - 1.3), D, kind, own(1), far);
    // Клумба — на другой половине, у забора; у стены за деревом — куст.
    flowerBed(parts, side < 0 ? 0.2 : x0, side < 0 ? x1 : -0.2, yStreet, bedDepth, palette, own(2), far);
    if (D >= 2.2 && W >= 5) shrub(parts, side < 0 ? x1 : x0, -side, yWall, own(3), far, false);
  } else {
    // Садик: две яблони у широкого дома, у узкого — одна посередине и цветы вдоль забора.
    const xs = W >= 8 ? [-W / 4, W / 4] : [0];
    xs.forEach((x, k) => tree(parts, x, D, 'apple', own(1 + k), far));
    if (xs.length === 1) flowerBed(parts, x0, x1, yStreet, bedDepth * 0.8, palette, own(3), far);
  }

  // Глубокий палисадник (дом далеко от улицы): посередине ещё деревце или пара кустов.
  if (D >= 3.8 && style !== 'orchard') {
    const extra = own(5);
    const xMid = -sideOf * extra.range(0, W / 6);
    if (style === 'tree') {
      for (const dx of [-0.9, 0.9]) shrub(parts, xMid + dx + (dx < 0 ? -0.8 : 0.8), dx < 0 ? -1 : 1, -D / 2 + 0.6, extra, far, true);
    } else {
      tree(parts, xMid, D, extra.pick(['birch', 'rowan', 'apple'] as const), extra, far);
    }
  }

  // Лавочка у забора со стороны улицы.
  const bench = own(9);
  if (!far && bench.chance(0.3) && W >= 3) {
    const bx = bench.range(-W / 2 + 1, W / 2 - 1);
    const wood = bench.pick(['#8a6a48', '#6f8f5a', '#5d7fa0', '#9a7a52']);
    parts.push(box([bx, -D - 0.42, 0.44], [1.5, 0.36, 0.05], wood));
    parts.push(box([bx, -D - 0.26, 0.7], [1.5, 0.04, 0.22], wood));
    for (const dx of [-0.6, 0.6]) parts.push(box([bx + dx, -D - 0.42, 0.21], [0.07, 0.3, 0.42], shade(wood, 0.75)));
  }
  return { parts, style };
}

function pickStyle(dice: Dice, W: number, D: number): GardenStyle {
  const r = dice.next();
  if (r < 0.35) return 'flowers';
  if (r < 0.55) return 'hedge';
  if (r < 0.85 || W < 6 || D < 2.4) return 'tree';
  return 'orchard';
}

/** Забор вдоль отрезка a→b: столбы, две прожилины (с внутренней стороны) и штакетины с просветами. */
function fenceRun(parts: HousePart[], a: [number, number], b: [number, number], look: FenceLook, far: boolean): void {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  if (length < 0.2) return;
  const ux = dx / length;
  const uy = dy / length;
  const angle = Math.atan2(uy, ux);
  // Внутрь сада — влево от направления обхода.
  const ix = -uy;
  const iy = ux;
  const at = (t: number, inward: number, z: number): Vec3 => [a[0] + ux * t + ix * inward, a[1] + uy * t + iy * inward, z];
  const H = look.height;
  const postColor = shade(look.color, 0.78);

  if (far) {
    // Издали штакетины сливаются: полупрозрачный на вид забор — светлее и ниже настоящего.
    parts.push(box(at(length / 2, 0, (H * 0.85) / 2), [length, 0.04, H * 0.85], mixColor(look.color, '#c7d1a5', 0.35), angle));
    return;
  }

  const spans = Math.max(1, Math.ceil(length / POST.every));
  const span = length / spans;
  for (let k = 0; k <= spans; k++) parts.push(box(at(k * span, 0.04, (H + 0.08) / 2), [POST.size, POST.size, H + 0.08], postColor, angle));
  for (const z of [0.32, H - 0.24]) parts.push(box(at(length / 2, 0.04, z), [length, 0.035, 0.07], postColor, angle));

  const count = Math.floor(length / PICKET.step);
  const offset = (length - (count - 1) * PICKET.step) / 2;
  for (let i = 0; i < count; i++) {
    const t = offset + i * PICKET.step;
    // У столбов штакетину не ставим — там столб.
    const nearPost = Math.abs(t / span - Math.round(t / span)) * span < 0.06;
    if (nearPost) continue;
    const inSpan = (t % span) / span;
    const h = look.wave ? H - 0.14 + 0.2 * Math.sin(Math.PI * inSpan) : H;
    const color = look.second && i % 2 ? look.second : look.color;
    const body = look.tips ? h - PICKET.lift - PICKET.tip : h - PICKET.lift;
    parts.push(box(at(t, 0, PICKET.lift + body / 2), [PICKET.width, PICKET.thick, body], color, angle));
    if (look.tips) parts.push(box(at(t, 0, h - PICKET.tip / 2), [PICKET.width, PICKET.thick, PICKET.tip], look.tips, angle));
  }
}

/** Клумба вдоль забора: земля и кустики цветов (зелень и шапка цветов), ряд или два. */
function flowerBed(parts: HousePart[], x0: number, x1: number, y0: number, depth: number, palette: string[], dice: Dice, far: boolean): void {
  const L = x1 - x0;
  if (L < 0.6 || depth < 0.3) return;
  const cy = y0 + depth / 2;
  parts.push(box([(x0 + x1) / 2, cy, 0.03], [L, depth, 0.07], DIRT, 0, 'dirt'));
  if (far) {
    parts.push(box([(x0 + x1) / 2, cy, 0.16], [L - 0.1, depth - 0.1, 0.22], mixColor(palette[0]!, '#5b8f3e', 0.35)));
    return;
  }
  const rows = depth >= 0.6 ? 2 : 1;
  const step = 0.42;
  const n = Math.max(1, Math.floor(L / step));
  for (let r = 0; r < rows; r++) {
    const y = rows === 1 ? cy : y0 + depth * (r === 0 ? 0.28 : 0.72);
    for (let i = 0; i < n; i++) {
      const x = x0 + (L / n) * (i + 0.5) + (r ? step / 2 : 0) * (i < n - 1 ? 1 : 0);
      const color = palette[Math.floor(i / 2 + r) % palette.length]!;
      const s = dice.range(0.85, 1.15);
      parts.push(blob([x, y, 0.2 * s], [0.22 * s, 0.22 * s, 0.2 * s], dice.pick(['#4c7f39', '#558a3e']), 0));
      parts.push(blob([x, y, 0.42 * s], [0.19 * s, 0.19 * s, 0.11 * s], color, 0));
    }
  }
}

/** Высокие цветы у стены: «золотые шары», мальвы, флоксы — зелёный куст и шапки цветов наверху. */
function tallFlowers(parts: HousePart[], x0: number, x1: number, y: number, dice: Dice, far: boolean): void {
  const L = x1 - x0;
  if (L < 0.8) return;
  const color = dice.pick(['#f1c232', '#e88bb5', '#f3f0e8', '#c470c9', '#e8573f']);
  const n = Math.max(2, Math.round(L / 1.6));
  for (let i = 0; i < n; i++) {
    const x = x0 + (L / (n - 1 || 1)) * i;
    const h = dice.range(1.0, 1.5);
    parts.push(blob([x, y, h * 0.47], [0.34, 0.3, h * 0.47], '#4f8a3a', far ? 0 : 1));
    // Шапки цветов — по верху куста, наполовину в листве (кости тянем и вдали — чтобы сад совпадал).
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + dice.next();
      const ring = k === 3 ? 0 : 0.17;
      if (!far) parts.push(blob([x + Math.cos(a) * ring, y + Math.sin(a) * ring * 0.9, h * (k === 3 ? 0.92 : 0.8)], [0.15, 0.15, 0.12], color, 0));
    }
  }
}

/** Куст у стены в углу (side — к какому краю): круглый, иногда цветущая сирень. */
function shrub(parts: HousePart[], xEdge: number, side: number, yWall: number, dice: Dice, far: boolean, lilacAllowed: boolean): void {
  const rx = dice.range(0.55, 0.85);
  const ry = dice.range(0.5, 0.7);
  const rz = dice.range(0.6, 0.95);
  const x = xEdge - side * rx;
  const y = yWall - ry;
  const green = dice.pick(LEAVES);
  parts.push(blob([x, y, rz * 0.92], [rx, ry, rz], green, far ? 0 : 1, dice.range(0, Math.PI)));
  // Цветущая сирень; кости тянем и вдали — чтобы следующие кусты стояли там же.
  const lilac = dice.chance(0.35);
  const bloom = dice.pick(['#b48ad6', '#c9a3e3', '#f2efe6']);
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + dice.next();
    const z = rz * (1.25 + dice.range(-0.15, 0.2));
    if (!far && lilacAllowed && lilac) parts.push(blob([x + Math.cos(a) * rx * 0.7, y + Math.sin(a) * ry * 0.7, z], [0.2, 0.2, 0.17], bloom, 0));
  }
}

/** Подстриженная живая изгородь вдоль забора. */
function hedge(parts: HousePart[], x0: number, x1: number, y0: number, dice: Dice, far: boolean): void {
  const L = x1 - x0;
  const n = Math.max(1, Math.round(L / 1.1));
  const color = dice.pick(['#4f8a3a', '#5a9142', '#477f35']);
  const h = dice.range(0.42, 0.55);
  for (let i = 0; i < n; i++) {
    const x = x0 + (L / n) * (i + 0.5);
    parts.push(blob([x, y0 + 0.32, h], [L / n / 2 + 0.22, 0.32, h], color, far ? 0 : 1));
  }
}

/** Деревце в палисаднике: ствол и крона, крона не залезает в стену (но может свеситься за забор). */
function tree(parts: HousePart[], x: number, D: number, kind: 'birch' | 'rowan' | 'apple', dice: Dice, far: boolean): void {
  const detail = far ? 0 : 1;
  const spec =
    kind === 'birch'
      ? { trunk: '#e9e6dc', r: 0.09, h: dice.range(2.6, 3.4), crown: [1.0, 1.0, 1.6] as Vec3, color: '#8fbf5a' }
      : kind === 'rowan'
        ? { trunk: '#6e5a4a', r: 0.08, h: dice.range(1.8, 2.2), crown: [1.1, 1.1, 1.2] as Vec3, color: '#6c9e45' }
        : { trunk: '#6b5040', r: 0.1, h: dice.range(1.5, 1.8), crown: [1.1, 1.1, 0.9] as Vec3, color: '#5f9440' };
  const s = Math.min(1, (D + 0.6) / 3.2) * dice.range(0.9, 1.1);
  const crown: Vec3 = [spec.crown[0] * s, spec.crown[1] * s, spec.crown[2] * s];
  const y = Math.max(Math.min(-D / 2, -(crown[1] + 0.15)), -D + 0.3);
  const zc = spec.h * s + crown[2] * 0.75;
  parts.push({ type: 'cylinder', from: [x, y, 0], to: [x, y, zc], radius: spec.r, radiusTop: spec.r * 0.6, segments: far ? 5 : 7, color: spec.trunk, caps: false });
  // Чёрные чёрточки на бересте (кости тянем у любого дерева и вдали — сад вблизи и вдали один).
  for (let k = 0; k < 4; k++) {
    const z = 0.4 + k * 0.55 + dice.range(0, 0.2);
    const a = dice.range(0, Math.PI);
    if (kind === 'birch' && !far) parts.push(box([x, y, z], [spec.r * 2.05, spec.r * 2.05, 0.05], '#3a3632', a));
  }
  parts.push(blob([x, y, zc], crown, spec.color, detail, dice.range(0, Math.PI)));
  // Вторая шапка кроны — объёмнее и неровнее.
  if (!far) parts.push(blob([x + crown[0] * 0.35, y + crown[1] * 0.1, zc + crown[2] * 0.45], [crown[0] * 0.65, crown[1] * 0.65, crown[2] * 0.55], shade(spec.color, 1.08), detail));
  const apples = dice.chance(0.6);
  const appleColor = dice.pick(['#c8392b', '#d9b23a']);
  const fruit = kind === 'rowan' ? '#d4442c' : kind === 'apple' && apples ? appleColor : undefined;
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + dice.next();
    const z = zc + dice.range(-0.3, 0.3) * crown[2];
    if (fruit && !far) parts.push(blob([x + Math.cos(a) * crown[0] * 0.9, y + Math.sin(a) * crown[1] * 0.9, z], [0.1, 0.1, 0.1], fruit, 0));
  }
}

/** Сдвинуть детали на (dx, dy) — поставить палисадник перед фасадом дома. */
export function shiftParts(parts: readonly HousePart[], dx: number, dy: number): HousePart[] {
  const m = (p: Vec3): Vec3 => [p[0] + dx, p[1] + dy, p[2]];
  return parts.map((p): HousePart => {
    if (p.type === 'cylinder') return { ...p, from: m(p.from), to: m(p.to) };
    if (p.type === 'slab') return { ...p, points: p.points.map(m) };
    return { ...p, center: m(p.center) };
  });
}
