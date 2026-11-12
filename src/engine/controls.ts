// Три режима камеры: обзор сверху, прогулка от первого лица, поездка на машине.

import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  SpotLight,
  Vector3,
  type PerspectiveCamera,
} from 'three';
import { clamp } from '../core/geo';
import type { RoadIndex, SegmentGrid } from '../core/spatial';
import type { Rect } from './shared';
import type { HeightMap } from './terrain';

/** То, что режимам нужно от мира; поля меняются при смене территории. */
/** Подписка, которая снимается вместе с движком: иначе прежний движок продолжал бы ловить мышь. */
function on<K extends keyof HTMLElementEventMap>(signal: AbortSignal, target: EventTarget, type: K, handler: (e: HTMLElementEventMap[K]) => void, options?: AddEventListenerOptions): void {
  target.addEventListener(type, handler as EventListener, { ...options, signal });
}

export interface Ctx {
  /** Гаснет, когда движок уничтожен. */
  signal: AbortSignal;
  camera: PerspectiveCamera;
  dom: HTMLElement;
  keys: Set<string>;
  hm: HeightMap;
  walls: SegmentGrid<number>;
  roads: RoadIndex;
  rect: Rect;
  city: boolean;
  night: number;
  /** Точка земли под точкой экрана (координаты −1..1). */
  ground: (nx: number, ny: number) => Vector3 | null;
  /** Для звука: пройдено пешком, состояние мотора (undefined — заглушить), удар. */
  onWalk?: (distance: number, running: boolean, x: number, z: number) => void;
  onDrive?: (car: { rpm: number; throttle: number; speed: number; x: number; z: number } | undefined) => void;
  onBump?: (strength: number) => void;
}

const damp = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);
const axis = (keys: Set<string>, plus: string[], minus: string[]) =>
  (plus.some((k) => keys.has(k)) ? 1 : 0) - (minus.some((k) => keys.has(k)) ? 1 : 0);

/** Выталкивает круг из стен. Возвращает глубину самого сильного проникновения. */
function pushOut(ctx: Ctx, p: { x: number; z: number }, r: number): number {
  let worst = 0;
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    ctx.walls.near(p.x, p.z, r, (dist, t, ax, az, bx, bz) => {
      const cx = ax + (bx - ax) * t, cz = az + (bz - az) * t;
      const d = Math.max(dist, 1e-4);
      const push = r - dist;
      if (push <= 0) return;
      p.x += ((p.x - cx) / d) * push;
      p.z += ((p.z - cz) / d) * push;
      worst = Math.max(worst, push);
      moved = true;
    });
    if (!moved) break;
  }
  return worst;
}

export class Overview {
  readonly focus = new Vector3();
  shadowRadius = 600;
  onPick?: (clientX: number, clientY: number) => void;
  private g = { x: 0, z: 0, dist: 900, yaw: 0.6, pitch: 0.62 };
  private c = { ...this.g };
  private y = 0;
  private down?: { x: number; y: number; button: number; moved: number; shift: boolean };
  private active = false;
  private enabled = true;

  constructor(private readonly ctx: Ctx) {
    const dom = ctx.dom;
    on(ctx.signal, dom, 'pointerdown', (e) => {
      if (!this.active || !this.enabled) return;
      this.down = { x: e.clientX, y: e.clientY, button: e.button, moved: 0, shift: e.shiftKey };
      dom.setPointerCapture(e.pointerId);
    });
    on(ctx.signal, dom, 'pointermove', (e) => {
      const d = this.down;
      if (!this.active || !d || !this.enabled) return;
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      d.x = e.clientX;
      d.y = e.clientY;
      d.moved += Math.abs(dx) + Math.abs(dy);
      const g = this.g;
      if (d.button === 2 || d.button === 1 || d.shift) {
        g.yaw -= dx * 0.005;
        g.pitch = clamp(g.pitch + dy * 0.004, 0.1, 1.52);
      } else {
        const k = (g.dist * 2 * Math.tan((ctx.camera.fov * Math.PI) / 360)) / dom.clientHeight;
        const fwd = (dy * k) / Math.max(0.3, Math.sin(g.pitch));
        g.x += -Math.cos(g.yaw) * dx * k - Math.sin(g.yaw) * fwd;
        g.z += Math.sin(g.yaw) * dx * k - Math.cos(g.yaw) * fwd;
      }
    });
    on(ctx.signal, dom, 'pointerup', (e) => {
      const d = this.down;
      this.down = undefined;
      if (this.active && d && d.button === 0 && d.moved < 5) this.onPick?.(e.clientX, e.clientY);
    });
    on(ctx.signal, dom, 'dblclick', (e) => {
      if (!this.active) return;
      const r = dom.getBoundingClientRect();
      const p = ctx.ground(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      if (p) this.flyTo(p.x, p.z, Math.max(60, this.g.dist * 0.45));
    });
    on(ctx.signal, dom, 'wheel', (e) => {
      if (!this.active) return;
      e.preventDefault();
      this.g.dist = clamp(this.g.dist * Math.exp(e.deltaY * 0.0013), 25, 7000);
    }, { passive: false });
    on(ctx.signal, dom, 'contextmenu', (e) => e.preventDefault());
  }

  enter(): void {
    this.active = true;
  }
  /** Мышь камеры: редактор выключает её, пока тянут дом или ведут линию. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.down = undefined;
  }
  exit(): void {
    this.active = false;
    this.down = undefined;
  }

  flyTo(x: number, z: number, dist?: number, snap = false): void {
    this.g.x = x;
    this.g.z = z;
    if (dist) this.g.dist = dist;
    if (snap) {
      this.c = { ...this.g };
      this.y = this.ctx.hm.at(x, z);
    }
  }

  setPose(x: number, z: number, dist: number, yaw = this.g.yaw, pitch = this.g.pitch): void {
    Object.assign(this.g, { x, z, dist, yaw, pitch });
    this.c = { ...this.g };
    this.y = this.ctx.hm.at(x, z);
  }

  setView(top: boolean): void {
    this.g.pitch = top ? 1.52 : 0.62;
  }

  update(dt: number): void {
    const { keys, hm, camera, rect } = this.ctx;
    const g = this.g, c = this.c;
    const fast = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 2.6 : 1;
    const mf = axis(keys, ['KeyW', 'ArrowUp'], ['KeyS', 'ArrowDown']);
    const mr = axis(keys, ['KeyD', 'ArrowRight'], ['KeyA', 'ArrowLeft']);
    const v = g.dist * 0.85 * fast * dt;
    g.x += (-Math.sin(g.yaw) * mf + Math.cos(g.yaw) * mr) * v;
    g.z += (-Math.cos(g.yaw) * mf - Math.sin(g.yaw) * mr) * v;
    g.yaw += axis(keys, ['KeyQ'], ['KeyE']) * 1.3 * dt;
    g.dist = clamp(g.dist * Math.exp(axis(keys, ['KeyF', 'Minus'], ['KeyR', 'Equal']) * 1.4 * dt), 25, 7000);
    g.x = clamp(g.x, rect.x0 - 1500, rect.x1 + 1500);
    g.z = clamp(g.z, rect.z0 - 1500, rect.z1 + 1500);

    const k = damp(11, dt);
    c.x += (g.x - c.x) * k;
    c.z += (g.z - c.z) * k;
    c.dist += (g.dist - c.dist) * k;
    c.yaw += (g.yaw - c.yaw) * k;
    c.pitch += (g.pitch - c.pitch) * k;
    this.y += (hm.at(c.x, c.z) - this.y) * damp(6, dt);
    this.focus.set(c.x, this.y, c.z);
    const cp = Math.cos(c.pitch);
    camera.position.set(c.x + Math.sin(c.yaw) * cp * c.dist, this.y + Math.sin(c.pitch) * c.dist, c.z + Math.cos(c.yaw) * cp * c.dist);
    camera.position.y = Math.max(camera.position.y, hm.at(camera.position.x, camera.position.z) + 3);
    camera.up.set(0, 1, 0);
    camera.lookAt(this.focus);
    this.shadowRadius = clamp(c.dist * 1.15, 140, 2048);
  }
}

/** Общее состояние «игрока» для мини-карты и подписи улицы. */
export interface Player {
  x: number;
  z: number;
  /** Курс: 0 — север, по часовой, радианы. */
  heading: number;
  speed: number;
}

export class Walk implements Player {
  x = 0;
  z = 0;
  heading = 0;
  speed = 0;
  readonly focus = new Vector3();
  readonly shadowRadius = 140;
  private pitch = 0;
  private vx = 0;
  private vz = 0;
  private bob = 0;
  private active = false;
  private drag = false;

  constructor(private readonly ctx: Ctx) {
    const dom = ctx.dom;
    on(ctx.signal, dom, 'click', () => {
      // Браузер может отказать в захвате (вкладка не в фокусе) — тогда осматриваемся с зажатой кнопкой.
      if (this.active && document.pointerLockElement !== dom) void Promise.resolve(dom.requestPointerLock?.()).catch(() => undefined);
    });
    on(ctx.signal, dom, 'pointerdown', () => (this.drag = this.active));
    on(ctx.signal, window, 'pointerup', () => (this.drag = false));
    on(ctx.signal, document, 'mousemove', (e) => {
      if (!this.active) return;
      const locked = document.pointerLockElement === dom;
      if (!locked && !this.drag) return;
      const s = locked ? 0.0022 : -0.004;
      this.heading += e.movementX * s;
      this.pitch = clamp(this.pitch - e.movementY * s, -1.4, 1.4);
    });
  }

  enter(x: number, z: number, heading: number): void {
    Object.assign(this, { x, z, heading, pitch: 0, vx: 0, vz: 0, active: true });
  }
  exit(): void {
    this.active = false;
    if (document.pointerLockElement === this.ctx.dom) document.exitPointerLock();
  }

  update(dt: number): void {
    const { keys, hm, camera } = this.ctx;
    this.heading += axis(keys, ['KeyE', 'ArrowRight'], ['KeyQ', 'ArrowLeft']) * 1.9 * dt;
    const mf = axis(keys, ['KeyW', 'ArrowUp'], ['KeyS', 'ArrowDown']);
    const mr = axis(keys, ['KeyD'], ['KeyA']);
    const run = keys.has('ShiftLeft') || keys.has('ShiftRight');
    const len = Math.hypot(mf, mr) || 1;
    const top = run ? 9 : 3.6;
    const sh = Math.sin(this.heading), ch = Math.cos(this.heading);
    const wx = ((sh * mf + ch * mr) / len) * top;
    const wz = ((-ch * mf + sh * mr) / len) * top;
    const k = damp(9, dt);
    this.vx += (wx - this.vx) * k;
    this.vz += (wz - this.vz) * k;
    this.x += this.vx * dt;
    this.z += this.vz * dt;
    pushOut(this.ctx, this, 0.45);
    this.speed = Math.hypot(this.vx, this.vz);
    if (this.speed > 0.4) this.ctx.onWalk?.(this.speed * dt, run, this.x, this.z);
    this.bob += this.speed * dt * 1.9;
    const eye = hm.at(this.x, this.z) + 1.7 + Math.sin(this.bob) * 0.035 * Math.min(1, this.speed / 3);
    camera.position.set(this.x, eye, this.z);
    camera.rotation.set(this.pitch, -this.heading, 0, 'YXZ');
    this.focus.set(this.x, eye, this.z);
  }
}

export const CAR_COLOURS = ['#c8372d', '#e8e6e1', '#2b4c7e', '#1d1f22', '#d9a441'];

function buildCar(): { root: Group; body: Group; wheels: Object3D[]; steer: Group[]; paint: MeshStandardMaterial; head: MeshStandardMaterial; tail: MeshStandardMaterial; spot: SpotLight } {
  const root = new Group();
  const body = new Group();
  root.add(body);
  const paint = new MeshStandardMaterial({ color: CAR_COLOURS[0], roughness: 0.32, metalness: 0.55 });
  const glass = new MeshStandardMaterial({ color: 0x1a2228, roughness: 0.08, metalness: 0.7 });
  const dark = new MeshStandardMaterial({ color: 0x17181a, roughness: 0.8 });
  const hub = new MeshStandardMaterial({ color: 0xb8bcc2, roughness: 0.35, metalness: 0.8 });
  const head = new MeshStandardMaterial({ color: 0xdddddd, emissive: new Color(1, 0.93, 0.8), emissiveIntensity: 0 });
  const tail = new MeshStandardMaterial({ color: 0x551111, emissive: new Color(1, 0.08, 0.04), emissiveIntensity: 0.4 });
  const part = (geometry: BoxGeometry | CylinderGeometry, material: MeshStandardMaterial, x: number, y: number, z: number, parent: Object3D = body) => {
    const mesh = new Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  };
  part(new BoxGeometry(1.82, 0.5, 4.3), paint, 0, 0.62, 0);
  part(new BoxGeometry(1.84, 0.16, 4.34), dark, 0, 0.34, 0);
  const cabin = new BoxGeometry(1.62, 0.52, 2.3);
  const cp = cabin.getAttribute('position');
  for (let i = 0; i < cp.count; i++) {
    if (cp.getY(i) > 0) cp.setXYZ(i, cp.getX(i) * 0.84, cp.getY(i), cp.getZ(i) * 0.72);
  }
  cabin.computeVertexNormals();
  part(cabin, glass, 0, 1.13, 0.3);
  part(new BoxGeometry(1.38, 0.05, 1.68), paint, 0, 1.4, 0.3);
  for (const sx of [-0.62, 0.62]) {
    part(new BoxGeometry(0.42, 0.14, 0.06), head, sx, 0.72, -2.15);
    part(new BoxGeometry(0.46, 0.12, 0.06), tail, sx, 0.74, 2.15);
  }
  const wheelGeometry = new CylinderGeometry(0.34, 0.34, 0.24, 16).rotateZ(Math.PI / 2);
  const wheels: Object3D[] = [];
  const steer: Group[] = [];
  for (const [x, z, front] of [[-0.88, -1.38, 1], [0.88, -1.38, 1], [-0.88, 1.34, 0], [0.88, 1.34, 0]] as const) {
    const pivot = new Group();
    pivot.position.set(x, 0.34, z);
    root.add(pivot);
    const wheel = part(wheelGeometry, dark, 0, 0, 0, pivot);
    part(new CylinderGeometry(0.19, 0.19, 0.26, 12).rotateZ(Math.PI / 2), hub, 0, 0, 0, wheel).castShadow = false;
    wheels.push(wheel);
    if (front) steer.push(pivot);
  }
  const spot = new SpotLight(0xfff0d8, 0, 90, 0.52, 0.7, 1.4);
  spot.position.set(0, 0.8, -2.0);
  spot.target.position.set(0, 0.1, -22);
  body.add(spot, spot.target);
  return { root, body, wheels, steer, paint, head, tail, spot };
}

export class Drive implements Player {
  x = 0;
  z = 0;
  heading = 0;
  speed = 0;
  readonly focus = new Vector3();
  readonly shadowRadius = 180;
  readonly car = buildCar();
  cabin = false;
  private steer = 0;
  private y = 0;
  private pitch = 0;
  private roll = 0;
  private zoom = 1;
  private readonly cam = new Vector3();
  private readonly look = new Vector3();
  private active = false;
  private braking = false;
  private bumpWait = 0;

  constructor(private readonly ctx: Ctx) {
    this.car.root.visible = false;
    on(ctx.signal, ctx.dom, 'wheel', (e) => {
      if (this.active) this.zoom = clamp(this.zoom * Math.exp(e.deltaY * 0.001), 0.6, 3);
    }, { passive: true });
  }

  setColour(hex: string): void {
    this.car.paint.color.set(hex);
  }

  enter(x: number, z: number, heading: number): void {
    Object.assign(this, { x, z, heading, speed: 0, steer: 0, active: true, pitch: 0, roll: 0 });
    this.y = this.ctx.hm.at(x, z);
    this.car.root.visible = true;
    this.cam.set(x - Math.sin(heading) * 9, this.y + 4, z + Math.cos(heading) * 9);
  }
  exit(): void {
    if (this.active) this.ctx.onDrive?.(undefined);
    this.active = false;
    this.car.root.visible = false;
  }

  /** Вернуть машину на ближайшую дорогу. */
  reset(): void {
    const hit = this.ctx.roads.nearest(this.x, this.z, 400);
    if (!hit) return;
    const along = hit.dx * Math.sin(this.heading) - hit.dz * Math.cos(this.heading) >= 0 ? 1 : -1;
    this.enter(hit.x, hit.z, Math.atan2(hit.dx * along, -hit.dz * along));
  }

  update(dt: number): void {
    const { keys, hm, roads, camera } = this.ctx;
    const gas = axis(keys, ['KeyW', 'ArrowUp'], ['KeyS', 'ArrowDown']);
    const turn = axis(keys, ['KeyD', 'ArrowRight'], ['KeyA', 'ArrowLeft']);
    const boost = keys.has('ShiftLeft') || keys.has('ShiftRight');
    const onRoad = roads.onRoad(this.x, this.z, 1.5);
    const vmax = ((boost ? 90 : 60) / 3.6) * (onRoad ? 1 : 0.5);
    let v = this.speed;
    this.braking = false;
    if (gas > 0) {
      if (v >= -0.2) v += 6.5 * Math.max(0, 1 - v / vmax) * dt;
      else v += 14 * dt;
    } else if (gas < 0) {
      if (v > 0.4) {
        v -= 15 * dt;
        this.braking = true;
      } else v -= 3.5 * Math.max(0, 1 + v / 7) * dt;
    }
    if (keys.has('Space')) {
      v -= Math.sign(v) * Math.min(Math.abs(v), 20 * dt);
      this.braking = true;
    }
    v -= v * (onRoad ? 0.22 : 0.9) * dt;
    if (v > vmax) v -= (v - vmax) * 2 * dt;

    const sh = Math.sin(this.heading), ch = Math.cos(this.heading);
    const hF = hm.at(this.x + sh * 1.4, this.z - ch * 1.4), hR = hm.at(this.x - sh * 1.4, this.z + ch * 1.4);
    v -= 9.8 * ((hF - hR) / 2.8) * 0.55 * dt;

    const maxSteer = 0.58 / (1 + Math.abs(v) * 0.085);
    this.steer += (turn * maxSteer - this.steer) * damp(5, dt);
    this.heading += ((v * Math.tan(this.steer)) / 2.7) * dt;
    this.x += Math.sin(this.heading) * v * dt;
    this.z += -Math.cos(this.heading) * v * dt;

    // Столкновения: два круга — у передней и задней оси.
    for (const s of [1.25, -1.25]) {
      const p = { x: this.x + Math.sin(this.heading) * s, z: this.z - Math.cos(this.heading) * s };
      const before = { ...p };
      if (pushOut(this.ctx, p, 1.05) > 0) {
        this.x += p.x - before.x;
        this.z += p.z - before.z;
        if (Math.abs(v) > 2.5 && this.bumpWait <= 0) {
          this.ctx.onBump?.(Math.min(Math.abs(v) / 14, 1));
          this.bumpWait = 0.5;
        }
        if (Math.abs(v) > 1.5 && Math.sign(v) === Math.sign(s)) v *= -0.25;
        else v *= 0.9;
      }
    }
    this.speed = v;
    this.bumpWait -= dt;
    // Обороты для звука мотора: условные передачи по скорости.
    const kmh = Math.abs(v) * 3.6;
    const gears = [0, 18, 36, 56, 76, 100];
    const gi = Math.min(gears.length - 2, gears.findIndex((g, i) => kmh >= g && kmh < (gears[i + 1] ?? Infinity)));
    const span = gears[gi + 1] - gears[gi];
    const rpm = kmh < 1 ? 0.12 + Math.max(gas, 0) * 0.25 : 0.25 + 0.7 * Math.min(1, (kmh - gears[gi]) / span);
    this.ctx.onDrive?.({ rpm, throttle: gas, speed: Math.abs(v), x: this.x, z: this.z });

    // Посадка на рельеф.
    const s2 = Math.sin(this.heading), c2 = Math.cos(this.heading);
    const f = hm.at(this.x + s2 * 1.38, this.z - c2 * 1.38), r = hm.at(this.x - s2 * 1.34, this.z + c2 * 1.34);
    const l = hm.at(this.x - c2 * 0.86, this.z - s2 * 0.86), rt = hm.at(this.x + c2 * 0.86, this.z + s2 * 0.86);
    const k = damp(12, dt);
    this.y += ((f + r + l + rt) / 4 - this.y) * damp(18, dt);
    this.pitch += (Math.atan2(f - r, 2.72) - this.pitch) * k;
    this.roll += (Math.atan2(l - rt, 1.72) - this.roll) * k;
    const { root, body, wheels, steer, head, tail, spot } = this.car;
    root.position.set(this.x, this.y, this.z);
    root.rotation.set(this.pitch, -this.heading, -this.roll, 'YXZ');
    const lateral = (v * v * Math.tan(this.steer)) / 2.7;
    body.rotation.z += (clamp(lateral * 0.006, -0.06, 0.06) - body.rotation.z) * k;
    body.rotation.x += ((this.braking ? 0.025 : gas > 0 ? -0.012 : 0) * Math.min(1, Math.abs(v) / 4) - body.rotation.x) * k;
    for (const w of wheels) w.rotation.x -= (v / 0.34) * dt;
    for (const p of steer) p.rotation.y = -this.steer;
    const night = this.ctx.night;
    head.emissiveIntensity = 0.3 + night * 5;
    tail.emissiveIntensity = (this.braking ? 4 : 0.3 + night * 1.2);
    spot.intensity = night * 900;

    // Камера.
    if (this.cabin) {
      camera.position.set(-0.36, 1.2, 0.15).applyMatrix4(root.matrixWorld.compose(root.position, root.quaternion, root.scale));
      camera.rotation.set(this.pitch * 0.6, -this.heading, 0, 'YXZ');
    } else {
      const back = 7.2 * this.zoom + Math.abs(v) * 0.12;
      const want = this.look.set(this.x - s2 * back, this.y + 2.6 * this.zoom + 0.4, this.z + c2 * back);
      this.cam.lerp(want, damp(4.5, dt));
      this.cam.y = Math.max(this.cam.y, hm.at(this.cam.x, this.cam.z) + 1);
      camera.position.copy(this.cam);
      camera.up.set(0, 1, 0);
      camera.lookAt(this.x + s2 * 3.5, this.y + 1.3, this.z - c2 * 3.5);
    }
    this.focus.set(this.x, this.y, this.z);
  }
}
