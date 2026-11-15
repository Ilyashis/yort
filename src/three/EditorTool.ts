// Редактор в сцене three.js — как в градостроителях: «Дом» — тяни по земле, дом вырастает под
// участок (вдоль улицы); «Дорога» и «Забор» — веди линию, как карандашом (дорога прилипает к
// соседним); «Выбор» — клик по дому, дороге или забору; дом тянут, поворачивают и растягивают за ручки.
// Клавиши: V/Y/T/B — инструменты, Delete/Backspace — удалить выделенное, Ctrl+Z / Ctrl+Shift+Z (Ctrl+Y) —
// отмена и повтор, Esc — отменить совмещение подложки, перетаскивание, выделение или инструмент.
//
// Открытый интерфейс:
//   new EditorTool(ctx: EditorContext) — слушает мышь на city.canvas и клавиатуру на window;
//   resolve(id)       — дом для правки: уже изменённый или дом OSM в виде правки (для useEditStore.setResolver);
//   applyModel(b, m)  — дом-модель на месте дома: прямоугольник контура, фасад к ближайшей улице (или без модели);
//   deleteSelection() — удалить выделенное;
//   destroy().

import { booleanIntersects, point, polygon } from '@turf/turf';
import { Vector3 } from 'three';
import { useAppStore } from '../store/useAppStore';
import { useEditStore, type EditTool } from '../store/useEditStore';
import { useUnderlayStore } from '../store/useUnderlayStore';
import { hashString } from '../utils/hash';
import type { BaseBuildingFeature } from '../world/base/types';
import type { Yard } from '../world/base/yards';
import { distanceAlong, placeGates, type FenceGateSpec } from '../world/base/fenceGates';
import {
  ROAD_KINDS,
  TREE_KINDS,
  footprintCorners,
  type Edits,
  TREE_SIZES,
  addFence,
  adoptFence,
  areaOf,
  centroidOf,
  fromOsm,
  lineLength,
  modelFootprint,
  nearestOnLines,
  newBuilding,
  removeBuilding,
  removeFence,
  removeRoad,
  replacedOsmIds,
  resizeByCorner,
  rotate,
  simplifyLine,
  snapEnds,
  stretchRectangle,
  translate,
  upsertBuilding,
  upsertFence,
  upsertRoad,
  withModel,
  type EditedBuilding,
  type EditedTree,
  type HouseModelRef,
  type LonLat,
} from '../world/edit/edits';
import { findHouseModel, type HouseModelId } from '../world/village/houseModels';
import { removeVertex, segmentLength, snapPoint, treeRow, type Snap } from '../world/edit/snapLine';
import { createPlot, insidePlot, materializePlot, orientPlot, PLOT_TEMPLATES, plotFromOutline, removePlot, resizePlot, roleOfModel, transformPlot, type MapPlot } from '../world/edit/plots';
import { distanceToSegment, type LocalFrame, type Vec2 } from '../world/walk/localFrame';
import type { BuildingsLayer } from './BuildingsLayer';
import type { CityScene } from './CityScene';
import { toLocal2 } from './coords';
import type { EditLayer, Handle } from './EditLayer';
import type { GroundLayer } from './GroundLayer';
import type { VillageModelsLayer } from './VillageModelsLayer';
import { isTypingTarget } from './OverviewControls';

/** Сдвиг курсора меньше этого (px) — клик, а не перетаскивание. */
const CLICK_PX = 5;
/** Дорога «тянется от любой дороги»: начало и конец прилипают к осям ближе этого, м. */
const ROAD_SNAP_M = 10;
/** Точка забора прилипает к соседнему углу или линии ближе этого, px на экране. */
const SNAP_PX = 14;
/** Два щелчка по точке забора быстрее этого — убрать точку, мс. */
const DOUBLE_CLICK_MS = 450;
/** Дом выравнивается по улице, если она ближе этого, м. */
const ALIGN_TO_STREET_M = 60;
const MIN_HOUSE_SIDE = 3;
/** Дом-модель кликом у дороги: фасад не ближе этого к оси улицы, м (полдороги и палисадник). */
const FACADE_SETBACK_M = 6.5;
const HOTKEYS: Record<string, EditTool> = { KeyV: 'select', KeyY: 'house', KeyT: 'road', KeyB: 'fence', KeyN: 'tree', KeyU: 'plot', KeyG: 'terrain' };
/** Улица участка — на таком расстоянии от оси дороги (полдороги и палисадник), м. */
const PLOT_SETBACK_M = 7.5;
/** Меньше этого участок не сжимается, м. */
const MIN_PLOT_SIDE = 6;
/** Ластик деревьев: радиус, м. */
const TREE_ERASE_M = 3;
/** Своё дерево выбирается щелчком ближе этого к его кроне на экране, px. */
const TREE_PICK_PX = 28;

/** Что ставят по точкам: дорогу, забор или обводку участка. */
type LineKind = 'road' | 'fence' | 'plot';

/** Точка экрана (координаты клиента, px). */
type ScreenPoint = [number, number];

type Drag =
  | { type: 'click'; at: ScreenPoint }
  | { type: 'house'; start: Vec2; dir: Vec2; current?: Vec2 }
  | { type: 'line'; kind: LineKind; points: Vec2[]; at: ScreenPoint }
  | { type: 'move'; original: EditedBuilding; start: Vec2; current: EditedBuilding; at: ScreenPoint }
  | { type: 'rotate'; original: EditedBuilding; center: Vec2; startAngle: number; current: EditedBuilding }
  | { type: 'resize'; original: EditedBuilding; index: number; current: EditedBuilding }
  // Свой забор: перенос целиком, перенос одной точки, поворот вокруг середины.
  | { type: 'fmove'; id: string; original: Vec2[]; start: Vec2; current: Vec2[]; at: ScreenPoint }
  | { type: 'fvertex'; id: string; original: Vec2[]; index: number; current: Vec2[]; at: ScreenPoint; inserted?: boolean }
  | { type: 'frotate'; id: string; original: Vec2[]; center: Vec2; startAngle: number; current: Vec2[] }
  | { type: 'fgate'; id: string; line: Vec2[]; index: number; gates: FenceGateSpec[] }
  // Деревья: посадка (щелчок — одно, протяжка — аллея), ластик, перенос своего дерева.
  | { type: 'plant'; points: Vec2[]; at: ScreenPoint }
  | { type: 'erase'; points: Vec2[] }
  | { type: 'tmove'; id: string; start: Vec2; at: ScreenPoint; current?: Vec2 }
  // Участки: новый (щелчок или протяжка), перенос, растяжка за угол, поворот.
  | { type: 'plotnew'; start: Vec2; at: ScreenPoint; current?: Vec2 }
  | { type: 'pmove'; id: string; start: Vec2; at: ScreenPoint; next?: Edits; base?: Edits }
  | { type: 'presize'; id: string; index: number; original: Vec2[]; next?: Edits; free?: boolean }
  | { type: 'protate'; id: string; center: Vec2; startAngle: number; next?: Edits; base?: Edits };

export interface EditorContext {
  city: CityScene;
  frame: LocalFrame;
  base: BuildingsLayer;
  layer: EditLayer;
  ground: GroundLayer;
  /** Мышь камеры (OverviewControls): пока тянем дом или рисуем линию, камера стоит. */
  controls: { setEnabled: (enabled: boolean) => void };
  village: boolean;
  /** Оси дорог OSM (локальные метры) — для прилипания и выравнивания. */
  osmRoads: readonly Vec2[][];
  /** Дома OSM — проверка, что новый дом ни на что не налезает. */
  osmBuildings: readonly BaseBuildingFeature[];
  yards: readonly Yard[];
  /** Деревня из моделей: дома OSM, нарисованные башкирскими домами (выбор, правка, скрытие). */
  models?: VillageModelsLayer;
  /** Постройки во дворах с карты: гараж, баня, сарай. */
  yardModels?: VillageModelsLayer;
  /** Участки с карты (локальные метры): щелчок внутри — выбрать участок. */
  mapPlots?: readonly MapPlot[];
  /** Показать свои деревья как в списке (перенос дерева, до записи в правки). */
  previewTrees?: (trees: readonly EditedTree[]) => void;
  /** Свои деревья: id и середина кроны в координатах three — для выбора щелчком. */
  ownTrees?: () => { id: string; x: number; y: number; z: number }[];
  /** Заборы с карты (локальные метры): щелчок по такому забору берёт его в правку. */
  mapFences?: readonly { id: string; line: Vec2[] }[];
}

const screenDistance = (a: ScreenPoint, b: ScreenPoint) => Math.hypot(a[0] - b[0], a[1] - b[1]);
/** Зерно по месту (до дециметра): пока тянут дом, окраска модели не мигает. */
const pointSeed = (point: Vec2) => hashString(`${point[0].toFixed(1)}:${point[1].toFixed(1)}`) % 9973;

/**
 * Редактор в сцене — как в градостроителях: «Дом» — тяни по земле, дом вырастает под участок
 * (вдоль улицы); «Дорога» и «Забор» — веди линию, как карандашом (дорога прилипает к соседним);
 * «Выбор» — клик по дому, дороге или забору; дом тянут, поворачивают и растягивают за ручки.
 */
export class EditorTool {
  private drag?: Drag;
  /** Указатель, захваченный на время перетаскивания (движения и отпускание приходят и за краем холста). */
  private pointerId?: number;
  /** Камеру выключили мы — значит, и включаем мы (не трогаем чужие выключения). */
  private cameraOff = false;
  private readonly obstacleShapes: { id: string; shape: ReturnType<typeof polygon>; box: [number, number, number, number] }[];

  constructor(private readonly ctx: EditorContext) {
    const canvas = ctx.city.canvas;
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerCancel);
    window.addEventListener('keydown', this.onKey);
    useEditStore.getState().setLineCloser(() => this.closePending());
    this.obstacleShapes = ctx.osmBuildings.flatMap((f) =>
      (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates).map((rings) => {
        const xs = (rings[0] ?? []).map(([x]) => x);
        const ys = (rings[0] ?? []).map(([, y]) => y);
        return {
          id: f.properties.id,
          shape: polygon(rings),
          box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] as [number, number, number, number],
        };
      }),
    );
  }

  /** Дом для правки: уже изменённый или дом OSM, переведённый в правку с тем же видом. */
  resolve(id: string): EditedBuilding | undefined {
    const own = useEditStore.getState().edits.buildings.find((b) => b.id === id);
    if (own) return own;
    // Дом или постройка с карты на участке: правка сразу помечена участком и ролью.
    const plot = useEditStore.getState().edits.plots?.find((p) => p.mapMembers?.some((m) => m.id === id));
    const found = this.resolveMap(id);
    if (!found || !plot) return found;
    return { ...found, plot: plot.id, plotRole: plot.mapMembers!.find((m) => m.id === id)!.role };
  }

  /** Дом с карты (OSM или постройка во дворе) в виде правки. */
  private resolveMap(id: string): EditedBuilding | undefined {
    const info = this.ctx.base.buildingInfo(id);
    if (!info || info.outline.length < 3) {
      // Постройка во дворе с карты — в правку моделью и её прямоугольником.
      const yard = this.ctx.yardModels?.house(id);
      const rect = yard && this.ctx.yardModels?.rectLonLat(id);
      if (!yard || !rect) return undefined;
      const shed: EditedBuilding = { id, source: id, kind: 'shed', footprint: rect, floors: 1, roof: 'gabled', facadeColor: '#9a8f7c', roofColor: '#6b7176' };
      return withModel(shed, { id: yard.model, seed: yard.seed }, rect);
    }
    const osm = fromOsm({
      id,
      building: info.props.building,
      levels: info.props.levels,
      wallTop: info.wallTop,
      roof: info.roof,
      outline: info.outline,
      facadeColor: info.facadeColor,
      roofColor: info.roofColor,
    });
    // Дом деревни, нарисованный моделью, — в правку с той же моделью и её прямоугольником.
    const house = this.ctx.models?.house(id);
    const rect = house && this.ctx.models?.rectLonLat(id);
    return house && rect ? withModel(osm, { id: house.model, seed: house.seed }, rect) : osm;
  }

  /** Дом-модель на месте дома: прямоугольник контура, фасад — к ближайшей улице; без модели — простой объём. */
  applyModel(b: EditedBuilding, model: HouseModelRef | undefined): EditedBuilding {
    if (!model) return withModel(b, undefined);
    // Уже модель — контур и сторона фасада остаются (меняется только вид).
    if (b.model && b.footprint.length === 4) return withModel(b, model);
    const rect = modelFootprint(this.local(b), this.roadLines());
    return withModel(b, model, rect.map(this.ctx.frame.toLonLat) as LonLat[]);
  }

  /** Удалить выделенное (Delete). */
  deleteSelection(): void {
    const { selection, edits, commit, select } = useEditStore.getState();
    if (!selection) return;
    const next =
      selection.type === 'building'
        ? removeBuilding(edits, selection.id)
        : selection.type === 'road'
          ? removeRoad(edits, selection.id)
          : selection.type === 'tree'
            ? { ...edits, trees: (edits.trees ?? []).filter((t) => t.id !== selection.id) }
            : selection.type === 'plot'
              ? removePlot(edits, selection.id, true)
              : removeFence(edits, selection.id);
    commit(next);
    select(undefined);
  }

  destroy(): void {
    const canvas = this.ctx.city.canvas;
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    canvas.removeEventListener('pointermove', this.onPointerMove);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('pointercancel', this.onPointerCancel);
    window.removeEventListener('keydown', this.onKey);
    useEditStore.getState().setLineCloser(undefined);
    this.releasePointer();
    this.setCamera(true);
  }

  // --- мышь ------------------------------------------------------------------

  private readonly onPointerDown = (event: PointerEvent) => {
    // Только левая кнопка без Shift/Ctrl/Alt; правая — вращение камеры.
    if (event.button !== 0 || !event.isPrimary || event.shiftKey || event.ctrlKey || event.altKey) return;
    this.down([event.clientX, event.clientY]);
    if (this.drag && this.drag.type !== 'click') this.capturePointer(event.pointerId);
  };

  private readonly onPointerMove = (event: PointerEvent) => {
    if (event.isPrimary) this.move([event.clientX, event.clientY]);
  };

  private readonly onPointerUp = (event: PointerEvent) => {
    if (event.button !== 0 || !event.isPrimary) return;
    this.releasePointer();
    this.up([event.clientX, event.clientY]);
  };

  private readonly onPointerCancel = () => {
    if (this.drag) this.cancelDrag();
  };

  private down(position: ScreenPoint): void {
    const { tool } = useEditStore.getState();
    // Пока подложку двигают или совмещают, клики — её.
    if (!tool || useAppStore.getState().mode !== 'explore' || useUnderlayStore.getState().mode) return;
    const point = this.ground(position);

    if (tool === 'house' && point) {
      this.drag = { type: 'house', start: point, dir: this.streetDirection(point) };
      this.setCamera(false);
    } else if ((tool === 'road' || tool === 'fence') && point) {
      const start = tool === 'road' ? this.snapToRoad(point) : this.pending ? point : (this.fenceSnap(point, position)?.point ?? point);
      if (this.pending && this.pending.kind !== tool) this.dropPending();
      this.drag = { type: 'line', kind: tool, points: [start], at: position };
      this.setCamera(false);
    } else if (tool === 'plot' && point && useEditStore.getState().plotMode === 'outline') {
      // Обвести постройки: контур по точкам (как забор), замкнуть — участок с тем, что внутри.
      const start = this.pending ? point : (this.fenceSnap(point, position)?.point ?? point);
      if (this.pending && this.pending.kind !== 'plot') this.dropPending();
      this.drag = { type: 'line', kind: 'plot', points: [start], at: position };
      this.setCamera(false);
    } else if (tool === 'plot' && point) {
      this.drag = { type: 'plotnew', start: point, at: position };
      this.setCamera(false);
    } else if (tool === 'tree' && point) {
      const mode = useEditStore.getState().tree.mode;
      this.drag = mode === 'erase' ? { type: 'erase', points: [point] } : { type: 'plant', points: [point], at: position };
      this.setCamera(false);
      if (mode === 'erase') this.previewErase([point]);
    } else if (tool === 'select') {
      this.drag = this.pressSelect(position, point) ?? { type: 'click', at: position };
      if (this.drag.type !== 'click') this.setCamera(false);
    }
  }

  private move(position: ScreenPoint): void {
    const drag = this.drag;
    if (!drag) this.hover(position);
    if (!drag || drag.type === 'click') return;
    const point = this.ground(position);
    if (!point) return;
    const { layer } = this.ctx;

    if (drag.type === 'house') {
      drag.current = point;
      const building = this.houseFrom(drag.start, point, drag.dir) ?? this.modelAt(drag.start);
      layer.preview(building, !building || this.blocked(building));
    } else if (drag.type === 'line') {
      // Пока линию ставят по точкам, протяжка ничего не рисует — следующая точка встанет там, где отпустят.
      if (this.pending) {
        layer.previewLine([...this.pending.points, point].map(this.ctx.frame.toLonLat), this.lineStyle(drag.kind));
        return;
      }
      if (screenDistance(drag.at, position) <= CLICK_PX) return;
      const last = drag.points[drag.points.length - 1]!;
      if (Math.hypot(point[0] - last[0], point[1] - last[1]) >= (drag.kind === 'road' ? 1.5 : 0.5)) drag.points.push(point);
      if (drag.kind === 'plot') this.showOutline([...drag.points, point]);
      useEditStore.getState().setDrawing({ kind: drag.kind, points: drag.points.length, segment: 0, total: lengthOf([...drag.points, point]) });
      layer.previewLine([...drag.points, point].map(this.ctx.frame.toLonLat), this.lineStyle(drag.kind));
    } else if (drag.type === 'plotnew') {
      if (screenDistance(drag.at, position) <= CLICK_PX) return;
      drag.current = point;
      const rect = this.plotRectFrom(drag.start, point);
      layer.previewLine([...rect, rect[0]!].map(this.ctx.frame.toLonLat), 'fence');
    } else if (drag.type === 'pmove' || drag.type === 'presize' || drag.type === 'protate') {
      const store = useEditStore.getState();
      // Перенос и поворот двигают и постройки: те, что ещё с карты, переходят в правки.
      // Один раз, в начале: дальше постройки с карты уже спрятаны и не находятся.
      const edits = drag.type === 'presize' ? store.edits : (drag.base ??= materializePlot(store.edits, drag.id, (id) => this.resolve(id)));
      const plot = edits.plots?.find((p) => p.id === drag.id);
      if (!plot) return;
      if (drag.type === 'pmove') {
        const dx = point[0] - drag.start[0], dy = point[1] - drag.start[1];
        drag.next = transformPlot(edits, drag.id, ([x, y]) => [x + dx, y + dy], this.ctx.frame);
      } else if (drag.type === 'protate') {
        const angle = Math.atan2(point[1] - drag.center[1], point[0] - drag.center[0]) - drag.startAngle;
        drag.next = transformPlot(edits, drag.id, (p) => rotate([p], drag.center, angle)[0]!, this.ctx.frame);
      } else {
        const outline = drag.free ? drag.original.map((q, i) => (i === drag.index ? point : q)) : resizedPlot(drag.original, drag.index, point);
        drag.next = resizePlot(edits, drag.id, outline, this.ctx.frame);
      }
      layer.render(drag.next, undefined);
      // Дома с карты, перешедшие в правки, не должны стоять на старом месте.
      this.ctx.models?.setHidden(replacedOsmIds(drag.next));
      this.ctx.yardModels?.setHidden(replacedOsmIds(drag.next));
      const moved = drag.next.plots!.find((p) => p.id === drag.id)!;
      if (moved.free) layer.setLineHandles([...moved.outline, moved.outline[0]!]);
      else layer.setHandles(undefined, moved.outline);
      layer.highlight([closedLine(drag.next.plots!.find((p) => p.id === drag.id)!.outline)]);
      this.ctx.previewTrees?.(drag.next.trees ?? []);
    } else if (drag.type === 'plant') {
      if (screenDistance(drag.at, position) <= CLICK_PX) return;
      const last = drag.points[drag.points.length - 1]!;
      if (Math.hypot(point[0] - last[0], point[1] - last[1]) >= 0.5) drag.points.push(point);
      // Аллея: где встанут деревья — пунктиром по линии.
      layer.previewLine(drag.points.map(this.ctx.frame.toLonLat), 'fence');
      const spots = treeRow(drag.points, this.treeSpacing());
      layer.setSnapMarkers(spots);
      useEditStore.getState().setDrawing({ kind: 'fence', points: spots.length, segment: 0, total: lengthOf(drag.points) });
    } else if (drag.type === 'erase') {
      drag.points.push(point);
      this.previewErase(drag.points);
    } else if (drag.type === 'tmove') {
      drag.current = point;
      const { edits } = useEditStore.getState();
      const trees = (edits.trees ?? []).map((t) => (t.id === drag.id ? { ...t, at: this.ctx.frame.toLonLat(point) } : t));
      this.ctx.previewTrees?.(trees);
    } else if (drag.type === 'fgate') {
      // Ворота едут вдоль забора: середина проёма — ближайшая к курсору точка линии.
      const at = distanceAlong(drag.line, point);
      drag.gates = drag.gates.map((g, i) => (i === drag.index ? { ...g, at } : g));
      const { edits } = useEditStore.getState();
      const fences = edits.fences.map((f) => (f.id === drag.id ? { ...f, gates: drag.gates } : f));
      layer.render({ ...edits, fences }, undefined);
      layer.setLineHandles(drag.line.map(this.ctx.frame.toLonLat), drag.gates);
    } else if (drag.type === 'fmove' || drag.type === 'fvertex' || drag.type === 'frotate') {
      if (drag.type === 'fmove') drag.current = translate(drag.original, [point[0] - drag.start[0], point[1] - drag.start[1]]);
      else if (drag.type === 'fvertex') {
        // Точка прилипает к углам и линиям других заборов — участки смыкаются без щелей.
        const snap = this.fenceSnap(point, position, drag.id);
        this.ctx.layer.setSnapMarker(snap);
        const at = snap?.point ?? point;
        const closed = isClosed(drag.original);
        const last = drag.original.length - 1;
        drag.current = drag.original.map((p, i) => (i === drag.index || (closed && ((drag.index === 0 && i === last) || (drag.index === last && i === 0))) ? at : p));
      }
      else drag.current = rotate(drag.original, drag.center, Math.atan2(point[1] - drag.center[1], point[0] - drag.center[0]) - drag.startAngle);
      layer.previewLine(drag.current.map(this.ctx.frame.toLonLat), 'fence');
    } else if (drag.type === 'move') {
      const delta: Vec2 = [point[0] - drag.start[0], point[1] - drag.start[1]];
      drag.current = this.withFootprint(drag.original, translate(this.local(drag.original), delta));
      layer.preview(drag.current, this.blocked(drag.current));
    } else if (drag.type === 'rotate') {
      const angle = Math.atan2(point[1] - drag.center[1], point[0] - drag.center[0]) - drag.startAngle;
      drag.current = this.withFootprint(drag.original, rotate(this.local(drag.original), drag.center, angle));
      layer.preview(drag.current, this.blocked(drag.current));
    } else if (drag.type === 'resize') {
      drag.current = this.withFootprint(drag.original, resizeByCorner(this.local(drag.original), drag.index, point, MIN_HOUSE_SIDE));
      layer.preview(drag.current, this.blocked(drag.current));
    }
  }

  /** Курсор над выделенным домом: на углу — растянуть, чуть снаружи угла — повернуть. */
  private hover(position: ScreenPoint): void {
    const { tool, selection } = useEditStore.getState();
    if (this.pending) {
      // Инструмент сменили мышью — недорисованную линию бросаем; иначе тянем «резинку» к курсору.
      if (tool !== this.pending.kind) this.dropPending();
      else {
        const raw = this.ground(position);
        if (raw) {
          const snap = this.pending.kind !== 'road' ? this.fenceSnap(raw, position) : undefined;
          const point = snap?.point ?? raw;
          this.ctx.layer.setSnapMarker(snap);
          this.ctx.layer.previewLine([...this.pending.points, point].map(this.ctx.frame.toLonLat), this.lineStyle(this.pending.kind));
          const last = this.pending.points[this.pending.points.length - 1]!;
          const capture = this.pending.kind === 'plot' ? this.showOutline([...this.pending.points, point]) : undefined;
          useEditStore.getState().setDrawing({
            kind: this.pending.kind,
            points: this.pending.points.length,
            segment: segmentLength(last, point),
            total: lengthOf([...this.pending.points, point]),
            snap: snap?.kind,
            ...(capture !== undefined ? { capture } : {}),
          });
        }
      }
    } else if ((tool === 'fence' || (tool === 'plot' && useEditStore.getState().plotMode === 'outline')) && !useUnderlayStore.getState().mode) {
      // Первая точка тоже прилипает — метка показывает, куда она встанет.
      const raw = this.ground(position);
      this.ctx.layer.setSnapMarker(raw ? this.fenceSnap(raw, position) : undefined);
    } else this.ctx.layer.setSnapMarker(undefined);
    const canvas = this.ctx.city.canvas;
    const editable = tool === 'select' && useAppStore.getState().mode === 'explore' && !useUnderlayStore.getState().mode;
    const active = editable && selection?.type === 'building';
    const ownFence = editable && selection?.type === 'fence' ? useEditStore.getState().edits.fences.find((f) => f.id === selection.id) : undefined;
    let cursor: string | undefined;
    if (ownFence) {
      // У забора: на точке — тянуть её, чуть снаружи — повернуть, на воротах — двигать их, на линии — весь забор.
      const at = this.ctx.layer.cursorAt(position[0], position[1]);
      const point = this.ground(position);
      const line = ownFence.line.map(this.ctx.frame.toLocal);
      const near = !!point && line.some((p, i) => i > 0 && distanceToSegment(point, line[i - 1]!, p) < 1.5);
      // Синяя точка ворот — тянуть вдоль забора.
      cursor = at ? (at === 'ew-resize' ? at : at.includes('resize') ? 'pointer' : at) : near ? 'move' : '';
    } else if (editable && selection?.type === 'plot') {
      // У участка: угол — растянуть, снаружи — повернуть, внутри на пустом месте — двигать весь участок.
      const plot = useEditStore.getState().edits.plots?.find((p) => p.id === selection.id);
      const point = this.ground(position);
      const inside = !!plot && !!point && insidePlot(plot.outline.map(this.ctx.frame.toLocal), point);
      cursor = this.ctx.layer.cursorAt(position[0], position[1]) ?? (inside ? 'move' : '');
    } else if (active) {
      // На углу — растянуть, снаружи угла — повернуть, на самом доме — двигать.
      cursor = this.ctx.layer.cursorAt(position[0], position[1]) ?? (this.pick(position).building === selection.id ? 'move' : '');
    }
    if (cursor === undefined) {
      if (this.hoverCursor) canvas.style.cursor = '';
      this.hoverCursor = false;
      return;
    }
    if (cursor || this.hoverCursor) canvas.style.cursor = cursor;
    this.hoverCursor = !!cursor;
  }

  private hoverCursor = false;

  private up(position: ScreenPoint): void {
    const drag = this.drag;
    this.drag = undefined;
    this.setCamera(true);
    if (!drag) return;
    const store = useEditStore.getState();
    const { layer } = this.ctx;
    layer.preview(undefined);
    layer.previewLine(undefined);

    if (drag.type === 'click') {
      if (screenDistance(drag.at, position) <= CLICK_PX) this.selectAt(position);
      return;
    }
    if (drag.type === 'house') {
      // С моделью — клик ставит дом обычного размера фасадом к улице, растяжка — по размеру.
      const building = (drag.current && this.houseFrom(drag.start, drag.current, drag.dir)) || this.modelAt(drag.start);
      if (!building) return store.notify('Растяните дом побольше — хотя бы 3 × 3 м');
      if (this.blocked(building)) return store.notify('Здесь уже стоит дом — выберите свободное место');
      store.commit(upsertBuilding(store.edits, building));
      store.setTool('select');
      store.select({ type: 'building', id: building.id });
      return;
    }
    if (drag.type === 'line') {
      // Щелчок (без протяжки) или линия уже ставится по точкам — это очередная точка.
      if (this.pending || screenDistance(drag.at, position) <= CLICK_PX || drag.points.length < 2) {
        this.addPoint(drag.kind, this.ground(position) ?? drag.points[0]!, position);
        return;
      }
      // Протяжка — линия «кистью», как карандашом; конец забора прилипает, как и начало.
      useEditStore.getState().setDrawing(undefined);
      const points = simplifyLine(drag.points, drag.kind === 'road' ? 1.2 : 0.3);
      if (drag.kind !== 'road') {
        const end = this.fenceSnap(points[points.length - 1]!, position);
        if (drag.kind === 'plot') this.ctx.layer.setOutlineArea(undefined);
        if (end) points[points.length - 1] = end.point;
      }
      this.commitLine(drag.kind, points);
      return;
    }
    if (drag.type === 'plotnew') {
      const click = screenDistance(drag.at, position) <= CLICK_PX || !drag.current;
      const rect = click ? this.plotRectAt(drag.start) : this.plotRectFrom(drag.start, drag.current!);
      const [w, d] = [Math.hypot(rect[1]![0] - rect[0]![0], rect[1]![1] - rect[0]![1]), Math.hypot(rect[3]![0] - rect[0]![0], rect[3]![1] - rect[0]![1])];
      if (w < MIN_PLOT_SIDE || d < MIN_PLOT_SIDE) return store.notify('Растяните участок побольше — хотя бы 6 × 6 м');
      const id = `plot-${Date.now().toString(36)}`;
      store.commit(createPlot(store.edits, id, rect, store.plotTemplate, this.ctx.frame));
      store.setTool('select');
      store.select({ type: 'plot', id });
      return;
    }
    if (drag.type === 'pmove' || drag.type === 'presize' || drag.type === 'protate') {
      if (drag.next) store.commit(drag.next);
      else this.refreshHidden();
      return;
    }
    if (drag.type === 'plant') {
      store.setDrawing(undefined);
      layer.setSnapMarkers([]);
      const click = screenDistance(drag.at, position) <= CLICK_PX;
      const spots = click ? [drag.points[0]!] : treeRow(drag.points, this.treeSpacing());
      this.plantTrees(spots);
      return;
    }
    if (drag.type === 'erase') {
      layer.setSnapMarkers([]);
      this.eraseTrees(drag.points);
      return;
    }
    if (drag.type === 'tmove') {
      if (!drag.current || screenDistance(drag.at, position) <= CLICK_PX) this.ctx.previewTrees?.(store.edits.trees ?? []);
      if (!drag.current || screenDistance(drag.at, position) <= CLICK_PX) return;
      const at = this.ctx.frame.toLonLat(drag.current);
      store.commit({ ...store.edits, trees: (store.edits.trees ?? []).map((t) => (t.id === drag.id ? { ...t, at } : t)) });
      return;
    }
    if (drag.type === 'fgate') {
      const fence = store.edits.fences.find((f) => f.id === drag.id);
      // Ворота встают туда, где они на самом деле поместились (не через излом и не на соседние ворота).
      const placed = placeGates(drag.line, drag.gates);
      const gates = drag.gates.map((g, i) => ({ ...g, at: placed.find((p) => p.index === i)?.at ?? g.at }));
      if (fence) store.commit(upsertFence(store.edits, { ...fence, gates }));
      return;
    }
    if (drag.type === 'fmove' || drag.type === 'fvertex' || drag.type === 'frotate') {
      layer.setSnapMarker(undefined);
      if (drag.type === 'fmove' && screenDistance(drag.at, position) <= CLICK_PX) return;
      const fence = store.edits.fences.find((f) => f.id === drag.id);
      if (drag.type === 'fvertex' && screenDistance(drag.at, position) <= CLICK_PX) {
        // Щелчок по точке без протяжки; второй подряд по той же — убрать её.
        if (drag.inserted) return layer.render(store.edits, undefined);
        const last = this.vertexClick;
        this.vertexClick = { id: drag.id, index: drag.index, time: performance.now() };
        if (!fence || !last || last.id !== drag.id || last.index !== drag.index || performance.now() - last.time > DOUBLE_CLICK_MS) return;
        this.vertexClick = undefined;
        const line = removeVertex(drag.original, drag.index);
        if (!line) return store.notify('У забора должно остаться хотя бы две точки — чтобы убрать весь забор, нажмите Delete');
        store.commit(upsertFence(store.edits, { ...fence, line: line.map(this.ctx.frame.toLonLat) }));
        return;
      }
      // Вид, цвет и ворота остаются при забору — меняется только линия.
      if (fence && drag.current !== drag.original) store.commit(upsertFence(store.edits, { ...fence, line: drag.current.map(this.ctx.frame.toLonLat) }));
      return;
    }
    // Перетаскивание дома, поворот, растяжка.
    if (this.blocked(drag.current)) {
      store.notify('Так дом налезает на соседний — правка отменена');
      this.refreshHidden();
      return;
    }
    if (drag.type === 'move' && screenDistance(drag.at, position) <= CLICK_PX) {
      this.refreshHidden();
      return;
    }
    store.commit(upsertBuilding(store.edits, drag.current));
  }

  /** Нажатие инструментом «Выбор»: на ручке или на выделенном доме — начать правку. */
  private pressSelect(position: ScreenPoint, point: Vec2 | undefined): Drag | undefined {
    const { selection, edits } = useEditStore.getState();
    if (selection?.type === 'plot' && point) {
      const plot = edits.plots?.find((p) => p.id === selection.id);
      if (plot) {
        const local = plot.outline.map(this.ctx.frame.toLocal);
        const handle = this.ctx.layer.hit(position[0], position[1]).handle;
        if (plot.free && (handle?.handle === 'corner' || handle?.handle === 'mid')) {
          // Участок с карты: угол тянется один; середина стороны — новый угол.
          const original = handle.handle === 'mid' ? [...local.slice(0, handle.index + 1), point, ...local.slice(handle.index + 1)] : local;
          const index = handle.handle === 'mid' ? handle.index + 1 : handle.index % local.length;
          return { type: 'presize', id: plot.id, index, original, free: true };
        }
        if (handle?.handle === 'corner') {
          // Ручки строятся по углам ориентированного прямоугольника — порядок может не совпасть с контуром.
          const c = footprintCorners(local)[handle.index]!;
          let index = 0;
          local.forEach((p, i) => {
            if (Math.hypot(p[0] - c[0], p[1] - c[1]) < Math.hypot(local[index]![0] - c[0], local[index]![1] - c[1])) index = i;
          });
          return { type: 'presize', id: plot.id, index, original: local };
        }
        if (handle?.handle === 'rotate') {
          const center = centroidOf(local);
          return { type: 'protate', id: plot.id, center, startAngle: Math.atan2(point[1] - center[1], point[0] - center[0]) };
        }
        // Внутри участка, но не на постройке и не на дереве — тянем весь участок.
        if (insidePlot(local, point) && !this.pick(position).building && !this.treeAt(position)) return { type: 'pmove', id: plot.id, start: point, at: position };
      }
    }
    if (selection?.type === 'tree' && point && this.treeAt(position) === selection.id) {
      return { type: 'tmove', id: selection.id, start: point, at: position };
    }
    if (selection?.type === 'fence' && point) {
      const fence = edits.fences.find((f) => f.id === selection.id);
      if (!fence) return undefined;
      const original = fence.line.map(this.ctx.frame.toLocal);
      const handle = this.ctx.layer.hit(position[0], position[1]).handle;
      if (handle?.handle === 'gate' && fence.gates?.[handle.index]) return { type: 'fgate', id: fence.id, line: original, index: handle.index, gates: fence.gates };
      if (handle?.handle === 'corner') return { type: 'fvertex', id: fence.id, original, index: handle.index, current: original, at: position };
      if (handle?.handle === 'mid') {
        // Середина отрезка: здесь появляется новый излом, его сразу тянут.
        const a = original[handle.index]!, b = original[handle.index + 1]!;
        const line = [...original.slice(0, handle.index + 1), [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as Vec2, ...original.slice(handle.index + 1)];
        return { type: 'fvertex', id: fence.id, original: line, index: handle.index + 1, current: line, at: position, inserted: true };
      }
      if (handle?.handle === 'rotate') {
        const center = centroidOf(original);
        return { type: 'frotate', id: fence.id, original, center, startAngle: Math.atan2(point[1] - center[1], point[0] - center[0]), current: original };
      }
      const near = original.some((p, i) => i > 0 && distanceToSegment(point, original[i - 1]!, p) < 1.5);
      return near ? { type: 'fmove', id: fence.id, original, start: point, current: original, at: position } : undefined;
    }
    if (selection?.type !== 'building' || !point) return undefined;
    const hit = this.pick(position);
    if (!hit.handle && hit.building !== selection.id) return undefined;
    const original = this.resolve(selection.id);
    if (!original) return undefined;
    // Дом OSM на время правки прячем — виден только предпросмотр.
    this.hideWhileDragging(original);
    const local = this.local(original);
    if (hit.handle?.handle === 'corner') return { type: 'resize', original, index: hit.handle.index, current: original };
    if (hit.handle?.handle === 'rotate') {
      const center = centroidOf(local);
      return { type: 'rotate', original, center, startAngle: Math.atan2(point[1] - center[1], point[0] - center[0]), current: original };
    }
    return { type: 'move', original, start: point, current: original, at: position };
  }

  /** Клик без перетаскивания: дом, забор, дорога или пусто. */
  private selectAt(position: ScreenPoint): void {
    const store = useEditStore.getState();
    const tree = this.treeAt(position);
    if (tree) return store.select({ type: 'tree', id: tree });
    const hit = this.pick(position);
    if (hit.building) return store.select({ type: 'building', id: hit.building });
    if (hit.fence?.startsWith('plot:')) return store.select({ type: 'plot', id: hit.fence.slice(5, hit.fence.lastIndexOf(':')) });
    if (hit.fence) return store.select({ type: 'fence', id: hit.fence });

    const point = this.ground(position);
    if (!point) return store.select(undefined);
    // Свой забор — по близости к линии (сверху тонкий лист забора лучом почти не поймать).
    const mine = store.edits.fences.find((f) => {
      const line = f.line.map(this.ctx.frame.toLocal);
      return line.some((p, i) => i > 0 && distanceToSegment(point, line[i - 1]!, p) < 1.5);
    });
    if (mine) return store.select({ type: 'fence', id: mine.id });
    // Внутри своего участка — участок.
    const plot = store.edits.plots?.find((p) => insidePlot(p.outline.map(this.ctx.frame.toLocal), point));
    if (plot) return store.select({ type: 'plot', id: plot.id });
    // Забор с карты: берём его в правку — исходный прячется, появляется свой, который можно менять.
    const gone = new Set(store.edits.removedFences ?? []);
    const fromMap = (this.ctx.mapFences ?? []).find((f) => !gone.has(f.id) && f.line.some((p, i) => i > 0 && distanceToSegment(point, f.line[i - 1]!, p) < 1.5));
    if (fromMap) {
      const id = `fence-${Date.now().toString(36)}`;
      store.commit(adoptFence(store.edits, fromMap.id, { id, line: fromMap.line.map(this.ctx.frame.toLonLat) }));
      return store.select({ type: 'fence', id });
    }
    // Участок с карты вокруг жилого дома (ещё не взятый в правку).
    const adopted = new Set((store.edits.plots ?? []).map((p) => p.source));
    const mapPlot = this.ctx.mapPlots?.find((p) => !adopted.has(p.house) && insidePlot(p.outline, point));
    if (mapPlot) return store.select({ type: 'plot', id: mapPlot.id });
    // Заборы дворов — по близости к линии.
    const yard = this.ctx.yards.find(
      (y) => !store.edits.removedYards.includes(y.houseId) && y.fence.some(([a, b]) => distanceToSegment(point, a, b) < 2),
    );
    if (yard) return store.select({ type: 'fence', id: yard.houseId });
    // Свои дороги — по оси, дороги OSM — по полигону проезжей части.
    const own = store.edits.roads.find((r) => {
      const axis = r.axis.map(this.ctx.frame.toLocal);
      return axis.some((p, i) => i > 0 && distanceToSegment(point, axis[i - 1]!, p) < ROAD_KINDS[r.kind].width / 2 + 1);
    });
    if (own) return store.select({ type: 'road', id: own.id });
    const osm = this.ctx.ground.roadAt(...this.ctx.frame.toLonLat(point));
    store.select(osm ? { type: 'road', id: osm.key } : undefined);
  }

  /**
   * Что под курсором: ручка, свой дом или забор, дом OSM. Луч — по своим мешам и по зданиям OSM сразу,
   * побеждает ближайшее к камере; спрятанные слои не выбираются.
   */
  private pick([x, y]: ScreenPoint): { handle?: Handle; building?: string; fence?: string } {
    const { city, layer, base, models, yardModels } = this.ctx;
    const objects = [...layer.pickables, ...base.pickables, ...(models?.pickables ?? []), ...(yardModels?.pickables ?? [])].filter((object) => object.visible);
    const intersection = city.pickObject(x, y, objects);
    const hit = layer.hit(x, y, intersection);
    if (hit.handle || hit.building || hit.fence) return hit;
    const building = base.buildingFromPick(intersection)?.id ?? models?.buildingFromPick(intersection) ?? yardModels?.buildingFromPick(intersection);
    return building ? { building } : {};
  }

  // --- клавиатура ---------------------------------------------------------------

  private readonly onKey = (event: KeyboardEvent) => {
    if (isTypingTarget(event.target) || useAppStore.getState().mode !== 'explore') return;
    const store = useEditStore.getState();
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.code === 'KeyZ') {
      event.preventDefault();
      if (event.shiftKey) store.redo();
      else store.undo();
      return;
    }
    if (mod && event.code === 'KeyY') {
      event.preventDefault();
      store.redo();
      return;
    }
    if (mod || event.altKey) return;
    if (this.pending) {
      // Линия по точкам: Enter — готово, Backspace — убрать последнюю точку, Esc — бросить.
      if (event.code === 'Enter' || event.code === 'NumpadEnter') {
        event.preventDefault();
        return this.finishPending();
      }
      if (event.code === 'Backspace') {
        event.preventDefault();
        this.pending.points.pop();
        if (!this.pending.points.length) return this.dropPending();
        return this.ctx.layer.previewLine(this.pending.points.map(this.ctx.frame.toLonLat), this.lineStyle(this.pending.kind));
      }
      if (event.code === 'Escape') return this.dropPending();
      if (event.code === 'KeyC') {
        event.preventDefault();
        return this.closePending();
      }
      this.dropPending();
    }
    const tool = HOTKEYS[event.code];
    if (tool) {
      store.setTool(store.tool === tool ? undefined : tool);
      return;
    }
    if (event.code === 'Escape') {
      const underlay = useUnderlayStore.getState();
      if (underlay.mode) underlay.setMode(undefined);
      else if (this.drag) this.cancelDrag();
      else if (store.selection) store.select(undefined);
      else if (store.tool) store.setTool(undefined);
      return;
    }
    if (event.code === 'Backspace' && useUnderlayStore.getState().mode?.startsWith('align')) {
      event.preventDefault();
      useUnderlayStore.getState().alignBack();
      return;
    }
    if ((event.code === 'Delete' || event.code === 'Backspace') && store.selection) {
      event.preventDefault();
      this.deleteSelection();
    }
  };

  // --- дорога и забор по точкам ---------------------------------------------------

  /** Линия, которую ставят щелчками: точки уже поставлены, следующая — под курсором. */
  private pending?: { kind: LineKind; points: Vec2[] };

  private lineStyle(kind: LineKind) {
    return kind === 'road' ? useEditStore.getState().roadKind : 'fence';
  }

  /** Очередная точка: щелчок по последней точке (или двойной щелчок) — закончить, по первой — замкнуть забор. */
  private addPoint(kind: LineKind, raw: Vec2, position?: ScreenPoint): void {
    const point = kind === 'road' ? (this.pending ? raw : this.snapToRoad(raw)) : ((position && this.fenceSnap(raw, position)?.point) ?? raw);
    if (!this.pending) {
      this.pending = { kind, points: [point] };
      useEditStore.getState().notify(
        kind === 'road'
          ? 'Ставьте точки дороги. Двойной щелчок или Enter — готово, Backspace — убрать точку'
          : kind === 'plot'
            ? 'Обведите двор по точкам. Щелчок по первой точке, C или Enter — замкнуть: участок возьмёт всё, что внутри'
            : 'Ставьте точки забора. Щелчок по первой точке или C — замкнуть; двойной щелчок или Enter — готово',
      );
    } else {
      const points = this.pending.points;
      const near = (q: Vec2, metres: number) => Math.hypot(point[0] - q[0], point[1] - q[1]) < metres;
      if (points.length >= 2 && near(points[points.length - 1]!, 1.2)) return this.finishPending();
      if (kind !== 'road' && points.length >= 3 && near(points[0]!, 2.5)) {
        points.push(points[0]!);
        return this.finishPending();
      }
      if (!near(points[points.length - 1]!, 0.4)) points.push(point);
    }
    this.ctx.layer.previewLine(this.pending.points.map(this.ctx.frame.toLonLat), this.lineStyle(kind));
    // Подсказка с длинами и кнопкой «Замкнуть» — сразу, не дожидаясь движения мыши.
    const capture = kind === 'plot' ? this.showOutline(this.pending.points) : undefined;
    useEditStore.getState().setDrawing({ kind, points: this.pending.points.length, segment: 0, total: lengthOf(this.pending.points), ...(capture !== undefined ? { capture } : {}) });
  }

  /** Замкнуть забор или обводку участка: последняя точка — в первую (нужно хотя бы три точки). */
  closePending(): void {
    const pending = this.pending;
    if (!pending || pending.kind === 'road') return;
    if (pending.points.length < 3) return useEditStore.getState().notify('Чтобы замкнуть, поставьте хотя бы три точки');
    pending.points.push(pending.points[0]!);
    this.finishPending();
  }

  /**
   * Участок по обводке: контур (замыкается сам), улица — к ближайшей дороге; внутри — дома и постройки
   * с карты и свои, чья середина в контуре и которые ещё ни на каком участке.
   */
  private outlinePlot(points: Vec2[]): void {
    const store = useEditStore.getState();
    let ring = points.slice();
    const [f, l] = [ring[0]!, ring[ring.length - 1]!];
    if (ring.length > 3 && Math.hypot(f[0] - l[0], f[1] - l[1]) < 0.5) ring = ring.slice(0, -1);
    if (ring.length < 3) return store.notify('Обведите двор хотя бы тремя точками');
    const outline = orientPlot(ring, this.roadLines());
    const { edits } = store;
    const { map, own } = this.capturable(outline);
    if (!map.length && !own.length) store.notify('Внутри обводки построек нет — участок пустой, только забор с воротами');
    this.ctx.layer.setOutlineArea(undefined);
    const id = `plot-${Date.now().toString(36)}`;
    store.commit(plotFromOutline(edits, id, outline, { map, own }, this.ctx.frame));
    store.setTool('select');
    store.select({ type: 'plot', id });
  }

  /** Что попадёт на участок с таким контуром: постройки с карты и свои, чья середина внутри, ещё ни на каком участке. */
  private capturable(outline: readonly Vec2[]) {
    const { edits } = useEditStore.getState();
    const removed = new Set(edits.removedBuildings);
    const replaced = replacedOsmIds(edits);
    const taken = new Set([...(edits.plots ?? []).flatMap((p) => (p.mapMembers ?? []).map((m) => m.id)), ...edits.buildings.filter((b) => b.plot).map((b) => b.id)]);
    const middle = (r: readonly Vec2[]): Vec2 => [r.reduce((s, p) => s + p[0], 0) / r.length, r.reduce((s, p) => s + p[1], 0) / r.length];
    const map = [...(this.ctx.models?.houses ?? []), ...(this.ctx.yardModels?.houses ?? [])]
      .filter((h) => !removed.has(h.id) && !replaced.has(h.id) && !taken.has(h.id) && insidePlot(outline, middle(h.rect)))
      .map((h) => ({ id: h.id, role: roleOfModel(h.model), rect: h.rect }));
    const own = edits.buildings
      .filter((b) => !b.plot && b.footprint.length >= 3)
      .map((b) => ({ id: b.id, model: b.model?.id, rect: b.footprint.map(this.ctx.frame.toLocal) }))
      .filter((b) => insidePlot(outline, middle(b.rect)));
    return { map, own };
  }

  /** Обводка по ходу: заливка, замыкающая линия, рамки вокруг того, что попадёт на участок, — и подпись. */
  private showOutline(polygon: readonly Vec2[] | undefined): string | undefined {
    if (!polygon || polygon.length < 3) {
      this.ctx.layer.setOutlineArea(undefined);
      return undefined;
    }
    const { map, own } = this.capturable(polygon);
    this.ctx.layer.setOutlineArea(polygon, [...map.map((m) => m.rect), ...own.map((b) => b.rect)]);
    return captureSummary([...map.map((m) => m.role), ...own.map((b) => roleOfModel(b.model))]);
  }

  private finishPending(): void {
    const pending = this.pending;
    this.dropPending();
    if (pending && pending.points.length >= 2) this.commitLine(pending.kind, pending.points);
  }

  private dropPending(): void {
    this.pending = undefined;
    this.ctx.layer.previewLine(undefined);
    this.ctx.layer.setOutlineArea(undefined);
    this.ctx.layer.setSnapMarker(undefined);
    useEditStore.getState().setDrawing(undefined);
  }

  /** Последний щелчок по точке своего забора — второй подряд её убирает. */
  private vertexClick?: { id: string; index: number; time: number };

  /** Сколько метров земли под курсором в одном пикселе экрана. */
  private metresPerPixel(position: ScreenPoint): number | undefined {
    const a = this.ground(position);
    const b = this.ground([position[0] + 20, position[1]]);
    return a && b ? Math.hypot(b[0] - a[0], b[1] - a[1]) / 20 : undefined;
  }

  /**
   * Куда встанет точка забора: к углу или линии соседнего забора (своего, с карты или уже поставленным
   * точкам этой же линии), иначе под прямым углом к предыдущему отрезку. except — забор, который правят.
   */
  private fenceSnap(raw: Vec2, position: ScreenPoint, except?: string): Snap | undefined {
    const mpp = this.metresPerPixel(position);
    const tolerance = Math.min(6, Math.max(0.3, (mpp ?? 0.1) * SNAP_PX));
    const { edits } = useEditStore.getState();
    const gone = new Set(edits.removedFences ?? []);
    const lines: Vec2[][] = [
      ...edits.fences.filter((f) => f.id !== except).map((f) => f.line.map(this.ctx.frame.toLocal)),
      ...(this.ctx.mapFences ?? []).filter((f) => !gone.has(f.id)).map((f) => f.line),
    ];
    const pending = this.pending && this.pending.kind !== 'road' ? this.pending.points : [];
    // Свои уже поставленные точки (кроме последней — от неё идёт отрезок) тоже притягивают.
    if (pending.length >= 2) lines.push(pending.slice(0, -1));
    return snapPoint(raw, lines, tolerance, pending[pending.length - 1], pending[pending.length - 2]);
  }

  /** Готовая линия — в правки: дорога прилипает концами к соседним, слишком короткое не берём. */
  private commitLine(kind: LineKind, points: Vec2[]): void {
    if (kind === 'plot') return this.outlinePlot(points);
    const store = useEditStore.getState();
    const isRoad = kind === 'road';
    const line = isRoad ? snapEnds(points, this.roadLines(), ROAD_SNAP_M) : points;
    if (lineLength(line) < (isRoad ? 6 : 2)) return store.notify(isRoad ? 'Дорога слишком короткая' : 'Забор слишком короткий');
    const axis = line.map(this.ctx.frame.toLonLat);
    const id = `${isRoad ? 'road' : 'fence'}-${Date.now().toString(36)}`;
    store.commit(isRoad ? upsertRoad(store.edits, { id, kind: store.roadKind, axis }) : addFence(store.edits, { id, line: axis }));
  }

  // --- участки ---------------------------------------------------------------------

  /** Участок шаблонного размера у точки: улицей к ближайшей дороге, с отступом под палисадник. */
  private plotRectAt(point: Vec2): Vec2[] {
    const [W, D] = PLOT_TEMPLATES[useEditStore.getState().plotTemplate].size;
    const snap = nearestOnLines(point, this.roadLines());
    let away: Vec2 = [0, 1];
    let street = point;
    // Участок всегда улицей к ближайшей дороге (даже на окраине — до 200 м).
    if (snap && snap.distance <= 200) {
      away = snap.distance > 0.01 ? [(point[0] - snap.point[0]) / snap.distance, (point[1] - snap.point[1]) / snap.distance] : [-snap.dir[1], snap.dir[0]];
      // Улица участка — вдоль дороги, на отступе от её оси (или там, где щёлкнули, если дальше).
      const off = Math.max(PLOT_SETBACK_M, snap.distance);
      street = [snap.point[0] + away[0] * off, snap.point[1] + away[1] * off];
    }
    // Вдоль улицы — так, чтобы «внутрь» (влево от направления) смотрело от дороги.
    const d: Vec2 = [away[1], -away[0]];
    const a: Vec2 = [street[0] - d[0] * (W / 2), street[1] - d[1] * (W / 2)];
    const b: Vec2 = [street[0] + d[0] * (W / 2), street[1] + d[1] * (W / 2)];
    return [a, b, [b[0] + away[0] * D, b[1] + away[1] * D], [a[0] + away[0] * D, a[1] + away[1] * D]];
  }

  /** Участок протяжкой: прямоугольник вдоль улицы, первая сторона — ближайшая к дороге. */
  private plotRectFrom(start: Vec2, end: Vec2): Vec2[] {
    const rect = stretchRectangle(start, end, this.streetDirection(start));
    const roads = this.roadLines();
    let best = 0, bestD = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 4; i++) {
      const a = rect[i]!, b = rect[(i + 1) % 4]!;
      const snap = nearestOnLines([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], roads);
      if (snap && snap.distance < bestD) {
        bestD = snap.distance;
        best = i;
      }
    }
    return [0, 1, 2, 3].map((k) => rect[(best + k) % 4]!);
  }

  // --- деревья ---------------------------------------------------------------------

  /** Шаг аллеи по выбранной породе и возрасту, м. */
  private treeSpacing(): number {
    const { kind, size } = useEditStore.getState().tree;
    const scale = TREE_SIZES.find((s) => s.id === size)!.scale;
    return TREE_KINDS[kind].spacing * Math.max(0.7, scale / 0.85);
  }

  private plantTrees(spots: Vec2[]): void {
    const store = useEditStore.getState();
    const { kind, size } = store.tree;
    const scale = TREE_SIZES.find((s) => s.id === size)!.scale;
    const stamp = Date.now().toString(36);
    const trees = spots
      .filter((p) => !this.inHouse(p))
      .map((p, i) => ({ id: `tree-${stamp}-${i}`, at: this.ctx.frame.toLonLat(p), kind, scale: scale * (0.92 + ((i * 37) % 17) / 100) }));
    if (!trees.length) return store.notify('Здесь дом — дерево не посадить');
    store.commit({ ...store.edits, trees: [...(store.edits.trees ?? []), ...trees] });
    if (trees.length > 1) store.notify(`Посажено деревьев: ${trees.length}`);
  }

  /** Ластик: свои деревья в радиусе — долой, деревья с карты в этих кругах прячутся. */
  private eraseTrees(points: Vec2[]): void {
    const store = useEditStore.getState();
    const circles = thin(points, TREE_ERASE_M * 0.8);
    const near = (p: Vec2) => circles.some((c) => Math.hypot(p[0] - c[0], p[1] - c[1]) < TREE_ERASE_M);
    const trees = (store.edits.trees ?? []).filter((t) => !near(this.ctx.frame.toLocal(t.at)));
    const cleared = [...(store.edits.clearedTrees ?? []), ...circles.map((c) => ({ at: this.ctx.frame.toLonLat(c), radius: TREE_ERASE_M }))];
    store.commit({ ...store.edits, trees, clearedTrees: cleared });
  }

  private previewErase(points: Vec2[]): void {
    this.ctx.layer.setSnapMarkers(thin(points, TREE_ERASE_M * 0.8), 'erase');
  }

  /** Стоит ли точка внутри дома (свои и OSM). */
  private inHouse(p: Vec2): boolean {
    const lonLat = this.ctx.frame.toLonLat(p);
    const { edits } = useEditStore.getState();
    const removed = new Set(edits.removedBuildings);
    const box = (o: { box: [number, number, number, number] }) => lonLat[0] >= o.box[0] && lonLat[0] <= o.box[2] && lonLat[1] >= o.box[1] && lonLat[1] <= o.box[3];
    if (this.obstacleShapes.some((o) => !removed.has(o.id) && box(o) && booleanIntersects(point(lonLat), o.shape))) return true;
    return edits.buildings.some((b) => b.footprint.length >= 3 && booleanIntersects(point(lonLat), polygon([[...b.footprint, b.footprint[0]!]])));
  }

  /** Своё дерево под курсором: ближайшая крона на экране. */
  private treeAt([x, y]: ScreenPoint): string | undefined {
    const crowns = this.ctx.ownTrees?.() ?? [];
    if (!crowns.length) return undefined;
    const rect = this.ctx.city.canvas.getBoundingClientRect();
    let best: { id: string; d: number } | undefined;
    for (const c of crowns) {
      const p = this.projected.set(c.x, c.y, c.z).project(this.ctx.city.camera);
      if (p.z < -1 || p.z > 1) continue;
      const d = Math.hypot(rect.left + ((p.x + 1) / 2) * rect.width - x, rect.top + ((1 - p.y) / 2) * rect.height - y);
      if (d < TREE_PICK_PX && (!best || d < best.d)) best = { id: c.id, d };
    }
    return best?.id;
  }

  private readonly projected = new Vector3();

  private cancelDrag(): void {
    if (this.drag?.type === 'tmove') this.ctx.previewTrees?.(useEditStore.getState().edits.trees ?? []);
    if (this.drag?.type === 'plant' || this.drag?.type === 'erase') this.ctx.layer.setSnapMarkers([]);
    if (this.drag?.type === 'line' && this.drag.kind === 'plot' && !this.pending) this.ctx.layer.setOutlineArea(undefined);
    this.drag = undefined;
    this.ctx.layer.setSnapMarker(undefined);
    useEditStore.getState().setDrawing(this.pending ? useEditStore.getState().drawing : undefined);
    this.releasePointer();
    this.setCamera(true);
    this.ctx.layer.preview(undefined);
    this.ctx.layer.previewLine(undefined);
    this.refreshHidden();
  }

  // --- геометрия -------------------------------------------------------------------

  private ground([x, y]: ScreenPoint): Vec2 | undefined {
    const hit = this.ctx.city.pickGround(x, y);
    return hit ? toLocal2(hit) : undefined;
  }

  private local(b: EditedBuilding): Vec2[] {
    return b.footprint.map(this.ctx.frame.toLocal);
  }

  private withFootprint(b: EditedBuilding, local: Vec2[]): EditedBuilding {
    return { ...b, footprint: local.map(this.ctx.frame.toLonLat) as LonLat[] };
  }

  private roadLines(): Vec2[][] {
    const own = useEditStore.getState().edits.roads.map((r) => r.axis.map(this.ctx.frame.toLocal));
    return [...this.ctx.osmRoads, ...own];
  }

  private snapToRoad(point: Vec2): Vec2 {
    const snap = nearestOnLines(point, this.roadLines());
    return snap && snap.distance <= ROAD_SNAP_M ? snap.point : point;
  }

  /** Направление ближайшей улицы — дом встаёт вдоль неё, «как мебель». */
  private streetDirection(point: Vec2): Vec2 {
    const snap = nearestOnLines(point, this.roadLines());
    return snap && snap.distance <= ALIGN_TO_STREET_M ? snap.dir : [1, 0];
  }

  private houseFrom(start: Vec2, end: Vec2, dir: Vec2): EditedBuilding | undefined {
    const rect = stretchRectangle(start, end, dir);
    const [a, b, c] = rect;
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < MIN_HOUSE_SIDE || Math.hypot(c[0] - b[0], c[1] - b[1]) < MIN_HOUSE_SIDE) return undefined;
    const id = this.newHouseId(start);
    const footprint = rect.map(this.ctx.frame.toLonLat) as LonLat[];
    const building = newBuilding(id, footprint, areaOf(rect), this.ctx.village, hashString(id));
    const model = useEditStore.getState().houseModel;
    return model ? this.applyModel(building, { id: model, seed: pointSeed(start) }) : building;
  }

  /**
   * Дом-модель обычного размера у точки клика: вдоль ближайшей улицы, фасадом к ней; если клик у самой
   * дороги — дом отходит, чтобы фасад был в FACADE_SETBACK_M от её оси (на проезжую часть не встаёт).
   */
  private modelAt(point: Vec2, id: HouseModelId | undefined = useEditStore.getState().houseModel): EditedBuilding | undefined {
    const model = id && findHouseModel(id);
    if (!model) return undefined;
    const d = this.streetDirection(point);
    const n: Vec2 = [-d[1], d[0]];
    const w = model.width.value / 2;
    const h = model.depth.value / 2;
    let center = point;
    const snap = nearestOnLines(point, this.roadLines());
    if (snap && snap.distance < h + FACADE_SETBACK_M) {
      // Прочь от оси дороги (клик прямо на оси — в сторону левой нормали улицы).
      const away: Vec2 = snap.distance > 0.01 ? [(point[0] - snap.point[0]) / snap.distance, (point[1] - snap.point[1]) / snap.distance] : [-snap.dir[1], snap.dir[0]];
      const shift = h + FACADE_SETBACK_M - snap.distance;
      center = [point[0] + away[0] * shift, point[1] + away[1] * shift];
    }
    const corner = (sw: number, sh: number): Vec2 => [center[0] + d[0] * w * sw + n[0] * h * sh, center[1] + d[1] * w * sw + n[1] * h * sh];
    const rect = modelFootprint([corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)], this.roadLines());
    const houseId = this.newHouseId(point);
    const footprint = rect.map(this.ctx.frame.toLonLat) as LonLat[];
    return withModel(newBuilding(houseId, footprint, areaOf(rect), this.ctx.village, hashString(houseId)), { id: model.id, seed: pointSeed(point) }, footprint);
  }

  private newHouseId(point: Vec2): string {
    return `house-${pointSeed(point).toString(36)}-${Date.now().toString(36)}`;
  }

  /** Налезает ли дом на другие (дома OSM, свои, здания из конструктора); сараи внутри дворов не мешают друг другу. */
  private blocked(b: EditedBuilding): boolean {
    const { edits } = useEditStore.getState();
    const ring = [...b.footprint, b.footprint[0]!];
    const shape = polygon([ring]);
    const xs = b.footprint.map(([x]) => x);
    const ys = b.footprint.map(([, y]) => y);
    const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    const overlaps = (other: [number, number, number, number]) =>
      other[0] <= box[2]! && other[2] >= box[0]! && other[1] <= box[3]! && other[3] >= box[1]!;
    const removed = new Set(edits.removedBuildings);
    const ignore = new Set([b.id, b.source]);
    if (this.obstacleShapes.some((o) => !removed.has(o.id) && !ignore.has(o.id) && overlaps(o.box) && booleanIntersects(shape, o.shape))) {
      return true;
    }
    const others = [
      ...edits.buildings.filter((o) => !ignore.has(o.id)).map((o) => o.footprint),
      ...useAppStore.getState().userBuildings.map((u) => u.building.footprint),
    ];
    return others.some((footprint) => footprint.length >= 3 && booleanIntersects(shape, polygon([[...footprint, footprint[0]!]])));
  }

  private hideWhileDragging(b: EditedBuilding): void {
    const { edits } = useEditStore.getState();
    this.ctx.base.setHidden(new Set([...edits.removedBuildings, b.id]));
    this.ctx.models?.setHidden(new Set([...replacedOsmIds(edits), b.id]));
    this.ctx.yardModels?.setHidden(new Set([...replacedOsmIds(edits), b.id]));
    this.ctx.layer.render(edits, undefined, b.id);
  }

  /** Вернуть скрытие и отрисовку как в правках (после отмены перетаскивания). */
  private refreshHidden(): void {
    const { edits, selection } = useEditStore.getState();
    this.ctx.base.setHidden(new Set(edits.removedBuildings));
    this.ctx.models?.setHidden(replacedOsmIds(edits));
    this.ctx.yardModels?.setHidden(replacedOsmIds(edits));
    this.ctx.layer.render(edits, selection?.type === 'building' ? selection.id : undefined);
  }

  /** Камера не должна ехать, пока тянем дом или рисуем линию левой кнопкой. */
  private setCamera(enabled: boolean): void {
    if (this.cameraOff === !enabled) return;
    this.cameraOff = !enabled;
    this.ctx.controls.setEnabled(enabled);
  }

  private capturePointer(pointerId: number): void {
    this.releasePointer();
    try {
      this.ctx.city.canvas.setPointerCapture(pointerId);
      this.pointerId = pointerId;
    } catch {
      // Указатель уже отпущен — захватывать нечего.
    }
  }

  private releasePointer(): void {
    if (this.pointerId === undefined) return;
    const canvas = this.ctx.city.canvas;
    if (canvas.hasPointerCapture(this.pointerId)) canvas.releasePointerCapture(this.pointerId);
    this.pointerId = undefined;
  }
}

export type { Handle };

const lengthOf = (line: readonly Vec2[]) => line.reduce((sum, p, i) => (i ? sum + segmentLength(line[i - 1]!, p) : 0), 0);
const isClosed = (line: readonly Vec2[]) => line.length > 3 && line[0]![0] === line[line.length - 1]![0] && line[0]![1] === line[line.length - 1]![1];

/** Прорядить точки: соседние не ближе step. */
function thin(points: readonly Vec2[], step: number): Vec2[] {
  const out: Vec2[] = [];
  for (const p of points) if (!out.length || segmentLength(out[out.length - 1]!, p) >= step) out.push(p);
  return out;
}

/** Замкнутая линия по углам. */
function closedLine<T>(points: readonly T[]): T[] {
  return [...points, points[0]!];
}

/**
 * Участок, растянутый за угол index до точки p: противоположный угол на месте, стороны — вдоль прежних осей,
 * первая сторона по-прежнему улица. Меньше MIN_PLOT_SIDE не сжимается.
 */
export function resizedPlot(original: readonly Vec2[], index: number, p: Vec2): Vec2[] {
  const [a, b, , d] = original as [Vec2, Vec2, Vec2, Vec2];
  const W = Math.hypot(b[0] - a[0], b[1] - a[1]), D = Math.hypot(d[0] - a[0], d[1] - a[1]);
  const along: Vec2 = [(b[0] - a[0]) / W, (b[1] - a[1]) / W], inward: Vec2 = [(d[0] - a[0]) / D, (d[1] - a[1]) / D];
  const uv: [number, number][] = [[0, 0], [W, 0], [W, D], [0, D]];
  const [fu, fv] = uv[(index + 2) % 4]!;
  const [ou, ov] = uv[index]!;
  const cu = (p[0] - a[0]) * along[0] + (p[1] - a[1]) * along[1];
  const cv = (p[0] - a[0]) * inward[0] + (p[1] - a[1]) * inward[1];
  // Угол не переходит за противоположный: сторона не короче MIN_PLOT_SIDE.
  const nu = ou > fu ? Math.max(cu, fu + MIN_PLOT_SIDE) : Math.min(cu, fu - MIN_PLOT_SIDE);
  const nv = ov > fv ? Math.max(cv, fv + MIN_PLOT_SIDE) : Math.min(cv, fv - MIN_PLOT_SIDE);
  const u0 = Math.min(fu, nu), u1 = Math.max(fu, nu), v0 = Math.min(fv, nv), v1 = Math.max(fv, nv);
  const P = (u: number, v: number): Vec2 => [a[0] + along[0] * u + inward[0] * v, a[1] + along[1] * u + inward[1] * v];
  return [P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1)];
}

/** Подпись: что попадёт на участок — «дом, 2 бани, сарай» (жилой дом один, лишние — сараи). */
function captureSummary(roles: readonly string[]): string {
  if (!roles.length) return 'внутри построек нет';
  const counts = new Map<string, number>();
  let houses = 0;
  for (const r of roles) {
    const role = r === 'house' && houses++ > 0 ? 'shed' : r;
    counts.set(role, (counts.get(role) ?? 0) + 1);
  }
  // Один, два-четыре, пять и больше.
  const names: Record<string, [string, string, string]> = {
    house: ['дом', 'дома', 'домов'],
    garage: ['гараж', 'гаража', 'гаражей'],
    banya: ['баня', 'бани', 'бань'],
    shed: ['сарай', 'сарая', 'сараев'],
    greenhouse: ['теплица', 'теплицы', 'теплиц'],
    well: ['колодец', 'колодца', 'колодцев'],
  };
  const word = (n: number, [one, few, many]: [string, string, string]) => {
    const m10 = n % 10, m100 = n % 100;
    return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
  };
  return ['house', 'garage', 'banya', 'shed', 'greenhouse', 'well']
    .filter((r) => counts.has(r))
    .map((r) => (counts.get(r)! > 1 ? `${counts.get(r)} ${word(counts.get(r)!, names[r]!)}` : names[r]![0]))
    .join(', ');
}
