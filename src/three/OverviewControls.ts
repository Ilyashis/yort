// Камера над городом: мышь как в градостроителях (MapControls: левая кнопка — двигать карту,
// правая — вращать, колесо — к курсору), клавиатура — WASD/стрелки, Q/E поворот, R/F приближение
// (Shift — быстрее), двойной клик — подлёт к точке. Камера не уходит под землю, точка вращения — на земле.

import { MathUtils, Vector3 } from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { axesFrom, isShift, OVERVIEW_KEYS, panSpeed } from '../world/walk/controlsMath';
import type { CityScene } from './CityScene';

const TURN_SPEED = 1.4;
const ZOOM_SPEED = 1.6;
/** Вид сверху — карта: двигаемся быстрее (до TOP_BOOST раз при взгляде почти вниз). */
const TOP_BOOST = 1.7;
/** Разгон и торможение клавишами, 1/с: камера не дёргается при нажатии и отпускании. */
const ACCEL = 9;

export class OverviewControls {
  readonly controls: MapControls;
  private readonly pressed = new Set<string>();
  /** Текущая скорость сдвига клавишами (вперёд, вправо), доля от полной. */
  private vel = { forward: 0, right: 0 };
  private readonly removeAnimator: () => void;

  constructor(
    private readonly city: CityScene,
    /** Высота земли в точке three.js (x, z). */
    private readonly groundAt: (x: number, z: number) => number,
    private readonly isActive: () => boolean,
  ) {
    const controls = new MapControls(city.camera, city.canvas);
    controls.target = city.target;
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.screenSpacePanning = false;
    controls.maxPolarAngle = MathUtils.degToRad(84);
    controls.minDistance = 15;
    controls.maxDistance = 9000;
    controls.zoomToCursor = true;
    controls.zoomSpeed = 1.3;
    controls.addEventListener('change', () => city.requestRender());
    this.controls = controls;

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    city.canvas.addEventListener('dblclick', this.onDoubleClick);
    this.removeAnimator = city.addAnimator((dt) => this.tick(dt));
  }

  /** Временно выключить мышь (инструменты редактора перетаскивают своё). */
  setEnabled(enabled: boolean): void {
    this.controls.enabled = enabled;
  }

  destroy(): void {
    this.removeAnimator();
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.city.canvas.removeEventListener('dblclick', this.onDoubleClick);
    this.controls.dispose();
  }

  private tick(dt: number): boolean {
    if (!this.isActive() || this.city.flying) return false;
    const camera = this.city.camera;
    const target = this.city.target;
    let moved = false;

    const axes = axesFrom(this.pressed, OVERVIEW_KEYS);
    // Плавный разгон к нажатому и торможение после отпускания.
    const k = 1 - Math.exp(-ACCEL * dt);
    this.vel.forward += (axes.forward - this.vel.forward) * k;
    this.vel.right += (axes.right - this.vel.right) * k;
    if (Math.abs(this.vel.forward) < 0.002 && !axes.forward) this.vel.forward = 0;
    if (Math.abs(this.vel.right) < 0.002 && !axes.right) this.vel.right = 0;
    if (this.vel.forward || this.vel.right || axes.turn || axes.zoom) {
      const height = camera.position.y - this.groundAt(camera.position.x, camera.position.z);
      const top = MathUtils.smoothstep(this.city.pitch(), 45, 85);
      const speed = panSpeed(height, isShift(this.pressed)) * (1 + (TOP_BOOST - 1) * top) * dt;
      const h = MathUtils.degToRad(this.city.heading());
      const forward = new Vector3(Math.sin(h), 0, -Math.cos(h));
      const right = new Vector3(Math.cos(h), 0, Math.sin(h));
      const shift = forward.multiplyScalar(this.vel.forward * speed).add(right.multiplyScalar(this.vel.right * speed));
      camera.position.add(shift);
      target.add(shift);
      if (axes.turn) {
        const offset = camera.position.clone().sub(target);
        offset.applyAxisAngle(new Vector3(0, 1, 0), -axes.turn * TURN_SPEED * dt);
        camera.position.copy(target).add(offset);
      }
      if (axes.zoom) {
        const offset = camera.position.clone().sub(target);
        const length = MathUtils.clamp(offset.length() * Math.exp(-axes.zoom * ZOOM_SPEED * dt), this.controls.minDistance, this.controls.maxDistance);
        camera.position.copy(target).add(offset.setLength(length));
      }
      moved = true;
    }

    const changed = this.controls.update(dt);
    // Точка вращения — на земле; камера — не ниже 4 м над ней.
    const ground = this.groundAt(target.x, target.z);
    if (Math.abs(target.y - ground) > 0.01) {
      camera.position.y += ground - target.y;
      target.y = ground;
      moved = true;
    }
    const floor = this.groundAt(camera.position.x, camera.position.z) + 4;
    if (camera.position.y < floor) {
      camera.position.y = floor;
      camera.lookAt(target);
      moved = true;
    }
    if (moved) this.city.requestRender();
    return moved || changed || this.pressed.size > 0 || !!this.vel.forward || !!this.vel.right;
  }

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (!this.isActive() || isTypingTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
    if (OVERVIEW_KEYS[event.code] || event.code.startsWith('Shift')) {
      this.pressed.add(event.code);
      this.city.requestRender();
    }
  };

  private readonly onKeyUp = (event: KeyboardEvent) => {
    this.pressed.delete(event.code);
  };

  private readonly onBlur = () => {
    this.pressed.clear();
    this.vel = { forward: 0, right: 0 };
  };

  /** Двойной клик — подлететь к точке, сохранив курс и наклон. */
  private readonly onDoubleClick = (event: MouseEvent) => {
    if (!this.isActive()) return;
    const point = this.city.pickGround(event.clientX, event.clientY);
    if (!point) return;
    const distance = Math.max(this.city.camera.position.distanceTo(this.city.target) * 0.5, 80);
    this.city.flyTo(this.city.orbitPosition(point, this.city.heading(), Math.max(this.city.pitch(), 20), distance), point, 0.8);
  };
}

/** Набор текста в поле ввода — клавиши не наши. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}
