import {
  CallbackProperty,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  ColorMaterialProperty,
  ConstantProperty,
  PolygonHierarchy,
  SceneTransforms,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  type Entity,
  type Viewer,
} from 'cesium';
import type { LonLat } from '../world/user/plot';
import { isTypingTarget } from './keyboard';
import { pickGround, toLonLat } from './pick';

export interface PlotDrawingCallbacks {
  /** Изменился набор поставленных вершин. */
  onChange: (points: LonLat[]) => void;
  /** Контур замкнут (≥ 3 вершины). */
  onFinish: (points: LonLat[]) => void;
  onCancel: () => void;
}

export const PLOT_COLORS = {
  draft: '#f5a524',
  valid: '#3ecf8e',
  invalid: '#ff6b6b',
} as const;

type PlotLook = keyof typeof PLOT_COLORS;

/** Клик ближе этого расстояния (в пикселях) к первой вершине замыкает контур. */
const CLOSE_RING_PX = 12;
/**
 * На плоском рельефе поверхности земли (дороги, газоны) — обычные примитивы,
 * и прижатый к земле участок оказался бы под ними. Поэтому рисуем его чуть выше.
 */
const FLAT_PLOT_HEIGHT = 0.3;
/** Вершины ближе этого расстояния (м) считаются одной точкой (двойной клик и т. п.). */
const MIN_VERTEX_DISTANCE_M = 0.5;

/**
 * Рисование участка на земле: клик — вершина, двойной клик / Enter / клик по первой
 * вершине — завершить, правый клик / Backspace — убрать последнюю, Esc — отмена.
 *
 * Левый клик сюда передаёт CityViewer (handleClick) — так один и тот же клик
 * не может одновременно поставить вершину и выбрать здание.
 */
export class PlotDrawingTool {
  private readonly handler: ScreenSpaceEventHandler;
  private readonly polygon: Entity;
  private readonly outline: Entity;
  private vertices: Entity[] = [];
  private points: Cartesian3[] = [];
  private cursor: Cartesian3 | undefined;
  private drawing = false;

  constructor(
    private readonly viewer: Viewer,
    private readonly callbacks: PlotDrawingCallbacks,
    private readonly clampToGround: boolean,
  ) {
    this.polygon = viewer.entities.add({
      show: false,
      polygon: {
        hierarchy: new PolygonHierarchy([]),
        height: clampToGround ? undefined : FLAT_PLOT_HEIGHT,
      },
    });
    this.outline = viewer.entities.add({
      show: false,
      polyline: { positions: [], width: 3, clampToGround },
    });
    this.setLook('draft');

    this.handler = new ScreenSpaceEventHandler(viewer.scene.canvas);
    this.handler.setInputAction(
      (e: ScreenSpaceEventHandler.MotionEvent) => this.onMouseMove(e.endPosition),
      ScreenSpaceEventType.MOUSE_MOVE,
    );
    this.handler.setInputAction(() => this.drawing && this.finish(), ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    this.handler.setInputAction(() => this.drawing && this.undo(), ScreenSpaceEventType.RIGHT_CLICK);
    window.addEventListener('keydown', this.onKeyDown);
  }

  get isDrawing(): boolean {
    return this.drawing;
  }

  start(): void {
    this.reset();
    this.drawing = true;
    this.setLook('draft');
    this.setDynamic(true);
    this.polygon.show = true;
    this.outline.show = true;
    this.viewer.canvas.style.cursor = 'crosshair';
    this.viewer.scene.requestRender();
  }

  handleClick(position: Cartesian2): void {
    if (!this.drawing) return;

    if (this.points.length >= 3 && this.isNearFirstVertex(position)) {
      this.finish();
      return;
    }

    const point = this.pick(position);
    if (!point) return;
    const last = this.points[this.points.length - 1];
    if (last && Cartesian3.distance(last, point) < MIN_VERTEX_DISTANCE_M) return;

    this.points.push(point);
    this.vertices.push(this.addVertex(point));
    this.emitChange();
  }

  undo(): void {
    if (!this.drawing || this.points.length === 0) return;
    this.points.pop();
    const vertex = this.vertices.pop();
    if (vertex) this.viewer.entities.remove(vertex);
    this.emitChange();
  }

  finish(): void {
    if (!this.drawing || this.points.length < 3) return;
    this.drawing = false;
    this.cursor = undefined;
    this.setDynamic(false);
    this.viewer.canvas.style.cursor = '';
    this.viewer.scene.requestRender();
    this.callbacks.onFinish(this.lonLats());
  }

  cancel(): void {
    if (!this.drawing) return;
    this.reset();
    this.callbacks.onCancel();
  }

  /** Подкрашивает готовый участок по результату проверки. */
  showResult(valid: boolean): void {
    this.setLook(valid ? 'valid' : 'invalid');
    this.viewer.scene.requestRender();
  }

  /** Убирает участок со сцены без колбэков. */
  reset(): void {
    this.drawing = false;
    this.cursor = undefined;
    this.points = [];
    for (const vertex of this.vertices) this.viewer.entities.remove(vertex);
    this.vertices = [];
    this.polygon.show = false;
    this.outline.show = false;
    this.viewer.canvas.style.cursor = '';
    this.viewer.scene.requestRender();
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    this.handler.destroy();
    if (!this.viewer.isDestroyed()) {
      this.reset();
      this.viewer.entities.remove(this.polygon);
      this.viewer.entities.remove(this.outline);
    }
  }

  // --- внутреннее -----------------------------------------------------------

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (!this.drawing || isTypingTarget(event.target)) return;

    if (event.key === 'Enter') this.finish();
    else if (event.key === 'Escape') this.cancel();
    else if (event.key === 'Backspace' || event.key === 'Delete') this.undo();
    else return;
    event.preventDefault();
  };

  private onMouseMove(position: Cartesian2): void {
    if (!this.drawing) return;
    this.cursor = this.pick(position);
    this.viewer.scene.requestRender();
  }

  private emitChange(): void {
    this.viewer.scene.requestRender();
    this.callbacks.onChange(this.lonLats());
  }

  /** Точка на земле (сквозь здания), на плоском рельефе — приподнятая над слоями земли. */
  private pick(position: Cartesian2): Cartesian3 | undefined {
    const ground = pickGround(this.viewer, position);
    if (!ground || this.clampToGround) return ground;
    const c = Cartographic.fromCartesian(ground);
    return Cartesian3.fromRadians(c.longitude, c.latitude, FLAT_PLOT_HEIGHT);
  }

  private isNearFirstVertex(position: Cartesian2): boolean {
    const first = this.points[0];
    if (!first) return false;
    const onScreen = SceneTransforms.worldToWindowCoordinates(this.viewer.scene, first);
    return !!onScreen && Cartesian2.distance(onScreen, position) <= CLOSE_RING_PX;
  }

  /** Вершины плюс «резиновая» точка под курсором, пока идёт рисование. */
  private shape(): Cartesian3[] {
    return this.drawing && this.cursor ? [...this.points, this.cursor] : this.points;
  }

  /** Во время рисования контур пересчитывается каждый кадр, после — становится статичным. */
  private setDynamic(dynamic: boolean): void {
    const polygon = this.polygon.polygon!;
    const polyline = this.outline.polyline!;
    const ring = (positions: Cartesian3[]) =>
      positions.length > 2 ? [...positions, positions[0]!] : positions;

    if (dynamic) {
      polygon.hierarchy = new CallbackProperty(() => new PolygonHierarchy(this.shape()), false);
      polyline.positions = new CallbackProperty(() => ring(this.shape()), false);
    } else {
      polygon.hierarchy = new ConstantProperty(new PolygonHierarchy([...this.points]));
      polyline.positions = new ConstantProperty(ring([...this.points]));
    }
  }

  private setLook(look: PlotLook): void {
    const color = Color.fromCssColorString(PLOT_COLORS[look]);
    this.polygon.polygon!.material = new ColorMaterialProperty(color.withAlpha(0.35));
    this.outline.polyline!.material = new ColorMaterialProperty(color);
  }

  private addVertex(position: Cartesian3): Entity {
    return this.viewer.entities.add({
      position,
      point: {
        pixelSize: 9,
        color: Color.WHITE,
        outlineColor: Color.fromCssColorString(PLOT_COLORS.draft),
        outlineWidth: 2,
        // Вершины видны поверх зданий.
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
  }

  private lonLats(): LonLat[] {
    return this.points.map(toLonLat);
  }
}
