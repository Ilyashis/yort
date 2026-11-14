// Правки редактора в сцене three.js: свои и изменённые дома (тем же шейдером фасадов с окнами, что и
// город), трубы, заборы, предпросмотр того, что сейчас тянут или рисуют, подсветка выделенной дороги
// или забора и ручки выделенного дома. Геометрия маленькая — при каждой правке пересобираем целиком.
//
// Открытый интерфейс:
//   Дома с моделью (изба, пятистенок, кирпичный…) рисуются моделью из каталога, вписанной в прямоугольник
//   контура фасадом по первой стороне; геометрия моделей кэшируется по виду и размеру.
//
//   new EditLayer(city, frame, heightAt, village) — heightAt(x, y): высота земли в локальных метрах;
//   render(edits, selectedId?, hiddenId?)   — все правки; selectedId подсвечен, hiddenId не рисуется (его тянут);
//   preview(building | undefined, invalid?) — предпросмотр дома (красным — здесь ставить нельзя);
//   previewLine(points | undefined, kind?)  — линия, которую рисуют сейчас (дорога, забор), lon/lat;
//   highlight(lines)                        — подсветка выделенной дороги или забора: линии по земле, lon/lat;
//   setHandles(building | undefined, outline?) — ручки дома: углы — растянуть, кружок перед фасадом — повернуть;
//   pickables                               — объекты для луча выбора (свои дома, предпросмотр, заборы);
//   hit(clientX, clientY, intersection?)    — что под курсором: ручка (по экрану), свой дом или свой забор;
//   destroy().

import {
  BufferGeometry,
  CanvasTexture,
  Color,
  Group,
  Mesh,
  MeshStandardMaterial,
  Points,
  PointsMaterial,
  ShapeUtils,
  SRGBColorSpace,
  Vector2,
  Vector3,
  type Intersection,
  type Material,
  type Object3D,
} from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { hashString } from '../utils/hash';
import { chimneys, FENCE, FENCE_COLOR_HEX, fenceLookBoxes } from '../world/base/buildingDetails';
import { defaultRoofHeight, openRing, orientedBox, roofFrame, roofTriangles, signedArea } from '../world/base/roofGeometry';
import { findHouseModel } from '../world/village/houseModels';
import { mirrorPartsX } from '../world/village/houseParts';
import {
  ROAD_KINDS,
  footprintCorners,
  modelPlacement,
  nearestOnLines,
  rotateHandle,
  wallHeightOf,
  type EditRoadKind,
  type EditedBuilding,
  type EditedFence,
  type Edits,
  type LonLat,
} from '../world/edit/edits';
import type { LocalFrame, Vec2 } from '../world/walk/localFrame';
import type { CityScene } from './CityScene';
import { toLocal2, toThree } from './coords';
import { createFacadeMaterial, createRoofMaterial } from './facadeShader';
import { buildHouseMesh, createHouseMaterials, type HouseMaterials, type HouseMesh } from './houseMesh';
import { MergedBuilder } from './merged';
import { MeshBuilder } from './meshBuilder';
import { hookMaterial } from './shaderHooks';
import { FOOTING_DEPTH, siteOnSlope } from '../world/base/siting';

const SELECTED = new Color('#f5a524');
const INVALID = new Color('#e5484d');
const CHIMNEY = new Color('#9b4a35');
const HIGHLIGHT = '#f5a524';
const FENCE_LINE = '#7a5a3e';
const ROOF_OVERHANG = 0.5;
/** Линии чуть над землёй, м (и сдвиг глубины) — чтобы не мерцали с рельефом. */
const LINE_LIFT = 0.25;
/** Шаг, с которым линия повторяет рельеф, м. */
const DRAPE_STEP = 3;
const LINE_ORDER = 15;
const HANDLE_ORDER = 20;
/** Ручку легче схватить: допуск вокруг кружка, px. */
const HANDLE_SLOP_PX = 4;

/** Кружок ручки: размер на экране (px, с обводкой), заливка, обводка и её толщина. */
interface HandleStyle {
  size: number;
  fill: string;
  outline: string;
  ring: number;
}
const CORNER_STYLE: HandleStyle = { size: 17, fill: '#ffffff', outline: '#1b1f27', ring: 2 };
const ROTATE_STYLE: HandleStyle = { size: 19, fill: '#f5a524', outline: '#ffffff', ring: 2 };

/** Докуда от угла дома (снаружи) тянется зона «повернуть», пикселей. */
const ROTATE_RING_PX = 38;
/** Курсор «повернуть»: круговая стрелка. */
const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26" fill="none" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M20.5 13a7.5 7.5 0 1 1-2.6-5.7M18.4 3.4v4.2h-4.2" stroke="#1b1f27" stroke-width="5"/>' +
    '<path d="M20.5 13a7.5 7.5 0 1 1-2.6-5.7M18.4 3.4v4.2h-4.2" stroke="#ffffff" stroke-width="2.2"/></svg>',
)}") 13 13, alias`;

/** Ручка выделенного дома: угол (растянуть) или поворот. */
export type Handle = { handle: 'corner'; index: number } | { handle: 'rotate' };

/** Собранные меши правок; у треугольников стен и крыш — номер дома в ids. */
interface Assembly {
  walls?: Mesh;
  roofs?: Mesh;
  chimneys?: Mesh;
  fences?: Mesh;
  ids: string[];
  wallOwners: number[];
  roofOwners: number[];
  /** Оси заборов (локальные метры) — по ним узнаём, в какой забор попал луч. */
  fenceLines: { id: string; line: Vec2[] }[];
  /** Дома-модели (у группы в userData.buildingId — чей дом) и рамки выделения вокруг них. */
  models: Group[];
  outlines: Line2[];
  /** Ключи кэша моделей, которые нужны этой сборке. */
  modelKeys: Set<string>;
}

/**
 * Правки в сцене: свои и изменённые дома, трубы, заборы, предпросмотр рисуемого, подсветка
 * выделения и ручки. Меши маленькие — пересобираем целиком.
 */
export class EditLayer {
  private readonly group = new Group();
  private readonly wallMaterial: MeshStandardMaterial;
  private readonly roofMaterial: MeshStandardMaterial;
  private readonly boxMaterial: MeshStandardMaterial;
  private readonly lineMaterial: LineMaterial;
  private readonly highlightMaterial: LineMaterial;
  private readonly invalidMaterial: LineMaterial;
  private readonly houseMaterials: HouseMaterials;
  /** Геометрия моделей по виду и размеру — перетаскивание и перерисовка не пересобирают дом. */
  private readonly modelCache = new Map<string, HouseMesh>();
  private readonly cornerPoints: Points;
  private readonly rotatePoints: Points;
  private main?: Assembly;
  private previewed?: Assembly;
  private line?: Line2;
  private highlights: Line2[] = [];
  private handleSpots: { handle: Handle; position: Vector3; size: number }[] = [];
  private readonly projected = new Vector3();

  constructor(
    private readonly city: CityScene,
    private readonly frame: LocalFrame,
    /** Высота земли в локальных метрах. */
    private readonly heightAt: (x: number, y: number) => number,
    private readonly village: boolean,
  ) {
    // Материалы общие на все пересборки: к каскадным теням подключаются один раз.
    this.wallMaterial = createFacadeMaterial(city.csm);
    this.roofMaterial = createRoofMaterial(city.csm);
    this.boxMaterial = new MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
    hookMaterial(this.boxMaterial, 'edit-boxes', undefined, city.csm);
    this.lineMaterial = lineMaterial(HIGHLIGHT, 5, 0.85);
    this.highlightMaterial = lineMaterial(HIGHLIGHT, 4, 1);
    this.invalidMaterial = lineMaterial('#e5484d', 4, 1);
    this.houseMaterials = createHouseMaterials(city.csm);
    this.cornerPoints = handlePoints(CORNER_STYLE);
    this.rotatePoints = handlePoints(ROTATE_STYLE);
    this.group.name = 'edits';
    this.group.add(this.cornerPoints, this.rotatePoints);
    city.scene.add(this.group);
  }

  /** Все правки: дома, трубы, заборы. hiddenId — дом, который сейчас тянут (рисуется в предпросмотре). */
  render(edits: Edits, selectedId?: string, hiddenId?: string): void {
    this.disposeAssembly(this.main);
    const items = edits.buildings
      .filter((b) => b.id !== hiddenId)
      .map((building) => ({ building, tint: building.id === selectedId ? SELECTED : undefined }));
    this.main = this.assemble('edit', items, edits.fences);
    this.sweepModels();
    this.city.requestRender();
  }

  /** Предпросмотр дома (растяжка, перетаскивание); invalid — красным: здесь ставить нельзя. */
  preview(building: EditedBuilding | undefined, invalid = false): void {
    this.disposeAssembly(this.previewed);
    this.previewed = building ? this.assemble('edit-preview', [{ building, tint: invalid ? INVALID : SELECTED }], []) : undefined;
    this.sweepModels();
    this.city.requestRender();
  }

  /** Линия, которую рисуют сейчас (дорога, забор); undefined — спрятать. */
  previewLine(points: LonLat[] | undefined, kind?: EditRoadKind | 'fence'): void {
    this.removeLine(this.line);
    this.line = undefined;
    if (kind) {
      // Ширина линии на экране — условная: настоящая ширина дороги видна после отпускания.
      this.lineMaterial.linewidth = kind === 'fence' ? 3 : Math.max(3, ROAD_KINDS[kind].width);
      this.lineMaterial.color.set(kind === 'fence' ? FENCE_LINE : HIGHLIGHT);
      this.lineMaterial.opacity = kind === 'fence' ? 1 : 0.75;
    }
    if (points && points.length >= 2) this.line = this.addLine(points, this.lineMaterial);
    this.city.requestRender();
  }

  /** Подсветка выделенной дороги или забора (линии по земле). */
  highlight(lines: LonLat[][]): void {
    for (const line of this.highlights) this.removeLine(line);
    this.highlights = lines.flatMap((line) => {
      const object = line.length >= 2 ? this.addLine(line, this.highlightMaterial) : undefined;
      return object ? [object] : [];
    });
    this.city.requestRender();
  }

  /** Ручки выделенного дома: углы — растянуть, кружок перед фасадом — повернуть. */
  setHandles(building: EditedBuilding | undefined, outline?: LonLat[]): void {
    this.handleSpots = [];
    const footprint = building?.footprint ?? outline;
    if (footprint && footprint.length >= 3) {
      const local = footprint.map(this.frame.toLocal);
      const ground = siteOnSlope(local, this.heightAt).floor;
      const top = ground + (building ? wallHeightOf(building, this.village) : 3) + 0.5;
      const corners = footprintCorners(local);
      corners.forEach(([x, y], index) => {
        this.handleSpots.push({ handle: { handle: 'corner', index }, position: toThree(x, y, top), size: CORNER_STYLE.size });
      });
      const [rx, ry] = rotateHandle(corners);
      this.handleSpots.push({ handle: { handle: 'rotate' }, position: toThree(rx, ry, top), size: ROTATE_STYLE.size });
    }
    setPoints(this.cornerPoints, this.handleSpots.filter((s) => s.handle.handle === 'corner').map((s) => s.position));
    setPoints(this.rotatePoints, this.handleSpots.filter((s) => s.handle.handle === 'rotate').map((s) => s.position));
    this.city.requestRender();
  }

  /** Ручки своего забора: по одной на каждом изломе. */
  setLineHandles(line: readonly LonLat[]): void {
    this.handleSpots = line.map((p, index) => {
      const [x, y] = this.frame.toLocal(p);
      return { handle: { handle: 'corner', index }, position: toThree(x, y, this.heightAt(x, y) + FENCE.street + 0.4), size: CORNER_STYLE.size };
    });
    setPoints(this.cornerPoints, this.handleSpots.map((s) => s.position));
    setPoints(this.rotatePoints, []);
    this.city.requestRender();
  }

  /** Объекты для луча выбора: свои дома (и предпросмотр) и свои заборы. */
  get pickables(): Object3D[] {
    return [
      this.main?.walls,
      this.main?.roofs,
      this.main?.fences,
      this.previewed?.walls,
      this.previewed?.roofs,
      ...(this.main?.models ?? []),
      ...(this.previewed?.models ?? []),
    ].filter((object): object is Mesh | Group => !!object);
  }

  /**
   * Что под курсором: ручка (по положению на экране — они рисуются поверх всего), свой дом или свой
   * забор (по попаданию луча intersection — ближайшему среди pickables и других слоёв).
   */
  hit(clientX: number, clientY: number, intersection?: Intersection): { handle?: Handle; building?: string; fence?: string } {
    const handle = this.handleAt(clientX, clientY);
    if (handle) return { handle };
    if (!intersection) return {};
    // Дом-модель: группа дома помнит, чей он.
    for (let object: Object3D | null = intersection.object; object; object = object.parent) {
      const id = object.userData['buildingId'] as string | undefined;
      if (id) return { building: id };
    }
    for (const assembly of [this.main, this.previewed]) {
      if (!assembly || intersection.faceIndex == null) continue;
      const owners =
        intersection.object === assembly.walls ? assembly.wallOwners : intersection.object === assembly.roofs ? assembly.roofOwners : undefined;
      const index = owners?.[intersection.faceIndex];
      const id = index === undefined ? undefined : assembly.ids[index];
      if (id) return { building: id };
    }
    if (this.main?.fences && intersection.object === this.main.fences) {
      // Луч попал в доску или столб — забор тот, чья ось ближе всего к точке попадания.
      const point = toLocal2(intersection.point);
      let best: { id: string; distance: number } | undefined;
      for (const { id, line } of this.main.fenceLines) {
        const distance = nearestOnLines(point, [line])?.distance ?? Number.POSITIVE_INFINITY;
        if (!best || distance < best.distance) best = { id, distance };
      }
      return best ? { fence: best.id } : {};
    }
    return {};
  }

  destroy(): void {
    this.disposeAssembly(this.main);
    this.disposeAssembly(this.previewed);
    this.main = undefined;
    this.previewed = undefined;
    this.removeLine(this.line);
    for (const line of this.highlights) this.removeLine(line);
    this.highlights = [];
    for (const points of [this.cornerPoints, this.rotatePoints]) {
      points.geometry.dispose();
      const material = points.material as PointsMaterial;
      material.map?.dispose();
      material.dispose();
    }
    for (const mesh of this.modelCache.values()) mesh.dispose();
    this.modelCache.clear();
    this.houseMaterials.dispose();
    for (const material of [this.wallMaterial, this.roofMaterial, this.boxMaterial, this.lineMaterial, this.highlightMaterial, this.invalidMaterial]) {
      material.dispose();
    }
    this.city.scene.remove(this.group);
    this.city.requestRender();
  }

  // --- сборка ------------------------------------------------------------------------------------

  private assemble(name: string, items: readonly { building: EditedBuilding; tint?: Color }[], fences: readonly EditedFence[]): Assembly {
    const walls = new MeshBuilder();
    const roofs = new MeshBuilder();
    const extras = new MergedBuilder();
    const fenceParts = new MergedBuilder();
    const models: Group[] = [];
    const outlines: Line2[] = [];
    const modelKeys = new Set<string>();
    items.forEach(({ building, tint }, index) => {
      if (building.model && building.footprint.length === 4) {
        const model = this.addModel(building, modelKeys);
        if (model) models.push(model);
        if (tint) {
          const outline = this.addLine([...building.footprint, building.footprint[0]!], tint === INVALID ? this.invalidMaterial : this.highlightMaterial);
          if (outline) outlines.push(outline);
        }
        return;
      }
      this.addBuilding(building, index, tint, walls, roofs, extras);
    });
    const fenceLines = fences.map((fence) => {
      const local = fence.line.map(this.frame.toLocal);
      this.addFence(fence, local, fenceParts);
      return { id: fence.id, line: local };
    });
    return {
      walls: walls.vertexCount ? this.addMesh(new Mesh(walls.geometry(), this.wallMaterial), `${name}-walls`) : undefined,
      roofs: roofs.vertexCount ? this.addMesh(new Mesh(roofs.geometry(), this.roofMaterial), `${name}-roofs`) : undefined,
      chimneys: this.boxes(extras, `${name}-chimneys`),
      fences: this.boxes(fenceParts, `${name}-fences`),
      ids: items.map(({ building }) => building.id),
      wallOwners: walls.owners,
      roofOwners: roofs.owners,
      fenceLines,
      models,
      outlines,
      modelKeys,
    };
  }

  /** Дом-модель: вписан в прямоугольник контура, фасад — по первой стороне, на самой низкой точке земли. */
  private addModel(b: EditedBuilding, keys: Set<string>): Group | undefined {
    const ref = b.model!;
    const model = findHouseModel(ref.id);
    if (!model) return undefined;
    const local = b.footprint.map(this.frame.toLocal);
    const place = modelPlacement(local);
    // Пол — по верхней точке склона; цоколь, крыльцо и ступени уходят вниз до нижней.
    const site = siteOnSlope(local, this.heightAt);
    const foundation = Math.round((site.floor - site.low + FOOTING_DEPTH) * 10) / 10;
    const key = `${ref.id}:${ref.seed}:${ref.mirror ? 'm' : ''}:${place.width.toFixed(2)}:${place.depth.toFixed(2)}:${foundation}`;
    let mesh = this.modelCache.get(key);
    if (!mesh) {
      const plan = model.plan({ seed: ref.seed, width: place.width, depth: place.depth, foundation });
      mesh = buildHouseMesh(ref.mirror ? { ...plan, parts: mirrorPartsX(plan.parts) } : plan, this.houseMaterials);
      this.modelCache.set(key, mesh);
    }
    keys.add(key);
    const group = mesh.group.clone();
    group.name = `edit-model:${b.id}`;
    group.userData['buildingId'] = b.id;
    group.position.copy(toThree(place.center[0], place.center[1], site.floor));
    group.rotation.y = place.angle;
    this.group.add(group);
    return group;
  }

  /** Убрать из кэша модели, которые не нужны ни правкам, ни предпросмотру. */
  private sweepModels(): void {
    const used = new Set([...(this.main?.modelKeys ?? []), ...(this.previewed?.modelKeys ?? [])]);
    for (const [key, mesh] of this.modelCache) {
      if (used.has(key)) continue;
      mesh.dispose();
      this.modelCache.delete(key);
    }
  }

  /** Дом из правки: стены с окнами и плоским верхом, скатная крыша со свесом, у жилого дома — труба. */
  private addBuilding(
    b: EditedBuilding,
    owner: number,
    tint: Color | undefined,
    walls: MeshBuilder,
    roofs: MeshBuilder,
    extras: MergedBuilder,
  ): void {
    const local = openRing(b.footprint.map(this.frame.toLocal));
    if (local.length < 3) return;
    const site = siteOnSlope(local, this.heightAt);
    const ground = site.floor;
    const wallTop = wallHeightOf(b, this.village);
    const seed = hashString(b.id);
    const grain = (seed % 10_000) / 10_000;
    const shade = (css: string) => {
      const color = new Color(css);
      return tint ? color.lerp(tint, 0.45) : color;
    };
    const floorHeight = b.kind === 'shed' ? 0 : wallTop / b.floors;
    const carved = this.village && b.kind === 'house';
    const variant = b.kind === 'apartments' && b.floors >= 9 ? 2 : seed % 2;
    const facade = [ground, 0, wallTop, floorHeight];
    const style = [carved ? 2 : b.kind === 'shop' ? 1 : 0, variant, grain, 0];
    const facadeColor = shade(b.facadeColor);
    const z0 = site.low - FOOTING_DEPTH;
    const z1 = ground + wallTop;

    // Стены: нормаль наружу при любом направлении обхода контура.
    const sign = signedArea(local) > 0 ? 1 : -1;
    for (let i = 0; i < local.length; i++) {
      const a = local[i]!;
      const c = local[(i + 1) % local.length]!;
      const dx = c[0] - a[0];
      const dy = c[1] - a[1];
      const length = Math.hypot(dx, dy);
      if (length < 0.01) continue;
      const outward = [(dy / length) * sign, (-dx / length) * sign, 0];
      walls.triangle([a[0], a[1], z0], [c[0], c[1], z0], [c[0], c[1], z1], outward, facadeColor, facade, style, owner);
      walls.triangle([a[0], a[1], z0], [c[0], c[1], z1], [a[0], a[1], z1], outward, facadeColor, facade, style, owner);
    }
    // Верх стен: плоская крыша (под скатной её не видно, но она закрывает коробку сверху).
    const contour = local.map(([x, y]) => new Vector2(x, y));
    for (const face of ShapeUtils.triangulateShape(contour, [])) {
      const [p, q, r] = face.map((i) => contour[i]!);
      walls.triangle([p!.x, p!.y, z1], [q!.x, q!.y, z1], [r!.x, r!.y, z1], [0, 0, 1], facadeColor, facade, style, owner);
    }

    if (b.roof === 'flat') return;
    const box = orientedBox(local);
    const height = defaultRoofHeight(b.roof, box, Math.abs(signedArea(local)));
    const triangles = roofTriangles(local, b.roof, height, 'along', ROOF_OVERHANG);
    if (!triangles) return;
    const roofColor = shade(b.roofColor);
    for (const [p, q, r] of triangles) {
      roofs.triangle([p[0], p[1], z1 + p[2]], [q[0], q[1], z1 + q[2]], [r[0], r[1], z1 + r[2]], undefined, roofColor, [ground, 0, 0, 0], [0, 0, grain, 1], owner);
    }
    const frame = roofFrame(local, b.roof, height);
    if (frame && b.kind === 'house') {
      for (const chimney of chimneys(frame, seed, true)) extras.addBox(chimney, z1, CHIMNEY, b.id);
    }
  }

  /** Забор по линии: доски кусками (каждый — на своей высоте земли) и столбы. */
  private addFence(fence: EditedFence, line: readonly Vec2[], builder: MergedBuilder): void {
    const id = fence.id;
    const kind = fence.kind ?? 'boards';
    const color = new Color(fence.color ?? FENCE_COLOR_HEX[hashString(id) % FENCE_COLOR_HEX.length]!);
    // У профнастила столбы — серая сталь, у остальных — то же дерево, темнее.
    const postColor = kind === 'profile' ? new Color('#6d7174') : color.clone().multiplyScalar(0.7);
    for (let i = 1; i < line.length; i++) {
      const { pieces, posts } = fenceLookBoxes(line[i - 1]!, line[i]!, kind);
      for (const box of pieces) builder.addBox(box, this.heightAt(box.center[0], box.center[1]), color, id);
      for (const box of posts) builder.addBox(box, this.heightAt(box.center[0], box.center[1]), postColor, id);
    }
  }

  private addMesh(mesh: Mesh, name: string): Mesh {
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    return mesh;
  }

  /** Ящики одной геометрией; материал — общий (у собранного свой, не подключённый к теням, выбрасываем). */
  private boxes(builder: MergedBuilder, name: string): Mesh | undefined {
    if (builder.empty) return undefined;
    const { mesh } = builder.build(name, undefined);
    (mesh.material as Material).dispose();
    mesh.material = this.boxMaterial;
    return this.addMesh(mesh, name);
  }

  private disposeAssembly(assembly: Assembly | undefined): void {
    if (!assembly) return;
    for (const mesh of [assembly.walls, assembly.roofs, assembly.chimneys, assembly.fences]) {
      if (!mesh) continue;
      this.group.remove(mesh);
      mesh.geometry.dispose();
    }
    // Геометрия моделей — в кэше (общая), здесь только убираем копии из сцены.
    for (const model of assembly.models) this.group.remove(model);
    for (const line of assembly.outlines) this.removeLine(line);
  }

  // --- линии и ручки ---------------------------------------------------------------------------

  private addLine(points: readonly LonLat[], material: LineMaterial): Line2 | undefined {
    const positions = this.drape(points.map(this.frame.toLocal));
    if (positions.length < 6) return undefined;
    const geometry = new LineGeometry();
    geometry.setPositions(positions);
    const line = new Line2(geometry, material);
    line.name = 'edit-line';
    line.renderOrder = LINE_ORDER;
    // Толщина линии задаётся в пикселях — материалу нужен размер кадра.
    line.onBeforeRender = (renderer) => {
      renderer.getSize(material.resolution);
    };
    this.group.add(line);
    return line;
  }

  private removeLine(line: Line2 | undefined): void {
    if (!line) return;
    this.group.remove(line);
    line.geometry.dispose();
  }

  /** Линия по рельефу (three.js, плоским массивом): промежуточные точки через DRAPE_STEP, чуть над землёй. */
  private drape(line: readonly Vec2[]): number[] {
    const out: number[] = [];
    const push = (x: number, y: number) => {
      out.push(x, this.heightAt(x, y) + LINE_LIFT, -y);
    };
    const first = line[0];
    if (first) push(first[0], first[1]);
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1]!;
      const b = line[i]!;
      const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / DRAPE_STEP));
      for (let k = 1; k <= steps; k++) push(a[0] + ((b[0] - a[0]) * k) / steps, a[1] + ((b[1] - a[1]) * k) / steps);
    }
    return out;
  }

  /** Ручка под курсором: ближайшая, чей кружок на экране накрывает точку. */
  private handleAt(clientX: number, clientY: number): Handle | undefined {
    return this.probe(clientX, clientY)?.handle;
  }

  /** Какой курсор показать над ручками выделенного дома: растянуть (на углу) или повернуть (чуть снаружи угла). */
  cursorAt(clientX: number, clientY: number): string | undefined {
    const found = this.probe(clientX, clientY);
    if (!found) return undefined;
    if (found.handle.handle === 'rotate') return ROTATE_CURSOR;
    return found.dx * found.dy > 0 ? 'nwse-resize' : 'nesw-resize';
  }

  /**
   * Ручка под курсором (по экрану). Прямо на углу — растянуть. Чуть снаружи угла (кольцо вокруг него,
   * со стороны от дома) — повернуть: так дом крутят за любой угол, не целясь в отдельную ручку.
   */
  private probe(clientX: number, clientY: number): { handle: Handle; dx: number; dy: number } | undefined {
    if (!this.handleSpots.length) return undefined;
    const rect = this.city.canvas.getBoundingClientRect();
    const spots: { handle: Handle; x: number; y: number; size: number }[] = [];
    for (const { handle, position, size } of this.handleSpots) {
      const p = this.projected.copy(position).project(this.city.camera);
      if (p.z < -1 || p.z > 1) continue; // за камерой или дальше дальней плоскости
      spots.push({ handle, size, x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height });
    }
    const corners = spots.filter((s) => s.handle.handle === 'corner');
    const cx = corners.reduce((sum, c) => sum + c.x, 0) / (corners.length || 1), cy = corners.reduce((sum, c) => sum + c.y, 0) / (corners.length || 1);
    let best: { handle: Handle; dx: number; dy: number } | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const spot of spots) {
      const distance = Math.hypot(spot.x - clientX, spot.y - clientY);
      if (distance <= spot.size / 2 + HANDLE_SLOP_PX && distance < bestDistance) {
        best = { handle: spot.handle, dx: spot.x - cx, dy: spot.y - cy };
        bestDistance = distance;
      }
    }
    if (best) return best;
    for (const corner of corners) {
      const distance = Math.hypot(corner.x - clientX, corner.y - clientY);
      // Снаружи: курсор дальше от середины дома, чем сам угол.
      const outside = Math.hypot(clientX - cx, clientY - cy) > Math.hypot(corner.x - cx, corner.y - cy);
      if (outside && distance <= ROTATE_RING_PX && distance < bestDistance) {
        best = { handle: { handle: 'rotate' }, dx: 0, dy: 0 };
        bestDistance = distance;
      }
    }
    return best;
  }
}

/** Материал линии толщиной в пикселях; поверх земли — с подъёмом и сдвигом глубины, но за домами прячется. */
function lineMaterial(color: string, width: number, opacity: number): LineMaterial {
  return new LineMaterial({
    color,
    linewidth: width,
    transparent: true,
    opacity,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -4,
  });
}

/** Ручки одного вида: кружки поверх всего, одного размера на экране. */
function handlePoints(style: HandleStyle): Points {
  const material = new PointsMaterial({
    size: style.size,
    sizeAttenuation: false,
    map: discTexture(style),
    transparent: true,
    alphaTest: 0.05,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    fog: false,
  });
  const points = new Points(new BufferGeometry(), material);
  points.name = 'edit-handles';
  points.renderOrder = HANDLE_ORDER;
  points.frustumCulled = false;
  points.visible = false;
  return points;
}

function setPoints(points: Points, positions: Vector3[]): void {
  points.geometry.dispose();
  points.geometry = new BufferGeometry().setFromPoints(positions);
  points.visible = positions.length > 0;
}

/** Кружок с обводкой для ручки. */
function discTexture({ size, fill, outline, ring }: HandleStyle): CanvasTexture {
  const px = 64;
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d')!;
  const r = px / 2 - 1;
  ctx.fillStyle = outline;
  ctx.beginPath();
  ctx.arc(px / 2, px / 2, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(px / 2, px / 2, r * (1 - (2 * ring) / size), 0, Math.PI * 2);
  ctx.fill();
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}
