// Правки заборов посёлка поверх плана участков (planEstates): забор (FenceRun) получает свою ломаную,
// ворота участка — своё место на уличном заборе. Вырезы (ворота, палисадник, стены построек) переносятся
// на новую ломаную по своим точкам. Неизменённые заборы и участки остаются теми же объектами — слой
// перерисовывает только изменённое. Плюс геометрия инструмента: магнит к точкам и линиям соседей.
// Чистые функции, локальные метры.

import type { Vec2 } from '../walk/localFrame';
import { arcPosition, pointAt, type EstateGate, type EstatePlan, type FenceRun, type FenceStyle, type Plot } from './estates';

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

/** Ворота участка: есть ли ворота и калитка, сторона калитки, козырёк. */
export interface GateOption {
  wicketSide?: -1 | 1;
  canopy?: boolean;
  /** Ворота (две створки): true — поставить, false — убрать. */
  gate?: boolean;
  /** Калитка: true — поставить, false — убрать. */
  wicket?: boolean;
}

/** Палисадник: от фасада (origin) к улице (toStreet), ширина вдоль фасада, глубина до уличного забора. */
export interface Palisade {
  origin: Vec2;
  toStreet: Vec2;
  width: number;
  depth: number;
}

export interface FenceOverrides {
  /** Новые ломаные заборов по ключу runKey. */
  lines: ReadonlyMap<string, readonly Vec2[]>;
  /** Новое место ворот по id участка. */
  gates: ReadonlyMap<string, Vec2>;
  /** Вид заборов по ключу runKey. */
  looks?: ReadonlyMap<string, RunLook>;
  /** Ворота: есть ли ворота и калитка, сторона калитки, козырёк — по id участка. */
  gateOptions?: ReadonlyMap<string, GateOption>;
  /** Палисадники, переехавшие вместе с домом, — по id участка. */
  palisades?: ReadonlyMap<string, Palisade>;
  /** Мелочь дворов по ключу propKey: новое место, поворот, убрана. */
  props?: ReadonlyMap<string, { at?: Vec2; angle?: number; removed?: boolean }>;
}

/** Ключ мелочи двора: участок и номер в его плане. */
export const propKey = (plot: string, index: number) => `${plot}#${index}`;

/** Ширина ворот и калитки, когда их ставят заново, м. */
export const NEW_GATE = 3.2;
export const NEW_WICKET = 1;

const length = (line: readonly Vec2[]) => {
  let s = 0;
  for (let k = 1; k < line.length; k++) s += Math.hypot(line[k]![0] - line[k - 1]![0], line[k]![1] - line[k - 1]![1]);
  return s;
};

const same = (a: Vec2, b: Vec2) => Math.abs(a[0] - b[0]) < 1e-4 && Math.abs(a[1] - b[1]) < 1e-4;
const palisadeFront = (p: Palisade): Vec2 => [p.origin[0] + p.toStreet[0] * p.depth, p.origin[1] + p.toStreet[1] * p.depth];

/** Вырез палисадника в заборе line (если его перед стоит на заборе). */
function palisadeCut(line: readonly Vec2[], p: Palisade): [number, number] | undefined {
  const front = palisadeFront(p);
  const along: Vec2 = [-p.toStreet[1], p.toStreet[0]];
  const a = arcPosition(line, [front[0] + along[0] * (p.width / 2 + 0.05), front[1] + along[1] * (p.width / 2 + 0.05)]);
  const b = arcPosition(line, [front[0] - along[0] * (p.width / 2 + 0.05), front[1] - along[1] * (p.width / 2 + 0.05)]);
  return a.distance < 1.2 && b.distance < 1.2 ? [Math.min(a.s, b.s), Math.max(a.s, b.s)] : undefined;
}

/** План с правками заборов, ворот и палисадников. Без правок — тот же план. */
export function editPlan(base: EstatePlan, overrides: FenceOverrides): EstatePlan {
  const looks = overrides.looks ?? new Map<string, RunLook>();
  const options = overrides.gateOptions ?? new Map<string, GateOption>();
  const palisades = overrides.palisades ?? new Map<string, Palisade>();
  const propEdits = overrides.props ?? new Map<string, { at?: Vec2; angle?: number; removed?: boolean }>();
  if (!overrides.lines.size && !overrides.gates.size && !looks.size && !options.size && !palisades.size && !propEdits.size) return base;
  const propPlots = new Set([...propEdits.keys()].map((k) => k.slice(0, k.lastIndexOf('#'))));
  const plotById = new Map(base.plots.map((p) => [p.id, p]));

  const runs = base.runs.map((run) => {
    const key = runKey(run);
    const line = overrides.lines.get(key);
    // Только заданные поля вида: пустой цвет не затирает цвет забора.
    const raw = looks.get(key);
    const look: RunLook | undefined =
      raw && (raw.style || raw.height || raw.color)
        ? { ...(raw.style ? { style: raw.style } : {}), ...(raw.height ? { height: raw.height } : {}), ...(raw.color ? { color: raw.color } : {}) }
        : undefined;
    return { run, line: line && line.length >= 2 ? [...line] : undefined, look };
  });
  /** Заборы, на которых могут стоять ворота участка: уличные (свои), а если улицы нет — любые его. */
  const gateRuns = (id: string) => {
    const street = runs.filter((r) => r.run.kind === 'street' && r.run.owners[0] === id);
    return street.length ? street : runs.filter((r) => r.run.owners.includes(id));
  };

  const plots = base.plots.map((plot): Plot => {
    const option = options.get(plot.id);
    const target = overrides.gates.get(plot.id);
    const palisade = palisades.get(plot.id);
    const own = gateRuns(plot.id);
    const look = runs.find((r) => r.look && r.run.kind === 'street' && r.run.owners[0] === plot.id)?.look;
    const touched =
      propPlots.has(plot.id) ||
      !!palisade || !!target || !!look || own.some((r) => r.line) || (!!option && (option.wicketSide || option.canopy !== undefined || option.gate !== undefined || option.wicket !== undefined));
    if (!touched) return plot;

    const fence = look ? { style: look.style ?? plot.fence.style, color: look.color ?? plot.fence.color, height: look.height ?? plot.fence.height } : plot.fence;
    let gate = plot.gate;
    // Ворот не было, а их включили — ставим посередине самого длинного забора участка.
    if (!gate && (option?.gate || option?.wicket)) {
      const longest = own.map((r) => r.line ?? r.run.line).sort((a, b) => length(b) - length(a))[0];
      if (longest) {
        const { point } = pointAt(longest, length(longest) / 2);
        gate = { at: point, along: plot.t, inward: plot.n, gate: 0, wicket: 0, wicketSide: 1, canopy: false, style: fence.style, color: fence.color };
      }
    }
    if (gate) {
      const G = option?.gate === false ? 0 : option?.gate && !gate.gate ? NEW_GATE : gate.gate;
      const W = option?.wicket === false ? 0 : option?.wicket && !gate.wicket ? NEW_WICKET : gate.wicket;
      gate =
        G || W
          ? {
              ...gate,
              gate: G,
              wicket: W,
              ...(look ? { style: fence.style, color: fence.color } : {}),
              ...(option?.wicketSide ? { wicketSide: option.wicketSide } : {}),
              ...(option?.canopy !== undefined ? { canopy: option.canopy } : {}),
            }
          : undefined;
    }
    // Ворота — целиком на ближайшем заборе участка (с правками), лицом к улице.
    let driveway = plot.driveway;
    if (gate) {
      let best: { line: Vec2[]; s: number; distance: number } | undefined;
      for (const r of own) {
        const line = r.line ?? r.run.line;
        const at = arcPosition(line, target ?? gate.at);
        if (!best || at.distance < best.distance) best = { line, s: at.s, distance: at.distance };
      }
      if (best) {
        const total = length(best.line);
        const half = gateHalf(gate);
        const s = total > 2 * half + 0.6 ? Math.min(Math.max(best.s, half + 0.3), total - half - 0.3) : total / 2;
        const { point, dir } = pointAt(best.line, s);
        const along: Vec2 = dir[0] * plot.t[0] + dir[1] * plot.t[1] >= 0 ? dir : [-dir[0], -dir[1]];
        const inward: Vec2 = [-along[1], along[0]];
        const shift: Vec2 = [point[0] - gate.at[0], point[1] - gate.at[1]];
        // Подъезд — за воротами.
        if (driveway && plot.gate) driveway = driveway.map(([x, y]): Vec2 => [x + shift[0], y + shift[1]]);
        gate = { ...gate, at: point, along, inward: inward[0] * plot.n[0] + inward[1] * plot.n[1] >= 0 ? inward : [-inward[0], -inward[1]] };
      }
    }
    if (!gate) driveway = undefined;
    const next: Plot = { ...plot, fence, ...(palisade ? { palisade } : {}) };
    if (propPlots.has(plot.id))
      next.props = plot.props.flatMap((prop, i) => {
        const e = propEdits.get(propKey(plot.id, i));
        if (e?.removed) return [];
        return [{ ...prop, ref: i, ...(e?.at ? { at: e.at } : {}), ...(e?.angle !== undefined ? { angle: e.angle } : {}) }];
      });
    if (gate) next.gate = gate;
    else delete next.gate;
    if (driveway) next.driveway = driveway;
    else delete next.driveway;
    return next;
  });
  const editedPlot = new Map(plots.map((p) => [p.id, p]));
  /** Изменились ли у участка ворота (есть/нет, место, ширина) или палисадник. */
  const gateChanged = (id: string) => {
    const a = plotById.get(id)?.gate;
    const b = editedPlot.get(id)?.gate;
    if (!a || !b) return !!a !== !!b;
    return !same(a.at, b.at) || a.gate !== b.gate || a.wicket !== b.wicket;
  };
  const palisadeChanged = (id: string) => palisades.has(id) && editedPlot.get(id)?.palisade !== plotById.get(id)?.palisade;

  const out = runs.map(({ run, line, look }): FenceRun => {
    // Ворота участка поменялись и стояли (или встанут) на этом заборе.
    const onRun = (g: { at: Vec2 } | undefined, l: readonly Vec2[]) => !!g && arcPosition(l, g.at).distance < 0.05;
    const gateOwners = run.owners.filter(
      (id) => gateChanged(id) && (onRun(plotById.get(id)?.gate, run.line) || onRun(editedPlot.get(id)?.gate, line ?? run.line)),
    );
    const palOwners = run.kind === 'street' ? run.owners.filter(palisadeChanged) : [];
    if (!line && !gateOwners.length && !palOwners.length) return look ? { ...run, ...look } : run;
    const next = line ?? run.line;
    // Старые вырезы ворот и палисадников, которые поменялись, — уходят (встанут заново).
    const stale = (a: number, b: number) =>
      gateOwners.some((id) => {
        const g = plotById.get(id)?.gate;
        if (!g) return false;
        const at = arcPosition(run.line, g.at);
        return at.distance < 0.05 && at.s >= a - 0.01 && at.s <= b + 0.01;
      }) ||
      palOwners.some((id) => {
        const p = plotById.get(id)?.palisade;
        if (!p) return false;
        const at = arcPosition(run.line, palisadeFront(p));
        return at.distance < 1.2 && at.s >= a - 0.01 && at.s <= b + 0.01;
      });
    const cuts: [number, number][] = [];
    for (const [a, b] of run.cuts) {
      if (stale(a, b)) continue;
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
    for (const id of run.owners) {
      const gate = editedPlot.get(id)?.gate;
      if (!gate || (!gateOwners.includes(id) && !line)) continue;
      const at = arcPosition(next, gate.at);
      if (at.distance >= 0.05) continue;
      const half = gateHalf(gate);
      // Ворота не меняли, а ломаная новая — старый вырез уже перенесён.
      if (gateOwners.includes(id) || !cuts.some(([a, b]) => at.s > a && at.s < b)) cuts.push([at.s - half, at.s + half]);
    }
    for (const id of palOwners) {
      const p = editedPlot.get(id)?.palisade;
      const cut = p && palisadeCut(next, p);
      if (cut) cuts.push(cut);
    }
    return { ...run, ...look, line: next, cuts: mergeCuts(cuts) };
  });
  return { plots, runs: out };
}

/**
 * Палисадник дома, который передвинули или повернули: едет вместе с домом (тот же сдвиг и поворот), а перед
 * его — снова на уличном заборе, если тот рядом (палисадник тянется от фасада до забора).
 */
export function movePalisade(p: Palisade, from: { center: Vec2; angle: number }, to: { center: Vec2; angle: number }, streets: readonly (readonly Vec2[])[]): Palisade {
  const da = to.angle - from.angle;
  const c = Math.cos(da);
  const sn = Math.sin(da);
  const rot = ([x, y]: Vec2): Vec2 => [x * c - y * sn, x * sn + y * c];
  const [rx, ry] = rot([p.origin[0] - from.center[0], p.origin[1] - from.center[1]]);
  const origin: Vec2 = [to.center[0] + rx, to.center[1] + ry];
  const toStreet = rot(p.toStreet);
  let depth = p.depth;
  // Где луч от фасада к улице встречает уличный забор.
  let best: number | undefined;
  for (const line of streets) {
    for (let k = 1; k < line.length; k++) {
      const a = line[k - 1]!;
      const b = line[k]!;
      const ex = b[0] - a[0];
      const ey = b[1] - a[1];
      const den = toStreet[0] * ey - toStreet[1] * ex;
      if (Math.abs(den) < 1e-6) continue;
      const t = ((a[0] - origin[0]) * ey - (a[1] - origin[1]) * ex) / den;
      const u = ((a[0] - origin[0]) * toStreet[1] - (a[1] - origin[1]) * toStreet[0]) / den;
      if (u < -0.05 || u > 1.05 || t < 0.5 || t > p.depth + 8) continue;
      if (best === undefined || t < best) best = t;
    }
  }
  if (best !== undefined) depth = best;
  return { origin, toStreet, width: p.width, depth };
}

/** Ворота своего забора (нарисованного в редакторе): на ломаной line, в точке at (нет — посередине). */
export function ownGate(
  line: readonly Vec2[],
  o: { at?: Vec2; gate?: boolean; wicket?: boolean; wicketSide?: -1 | 1; canopy?: boolean },
  look: { style: FenceStyle; color: string },
): { gate: EstateGate; cut: [number, number] } | undefined {
  const G = o.gate ? NEW_GATE : 0;
  const W = o.wicket ? NEW_WICKET : 0;
  if (!G && !W || line.length < 2) return undefined;
  const total = length(line);
  const half = (G + W + (G && W ? 0.2 : 0)) / 2;
  if (total < 2 * half + 0.4) return undefined;
  const s0 = o.at ? arcPosition(line, o.at).s : total / 2;
  const s = Math.min(Math.max(s0, half + 0.2), total - half - 0.2);
  const { point, dir } = pointAt(line, s);
  return {
    gate: { at: point, along: dir, inward: [-dir[1], dir[0]], gate: G, wicket: W, wicketSide: o.wicketSide ?? 1, canopy: !!o.canopy, style: look.style, color: look.color },
    cut: [s - half - 0.05, s + half + 0.05],
  };
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
