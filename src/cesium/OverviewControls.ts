import {
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  CameraEventType,
  HeadingPitchRange,
  KeyboardEventModifier,
  Math as CesiumMath,
  Matrix4,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  Transforms,
  type Viewer,
} from 'cesium';
import { OVERVIEW_KEYS, axesFrom, isShift, panSpeed } from './controlsMath';
import { isTypingTarget } from './keyboard';
import { pickGround, toLonLat } from './pick';

/** Скорость поворота клавишами Q/E, рад/с. */
const TURN_SPEED = 1.2;
/** Не ближе к земле и не дальше от неё, м. */
const MIN_ZOOM_DISTANCE = 15;
const MAX_ZOOM_DISTANCE = 15_000;

export interface OverviewControlsOptions {
  /** Высота земли (рельеф) в точке. */
  heightAt: (lon: number, lat: number) => number;
  /** Работает ли управление сейчас (на прогулке — нет). */
  isActive: () => boolean;
}

/**
 * Управление камерой «как в городских стройках»:
 *  - левая кнопка — двигать карту, колесо/щипок — приблизить;
 *  - правая кнопка (или Shift/Ctrl + левая) — повернуть и наклонить вокруг точки под курсором;
 *  - W A S D / стрелки — лететь над городом, Q/E — поворот вокруг центра экрана, R/F или +/− — ближе/дальше;
 *  - двойной клик — плавно подлететь к точке.
 */
export class OverviewControls {
  private readonly pressed = new Set<string>();
  private readonly handler: ScreenSpaceEventHandler;
  private frame: number | undefined;
  private lastTime = 0;

  constructor(
    private readonly viewer: Viewer,
    private readonly options: OverviewControlsOptions,
  ) {
    const controller = viewer.scene.screenSpaceCameraController;
    controller.zoomEventTypes = [CameraEventType.WHEEL, CameraEventType.PINCH];
    controller.tiltEventTypes = [
      CameraEventType.RIGHT_DRAG,
      CameraEventType.MIDDLE_DRAG,
      CameraEventType.PINCH,
      { eventType: CameraEventType.LEFT_DRAG, modifier: KeyboardEventModifier.SHIFT },
      { eventType: CameraEventType.LEFT_DRAG, modifier: KeyboardEventModifier.CTRL },
    ];
    // Shift + левая теперь наклоняет — «осмотр на месте» не нужен.
    controller.lookEventTypes = undefined;
    controller.minimumZoomDistance = MIN_ZOOM_DISTANCE;
    controller.maximumZoomDistance = MAX_ZOOM_DISTANCE;
    controller.enableCollisionDetection = true;

    this.handler = new ScreenSpaceEventHandler(viewer.scene.canvas);
    this.handler.setInputAction(
      (event: ScreenSpaceEventHandler.PositionedEvent) => this.flyTo(event.position),
      ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
    );
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.handler.destroy();
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
  }

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (!this.options.isActive() || isTypingTarget(event.target) || event.metaKey || event.ctrlKey) return;
    if (!OVERVIEW_KEYS[event.code] && !event.code.startsWith('Shift')) return;
    if (OVERVIEW_KEYS[event.code]) event.preventDefault();
    this.pressed.add(event.code);
    this.startLoop();
  };

  private readonly onKeyUp = (event: KeyboardEvent) => {
    this.pressed.delete(event.code);
  };

  private readonly onBlur = () => this.pressed.clear();

  private startLoop(): void {
    if (this.frame !== undefined) return;
    this.lastTime = performance.now();
    const step = (now: number) => {
      const dt = Math.min((now - this.lastTime) / 1000, 0.1);
      this.lastTime = now;
      const axes = axesFrom(this.pressed, OVERVIEW_KEYS);
      const moving = axes.forward || axes.right || axes.turn || axes.zoom;
      if (!moving || !this.options.isActive() || this.viewer.isDestroyed()) {
        this.frame = undefined;
        return;
      }
      this.apply(axes, dt);
      this.viewer.scene.requestRender();
      this.frame = requestAnimationFrame(step);
    };
    this.frame = requestAnimationFrame(step);
  }

  private apply(axes: ReturnType<typeof axesFrom>, dt: number): void {
    const { camera, scene } = this.viewer;
    const carto = camera.positionCartographic;
    const ground = this.options.heightAt(CesiumMath.toDegrees(carto.longitude), CesiumMath.toDegrees(carto.latitude));
    const heightAboveGround = Math.max(carto.height - ground, 1);
    const speed = panSpeed(heightAboveGround, isShift(this.pressed));

    if (axes.forward || axes.right) {
      // «Вперёд» — направление взгляда, спроецированное на землю (при взгляде вниз — верх экрана).
      const up = scene.globe.ellipsoid.geodeticSurfaceNormal(camera.positionWC, new Cartesian3());
      const forward = flatten(camera.directionWC, up);
      const fallback = flatten(camera.upWC, up);
      const dir = Cartesian3.magnitude(forward) > 0.2 ? forward : fallback;
      Cartesian3.normalize(dir, dir);
      const right = Cartesian3.normalize(Cartesian3.cross(dir, up, new Cartesian3()), new Cartesian3());
      const move = Cartesian3.add(
        Cartesian3.multiplyByScalar(dir, axes.forward, new Cartesian3()),
        Cartesian3.multiplyByScalar(right, axes.right, new Cartesian3()),
        new Cartesian3(),
      );
      if (Cartesian3.magnitude(move) > 0) {
        camera.move(Cartesian3.normalize(move, move), speed * dt);
      }
    }

    if (axes.zoom) {
      const amount = Math.min(heightAboveGround * 1.4 * dt, Math.max(heightAboveGround - MIN_ZOOM_DISTANCE, 0));
      if (axes.zoom > 0) camera.zoomIn(amount);
      else camera.zoomOut(heightAboveGround * 1.4 * dt);
    }

    if (axes.turn) this.orbit(axes.turn * TURN_SPEED * dt);
  }

  /** Поворот вокруг точки в центре экрана (или под камерой, если центр — небо). */
  private orbit(angle: number): void {
    const { camera, scene } = this.viewer;
    const center = new Cartesian2(scene.canvas.clientWidth / 2, scene.canvas.clientHeight / 2);
    const target = pickGround(this.viewer, center) ?? scene.globe.ellipsoid.scaleToGeodeticSurface(camera.positionWC);
    if (!target) return;
    camera.lookAtTransform(Transforms.eastNorthUpToFixedFrame(target));
    // Камера обходит точку против часовой — взгляд поворачивается вправо (E), и наоборот (Q).
    camera.rotateLeft(angle);
    camera.lookAtTransform(Matrix4.IDENTITY);
  }

  /** Двойной клик: плавно подлететь к точке, сохранив поворот камеры. */
  private flyTo(position: Cartesian2): void {
    if (!this.options.isActive()) return;
    const point = pickGround(this.viewer, position);
    if (!point) return;
    const { camera } = this.viewer;
    const [lon, lat] = toLonLat(point);
    const carto = camera.positionCartographic;
    const height = carto.height - this.options.heightAt(lon, lat);
    camera.flyToBoundingSphere(new BoundingSphere(point, 1), {
      offset: new HeadingPitchRange(
        camera.heading,
        Math.min(camera.pitch, CesiumMath.toRadians(-20)),
        Math.min(Math.max(height * 0.45, 120), 900),
      ),
      duration: 0.9,
    });
  }
}

/** Проекция вектора на касательную к земле плоскость. */
function flatten(vector: Cartesian3, up: Cartesian3): Cartesian3 {
  const along = Cartesian3.multiplyByScalar(up, Cartesian3.dot(vector, up), new Cartesian3());
  return Cartesian3.subtract(vector, along, new Cartesian3());
}
