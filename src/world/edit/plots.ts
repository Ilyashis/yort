// Участки-шаблоны: прямоугольник участка (одна сторона — к улице) и что на нём стоит — дом, гараж, баня,
// сарай, теплица, колодец, деревья. Постройки и деревья — обычные правки (дома-модели и свои деревья),
// помеченные участком: их правят, двигают и крутят как любой дом. Забор по периметру не хранится, а
// считается: граница участка минус отрезки, где на ней стоят постройки (обычно дом и гараж выходят на
// улицу, забор упирается в их стены). Отодвинули дом от границы — забор сам закрыл щель.
//
// Оси участка: u — вдоль улицы, слева направо, если смотреть с улицы на участок (0 — левый угол),
// v — вглубь от улицы (0 — линия улицы). Чистые функции; координаты — локальные метры и lon/lat.

import { hashString } from '../../utils/hash';
import type { FenceGateSpec } from '../base/fenceGates';
import type { HouseModelId } from '../village/houseModels';
import type { LocalFrame, Vec2 } from '../walk/localFrame';
import type { EditedBuilding, EditedFence, EditedTree, Edits, FenceKind, LonLat } from './edits';

export type PlotTemplate = 'yard' | 'dacha' | 'empty';
export type PlotRole = 'house' | 'garage' | 'banya' | 'shed' | 'greenhouse' | 'well';

export const PLOT_ROLES: Record<PlotRole, { label: string; model: HouseModelId; size: [number, number] }> = {
  house: { label: 'Дом', model: 'izba', size: [6.6, 7.2] },
  garage: { label: 'Гараж', model: 'garage', size: [4, 6] },
  banya: { label: 'Баня', model: 'banya', size: [3.6, 4.6] },
  shed: { label: 'Сарай', model: 'shed', size: [4.5, 3.6] },
  greenhouse: { label: 'Теплица', model: 'greenhouse', size: [3, 5] },
  well: { label: 'Колодец', model: 'well', size: [1.8, 1.8] },
};
export const PLOT_ROLE_ORDER: PlotRole[] = ['house', 'garage', 'banya', 'shed', 'greenhouse', 'well'];

export const PLOT_TEMPLATES: Record<PlotTemplate, { label: string; hint: string; size: [number, number]; roles: PlotRole[]; trees: number }> = {
  yard: {
    label: 'Деревенский двор',
    hint: 'Дом и гараж на линии улицы, между ними ворота с калиткой, палисадник перед домом, баня в дальнем углу, сарай, яблони',
    size: [22, 38],
    roles: ['house', 'garage', 'banya', 'shed'],
    trees: 3,
  },
  dacha: { label: 'Дача', hint: 'Небольшой дом в глубине, баня и теплица, сад', size: [16, 26], roles: ['house', 'banya', 'greenhouse'], trees: 4 },
  empty: { label: 'Пустой', hint: 'Только забор с воротами и калиткой', size: [20, 30], roles: [], trees: 0 },
};
export const PLOT_TEMPLATE_ORDER: PlotTemplate[] = ['yard', 'dacha', 'empty'];

export interface EditedPlot {
  id: string;
  /** Углы против часовой, первая сторона (0 → 1) — по улице, угол 0 — левый, если смотреть с улицы. */
  outline: LonLat[];
  template: PlotTemplate;
  fence: { kind?: FenceKind; color?: string; gates: FenceGateSpec[] };
}

/** Рамка участка в метрах: угол, направление вдоль улицы, вглубь, ширина и глубина. */
export interface PlotFrame {
  origin: Vec2;
  along: Vec2;
  inward: Vec2;
  width: number;
  depth: number;
}

export function plotFrame(local: readonly Vec2[]): PlotFrame {
  const [a, b, , d] = local as [Vec2, Vec2, Vec2, Vec2];
  const width = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const depth = Math.hypot(d[0] - a[0], d[1] - a[1]) || 1;
  return { origin: a, along: [(b[0] - a[0]) / width, (b[1] - a[1]) / width], inward: [(d[0] - a[0]) / depth, (d[1] - a[1]) / depth], width, depth };
}

export const plotPoint = (f: PlotFrame, u: number, v: number): Vec2 => [f.origin[0] + f.along[0] * u + f.inward[0] * v, f.origin[1] + f.along[1] * u + f.inward[1] * v];

/** Прямоугольник постройки [u0, u1] × [v0, v1]: против часовой, первая сторона — к улице (фасад). */
export function plotRect(f: PlotFrame, u0: number, u1: number, v0: number, v1: number): Vec2[] {
  return [plotPoint(f, u0, v0), plotPoint(f, u1, v0), plotPoint(f, u1, v1), plotPoint(f, u0, v1)];
}

/** Где по шаблону стоит постройка (u0, u1, v0, v1) на участке W × D. */
export function rolePlace(template: PlotTemplate, role: PlotRole, W: number, D: number): [number, number, number, number] {
  const [w, d] = PLOT_ROLES[role].size;
  if (template === 'dacha') {
    switch (role) {
      case 'house':
        return [W / 2 - w / 2, W / 2 + w / 2, D * 0.45, D * 0.45 + d];
      case 'banya':
        return [0.8, 0.8 + w, 1.5, 1.5 + d];
      case 'greenhouse':
        return [W - 0.8 - w, W - 0.8, 2, 2 + d];
      case 'garage':
        return [0, w, 0, d];
      case 'shed':
        return [W - w, W, D - d, D];
      case 'well':
        return [W / 2 - 0.9, W / 2 + 0.9, D * 0.3, D * 0.3 + 1.8];
    }
  }
  switch (role) {
    // Дом и гараж — на линии улицы, к боковым границам: забор упирается в их стены.
    case 'house':
      return [W - w, W, 0, d];
    case 'garage':
      return [0, w, 0, d];
    // Баня — в дальнем правом углу, с отступом.
    case 'banya':
      return [W - 1 - w, W - 1, D - 1 - d, D - 1];
    // Сарай — у левой границы за гаражом.
    case 'shed':
      return [0, w, PLOT_ROLES.garage.size[1] + 3, PLOT_ROLES.garage.size[1] + 3 + d];
    case 'greenhouse':
      return [W / 2 - w / 2, W / 2 + w / 2, D * 0.62, D * 0.62 + d];
    case 'well':
      return [W / 2 - 0.9, W / 2 + 0.9, D * 0.35, D * 0.35 + 1.8];
  }
}

/** Ворота по шаблону: между гаражом и домом (у дачи — посередине). */
export function defaultGates(template: PlotTemplate, W: number): FenceGateSpec[] {
  if (template === 'yard') {
    const left = PLOT_ROLES.garage.size[0], right = W - PLOT_ROLES.house.size[0];
    return [{ kind: right - left >= 6 ? 'combo' : 'wicket', at: (left + right) / 2 }];
  }
  return [{ kind: W >= 12 ? 'combo' : 'wicket', at: W / 2 }];
}

/** Постройка участка: дом-модель по прямоугольнику, помеченная участком и ролью. */
function roleBuilding(plotId: string, role: PlotRole, rect: Vec2[], frame: LocalFrame): EditedBuilding {
  const footprint = rect.map(frame.toLonLat) as LonLat[];
  const seed = 1 + (hashString(`${plotId}:${role}`) % 9973);
  return {
    id: `${plotId}-${role}`,
    kind: role === 'house' ? 'house' : 'shed',
    footprint,
    floors: 1,
    roof: 'gabled',
    facadeColor: '#c4ad86',
    roofColor: '#6b7176',
    model: { id: PLOT_ROLES[role].model, seed },
    // Палисадник — только у дома, перед уличным фасадом.
    garden: role === 'house' ? 0 : -1,
    plot: plotId,
    plotRole: role,
  };
}

/** Новый участок по шаблону: прямоугольник (локальные метры, первая сторона — улица), постройки, деревья. */
export function createPlot(edits: Edits, id: string, local: readonly Vec2[], template: PlotTemplate, frame: LocalFrame): Edits {
  const f = plotFrame(local);
  const t = PLOT_TEMPLATES[template];
  const plot: EditedPlot = { id, outline: local.map(frame.toLonLat) as LonLat[], template, fence: { gates: defaultGates(template, f.width) } };
  const buildings = t.roles.map((role) => {
    const [u0, u1, v0, v1] = rolePlace(template, role, f.width, f.depth);
    return roleBuilding(id, role, plotRect(f, u0, u1, v0, v1), frame);
  });
  // Яблони — рядком в глубине участка, между постройками.
  const trees: EditedTree[] = Array.from({ length: t.trees }, (_, k) => {
    const u = (f.width * (k + 1)) / (t.trees + 1);
    const v = f.depth * (template === 'dacha' ? 0.82 : 0.72) + (k % 2) * 2.5;
    return { id: `${id}-tree-${k}`, at: frame.toLonLat(plotPoint(f, u, v)), kind: 'apple', scale: 0.85, plot: id };
  });
  return {
    ...edits,
    plots: [...(edits.plots ?? []), plot],
    buildings: [...edits.buildings, ...buildings],
    trees: [...(edits.trees ?? []), ...trees],
  };
}

/** Включить или убрать постройку участка (на место по шаблону и текущему размеру). */
export function setPlotRole(edits: Edits, plotId: string, role: PlotRole, on: boolean, frame: LocalFrame): Edits {
  const plot = edits.plots?.find((p) => p.id === plotId);
  if (!plot) return edits;
  const others = edits.buildings.filter((b) => !(b.plot === plotId && b.plotRole === role));
  if (!on) return { ...edits, buildings: others };
  const f = plotFrame(plot.outline.map(frame.toLocal));
  const [u0, u1, v0, v1] = rolePlace(plot.template, role, f.width, f.depth);
  return { ...edits, buildings: [...others, roleBuilding(plotId, role, plotRect(f, u0, u1, v0, v1), frame)] };
}

/** Сдвинуть или повернуть участок вместе со всем, что на нём стоит: transform — для локальной точки. */
export function transformPlot(edits: Edits, plotId: string, transform: (p: Vec2) => Vec2, frame: LocalFrame): Edits {
  const move = (p: LonLat) => frame.toLonLat(transform(frame.toLocal(p)));
  return {
    ...edits,
    plots: (edits.plots ?? []).map((p) => (p.id === plotId ? { ...p, outline: p.outline.map(move) } : p)),
    buildings: edits.buildings.map((b) => (b.plot === plotId ? { ...b, footprint: b.footprint.map(move) } : b)),
    trees: (edits.trees ?? []).map((t) => (t.plot === plotId ? { ...t, at: move(t.at) } : t)),
  };
}

/** Новый контур участка (растянули): постройки и деревья остаются на местах; ворота — на той же доле улицы. */
export function resizePlot(edits: Edits, plotId: string, local: readonly Vec2[], frame: LocalFrame): Edits {
  return {
    ...edits,
    plots: (edits.plots ?? []).map((p) => {
      if (p.id !== plotId) return p;
      const before = plotFrame(p.outline.map(frame.toLocal));
      const after = plotFrame(local);
      // Ворота стоят на том же месте улицы (u — от левого угла): сдвигаем на столько, на сколько уехал угол.
      const shift = (after.origin[0] - before.origin[0]) * after.along[0] + (after.origin[1] - before.origin[1]) * after.along[1];
      const gates = p.fence.gates.map((g) => ({ ...g, at: Math.min(after.width - 0.5, Math.max(0.5, g.at - shift)) }));
      return { ...p, outline: local.map(frame.toLonLat) as LonLat[], fence: { ...p.fence, gates } };
    }),
  };
}

/** Убрать участок; withContents — вместе с постройками и деревьями (иначе они остаются сами по себе). */
export function removePlot(edits: Edits, plotId: string, withContents: boolean): Edits {
  const free = <T extends { plot?: string }>(x: T): T => {
    const { plot: _p, ...rest } = x as T & { plotRole?: unknown };
    delete (rest as { plotRole?: unknown }).plotRole;
    return rest as T;
  };
  return {
    ...edits,
    plots: (edits.plots ?? []).filter((p) => p.id !== plotId),
    buildings: withContents ? edits.buildings.filter((b) => b.plot !== plotId) : edits.buildings.map((b) => (b.plot === plotId ? free(b) : b)),
    trees: withContents ? (edits.trees ?? []).filter((t) => t.plot !== plotId) : (edits.trees ?? []).map((t) => (t.plot === plotId ? free(t) : t)),
  };
}

/** Постройка стоит на границе, если её стена ближе этого к линии участка, м. */
const ON_EDGE_M = 0.8;
/** Обрезки забора короче этого не ставим, м. */
const MIN_PIECE_M = 0.4;

/**
 * Забор участка: периметр минус отрезки, где на границе стоят постройки (их стена ближе ON_EDGE_M к
 * линии). Ворота (u — по улице от левого угла) встают на тот кусок, куда попали. Линии — локальные метры.
 */
export function plotFenceLines(local: readonly Vec2[], footprints: readonly (readonly Vec2[])[], gates: readonly FenceGateSpec[]): { line: Vec2[]; gates: FenceGateSpec[] }[] {
  const corners = local.slice(0, 4) as Vec2[];
  const sides = corners.map((a, i) => [a, corners[(i + 1) % 4]!] as [Vec2, Vec2]);
  const lengths = sides.map(([a, b]) => Math.hypot(b[0] - a[0], b[1] - a[1]));
  const perimeter = lengths.reduce((s, l) => s + l, 0);
  const start = lengths.map((_, i) => lengths.slice(0, i).reduce((s, l) => s + l, 0));
  // Занятые постройками отрезки периметра (в метрах от угла 0).
  const covered: [number, number][] = [];
  sides.forEach(([a, b], i) => {
    const L = lengths[i]!;
    const d: Vec2 = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
    // Внутрь участка — влево от стороны (обход против часовой).
    const inward: Vec2 = [-d[1], d[0]];
    for (const fp of footprints) {
      const across = fp.map((p) => (p[0] - a[0]) * inward[0] + (p[1] - a[1]) * inward[1]);
      if (Math.min(...across) > ON_EDGE_M || Math.max(...across) < -ON_EDGE_M) continue;
      const along = fp.map((p) => (p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]);
      const t0 = Math.max(0, Math.min(...along)), t1 = Math.min(L, Math.max(...along));
      if (t1 - t0 > 0.05) covered.push([start[i]! + t0, start[i]! + t1]);
    }
  });
  covered.sort((x, y) => x[0] - y[0]);
  const merged: [number, number][] = [];
  for (const c of covered) {
    const last = merged[merged.length - 1];
    if (last && c[0] <= last[1] + 0.05) last[1] = Math.max(last[1], c[1]);
    else merged.push([...c]);
  }
  // Свободные куски периметра; кусок через угол 0 (конец и начало обхода) — один.
  const free: [number, number][] = [];
  let s = 0;
  for (const [c0, c1] of merged) {
    if (c0 - s > MIN_PIECE_M) free.push([s, c0]);
    s = Math.max(s, c1);
  }
  if (perimeter - s > MIN_PIECE_M) free.push([s, perimeter]);
  if (free.length > 1 && free[0]![0] === 0 && free[free.length - 1]![1] === perimeter) {
    const last = free.pop()!;
    free[0] = [last[0] - perimeter, free[0]![1]];
  }
  if (!free.length && !merged.length) free.push([0, perimeter]);
  const pointAt = (m: number): Vec2 => {
    const x = ((m % perimeter) + perimeter) % perimeter;
    let i = 0;
    while (i < 3 && x > start[i + 1]!) i++;
    const [a, b] = sides[i]!;
    const t = (x - start[i]!) / lengths[i]!;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  };
  const closedRing = free.length === 1 && free[0]![1] - free[0]![0] >= perimeter - 1e-6;
  return free.map(([m0, m1]) => {
    // Линия куска: начало, углы внутри, конец.
    const line: Vec2[] = [pointAt(m0)];
    for (let k = -1; k <= 4; k++) {
      const c = start[((k % 4) + 4) % 4]! + (k < 0 ? -perimeter : k >= 4 ? perimeter : 0);
      if (c > m0 + 1e-6 && c < m1 - 1e-6) line.push(pointAt(c));
    }
    line.push(closedRing ? pointAt(m0) : pointAt(m1));
    // Ворота на улице (сторона 0, u от угла 0) — если попали в этот кусок.
    const own = gates.filter((g) => g.at > m0 && g.at < m1).map((g) => ({ ...g, at: g.at - m0 }));
    return { line, gates: own };
  });
}

/** Заборы всех участков — как обычные заборы (для отрисовки); id — `plot:<участок>:<n>`. */
export function plotFences(edits: Edits, frame: LocalFrame): EditedFence[] {
  return (edits.plots ?? []).flatMap((p) => {
    const local = p.outline.map(frame.toLocal);
    const footprints = edits.buildings.filter((b) => b.plot === p.id).map((b) => b.footprint.map(frame.toLocal));
    return plotFenceLines(local, footprints, p.fence.gates).map(({ line, gates }, n) => ({
      id: `plot:${p.id}:${n}`,
      line: line.map(frame.toLonLat) as LonLat[],
      ...(p.fence.kind ? { kind: p.fence.kind } : {}),
      ...(p.fence.color ? { color: p.fence.color } : {}),
      gates,
    }));
  });
}

/** Точка внутри участка (локальные метры). */
export function insidePlot(local: readonly Vec2[], p: Vec2): boolean {
  const f = plotFrame(local);
  const dx = p[0] - f.origin[0], dy = p[1] - f.origin[1];
  const u = dx * f.along[0] + dy * f.along[1], v = dx * f.inward[0] + dy * f.inward[1];
  return u >= 0 && u <= f.width && v >= 0 && v <= f.depth;
}

/** Сменить шаблон: постройки и деревья участка встают заново по новому шаблону и текущему размеру. */
export function applyTemplate(edits: Edits, plotId: string, template: PlotTemplate, frame: LocalFrame): Edits {
  const plot = edits.plots?.find((p) => p.id === plotId);
  if (!plot) return edits;
  const local = plot.outline.map(frame.toLocal);
  const cleared: Edits = {
    ...edits,
    plots: (edits.plots ?? []).filter((p) => p.id !== plotId),
    buildings: edits.buildings.filter((b) => !(b.plot === plotId && b.plotRole)),
    trees: (edits.trees ?? []).filter((t) => t.plot !== plotId),
  };
  const made = createPlot(cleared, plotId, local, template, frame);
  // Вид и цвет забора — как были; ворота — по новому шаблону.
  return { ...made, plots: (made.plots ?? []).map((p) => (p.id === plotId ? { ...p, fence: { ...plot.fence, gates: p.fence.gates } } : p)) };
}

/** Ширина и глубина участка, м. */
export function plotSize(plot: EditedPlot, frame: LocalFrame): [number, number] {
  const f = plotFrame(plot.outline.map(frame.toLocal));
  return [f.width, f.depth];
}
