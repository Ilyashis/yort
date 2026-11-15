// Правки заборов посёлка поверх плана участков (planEstates): забор (FenceRun) получает свою ломаную,
// ворота участка — своё место на уличном заборе. Вырезы (ворота, палисадник, стены построек) переносятся
// на новую ломаную по своим точкам. Неизменённые заборы и участки остаются теми же объектами — слой
// перерисовывает только изменённое. Плюс геометрия инструмента: магнит к точкам и линиям соседей.
// Чистые функции, локальные метры.

import type { Vec2 } from '../walk/localFrame';
import { arcPosition, pointAt, type EstatePlan, type FenceRun, type FenceStyle, type Plot } from './estates';

/** Вид забора: тип, высота, цвет. */
export interface RunLook {
  style?: FenceStyle;
  height?: number;
  color?: string;
}

/** Ключ забора — по хозяевам и началу: план участков детерминирован, ключ переживает перезагрузку. */
export function runKey(run: Pick<FenceRun, 'owners' | 'line'>): string {
  const [x, y] = run.line[0] ?? [0, 0];
  return `${run.owners.join('|')}@${x.toFixed(1)},${y.toFixed(1)}`;
}

/** Проём ворот с калиткой вдоль забора, м (половина). */
export function gateHalf(gate: { gate: number; wicket: number }): number {
  return (gate.gate + gate.wicket + 0.2) / 2;
}

export interface FenceOverrides {
  /** Новые ломаные заборов по ключу runKey. */
  lines: ReadonlyMap<string, readonly Vec2[]>;
  /** Новое место ворот по id участка. */
  gates: ReadonlyMap<string, Vec2>;
  /** Вид заборов по ключу runKey. */
  looks?: ReadonlyMap<string, RunLook>;
  /** Ворота: сторона калитки и козырёк по id участка. */
  gateOptions?: ReadonlyMap<string, { wicketSide?: -1 | 1; canopy?: boolean }>;
}

const length = (line: readonly Vec2[]) => {
  let s = 0;
  for (let k = 1; k < line.length; k++) s += Math.hypot(line[k]![0] - line[k - 1]![0], line[k]![1] - line[k - 1]![1]);
  return s;
};

/** План с правками заборов и ворот. Без правок — тот же план. */
export function editPlan(base: EstatePlan, overrides: FenceOverrides): EstatePlan {
  const looks = overrides.looks ?? new Map<string, RunLook>();
  const options = overrides.gateOptions ?? new Map<string, { wicketSide?: -1 | 1; canopy?: boolean }>();
  if (!overrides.lines.size && !overrides.gates.size && !looks.size && !options.size) return base;
  const plotById = new Map(base.plots.map((p) => [p.id, p]));

  // Ворота: где они на старом заборе и куда встают.
  const runs = base.runs.map((run) => {
    const key = runKey(run);
    const line = overrides.lines.get(key);
    const look = looks.get(key);
    return { run, line: line && line.length >= 2 ? [...line] : undefined, look: look && (look.style || look.height || look.color) ? look : undefined };
  });
  const moved = new Set<string>();
  const plots = base.plots.map((plot): Plot => restyle(placeGate(plot)));

  /** Вид уличного забора участка — и у ворот (тип, цвет, высота), сторона калитки и козырёк — из правки. */
  function restyle(plot: Plot): Plot {
    const look = runs.find((r) => r.look && r.run.kind === 'street' && r.run.owners[0] === plot.id)?.look;
    const raw = options.get(plot.id);
    const option = raw && (raw.wicketSide || raw.canopy !== undefined) ? raw : undefined;
    if (!look && !option) return plot;
    const fence = look ? { style: look.style ?? plot.fence.style, color: look.color ?? plot.fence.color, height: look.height ?? plot.fence.height } : plot.fence;
    const gate = plot.gate && {
      ...plot.gate,
      ...(look ? { style: fence.style, color: fence.color } : {}),
      ...(option?.wicketSide ? { wicketSide: option.wicketSide } : {}),
      ...(option?.canopy !== undefined ? { canopy: option.canopy } : {}),
    };
    return { ...plot, fence, ...(gate ? { gate } : {}) };
  }

  function placeGate(plot: Plot): Plot {
    const gate = plot.gate;
    if (!gate) return plot;
    const target = overrides.gates.get(plot.id);
    const ownRuns = runs.filter((r) => r.run.kind === 'street' && r.run.owners[0] === plot.id);
    if (!target && !ownRuns.some((r) => r.line)) return plot;
    // Ближайший уличный забор участка (с правками), ворота — целиком на нём.
    let best: { line: Vec2[]; s: number; distance: number } | undefined;
    for (const r of ownRuns) {
      const line = r.line ?? r.run.line;
      const at = arcPosition(line, target ?? gate.at);
      if (!best || at.distance < best.distance) best = { line, s: at.s, distance: at.distance };
    }
    if (!best) return plot;
    const total = length(best.line);
    const half = gateHalf(gate);
    const s = total > 2 * half + 0.6 ? Math.min(Math.max(best.s, half + 0.3), total - half - 0.3) : total / 2;
    const { point, dir } = pointAt(best.line, s);
    const along: Vec2 = dir[0] * plot.t[0] + dir[1] * plot.t[1] >= 0 ? dir : [-dir[0], -dir[1]];
    const inward: Vec2 = [-along[1], along[0]];
    const shift: Vec2 = [point[0] - gate.at[0], point[1] - gate.at[1]];
    if (Math.hypot(shift[0], shift[1]) < 1e-4 && along[0] === gate.along[0] && along[1] === gate.along[1]) return plot;
    moved.add(plot.id);
    return {
      ...plot,
      gate: { ...gate, at: point, along, inward: inward[0] * plot.n[0] + inward[1] * plot.n[1] >= 0 ? inward : [-inward[0], -inward[1]] },
      // Подъезд — за воротами.
      ...(plot.driveway ? { driveway: plot.driveway.map(([x, y]): Vec2 => [x + shift[0], y + shift[1]]) } : {}),
    };
  }
  const editedPlot = new Map(plots.map((p) => [p.id, p]));

  const out = runs.map(({ run, line, look }): FenceRun => {
    const owner = run.kind === 'street' ? run.owners[0] : undefined;
    const gateMoved = !!owner && moved.has(owner);
    if (!line && !gateMoved) return look ? { ...run, ...look } : run;
    const next = line ?? run.line;
    const oldGate = owner ? plotById.get(owner)?.gate : undefined;
    const oldGateS = oldGate ? arcPosition(run.line, oldGate.at) : undefined;
    const cuts: [number, number][] = [];
    for (const [a, b] of run.cuts) {
      // Вырез старых ворот — уходит (ворота встанут заново).
      if (oldGateS && oldGateS.distance < 0.05 && oldGateS.s >= a - 0.01 && oldGateS.s <= b + 0.01 && gateMoved) continue;
      if (!line) {
        cuts.push([a, b]);
        continue;
      }
      // Вырез — по его концам на новой ломаной (стена постройки, палисадник остаются на месте).
      const pa = arcPosition(next, pointAt(run.line, a).point);
      const pb = arcPosition(next, pointAt(run.line, b).point);
      if (pa.distance > 1 || pb.distance > 1) continue;
      const lo = Math.min(pa.s, pb.s);
      const hi = Math.max(pa.s, pb.s);
      if (hi - lo > 0.1) cuts.push([lo, hi]);
    }
    const gate = owner ? editedPlot.get(owner)?.gate : undefined;
    if (gate && (gateMoved || line)) {
      const at = arcPosition(next, gate.at);
      if (at.distance < 0.05) {
        // Старый вырез ворот на изменённой ломаной (ворота не двигали) уже перенесён — новый не нужен.
        const half = gateHalf(gate);
        if (gateMoved || !cuts.some(([a, b]) => at.s > a && at.s < b)) cuts.push([at.s - half, at.s + half]);
      }
    }
    return { ...run, ...look, line: next, cuts: mergeCuts(cuts) };
  });
  return { plots, runs: out };
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

// --- инструмент ------------------------------------------------------------------------------

/** Точки ближе этого, м, — одна точка (стык заборов соседей). */
export const SAME_POINT = 0.02;

export const samePoint = (a: Vec2, b: Vec2) => Math.abs(a[0] - b[0]) < SAME_POINT && Math.abs(a[1] - b[1]) < SAME_POINT;

/** Переставить точку at в to во всех линиях (стык соседей двигается целиком). Возвращает изменённые. */
export function movePoint<K>(lines: ReadonlyMap<K, readonly Vec2[]>, at: Vec2, to: Vec2): Map<K, Vec2[]> {
  const out = new Map<K, Vec2[]>();
  for (const [key, line] of lines) {
    if (!line.some((p) => samePoint(p, at))) continue;
    out.set(
      key,
      line.map((p) => (samePoint(p, at) ? to : p)),
    );
  }
  return out;
}

/** Убрать излом at из линий (концы заборов — стыки — не убираются). undefined — убрать нельзя. */
export function dropPoint<K>(lines: ReadonlyMap<K, readonly Vec2[]>, at: Vec2): Map<K, Vec2[]> | undefined {
  const out = new Map<K, Vec2[]>();
  for (const [key, line] of lines) {
    const i = line.findIndex((p) => samePoint(p, at));
    if (i < 0) continue;
    if (i === 0 || i === line.length - 1) return undefined;
    out.set(key, [...line.slice(0, i), ...line.slice(i + 1)]);
  }
  return out.size ? out : undefined;
}

export interface MagnetTarget {
  point: Vec2;
  /** К чему притянулось: к точке соседа, на линию забора или в створ соседних точек. */
  kind: 'point' | 'line' | 'straight';
}

/**
 * Магнит для перетаскиваемой точки: к чужой точке (ближе pointReach м), на чужую линию (ближе lineReach м),
 * иначе — в створ двух соседних точек (почти прямой забор — ровно прямой). Свои соседние отрезки не тянут.
 */
export function magnet(
  p: Vec2,
  neighbours: readonly Vec2[],
  lines: readonly (readonly Vec2[])[],
  dragged: Vec2,
  pointReach: number,
  lineReach: number,
): MagnetTarget | undefined {
  let bestPoint: { point: Vec2; d: number } | undefined;
  for (const line of lines) {
    for (const q of line) {
      if (samePoint(q, dragged)) continue;
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d <= pointReach && (!bestPoint || d < bestPoint.d)) bestPoint = { point: q, d };
    }
  }
  if (bestPoint) return { point: bestPoint.point, kind: 'point' };
  let bestLine: { point: Vec2; d: number } | undefined;
  for (const line of lines) {
    for (let k = 1; k < line.length; k++) {
      const a = line[k - 1]!;
      const b = line[k]!;
      // Отрезки, что выходят из самой точки, — её же: к ним не тянем.
      if (samePoint(a, dragged) || samePoint(b, dragged)) continue;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const l2 = dx * dx + dy * dy;
      if (l2 < 1e-6) continue;
      const t = Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
      const q: Vec2 = [a[0] + dx * t, a[1] + dy * t];
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d <= lineReach && (!bestLine || d < bestLine.d)) bestLine = { point: q, d };
    }
  }
  if (bestLine) return { point: bestLine.point, kind: 'line' };
  // Створ: точка почти на прямой между соседями — ставим ровно на неё.
  if (neighbours.length === 2) {
    const [a, b] = neighbours as [Vec2, Vec2];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    if (l2 > 1) {
      const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
      const q: Vec2 = [a[0] + dx * t, a[1] + dy * t];
      if (t > 0.05 && t < 0.95 && Math.hypot(q[0] - p[0], q[1] - p[1]) <= lineReach * 0.6) return { point: q, kind: 'straight' };
    }
  }
  return undefined;
}

/** Ворота на заборе: ближайшая точка уличного забора участка, проём целиком на нём. */
export function gateSpot(lines: readonly (readonly Vec2[])[], p: Vec2, half: number): Vec2 | undefined {
  let best: { line: readonly Vec2[]; s: number; distance: number } | undefined;
  for (const line of lines) {
    const at = arcPosition(line, p);
    if (!best || at.distance < best.distance) best = { line, s: at.s, distance: at.distance };
  }
  if (!best) return undefined;
  const total = length(best.line);
  const s = total > 2 * half + 0.6 ? Math.min(Math.max(best.s, half + 0.3), total - half - 0.3) : total / 2;
  return pointAt(best.line, s).point;
}
