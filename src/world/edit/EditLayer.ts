import {
  BoxGeometry,
  CallbackProperty,
  Cartesian3,
  Color,
  ColorGeometryInstanceAttribute,
  ComponentDatatype,
  GeometryInstance,
  GeometryInstanceAttribute,
  Matrix3,
  Matrix4,
  PerInstanceColorAppearance,
  PointPrimitiveCollection,
  PolygonGeometry,
  PolygonHierarchy,
  Primitive,
  ShadowMode,
  Transforms,
  type Entity,
  type Viewer,
} from 'cesium';
import { createBuildingAppearance } from '../../cesium/buildingAppearance';
import { meshFromTriangles } from '../../cesium/meshGeometry';
import { hashString } from '../../utils/hash';
import { FENCE_COLORS } from '../base/BuildingDetailsLayer';
import { FENCE, chimneys, fenceBoxes, type DetailBox } from '../base/buildingDetails';
import { defaultRoofHeight, openRing, orientedBox, roofFrame, roofTriangles, signedArea } from '../base/roofGeometry';
import type { LocalFrame, Vec2 } from '../walk/localFrame';
import {
  EDIT_FLOOR_HEIGHT,
  ROAD_KINDS,
  SHED_WALL_HEIGHT,
  footprintCorners,
  type EditRoadKind,
  type EditedBuilding,
  type Edits,
  type LonLat,
} from './edits';

const VERTEX_FORMAT = PerInstanceColorAppearance.VERTEX_FORMAT;
const SELECTED = Color.fromCssColorString('#f5a524');
const INVALID = Color.fromCssColorString('#e5484d');
const CHIMNEY = Color.fromCssColorString('#9b4a35');
const HIGHLIGHT = Color.fromCssColorString('#f5a524');
const BUILDING_PREFIX = 'edit/';
const FENCE_PREFIX = 'editfence/';
const ROOF_OVERHANG = 0.5;

/** Ручка выделенного дома: угол (растянуть) или поворот. */
export type Handle = { handle: 'corner'; index: number } | { handle: 'rotate' };

/** Высота стен дома из правки, м. */
export function wallHeightOf(b: EditedBuilding, village: boolean): number {
  if (b.kind === 'shed') return SHED_WALL_HEIGHT;
  const extra = b.kind === 'shop' ? 0.6 : village && b.kind === 'house' ? 0.4 : 0;
  return b.floors * EDIT_FLOOR_HEIGHT + extra;
}

/**
 * Правки в сцене: свои и изменённые дома (тем же шейдером фасадов, что и город), трубы, заборы,
 * предпросмотр рисуемого, подсветка выделения и ручки. Примитивы маленькие — пересобираем целиком.
 */
export class EditLayer {
  private buildings?: Primitive;
  private extras?: Primitive;
  private previewBuildings?: Primitive;
  private previewExtras?: Primitive;
  private readonly handles = new PointPrimitiveCollection();
  private readonly lineEntity: Entity;
  private linePoints: Cartesian3[] = [];
  private highlights: Entity[] = [];
  private readonly boxes = new Map<string, BoxGeometry>();

  constructor(
    private readonly viewer: Viewer,
    private readonly frame: LocalFrame,
    private readonly center: Cartesian3,
    private readonly heightAt: (lon: number, lat: number) => number,
    private readonly village: boolean,
  ) {
    viewer.scene.primitives.add(this.handles);
    this.lineEntity = viewer.entities.add({
      show: false,
      polyline: {
        positions: new CallbackProperty(() => this.linePoints, false),
        clampToGround: true,
        width: 5,
        material: HIGHLIGHT.withAlpha(0.85),
      },
    });
  }

  /** Все правки: дома, трубы, заборы. hiddenId — дом, который сейчас тянут (рисуется в предпросмотре). */
  render(edits: Edits, selectedId?: string, hiddenId?: string): void {
    this.remove(this.buildings);
    this.remove(this.extras);
    const buildings = edits.buildings.filter((b) => b.id !== hiddenId);
    const walls: GeometryInstance[] = [];
    const extras: GeometryInstance[] = [];
    for (const b of buildings) this.addBuilding(b, walls, extras, b.id === selectedId ? SELECTED : undefined);
    for (const fence of edits.fences) this.addFence(fence.id, fence.line, extras);
    this.buildings = this.primitive(walls, true);
    this.extras = this.primitive(extras, false);
    this.viewer.scene.requestRender();
  }

  /** Предпросмотр дома (растяжка, перетаскивание); invalid — красным: здесь ставить нельзя. */
  preview(building: EditedBuilding | undefined, invalid = false): void {
    this.remove(this.previewBuildings);
    this.remove(this.previewExtras);
    this.previewBuildings = undefined;
    this.previewExtras = undefined;
    if (building) {
      const walls: GeometryInstance[] = [];
      const extras: GeometryInstance[] = [];
      this.addBuilding(building, walls, extras, invalid ? INVALID : SELECTED);
      this.previewBuildings = this.primitive(walls, true);
      this.previewExtras = this.primitive(extras, false);
    }
    this.viewer.scene.requestRender();
  }

  /** Линия, которую рисуют сейчас (дорога, забор); undefined — спрятать. */
  previewLine(points: LonLat[] | undefined, kind?: EditRoadKind | 'fence'): void {
    const polyline = this.lineEntity.polyline!;
    this.lineEntity.show = !!points && points.length >= 2;
    this.linePoints = (points ?? []).map(([lon, lat]) => Cartesian3.fromDegrees(lon, lat));
    if (kind) {
      // Ширина линии на экране — условная: настоящая ширина дороги видна после отпускания.
      const width = kind === 'fence' ? 3 : Math.max(3, ROAD_KINDS[kind].width);
      polyline.width = width as never;
      polyline.material = (kind === 'fence' ? Color.fromCssColorString('#7a5a3e') : HIGHLIGHT.withAlpha(0.75)) as never;
    }
    this.viewer.scene.requestRender();
  }

  /** Подсветка выделенной дороги или забора (линии по земле). */
  highlight(lines: LonLat[][]): void {
    for (const entity of this.highlights) this.viewer.entities.remove(entity);
    this.highlights = lines
      .filter((line) => line.length >= 2)
      .map((line) =>
        this.viewer.entities.add({
          polyline: {
            positions: Cartesian3.fromDegreesArray(line.flat()),
            clampToGround: true,
            width: 4,
            material: HIGHLIGHT,
          },
        }),
      );
    this.viewer.scene.requestRender();
  }

  /** Ручки выделенного дома: углы — растянуть, кружок перед фасадом — повернуть. */
  setHandles(building: EditedBuilding | undefined, outline?: LonLat[]): void {
    this.handles.removeAll();
    const footprint = building?.footprint ?? outline;
    if (footprint && footprint.length >= 3) {
      const local = footprint.map(this.frame.toLocal);
      const ground = Math.min(...footprint.map(([lon, lat]) => this.heightAt(lon, lat)));
      const top = ground + (building ? wallHeightOf(building, this.village) : 3) + 0.5;
      const corners = footprintCorners(local);
      corners.forEach((corner, index) => {
        this.handles.add({
          id: { handle: 'corner', index } satisfies Handle,
          position: Cartesian3.fromDegrees(...this.frame.toLonLat(corner), top),
          pixelSize: 13,
          color: Color.WHITE,
          outlineColor: Color.fromCssColorString('#1b1f27'),
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        });
      });
      this.handles.add({
        id: { handle: 'rotate' } satisfies Handle,
        position: Cartesian3.fromDegrees(...this.frame.toLonLat(rotateHandle(corners)), top),
        pixelSize: 15,
        color: SELECTED,
        outlineColor: Color.WHITE,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
    }
    this.viewer.scene.requestRender();
  }

  /** Что под курсором: ручка, свой дом или свой забор. */
  hit(picked: unknown): { handle?: Handle; building?: string; fence?: string } {
    if (!picked || typeof picked !== 'object') return {};
    const { primitive, id } = picked as { primitive?: unknown; id?: unknown };
    if (id && typeof id === 'object' && 'handle' in id) return { handle: id as Handle };
    if (typeof id !== 'string') return {};
    if (primitive === this.buildings || primitive === this.previewBuildings) {
      if (id.startsWith(BUILDING_PREFIX)) return { building: id.slice(BUILDING_PREFIX.length, id.lastIndexOf('#')) };
    }
    if (primitive === this.extras && id.startsWith(FENCE_PREFIX)) {
      return { fence: id.slice(FENCE_PREFIX.length, id.lastIndexOf('#')) };
    }
    return {};
  }

  destroy(): void {
    for (const p of [this.buildings, this.extras, this.previewBuildings, this.previewExtras]) this.remove(p);
    if (!this.viewer.isDestroyed()) {
      this.viewer.scene.primitives.remove(this.handles);
      this.viewer.entities.remove(this.lineEntity);
      for (const entity of this.highlights) this.viewer.entities.remove(entity);
    }
  }

  private addBuilding(b: EditedBuilding, walls: GeometryInstance[], extras: GeometryInstance[], tint?: Color): void {
    if (b.footprint.length < 3) return;
    const local = openRing(b.footprint.map(this.frame.toLocal));
    const ground = Math.min(...b.footprint.map(([lon, lat]) => this.heightAt(lon, lat)));
    const wallTop = wallHeightOf(b, this.village);
    const seed = hashString(b.id);
    const shade = (css: string) => {
      const color = Color.fromCssColorString(css);
      return tint ? Color.lerp(color, tint, 0.45, new Color()) : color;
    };
    const floorHeight = b.kind === 'shed' ? 0 : wallTop / b.floors;
    const carved = this.village && b.kind === 'house';
    const variant = b.kind === 'apartments' && b.floors >= 9 ? 2 : seed % 2;
    const facade = (top: number, floor: number) =>
      new GeometryInstanceAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 4, value: [ground, 0, top, floor] });
    const style = (values: number[]) =>
      new GeometryInstanceAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 4, value: values });

    walls.push(
      new GeometryInstance({
        id: `${BUILDING_PREFIX}${b.id}#w`,
        geometry: new PolygonGeometry({
          polygonHierarchy: new PolygonHierarchy(Cartesian3.fromDegreesArray(b.footprint.flat())),
          height: ground,
          extrudedHeight: ground + wallTop,
          vertexFormat: VERTEX_FORMAT,
        }),
        attributes: {
          color: ColorGeometryInstanceAttribute.fromColor(shade(b.facadeColor)),
          facade: facade(wallTop, floorHeight),
          facadeStyle: style([carved ? 2 : b.kind === 'shop' ? 1 : 0, variant, (seed % 10_000) / 10_000, 0]),
        },
      }),
    );

    if (b.roof === 'flat') return;
    const box = orientedBox(local);
    const height = defaultRoofHeight(b.roof, box, Math.abs(signedArea(local)));
    const triangles = roofTriangles(local, b.roof, height, 'along', ROOF_OVERHANG);
    if (!triangles) return;
    const base = ground + wallTop;
    walls.push(
      new GeometryInstance({
        id: `${BUILDING_PREFIX}${b.id}#r`,
        geometry: meshFromTriangles(
          triangles.map(
            (t) => t.map(([x, y, z]) => Cartesian3.fromDegrees(...this.frame.toLonLat([x, y]), base + z)) as [Cartesian3, Cartesian3, Cartesian3],
          ),
        ),
        attributes: {
          color: ColorGeometryInstanceAttribute.fromColor(shade(b.roofColor)),
          facade: facade(0, 0),
          facadeStyle: style([0, 0, (seed % 10_000) / 10_000, 1]),
        },
      }),
    );
    const frame = roofFrame(local, b.roof, height);
    if (frame && b.kind === 'house') {
      for (const chimney of chimneys(frame, seed, true)) extras.push(this.box(`${BUILDING_PREFIX}${b.id}#c`, chimney, base, CHIMNEY));
    }
  }

  private addFence(id: string, line: LonLat[], extras: GeometryInstance[]): void {
    const color = FENCE_COLORS[hashString(id) % FENCE_COLORS.length]!;
    const postColor = Color.multiplyByScalar(color, 0.7, new Color());
    const local = line.map(this.frame.toLocal);
    let n = 0;
    for (let i = 1; i < local.length; i++) {
      const { pieces, posts } = fenceBoxes(local[i - 1]!, local[i]!, FENCE.street, true);
      for (const box of pieces) extras.push(this.box(`${FENCE_PREFIX}${id}#${n++}`, box, this.groundOf(box), color));
      for (const box of posts) extras.push(this.box(`${FENCE_PREFIX}${id}#${n++}`, box, this.groundOf(box), postColor));
    }
  }

  private groundOf(box: DetailBox): number {
    return this.heightAt(...this.frame.toLonLat([box.center[0], box.center[1]]));
  }

  private box(id: string, box: DetailBox, base: number, color: Color): GeometryInstance {
    const [w, d, h] = box.size;
    const key = `${w.toFixed(2)}|${d.toFixed(2)}|${h.toFixed(2)}`;
    let geometry = this.boxes.get(key);
    if (!geometry) {
      geometry = BoxGeometry.fromDimensions({ dimensions: new Cartesian3(w, d, h), vertexFormat: VERTEX_FORMAT });
      this.boxes.set(key, geometry);
    }
    const [x, y, z] = box.center;
    const enu = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(...this.frame.toLonLat([x, y]), base + z));
    return new GeometryInstance({
      id,
      geometry,
      modelMatrix: Matrix4.multiply(enu, Matrix4.fromRotation(Matrix3.fromRotationZ(box.angle)), new Matrix4()),
      attributes: { color: ColorGeometryInstanceAttribute.fromColor(color) },
    });
  }

  private primitive(instances: GeometryInstance[], facades: boolean): Primitive | undefined {
    if (!instances.length) return undefined;
    const primitive = new Primitive({
      geometryInstances: instances,
      appearance: facades ? createBuildingAppearance(this.center) : new PerInstanceColorAppearance({ closed: true, translucent: false }),
      shadows: ShadowMode.ENABLED,
      // Крыша — готовая Geometry: собираем синхронно (и правка видна сразу).
      asynchronous: false,
      compressVertices: false,
    });
    this.viewer.scene.primitives.add(primitive);
    return primitive;
  }

  private remove(primitive: Primitive | undefined): void {
    if (!primitive) return;
    if (!this.viewer.isDestroyed() && this.viewer.scene.primitives.contains(primitive)) this.viewer.scene.primitives.remove(primitive);
    else if (!primitive.isDestroyed()) primitive.destroy();
  }
}

/** Ручка поворота: перед серединой первой стороны прямоугольника, на 2,5 м наружу. */
export function rotateHandle(corners: readonly Vec2[]): Vec2 {
  const [a, b] = corners as [Vec2, Vec2];
  const c: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const center: Vec2 = [corners.reduce((s, p) => s + p[0], 0) / corners.length, corners.reduce((s, p) => s + p[1], 0) / corners.length];
  const out: Vec2 = [c[0] - center[0], c[1] - center[1]];
  const length = Math.hypot(out[0], out[1]) || 1;
  return [c[0] + (out[0] / length) * 2.5, c[1] + (out[1] / length) * 2.5];
}
