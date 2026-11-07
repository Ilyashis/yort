import { booleanIntersects, polygon } from '@turf/turf';
import { Cartesian2, ScreenSpaceEventHandler, ScreenSpaceEventType, type Viewer } from 'cesium';
import { useAppStore } from '../store/useAppStore';
import { useEditStore, type EditTool } from '../store/useEditStore';
import { useUnderlayStore } from '../store/useUnderlayStore';
import { hashString } from '../utils/hash';
import type { BaseBuildingsLayer } from '../world/base/BaseBuildingsLayer';
import type { GroundLayer } from '../world/base/GroundLayer';
import type { BaseBuildingFeature } from '../world/base/types';
import type { Yard } from '../world/base/yards';
import {
  ROAD_KINDS,
  addFence,
  areaOf,
  centroidOf,
  fromOsm,
  lineLength,
  nearestOnLines,
  newBuilding,
  removeBuilding,
  removeFence,
  removeRoad,
  resizeByCorner,
  rotate,
  simplifyLine,
  snapEnds,
  stretchRectangle,
  translate,
  upsertBuilding,
  upsertRoad,
  type EditedBuilding,
  type LonLat,
} from '../world/edit/edits';
import type { EditLayer, Handle } from '../world/edit/EditLayer';
import { distanceToSegment, type LocalFrame, type Vec2 } from '../world/walk/localFrame';
import { isTypingTarget } from './keyboard';
import { pickGround, toLonLat } from './pick';

/** Сдвиг курсора меньше этого (px) — клик, а не перетаскивание. */
const CLICK_PX = 5;
/** Дорога «тянется от любой дороги»: начало и конец прилипают к осям ближе этого, м. */
const ROAD_SNAP_M = 10;
/** Дом выравнивается по улице, если она ближе этого, м. */
const ALIGN_TO_STREET_M = 60;
const MIN_HOUSE_SIDE = 3;
const HOTKEYS: Record<string, EditTool> = { KeyV: 'select', KeyY: 'house', KeyT: 'road', KeyB: 'fence' };

type Drag =
  | { type: 'click'; at: Cartesian2 }
  | { type: 'house'; start: Vec2; dir: Vec2; current?: Vec2 }
  | { type: 'line'; kind: 'road' | 'fence'; points: Vec2[] }
  | { type: 'move'; original: EditedBuilding; start: Vec2; current: EditedBuilding; at: Cartesian2 }
  | { type: 'rotate'; original: EditedBuilding; center: Vec2; startAngle: number; current: EditedBuilding }
  | { type: 'resize'; original: EditedBuilding; index: number; current: EditedBuilding };

export interface EditorContext {
  viewer: Viewer;
  frame: LocalFrame;
  base: BaseBuildingsLayer;
  layer: EditLayer;
  ground: GroundLayer;
  village: boolean;
  /** Оси дорог OSM (локальные метры) — для прилипания и выравнивания. */
  osmRoads: readonly Vec2[][];
  /** Дома OSM — проверка, что новый дом ни на что не налезает. */
  osmBuildings: readonly BaseBuildingFeature[];
  yards: readonly Yard[];
}

/**
 * Редактор в сцене — как в градостроителях: «Дом» — тяни по земле, дом вырастает под участок
 * (вдоль улицы); «Дорога» и «Забор» — веди линию, как карандашом (дорога прилипает к соседним);
 * «Выбор» — клик по дому, дороге или забору; дом тянут, поворачивают и растягивают за ручки.
 */
export class EditorTool {
  private readonly handler: ScreenSpaceEventHandler;
  private drag?: Drag;
  private readonly obstacleShapes: { id: string; shape: ReturnType<typeof polygon>; box: [number, number, number, number] }[];

  constructor(private readonly ctx: EditorContext) {
    this.handler = new ScreenSpaceEventHandler(ctx.viewer.scene.canvas);
    this.handler.setInputAction((e: ScreenSpaceEventHandler.PositionedEvent) => this.down(e.position), ScreenSpaceEventType.LEFT_DOWN);
    this.handler.setInputAction((e: ScreenSpaceEventHandler.MotionEvent) => this.move(e.endPosition), ScreenSpaceEventType.MOUSE_MOVE);
    this.handler.setInputAction((e: ScreenSpaceEventHandler.PositionedEvent) => this.up(e.position), ScreenSpaceEventType.LEFT_UP);
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
    return fromOsm({
      id,
      building: info.props.building,
      levels: info.props.levels,
      wallTop: info.wallTop,
      roof: info.roof,
      outline: info.outline,
      facadeColor: info.facadeColor.toCssHexString(),
      roofColor: info.roofColor?.toCssHexString(),
    });
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
    this.handler.destroy();
    window.removeEventListener('keydown', this.onKey);
    this.setCamera(true);
  }

  // --- мышь ------------------------------------------------------------------

  private down(position: Cartesian2): void {
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
      this.drag = this.pressSelect(position, point) ?? { type: 'click', at: Cartesian2.clone(position) };
      if (this.drag.type !== 'click') this.setCamera(false);
    }
  }

  private move(position: Cartesian2): void {
    const drag = this.drag;
    if (!drag || drag.type === 'click') return;
    const point = this.ground(position);
    if (!point) return;
    const { layer } = this.ctx;

    if (drag.type === 'house') {
      drag.current = point;
      const building = this.houseFrom(drag.start, point, drag.dir);
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

  private up(position: Cartesian2): void {
    const drag = this.drag;
    this.drag = undefined;
    this.setCamera(true);
    if (!drag) return;
    const store = useEditStore.getState();
    const { layer } = this.ctx;
    layer.preview(undefined);
    layer.previewLine(undefined);

    if (drag.type === 'click') {
      if (Cartesian2.distance(drag.at, position) <= CLICK_PX) this.selectAt(position);
      return;
    }
    if (drag.type === 'house') {
      const building = drag.current && this.houseFrom(drag.start, drag.current, drag.dir);
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
    if (drag.type === 'move' && Cartesian2.distance(drag.at, position) <= CLICK_PX) {
      this.refreshHidden();
      return;
    }
    store.commit(upsertBuilding(store.edits, drag.current));
  }

  /** Нажатие инструментом «Выбор»: на ручке или на выделенном доме — начать правку. */
  private pressSelect(position: Cartesian2, point: Vec2 | undefined): Drag | undefined {
    const { selection } = useEditStore.getState();
    if (selection?.type !== 'building' || !point) return undefined;
    const picked = this.ctx.viewer.scene.pick(position);
    const hit = this.ctx.layer.hit(picked);
    const pickedId = hit.building ?? this.ctx.base.buildingFromPick(picked)?.id;
    if (!hit.handle && pickedId !== selection.id) return undefined;
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
    return { type: 'move', original, start: point, current: original, at: Cartesian2.clone(position) };
  }

  /** Клик без перетаскивания: дом, забор, дорога или пусто. */
  private selectAt(position: Cartesian2): void {
    const store = useEditStore.getState();
    const picked = this.ctx.viewer.scene.pick(position);
    const hit = this.ctx.layer.hit(picked);
    const building = hit.building ?? this.ctx.base.buildingFromPick(picked)?.id;
    if (building) return store.select({ type: 'building', id: building });
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
    this.setCamera(true);
    this.ctx.layer.preview(undefined);
    this.ctx.layer.previewLine(undefined);
    this.refreshHidden();
  }

  // --- геометрия -------------------------------------------------------------------

  private ground(position: Cartesian2): Vec2 | undefined {
    const hit = pickGround(this.ctx.viewer, position);
    return hit ? this.ctx.frame.toLocal(toLonLat(hit)) : undefined;
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
    const id = `house-${hashString(`${start[0].toFixed(1)}:${start[1].toFixed(1)}`).toString(36)}-${Date.now().toString(36)}`;
    const footprint = rect.map(this.ctx.frame.toLonLat) as LonLat[];
    return newBuilding(id, footprint, areaOf(rect), this.ctx.village, hashString(id));
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
    this.ctx.layer.render(edits, undefined, b.id);
  }

  /** Вернуть скрытие и отрисовку как в правках (после отмены перетаскивания). */
  private refreshHidden(): void {
    const { edits, selection } = useEditStore.getState();
    this.ctx.base.setHidden(new Set(edits.removedBuildings));
    this.ctx.layer.render(edits, selection?.type === 'building' ? selection.id : undefined);
  }

  /** Камера не должна ехать, пока тянем дом или рисуем линию левой кнопкой. */
  private setCamera(enabled: boolean): void {
    if (this.ctx.viewer.isDestroyed()) return;
    this.ctx.viewer.scene.screenSpaceCameraController.enableInputs = enabled;
  }
}

export type { Handle };
