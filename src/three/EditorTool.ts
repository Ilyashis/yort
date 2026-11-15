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

import { booleanIntersects, polygon } from '@turf/turf';
import { useAppStore } from '../store/useAppStore';
import { useEditStore, type EditTool, type FenceInfo } from '../store/useEditStore';
import { useUnderlayStore } from '../store/useUnderlayStore';
import { hashString } from '../utils/hash';
import type { BaseBuildingFeature } from '../world/base/types';
import type { Yard } from '../world/base/yards';
import {
  ROAD_KINDS,
  addFence,
  addStroke,
  type Edits,
  FENCE_STYLES,
  setEstateFences,
  setEstateLook,
  setFenceLine,
  setFenceLook,
  setGate,
  type FenceLook,
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
  roadWidth,
  roundCorners,
  smoothLine,
  replacedOsmIds,
  resizeByCorner,
  rotate,
  simplifyLine,
  snapEnds,
  stretchRectangle,
  translate,
  upsertBuilding,
  upsertRoad,
  withModel,
  type EditedBuilding,
  type HouseModelRef,
  type LonLat,
} from '../world/edit/edits';
import { findHouseModel, type HouseModelId } from '../world/village/houseModels';
import type { EstatePlan } from '../world/village/estates';
import { dropPoint, gateHalf, gateSpot, magnet, movePoint, runKey, samePoint } from '../world/village/fenceEdits';
import { distanceToSegment, type LocalFrame, type Vec2 } from '../world/walk/localFrame';
import type { BuildingsLayer } from './BuildingsLayer';
import type { CityScene } from './CityScene';
import { toLocal2 } from './coords';
import type { EditLayer, FenceHandles, Handle } from './EditLayer';
import type { GroundLayer } from './GroundLayer';
import type { VillageModelsLayer } from './VillageModelsLayer';
import { isTypingTarget } from './OverviewControls';

/** Сдвиг курсора меньше этого (px) — клик, а не перетаскивание. */
const CLICK_PX = 5;
/** Дорога «тянется от любой дороги»: начало и конец прилипают к осям ближе этого, м. */
const ROAD_SNAP_M = 10;
/** Дом выравнивается по улице, если она ближе этого, м. */
const ALIGN_TO_STREET_M = 60;
const MIN_HOUSE_SIDE = 3;
/** Дом-модель кликом у дороги: фасад не ближе этого к оси улицы, м (полдороги и палисадник). */
const FACADE_SETBACK_M = 6.5;
/** Магнит: к точке соседа ближе этого на экране, px; на линию забора — ближе этого. */
const SNAP_POINT_PX = 14;
const SNAP_LINE_PX = 9;
/** «+» на отрезке забора — только на отрезках длиннее этого, м. */
const INSERT_MIN_M = 2.5;
/** Запас выравнивания земли вокруг поля и площадки, м (больше плавного края обводки — 5 м): под самой площадкой ровно. */
const PAD_MARGIN = 7;
const HOTKEYS: Record<string, EditTool> = { KeyV: 'select', KeyY: 'house', KeyT: 'road', KeyB: 'fence', KeyG: 'terrain' };

/** Точка экрана (координаты клиента, px). */
type ScreenPoint = [number, number];

type Drag =
  | { type: 'click'; at: ScreenPoint }
  | { type: 'house'; start: Vec2; dir: Vec2; current?: Vec2 }
  | { type: 'line'; kind: 'road' | 'fence'; points: Vec2[] }
  | { type: 'move'; original: EditedBuilding; start: Vec2; current: EditedBuilding; at: ScreenPoint }
  | { type: 'rotate'; original: EditedBuilding; center: Vec2; startAngle: number; current: EditedBuilding }
  | { type: 'resize'; original: EditedBuilding; index: number; current: EditedBuilding }
  | {
      type: 'vertex';
      /** Где точка была: по этому месту её находят во всех заборах (стык соседей двигается целиком). */
      from: Vec2;
      /** Заборы с этой точкой (до перетаскивания). */
      affected: Map<string, Vec2[]>;
      /** Соседние точки (для «в створ»), заборы вокруг — для магнита. */
      neighbours: Vec2[];
      around: Vec2[][];
      current: Vec2;
      inserted: boolean;
      at: ScreenPoint;
      moved: boolean;
    }
  | { type: 'gate'; plot: string; streets: Vec2[][]; half: number; current?: Vec2 };

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
  /** Участки посёлка: план и план с правками — заборы правят по точкам, ворота двигают по забору. */
  estate?: { base: EstatePlan; plan: () => EstatePlan };
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
  /** Ключи заборов участков (по плану без правок) и номера участков. */
  private readonly runKeys: string[];
  private readonly plotIndex: Map<string, number>;
  /** Выбранная точка выделенного забора (Delete убирает её) и чей это забор. */
  private activeVertex?: { fence: string; point: Vec2 };
  /** Постройки, которых перетаскиваемый дом касался на своём месте (не мешают ему). */
  private touching = new Set<string>();
  /** Alt зажат — магнит выключен. */
  private alt = false;
  /** Забор по точкам: поставленные точки (локальные метры) и куда тянется «резиновый» отрезок. */
  private draft?: Vec2[];
  private draftCursor?: Vec2;
  /** Что рисуем по точкам: забор или дорогу. */
  private draftKind: 'road' | 'fence' = 'fence';

  constructor(private readonly ctx: EditorContext) {
    const canvas = ctx.city.canvas;
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerCancel);
    window.addEventListener('keydown', this.onKey);
    // capture: двойной клик, завершающий забор, не должен долететь до камеры (подлёт к точке).
    canvas.addEventListener('dblclick', this.onDoubleClick, { capture: true });
    this.runKeys = ctx.estate?.base.runs.map(runKey) ?? [];
    this.plotIndex = new Map(ctx.estate?.base.plots.map((p, i) => [p.id, i]) ?? []);
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
    const info = this.ctx.base.buildingInfo(id);
    if (!info || info.outline.length < 3) return undefined;
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
    const { selection, edits, commit, select, notify } = useEditStore.getState();
    if (!selection) return;
    // Выбрана точка забора — убираем только её (излом уходит, забор спрямляется).
    if (selection.type === 'fence' && this.activeVertex?.fence === selection.id) {
      const dropped = dropPoint(this.fenceLines(), this.activeVertex.point);
      if (!dropped) return notify('Стык заборов не убрать — его можно передвинуть');
      this.activeVertex = undefined;
      this.commitLines(dropped);
      return;
    }
    const next =
      selection.type === 'building'
        ? removeBuilding(edits, selection.id)
        : selection.type === 'road'
          ? removeRoad(edits, selection.id)
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
    canvas.removeEventListener('dblclick', this.onDoubleClick, { capture: true });
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
    this.alt = event.altKey;
    if (!event.isPrimary) return;
    if (this.draft && !this.drag) this.followDraft([event.clientX, event.clientY]);
    this.move([event.clientX, event.clientY]);
  };

  private readonly onDoubleClick = (event: MouseEvent) => {
    if (!this.draft) return;
    event.stopImmediatePropagation();
    this.finishDraft();
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
    this.touching = new Set();

    if (tool === 'house' && point) {
      this.drag = { type: 'house', start: point, dir: this.streetDirection(point) };
      this.setCamera(false);
    } else if ((tool === 'fence' && useEditStore.getState().fenceDraw === 'points') || (tool === 'road' && useEditStore.getState().roadDraw === 'points')) {
      // По точкам: клик — точка (перетаскивание — камера, как обычно).
      this.drag = { type: 'click', at: position };
    } else if ((tool === 'road' || tool === 'fence') && point) {
      // Кистью дорога начинается где нажали (не липнет): ею рисуют площадки и расширения любой формы.
      const start = tool === 'road' && useEditStore.getState().roadDraw !== 'brush' ? this.snapToRoad(point) : point;
      this.drag = { type: 'line', kind: tool, points: [start] };
      this.setCamera(false);
    } else if (tool === 'select') {
      this.drag = this.pressSelect(position, point) ?? { type: 'click', at: position };
      if (this.drag.type !== 'click') this.setCamera(false);
    }
  }

  private move(position: ScreenPoint): void {
    const drag = this.drag;
    if (!drag || drag.type === 'click') return;
    const point = this.ground(position);
    if (!point) return;
    const { layer } = this.ctx;

    if (drag.type === 'house') {
      drag.current = point;
      const building = this.houseFrom(drag.start, point, drag.dir) ?? this.modelAt(drag.start);
      layer.preview(building, !building || this.blocked(building));
    } else if (drag.type === 'line') {
      const last = drag.points[drag.points.length - 1]!;
      const brush = drag.kind === 'road' && useEditStore.getState().roadDraw === 'brush';
      if (Math.hypot(point[0] - last[0], point[1] - last[1]) >= (drag.kind === 'road' && !brush ? 1.5 : 0.5)) drag.points.push(point);
      const line = [...drag.points, point].map(this.ctx.frame.toLonLat);
      if (drag.kind === 'road') layer.previewLine(line, useEditStore.getState().roadKind, this.newRoadWidth());
      else layer.previewLine(line, 'fence');
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
    } else if (drag.type === 'vertex') {
      drag.moved ||= screenDistance(drag.at, position) > CLICK_PX;
      if (!drag.moved) return;
      const [reachPoint, reachLine] = this.snapReach(point);
      const snap = this.alt ? undefined : magnet(point, drag.neighbours, drag.around, drag.from, reachPoint, reachLine);
      drag.current = snap?.point ?? point;
      layer.setSnap(snap?.point);
      this.showFenceWith(movePoint(drag.affected, drag.from, drag.current), drag.current);
    } else if (drag.type === 'gate') {
      const spot = gateSpot(drag.streets, point, drag.half);
      if (!spot) return;
      drag.current = spot;
      this.showFenceWith(new Map(), undefined, spot);
    }
  }

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
      if (screenDistance(drag.at, position) > CLICK_PX) return;
      if ((store.tool === 'fence' && store.fenceDraw === 'points') || (store.tool === 'road' && store.roadDraw === 'points')) this.addDraftPoint(position);
      else this.selectAt(position);
      return;
    }
    if (drag.type === 'vertex') {
      layer.setSnap(undefined);
      const fence = store.selection?.type === 'fence' ? store.selection.id : '';
      if (!drag.moved && !drag.inserted) {
        // Клик по точке — выбрать её (Delete уберёт).
        this.activeVertex = { fence, point: drag.from };
        this.showFence();
        return;
      }
      this.activeVertex = { fence, point: drag.current };
      this.commitLines(movePoint(drag.affected, drag.from, drag.current));
      return;
    }
    if (drag.type === 'gate') {
      if (!drag.current) return void this.showFence();
      store.commit(setGate(store.edits, drag.plot, { at: this.ctx.frame.toLonLat(drag.current) as LonLat }));
      return;
    }
    if (drag.type === 'house') {
      // С моделью — клик ставит дом обычного размера фасадом к улице, растяжка — по размеру.
      const building = (drag.current && this.houseFrom(drag.start, drag.current, drag.dir)) || this.modelAt(drag.start);
      if (!building) return store.notify('Растяните дом побольше — хотя бы 3 × 3 м');
      if (this.blocked(building)) return store.notify('Здесь уже стоит дом — выберите свободное место');
      store.commit(this.withPad(upsertBuilding(store.edits, building), building));
      store.setTool('select');
      store.select({ type: 'building', id: building.id });
      return;
    }
    if (drag.type === 'line') {
      const isRoad = drag.kind === 'road';
      const brush = isRoad && store.roadDraw === 'brush';
      // Кисть — как вели (точно и плавно), линия — спрямлённая, концы липнут к дорогам.
      let line = brush ? smoothLine(simplifyLine(drag.points, 0.25)) : simplifyLine(drag.points, isRoad ? 1.2 : 0.3);
      if (isRoad && !brush) line = snapEnds(line, this.roadLines(), ROAD_SNAP_M);
      else if (!this.alt) line = this.snapFenceEnds(line);
      if (lineLength(line) < (brush ? 0.5 : isRoad ? 6 : 2)) return store.notify(isRoad ? 'Дорога слишком короткая' : 'Забор слишком короткий');
      // Кисть одним касанием — круглое пятно: ось из двух близких точек.
      if (line.length < 2) line = [line[0]!, [line[0]![0] + 0.3, line[0]![1]]];
      const axis = line.map(this.ctx.frame.toLonLat);
      if (isRoad) return this.commitRoad(axis);
      store.commit(addFence(store.edits, { id: `fence-${Date.now().toString(36)}`, line: axis }));
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
    store.commit(this.withPad(upsertBuilding(store.edits, drag.current), drag.current));
  }

  /** Нажатие инструментом «Выбор»: на ручке или на выделенном доме — начать правку. */
  private pressSelect(position: ScreenPoint, point: Vec2 | undefined): Drag | undefined {
    const { selection } = useEditStore.getState();
    if (selection?.type === 'fence') return this.pressFence(position, selection.id);
    if (selection?.type !== 'building' || !point) return undefined;
    const hit = this.pick(position);
    if (!hit.handle && hit.building !== selection.id) return undefined;
    const original = this.resolve(selection.id);
    if (!original) return undefined;
    // Дом OSM на время правки прячем — виден только предпросмотр.
    this.hideWhileDragging(original);
    this.touching = this.touchingOf(original);
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
    const hit = this.pick(position);
    if (hit.building) return store.select({ type: 'building', id: hit.building });
    if (hit.fence) return store.select({ type: 'fence', id: hit.fence });

    const point = this.ground(position);
    if (!point) return store.select(undefined);
    // Заборы участков посёлка — ближайший (общий забор — участку с той стороны, где клик).
    if (this.ctx.estate) {
      const plot = this.estatePlotAt(point);
      if (plot) return store.select({ type: 'fence', id: plot });
    }
    // Заборы дворов — по близости к линии.
    const yard = this.ctx.yards.find(
      (y) => !store.edits.removedYards.includes(y.houseId) && y.fence.some(([a, b]) => distanceToSegment(point, a, b) < 2),
    );
    if (yard) return store.select({ type: 'fence', id: yard.houseId });
    // Свои дороги — по оси, дороги OSM — по полигону проезжей части.
    const own = store.edits.roads.find((r) => {
      const axis = r.axis.map(this.ctx.frame.toLocal);
      return axis.some((p, i) => i > 0 && distanceToSegment(point, axis[i - 1]!, p) < roadWidth(r) / 2 + 1);
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
    const { city, layer, base, models } = this.ctx;
    const objects = [...layer.pickables, ...base.pickables, ...(models?.pickables ?? [])].filter((object) => object.visible);
    const intersection = city.pickObject(x, y, objects);
    const hit = layer.hit(x, y, intersection);
    if (hit.handle || hit.building || hit.fence) return hit;
    const building = base.buildingFromPick(intersection)?.id ?? models?.buildingFromPick(intersection);
    return building ? { building } : {};
  }

  // --- забор по точкам ------------------------------------------------------------

  /** Концы забора, нарисованного карандашом, — к точкам и линиям соседних заборов. */
  private snapFenceEnds(line: Vec2[]): Vec2[] {
    const out = [...line];
    const lines = [...this.fenceLines().values()];
    for (const i of [0, out.length - 1]) {
      const p = out[i]!;
      const [reachPoint, reachLine] = this.snapReach(p);
      const near = lines.filter((l) => l.some((q) => Math.abs(q[0] - p[0]) < 60 && Math.abs(q[1] - p[1]) < 60));
      const snap = magnet(p, [], near, [Number.NaN, Number.NaN], reachPoint, reachLine);
      if (snap) out[i] = snap.point;
    }
    return out;
  }

  /** Ширина новой дороги: из настройки или по типу. */
  private newRoadWidth(): number {
    const { roadWidth: width, roadKind } = useEditStore.getState();
    return width ?? ROAD_KINDS[roadKind].width;
  }

  private commitRoad(axis: LonLat[]): void {
    const store = useEditStore.getState();
    const id = `road-${Date.now().toString(36)}`;
    store.commit(upsertRoad(store.edits, { id, kind: store.roadKind, axis, ...(store.roadWidth !== undefined ? { width: store.roadWidth } : {}) }));
  }

  /** Бросить недорисованный забор или дорогу (сменили инструмент, Esc). */
  cancelDraft(): void {
    if (!this.draft) return;
    this.draft = undefined;
    this.draftCursor = undefined;
    this.ctx.layer.previewLine(undefined);
    this.ctx.layer.setSnap(undefined);
    this.ctx.layer.setFenceHandles(undefined);
  }

  /** Точка под курсором с магнитом: к точкам и линиям заборов, к первой точке (замкнуть). */
  private draftPoint(position: ScreenPoint): { point: Vec2; snapped: boolean } | undefined {
    const raw = this.ground(position);
    if (!raw) return undefined;
    if (this.alt) return { point: raw, snapped: false };
    const road = this.draftKind === 'road';
    // Дорога липнет к осям дорог (с запасом побольше), забор — к заборам.
    const [reachPoint, reachLine] = this.snapReach(raw, road ? 1.6 : 1);
    const lines = road ? this.roadLines() : [...this.fenceLines().values()];
    const near = lines.filter((line) => line.some((p) => Math.abs(p[0] - raw[0]) < 120 && Math.abs(p[1] - raw[1]) < 120));
    const draft = this.draft ?? [];
    // Своя первая точка — замкнуть.
    if (draft.length >= 2) near.push([draft[0]!]);
    const snap = magnet(raw, [], near, [Number.NaN, Number.NaN], reachPoint, reachLine);
    return snap ? { point: snap.point, snapped: true } : { point: raw, snapped: false };
  }

  private addDraftPoint(position: ScreenPoint): void {
    const hit = this.draftPoint(position);
    if (!hit) return;
    if (!this.draft) this.draftKind = useEditStore.getState().tool === 'road' ? 'road' : 'fence';
    const draft = (this.draft ??= []);
    const last = draft[draft.length - 1];
    // Двойной клик ставит точку дважды — вторую пропускаем.
    if (last && Math.hypot(hit.point[0] - last[0], hit.point[1] - last[1]) < 0.3) return;
    draft.push(hit.point);
    // Клик в первую точку — забор замкнут.
    if (draft.length >= 3 && samePoint(hit.point, draft[0]!)) return this.finishDraft();
    this.showDraft();
  }

  private followDraft(position: ScreenPoint): void {
    const hit = this.draftPoint(position);
    this.draftCursor = hit?.point;
    this.ctx.layer.setSnap(hit?.snapped ? hit.point : undefined);
    this.showDraft();
  }

  private showDraft(): void {
    const draft = this.draft ?? [];
    const line = this.draftCursor ? [...draft, this.draftCursor] : draft;
    const store = useEditStore.getState();
    if (this.draftKind === 'road') this.ctx.layer.previewLine(line.map(this.ctx.frame.toLonLat), store.roadKind, this.newRoadWidth());
    else this.ctx.layer.previewLine(line.map(this.ctx.frame.toLonLat), 'fence');
    this.ctx.layer.setFenceHandles({ vertices: [...draft], inserts: [] });
  }

  private finishDraft(): void {
    const draft = this.draft ?? [];
    this.cancelDraft();
    const store = useEditStore.getState();
    const line = draft.filter((p, i) => i === 0 || !samePoint(p, draft[i - 1]!));
    if (this.draftKind === 'road') {
      if (line.length < 2 || lineLength(line) < 4) return store.notify('Дорога слишком короткая — поставьте хотя бы две точки');
      // Повороты — плавной дугой (радиус — по ширине дороги), как у настоящих дорог.
      const width = this.newRoadWidth();
      const axis = roundCorners(line, Math.max(4, width * 1.5)).map(this.ctx.frame.toLonLat);
      return this.commitRoad(axis);
    }
    if (line.length < 2 || lineLength(line) < 2) return store.notify('Забор слишком короткий — поставьте хотя бы две точки');
    const id = `fence-${Date.now().toString(36)}`;
    store.commit(addFence(store.edits, { id, line: line.map(this.ctx.frame.toLonLat) }));
  }

  // --- заборы: точки и ворота -------------------------------------------------------

  /**
   * Подсветка и ручки выделенного забора (свой или участка посёлка). false — выделен не такой забор
   * (двор города: его подсвечивает сцена по-старому).
   */
  showFence(): boolean {
    return this.showFenceWith(new Map());
  }

  /** Есть ли у участка правки забора или ворот. */
  fenceEdited(id: string): boolean {
    const { edits } = useEditStore.getState();
    if (edits.gates.some((g) => g.plot === id)) return true;
    const keys = new Set(this.plotRunKeys(id));
    return edits.estateFences.some((f) => keys.has(f.key));
  }

  /** Вид выделенного забора: свой или участка (уличный — или первый, если улицы нет), и его ворота. */
  fenceInfo(id: string): FenceInfo | undefined {
    const { edits } = useEditStore.getState();
    const own = edits.fences.find((f) => f.id === id);
    if (own) {
      const style = own.style ?? 'boards';
      return { own: true, style, height: own.height ?? FENCE_STYLES[style].height, color: own.color, hasStreet: false };
    }
    const estate = this.ctx.estate;
    if (!estate || !this.plotIndex.has(id)) return undefined;
    const plan = estate.plan();
    const runs = plan.runs.filter((r) => r.owners.includes(id));
    const street = runs.find((r) => r.kind === 'street' && r.owners[0] === id);
    const run = street ?? runs[0];
    if (!run) return undefined;
    const gate = plan.plots[this.plotIndex.get(id)!]!.gate;
    return {
      own: false,
      style: run.style,
      height: run.height,
      color: run.color,
      hasStreet: !!street,
      ...(gate ? { gate: { wicketSide: gate.wicketSide, canopy: gate.canopy } } : {}),
    };
  }

  /** Тип, высота, цвет забора: своего — его; участка — уличного или всех заборов участка. */
  setFenceLook(id: string, target: 'street' | 'all', look: FenceLook): void {
    const store = useEditStore.getState();
    if (store.edits.fences.some((f) => f.id === id)) return store.commit(setFenceLook(store.edits, id, look));
    const base = this.ctx.estate?.base.runs ?? [];
    const keys = base.flatMap((run, k) =>
      run.owners.includes(id) && (target === 'all' || (run.kind === 'street' && run.owners[0] === id)) ? [this.runKeys[k]!] : [],
    );
    if (keys.length) store.commit(setEstateLook(store.edits, keys, look));
  }

  /** Ворота участка: сторона калитки, козырёк. */
  setGateOption(id: string, patch: { wicketSide?: -1 | 1; canopy?: boolean }): void {
    const store = useEditStore.getState();
    store.commit(setGate(store.edits, id, patch));
  }

  /** Вернуть забор участка и ворота как были. */
  resetFence(id: string): void {
    const store = useEditStore.getState();
    const keys = this.plotRunKeys(id);
    const next = setGate(setEstateFences(store.edits, new Map(keys.map((k) => [k, undefined]))), id, undefined);
    this.activeVertex = undefined;
    store.commit(next);
  }

  /** Ключи заборов участка (по плану без правок). */
  private plotRunKeys(id: string): string[] {
    return (this.ctx.estate?.base.runs ?? []).flatMap((run, k) => (run.owners.includes(id) ? [this.runKeys[k]!] : []));
  }

  /** Ломаные заборов, которые можно править: участков (с правками) и свои. Ключ: run:<ключ> или own:<id>. */
  private fenceLines(): Map<string, Vec2[]> {
    const out = new Map<string, Vec2[]>();
    const { edits } = useEditStore.getState();
    const estate = this.ctx.estate;
    if (estate) {
      const removed = new Set(edits.removedYards);
      const plan = estate.plan();
      plan.runs.forEach((run, k) => {
        if (!run.owners.every((o) => removed.has(o))) out.set(`run:${this.runKeys[k]}`, run.line);
      });
    }
    for (const f of edits.fences) out.set(`own:${f.id}`, f.line.map(this.ctx.frame.toLocal));
    return out;
  }

  /** Заборы выделения: свой забор — он сам, участок — все его заборы. */
  private selectedKeys(id: string, lines: ReadonlyMap<string, Vec2[]>): string[] {
    if (lines.has(`own:${id}`)) return [`own:${id}`];
    return this.plotRunKeys(id)
      .map((k) => `run:${k}`)
      .filter((k) => lines.has(k));
  }

  /** Подсветка и ручки выделенного забора с заменёнными на время перетаскивания ломаными. */
  private showFenceWith(changed: ReadonlyMap<string, Vec2[]>, active?: Vec2, gate?: Vec2): boolean {
    const { layer, frame } = this.ctx;
    const { selection } = useEditStore.getState();
    const id = selection?.type === 'fence' ? selection.id : undefined;
    if (this.activeVertex && this.activeVertex.fence !== id) this.activeVertex = undefined;
    const lines = this.fenceLines();
    const keys = id ? this.selectedKeys(id, lines) : [];
    if (!id || !keys.length) {
      layer.setFenceHandles(undefined);
      return false;
    }
    for (const [key, line] of changed) lines.set(key, line);
    const spec: FenceHandles = { vertices: [], inserts: [], active: active ?? this.activeVertex?.point };
    for (const key of keys) {
      const line = lines.get(key)!;
      for (const p of line) if (!spec.vertices.some((q) => samePoint(p, q))) spec.vertices.push(p);
      line.forEach((p, i) => {
        const q = line[i + 1];
        if (q && Math.hypot(q[0] - p[0], q[1] - p[1]) >= INSERT_MIN_M) spec.inserts.push({ line: key, index: i, point: [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2] });
      });
    }
    // Ворота участка — синей ручкой; пока их тянут — проём подсвечен на заборе.
    const plot = this.ctx.estate && this.plotIndex.has(id) ? this.ctx.estate.plan().plots[this.plotIndex.get(id)!] : undefined;
    const highlight = keys.map((k) => lines.get(k)!.map(frame.toLonLat));
    if (plot?.gate) {
      spec.gate = gate ?? plot.gate.at;
      if (gate) {
        const half = gateHalf(plot.gate);
        const along = plot.gate.along;
        highlight.push([frame.toLonLat([gate[0] - along[0] * half, gate[1] - along[1] * half]), frame.toLonLat([gate[0] + along[0] * half, gate[1] + along[1] * half])]);
      }
    }
    layer.highlight(highlight);
    layer.setFenceHandles(spec);
    return true;
  }

  /** Нажатие на ручку выделенного забора: точка, «+» (новая точка) или ворота. */
  private pressFence(position: ScreenPoint, id: string): Drag | undefined {
    const handle = this.ctx.layer.hit(...position).handle;
    if (!handle) return undefined;
    const lines = this.fenceLines();
    if (handle.handle === 'gate') {
      const plot = this.ctx.estate?.plan().plots[this.plotIndex.get(id) ?? -1];
      if (!plot?.gate) return undefined;
      const streets = this.ctx.estate!.plan()
        .runs.filter((r) => r.kind === 'street' && r.owners[0] === id)
        .map((r) => r.line);
      return streets.length ? { type: 'gate', plot: id, streets, half: gateHalf(plot.gate) } : undefined;
    }
    if (handle.handle !== 'vertex' && handle.handle !== 'insert') return undefined;
    let affected: Map<string, Vec2[]>;
    let neighbours: Vec2[] = [];
    const from = handle.point;
    if (handle.handle === 'insert') {
      const line = lines.get(handle.line);
      if (!line) return undefined;
      const next = [...line.slice(0, handle.index + 1), from, ...line.slice(handle.index + 1)];
      affected = new Map([[handle.line, next]]);
      lines.set(handle.line, next);
      neighbours = [line[handle.index]!, line[handle.index + 1]!];
    } else {
      affected = new Map([...lines].filter(([, line]) => line.some((p) => samePoint(p, from))));
      if (affected.size === 1) {
        const line = [...affected.values()][0]!;
        const i = line.findIndex((p) => samePoint(p, from));
        if (i > 0 && i < line.length - 1) neighbours = [line[i - 1]!, line[i + 1]!];
      }
    }
    // Магнит — к заборам вокруг (60 м).
    const around = [...lines.values()].filter((line) => line.some((p) => Math.abs(p[0] - from[0]) < 60 && Math.abs(p[1] - from[1]) < 60));
    return { type: 'vertex', from, affected, neighbours, around, current: from, inserted: handle.handle === 'insert', at: position, moved: false };
  }

  /** Новые ломаные заборов → правки (одной правкой, отмена — Ctrl+Z). */
  private commitLines(changed: ReadonlyMap<string, Vec2[]>): void {
    const store = useEditStore.getState();
    let next = store.edits;
    const runs = new Map<string, LonLat[]>();
    for (const [key, raw] of changed) {
      // Точку бросили на соседнюю — двойную убираем.
      const line = raw.filter((p, i) => i === 0 || !samePoint(p, raw[i - 1]!));
      if (line.length < 2) continue;
      const lonLat = line.map(this.ctx.frame.toLonLat) as LonLat[];
      if (key.startsWith('run:')) runs.set(key.slice(4), lonLat);
      else next = setFenceLine(next, key.slice(4), lonLat);
    }
    if (runs.size) next = setEstateFences(next, runs);
    store.commit(next);
  }

  /** Участок, чей забор под точкой (ближе 2 м): общий — того, с чьей стороны точка. */
  private estatePlotAt(point: Vec2): string | undefined {
    const estate = this.ctx.estate!;
    const removed = new Set(useEditStore.getState().edits.removedYards);
    let best: { owners: string[]; distance: number } | undefined;
    for (const run of estate.plan().runs) {
      if (run.owners.every((o) => removed.has(o))) continue;
      const snap = nearestOnLines(point, [run.line]);
      if (snap && snap.distance < 2 && (!best || snap.distance < best.distance)) best = { owners: run.owners, distance: snap.distance };
    }
    if (!best) return undefined;
    const live = best.owners.filter((o) => !removed.has(o));
    const inside = live.find((id) => {
      const plot = estate.base.plots[this.plotIndex.get(id) ?? -1];
      return plot && pointInRing(point, plot.ring);
    });
    return inside ?? live[0];
  }

  /** Радиус магнита в метрах — по масштабу на экране у этой точки. */
  private snapReach(point: Vec2, factor = 1): [number, number] {
    const a = this.ctx.layer.screenOf(point);
    const b = this.ctx.layer.screenOf([point[0] + 1, point[1]]);
    const c = this.ctx.layer.screenOf([point[0], point[1] + 1]);
    const px = a && b && c ? Math.max(Math.hypot(b[0] - a[0], b[1] - a[1]), Math.hypot(c[0] - a[0], c[1] - a[1])) : 20;
    const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
    return [clamp((SNAP_POINT_PX * factor) / px, 0.4, 6 * factor), clamp((SNAP_LINE_PX * factor) / px, 0.25, 3 * factor)];
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
    const tool = HOTKEYS[event.code];
    if (tool) {
      store.setTool(store.tool === tool ? undefined : tool);
      return;
    }
    if (this.draft) {
      if (event.code === 'Enter') this.finishDraft();
      else if (event.code === 'Escape') this.cancelDraft();
      else if (event.code === 'Backspace' || event.code === 'Delete') {
        this.draft.pop();
        if (!this.draft.length) this.cancelDraft();
        else this.showDraft();
      } else return;
      event.preventDefault();
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

  private cancelDrag(): void {
    this.drag = undefined;
    this.releasePointer();
    this.setCamera(true);
    this.ctx.layer.preview(undefined);
    this.ctx.layer.previewLine(undefined);
    this.ctx.layer.setSnap(undefined);
    this.refreshHidden();
    this.showFence();
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

  /**
   * Поле и площадки лежат на земле: под ними (с запасом PAD_MARGIN м) земля выравнивается к средней высоте —
   * тем же мазком «выровнять обводкой», что и в «Рельефе» (одна правка с самой площадкой — одна отмена).
   */
  private withPad(edits: Edits, b: EditedBuilding): Edits {
    if (!b.model || findHouseModel(b.model.id)?.group !== 'leisure') return edits;
    const local = this.local(b);
    const center = centroidOf(local);
    const grown = local.map(([x, y]): Vec2 => {
      const dx = x - center[0];
      const dy = y - center[1];
      const d = Math.hypot(dx, dy) || 1;
      return [x + (dx / d) * PAD_MARGIN * Math.SQRT2, y + (dy / d) * PAD_MARGIN * Math.SQRT2];
    });
    return addStroke(edits, {
      id: `pad-${b.id}-${Date.now().toString(36)}`,
      mode: 'flatten',
      radius: 8,
      strength: 1,
      dabs: [],
      area: grown.map(this.ctx.frame.toLonLat) as [number, number][],
    });
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
    const ignore = new Set<string | undefined>([b.id, b.source, ...this.touching]);
    if (this.obstacleShapes.some((o) => !removed.has(o.id) && !ignore.has(o.id) && overlaps(o.box) && booleanIntersects(shape, o.shape))) return true;
    const others = [
      ...edits.buildings.filter((o) => !ignore.has(o.id)).map((o) => o.footprint),
      ...useAppStore.getState().userBuildings.map((u) => u.building.footprint),
    ];
    return others.some((footprint) => footprint.length >= 3 && booleanIntersects(shape, polygon([[...footprint, footprint[0]!]])));
  }

  /**
   * Постройки, которых дом уже касается на своём месте (пристройки и сени из съёмки, сарай вплотную, модель
   * шире контура OSM): двигать дом они не мешают — иначе его нельзя сдвинуть даже на сантиметр.
   */
  private touchingOf(b: EditedBuilding): Set<string> {
    this.touching = new Set();
    const ids = new Set<string>();
    for (const id of [...this.obstacleShapes.map((o) => o.id), ...useEditStore.getState().edits.buildings.map((o) => o.id)]) {
      if (id === b.id || id === b.source) continue;
      ids.add(id);
    }
    const shape = polygon([[...b.footprint, b.footprint[0]!]]);
    const out = new Set<string>();
    for (const o of this.obstacleShapes) if (ids.has(o.id) && booleanIntersects(shape, o.shape)) out.add(o.id);
    for (const o of useEditStore.getState().edits.buildings)
      if (ids.has(o.id) && o.footprint.length >= 3 && booleanIntersects(shape, polygon([[...o.footprint, o.footprint[0]!]]))) out.add(o.id);
    return out;
  }

  private hideWhileDragging(b: EditedBuilding): void {
    const { edits } = useEditStore.getState();
    this.ctx.base.setHidden(new Set([...edits.removedBuildings, b.id]));
    this.ctx.models?.setHidden(new Set([...replacedOsmIds(edits), b.id]));
    this.ctx.layer.render(edits, undefined, b.id);
  }

  /** Вернуть скрытие и отрисовку как в правках (после отмены перетаскивания). */
  private refreshHidden(): void {
    const { edits, selection } = useEditStore.getState();
    this.ctx.base.setHidden(new Set(edits.removedBuildings));
    this.ctx.models?.setHidden(replacedOsmIds(edits));
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

function pointInRing([x, y]: Vec2, ring: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
