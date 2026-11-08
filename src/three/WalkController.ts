// Прогулка от первого лица, управление как в играх:
//  - клик по сцене захватывает курсор — дальше просто ведите мышью, кнопку держать не нужно;
//    Esc отпускает курсор, второй Esc — выход из прогулки;
//  - W/S — вперёд/назад, A/D — шаг вбок, Q/E или ←/→ — поворот (удобно с тачпадом), Shift — бег;
//  - плавный разгон и торможение; сквозь дома не пройти; глаза — на 1,7 м над землёй.
// Если браузер не даёт захватить курсор — обзор перетаскиванием.

import { MathUtils, Vector3 } from 'three';
import { approach, axesFrom, isShift, WALK_KEYS } from '../world/walk/controlsMath';
import type { LonLat } from '../world/user/plot';
import type { Collider } from '../world/walk/collider';
import type { LocalFrame, Vec2 } from '../world/walk/localFrame';
import type { StreetIndex } from '../world/walk/streets';
import type { CityScene } from './CityScene';
import { isTypingTarget } from './OverviewControls';

const EYE_HEIGHT = 1.7;
const WALK_SPEED = 4;
const RUN_SPEED = 12;
const ACCELERATION = 9;
const TURN_SPEED = 1.9;
const LOOK_SENSITIVITY_LOCKED = 0.0022;
const LOOK_SENSITIVITY_DRAG = 0.004;
const MAX_PITCH = MathUtils.degToRad(80);
const STREET_UPDATE_MS = 300;
const ESC_AFTER_UNLOCK_MS = 400;

export interface WalkCallbacks {
  onExit: () => void;
  onStreet: (name: string | undefined) => void;
  onMove?: (distance: number, running: boolean, position: Vec2) => void;
  onMouseLock?: (locked: boolean) => void;
}

export class WalkController {
  private walking = false;
  private position: Vec2 = [0, 0];
  private velocity: Vec2 = [0, 0];
  /** Курс: 0 — север, по часовой, рад. */
  private heading = 0;
  private pitch = 0;
  private readonly pressed = new Set<string>();
  private dragging = false;
  private locked = false;
  private unlockedAt = 0;
  private lastPointer: [number, number] = [0, 0];
  private lastStreetCheck = 0;
  private street: string | undefined;
  private saved?: { position: Vector3; target: Vector3; near: number };
  private removeAnimator?: () => void;

  constructor(
    private readonly city: CityScene,
    private readonly frame: LocalFrame,
    private readonly collider: Collider,
    private readonly streets: StreetIndex,
    /** Высота земли в локальных метрах. */
    private readonly heightAt: (x: number, y: number) => number,
    private readonly callbacks: WalkCallbacks,
  ) {}

  get isWalking(): boolean {
    return this.walking;
  }

  /** Точка земли в distance метрах впереди пешехода (локальные метры). */
  pointAhead(distance: number): Vec2 {
    return [this.position[0] + Math.sin(this.heading) * distance, this.position[1] + Math.cos(this.heading) * distance];
  }

  /** Начать прогулку в точке start (lon/lat), курс — в градусах от севера. */
  enter(start: LonLat, headingDeg: number): void {
    if (this.walking) return;
    const camera = this.city.camera;
    this.saved = { position: camera.position.clone(), target: this.city.target.clone(), near: camera.near };
    this.city.cancelFlight();
    camera.near = 0.15;
    camera.updateProjectionMatrix();
    this.walking = true;
    this.position = this.frame.toLocal(start);
    this.velocity = [0, 0];
    this.heading = MathUtils.degToRad(headingDeg);
    this.pitch = MathUtils.degToRad(-3);
    this.street = undefined;
    this.lastStreetCheck = 0;

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    this.city.canvas.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    this.city.canvas.style.cursor = 'crosshair';
    this.removeAnimator = this.city.addAnimator((dt) => this.tick(dt));
  }

  exit(): void {
    if (!this.walking) return;
    this.walking = false;
    this.detach();
    const camera = this.city.camera;
    if (this.saved) {
      camera.near = this.saved.near;
      camera.updateProjectionMatrix();
      // Вернуть обзор с той же точки: камера взлетает над местом, где закончили прогулку.
      const here = camera.position.clone();
      here.y = this.heightAt(this.position[0], this.position[1]);
      const offset = this.saved.position.clone().sub(this.saved.target);
      this.city.flyTo(here.clone().add(offset), here, 1.2);
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

  private detach(): void {
    this.removeAnimator?.();
    this.removeAnimator = undefined;
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
    this.city.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.city.canvas.style.cursor = '';
  }

  private tick(dt: number): boolean {
    const axes = axesFrom(this.pressed, WALK_KEYS);
    const run = isShift(this.pressed);
    if (axes.turn) this.heading += axes.turn * TURN_SPEED * dt;

    const length = Math.hypot(axes.forward, axes.right);
    const speed = length > 0 ? (run ? RUN_SPEED : WALK_SPEED) / length : 0;
    const sin = Math.sin(this.heading);
    const cos = Math.cos(this.heading);
    const target: Vec2 = [(axes.forward * sin + axes.right * cos) * speed, (axes.forward * cos - axes.right * sin) * speed];
    this.velocity = [approach(this.velocity[0], target[0], dt, ACCELERATION), approach(this.velocity[1], target[1], dt, ACCELERATION)];
    if (Math.hypot(...this.velocity) < 0.02) this.velocity = [0, 0];

    if (this.velocity[0] || this.velocity[1]) {
      const before = this.position;
      this.position = this.collider.move(this.position, [this.velocity[0] * dt, this.velocity[1] * dt]);
      const moved = Math.hypot(this.position[0] - before[0], this.position[1] - before[1]);
      if (moved < Math.hypot(...this.velocity) * dt * 0.2) this.velocity = [0, 0];
      if (moved > 0) this.callbacks.onMove?.(moved, run, this.position);
    }

    const [x, y] = this.position;
    const camera = this.city.camera;
    camera.position.set(x, this.heightAt(x, y) + EYE_HEIGHT, -y);
    const cp = Math.cos(this.pitch);
    this.city.target.set(x + Math.sin(this.heading) * cp * 10, camera.position.y + Math.sin(this.pitch) * 10, -y - Math.cos(this.heading) * cp * 10);
    camera.lookAt(this.city.target);

    const now = performance.now();
    if (now - this.lastStreetCheck > STREET_UPDATE_MS) {
      this.lastStreetCheck = now;
      const street = this.streets.nameAt(this.position);
      if (street !== this.street) {
        this.street = street;
        this.callbacks.onStreet(street);
      }
    }
    return true;
  }

  private look(dx: number, dy: number, sensitivity: number): void {
    this.heading += dx * sensitivity;
    this.pitch = MathUtils.clamp(this.pitch - dy * sensitivity, -MAX_PITCH, MAX_PITCH);
  }

  private isLocked(): boolean {
    return document.pointerLockElement === this.city.canvas;
  }

  private setLocked(locked: boolean): void {
    if (locked === this.locked) return;
    this.locked = locked;
    if (!locked) this.unlockedAt = performance.now();
    this.city.canvas.style.cursor = locked ? 'none' : 'crosshair';
    this.callbacks.onMouseLock?.(locked);
  }

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (isTypingTarget(event.target)) return;
    if (event.code === 'Escape') {
      event.preventDefault();
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
    try {
      const request = this.city.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      request?.catch?.(() => undefined);
    } catch {
      // захват курсора не поддерживается — обзор перетаскиванием
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
