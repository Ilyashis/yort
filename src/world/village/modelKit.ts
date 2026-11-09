// Общее для моделей зданий: палитры, расстановка окон и дверей, козырьки, сборка плана, фундамент на склоне.

import {
  Dice,
  doorParts,
  toneOf,
  windowParts,
  type Canopy,
  type HousePart,
  type Opening,
  type WallFrame,
  type WindowStyle,
} from './houseParts';
import type { HouseModelId, HouseOptions, HousePlan } from './houseModels';

// --- палитры ------------------------------------------------------------------------------------

/** Сруб: свежий — медовый, старый — серо-коричневый. */
export const LOGS = ['#9a7650', '#8a6a4a', '#a78258', '#7d6f62', '#8f7a63'];
/** Крашеная обшивка: синий, бирюза, зелёный, охра, белый, голубой. */
export const PAINTS = ['#4f86b8', '#3f8f8a', '#6a9f62', '#d2b25a', '#e6dfcd', '#86b4d4', '#b8694f', '#5f9a9a'];
export const TRIMS = ['#f4f1e8', '#ffffff', '#e9f0f4'];
/** Резьба вторым цветом: синий, бирюзовый, красный, жёлтый, зелёный. */
export const ACCENTS = ['#2f6fb0', '#2a8a86', '#c8463a', '#e2b23a', '#3c9255'];
export const SHUTTERS = ['#2f6fb0', '#2f8796', '#3c9255', '#f1eee5', '#7a5236', '#c8463a'];
export const METAL_ROOFS = ['#3f6b4f', '#3a5f86', '#7c3a2e', '#2f6f6a', '#5d6a3a', '#5a3e32'];
export const SLATE = ['#8f9392', '#9b9b92', '#80858a'];
export const FOUNDATIONS = ['#a29d93', '#928d83', '#b0a99c'];
export const DOORS = ['#7a4f33', '#4f6f8f', '#3e6b52', '#8a3b30', '#6b5a48'];
export const BRICK_RED = ['#a4523b', '#97492f', '#b0603f'];
export const BRICK_WHITE = ['#e3dccb', '#d8d0bd'];
export const PLASTER = ['#ece6d6', '#e8dcc0', '#dfe6e6'];
export const FELT = ['#ece5d3', '#e4dac3', '#efe9dc'];
export const BAND = ['#b0392e', '#2f5f9f', '#2f7f5f'];

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const rect = (w: number, d: number, cx = 0, cy = 0): [number, number][] => [
  [cx - w / 2, cy - d / 2],
  [cx + w / 2, cy - d / 2],
  [cx + w / 2, cy + d / 2],
  [cx - w / 2, cy + d / 2],
];

/** Середины n окон, разнесённых по стене длиной L с шагом step (по центру стены). */
export const spread = (L: number, n: number, step: number) => Array.from({ length: n }, (_, i) => L / 2 + (i - (n - 1) / 2) * step);

/** Окна по стене: сколько поместится (со ставнями окно занимает 2w + 0,42 м, без — w + 0,75) и где. */
export function fitWindows(L: number, w: number, shutters: boolean, max: number, margin = 0.45): number[] {
  const need = shutters ? 2 * w + 0.42 : w + 0.75;
  const room = L - 2 * margin;
  const n = clamp(Math.floor(room / need), 1, max);
  const step = n > 1 ? Math.min(need * 1.3, (room - need) / (n - 1)) : 0;
  return spread(L, n, step);
}

/**
 * Односкатный козырёк крыльца под свесом крыши: от стены (wallOut) до out1, выше двери (doorTop)
 * и ниже кровли (кровля над точкой в out от стены: top − out·tan, свес — до overhang).
 */
export function leanCanopy(top: number, pitch: number, wallOut: number, overhang: number, out1: number, doorTop: number): Canopy {
  const tan = Math.tan((pitch * Math.PI) / 180);
  const roofAt = (out: number) => top - out * tan - 0.08;
  let low = doorTop + 0.12;
  const k = (overhang - wallOut) / (out1 - wallOut);
  const high = Math.min(roofAt(wallOut) - 0.1, (roofAt(overhang) - 0.04 - low * k) / (1 - k));
  if (high < low + 0.08) low = high - 0.08;
  return { kind: 'lean', high, low };
}

/**
 * Готовый план дома. paint — основные цвета кровли и стен: детали этих цветов (и их оттенков) помечаются,
 * чтобы потом заменить цвет снятым с дрона.
 */
export function finish(
  id: HouseModelId,
  parts: HousePart[],
  width: number,
  depth: number,
  footprint: [number, number][],
  paint?: { roof?: string; wall?: string },
): HousePlan {
  if (paint) markPaint(parts, paint);
  let height = 0;
  for (const p of parts) {
    if (p.type === 'box' || p.type === 'glass' || p.type === 'sign') height = Math.max(height, p.center[2] + p.size[2] / 2);
    else if (p.type === 'cylinder') height = Math.max(height, p.from[2], p.to[2]);
    else if (p.type === 'blob') height = Math.max(height, p.center[2] + p.radii[2]);
    else for (const q of p.points) height = Math.max(height, q[2]);
  }
  return { id, parts, width, depth, height, footprint };
}

/** Окно в срубе (стекло в середине бревна, окосячка) или в сплошной стене толщиной thickness. */
export function windowIn(
  parts: HousePart[],
  openings: Opening[],
  f: WallFrame,
  u: number,
  z0: number,
  w: number,
  h: number,
  wall: { log: number } | { thickness: number },
  style: WindowStyle,
  dice: Dice,
  revealColor?: string,
) {
  openings.push({ u0: u - w / 2 - 0.07, u1: u + w / 2 + 0.07, z0: z0 - 0.07, z1: z0 + h + 0.07 });
  const log = 'log' in wall;
  const wallOut = log ? wall.log : wall.thickness / 2;
  const glassOut = log ? 0 : wall.thickness / 2 - 0.11;
  parts.push(...windowParts({ f, u, z0, w, h, wallOut, glassOut, reveal: log ? wall.log : 0.11, revealColor, dice }, style));
}

export function doorIn(
  parts: HousePart[],
  openings: Opening[],
  f: WallFrame,
  u: number,
  z0: number,
  w: number,
  h: number,
  wallOut: number,
  color: string,
  trim: string,
) {
  openings.push({ u0: u - w / 2 - 0.08, u1: u + w / 2 + 0.08, z0, z1: z0 + h + 0.08 });
  parts.push(...doorParts(f, u, z0, w, h, wallOut, wallOut * 0.2, color, trim));
}

/** Части, стоящие на земле (низ на z ≈ 0), продолжаем вниз на below метров. */
export function sinkToGround(plan: HousePlan, below: number | undefined): HousePlan {
  const b = clamp(below ?? 0, 0, 6);
  if (b < 0.01) return plan;
  const parts = plan.parts.map((p): HousePart => {
    if (p.type === 'box' && Math.abs(p.center[2] - p.size[2] / 2) < 0.03) {
      return { ...p, center: [p.center[0], p.center[1], p.center[2] - b / 2], size: [p.size[0], p.size[1], p.size[2] + b] };
    }
    if (p.type === 'cylinder' && Math.abs(p.from[2]) < 0.03 && Math.abs(p.to[0] - p.from[0]) + Math.abs(p.to[1] - p.from[1]) < 1e-6) {
      return { ...p, from: [p.from[0], p.from[1], -b] };
    }
    return p;
  });
  return { ...plan, parts };
}


/** План модели с фундаментом на склоне (options.foundation). */
export function withGround(planner: (o: HouseOptions) => HousePlan): (o?: HouseOptions) => HousePlan {
  return (o = {}) => sinkToGround(planner(o), o.foundation);
}

/** Пометить детали кровли и стен (по цвету и его оттенкам). Стёкла, таблички и чужие цвета не трогаем. */
export function markPaint(parts: HousePart[], paint: { roof?: string; wall?: string }): void {
  for (const p of parts) {
    if (p.type === 'glass' || p.type === 'sign') continue;
    for (const role of ['roof', 'wall'] as const) {
      const base = paint[role];
      if (!base) continue;
      const tone = toneOf(p.color, base);
      if (tone !== undefined) {
        p.paint = { role, tone };
        break;
      }
    }
  }
}
