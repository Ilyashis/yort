// Детали посёлка из частей (как у моделей домов): заборы по ломаной разных видов, ворота с калиткой,
// поленница, ульи, стог, будка, лавочка, компостный ящик. Координаты — локальные метры посёлка (x — восток,
// y — север), z — от земли под самой деталью: слой ставит каждую деталь на землю в её точке, так забор на
// склоне идёт ступеньками. far — дальний план: без мелких планок, штакетник — сплошной полосой.

import type { EstateGate, EstateProp, FenceRun, FenceStyle } from './estates';
import { Dice, rotatePartsZ, shade, slab, type BoxPart, type HousePart, type Surface, type Vec3 } from './houseParts';
import type { Vec2 } from '../walk/localFrame';

/** Шаг столбов, м. */
const SPAN: Record<FenceStyle, number> = {
  boards: 2.5,
  metal: 2.8,
  picket: 2.4,
  slats: 2.5,
  rails: 3,
};
/** Низ забора уходит в землю на столько: на склоне он не повисает. */
const SINK = 0.15;

const box = (center: Vec3, size: Vec3, angle: number, color: string, surface?: Surface): BoxPart => ({
  type: 'box',
  center,
  size,
  angle,
  color,
  ...(surface ? { surface } : {}),
});

/** Куски ломаной без вырезов: [начало, конец, направление] по каждому отрезку. */
function pieces(line: readonly Vec2[], cuts: readonly [number, number][]): { a: Vec2; b: Vec2 }[] {
  const out: { a: Vec2; b: Vec2 }[] = [];
  let s0 = 0;
  for (let k = 1; k < line.length; k++) {
    const p = line[k - 1]!;
    const q = line[k]!;
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (len < 1e-6) continue;
    const at = (s: number): Vec2 => [p[0] + ((q[0] - p[0]) * (s - s0)) / len, p[1] + ((q[1] - p[1]) * (s - s0)) / len];
    let from = s0;
    for (const [c0, c1] of cuts) {
      if (c1 <= from || c0 >= s0 + len) continue;
      if (c0 > from + 0.3) out.push({ a: at(from), b: at(c0) });
      from = Math.max(from, c1);
    }
    if (s0 + len > from + 0.3) out.push({ a: at(from), b: at(s0 + len) });
    s0 += len;
  }
  return out;
}

/** Забор вдоль ломаной: пролёты между столбами, у каждого вида свой рисунок. */
export function fenceParts(run: FenceRun, far: boolean): HousePart[] {
  const parts: HousePart[] = [];
  const H = run.height;
  const color = run.color;
  const post = shade(color, run.style === 'metal' ? 0.55 : 0.72);
  const dice = new Dice(run.seed);
  for (const { a, b } of pieces(run.line, run.cuts)) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const u: Vec2 = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    const angle = Math.atan2(u[1], u[0]);
    const count = Math.max(1, Math.ceil(len / SPAN[run.style]));
    const step = len / count;
    for (let k = 0; k <= count; k++) {
      const p: Vec2 = [a[0] + u[0] * step * k, a[1] + u[1] * step * k];
      if (run.style === 'rails') {
        if (!far || k % 2 === 0 || k === count)
          parts.push({
            type: 'cylinder',
            from: [p[0], p[1], -SINK],
            to: [p[0], p[1], H + 0.1],
            radius: 0.06,
            segments: far ? 3 : 6,
            color: post,
            surface: 'wood',
            caps: false,
          });
      } else if (!far || k % 2 === 0 || k === count)
        parts.push(
          box(
            [p[0], p[1], (H + 0.15 - SINK) / 2],
            [run.style === 'metal' ? 0.07 : 0.1, run.style === 'metal' ? 0.07 : 0.1, H + 0.15 + SINK],
            angle,
            post,
            run.style === 'metal' ? undefined : 'wood',
          ),
        );
    }
    for (let k = 0; k < count; k++) {
      const mid: Vec2 = [a[0] + u[0] * step * (k + 0.5), a[1] + u[1] * step * (k + 0.5)];
      const span = step - 0.02;
      switch (run.style) {
        case 'boards':
          parts.push(box([mid[0], mid[1], (H - SINK) / 2], [span, 0.04, H + SINK], angle, shade(color, dice.range(0.95, 1.04)), 'boards'));
          if (!far) parts.push(box([mid[0], mid[1], H + 0.02], [span + 0.02, 0.08, 0.05], angle, shade(color, 0.85), 'wood'));
          break;
        case 'metal':
          parts.push(box([mid[0], mid[1], (H - SINK) / 2], [span, 0.025, H + SINK], angle, color, 'metal'));
          break;
        case 'picket':
        case 'slats': {
          const width = run.style === 'picket' ? 0.08 : 0.13;
          const gap = run.style === 'picket' ? 0.065 : dice.range(0.06, 0.12);
          if (far) {
            parts.push(box([mid[0], mid[1], (H * 0.92 - SINK) / 2], [span, 0.03, H * 0.92 + SINK], angle, shade(color, 0.92), 'boards'));
            break;
          }
          // Две поперечины (со стороны двора — за ними не видно) и планки.
          for (const z of [0.3, H - 0.3]) parts.push(box([mid[0], mid[1], z], [span, 0.05, 0.08], angle, shade(color, 0.8), 'wood'));
          const n = Math.max(1, Math.floor(span / (width + gap)));
          const pitch = span / n;
          for (let i = 0; i < n; i++) {
            const s = -span / 2 + pitch * (i + 0.5);
            const h = H - (run.style === 'slats' ? dice.range(0, 0.15) : 0);
            parts.push(
              box([mid[0] + u[0] * s, mid[1] + u[1] * s, (h - SINK) / 2], [width, 0.022, h + SINK], angle, shade(color, dice.range(0.92, 1.06)), 'wood'),
            );
          }
          break;
        }
        case 'rails':
          for (const z of far ? [0.45, 0.95] : [0.35, 0.75, 1.1]) {
            const from: Vec3 = [mid[0] - (u[0] * step) / 2, mid[1] - (u[1] * step) / 2, z];
            const to: Vec3 = [mid[0] + (u[0] * step) / 2, mid[1] + (u[1] * step) / 2, z];
            parts.push({
              type: 'cylinder',
              from,
              to,
              radius: 0.04,
              segments: far ? 3 : 5,
              color: shade(color, dice.range(0.92, 1.08)),
              surface: 'wood',
              caps: false,
            });
          }
          break;
      }
    }
  }
  return parts;
}

/**
 * Ворота с калиткой: столбы, две створки, калитка со стороны дома; у части дворов над воротами —
 * двускатный козырёк на перекладине (как у старых башкирских дворов).
 */
export function gateParts(gate: EstateGate, height: number, far: boolean): HousePart[] {
  const { at, along: u, inward, gate: G, wicket: Wk, wicketSide } = gate;
  const angle = Math.atan2(u[1], u[0]);
  const H = Math.max(height, 1.6) + 0.15;
  const post = shade(gate.color, gate.style === 'metal' ? 0.5 : 0.7);
  const surface: Surface = gate.style === 'metal' ? 'metal' : 'boards';
  const total = G ? G + 0.2 + Wk : Wk;
  const pos = (s: number, z: number, out = 0): Vec3 => [at[0] + u[0] * s + inward[0] * out, at[1] + u[1] * s + inward[1] * out, z];
  const parts: HousePart[] = [];
  // Раскладка по along: калитка — на конце wicketSide, ворота — на другом.
  const wEnd = (wicketSide * total) / 2;
  const wMid = wEnd - wicketSide * (Wk / 2);
  const postTop = H + (gate.canopy ? 0.55 : 0.25);
  // Столбы: по краям проёма и между калиткой и воротами.
  const posts = G ? [wEnd, wEnd - wicketSide * (Wk + 0.1), -wEnd] : [wEnd, -wEnd];
  for (const s of posts) parts.push(box(pos(s, (postTop - SINK) / 2), [0.18, 0.18, postTop + SINK], angle, post, gate.style === 'metal' ? undefined : 'wood'));
  // Калитка.
  parts.push(box(pos(wMid, H / 2 + 0.04), [Wk - 0.08, 0.05, H - 0.08], angle, shade(gate.color, 1.04), surface));
  if (!far) parts.push(box(pos(wMid - wicketSide * (Wk / 2 - 0.15), 1.0, -0.04), [0.04, 0.05, 0.12], angle, '#2b2b2b'));
  // Створки ворот.
  if (G) {
    const gMid = -wEnd + wicketSide * (G / 2);
    for (const k of [-1, 1]) {
      parts.push(box(pos(gMid + (k * G) / 4, H / 2 + 0.06), [G / 2 - 0.05, 0.05, H - 0.04], angle, gate.color, surface));
      if (!far && gate.style !== 'metal') {
        for (const z of [0.4, H - 0.35]) parts.push(box(pos(gMid + (k * G) / 4, z, 0.04), [G / 2 - 0.1, 0.04, 0.1], angle, shade(gate.color, 0.82), 'wood'));
      }
    }
    if (!far) parts.push(box(pos(gMid, 1.05, -0.05), [0.5, 0.04, 0.06], angle, '#2f2f2f'));
  }
  if (gate.canopy) {
    // Перекладина по столбам и двускатный козырёк вдоль забора.
    parts.push(box(pos(0, postTop + 0.06), [total + 0.4, 0.2, 0.14], angle, post, 'wood'));
    const z0 = postTop + 0.13;
    const ridge = z0 + 0.45;
    const half = total / 2 + 0.45;
    const roof = gate.style === 'metal' ? gate.color : shade(gate.color, 0.7);
    for (const side of [-1, 1]) {
      const eave = 0.65 * side;
      parts.push(
        slab(
          [pos(-half, z0, eave), pos(half, z0, eave), pos(half, ridge, 0), pos(-half, ridge, 0)],
          [inward[0] * side, inward[1] * side, 1],
          0.04,
          roof,
          gate.style === 'metal' ? 'metal' : 'boards',
        ),
      );
    }
  }
  return parts;
}

/** Мелочь двора в своих осях (перед — к −y), повёрнутая и поставленная в точку. */
export function propParts(prop: EstateProp, far: boolean): HousePart[] {
  const dice = new Dice(prop.seed);
  const local: HousePart[] = [];
  switch (prop.kind) {
    case 'woodpile': {
      const L = prop.length;
      const wood = dice.pick(['#b48a5a', '#a87f52', '#bf9864']);
      local.push(box([0, 0, 0.65], [L, 0.6, 1.3], 0, wood, 'endgrain'));
      if (!far) {
        local.push(
          slab(
            [
              [-L / 2 - 0.15, -0.45, 1.42],
              [L / 2 + 0.15, -0.45, 1.42],
              [L / 2 + 0.15, 0.42, 1.58],
              [-L / 2 - 0.15, 0.42, 1.58],
            ],
            [0, 0, 1],
            0.03,
            dice.pick(['#8f9392', '#7a6a58', '#5a3e32']),
            'slate',
          ),
        );
        for (const x of [-L / 2, L / 2]) local.push(box([x, 0.3, 0.78], [0.08, 0.08, 1.56], 0, '#6b5a48', 'wood'));
      }
      break;
    }
    case 'beehive': {
      const paint = dice.pick(['#4f86b8', '#e2b23a', '#3c9255', '#e9e4d6', '#c8463a', '#86b4d4']);
      local.push(
        box([0, 0, 0.17], [0.42, 0.4, 0.34], 0, '#5a4a3a', 'wood'),
        box([0, 0, 0.62], [0.52, 0.46, 0.56], 0, paint, 'boards'),
        box([0, 0, 0.94], [0.64, 0.58, 0.08], 0, shade(paint, 0.75)),
      );
      if (!far) local.push(box([0, -0.235, 0.42], [0.3, 0.02, 0.04], 0, '#1d1a17'));
      break;
    }
    case 'haystack': {
      const hay = dice.pick(['#c2a35c', '#b8995a', '#cdb06a']);
      local.push(
        {
          type: 'blob',
          center: [0, 0, 1.05],
          radii: [1.55, 1.45, 1.35],
          color: hay,
          detail: far ? 0 : 1,
        },
        {
          type: 'blob',
          center: [0, 0, 2.1],
          radii: [0.95, 0.9, 0.75],
          color: shade(hay, 0.94),
          detail: far ? 0 : 1,
        },
      );
      if (!far)
        local.push({
          type: 'cylinder',
          from: [0, 0, 2.4],
          to: [0.05, 0, 3.3],
          radius: 0.035,
          segments: 5,
          color: '#6b5a48',
          caps: false,
        });
      break;
    }
    case 'doghouse': {
      const wood = dice.pick(['#8a6a48', '#7d6f5c', '#4f7a54', '#4d6f93']);
      local.push(box([0, 0, 0.36], [0.9, 1.1, 0.72], 0, wood, 'boards'));
      for (const s of [-1, 1])
        local.push(
          slab(
            [
              [0.55 * s, -0.62, 0.68],
              [0.55 * s, 0.62, 0.68],
              [0, 0.62, 1.05],
              [0, -0.62, 1.05],
            ],
            [s, 0, 1],
            0.03,
            dice.pick(['#7c3a2e', '#3f6b4f', '#8f9392']),
          ),
        );
      local.push(
        slab(
          [
            [-0.45, -0.551, 0],
            [0.45, -0.551, 0],
            [0, -0.551, 1.03],
          ],
          [0, -1, 0],
          0.04,
          wood,
          'boards',
        ),
      );
      local.push(box([0, -0.57, 0.3], [0.38, 0.02, 0.45], 0, '#1b1714'));
      break;
    }
    case 'bench': {
      const L = prop.length;
      const wood = dice.pick(['#8a6a48', '#9a7a52', '#6f6252']);
      local.push(box([0, 0, 0.44], [L, 0.36, 0.05], 0, wood, 'wood'));
      if (dice.chance(0.6)) local.push(box([0, 0.17, 0.72], [L, 0.04, 0.3], 0, wood, 'wood'));
      for (const x of [-L / 2 + 0.2, L / 2 - 0.2]) local.push(box([x, 0, 0.21], [0.08, 0.32, 0.42], 0, shade(wood, 0.8), 'wood'));
      break;
    }
    case 'compost': {
      const L = prop.length;
      local.push(box([0, 0, 0.3], [L, 1, 0.6], 0, dice.pick(['#7d6f5c', '#8a7a64']), 'boards'), box([0, 0, 0.58], [L - 0.1, 0.9, 0.04], 0, '#4b3a2c', 'dirt'));
      break;
    }
  }
  return rotatePartsZ(local, prop.angle).map((p) => translate(p, prop.at));
}

function translate(p: HousePart, [dx, dy]: Vec2): HousePart {
  const move = (q: Vec3): Vec3 => [q[0] + dx, q[1] + dy, q[2]];
  if (p.type === 'cylinder') return { ...p, from: move(p.from), to: move(p.to) };
  if (p.type === 'slab') return { ...p, points: p.points.map(move) };
  return { ...p, center: move(p.center) };
}
