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
  /** Контур произвольный (участок с карты): углы двигаются по одному, а не растягивают прямоугольник. */
  free?: boolean;
  /** Участок взят с карты: id дома, вокруг которого он нарисован. */
  source?: string;
  /** Дом и постройки с карты, которые ещё не в правках (рисуются с карты): id и роль. */
  mapMembers?: { id: string; role: PlotRole }[];
}

/** Участок с карты (ещё не в правках): контур вокруг жилого дома, дом и дворовые постройки внутри. */
/** Дом или постройка с карты на участке: id, роль и прямоугольник (локальные метры). */
export interface MapMember {
  id: string;
  role: PlotRole;
  rect: Vec2[];
}

export interface MapPlot {
  /** `map:<id дома>`. */
  id: string;
  house: string;
  /** Локальные метры, против часовой, сторона 0 — к улице. */
  outline: Vec2[];
  /** Дом и дворовые постройки с карты внутри. */
  members: MapMember[];
}

/** Id участка, взятого с карты, по id дома. */
export const mapPlotId = (house: string) => `plot-${house.replace(/[^\w-]/g, '_')}`;

/** Ворота с калиткой — в середину самого длинного свободного от построек отрезка улицы (сторона 0). */
export function streetGates(outline: readonly Vec2[], footprints: readonly (readonly Vec2[])[]): FenceGateSpec[] {
  const [a, b] = outline as [Vec2, Vec2];
  const W = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const d: Vec2 = [(b[0] - a[0]) / W, (b[1] - a[1]) / W];
  const n: Vec2 = [-d[1], d[0]];
  const busy = footprints
    .filter((fp) => Math.min(...fp.map((p) => (p[0] - a[0]) * n[0] + (p[1] - a[1]) * n[1])) < ON_EDGE_M)
    .map((fp) => {
      const u = fp.map((p) => (p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]);
      return [Math.max(0, Math.min(...u)), Math.min(W, Math.max(...u))] as [number, number];
    })
    .sort((x, y) => x[0] - y[0]);
  let gateAt = W / 2, room = 0, at = 0.5;
  for (const [u0, u1] of [...busy, [W - 0.5, W] as [number, number]]) {
    if (u0 - at > room) {
      room = u0 - at;
      gateAt = (at + u0) / 2;
    }
    at = Math.max(at, u1);
  }
  return room >= 5.5 ? [{ kind: 'combo', at: gateAt }] : room >= 1.6 ? [{ kind: 'wicket', at: gateAt }] : [];
}

/**
 * Шаблон «Деревенский двор» на участке с карты: объекты с карты — ориентир. Каждый объект шаблона (дом,
 * гараж, баня, сарай) встаёт на свой объект с карты: если таких несколько — на тот, что ближе всего к месту
 * по шаблону; чего на карте нет — того нет и на участке; лишние постройки с карты убираются.
 */
export function templateMembers(plot: MapPlot): { keep: MapMember[]; drop: string[] } {
  const f = plotFrame(plot.outline);
  const keep: MapMember[] = [];
  for (const role of PLOT_TEMPLATES.yard.roles) {
    const candidates = plot.members.filter((m) => m.role === role);
    if (!candidates.length) continue;
    const [u0, u1, v0, v1] = rolePlace('yard', role, f.width, f.depth);
    const spot = plotPoint(f, (u0 + u1) / 2, (v0 + v1) / 2);
    const centre = (r: readonly Vec2[]) => [r.reduce((s, p) => s + p[0], 0) / r.length, r.reduce((s, p) => s + p[1], 0) / r.length];
    const best = candidates.reduce((a, b) => {
      const [ax, ay] = centre(a.rect), [bx, by] = centre(b.rect);
      return Math.hypot(ax - spot[0], ay - spot[1]) <= Math.hypot(bx - spot[0], by - spot[1]) ? a : b;
    });
    keep.push(best);
  }
  const kept = new Set(keep.map((m) => m.id));
  return { keep, drop: plot.members.filter((m) => !kept.has(m.id)).map((m) => m.id) };
}

/** Ворота с калиткой — у каждого двора: в самом широком свободном месте улицы, а если места нет — посередине. */
export function yardGates(outline: readonly Vec2[], footprints: readonly (readonly Vec2[])[]): FenceGateSpec[] {
  const found = streetGates(outline, footprints);
  if (found.length && found[0]!.kind === 'combo') return found;
  const [a, b] = outline as [Vec2, Vec2];
  const W = Math.hypot(b[0] - a[0], b[1] - a[1]);
  return [{ kind: 'combo', at: found[0]?.at ?? W / 2 }];
}

/**
 * Взять участки с карты в правки по шаблону (templateMembers): контур, ворота с калиткой, постройки с карты,
 * ставшие объектами шаблона (mapMembers — рисуются с карты, пока их не тронут); лишние постройки с карты
 * прячутся. Уже взятые участки с карты перестраиваются по тому же правилу. hidden — заборы и дворы,
 * которые участки заменяют.
 */
export function adoptMapPlots(
  edits: Edits,
  plots: readonly MapPlot[],
  frame: LocalFrame,
  hidden: { fences?: readonly string[]; yards?: readonly string[] } = {},
): Edits {
  const existing = new Map((edits.plots ?? []).map((p) => [p.id, p]));
  const removed = new Set(edits.removedBuildings);
  const drop: string[] = [];
  const next = new Map<string, EditedPlot>();
  for (const plot of plots) {
    const id = mapPlotId(plot.house);
    const own = existing.get(id);
    // Участок, у которого постройки уже перешли в правки (двигали, крутили), не трогаем.
    if (own && !own.mapMembers?.length && edits.buildings.some((b) => b.plot === id)) continue;
    const { keep, drop: extra } = templateMembers({ ...plot, members: plot.members.filter((m) => !removed.has(m.id)) });
    drop.push(...extra);
    next.set(id, {
      ...(own ?? {}),
      id,
      outline: own?.outline ?? (plot.outline.map(frame.toLonLat) as LonLat[]),
      template: 'yard',
      fence: { ...(own?.fence ?? {}), gates: yardGates(plot.outline, keep.map((m) => m.rect)) },
      free: true,
      source: plot.house,
      mapMembers: keep.map((m) => ({ id: m.id, role: m.role })),
    });
  }
  if (!next.size) return edits;
  return {
    ...edits,
    plots: [...(edits.plots ?? []).filter((p) => !next.has(p.id)), ...next.values()],
    removedBuildings: drop.length ? [...new Set([...edits.removedBuildings, ...drop])] : edits.removedBuildings,
    // Прежние заборы (с карты или «обустроенного посёлка») прячутся — теперь заборы участков.
    removedFences: [...new Set([...(edits.removedFences ?? []), ...(hidden.fences ?? [])])],
    removedYards: [...new Set([...edits.removedYards, ...(hidden.yards ?? [])])],
  };
}

/**
 * Перевести постройки с карты участка в правки (перед переносом или поворотом участка): resolve — дом как
 * правка (дом OSM или постройка во дворе с моделью). Уже изменённые и убранные пропускаются.
 */
export function materializePlot(edits: Edits, plotId: string, resolve: (id: string) => EditedBuilding | undefined): Edits {
  const plot = edits.plots?.find((p) => p.id === plotId);
  if (!plot?.mapMembers?.length) return edits;
  const removed = new Set(edits.removedBuildings);
  const added = plot.mapMembers.flatMap((m) => {
    if (removed.has(m.id)) return [];
    const b = resolve(m.id);
    return b ? [{ ...b, plot: plotId, plotRole: m.role }] : [];
  });
  return {
    ...edits,
    plots: (edits.plots ?? []).map((p) => (p.id === plotId ? { ...p, mapMembers: [] } : p)),
    buildings: [...edits.buildings.filter((b) => !added.some((a) => a.id === b.id)), ...added],
    removedBuildings: [...new Set([...edits.removedBuildings, ...added.map((b) => b.source ?? b.id)])],
  };
}

/** Рамка участка в метрах: угол, направление вдоль улицы, вглубь, ширина и глубина. */
export interface PlotFrame {
  origin: Vec2;
  along: Vec2;
  inward: Vec2;
  width: number;
  depth: number;
}

/**
 * Рамка участка: от угла 0 вдоль улицы (сторона 0 → 1) и вглубь (влево от неё, обход против часовой).
 * У прямоугольника — его стороны; у многоугольника с карты — ширина по улице и глубина до дальней точки.
 */
export function plotFrame(local: readonly Vec2[]): PlotFrame {
  const [a, b] = local as [Vec2, Vec2];
  const width = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const along: Vec2 = [(b[0] - a[0]) / width, (b[1] - a[1]) / width];
  const inward: Vec2 = [-along[1], along[0]];
  const depth = Math.max(1, ...local.map((p) => (p[0] - a[0]) * inward[0] + (p[1] - a[1]) * inward[1]));
  return { origin: a, along, inward, width, depth };
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
  if (!on) {
    // Постройки с карты этой роли прячутся.
    const gone = (plot.mapMembers ?? []).filter((m) => m.role === role).map((m) => m.id);
    return {
      ...edits,
      buildings: others,
      plots: (edits.plots ?? []).map((p) => (p.id === plotId ? { ...p, mapMembers: (p.mapMembers ?? []).filter((m) => m.role !== role) } : p)),
      removedBuildings: gone.length ? [...new Set([...edits.removedBuildings, ...gone])] : edits.removedBuildings,
    };
  }
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
  const mapIds = (edits.plots?.find((p) => p.id === plotId)?.mapMembers ?? []).map((m) => m.id);
  return {
    ...edits,
    removedBuildings: withContents && mapIds.length ? [...new Set([...edits.removedBuildings, ...mapIds])] : edits.removedBuildings,
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
  const corners = local as Vec2[];
  const N = corners.length;
  const sides = corners.map((a, i) => [a, corners[(i + 1) % N]!] as [Vec2, Vec2]);
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
    while (i < N - 1 && x > start[i + 1]!) i++;
    const [a, b] = sides[i]!;
    const t = (x - start[i]!) / lengths[i]!;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  };
  const closedRing = free.length === 1 && free[0]![1] - free[0]![0] >= perimeter - 1e-6;
  return free.map(([m0, m1]) => {
    // Линия куска: начало, углы внутри, конец.
    const line: Vec2[] = [pointAt(m0)];
    for (let k = -N; k <= 2 * N; k++) {
      const c = start[((k % N) + N) % N]! + Math.floor(k / N) * perimeter;
      if (c > m0 + 1e-6 && c < m1 - 1e-6) line.push(pointAt(c));
    }
    line.push(closedRing ? pointAt(m0) : pointAt(m1));
    // Ворота на улице (сторона 0, u от угла 0) — если попали в этот кусок.
    const own = gates.filter((g) => g.at > m0 && g.at < m1).map((g) => ({ ...g, at: g.at - m0 }));
    return { line, gates: own };
  });
}

/** Заборы всех участков — как обычные заборы (для отрисовки); id — `plot:<участок>:<n>`. */
export function plotFences(edits: Edits, frame: LocalFrame, mapFootprint?: (id: string) => readonly Vec2[] | undefined): EditedFence[] {
  const removed = new Set(edits.removedBuildings);
  return (edits.plots ?? []).flatMap((p) => {
    const local = p.outline.map(frame.toLocal);
    const footprints = [
      ...edits.buildings.filter((b) => b.plot === p.id).map((b) => b.footprint.map(frame.toLocal)),
      // Постройки с карты (не убранные и не перешедшие в правки).
      ...(p.mapMembers ?? []).flatMap((m) => {
        const fp = !removed.has(m.id) ? mapFootprint?.(m.id) : undefined;
        return fp ? [fp] : [];
      }),
    ];
    return plotFenceLines(local, footprints, p.fence.gates).map(({ line, gates }, n) => ({
      id: `plot:${p.id}:${n}`,
      line: line.map(frame.toLonLat) as LonLat[],
      ...(p.fence.kind ? { kind: p.fence.kind } : {}),
      ...(p.fence.color ? { color: p.fence.color } : {}),
      gates,
    }));
  });
}

/** Точка внутри участка (локальные метры), любой многоугольник. */
export function insidePlot(local: readonly Vec2[], p: Vec2): boolean {
  let inside = false;
  for (let i = 0, j = local.length - 1; i < local.length; j = i++) {
    const a = local[i]!, b = local[j]!;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/**
 * Контур участка с карты → как у шаблона: против часовой, сторона 0 — ближайшая к дороге (улица).
 * roads — оси дорог в тех же локальных метрах.
 */
export function orientPlot(outline: readonly Vec2[], roads: readonly (readonly Vec2[])[]): Vec2[] {
  let ring = [...outline];
  const area = ring.reduce((s, p, i) => s + p[0] * ring[(i + 1) % ring.length]![1] - ring[(i + 1) % ring.length]![0] * p[1], 0);
  if (area < 0) ring = ring.reverse();
  let best = 0, bestD = Number.POSITIVE_INFINITY;
  ring.forEach((a, i) => {
    const b = ring[(i + 1) % ring.length]!;
    // Короткие стороны (срезанные углы) улицей не считаются.
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 4) return;
    const m: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    for (const road of roads) {
      for (let k = 1; k < road.length; k++) {
        const p = road[k - 1]!, q = road[k]!;
        const dx = q[0] - p[0], dy = q[1] - p[1], l2 = dx * dx + dy * dy || 1;
        const t = Math.min(1, Math.max(0, ((m[0] - p[0]) * dx + (m[1] - p[1]) * dy) / l2));
        const d = Math.hypot(p[0] + dx * t - m[0], p[1] + dy * t - m[1]);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    }
  });
  return ring.map((_, k) => ring[(best + k) % ring.length]!);
}

/** Сменить шаблон: постройки и деревья участка встают заново по новому шаблону и текущему размеру. */
export function applyTemplate(edits: Edits, plotId: string, template: PlotTemplate, frame: LocalFrame): Edits {
  const plot = edits.plots?.find((p) => p.id === plotId);
  if (!plot) return edits;
  const local = plot.outline.map(frame.toLocal);
  const cleared: Edits = {
    ...edits,
    removedBuildings: [...new Set([...edits.removedBuildings, ...(plot.mapMembers ?? []).map((m) => m.id)])],
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

/** Роль постройки на участке по её модели: баня, гараж, сарай, теплица, колодец; жилые — дом. */
export function roleOfModel(model: string | undefined): PlotRole {
  if (model === 'banya' || model === 'garage' || model === 'shed' || model === 'greenhouse' || model === 'well') return model;
  return 'house';
}

/**
 * Участок по обводке (замкнутый контур в локальных метрах, сторона к улице — первая): внутри — то, что
 * обвели. inside — постройки, чья середина внутри контура: с карты (рисуются с карты, mapMembers) и свои
 * (помечаются участком); жилой дом — один (самый большой), остальные жилые — как сараи. Свои деревья
 * внутри тоже становятся деревьями участка. Ворота с калиткой — на улице.
 */
export function plotFromOutline(
  edits: Edits,
  id: string,
  outline: readonly Vec2[],
  inside: { map: readonly MapMember[]; own: readonly { id: string; model?: string; rect: readonly Vec2[] }[] },
  frame: LocalFrame,
): Edits {
  const area = (r: readonly Vec2[]) => Math.abs(r.reduce((s, p, i) => s + p[0] * r[(i + 1) % r.length]![1] - r[(i + 1) % r.length]![0] * p[1], 0)) / 2;
  type Pick = { id: string; role: PlotRole; rect: readonly Vec2[]; own: boolean };
  const all: Pick[] = [
    ...inside.map.map((m) => ({ id: m.id, role: m.role, rect: m.rect, own: false })),
    ...inside.own.map((b) => ({ id: b.id, role: roleOfModel(b.model), rect: b.rect, own: true })),
  ];
  // Жилой дом на участке один — самый большой; остальные «дома» (летняя кухня, пристройка) — сараи.
  const houses = all.filter((p) => p.role === 'house').sort((a, b) => area(b.rect) - area(a.rect));
  for (const extra of houses.slice(1)) extra.role = 'shed';
  const ownRole = new Map(all.filter((p) => p.own).map((p) => [p.id, p.role]));
  const ring = [...outline];
  const plot: EditedPlot = {
    id,
    outline: ring.map(frame.toLonLat) as LonLat[],
    template: 'yard',
    fence: { gates: yardGates(ring, all.map((p) => p.rect)) },
    free: true,
    mapMembers: all.filter((p) => !p.own).map((p) => ({ id: p.id, role: p.role })),
  };
  return {
    ...edits,
    plots: [...(edits.plots ?? []), plot],
    buildings: edits.buildings.map((b) => (ownRole.has(b.id) ? { ...b, plot: id, plotRole: ownRole.get(b.id)! } : b)),
    trees: (edits.trees ?? []).map((t) => (!t.plot && insidePlot(ring, frame.toLocal(t.at)) ? { ...t, plot: id } : t)),
  };
}
