// Правки редактора в сцене three.js: свои и изменённые дома (тем же шейдером фасадов с окнами, что и
// город), трубы, заборы, предпросмотр того, что сейчас тянут или рисуют, подсветка выделенной дороги
// или забора и ручки выделенного дома. Геометрия маленькая — при каждой правке пересобираем целиком.
//
// Открытый интерфейс:
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
import { chimneys, FENCE, FENCE_COLOR_HEX, fenceBoxes } from '../world/base/buildingDetails';
import { defaultRoofHeight, openRing, orientedBox, roofFrame, roofTriangles, signedArea } from '../world/base/roofGeometry';
import {
  ROAD_KINDS,
  footprintCorners,
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
import { MergedBuilder } from './merged';
import { MeshBuilder } from './meshBuilder';
import { hookMaterial } from './shaderHooks';

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
    this.city.requestRender();
  }

  /** Предпросмотр дома (растяжка, перетаскивание); invalid — красным: здесь ставить нельзя. */
  preview(building: EditedBuilding | undefined, invalid = false): void {
    this.disposeAssembly(this.previewed);
    this.previewed = building ? this.assemble('edit-preview', [{ building, tint: invalid ? INVALID : SELECTED }], []) : undefined;
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
      const ground = Math.min(...local.map(([x, y]) => this.heightAt(x, y)));
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

  /** Объекты для луча выбора: свои дома (и предпросмотр) и свои заборы. */
  get pickables(): Object3D[] {
    return [this.main?.walls, this.main?.roofs, this.main?.fences, this.previewed?.walls, this.previewed?.roofs].filter(
      (object): object is Mesh => !!object,
    );
  }

  /**
   * Что под курсором: ручка (по положению на экране — они рисуются поверх всего), свой дом или свой
   * забор (по попаданию луча intersection — ближайшему среди pickables и других слоёв).
   */
  hit(clientX: number, clientY: number, intersection?: Intersection): { handle?: Handle; building?: string; fence?: string } {
    const handle = this.handleAt(clientX, clientY);
    if (handle) return { handle };
    if (!intersection) return {};
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
    for (const material of [this.wallMaterial, this.roofMaterial, this.boxMaterial, this.lineMaterial, this.highlightMaterial]) material.dispose();
    this.city.scene.remove(this.group);
    this.city.requestRender();
  }

  // --- сборка ------------------------------------------------------------------------------------

  private assemble(name: string, items: readonly { building: EditedBuilding; tint?: Color }[], fences: readonly EditedFence[]): Assembly {
    const walls = new MeshBuilder();
    const roofs = new MeshBuilder();
    const extras = new MergedBuilder();
    const fenceParts = new MergedBuilder();
    items.forEach(({ building, tint }, index) => this.addBuilding(building, index, tint, walls, roofs, extras));
    const fenceLines = fences.map(({ id, line }) => {
      const local = line.map(this.frame.toLocal);
      this.addFence(id, local, fenceParts);
      return { id, line: local };
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
    };
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
    const ground = Math.min(...local.map(([x, y]) => this.heightAt(x, y)));
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
    const z0 = ground;
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
  private addFence(id: string, line: readonly Vec2[], builder: MergedBuilder): void {
    const color = new Color(FENCE_COLOR_HEX[hashString(id) % FENCE_COLOR_HEX.length]!);
    const postColor = color.clone().multiplyScalar(0.7);
    for (let i = 1; i < line.length; i++) {
      const { pieces, posts } = fenceBoxes(line[i - 1]!, line[i]!, FENCE.street, true);
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
    if (!this.handleSpots.length) return undefined;
    const rect = this.city.canvas.getBoundingClientRect();
    let best: Handle | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const { handle, position, size } of this.handleSpots) {
      const p = this.projected.copy(position).project(this.city.camera);
      if (p.z < -1 || p.z > 1) continue; // за камерой или дальше дальней плоскости
      const x = rect.left + ((p.x + 1) / 2) * rect.width;
      const y = rect.top + ((1 - p.y) / 2) * rect.height;
      const distance = Math.hypot(x - clientX, y - clientY);
      if (distance <= size / 2 + HANDLE_SLOP_PX && distance < bestDistance) {
        best = handle;
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
