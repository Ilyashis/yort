import {
  Cartesian3,
  Color,
  Math as CesiumMath,
  PerspectiveFrustum,
  type Viewer,
} from 'cesium';
import type { LonLat } from '../world/user/plot';
import type { Collider } from '../world/walk/collider';
import type { LocalFrame, Vec2 } from '../world/walk/localFrame';
import type { StreetIndex } from '../world/walk/streets';
import { WALK_KEYS, approach, axesFrom, isShift } from './controlsMath';
import { isTypingTarget } from './keyboard';

/** Высота глаз над землёй, м. */
const EYE_HEIGHT = 1.7;
/** Скорость шага и бега, м/с (быстрее реальной — район большой). */
const WALK_SPEED = 4;
const RUN_SPEED = 12;
/** Разгон и торможение: чем больше, тем резче, 1/с. */
const ACCELERATION = 9;
/** Поворот клавишами (Q/E, ←/→), рад/с. */
const TURN_SPEED = 1.9;
/** Чувствительность обзора: с захваченным курсором и при перетаскивании, рад/пиксель. */
const LOOK_SENSITIVITY_LOCKED = 0.0022;
const LOOK_SENSITIVITY_DRAG = 0.004;
const MAX_PITCH = CesiumMath.toRadians(80);
const STREET_UPDATE_MS = 300;
/** Esc, отпустивший курсор, не должен сразу завершать прогулку. */
const ESC_AFTER_UNLOCK_MS = 400;

export interface WalkCallbacks {
  /** Прогулка закончилась (Esc или exit()). */
  onExit: () => void;
  /** Сменилась улица под ногами. */
  onStreet: (name: string | undefined) => void;
  /** Пешеход сдвинулся на distance метров (для шагов). */
  onMove?: (distance: number, running: boolean, position: Vec2) => void;
  /** Курсор захвачен для обзора мышью (или отпущен). */
  onMouseLock?: (locked: boolean) => void;
}

interface SavedView {
  position: Cartesian3;
  heading: number;
  pitch: number;
  roll: number;
  near: number;
  requestRenderMode: boolean;
  imageryShown: boolean[];
  baseColor: Color;
}

/**
 * Прогулка от первого лица, управление как в играх:
 *  - клик по сцене захватывает курсор — дальше просто ведите мышью/пальцем, кнопку держать не нужно;
 *    Esc отпускает курсор, второй Esc — выход из прогулки;
 *  - W/S — вперёд/назад, A/D — шаг вбок, Q/E или ←/→ — поворот (удобно с тачпадом), Shift — бег;
 *  - плавный разгон и торможение.
 * Если браузер не даёт захватить курсор — обзор перетаскиванием, как раньше.
 * Клавиши читаются по физическому коду (event.code), поэтому работают и в русской раскладке.
 */
export class WalkController {
  private walking = false;
  private position: Vec2 = [0, 0];
  private velocity: Vec2 = [0, 0];
  private heading = 0;
  private pitch = 0;
  private groundHeight = 0;
  private readonly pressed = new Set<string>();
  private dragging = false;
  private locked = false;
  private unlockedAt = 0;
  private lastPointer: [number, number] = [0, 0];
  private lastTick = 0;
  private lastStreetCheck = 0;
  private street: string | undefined;
  private saved: SavedView | undefined;
  private removeTick: (() => void) | undefined;

  constructor(
    private readonly viewer: Viewer,
    private readonly frame: LocalFrame,
    private readonly collider: Collider,
    private readonly streets: StreetIndex,
    private readonly bareGroundColor: Color,
    /** Высота земли в точке (рельеф); глаза — на EYE_HEIGHT выше. */
    private readonly heightAt: (lon: number, lat: number) => number,
    private readonly callbacks: WalkCallbacks,
  ) {}

  get isWalking(): boolean {
    return this.walking;
  }

  enter(start: LonLat, heading: number): void {
    if (this.walking) return;
    const { scene, camera } = this.viewer;
    const frustum = camera.frustum as PerspectiveFrustum;

    this.saved = {
      position: camera.position.clone(),
      heading: camera.heading,
      pitch: camera.pitch,
      roll: camera.roll,
      near: frustum.near,
      requestRenderMode: scene.requestRenderMode,
      imageryShown: this.imageryLayers().map((layer) => layer.show),
      baseColor: scene.globe.baseColor.clone(),
    };

    // Сцена «для пешехода»: без карты под ногами, непрерывная отрисовка, близкая плоскость отсечения.
    for (const layer of this.imageryLayers()) layer.show = false;
    scene.globe.baseColor = this.bareGroundColor;
    scene.screenSpaceCameraController.enableInputs = false;
    scene.requestRenderMode = false;
    frustum.near = 0.1;

    this.walking = true;
    this.position = this.frame.toLocal(start);
    this.velocity = [0, 0];
    this.heading = heading;
    this.pitch = CesiumMath.toRadians(-3);
    this.groundHeight = 0;
    this.lastTick = performance.now();
    this.lastStreetCheck = 0;
    this.street = undefined;

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    this.viewer.canvas.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    this.viewer.canvas.style.cursor = 'crosshair';
    this.removeTick = scene.preUpdate.addEventListener(this.tick);
    this.tick();
  }

  exit(): void {
    if (!this.walking) return;
    this.walking = false;
    this.detach();

    const saved = this.saved;
    if (saved && !this.viewer.isDestroyed()) {
      const { scene, camera } = this.viewer;
      this.imageryLayers().forEach((layer, i) => (layer.show = saved.imageryShown[i] ?? true));
      scene.globe.baseColor = saved.baseColor;
      scene.screenSpaceCameraController.enableInputs = true;
      scene.requestRenderMode = saved.requestRenderMode;
      (camera.frustum as PerspectiveFrustum).near = saved.near;
      camera.flyTo({
        destination: saved.position,
        orientation: { heading: saved.heading, pitch: saved.pitch, roll: saved.roll },
        duration: 1.2,
      });
    }
    this.callbacks.onStreet(undefined);
    this.callbacks.onExit();
  }

  destroy(): void {
    if (this.walking) {
      this.walking = false;
      this.detach();
    }
  }

  // --- внутреннее -------------------------------------------------------------

  private detach(): void {
    this.removeTick?.();
    this.removeTick = undefined;
    this.pressed.clear();
    this.dragging = false;
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    if (this.isLocked()) document.exitPointerLock();
    this.setLocked(false);
    if (!this.viewer.isDestroyed()) {
      this.viewer.canvas.removeEventListener('pointerdown', this.onPointerDown);
      this.viewer.canvas.style.cursor = '';
    }
  }

  /** Только базовая подложка-карта (слой 0): текстура покрытий района на рельефе остаётся. */
  private imageryLayers() {
    const layers = this.viewer.imageryLayers;
    return layers.length ? [layers.get(0)] : [];
  }

  private readonly tick = () => {
    const now = performance.now();
    const dt = Math.min((now - this.lastTick) / 1000, 0.1);
    this.lastTick = now;

    const axes = axesFrom(this.pressed, WALK_KEYS);
    const run = isShift(this.pressed);
    if (axes.turn) this.heading = CesiumMath.zeroToTwoPi(this.heading + axes.turn * TURN_SPEED * dt);

    // Желаемая скорость в локальных метрах (x — восток, y — север); heading: 0 — север, по часовой.
    const length = Math.hypot(axes.forward, axes.right);
    const speed = length > 0 ? (run ? RUN_SPEED : WALK_SPEED) / length : 0;
    const sin = Math.sin(this.heading);
    const cos = Math.cos(this.heading);
    const target: Vec2 = [
      (axes.forward * sin + axes.right * cos) * speed,
      (axes.forward * cos - axes.right * sin) * speed,
    ];
    this.velocity = [
      approach(this.velocity[0], target[0], dt, ACCELERATION),
      approach(this.velocity[1], target[1], dt, ACCELERATION),
    ];
    if (Math.hypot(...this.velocity) < 0.02) this.velocity = [0, 0];

    if (this.velocity[0] || this.velocity[1]) {
      const before = this.position;
      this.position = this.collider.move(this.position, [this.velocity[0] * dt, this.velocity[1] * dt]);
      const moved = Math.hypot(this.position[0] - before[0], this.position[1] - before[1]);
      // Упёрлись в стену — гасим скорость, чтобы не «прилипать» с разгоном.
      if (moved < Math.hypot(...this.velocity) * dt * 0.2) this.velocity = [0, 0];
      if (moved > 0) this.callbacks.onMove?.(moved, run, this.position);
    }

    const [lon, lat] = this.frame.toLonLat(this.position);
    this.groundHeight = this.sampleGround(lon, lat);
    this.viewer.camera.setView({
      destination: Cartesian3.fromDegrees(lon, lat, this.groundHeight + EYE_HEIGHT),
      orientation: { heading: this.heading, pitch: this.pitch, roll: 0 },
    });

    if (now - this.lastStreetCheck > STREET_UPDATE_MS) {
      this.lastStreetCheck = now;
      const street = this.streets.nameAt(this.position);
      if (street !== this.street) {
        this.street = street;
        this.callbacks.onStreet(street);
      }
    }
  };

  private sampleGround(lon: number, lat: number): number {
    const height = this.heightAt(lon, lat);
    return Number.isFinite(height) ? height : this.groundHeight;
  }

  private look(dx: number, dy: number, sensitivity: number): void {
    this.heading = CesiumMath.zeroToTwoPi(this.heading + dx * sensitivity);
    this.pitch = CesiumMath.clamp(this.pitch - dy * sensitivity, -MAX_PITCH, MAX_PITCH);
  }

  private isLocked(): boolean {
    return !this.viewer.isDestroyed() && document.pointerLockElement === this.viewer.canvas;
  }

  private setLocked(locked: boolean): void {
    if (locked === this.locked) return;
    this.locked = locked;
    if (!locked) this.unlockedAt = performance.now();
    if (!this.viewer.isDestroyed()) this.viewer.canvas.style.cursor = locked ? 'none' : 'crosshair';
    this.callbacks.onMouseLock?.(locked);
  }

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (isTypingTarget(event.target)) return;
    if (event.code === 'Escape') {
      event.preventDefault();
      // Первый Esc отпускает курсор (браузер делает это сам), второй — выход из прогулки.
      if (this.isLocked()) document.exitPointerLock();
      else if (performance.now() - this.unlockedAt > ESC_AFTER_UNLOCK_MS) this.exit();
      return;
    }
    if (WALK_KEYS[event.code] || event.code.startsWith('Shift')) {
      event.preventDefault();
      this.pressed.add(event.code);
    }
  };

  private readonly onKeyUp = (event: KeyboardEvent) => {
    this.pressed.delete(event.code);
  };

  private readonly onBlur = () => {
    this.pressed.clear();
    this.dragging = false;
  };

  private readonly onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || this.isLocked()) return;
    // Пытаемся захватить курсор; не вышло — работает обзор перетаскиванием.
    const canvas = this.viewer.canvas;
    try {
      const request = canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      request?.catch?.(() => undefined);
    } catch {
      // браузер не поддерживает захват курсора
    }
    this.dragging = true;
    this.lastPointer = [event.clientX, event.clientY];
  };

  private readonly onPointerMove = (event: PointerEvent) => {
    if (!this.dragging || this.isLocked()) return;
    const [x, y] = this.lastPointer;
    this.lastPointer = [event.clientX, event.clientY];
    this.look(event.clientX - x, event.clientY - y, LOOK_SENSITIVITY_DRAG);
  };

  private readonly onPointerUp = () => {
    this.dragging = false;
  };

  private readonly onMouseMove = (event: MouseEvent) => {
    if (this.isLocked()) this.look(event.movementX, event.movementY, LOOK_SENSITIVITY_LOCKED);
  };

  private readonly onPointerLockChange = () => {
    const locked = this.isLocked();
    if (locked) this.dragging = false;
    this.setLocked(locked);
  };
}
