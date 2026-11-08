// Палисадники деревенских дворов: штакетник, клумбы, кусты и деревца перед домами (planFrontGarden).
// Вдали — одна лёгкая сетка на всю деревню (забор сплошной полосой, крупные кусты и кроны, клумбы
// цветной грядкой). Вблизи — подробные палисадники кусками по 150 м: кусок собирается, когда камера
// впервые подходит к нему ближе NEAR, и показывается вместо своей части дальней сетки.

import { BufferGeometry, Group, Mesh, Vector3 } from 'three';
import type { CSM } from 'three/addons/csm/CSM.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { planFrontGarden } from '../world/village/frontGarden';
import { rotatePartsZ, type HousePart, type Vec3 } from '../world/village/houseParts';
import type { Vec2 } from '../world/walk/localFrame';
import type { CityScene } from './CityScene';
import { buildHouseGeometries, createHouseMaterials, type HouseMaterials } from './houseMesh';
import { MergedMesh } from './merged';

export interface GardenSite {
  /** Владелец — двор (id дома во дворе): палисадник прячется вместе с ним. */
  owner: string;
  /** Середина фасада и единичный вектор к улице (локальные метры). */
  origin: Vec2;
  toStreet: Vec2;
  width: number;
  depth: number;
  seed: number;
}

const CHUNK = 150;
const NEAR = 170;
const HYSTERESIS = 15;
const RECHECK = 6;

interface Chunk {
  sites: GardenSite[];
  center: Vector3;
  radius: number;
  near: boolean;
  mesh?: MergedMesh;
}

export class FrontGardensLayer {
  private readonly group = new Group();
  private readonly materials: HouseMaterials;
  private chunks: Chunk[] = [];
  private far?: MergedMesh;
  private hide: (owner: string) => boolean = () => false;
  private readonly lastCheck = new Vector3(Infinity, 0, 0);
  private readonly removeAnimator: () => void;

  constructor(
    private readonly city: CityScene,
    private readonly heightAt: (x: number, y: number) => number,
    csm: CSM | undefined,
  ) {
    this.group.name = 'front-gardens';
    this.materials = createHouseMaterials(csm);
    city.scene.add(this.group);
    this.removeAnimator = city.addAnimator(() => {
      this.updateLod();
      return false;
    });
  }

  /** Палисадники заново (например, дома стали моделями — у них свой фасад и своя глубина палисадника). */
  setSites(sites: readonly GardenSite[]): void {
    this.clear();
    const cells = new Map<string, GardenSite[]>();
    for (const site of sites) {
      if (site.width < 1 || site.depth < 0.3) continue;
      const key = `${Math.floor(site.origin[0] / CHUNK)}:${Math.floor(site.origin[1] / CHUNK)}`;
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
      for (const s of list) {
        minX = Math.min(minX, s.origin[0]);
        maxX = Math.max(maxX, s.origin[0]);
        minY = Math.min(minY, s.origin[1]);
        maxY = Math.max(maxY, s.origin[1]);
        farParts.push({ owner: s.owner, geometry: this.geometry(s, true) });
      }
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const center = new Vector3(cx, this.heightAt(cx, cy), -cy);
      // Радиус — до самого дальнего палисадника плюс его размах.
      const radius = Math.hypot(maxX - minX, maxY - minY) / 2 + 12;
      this.chunks.push({ sites: list, center, radius, near: false });
    }
    this.far = this.merge(farParts, 'front-gardens-far');
    if (this.far) this.group.add(this.far.mesh);
    this.lastCheck.set(Infinity, 0, 0);
    this.applyHidden();
    this.city.requestRender();
  }

  /** Спрятать палисадники убранных дворов и дворов удалённых домов — как заборы в DetailsLayer. */
  setHidden(yards: ReadonlySet<string>, yardOwnersGone: ReadonlySet<string>): void {
    this.hide = (owner) => yards.has(owner) || yardOwnersGone.has(owner.slice(0, owner.lastIndexOf(':')));
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
    return { near: this.chunks.reduce((s, c) => s + (c.near ? count(c.mesh) : 0), 0), far: count(this.far) };
  }

  destroy(): void {
    this.removeAnimator();
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
      if (near && !chunk.mesh) {
        chunk.mesh = this.merge(
          chunk.sites.map((s) => ({ owner: s.owner, geometry: this.geometry(s, false) })),
          'front-gardens-near',
        );
        if (chunk.mesh) {
          this.group.add(chunk.mesh.mesh);
          chunk.mesh.setHidden(this.hide);
        }
      }
      if (chunk.mesh) chunk.mesh.mesh.visible = near;
    }
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
    const near = new Set(this.chunks.filter((c) => c.near).flatMap((c) => c.sites.map((s) => s.owner)));
    this.far?.setHidden((owner) => this.hide(owner) || near.has(owner));
  }

  /** Палисадник в осях сцены: поворот к улице, сдвиг к фасаду, каждая деталь — на своей высоте земли. */
  private geometry(site: GardenSite, far: boolean): BufferGeometry {
    const { parts } = planFrontGarden({ width: site.width, depth: site.depth, seed: site.seed, far });
    // Ось x палисадника — вдоль фасада (влево от направления к улице), y — от улицы к дому.
    const along: Vec2 = [-site.toStreet[1], site.toStreet[0]];
    const placed = rotatePartsZ(parts, Math.atan2(along[1], along[0])).map((p) => onGround(p, site.origin, this.heightAt));
    return buildHouseGeometries(placed).solid;
  }

  private merge(list: { owner: string; geometry: BufferGeometry }[], name: string): MergedMesh | undefined {
    const usable = list.filter((g) => g.geometry.getAttribute('position').count > 0);
    if (!usable.length) return undefined;
    const geometry = mergeGeometries(usable.map((g) => g.geometry));
    const ranges = new Map<string, [number, number][]>();
    let start = 0;
    for (const { owner, geometry: g } of usable) {
      const count = g.getAttribute('position').count;
      const r = ranges.get(owner) ?? [];
      r.push([start, count]);
      ranges.set(owner, r);
      start += count;
      g.dispose();
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

/** Сдвинуть деталь к фасаду (origin) и поднять на землю под ней. */
function onGround(p: HousePart, origin: Vec2, heightAt: (x: number, y: number) => number): HousePart {
  const lift = (q: Vec3, ground: number): Vec3 => [q[0] + origin[0], q[1] + origin[1], q[2] + ground];
  const groundAt = (q: Vec3) => heightAt(q[0] + origin[0], q[1] + origin[1]);
  if (p.type === 'cylinder') {
    const g = groundAt(p.from);
    return { ...p, from: lift(p.from, g), to: lift(p.to, g) };
  }
  if (p.type === 'slab') {
    const g = groundAt(p.points[0]!);
    return { ...p, points: p.points.map((q) => lift(q, g)) };
  }
  return { ...p, center: lift(p.center, groundAt(p.center)) };
}
