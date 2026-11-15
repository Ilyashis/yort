// Много мелких деталей из частей (палисадники, заборы, ворота, поленницы) одной сеткой на кусок земли.
// Вдали — одна лёгкая сетка на всё (без мелких планок). Вблизи — подробные куски по CHUNK м: кусок
// собирается заранее (в свободное время браузера, ближние — первыми) или, если не успел, — когда камера
// подходит к нему ближе NEAR (по одному куску за кадр), и показывается вместо своей части дальней
// сетки. Каждая деталь встаёт на землю: группа с anchor — вся на землю в этой точке, без — каждая часть
// на землю под собой (забор на склоне — ступеньками).

import { BufferGeometry, Group, Mesh, Vector3 } from 'three';
import type { CSM } from 'three/addons/csm/CSM.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { HousePart, Vec3 } from '../world/village/houseParts';
import type { Vec2 } from '../world/walk/localFrame';
import type { CityScene } from './CityScene';
import { buildHouseGeometries, createHouseMaterials, type HouseMaterials } from './houseMesh';
import { MergedMesh, type GroundArea, type GroundDelta } from './merged';

/** Части детали (локальные метры, z — от земли); anchor — общая точка земли для всех частей группы. */
export interface PartGroup {
  parts: HousePart[];
  anchor?: Vec2;
}

export interface PartsSite {
  /** Владелец: по нему деталь прячут (двор убрали — и его палисадник). */
  owner: string;
  /** Где деталь: по этой точке она попадает в кусок. */
  center: Vec2;
  /** Размах детали от center, м (для расстояния до камеры). */
  radius?: number;
  plan: (far: boolean) => PartGroup[];
}

/** Сторона куска, м: меньше кусок — короче рывок, когда он собирается. */
const CHUNK = 80;
const NEAR = 170;
/** Заранее (в свободное время браузера) собираем куски ближе этого, м. */
const PREBUILD = NEAR * 2.2;
const HYSTERESIS = 15;
const RECHECK = 6;

interface Chunk {
  sites: PartsSite[];
  center: Vector3;
  radius: number;
  near: boolean;
  /** Подробная сетка уже собиралась (может и не быть — нечего рисовать). */
  built?: boolean;
  mesh?: MergedMesh;
}

export class PartsLayer {
  private readonly group = new Group();
  private readonly materials: HouseMaterials;
  private chunks: Chunk[] = [];
  private far?: MergedMesh;
  private hide: (owner: string) => boolean = () => false;
  private readonly lastCheck = new Vector3(Infinity, 0, 0);
  private readonly removeAnimator: () => void;
  private idle?: number;

  constructor(
    private readonly city: CityScene,
    private readonly heightAt: (x: number, y: number) => number,
    csm: CSM | undefined,
    private readonly name: string,
  ) {
    this.group.name = name;
    this.materials = createHouseMaterials(csm);
    city.scene.add(this.group);
    this.removeAnimator = city.addAnimator(() => {
      this.updateLod();
      // Ближний кусок, которого ещё нет, — собрать (не больше одного за кадр: без долгих рывков).
      return this.buildNext(NEAR + HYSTERESIS, true);
    });
  }

  /**
   * Собрать один ещё не собранный кусок ближе reach к камере (самый близкий). onlyNear — только те, что уже
   * должны быть подробными. true — собрали (нужен кадр).
   */
  private buildNext(reach: number, onlyNear: boolean): boolean {
    const camera = this.city.camera.position;
    let best: Chunk | undefined;
    let bestD = reach;
    for (const chunk of this.chunks) {
      if (chunk.built || (onlyNear && !chunk.near)) continue;
      const d = Math.max(0, camera.distanceTo(chunk.center) - chunk.radius);
      if (d < bestD) {
        bestD = d;
        best = chunk;
      }
    }
    if (!best) return false;
    best.built = true;
    best.mesh = this.merge(
      best.sites.map((s) => ({ owner: s.owner, geometry: this.geometry(s, false) })),
      `${this.name}-near`,
    );
    if (best.mesh) {
      this.group.add(best.mesh.mesh);
      best.mesh.setHidden(this.hide);
      best.mesh.mesh.visible = best.near;
    }
    if (best.near) {
      this.applyFarHidden();
      this.city.requestRender();
    }
    return best.near;
  }

  /** В свободное время браузера — собрать куски вокруг камеры заранее, по одному. */
  private scheduleIdle(): void {
    const ric = (window as unknown as { requestIdleCallback?: (cb: (d: { timeRemaining(): number }) => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (!ric || this.idle !== undefined) return;
    this.idle = ric((deadline) => {
      this.idle = undefined;
      if (!this.chunks.length) return;
      if (deadline.timeRemaining() > 6) this.buildNext(PREBUILD, false);
      if (this.chunks.some((c) => !c.built)) this.scheduleIdle();
    });
  }

  setSites(sites: readonly PartsSite[]): void {
    this.clear();
    const cells = new Map<string, PartsSite[]>();
    for (const site of sites) {
      const key = `${Math.floor(site.center[0] / CHUNK)}:${Math.floor(site.center[1] / CHUNK)}`;
      const list = cells.get(key) ?? [];
      list.push(site);
      cells.set(key, list);
    }
    const farParts: { owner: string; geometry: BufferGeometry }[] = [];
    for (const list of cells.values()) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let reach = 0;
      for (const s of list) {
        minX = Math.min(minX, s.center[0]);
        maxX = Math.max(maxX, s.center[0]);
        minY = Math.min(minY, s.center[1]);
        maxY = Math.max(maxY, s.center[1]);
        reach = Math.max(reach, s.radius ?? 12);
        farParts.push({ owner: s.owner, geometry: this.geometry(s, true) });
      }
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const center = new Vector3(cx, this.heightAt(cx, cy), -cy);
      this.chunks.push({
        sites: list,
        center,
        radius: Math.hypot(maxX - minX, maxY - minY) / 2 + reach,
        near: false,
      });
    }
    this.far = this.merge(farParts, `${this.name}-far`);
    // Вдали тени от тонких заборов и мелочи не видны, а в каждом каскаде теней сетку рисовать заново.
    if (this.far) {
      this.far.mesh.castShadow = false;
      this.group.add(this.far.mesh);
    }
    this.lastCheck.set(Infinity, 0, 0);
    this.applyHidden();
    this.city.requestRender();
    this.scheduleIdle();
  }

  /** Спрятать детали владельцев, для которых hide — true (остальные показать). */
  setHidden(hide: (owner: string) => boolean): void {
    this.hide = hide;
    this.applyHidden();
    this.city.requestRender();
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
    this.city.requestRender();
  }

  /** Сколько треугольников сейчас в сцене: подробные куски и дальняя сетка. */
  get triangles(): { near: number; far: number } {
    const count = (m?: MergedMesh) => (m ? m.mesh.geometry.getAttribute('position').count / 3 : 0);
    return {
      near: this.chunks.reduce((s, c) => s + (c.near ? count(c.mesh) : 0), 0),
      far: count(this.far),
    };
  }

  /** Земля поменялась (кисть рельефа): детали в area — вместе с ней (ещё не собранные соберутся по новой земле). */
  shiftGround(delta: GroundDelta, area: GroundArea): void {
    for (const chunk of this.chunks) chunk.mesh?.shiftGround(delta, area);
    this.far?.shiftGround(delta, area);
  }

  destroy(): void {
    this.removeAnimator();
    const cic = (window as unknown as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback;
    if (this.idle !== undefined) cic?.(this.idle);
    this.clear();
    this.city.scene.remove(this.group);
    this.materials.dispose();
  }

  private clear(): void {
    for (const c of this.chunks) this.disposeMesh(c.mesh);
    this.disposeMesh(this.far);
    this.chunks = [];
    this.far = undefined;
  }

  private disposeMesh(m: MergedMesh | undefined): void {
    if (!m) return;
    this.group.remove(m.mesh);
    // Материал общий для всех кусков — освобождаем только геометрию.
    m.mesh.geometry.dispose();
  }

  /** Ближние куски — подробно, их часть дальней сетки прячем. Проверяем, когда камера сдвинулась на RECHECK. */
  private updateLod(): void {
    const camera = this.city.camera.position;
    if (!this.chunks.length || camera.distanceTo(this.lastCheck) < RECHECK) return;
    this.lastCheck.copy(camera);
    let changed = false;
    for (const chunk of this.chunks) {
      const distance = Math.max(0, camera.distanceTo(chunk.center) - chunk.radius);
      const near = chunk.near ? distance < NEAR + HYSTERESIS : distance < NEAR;
      if (near === chunk.near) continue;
      chunk.near = near;
      changed = true;
      // Ещё не собранный кусок соберёт buildNext (по одному за кадр), пока — дальняя сетка.
      if (chunk.mesh) chunk.mesh.mesh.visible = near;
    }
    if (changed) this.scheduleIdle();
    if (changed) {
      this.applyFarHidden();
      this.city.requestRender();
    }
  }

  private applyHidden(): void {
    for (const c of this.chunks) c.mesh?.setHidden(this.hide);
    this.applyFarHidden();
  }

  private applyFarHidden(): void {
    // Дальнюю сетку прячем только там, где подробная уже собрана.
    const near = new Set(this.chunks.filter((c) => c.near && c.built).flatMap((c) => c.sites.map((s) => s.owner)));
    this.far?.setHidden((owner) => this.hide(owner) || near.has(owner));
  }

  private geometry(site: PartsSite, far: boolean): BufferGeometry {
    const placed: HousePart[] = [];
    for (const group of site.plan(far)) {
      const ground = group.anchor ? this.heightAt(group.anchor[0], group.anchor[1]) : undefined;
      for (const p of group.parts) placed.push(onGround(p, ground, this.heightAt));
    }
    return buildHouseGeometries(placed).solid;
  }

  private merge(list: { owner: string; geometry: BufferGeometry }[], name: string): MergedMesh | undefined {
    const usable = list.filter((g) => g.geometry.getAttribute('position').count > 0);
    if (!usable.length) {
      for (const { geometry } of list) geometry.dispose();
      return undefined;
    }
    const geometry = mergeGeometries(usable.map((g) => g.geometry));
    const ranges = new Map<string, [number, number][]>();
    let start = 0;
    for (const { owner, geometry: g } of usable) {
      const count = g.getAttribute('position').count;
      const r = ranges.get(owner) ?? [];
      r.push([start, count]);
      ranges.set(owner, r);
      start += count;
    }
    for (const { geometry: g } of list) g.dispose();
    if (!geometry) return undefined;
    geometry.computeBoundingSphere();
    const mesh = new Mesh(geometry, this.materials.solid);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return new MergedMesh(mesh, ranges);
  }
}

/** Поднять часть на землю: на общую высоту ground или на землю под самой частью. */
function onGround(p: HousePart, ground: number | undefined, heightAt: (x: number, y: number) => number): HousePart {
  const lift = (q: Vec3, g: number): Vec3 => [q[0], q[1], q[2] + g];
  const at = (q: Vec3) => ground ?? heightAt(q[0], q[1]);
  if (p.type === 'cylinder') {
    const g = at(p.from);
    return { ...p, from: lift(p.from, g), to: lift(p.to, g) };
  }
  if (p.type === 'slab') {
    const g = at(p.points[0]!);
    return { ...p, points: p.points.map((q) => lift(q, g)) };
  }
  return { ...p, center: lift(p.center, at(p.center)) };
}

/** Сдвинуть части на (dx, dy). */
export function translateParts(parts: readonly HousePart[], [dx, dy]: Vec2): HousePart[] {
  const move = (q: Vec3): Vec3 => [q[0] + dx, q[1] + dy, q[2]];
  return parts.map((p): HousePart => {
    if (p.type === 'cylinder') return { ...p, from: move(p.from), to: move(p.to) };
    if (p.type === 'slab') return { ...p, points: p.points.map(move) };
    return { ...p, center: move(p.center) };
  });
}
