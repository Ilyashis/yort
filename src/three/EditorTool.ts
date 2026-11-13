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
import { useEditStore, type EditTool } from '../store/useEditStore';
import { useUnderlayStore } from '../store/useUnderlayStore';
import { hashString } from '../utils/hash';
import type { BaseBuildingFeature } from '../world/base/types';
import type { Yard } from '../world/base/yards';
import {
  ROAD_KINDS,
  addFence,
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
  upsertRoad,
  withModel,
  type EditedBuilding,
  type HouseModelRef,
  type LonLat,
} from '../world/edit/edits';
import { findHouseModel, type HouseModelId } from '../world/village/houseModels';
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
/** Дом выравнивается по улице, если она ближе этого, м. */
const ALIGN_TO_STREET_M = 60;
const MIN_HOUSE_SIDE = 3;
/** Дом-модель кликом у дороги: фасад не ближе этого к оси улицы, м (полдороги и палисадник). */
const FACADE_SETBACK_M = 6.5;
const HOTKEYS: Record<string, EditTool> = { KeyV: 'select', KeyY: 'house', KeyT: 'road', KeyB: 'fence', KeyG: 'terrain' };

/** Точка экрана (координаты клиента, px). */
type ScreenPoint = [number, number];

type Drag =
  | { type: 'click'; at: ScreenPoint }
  | { type: 'house'; start: Vec2; dir: Vec2; current?: Vec2 }
  | { type: 'line'; kind: 'road' | 'fence'; points: Vec2[] }
  | { type: 'move'; original: EditedBuilding; start: Vec2; current: EditedBuilding; at: ScreenPoint }
  | { type: 'rotate'; original: EditedBuilding; center: Vec2; startAngle: number; current: EditedBuilding }
  | { type: 'resize'; original: EditedBuilding; index: number; current: EditedBuilding };

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
    const { selection, edits, commit, select } = useEditStore.getState();
    if (!selection) return;
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
      const start = tool === 'road' ? this.snapToRoad(point) : point;
      this.drag = { type: 'line', kind: tool, points: [start] };
      this.setCamera(false);
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
      const last = drag.points[drag.points.length - 1]!;
      if (Math.hypot(point[0] - last[0], point[1] - last[1]) >= (drag.kind === 'road' ? 1.5 : 0.5)) drag.points.push(point);
      layer.previewLine([...drag.points, point].map(this.ctx.frame.toLonLat), drag.kind === 'road' ? useEditStore.getState().roadKind : 'fence');
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
    const canvas = this.ctx.city.canvas;
    const active = tool === 'select' && selection?.type === 'building' && useAppStore.getState().mode === 'explore' && !useUnderlayStore.getState().mode;
    const cursor = active ? (this.ctx.layer.cursorAt(position[0], position[1]) ?? '') : undefined;
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
      const isRoad = drag.kind === 'road';
      let line = simplifyLine(drag.points, isRoad ? 1.2 : 0.3);
      if (isRoad) line = snapEnds(line, this.roadLines(), ROAD_SNAP_M);
      if (lineLength(line) < (isRoad ? 6 : 2)) return store.notify(isRoad ? 'Дорога слишком короткая' : 'Забор слишком короткий');
      const axis = line.map(this.ctx.frame.toLonLat);
      const id = `${isRoad ? 'road' : 'fence'}-${Date.now().toString(36)}`;
      store.commit(isRoad ? upsertRoad(store.edits, { id, kind: store.roadKind, axis }) : addFence(store.edits, { id, line: axis }));
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
    const { selection } = useEditStore.getState();
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
    const hit = this.pick(position);
    if (hit.building) return store.select({ type: 'building', id: hit.building });
    if (hit.fence) return store.select({ type: 'fence', id: hit.fence });

    const point = this.ground(position);
    if (!point) return store.select(undefined);
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
    const { city, layer, base, models } = this.ctx;
    const objects = [...layer.pickables, ...base.pickables, ...(models?.pickables ?? [])].filter((object) => object.visible);
    const intersection = city.pickObject(x, y, objects);
    const hit = layer.hit(x, y, intersection);
    if (hit.handle || hit.building || hit.fence) return hit;
    const building = base.buildingFromPick(intersection)?.id ?? models?.buildingFromPick(intersection);
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

  private cancelDrag(): void {
    this.drag = undefined;
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
