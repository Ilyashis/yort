// Спорт и отдых в деревне: футбольное поле, спортивная площадка, детская площадка. Те же правила, что у
// домов: x — вдоль улицы, улица — со стороны −y, центр — в начале координат, z — от земли. Покрытие —
// плитой от земли (на склоне уходит вниз, как цоколь), разметка — тонкими полосами поверх.

import { Dice, shade, slab, type BoxPart, type CylinderPart, type HousePart, type Surface, type Vec3 } from './houseParts';
import type { HouseModel, HouseOptions, HousePlan } from './houseModels';
import { clamp, finish, rect, withGround } from './modelKit';

const box = (center: Vec3, size: Vec3, color: string, surface?: Surface, angle?: number): BoxPart => ({
  type: 'box',
  center,
  size,
  color,
  ...(surface ? { surface } : {}),
  ...(angle ? { angle } : {}),
});
const cyl = (from: Vec3, to: Vec3, radius: number, color: string, segments = 8): CylinderPart => ({ type: 'cylinder', from, to, radius, color, segments });

const LINE = '#f4f4ee';
const LINE_W = 0.12;

/** Полоса разметки от a до b на высоте z. */
function stripe(a: [number, number], b: [number, number], z: number, color = LINE, width = LINE_W): BoxPart {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  return box([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, z], [len + width, width, 0.01], color, undefined, Math.atan2(b[1] - a[1], b[0] - a[0]));
}

/** Прямоугольник разметкой. */
function frame(x0: number, y0: number, x1: number, y1: number, z: number, color = LINE): BoxPart[] {
  return [
    stripe([x0, y0], [x1, y0], z, color),
    stripe([x1, y0], [x1, y1], z, color),
    stripe([x1, y1], [x0, y1], z, color),
    stripe([x0, y1], [x0, y0], z, color),
  ];
}

/** Окружность (или дуга от a0 до a1) разметкой. */
function circle(cx: number, cy: number, r: number, z: number, a0 = 0, a1 = Math.PI * 2, n = 28, color = LINE): BoxPart[] {
  const out: BoxPart[] = [];
  for (let k = 0; k < n; k++) {
    const t0 = a0 + ((a1 - a0) * k) / n;
    const t1 = a0 + ((a1 - a0) * (k + 1)) / n;
    out.push(stripe([cx + r * Math.cos(t0), cy + r * Math.sin(t0)], [cx + r * Math.cos(t1), cy + r * Math.sin(t1)], z, color, LINE_W * 0.9));
  }
  return out;
}

/** Сетчатый забор (рабица) по отрезку: столбы, верх и низ, проволока рядами. gap — проход посередине, м. */
function meshFence(a: [number, number], b: [number, number], h: number, color: string, gap = 0): HousePart[] {
  const parts: HousePart[] = [];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const u: [number, number] = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
  const p = (s: number): [number, number] => [a[0] + u[0] * s, a[1] + u[1] * s];
  const spans: [number, number][] = gap > 0 ? [[0, (len - gap) / 2], [(len + gap) / 2, len]] : [[0, len]];
  const wire = shade(color, 1.25);
  for (const [s0, s1] of spans) {
    if (s1 - s0 < 0.3) continue;
    const n = Math.max(1, Math.round((s1 - s0) / 3));
    for (let k = 0; k <= n; k++) {
      const [x, y] = p(s0 + ((s1 - s0) * k) / n);
      parts.push(cyl([x, y, 0], [x, y, h], 0.04, color, 6));
    }
    for (const z of [0.12, h - 0.03]) parts.push(stripeAt(p(s0), p(s1), z, 0.05, 0.05, color));
    for (let z = 0.4; z < h - 0.1; z += 0.3) parts.push(stripeAt(p(s0), p(s1), z, 0.012, 0.012, wire));
  }
  return parts;
}

/** Тонкая перекладина от a до b на высоте z (сечение w × h). */
function stripeAt(a: [number, number], b: [number, number], z: number, w: number, h: number, color: string): BoxPart {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  return box([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, z], [len, w, h], color, undefined, Math.atan2(b[1] - a[1], b[0] - a[0]));
}

/** Скамейка: сиденье и спинка на ножках, вдоль оси x (angle — поворот), спинкой к +y. */
function bench(x: number, y: number, angle: number, length = 2, wood = '#8a6a48'): HousePart[] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const p = (u: number, v: number, z: number): Vec3 => [x + u * c - v * s, y + u * s + v * c, z];
  const parts: HousePart[] = [box(p(0, 0, 0.45), [length, 0.4, 0.05], wood, 'wood', angle), box(p(0, 0.2, 0.75), [length, 0.05, 0.3], wood, 'wood', angle)];
  for (const u of [-length / 2 + 0.2, length / 2 - 0.2]) parts.push(box(p(u, 0.05, 0.22), [0.06, 0.4, 0.44], '#3b3b3b', undefined, angle));
  return parts;
}

// --- футбольное поле ------------------------------------------------------------------------------

/** Ворота: штанги и перекладина белые, сетка — частыми нитями назад. x — линия ворот, dir — внутрь поля (±1). */
function goal(x: number, dir: number, width: number, height: number): HousePart[] {
  const parts: HousePart[] = [];
  const back = x - dir * 1.6;
  const net = '#e2e4e0';
  for (const y of [-width / 2, width / 2]) {
    parts.push(cyl([x, y, 0], [x, y, height], 0.06, '#ffffff'));
    parts.push(cyl([back, y, 0], [back, y, height * 0.6], 0.025, '#c9ccc8', 6));
    parts.push(cyl([x, y, height], [back, y, height * 0.6], 0.025, '#c9ccc8', 6));
  }
  parts.push(cyl([x, -width / 2, height], [x, width / 2, height], 0.06, '#ffffff'));
  // Сетка: задняя стенка и бока — нитями.
  for (let k = 0; k <= Math.round(width / 0.5); k++) {
    const y = -width / 2 + (width * k) / Math.round(width / 0.5);
    parts.push(cyl([back, y, 0.02], [back, y, height * 0.6], 0.008, net, 3));
    parts.push(cyl([x, y, height], [back, y, height * 0.6], 0.008, net, 3));
  }
  for (let z = 0.3; z < height * 0.6; z += 0.45) parts.push(cyl([back, -width / 2, z], [back, width / 2, z], 0.008, net, 3));
  return parts;
}

function planFootball(o: HouseOptions): HousePlan {
  const dice = new Dice((o.seed ?? 1) + 31000);
  const W = clamp(o.width ?? 60, 30, 100);
  const D = clamp(o.depth ?? 40, 20, 70);
  const parts: HousePart[] = [];
  const grass = dice.pick(['#4f8f3c', '#5a9a42', '#4a8644', '#5f9548']);
  const T = 0.06;
  parts.push(box([0, 0, T / 2], [W, D, T], grass, 'grass'));
  // Полосы стрижки поперёк поля.
  const bands = Math.max(6, Math.round(W / 6));
  for (let k = 0; k < bands; k += 2) parts.push(box([-W / 2 + ((k + 0.5) * W) / bands, 0, T + 0.002], [W / bands, D - 0.2, 0.004], shade(grass, 1.1), 'grass'));
  // Разметка (поле — с отступом от края покрытия), над полосами стрижки.
  const z = T + 0.012;
  const m = Math.min(3, W * 0.04);
  const L = W / 2 - m;
  const H = D / 2 - m;
  parts.push(...frame(-L, -H, L, H, z));
  parts.push(stripe([0, -H], [0, H], z));
  const r = Math.min(9.15, H * 0.4);
  parts.push(...circle(0, 0, r, z));
  parts.push(box([0, 0, z], [0.3, 0.3, 0.01], LINE));
  const pd = Math.min(16.5, L * 0.32);
  const pw = Math.min(40.3, H * 2 * 0.62);
  const gd = Math.min(5.5, L * 0.11);
  const gw = Math.min(18.3, H * 2 * 0.3);
  for (const side of [-1, 1]) {
    const x = side * L;
    parts.push(...frame(Math.min(x, x - side * pd), -pw / 2, Math.max(x, x - side * pd), pw / 2, z));
    parts.push(...frame(Math.min(x, x - side * gd), -gw / 2, Math.max(x, x - side * gd), gw / 2, z));
    parts.push(box([x - side * pd * 0.67, 0, z], [0.25, 0.25, 0.01], LINE));
    parts.push(...circle(x - side * pd * 0.67, 0, r, z, side > 0 ? Math.PI * 0.7 : -Math.PI * 0.3, side > 0 ? Math.PI * 1.3 : Math.PI * 0.3, 10));
    parts.push(...goal(x, side, Math.min(7.32, pw * 0.35), Math.min(2.44, 1.6 + W * 0.012)));
    // Угловые флажки.
    for (const y of [-H, H]) {
      parts.push(cyl([x, y, 0], [x, y, 1.5], 0.02, '#f2f2ec', 5));
      parts.push(box([x - side * 0.2, y, 1.35], [0.35, 0.01, 0.25], dice.pick(['#e5372b', '#f2c21b'])));
    }
  }
  // Скамейки запасных и зрителей — по дальней от улицы стороне.
  for (const x of [-6, 6]) parts.push(...bench(x, D / 2 - 0.9, 0, 3));
  if (W > 45) for (const x of [-W / 4, W / 4]) parts.push(...bench(x, D / 2 - 0.9, 0, 4, '#4d6f93'));
  // Сетка за воротами (чтобы мяч не улетал) — у большинства деревенских полей.
  if (dice.chance(0.7)) {
    const h = 4;
    const color = '#3f6b4f';
    for (const side of [-1, 1]) parts.push(...meshFence([side * (W / 2 - 0.3), -Math.min(H, 12)], [side * (W / 2 - 0.3), Math.min(H, 12)], h, color));
  }
  return finish('football', parts, W, D, rect(W, D));
}

// --- спортивная площадка -------------------------------------------------------------------------

/** Баскетбольная стойка: столб, вынос, щит, кольцо. x — у края, dir — к центру площадки. */
function hoop(x: number, dir: number, pole: string): HousePart[] {
  const parts: HousePart[] = [cyl([x, 0, 0], [x, 0, 3.4], 0.08, pole)];
  const board = x + dir * 1.0;
  parts.push(box([x + dir * 0.5, 0, 3.3], [1.0, 0.08, 0.08], pole));
  parts.push(box([board, 0, 3.4], [0.05, 1.8, 1.05], '#f6f6f2'));
  parts.push(box([board + dir * 0.03, 0, 3.3], [0.01, 0.59, 0.45], '#d8462a'));
  const ring = board + dir * 0.38;
  for (let k = 0; k < 12; k++) {
    const t0 = (k / 12) * Math.PI * 2;
    const t1 = ((k + 1) / 12) * Math.PI * 2;
    parts.push(stripeAt([ring + 0.23 * Math.cos(t0), 0.23 * Math.sin(t0)], [ring + 0.23 * Math.cos(t1), 0.23 * Math.sin(t1)], 3.05, 0.02, 0.02, '#e5672b'));
  }
  return parts;
}

function planSportsGround(o: HouseOptions): HousePlan {
  const dice = new Dice((o.seed ?? 1) + 32000);
  const W = clamp(o.width ?? 24, 14, 40);
  const D = clamp(o.depth ?? 16, 10, 30);
  const parts: HousePart[] = [];
  const surface = dice.pick(['#b5523b', '#a8483a', '#3f7d5a', '#3d6e8f']);
  const T = 0.08;
  parts.push(box([0, 0, T / 2], [W, D, T], surface, 'felt'));
  const z = T + 0.006;
  const L = W / 2 - 1;
  const H = D / 2 - 1;
  parts.push(...frame(-L, -H, L, H, z));
  parts.push(stripe([0, -H], [0, H], z));
  parts.push(...circle(0, 0, Math.min(1.8, H * 0.3), z));
  const pole = dice.pick(['#2f5f8f', '#3a3a3a', '#2f7a4a']);
  for (const side of [-1, 1]) {
    // Трёхочковая дуга и штрафная — упрощённо.
    parts.push(...circle(side * L, 0, Math.min(6.75, H * 0.9), z, side > 0 ? Math.PI / 2 : -Math.PI / 2, side > 0 ? (Math.PI * 3) / 2 : Math.PI / 2, 16));
    parts.push(...frame(Math.min(side * L, side * (L - 5.8)), -2.45, Math.max(side * L, side * (L - 5.8)), 2.45, z));
    parts.push(...hoop(side * (L + 0.4), -side, pole));
  }
  // Спортивный уголок у задней стороны: турники трёх высот и брусья.
  const metal = '#5b5f63';
  const bx = -W / 2 + 2.5;
  const by = D / 2 + 1.6;
  for (const [k, h] of [
    [0, 1.6],
    [1, 2.1],
    [2, 2.5],
  ] as const) {
    const x = bx + k * 1.4;
    parts.push(cyl([x, by, 0], [x, by, h], 0.04, metal, 6));
    parts.push(cyl([x + 1.2, by, 0], [x + 1.2, by, h], 0.04, metal, 6));
    parts.push(cyl([x, by, h], [x + 1.2, by, h], 0.02, '#c9ccc8', 6));
  }
  const px = bx + 5.6;
  for (const y of [by - 0.3, by + 0.3]) {
    for (const x of [px, px + 2.2]) parts.push(cyl([x, y, 0], [x, y, 1.3], 0.035, metal, 6));
    parts.push(cyl([px, y, 1.3], [px + 2.2, y, 1.3], 0.025, '#c9ccc8', 6));
  }
  // Рабица кругом, вход — с улицы.
  const fence = dice.pick(['#2f6f4a', '#3a3f45', '#2f5f8f']);
  const h = dice.chance(0.5) ? 3 : 2.2;
  const x0 = -W / 2 + 0.2;
  const x1 = W / 2 - 0.2;
  const y0 = -D / 2 + 0.2;
  const y1 = D / 2 + 0.2;
  parts.push(...meshFence([x0, y0], [x1, y0], h, fence, 1.6));
  parts.push(...meshFence([x1, y0], [x1, y1 - 0.2], h, fence));
  parts.push(...meshFence([x1, y1 - 0.2], [x0, y1 - 0.2], h, fence));
  parts.push(...meshFence([x0, y1 - 0.2], [x0, y0], h, fence));
  // Лавка у входа.
  parts.push(...bench(-3, -D / 2 - 1.2, Math.PI, 2));
  return finish('sportsground', parts, W, D, rect(W, D));
}

// --- детская площадка ----------------------------------------------------------------------------

const BRIGHT = ['#e5372b', '#f2c21b', '#2f7fd0', '#2fa35a', '#f07c1e', '#8e4fc2'];

/** Качели: А-образные стойки, перекладина, две доски на цепях. */
function swings(x: number, y: number, dice: Dice): HousePart[] {
  const parts: HousePart[] = [];
  const frameColor = dice.pick(BRIGHT);
  const span = 3.2;
  const h = 2.3;
  for (const sx of [x - span / 2, x + span / 2]) {
    parts.push(cyl([sx, y - 0.8, 0], [sx, y, h], 0.05, frameColor, 6));
    parts.push(cyl([sx, y + 0.8, 0], [sx, y, h], 0.05, frameColor, 6));
  }
  parts.push(cyl([x - span / 2, y, h], [x + span / 2, y, h], 0.05, frameColor, 6));
  for (const sx of [x - 0.75, x + 0.75]) {
    for (const d of [-0.22, 0.22]) parts.push(cyl([sx + d, y, 0.45], [sx + d, y, h], 0.01, '#8a8f86', 3));
    parts.push(box([sx, y, 0.45], [0.55, 0.22, 0.04], dice.pick(BRIGHT), 'wood'));
  }
  return parts;
}

/** Горка: площадка с крышей, лесенка, скат наружу (по +x). */
function slide(x: number, y: number, dice: Dice): HousePart[] {
  const parts: HousePart[] = [];
  const post = dice.pick(BRIGHT);
  const top = 1.4;
  for (const [dx, dy] of [
    [-0.6, -0.6],
    [0.6, -0.6],
    [0.6, 0.6],
    [-0.6, 0.6],
  ] as const)
    parts.push(cyl([x + dx, y + dy, 0], [x + dx, y + dy, top + 1.3], 0.05, post, 6));
  parts.push(box([x, y, top], [1.3, 1.3, 0.08], '#9a7a52', 'wood'));
  // Крыша-шатёр плоской плитой (лицом вверх).
  const roof = dice.pick(BRIGHT);
  parts.push(box([x, y, top + 1.33], [1.6, 1.6, 0.08], roof));
  parts.push(box([x, y, top + 1.5], [0.9, 0.9, 0.26], roof));
  // Перила.
  for (const dy of [-0.65, 0.65]) parts.push(box([x - 0.05, y + dy, top + 0.5], [1.2, 0.05, 0.06], post));
  // Лесенка назад (−x).
  for (let k = 1; k <= 4; k++) parts.push(box([x - 0.7 - k * 0.22, y, (top * k) / 5], [0.2, 0.6, 0.05], '#9a7a52', 'wood'));
  for (const dy of [-0.32, 0.32]) parts.push(cyl([x - 1.65, y + dy, 0], [x - 0.65, y + dy, top + 0.6], 0.03, post, 6));
  // Скат: плита от площадки вниз по +x — лицом вверх-наружу.
  const color = dice.pick(['#2f7fd0', '#e5372b', '#f2c21b', '#2fa35a']);
  const x0 = x + 0.65;
  const x1 = x + 3.3;
  parts.push(
    slab(
      [
        [x0, y - 0.3, top],
        [x1, y - 0.3, 0.25],
        [x1, y + 0.3, 0.25],
        [x0, y + 0.3, top],
      ],
      [top - 0.25, 0, x1 - x0],
      0.05,
      color,
    ),
  );
  for (const dy of [-0.33, 0.33]) parts.push(cyl([x0, y + dy, top + 0.2], [x1, y + dy, 0.45], 0.025, color, 5));
  parts.push(cyl([x1 - 0.1, y, 0], [x1 - 0.1, y, 0.25], 0.04, post, 6));
  return parts;
}

function planPlayground(o: HouseOptions): HousePlan {
  const dice = new Dice((o.seed ?? 1) + 33000);
  const W = clamp(o.width ?? 16, 10, 30);
  const D = clamp(o.depth ?? 12, 8, 24);
  const parts: HousePart[] = [];
  const rubber = dice.chance(0.5);
  const T = 0.06;
  parts.push(box([0, 0, T / 2], [W, D, T], rubber ? dice.pick(['#c0563f', '#3f8a5a', '#3d6e8f']) : '#d9c08a', rubber ? 'felt' : 'dirt'));
  parts.push(...swings(-W / 4, D / 4, dice));
  parts.push(...slide(W / 8, -D / 6, dice));
  // Песочница с бортиком и грибком.
  const sx = -W / 4 - 0.5;
  const sy = -D / 4;
  const wood = dice.pick(['#c7a46a', '#9a7a52', '#e0b04a']);
  parts.push(box([sx, sy, T + 0.05], [2, 2, 0.1], '#e6d3a1', 'dirt'));
  for (const [dx, dy, w, d] of [
    [0, -1, 2.2, 0.15],
    [0, 1, 2.2, 0.15],
    [-1, 0, 0.15, 2.2],
    [1, 0, 0.15, 2.2],
  ] as const)
    parts.push(box([sx + dx, sy + dy, 0.17], [w, d, 0.34], wood, 'wood'));
  parts.push(cyl([sx, sy, 0], [sx, sy, 1.8], 0.06, wood, 6));
  parts.push({ type: 'cylinder', from: [sx, sy, 1.75], to: [sx, sy, 2.3], radius: 1.1, radiusTop: 0.05, segments: 10, color: dice.pick(BRIGHT), caps: false });
  // Карусель.
  const cx = W / 4 + 1;
  const cy = D / 4;
  parts.push(cyl([cx, cy, 0], [cx, cy, 0.35], 0.12, '#5b5f63', 8));
  parts.push({ type: 'cylinder', from: [cx, cy, 0.33], to: [cx, cy, 0.4], radius: 1.0, segments: 16, color: dice.pick(BRIGHT) });
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2;
    parts.push(cyl([cx + 0.75 * Math.cos(a), cy + 0.75 * Math.sin(a), 0.4], [cx + 0.75 * Math.cos(a), cy + 0.75 * Math.sin(a), 1.0], 0.025, '#d8d8d2', 5));
    parts.push(cyl([cx + 0.75 * Math.cos(a), cy + 0.75 * Math.sin(a), 1.0], [cx, cy, 1.0], 0.025, '#d8d8d2', 5));
  }
  // Качалки на пружине.
  for (const [dx, color] of [
    [-1, dice.pick(BRIGHT)],
    [1, dice.pick(BRIGHT)],
  ] as const) {
    const x = W / 2 - 2.2 + dx * 0.9;
    const y = -D / 2 + 2;
    parts.push(cyl([x, y, 0], [x, y, 0.35], 0.07, '#8a8f86', 6));
    parts.push({ type: 'blob', center: [x, y, 0.6], radii: [0.45, 0.2, 0.28], color, detail: 0 });
  }
  // Скамейки для родителей — у задней стороны.
  parts.push(...bench(-W / 6, D / 2 - 0.7, 0, 2), ...bench(W / 6, D / 2 - 0.7, 0, 2));
  // Низкий заборчик-штакетник кругом, вход с улицы.
  const fence = dice.pick(['#2f68b0', '#3d8a58', '#e7e2d4', '#f2c21b']);
  const pick = (a: [number, number], b: [number, number], gap = 0) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const u = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    const angle = Math.atan2(u[1]!, u[0]!);
    const n = Math.round(len / 0.25);
    for (let k = 0; k <= n; k++) {
      const s = (len * k) / n;
      if (gap && Math.abs(s - len / 2) < gap / 2) continue;
      parts.push(box([a[0] + u[0]! * s, a[1] + u[1]! * s, 0.4], [0.08, 0.03, 0.8], fence, 'wood', angle));
    }
    for (const z of [0.25, 0.6]) {
      const spans = gap ? [[0, len / 2 - gap / 2], [len / 2 + gap / 2, len]] : [[0, len]];
      for (const [s0, s1] of spans) parts.push(stripeAt([a[0] + u[0]! * s0!, a[1] + u[1]! * s0!], [a[0] + u[0]! * s1!, a[1] + u[1]! * s1!], z, 0.03, 0.06, shade(fence, 0.85)));
    }
  };
  const e = 0.1;
  pick([-W / 2 + e, -D / 2 + e], [W / 2 - e, -D / 2 + e], 1.4);
  pick([W / 2 - e, -D / 2 + e], [W / 2 - e, D / 2 - e]);
  pick([W / 2 - e, D / 2 - e], [-W / 2 + e, D / 2 - e]);
  pick([-W / 2 + e, D / 2 - e], [-W / 2 + e, -D / 2 + e]);
  return finish('playground', parts, W, D, rect(W, D));
}

export const SPORT_MODELS: HouseModel[] = [
  {
    id: 'football',
    group: 'leisure',
    name: 'Футбольное поле',
    short: 'Футбол',
    summary: 'газон · ворота с сеткой',
    description: 'Деревенское футбольное поле: газон с полосами стрижки, разметка (центр, штрафные, вратарские), ворота с сеткой, угловые флажки, скамейки вдоль дальней стороны и сетка за воротами.',
    width: { min: 30, value: 60, max: 100 },
    depth: { min: 20, value: 40, max: 70 },
    plan: withGround(planFootball),
  },
  {
    id: 'sportsground',
    group: 'leisure',
    name: 'Спортивная площадка',
    short: 'Спортплощадка',
    summary: 'покрытие · баскетбол · турники',
    description: 'Школьная спортплощадка: резиновое покрытие с разметкой, две баскетбольные стойки, турники трёх высот и брусья, ограждение-рабица со входом с улицы.',
    width: { min: 14, value: 24, max: 40 },
    depth: { min: 10, value: 16, max: 30 },
    plan: withGround(planSportsGround),
  },
  {
    id: 'playground',
    group: 'leisure',
    name: 'Детская площадка',
    short: 'Детская',
    summary: 'качели · горка · песочница',
    description: 'Детская площадка: качели на двоих, горка с домиком и лесенкой, песочница с грибком, карусель, качалки на пружинах, скамейки для родителей и низкий заборчик кругом.',
    width: { min: 10, value: 16, max: 30 },
    depth: { min: 8, value: 12, max: 24 },
    plan: withGround(planPlayground),
  },
];
