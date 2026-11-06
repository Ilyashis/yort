import {
  Cartesian3,
  Cartographic,
  Color,
  EllipsoidTerrainProvider,
  Math as CesiumMath,
  PerspectiveFrustum,
  type Viewer,
} from 'cesium';
import type { LonLat } from '../world/user/plot';
import type { Collider } from '../world/walk/collider';
import type { LocalFrame, Vec2 } from '../world/walk/localFrame';
import type { StreetIndex } from '../world/walk/streets';
import { isTypingTarget } from './keyboard';

/** Высота глаз над землёй, м. */
const EYE_HEIGHT = 1.7;
/** Скорость шага и бега, м/с (быстрее реальной — район большой). */
const WALK_SPEED = 4;
const RUN_SPEED = 12;
/** Чувствительность обзора мышью, рад/пиксель. */
const LOOK_SENSITIVITY = 0.004;
const MAX_PITCH = CesiumMath.toRadians(80);
const STREET_UPDATE_MS = 300;

const MOVE_KEYS: Record<string, [forward: number, right: number]> = {
  KeyW: [1, 0],
  ArrowUp: [1, 0],
  KeyS: [-1, 0],
  ArrowDown: [-1, 0],
  KeyA: [0, -1],
  ArrowLeft: [0, -1],
  KeyD: [0, 1],
  ArrowRight: [0, 1],
};

export interface WalkCallbacks {
  /** Прогулка закончилась (Esc или exit()). */
  onExit: () => void;
  /** Сменилась улица под ногами. */
  onStreet: (name: string | undefined) => void;
  /** Пешеход сдвинулся на distance метров (для шагов). */
  onMove?: (distance: number, running: boolean, position: Vec2) => void;
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
 * Прогулка от первого лица: WASD/стрелки — идти, Shift — бежать,
 * зажатая левая кнопка мыши — осмотреться, Esc — выйти.
 * Клавиши читаются по физическому коду (event.code), поэтому работают и в русской раскладке.
 */
export class WalkController {
  private walking = false;
  private position: Vec2 = [0, 0];
  private heading = 0;
  private pitch = 0;
  private groundHeight = 0;
  private readonly pressed = new Set<string>();
  private dragging = false;
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
    this.viewer.canvas.style.cursor = 'grab';
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
    if (!this.viewer.isDestroyed()) {
      this.viewer.canvas.removeEventListener('pointerdown', this.onPointerDown);
      this.viewer.canvas.style.cursor = '';
    }
  }

  private imageryLayers() {
    const layers = this.viewer.imageryLayers;
    return Array.from({ length: layers.length }, (_, i) => layers.get(i));
  }

  private readonly tick = () => {
    const now = performance.now();
    const dt = Math.min((now - this.lastTick) / 1000, 0.1);
    this.lastTick = now;

    let forward = 0;
    let right = 0;
    for (const code of this.pressed) {
      const move = MOVE_KEYS[code];
      if (move) {
        forward += move[0];
        right += move[1];
      }
    }
    const length = Math.hypot(forward, right);
    if (length > 0) {
      const run = this.pressed.has('ShiftLeft') || this.pressed.has('ShiftRight');
      const distance = (run ? RUN_SPEED : WALK_SPEED) * dt;
      // heading Cesium: 0 — север, по часовой стрелке; x — восток, y — север.
      const sin = Math.sin(this.heading);
      const cos = Math.cos(this.heading);
      const f = forward / length;
      const r = right / length;
      const delta: Vec2 = [(f * sin + r * cos) * distance, (f * cos - r * sin) * distance];
      const before = this.position;
      this.position = this.collider.move(this.position, delta);
      const moved = Math.hypot(this.position[0] - before[0], this.position[1] - before[1]);
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
    const { globe } = this.viewer.scene;
    if (globe.terrainProvider instanceof EllipsoidTerrainProvider) return 0;
    return globe.getHeight(Cartographic.fromDegrees(lon, lat)) ?? this.groundHeight;
  }

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (isTypingTarget(event.target)) return;
    if (event.code === 'Escape') {
      event.preventDefault();
      this.exit();
      return;
    }
    if (MOVE_KEYS[event.code] || event.code.startsWith('Shift')) {
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
    if (event.button !== 0) return;
    this.dragging = true;
    this.lastPointer = [event.clientX, event.clientY];
    this.viewer.canvas.style.cursor = 'grabbing';
  };

  private readonly onPointerMove = (event: PointerEvent) => {
    if (!this.dragging) return;
    const [x, y] = this.lastPointer;
    this.lastPointer = [event.clientX, event.clientY];
    this.heading = CesiumMath.zeroToTwoPi(this.heading + (event.clientX - x) * LOOK_SENSITIVITY);
    this.pitch = CesiumMath.clamp(this.pitch - (event.clientY - y) * LOOK_SENSITIVITY, -MAX_PITCH, MAX_PITCH);
  };

  private readonly onPointerUp = () => {
    if (!this.dragging) return;
    this.dragging = false;
    this.viewer.canvas.style.cursor = 'grab';
  };
}
