// Ворота и калитки в заборе: где на линии забора проём и из чего створки.
// Положение ворот — расстояние по линии забора от её начала до середины проёма (м): так ворота
// остаются на месте, когда забор двигают или поворачивают, и «едут» по забору, когда их тянут.
// Проём целиком лежит на одном звене забора (через излом ворота не ставятся) и не налезает на соседние.

import type { Vec2 } from '../walk/localFrame';
import { fenceLookBoxes, type FenceBoxes, type FenceLook } from './buildingDetails';
import type { DetailBox } from './buildingDetails';

export type GateKind = 'wicket' | 'swing' | 'combo' | 'sliding';

export const GATE_KINDS: Record<GateKind, { label: string; hint: string; width: number }> = {
  wicket: { label: 'Калитка', hint: 'Калитка на одну створку, 1 м', width: 1.0 },
  swing: { label: 'Ворота', hint: 'Распашные ворота на две створки, 3,5 м', width: 3.5 },
  combo: { label: 'Ворота с калиткой', hint: 'Распашные ворота и калитка рядом на общих столбах, 4,7 м', width: 4.7 },
  sliding: { label: 'Откатные', hint: 'Откатные ворота: одно полотно на балке, отъезжает вдоль забора, 4 м', width: 4.0 },
};

export const GATE_ORDER: GateKind[] = ['wicket', 'swing', 'combo', 'sliding'];

export interface FenceGateSpec {
  kind: GateKind;
  /** Середина проёма: метры по линии забора от её начала. */
  at: number;
}

/** Ворота на линии: проём [from, to] по длине линии, на звене segment; center — середина, dir — вдоль звена. */
export interface GatePlace {
  index: number;
  kind: GateKind;
  at: number;
  from: number;
  to: number;
  segment: number;
  center: Vec2;
  dir: Vec2;
}

/** Отступ проёма от изломов забора и от соседних ворот, м. */
const MARGIN = 0.25;

/** Длины по линии: cum[i] — расстояние от начала до точки i. */
export function cumulative(line: readonly Vec2[]): number[] {
  const cum = [0];
  for (let i = 1; i < line.length; i++) cum.push(cum[i - 1]! + Math.hypot(line[i]![0] - line[i - 1]![0], line[i]![1] - line[i - 1]![1]));
  return cum;
}

/** Где на линии точка, ближайшая к p: расстояние от начала линии. */
export function distanceAlong(line: readonly Vec2[], p: Vec2): number {
  const cum = cumulative(line);
  let best = { d: Number.POSITIVE_INFINITY, at: 0 };
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!, b = line[i]!;
    const ab: Vec2 = [b[0] - a[0], b[1] - a[1]];
    const l2 = ab[0] * ab[0] + ab[1] * ab[1];
    if (!l2) continue;
    const t = Math.min(1, Math.max(0, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / l2));
    const d = Math.hypot(p[0] - a[0] - ab[0] * t, p[1] - a[1] - ab[1] * t);
    if (d < best.d) best = { d, at: cum[i - 1]! + t * Math.sqrt(l2) };
  }
  return best.at;
}

/**
 * Разложить ворота по линии: каждые — на звено, где их середина (или на ближайшее звено, куда они влезают),
 * сдвинув так, чтобы проём не доходил до изломов. Не влезли или налезли на уже поставленные — пропускаются.
 */
export function placeGates(line: readonly Vec2[], gates: readonly FenceGateSpec[]): GatePlace[] {
  const cum = cumulative(line);
  const placed: GatePlace[] = [];
  gates.forEach((gate, index) => {
    const w = GATE_KINDS[gate.kind].width;
    // Звенья, куда проём влезает, — ближайшее к желаемой середине.
    let best: { segment: number; at: number; shift: number } | undefined;
    for (let s = 1; s < line.length; s++) {
      const lo = cum[s - 1]! + MARGIN + w / 2, hi = cum[s]! - MARGIN - w / 2;
      if (hi < lo) continue;
      const at = Math.min(hi, Math.max(lo, gate.at));
      const shift = Math.abs(at - gate.at);
      if (!best || shift < best.shift) best = { segment: s, at, shift };
    }
    if (!best) return;
    const from = best.at - w / 2, to = best.at + w / 2;
    if (placed.some((p) => from < p.to + MARGIN && to > p.from - MARGIN)) return;
    const a = line[best.segment - 1]!, b = line[best.segment]!;
    const len = cum[best.segment]! - cum[best.segment - 1]!;
    const dir: Vec2 = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    const t = best.at - cum[best.segment - 1]!;
    placed.push({ index, kind: gate.kind, at: best.at, from, to, segment: best.segment, center: [a[0] + dir[0] * t, a[1] + dir[1] * t], dir });
  });
  return placed;
}

/** Где по умолчанию ставить новые ворота: середина самого длинного свободного места на звене. */
export function defaultGateAt(line: readonly Vec2[], kind: GateKind, others: readonly FenceGateSpec[]): number | undefined {
  const cum = cumulative(line);
  const w = GATE_KINDS[kind].width;
  const taken = placeGates(line, others);
  let best: { at: number; room: number } | undefined;
  for (let s = 1; s < line.length; s++) {
    // Свободные промежутки звена между уже стоящими воротами.
    const cuts = taken.filter((g) => g.segment === s).sort((a, b) => a.from - b.from);
    let start = cum[s - 1]! + MARGIN;
    const spans: [number, number][] = [];
    for (const g of cuts) {
      spans.push([start, g.from - MARGIN]);
      start = g.to + MARGIN;
    }
    spans.push([start, cum[s]! - MARGIN]);
    for (const [lo, hi] of spans) {
      const room = hi - lo;
      if (room >= w && (!best || room > best.room)) best = { at: (lo + hi) / 2, room };
    }
  }
  return best?.at;
}

/** Высота створок по виду забора (низ — над землёй). */
const LEAF_HEIGHT: Record<FenceLook, number> = { boards: 1.75, picket: 1.15, profile: 1.95, rails: 1.25, metal: 1.55 };
const LIFT = 0.07;

/** Створка между u0 и u1 (по звену от середины проёма): полотно того же вида, что и забор. */
function leaf(place: GatePlace, u0: number, u1: number, look: FenceLook, out: number, pieces: DetailBox[]): void {
  const angle = Math.atan2(place.dir[1], place.dir[0]);
  const n: Vec2 = [-place.dir[1], place.dir[0]];
  const at = (u: number, z: number): [number, number, number] => [
    place.center[0] + place.dir[0] * u + n[0] * out,
    place.center[1] + place.dir[1] * u + n[1] * out,
    z,
  ];
  const w = u1 - u0;
  const H = LEAF_HEIGHT[look];
  const mid = (u0 + u1) / 2;
  if (look === 'boards' || look === 'profile') {
    pieces.push({ center: at(mid, LIFT + H / 2), size: [w, look === 'profile' ? 0.04 : 0.05, H], angle });
    // Обвязка поверху и понизу — чуть толще полотна.
    for (const z of [LIFT + 0.05, LIFT + H - 0.05]) pieces.push({ center: at(mid, z), size: [w, 0.07, 0.07], angle });
    return;
  }
  // Каркас: две поперечины и боковины; внутри — штакетины, прутья или диагональ-укосина у жердей.
  for (const z of [LIFT + 0.15, LIFT + H - 0.12]) pieces.push({ center: at(mid, z), size: [w, 0.05, 0.06], angle });
  for (const u of [u0 + 0.03, u1 - 0.03]) pieces.push({ center: at(u, LIFT + H / 2), size: [0.06, 0.05, H], angle });
  if (look === 'rails') {
    pieces.push({ center: at(mid, LIFT + H / 2), size: [w, 0.05, 0.06], angle });
    return;
  }
  const step = look === 'metal' ? 0.13 : 0.15;
  const count = Math.max(1, Math.round(w / step) - 1);
  for (let k = 1; k <= count; k++) {
    const u = u0 + (w * k) / (count + 1);
    pieces.push(
      look === 'metal'
        ? { center: at(u, LIFT + H / 2), size: [0.018, 0.018, H], angle }
        : { center: at(u, LIFT + H / 2 + 0.03), size: [0.08, 0.025, H + 0.05], angle },
    );
  }
}

/** Детали ворот: столбы по краям (и между воротами и калиткой), створки, у откатных — балка. */
export function gateBoxes(place: GatePlace, look: FenceLook): FenceBoxes {
  const result: FenceBoxes = { pieces: [], posts: [] };
  const angle = Math.atan2(place.dir[1], place.dir[0]);
  const w = GATE_KINDS[place.kind].width;
  const H = LEAF_HEIGHT[look];
  const postH = H + 0.25;
  const post = (u: number) =>
    result.posts.push({ center: [place.center[0] + place.dir[0] * u, place.center[1] + place.dir[1] * u, postH / 2 - 0.1], size: [0.14, 0.14, postH + 0.2], angle });
  const half = w / 2;
  const gap = 0.04;
  post(-half);
  post(half);
  if (place.kind === 'wicket') {
    leaf(place, -half + 0.08, half - 0.08, look, 0, result.pieces);
  } else if (place.kind === 'swing') {
    leaf(place, -half + 0.08, -gap / 2, look, 0, result.pieces);
    leaf(place, gap / 2, half - 0.08, look, 0, result.pieces);
  } else if (place.kind === 'combo') {
    // Ворота 3,5 м слева, столб, калитка справа.
    const split = -half + 3.5 + 0.07;
    post(split);
    const gm = (-half + split) / 2;
    leaf(place, -half + 0.08, gm - gap / 2, look, 0, result.pieces);
    leaf(place, gm + gap / 2, split - 0.08, look, 0, result.pieces);
    leaf(place, split + 0.08, half - 0.08, look, 0, result.pieces);
  } else {
    // Откатные: полотно во весь проём, балка снизу уходит за столб вдоль забора (противовес).
    leaf(place, -half + 0.05, half - 0.05, look, 0.1, result.pieces);
    const n: Vec2 = [-place.dir[1], place.dir[0]];
    const beam = w * 0.4;
    const u = -half - beam / 2;
    result.posts.push({
      center: [place.center[0] + place.dir[0] * u + n[0] * 0.1, place.center[1] + place.dir[1] * u + n[1] * 0.1, LIFT + 0.04],
      size: [beam + w, 0.08, 0.1],
      angle,
    });
  }
  return result;
}

/**
 * Забор по линии с воротами: полотно режется на проёмах, в проёмах — ворота. Возвращает коробки полотна,
 * створки ворот отдельно (их красят на тон темнее, чтобы ворота читались), столбы и где ворота встали.
 */
export function fenceWithGates(line: readonly Vec2[], gates: readonly FenceGateSpec[], look: FenceLook): FenceBoxes & { leaves: DetailBox[]; places: GatePlace[] } {
  const places = placeGates(line, gates);
  const cum = cumulative(line);
  const result: FenceBoxes & { leaves: DetailBox[]; places: GatePlace[] } = { pieces: [], posts: [], leaves: [], places };
  for (let s = 1; s < line.length; s++) {
    const a = line[s - 1]!, b = line[s]!;
    const len = cum[s]! - cum[s - 1]!;
    if (len <= 0) continue;
    const point = (d: number): Vec2 => {
      const t = (d - cum[s - 1]!) / len;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    };
    let start = cum[s - 1]!;
    for (const gate of places.filter((g) => g.segment === s).sort((x, y) => x.from - y.from)) {
      if (gate.from - start > 0.05) add(result, fenceLookBoxes(point(start), point(gate.from), look));
      const g = gateBoxes(gate, look);
      result.leaves.push(...g.pieces);
      result.posts.push(...g.posts);
      start = gate.to;
    }
    if (cum[s]! - start > 0.05) add(result, fenceLookBoxes(point(start), b, look));
  }
  return result;
}

function add(into: FenceBoxes, from: FenceBoxes): void {
  into.pieces.push(...from.pieces);
  into.posts.push(...from.posts);
}
