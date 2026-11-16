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

import { BufferAttribute, Color, Float16BufferAttribute, Group, InstancedBufferAttribute, InstancedMesh, Matrix4, Mesh, Quaternion, Vector3, type BufferGeometry, type Intersection, type Material, type Object3D } from 'three';
import type { CSM } from 'three/addons/csm/CSM.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CAN_EDIT } from '../config/mode';
import { FOOTING_DEPTH, siteOnSlope } from '../world/base/siting';
import { modelPlacement, type LonLat } from '../world/edit/edits';
import { findHouseModel } from '../world/village/houseModels';
import { simplifyParts, type BoxPart, type HousePart } from '../world/village/houseParts';
import { fitPreset, type VillageHouse } from '../world/village/villagePlan';
import type { LocalFrame } from '../world/walk/localFrame';
import type { CityScene } from './CityScene';
import { toThree } from './coords';
import { markRanges, type GroundArea, type GroundDelta } from './merged';
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
  /** Цоколи модели (под ними — фундаменты) и уровень пола: при правке земли дом садится на склон заново. */
  plinths: BoxPart[];
  floor: number;
  /** Свои цвета кровли и стен (линейные RGB) или −1 — цвет модели. */
  roof: [number, number, number];
  wall: [number, number, number];
}

const KEEP: [number, number, number] = [-1, -1, -1];
const linear = (hex: string | undefined): [number, number, number] => {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return KEEP;
  const c = new Color(hex);
  return [c.r, c.g, c.b];
};

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
  /**
   * На сайте упрощённые (дальние) дома всех видов склеены в две сетки — стены и стёкла: два вызова
   * отрисовки вместо сотни. Ближние и спрятанные дома в склейке сведены в точку. У редактора — как раньше.
   */
  private readonly farMerged: FarMerged[] = [];
  private farMaterials?: HouseMaterials;

  constructor(
    private readonly city: CityScene,
    private readonly frame: LocalFrame,
    private readonly heightAt: (x: number, y: number) => number,
    readonly houses: readonly VillageHouse[],
    csm: CSM,
    /** Ближе этого — полная модель, м (мелким постройкам дворов хватает меньшего). */
    private readonly nearDistance = NEAR_M,
  ) {
    this.materials = createHouseMaterials(csm, { surveyColors: true });
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

    const mergeFar = !CAN_EDIT;
    const farParts: { solid: { owner: string; geometry: BufferGeometry }[]; glass: { owner: string; geometry: BufferGeometry }[] } = { solid: [], glass: [] };
    const foundationColors: string[] = [];
    let foundationCount = 0;
    const triangles = { near: 0, far: 0 };
    for (const list of groups.values()) {
      const { house, size } = list[0]!;
      const plan = findHouseModel(house.model)!.plan({ seed: house.seed, width: size[0], depth: size[1] });
      const farPlan = findHouseModel(house.model)!.plan({ seed: house.seed, width: size[0], depth: size[1], far: true });
      const farBuilt = mergeFar ? buildHouseGeometries(simplifyParts(farPlan.parts)) : undefined;
      if (farBuilt) triangles.far += farBuilt.triangles * list.length;
      const kind: Kind = {
        near: this.instanced(plan.parts, list.length, (t) => (triangles.near += t * list.length)),
        far: farBuilt ? [] : this.instanced(simplifyParts(farPlan.parts), list.length, (t) => (triangles.far += t * list.length)),
        entries: [],
      };
      this.kinds.push(kind);
      const plinths = plan.parts.filter(
        (p): p is BoxPart => p.type === 'box' && p.surface === 'plaster' && Math.abs(p.center[2] - p.size[2] / 2) < 0.03,
      );
      list.forEach(({ house: h, matrix, floor, low, center }, slot) => {
        const entry: Entry = {
          id: h.id,
          kind,
          matrix,
          center,
          near: true,
          foundations: [],
          plinths,
          floor,
          roof: linear(h.colors?.roof),
          wall: linear(h.colors?.wall),
        };
        this.entries.set(h.id, entry);
        kind.entries.push(entry);
        // Пока — все дома во всех мешах вида: так считаются границы для отсечения.
        for (const mesh of [...kind.near, ...kind.far]) {
          mesh.setMatrixAt(slot, matrix);
          setRepaint(mesh, slot, entry);
        }
        // Склейка: своя копия упрощённого дома, уже на месте и со своими цветами кровли и стен.
        if (farBuilt) {
          for (const [source, list2] of [
            [farBuilt.solid, farParts.solid],
            [farBuilt.glass, farParts.glass],
          ] as const) {
            if (!source.getAttribute('position').count) continue;
            const copy = source.clone().applyMatrix4(matrix);
            bakeRepaint(copy, entry);
            list2.push({ owner: h.id, geometry: copy });
          }
        }
        // Фундамент под каждым цоколем (цвет — как у цоколя); на ровном он весь в земле, на склоне — виден.
        entry.foundations = foundationMatrices(matrix, plinths, floor - low);
        for (const p of plinths) foundationColors.push(p.color);
        foundationCount += plinths.length;
      });
      if (farBuilt) {
        farBuilt.solid.dispose();
        farBuilt.glass.dispose();
      }
    }
    if (mergeFar) {
      this.farMaterials = createHouseMaterials(csm);
      const solid = mergeOwned(farParts.solid, this.farMaterials.solid, 'village-far');
      const glass = mergeOwned(farParts.glass, this.farMaterials.glass, 'village-far-glass');
      if (glass) glass.mesh.castShadow = false;
      for (const m of [solid, glass]) {
        if (!m) continue;
        this.farMerged.push(m);
        this.group.add(m.mesh);
      }
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

  /** Земля поменялась (кисть рельефа): дома в area садятся на склон заново — как при загрузке. */
  shiftGround(_delta: GroundDelta, area: GroundArea): void {
    for (const entry of this.entries.values()) {
      const rect = this.byId.get(entry.id)!.rect;
      if (rect.every(([x]) => x < area.x0) || rect.every(([x]) => x > area.x1) || rect.every(([, y]) => y < area.y0) || rect.every(([, y]) => y > area.y1)) {
        continue;
      }
      const site = siteOnSlope(rect, this.heightAt);
      const d = site.floor - entry.floor;
      if (Math.abs(d) < 1e-4 && !entry.plinths.length) continue;
      entry.floor = site.floor;
      entry.matrix.elements[13]! += d;
      entry.center.y += d;
      entry.foundations = foundationMatrices(entry.matrix, entry.plinths, site.floor - site.low);
      // Вид дома — переложить заново (вместе с ним перекладываются и фундаменты).
      this.dirty.add(entry.kind);
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
    return this.group.visible ? [...this.meshes, ...this.farMerged.map((m) => m.mesh)] : [];
  }

  /** id дома OSM по попаданию луча (или undefined). */
  buildingFromPick(hit: Intersection | undefined): string | undefined {
    if (!hit || !this.group.visible) return undefined;
    const merged = this.farMerged.find((m) => m.mesh === hit.object);
    const id = merged ? (hit.face ? merged.ownerAt(hit.face.a) : undefined) : hit.instanceId == null ? undefined : this.owners.get(hit.object)?.[hit.instanceId];
    return id && !this.hidden.has(id) ? id : undefined;
  }

  /** Модель дома (если он сейчас нарисован моделью). */
  /** Какие дома сейчас не рисуются. */
  get hiddenIds(): ReadonlySet<string> {
    return this.hidden;
  }

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
    for (const m of this.farMerged) m.mesh.geometry.dispose();
    this.materials.dispose();
    this.farMaterials?.dispose();
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
      // Цвета кровли и стен у каждого экземпляра (−1 — цвет модели).
      if (material === this.materials.solid) {
        geometry.setAttribute('surveyRoof', new InstancedBufferAttribute(new Float32Array(count * 3).fill(-1), 3));
        geometry.setAttribute('surveyWall', new InstancedBufferAttribute(new Float32Array(count * 3).fill(-1), 3));
      }
      const mesh = this.addMesh(new InstancedMesh(geometry, material, count));
      // Стёкла — в проёмах стен: тени от них не видно, а это лишний вызов в каждом каскаде теней.
      if (material === this.materials.glass) mesh.castShadow = false;
      out.push(mesh);
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
      const near = distance < (entry.near ? this.nearDistance + NEAR_HYSTERESIS_M : this.nearDistance);
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
            setRepaint(mesh, i, e);
            owners[i] = e.id;
          });
          mesh.count = list.length;
          // Пустой меш не рисуем вовсе: иначе это лишний вызов отрисовки (и в каждом каскаде теней).
          mesh.visible = list.length > 0;
          mesh.instanceMatrix.needsUpdate = true;
          for (const name of ['surveyRoof', 'surveyWall']) {
            const attribute = mesh.geometry.getAttribute(name);
            if (attribute) attribute.needsUpdate = true;
          }
        }
      }
    }
    this.dirty.clear();
    // Склейка дальних домов: ближние (их рисует полная модель) и спрятанные — сведены в точку.
    for (const m of this.farMerged) m.setHidden((id) => this.hidden.has(id) || !!this.entries.get(id)?.near);
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
      mesh.visible = index > 0;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    return true;
  }
}

/** Цвета кровли и стен дома — в экземпляр slot меша (если у меша они есть). */
function setRepaint(mesh: InstancedMesh, slot: number, entry: Entry): void {
  const roof = mesh.geometry.getAttribute('surveyRoof') as InstancedBufferAttribute | undefined;
  const wall = mesh.geometry.getAttribute('surveyWall') as InstancedBufferAttribute | undefined;
  roof?.setXYZ(slot, ...entry.roof);
  wall?.setXYZ(slot, ...entry.wall);
}

/** Фундаменты под цоколями дома (матрица дома matrix): от низа цоколя до drop + FOOTING_DEPTH ниже пола. */
function foundationMatrices(matrix: Matrix4, plinths: readonly BoxPart[], drop: number): Matrix4[] {
  const bottom = -Math.max(drop, 0) - FOOTING_DEPTH;
  return plinths.map((p) =>
    matrix.clone().multiply(new Matrix4().compose(new Vector3(p.center[0], (bottom + 0.05) / 2, -p.center[1]), new Quaternion(), new Vector3(p.size[0], 0.05 - bottom, p.size[1]))),
  );
}

/** Цвета кровли и стен дома — прямо в цвета вершин копии (для склейки, где нет цветов на экземпляр). */
function bakeRepaint(geometry: BufferGeometry, entry: Entry): void {
  const paint = geometry.getAttribute('paint');
  const color = geometry.getAttribute('color');
  if (paint && color && (entry.roof[0] >= 0 || entry.wall[0] >= 0)) {
    for (let i = 0; i < paint.count; i++) {
      const role = paint.getX(i);
      const own = role > 0.5 && role < 1.5 ? entry.roof : role > 1.5 ? entry.wall : KEEP;
      if (own[0] < 0) continue;
      const tone = paint.getY(i);
      color.setXYZ(i, Math.min(1, own[0] * tone), Math.min(1, own[1] * tone), Math.min(1, own[2] * tone));
    }
  }
  // В склейке цвета уже свои — признак «кровля или стены» не нужен.
  if (paint) geometry.deleteAttribute('paint');
  // Узор поверхности (код и координаты в осях дома, метры) — половинной точностью: дальние дома видны
  // не ближе 140 м, разницы нет, а памяти вдвое меньше.
  const surface = geometry.getAttribute('surface');
  if (surface) {
    const half = new Float16BufferAttribute(new Uint16Array(surface.count * surface.itemSize), surface.itemSize);
    for (let i = 0; i < surface.count; i++) half.setXYZ(i, surface.getX(i), surface.getY(i), surface.getZ(i));
    geometry.setAttribute('surface', half);
  }
}

/**
 * Склейка дальних домов: у каждого дома — свой диапазон вершин. Прячем дом, указывая во всех его
 * треугольниках на одну вершину (индексы), — без второй копии координат, как у MergedMesh.
 */
class FarMerged {
  private readonly hidden = new Set<string>();

  constructor(
    readonly mesh: Mesh,
    private readonly ranges: ReadonlyMap<string, [number, number][]>,
  ) {
    const count = mesh.geometry.getAttribute('position').count;
    const index = new Uint32Array(count);
    for (let i = 0; i < count; i++) index[i] = i;
    mesh.geometry.setIndex(new BufferAttribute(index, 1));
  }

  setHidden(hide: (owner: string) => boolean): void {
    const attribute = this.mesh.geometry.getIndex()!;
    const index = attribute.array as Uint32Array;
    const touched: [number, number][] = [];
    for (const [owner, ranges] of this.ranges) {
      const want = hide(owner);
      if (want === this.hidden.has(owner)) continue;
      if (want) this.hidden.add(owner);
      else this.hidden.delete(owner);
      for (const [start, count] of ranges) {
        for (let i = start; i < start + count; i++) index[i] = want ? start : i;
        touched.push([start, count]);
      }
    }
    if (touched.length) markRanges(attribute, touched);
  }

  /** Чья вершина — для выбора кликом. */
  ownerAt(vertex: number): string | undefined {
    for (const [owner, ranges] of this.ranges) for (const [start, count] of ranges) if (vertex >= start && vertex < start + count) return owner;
    return undefined;
  }
}

/** Склеить копии домов в одну сетку; у каждого дома — свой диапазон вершин (чтобы прятать и выбирать). */
function mergeOwned(list: { owner: string; geometry: BufferGeometry }[], material: Material, name: string): FarMerged | undefined {
  if (!list.length) return undefined;
  const geometry = mergeGeometries(list.map((g) => g.geometry));
  const ranges = new Map<string, [number, number][]>();
  let start = 0;
  for (const { owner, geometry: g } of list) {
    const count = g.getAttribute('position').count;
    const r = ranges.get(owner) ?? [];
    r.push([start, count]);
    ranges.set(owner, r);
    start += count;
    g.dispose();
  }
  if (!geometry) return undefined;
  // Склейка теряет пометку «половинная точность» — вернуть, иначе видеокарта прочтёт числа как целые.
  const surface = geometry.getAttribute('surface');
  if (surface && !(surface instanceof Float16BufferAttribute)) {
    geometry.setAttribute('surface', new Float16BufferAttribute(surface.array as Uint16Array, surface.itemSize));
  }
  geometry.computeBoundingSphere();
  const mesh = new Mesh(geometry, material);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return new FarMerged(mesh, ranges);
}
