// Деревня из моделей: дома OSM, которым подобрана модель (world/village/villagePlan), рисуются
// башкирскими домами. Одинаковые дома (модель × размер × окраска) — одна геометрия на всех
// (InstancedMesh): три сотни домов — сотня вызовов отрисовки, а не тысячи, и десятки мегабайт, а не
// сотни. Вблизи (до NEAR_M от камеры) — полная модель, дальше — упрощённая (без тонких планок, брёвна
// с меньшим числом граней). Под контур дом подгоняется масштабом (±20 %); на склоне пол — по верхней
// точке земли, а под цоколем — фундамент до нижней (свой ящик на каждый дом).
//
// Открытый интерфейс:
//   new VillageModelsLayer(city, frame, heightAt, houses, csm);
//   setHidden(ids)          — не рисовать эти дома (убраны или изменены в редакторе, их тянут);
//   setVisible(visible)     — показать или спрятать всю деревню из моделей;
//   pickables, buildingFromPick(hit) — выбор кликом: id дома OSM;
//   house(id), rectLonLat(id), houses — какая модель у дома и где её прямоугольник;
//   triangles, destroy().

import { Color, Group, InstancedMesh, Matrix4, Quaternion, Vector3, type BufferGeometry, type Intersection, type Material, type Object3D } from 'three';
import type { CSM } from 'three/addons/csm/CSM.js';
import { FOOTING_DEPTH, siteOnSlope } from '../world/base/siting';
import { modelPlacement, type LonLat } from '../world/edit/edits';
import { findHouseModel } from '../world/village/houseModels';
import { simplifyParts, type BoxPart, type HousePart } from '../world/village/houseParts';
import { fitPreset, type VillageHouse } from '../world/village/villagePlan';
import type { LocalFrame } from '../world/walk/localFrame';
import type { CityScene } from './CityScene';
import { toThree } from './coords';
import { buildHouseGeometries, createHouseMaterials, type HouseMaterials } from './houseMesh';

/** Ближе этого к камере — полная модель, дальше — упрощённая, м (с запасом, чтобы не мигало). */
const NEAR_M = 140;
const NEAR_HYSTERESIS_M = 15;
/** Пересчитываем, кто вблизи, когда камера сдвинулась на столько, м. */
const LOD_STEP_M = 8;

const UP = new Vector3(0, 1, 0);

/** Меши одного вида дома: вблизи и вдали (стены и стёкла) и дома этого вида. */
interface Kind {
  near: InstancedMesh[];
  far: InstancedMesh[];
  entries: Entry[];
}

interface Entry {
  id: string;
  kind: Kind;
  matrix: Matrix4;
  center: Vector3;
  near: boolean;
  /** Фундаменты под цоколями (на склоне). */
  foundations: Matrix4[];
}

export class VillageModelsLayer {
  private readonly group = new Group();
  private readonly materials: HouseMaterials;
  private readonly geometries: BufferGeometry[] = [];
  private readonly meshes: InstancedMesh[] = [];
  /** Чей дом в каждом экземпляре каждого меша. */
  private readonly owners = new Map<Object3D, string[]>();
  private readonly entries = new Map<string, Entry>();
  private readonly kinds: Kind[] = [];
  private foundationMesh?: InstancedMesh;
  private readonly byId = new Map<string, VillageHouse>();
  private hidden: ReadonlySet<string> = new Set();
  private readonly lastCamera = new Vector3(Number.NaN, 0, 0);
  private colors: string[] = [];
  private readonly tmpColor = new Color();
  private readonly removeAnimator: () => void;
  /** Виды, у которых поменялось, кто виден и кто вблизи: их экземпляры надо переложить. */
  private readonly dirty = new Set<Kind>();
  readonly triangles: { near: number; far: number };

  constructor(
    private readonly city: CityScene,
    private readonly frame: LocalFrame,
    heightAt: (x: number, y: number) => number,
    readonly houses: readonly VillageHouse[],
    csm: CSM,
  ) {
    this.materials = createHouseMaterials(csm);
    this.group.name = 'village-models';

    // Дома — по видам: модель × размер × окраска.
    const groups = new Map<string, { house: VillageHouse; matrix: Matrix4; size: [number, number]; floor: number; low: number; center: Vector3 }[]>();
    for (const house of houses) {
      this.byId.set(house.id, house);
      const place = modelPlacement(house.rect);
      const fit = fitPreset(house.model, place.width, place.depth);
      const site = siteOnSlope(house.rect, heightAt);
      const center = toThree(place.center[0], place.center[1], site.floor);
      const matrix = new Matrix4().compose(center, new Quaternion().setFromAxisAngle(UP, place.angle), new Vector3(fit.scale[0], 1, fit.scale[1]));
      const key = `${house.model}:${fit.preset}:${house.seed}`;
      const list = groups.get(key) ?? [];
      list.push({ house, matrix, size: fit.size, floor: site.floor, low: site.low, center });
      groups.set(key, list);
    }

    const foundationColors: string[] = [];
    let foundationCount = 0;
    const triangles = { near: 0, far: 0 };
    for (const list of groups.values()) {
      const { house, size } = list[0]!;
      const plan = findHouseModel(house.model)!.plan({ seed: house.seed, width: size[0], depth: size[1] });
      const farPlan = findHouseModel(house.model)!.plan({ seed: house.seed, width: size[0], depth: size[1], far: true });
      const kind: Kind = {
        near: this.instanced(plan.parts, list.length, (t) => (triangles.near += t * list.length)),
        far: this.instanced(simplifyParts(farPlan.parts), list.length, (t) => (triangles.far += t * list.length)),
        entries: [],
      };
      this.kinds.push(kind);
      const plinths = plan.parts.filter(
        (p): p is BoxPart => p.type === 'box' && p.surface === 'plaster' && Math.abs(p.center[2] - p.size[2] / 2) < 0.03,
      );
      list.forEach(({ house: h, matrix, floor, low, center }, slot) => {
        const entry: Entry = { id: h.id, kind, matrix, center, near: true, foundations: [] };
        this.entries.set(h.id, entry);
        kind.entries.push(entry);
        // Пока — все дома во всех мешах вида: так считаются границы для отсечения.
        for (const mesh of [...kind.near, ...kind.far]) mesh.setMatrixAt(slot, matrix);
        // Фундамент под каждым цоколем дома на склоне (цвет — как у цоколя).
        const drop = floor - low;
        if (drop < 0.03) return;
        const bottom = -drop - FOOTING_DEPTH;
        for (const p of plinths) {
          const local = new Matrix4().compose(
            new Vector3(p.center[0], (bottom + 0.05) / 2, -p.center[1]),
            new Quaternion(),
            new Vector3(p.size[0], 0.05 - bottom, p.size[1]),
          );
          entry.foundations.push(matrix.clone().multiply(local));
          foundationColors.push(p.color);
          foundationCount += 1;
        }
      });
    }
    if (foundationCount) {
      const unit = buildHouseGeometries([{ type: 'box', center: [0, 0, 0], size: [1, 1, 1], color: '#ffffff', surface: 'plaster' }]).solid;
      this.geometries.push(unit);
      this.foundationMesh = this.addMesh(new InstancedMesh(unit, this.materials.solid, foundationCount));
      let index = 0;
      for (const entry of this.entries.values()) for (const matrix of entry.foundations) this.foundationMesh.setMatrixAt(index++, matrix);
      triangles.near += 12 * foundationCount;
    }
    // Границы — по всем домам (до разделения на «вблизи» и «вдали»).
    for (const mesh of this.meshes) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
    this.colors = foundationColors;
    this.triangles = triangles;
    city.scene.add(this.group);
    // Камера сдвинулась — пересчитать, какие дома рисовать полностью.
    this.removeAnimator = city.addAnimator(() => {
      this.updateDetail();
      return false;
    });
    this.updateDetail(true);
  }

  /** Не рисовать эти дома; остальные — показать. */
  setHidden(ids: ReadonlySet<string>): void {
    const before = this.hidden;
    this.hidden = new Set(ids);
    for (const id of new Set([...before, ...ids])) {
      const entry = this.entries.get(id);
      if (entry && before.has(id) !== ids.has(id)) this.dirty.add(entry.kind);
    }
    if (this.flush()) this.city.requestRender();
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
    this.city.requestRender();
  }

  get visible(): boolean {
    return this.group.visible;
  }

  get pickables(): Object3D[] {
    return this.group.visible ? this.meshes : [];
  }

  /** id дома OSM по попаданию луча (или undefined). */
  buildingFromPick(hit: Intersection | undefined): string | undefined {
    if (!hit || hit.instanceId == null || !this.group.visible) return undefined;
    const id = this.owners.get(hit.object)?.[hit.instanceId];
    return id && !this.hidden.has(id) ? id : undefined;
  }

  /** Модель дома (если он сейчас нарисован моделью). */
  house(id: string): VillageHouse | undefined {
    return this.group.visible && !this.hidden.has(id) ? this.byId.get(id) : undefined;
  }

  rectLonLat(id: string): LonLat[] | undefined {
    const house = this.byId.get(id);
    return house?.rect.map(this.frame.toLonLat) as LonLat[] | undefined;
  }

  destroy(): void {
    this.removeAnimator();
    this.city.scene.remove(this.group);
    for (const geometry of this.geometries) geometry.dispose();
    for (const mesh of this.meshes) mesh.dispose();
    this.materials.dispose();
    this.city.requestRender();
  }

  // --- внутреннее ----------------------------------------------------------------------------

  /** Меши вида дома (стены и, если есть, стёкла) на count экземпляров. */
  private instanced(parts: readonly HousePart[], count: number, addTriangles: (t: number) => void): InstancedMesh[] {
    const built = buildHouseGeometries(parts);
    addTriangles(built.triangles);
    const out: InstancedMesh[] = [];
    for (const [geometry, material] of [
      [built.solid, this.materials.solid],
      [built.glass, this.materials.glass],
    ] as [BufferGeometry, Material][]) {
      if (!geometry.getAttribute('position').count) {
        geometry.dispose();
        continue;
      }
      this.geometries.push(geometry);
      out.push(this.addMesh(new InstancedMesh(geometry, material, count)));
    }
    return out;
  }

  private addMesh(mesh: InstancedMesh): InstancedMesh {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = 'village-house';
    this.group.add(mesh);
    this.meshes.push(mesh);
    this.owners.set(mesh, []);
    return mesh;
  }

  /** Вблизи или вдали — по расстоянию от камеры; при сдвиге камеры меньше LOD_STEP_M — без пересчёта. */
  private updateDetail(force = false): void {
    const camera = this.city.camera.position;
    if (!force && camera.distanceTo(this.lastCamera) < LOD_STEP_M) return;
    this.lastCamera.copy(camera);
    for (const entry of this.entries.values()) {
      const distance = entry.center.distanceTo(camera);
      const near = distance < (entry.near ? NEAR_M + NEAR_HYSTERESIS_M : NEAR_M);
      if (near === entry.near && !force) continue;
      entry.near = near;
      this.dirty.add(entry.kind);
    }
    this.flush();
  }

  /**
   * Переложить экземпляры изменившихся видов: в начало меша — только видимые дома (вблизи — в полный,
   * вдали — в упрощённый), count — их число. Скрытые не рисуются вовсе (а не сжимаются в точку).
   */
  private flush(): boolean {
    if (!this.dirty.size) return false;
    for (const kind of this.dirty) {
      const shown = kind.entries.filter((e) => !this.hidden.has(e.id));
      for (const [meshes, list] of [
        [kind.near, shown.filter((e) => e.near)],
        [kind.far, shown.filter((e) => !e.near)],
      ] as const) {
        for (const mesh of meshes) {
          const owners = this.owners.get(mesh)!;
          owners.length = 0;
          list.forEach((e, i) => {
            mesh.setMatrixAt(i, e.matrix);
            owners[i] = e.id;
          });
          mesh.count = list.length;
          mesh.instanceMatrix.needsUpdate = true;
        }
      }
    }
    this.dirty.clear();
    // Фундаменты — общим мешем: только у видимых домов.
    const mesh = this.foundationMesh;
    if (mesh) {
      const owners = this.owners.get(mesh)!;
      owners.length = 0;
      let index = 0;
      let k = 0;
      for (const entry of this.entries.values()) {
        for (const matrix of entry.foundations) {
          const color = this.colors[k++]!;
          if (this.hidden.has(entry.id)) continue;
          mesh.setMatrixAt(index, matrix);
          mesh.setColorAt(index, this.tmpColor.set(color));
          owners[index++] = entry.id;
        }
      }
      mesh.count = index;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    return true;
  }
}
