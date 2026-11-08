// Поездка на машине, управление как в играх:
//  - W/S или ↑/↓ — газ и тормоз (стоя — задний ход), A/D или ←/→ — руль, пробел — ручник, Shift — быстрее;
//  - C — камера сзади или из кабины; мышь с зажатой кнопкой — оглядеться, колесо — ближе/дальше;
//  - R — вернуть машину на ближайшую дорогу (если застряли); Esc — выйти.
// Машина едет по рельефу (наклоняется по высоте под колёсами), в дома не въезжает, по траве — медленнее.
// Вечером горят фары (настоящий прожектор, освещает дорогу и стены) и задние фонари.

import {
  BufferGeometry,
  Group,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  SpotLight,
  Vector3,
} from 'three';
import type { CSM } from 'three/addons/csm/CSM.js';
import {
  CAR,
  angleDelta,
  bodyCircles,
  engineState,
  snapToRoad,
  stepCar,
  wheelSpots,
  type CarInput,
  type CarState,
  type RoadLine,
} from '../world/drive/car';
import { carParts } from '../world/drive/carModel';
import type { HousePart } from '../world/village/houseParts';
import type { Collider } from '../world/walk/collider';
import type { Vec2 } from '../world/walk/localFrame';
import type { StreetIndex } from '../world/walk/streets';
import type { CarSound } from '../audio/engineSound';
import type { Surface } from '../audio/ambience';
import type { CityScene } from './CityScene';
import { buildHouseGeometries } from './houseMesh';
import { NIGHT } from './nightUniforms';
import { isTypingTarget } from './OverviewControls';
import { hookMaterial } from './shaderHooks';

export type DriveView = 'chase' | 'cabin';

export interface DriveHudState {
  /** Скорость, км/ч. */
  speed: number;
  gear: string;
}

export interface DriveCallbacks {
  onExit: () => void;
  onStreet: (name: string | undefined) => void;
  onHud: (hud: DriveHudState) => void;
  onView: (view: DriveView) => void;
  onSound?: (sound: CarSound | undefined) => void;
  onBump?: (strength: number) => void;
}

const KEYS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
} as const;
const HANDLED = new Set([...Object.values(KEYS).flat(), 'Space', 'ShiftLeft', 'ShiftRight']);

const CHASE = { distance: 7, min: 4.5, max: 18 };
const LOOK_SENSITIVITY = 0.004;
const STREET_UPDATE_MS = 300;
const HUD_UPDATE_MS = 100;
const SURFACE_UPDATE_MS = 150;
/** Сцепление вне дорог: в городе — газоны, в деревне — дворы и луга. */
const OFFROAD_GRIP = 0.62;
const MAX_DT = 1 / 20;
/** Камера держится от стен хотя бы на столько, м (свес крыши — около полуметра). */
const CAMERA_CLEARANCE = 0.6;
/** Глаза водителя в осях машины (x вправо, y вперёд, z вверх). */
const DRIVER_EYE = new Vector3(-0.36, -0.12, 1.24);

export class DriveController {
  private driving = false;
  private state: CarState = { position: [0, 0], heading: 0, speed: 0, steer: 0 };
  private readonly pressed = new Set<string>();
  private view: DriveView = 'chase';
  private chaseDistance = CHASE.distance;
  /** Какая доля расстояния до камеры свободна от стен (камера не заходит в дома). */
  private reach = 1;
  private cameraYaw = 0;
  /** Оглядеться мышью: смещение взгляда относительно курса и наклон. */
  private lookYaw = 0;
  private lookPitch = 0;
  private lookIdle = 0;
  private dragging = false;
  private lastPointer: [number, number] = [0, 0];
  private bodyZ = 0;
  private pitch = 0;
  private roll = 0;
  private wheelSpin = 0;
  private braking = false;
  private grip = 1;
  private surface: Surface = 'pavement';
  private lastSurfaceCheck = 0;
  private lastStreetCheck = 0;
  private lastHud = 0;
  private street: string | undefined;
  private bumpCooldown = 0;
  private saved?: { position: Vector3; target: Vector3; near: number; fov: number };
  private removeAnimator?: () => void;

  private readonly car = new Group();
  private readonly body = new Group();
  private readonly wheels: { pivot: Object3D; spin: Object3D; front: boolean }[] = [];
  private readonly paint: MeshStandardMaterial;
  private readonly glass: MeshStandardMaterial;
  private readonly headlights: MeshStandardMaterial;
  private readonly taillights: MeshStandardMaterial;
  private readonly beam = new SpotLight('#fff1d6', 0, 70, 0.62, 0.55, 1.4);
  private readonly geometries: BufferGeometry[] = [];
  /** Стёкла: из кабины их не рисуем — изнутри они были бы непрозрачными плитами. */
  private glassMesh?: Mesh;
  private color = '';

  constructor(
    private readonly city: CityScene,
    private readonly collider: Collider,
    private readonly streets: StreetIndex,
    /** Высота земли в локальных метрах. */
    private readonly heightAt: (x: number, y: number) => number,
    /** По чему едем: дорога и площадки или трава/грунт. */
    private readonly surfaceAt: (point: Vec2) => Surface,
    /** Оси дорог (локальные метры): на ближайшую ставится машина. */
    private readonly roads: () => readonly RoadLine[],
    csm: CSM | undefined,
    private readonly callbacks: DriveCallbacks,
  ) {
    const material = (key: string, params: ConstructorParameters<typeof MeshStandardMaterial>[0]) => {
      const m = new MeshStandardMaterial({ vertexColors: true, ...params });
      hookMaterial(m, key, undefined, csm);
      return m;
    };
    this.paint = material('car-paint', { roughness: 0.34, metalness: 0.28 });
    // Отражение неба — сдержанное: иначе лобовое стекло под острым углом кажется белым.
    this.glass = material('car-glass', { roughness: 0.16, metalness: 0.15, envMapIntensity: 0.55 });
    this.headlights = material('car-headlights', { roughness: 0.2, emissive: '#fff2d2', emissiveIntensity: 0 });
    this.taillights = material('car-taillights', { roughness: 0.3, emissive: '#ff2414', emissiveIntensity: 0 });

    this.car.name = 'car';
    this.car.visible = false;
    this.car.add(this.body);
    this.city.scene.add(this.car);
    // Прожектор фар — всегда в сцене (сила 0, пока не едем ночью): иначе его появление пересоберёт все шейдеры.
    this.beam.position.set(0, 0.8, -1.9);
    this.beam.target.position.set(0, -1.2, -24);
    this.car.add(this.beam, this.beam.target);
    this.setColor('#f2f1ec');
  }

  get isDriving(): boolean {
    return this.driving;
  }

  /** Где машина и куда смотрит (локальные метры, курс — рад от севера по часовой). */
  pose(): { position: Vec2; heading: number; speed: number } {
    return { position: this.state.position, heading: this.state.heading, speed: this.state.speed };
  }

  /** Точка земли в distance метрах впереди машины. */
  pointAhead(distance: number): Vec2 {
    const [x, y] = this.state.position;
    return [x + Math.sin(this.state.heading) * distance, y + Math.cos(this.state.heading) * distance];
  }

  /** Перекрасить машину. */
  setColor(color: string): void {
    if (color === this.color) return;
    this.color = color;
    for (const g of this.geometries) g.dispose();
    this.geometries.length = 0;
    this.body.clear();
    for (const w of this.wheels) w.pivot.removeFromParent();
    this.wheels.length = 0;

    const parts = carParts(color);
    const mesh = (list: HousePart[], material: MeshStandardMaterial) => {
      const geometry = buildHouseGeometries(list).solid;
      this.geometries.push(geometry);
      const m = new Mesh(geometry, material);
      m.castShadow = true;
      m.receiveShadow = true;
      return m;
    };
    this.glassMesh = mesh(parts.glass, this.glass);
    this.body.add(mesh(parts.body, this.paint), this.glassMesh, mesh(parts.headlights, this.headlights), mesh(parts.taillights, this.taillights));
    const wheelGeometry = buildHouseGeometries(parts.wheel).solid;
    this.geometries.push(wheelGeometry);
    const a = CAR.wheelbase / 2;
    const t = CAR.track / 2;
    for (const [x, y] of [
      [-t, a],
      [t, a],
      [-t, -a],
      [t, -a],
    ] as const) {
      const pivot = new Object3D();
      pivot.position.set(x, CAR.wheelRadius, -y);
      const spin = new Object3D();
      const wheel = new Mesh(wheelGeometry, this.paint);
      wheel.castShadow = true;
      spin.add(wheel);
      pivot.add(spin);
      this.car.add(pivot);
      this.wheels.push({ pivot, spin, front: y > 0 });
    }
    this.city.requestRender();
  }

  /** Сесть в машину в точке start (локальные метры) — машина встаёт на ближайшую дорогу. */
  enter(start: Vec2, headingRad: number): void {
    if (this.driving) return;
    const camera = this.city.camera;
    this.saved = { position: camera.position.clone(), target: this.city.target.clone(), near: camera.near, fov: camera.fov };
    this.city.cancelFlight();
    camera.near = 0.2;
    camera.updateProjectionMatrix();
    const placed = snapToRoad(start, this.roads(), headingRad, 200);
    this.state = { position: placed?.position ?? start, heading: placed?.heading ?? headingRad, speed: 0, steer: 0 };
    this.driving = true;
    this.car.visible = true;
    this.bodyZ = this.groundUnder().z;
    this.cameraYaw = this.state.heading;
    this.lookYaw = 0;
    this.lookPitch = 0;
    this.street = undefined;
    this.lastStreetCheck = 0;
    this.lastSurfaceCheck = 0;
    this.lastHud = 0;

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    this.city.canvas.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    this.city.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.city.canvas.style.cursor = 'grab';
    this.removeAnimator = this.city.addAnimator((dt) => this.tick(dt));
    this.callbacks.onView(this.view);
  }

  exit(): void {
    if (!this.driving) return;
    this.driving = false;
    this.detach();
    this.car.visible = false;
    if (this.glassMesh) this.glassMesh.visible = true;
    this.beam.intensity = 0;
    this.callbacks.onSound?.(undefined);
    const camera = this.city.camera;
    if (this.saved) {
      camera.near = this.saved.near;
      camera.fov = this.saved.fov;
      camera.updateProjectionMatrix();
      // Камера взлетает над местом, где оставили машину.
      const [x, y] = this.state.position;
      const here = new Vector3(x, this.heightAt(x, y), -y);
      const offset = this.saved.position.clone().sub(this.saved.target);
      this.city.flyTo(here.clone().add(offset), here, 1.2);
    }
    this.callbacks.onStreet(undefined);
    this.callbacks.onExit();
  }

  /** Сзади или из кабины. */
  toggleView(): void {
    this.view = this.view === 'chase' ? 'cabin' : 'chase';
    this.lookYaw = 0;
    this.lookPitch = 0;
    this.callbacks.onView(this.view);
    this.city.requestRender();
  }

  /** Вернуть машину на ближайшую дорогу (застряли во дворе или упёрлись). */
  backToRoad(): void {
    const placed = snapToRoad(this.state.position, this.roads(), this.state.heading, 400);
    if (!placed) return;
    this.state = { position: placed.position, heading: placed.heading, speed: 0, steer: 0 };
    this.bodyZ = this.groundUnder().z;
    this.cameraYaw = placed.heading;
  }

  destroy(): void {
    if (this.driving) {
      this.driving = false;
      this.detach();
    }
    this.car.removeFromParent();
    for (const g of this.geometries) g.dispose();
    for (const m of [this.paint, this.glass, this.headlights, this.taillights]) m.dispose();
    this.beam.dispose();
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
    this.city.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.city.canvas.removeEventListener('wheel', this.onWheel);
    this.city.canvas.style.cursor = '';
  }

  private input(): CarInput {
    const has = (codes: readonly string[]) => codes.some((c) => this.pressed.has(c));
    return {
      throttle: (has(KEYS.forward) ? 1 : 0) - (has(KEYS.back) ? 1 : 0),
      steer: (has(KEYS.right) ? 1 : 0) - (has(KEYS.left) ? 1 : 0),
      handbrake: this.pressed.has('Space'),
      fast: this.pressed.has('ShiftLeft') || this.pressed.has('ShiftRight'),
    };
  }

  /** Высота под колёсами: средняя, наклон вперёд и вбок. */
  private groundUnder(state: CarState = this.state): { z: number; pitch: number; roll: number } {
    const [fl, fr, rl, rr] = wheelSpots(state.position, state.heading).map(([x, y]) => this.heightAt(x, y)) as [number, number, number, number];
    return {
      z: (fl + fr + rl + rr) / 4,
      pitch: Math.atan2((fl + fr - rl - rr) / 2, CAR.wheelbase),
      roll: Math.atan2((fr + rr - fl - rl) / 2, CAR.track),
    };
  }

  private blocked(position: Vec2, heading: number): boolean {
    return bodyCircles(position, heading).some((c) => this.collider.isBlocked(c));
  }

  private tick(rawDt: number): boolean {
    const dt = Math.min(rawDt, MAX_DT);
    const input = this.input();
    const now = performance.now();

    if (now - this.lastSurfaceCheck > SURFACE_UPDATE_MS) {
      this.lastSurfaceCheck = now;
      this.surface = this.surfaceAt(this.state.position);
      this.grip = this.surface === 'grass' ? OFFROAD_GRIP : 1;
    }
    const ground = this.groundUnder();
    const step = stepCar(this.state, input, dt, { slope: Math.sin(ground.pitch), grip: this.grip });
    this.braking = (input.throttle < 0 && this.state.speed > 0.3) || (input.throttle > 0 && this.state.speed < -0.3) || input.handbrake;

    // Столкновения: машина — три круга. Упёрлись — пробуем скользнуть вдоль стены, иначе стоп с отскоком.
    const old = this.state;
    let next: CarState = { position: step.position, heading: step.heading, speed: step.speed, steer: step.steer };
    if (!this.blocked(old.position, old.heading) && this.blocked(next.position, next.heading)) {
      const dx = next.position[0] - old.position[0];
      const dy = next.position[1] - old.position[1];
      const slides: Vec2[] = [
        [old.position[0] + dx, old.position[1]],
        [old.position[0], old.position[1] + dy],
      ];
      // Скользим, только если вдоль стены и правда есть куда сдвинуться (носом в стену — стоп).
      const wanted = Math.hypot(dx, dy);
      const slide = slides.find((p) => Math.hypot(p[0] - old.position[0], p[1] - old.position[1]) > wanted * 0.3 && !this.blocked(p, old.heading));
      const impact = Math.abs(old.speed);
      if (slide && impact < 9) {
        next = { ...next, position: slide, heading: old.heading, speed: next.speed * 0.75 };
      } else {
        // Ударились на скорости — лёгкий отскок и звук удара; просто упёрлись — стоим.
        next = { ...next, position: old.position, heading: old.heading, speed: impact > 4 ? -old.speed * 0.2 : 0 };
        if (impact > 2.5 && this.bumpCooldown <= 0) {
          this.callbacks.onBump?.(Math.min(impact / 14, 1));
          this.bumpCooldown = 0.5;
        }
      }
    }
    this.bumpCooldown -= dt;
    this.state = next;

    // Кузов: высота и наклоны по рельефу (с мягкой подвеской), плюс клевок при торможении и крен в повороте.
    const under = this.groundUnder();
    const k = 1 - Math.exp(-14 * dt);
    this.bodyZ += (under.z - this.bodyZ) * k;
    const sway = MathUtils.clamp(step.accel * 0.006, -0.05, 0.05);
    const lean = MathUtils.clamp(step.lateral * 0.008, -0.06, 0.06);
    this.pitch += (under.pitch + sway - this.pitch) * k;
    this.roll += (under.roll + lean - this.roll) * k;
    const [x, y] = this.state.position;
    this.car.position.set(x, this.bodyZ, -y);
    this.car.rotation.set(this.pitch, -this.state.heading, this.roll, 'YXZ');
    this.wheelSpin -= (this.state.speed * dt) / CAR.wheelRadius;
    for (const w of this.wheels) {
      w.spin.rotation.x = this.wheelSpin;
      w.pivot.rotation.y = w.front ? -this.state.steer : 0;
    }
    this.updateLights();
    this.updateCamera(dt);

    if (now - this.lastStreetCheck > STREET_UPDATE_MS) {
      this.lastStreetCheck = now;
      const street = this.streets.nameAt(this.state.position);
      if (street !== this.street) {
        this.street = street;
        this.callbacks.onStreet(street);
      }
    }
    const engine = engineState(this.state.speed, input.throttle);
    if (now - this.lastHud > HUD_UPDATE_MS) {
      this.lastHud = now;
      this.callbacks.onHud({ speed: Math.round(Math.abs(this.state.speed) * 3.6), gear: engine.gear });
    }
    this.callbacks.onSound?.({ rpm: engine.rpm, throttle: input.throttle, speed: Math.abs(this.state.speed), surface: this.surface });
    return true;
  }

  private updateLights(): void {
    const night = NIGHT.lamps.value;
    this.headlights.emissiveIntensity = 0.05 + night * 2.4;
    this.taillights.emissiveIntensity = this.braking ? 2.2 : 0.04 + night * 1.1;
    this.beam.intensity = night * 140;
  }

  private updateCamera(dt: number): void {
    const camera = this.city.camera;
    const heading = this.state.heading;
    // Оглядывались мышью и поехали — взгляд сам возвращается вперёд.
    if (!this.dragging) {
      this.lookIdle += dt;
      if (this.lookIdle > 1.2 && Math.abs(this.state.speed) > 1) {
        const k = 1 - Math.exp(-2.5 * dt);
        this.lookYaw -= this.lookYaw * k;
        this.lookPitch -= this.lookPitch * k;
      }
    }

    if (this.glassMesh) this.glassMesh.visible = this.view !== 'cabin';
    if (this.view === 'cabin') {
      this.car.updateMatrixWorld();
      // Оси машины → three.js: (x, z, −y).
      const world = this.car.localToWorld(new Vector3(DRIVER_EYE.x, DRIVER_EYE.z, -DRIVER_EYE.y));
      const yaw = heading + this.lookYaw;
      const pitch = this.pitch + this.lookPitch - 0.06;
      camera.position.copy(world);
      this.city.target.set(
        world.x + Math.sin(yaw) * Math.cos(pitch) * 20,
        world.y + Math.sin(pitch) * 20,
        world.z - Math.cos(yaw) * Math.cos(pitch) * 20,
      );
      camera.near = 0.08;
      this.setFov(68);
    } else {
      // Камера догоняет курс машины с запаздыванием — поворот виден, но без рывков.
      const k = 1 - Math.exp(-3.5 * dt);
      this.cameraYaw += angleDelta(heading, this.cameraYaw) * k;
      const yaw = this.cameraYaw + this.lookYaw;
      const elevation = MathUtils.clamp(0.26 + this.lookPitch, 0.05, 1.2);
      const [x, y] = this.state.position;
      const lookAt = new Vector3(x + Math.sin(heading) * 1.5, this.bodyZ + 1.2, -(y + Math.cos(heading) * 1.5));
      // Между машиной и камерой стена — камера подъезжает ближе (быстро), стена ушла — отъезжает (плавно).
      const full = this.chaseDistance * Math.cos(elevation);
      let free = 1;
      for (let k = 3; k <= 12; k++) {
        const t = k / 12;
        if (this.collider.isBlocked([x - Math.sin(yaw) * full * t, y - Math.cos(yaw) * full * t], CAMERA_CLEARANCE)) {
          free = Math.max(0.4, t - 0.08);
          break;
        }
      }
      this.reach += (free - this.reach) * (1 - Math.exp(-(free < this.reach ? 12 : 2) * dt));
      const d = this.chaseDistance * this.reach;
      const cx = x - Math.sin(yaw) * Math.cos(elevation) * d;
      const cy = y - Math.cos(yaw) * Math.cos(elevation) * d;
      // Подтянутая к машине камера остаётся на прежней высоте — смотрит поверх крыши, а не упирается в неё.
      const cz = Math.max(this.bodyZ + 1.3 + Math.sin(elevation) * this.chaseDistance, this.heightAt(cx, cy) + 0.8);
      camera.position.set(cx, cz, -cy);
      this.city.target.copy(lookAt);
      camera.near = 0.2;
      this.setFov(52 + Math.min(Math.abs(this.state.speed), 25) * 0.45);
    }
    camera.lookAt(this.city.target);
  }

  private setFov(target: number): void {
    const camera = this.city.camera;
    const fov = camera.fov + (target - camera.fov) * 0.08;
    if (Math.abs(fov - camera.fov) > 0.01) camera.fov = fov;
    camera.updateProjectionMatrix();
  }

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (isTypingTarget(event.target)) return;
    if (event.code === 'Escape') {
      event.preventDefault();
      this.exit();
      return;
    }
    if (event.code === 'KeyC' && !event.repeat) {
      this.toggleView();
      return;
    }
    if (event.code === 'KeyR' && !event.repeat) {
      this.backToRoad();
      return;
    }
    if (HANDLED.has(event.code)) {
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
    if (event.button !== 0 && event.button !== 2) return;
    this.dragging = true;
    this.lookIdle = 0;
    this.lastPointer = [event.clientX, event.clientY];
    this.city.canvas.style.cursor = 'grabbing';
  };

  private readonly onPointerMove = (event: PointerEvent) => {
    if (!this.dragging) return;
    const [x, y] = this.lastPointer;
    this.lastPointer = [event.clientX, event.clientY];
    this.lookYaw += (event.clientX - x) * LOOK_SENSITIVITY;
    this.lookPitch = MathUtils.clamp(this.lookPitch + (event.clientY - y) * LOOK_SENSITIVITY * 0.7, -0.5, 0.9);
    this.lookIdle = 0;
  };

  private readonly onPointerUp = () => {
    if (!this.dragging) return;
    this.dragging = false;
    this.city.canvas.style.cursor = 'grab';
  };

  private readonly onWheel = (event: WheelEvent) => {
    event.preventDefault();
    this.chaseDistance = MathUtils.clamp(this.chaseDistance * Math.exp(event.deltaY * 0.0015), CHASE.min, CHASE.max);
  };
}
