import {
  BoundingSphere,
  Cartesian3,
  Color,
  ColorGeometryInstanceAttribute,
  ComponentDatatype,
  Geometry,
  GeometryAttribute,
  GeometryAttributes,
  GeometryInstance,
  GeometryInstanceAttribute,
  PerInstanceColorAppearance,
  PolygonGeometry,
  PolygonHierarchy,
  Primitive,
  PrimitiveType,
  ShadowMode,
  type Scene,
} from 'cesium';
import { createBuildingAppearance } from '../../cesium/buildingAppearance';
import { hashString } from '../../utils/hash';
import type { BaseBuildingFeature, BaseBuildingProperties } from '../base/types';
import type { BuildingSpec, GeneratedBuilding } from './building';
import { BUILDING_TYPES } from './building';
import type { LonLat } from './plot';

/** Здание пользователя: спецификация + сгенерированная геометрия. */
export interface UserBuilding {
  id: string;
  spec: BuildingSpec;
  building: GeneratedBuilding;
}

const ID_PREFIX = 'user/';

/**
 * Здания User World в сцене: размещённые и предпросмотр из конструктора.
 * Тот же шейдер фасадов, что у города, — новые дома выглядят «своими».
 * Геометрия маленькая, поэтому пересобираем примитив целиком при каждом изменении.
 */
export class UserBuildingsLayer {
  private primitive: Primitive | undefined;

  constructor(
    private readonly scene: Scene,
    private readonly center: Cartesian3,
    /** Высота земли (рельеф) в точке. */
    private readonly heightAt: (lon: number, lat: number) => number = () => 0,
  ) {}

  render(placed: readonly UserBuilding[], preview?: UserBuilding): void {
    this.clear();
    const items = preview ? [...placed, preview] : placed;
    if (!items.length) return;

    const instances = items.flatMap((item) => this.instancesFor(item));
    this.primitive = new Primitive({
      geometryInstances: instances,
      appearance: createBuildingAppearance(this.center),
      shadows: ShadowMode.ENABLED,
      // Крыша — готовая Geometry, а не описание: собираем синхронно.
      asynchronous: false,
    });
    this.scene.primitives.add(this.primitive);
    this.scene.requestRender();
  }

  /** id здания пользователя по результату scene.pick(), иначе undefined. */
  idFromPick(picked: unknown): string | undefined {
    if (!picked || typeof picked !== 'object') return undefined;
    const { primitive, id } = picked as { primitive?: unknown; id?: unknown };
    if (!this.primitive || primitive !== this.primitive || typeof id !== 'string') return undefined;
    return id.slice(0, id.lastIndexOf('#'));
  }

  destroy(): void {
    this.clear();
  }

  private clear(): void {
    if (this.primitive) {
      // remove() по умолчанию уничтожает примитив.
      if (!this.scene.isDestroyed() && this.scene.primitives.contains(this.primitive)) {
        this.scene.primitives.remove(this.primitive);
      } else if (!this.primitive.isDestroyed()) {
        this.primitive.destroy();
      }
      this.primitive = undefined;
      if (!this.scene.isDestroyed()) this.scene.requestRender();
    }
  }

  private instancesFor({ id, spec, building }: UserBuilding): GeometryInstance[] {
    const ground = groundHeight(this.heightAt, building.footprint);
    const attributes = () => ({
      color: ColorGeometryInstanceAttribute.fromColor(Color.fromCssColorString(spec.facadeColor)),
      facade: new GeometryInstanceAttribute({
        componentDatatype: ComponentDatatype.FLOAT,
        componentsPerAttribute: 4,
        value: [ground, 0, building.wallHeight, building.floorHeight],
      }),
      facadeStyle: new GeometryInstanceAttribute({
        componentDatatype: ComponentDatatype.FLOAT,
        componentsPerAttribute: 4,
        value: [spec.shops ? 1 : 0, building.windowVariant, (hashString(id) % 10_000) / 10_000, 0],
      }),
    });

    const instances = [
      new GeometryInstance({
        id: `${ID_PREFIX}${id}#walls`,
        geometry: new PolygonGeometry({
          polygonHierarchy: new PolygonHierarchy(Cartesian3.fromDegreesArray(building.footprint.flat())),
          height: ground,
          extrudedHeight: ground + building.wallHeight,
          vertexFormat: PerInstanceColorAppearance.VERTEX_FORMAT,
        }),
        attributes: attributes(),
      }),
    ];
    if (building.roof === 'pitched') {
      instances.push(
        new GeometryInstance({
          id: `${ID_PREFIX}${id}#roof`,
          geometry: hipRoof(building.footprint, ground + building.wallHeight, building.ridgeHeight),
          attributes: attributes(),
        }),
      );
    }
    return instances;
  }
}

/** Земля под зданием: минимум по вершинам, чтобы на склоне дом не висел в воздухе. */
function groundHeight(heightAt: (lon: number, lat: number) => number, footprint: readonly LonLat[]): number {
  const heights = footprint.map(([lon, lat]) => heightAt(lon, lat)).filter(Number.isFinite);
  return heights.length ? Math.min(...heights) : 0;
}

/**
 * Шатровая (вальмовая) крыша для выпуклого контура: треугольник от каждой стороны к коньку
 * над центром. Нормали — по граням, чтобы скаты по-разному освещались солнцем.
 */
function hipRoof(footprint: readonly LonLat[], eaveHeight: number, ridgeHeight: number): Geometry {
  const n = footprint.length;
  const [cLon, cLat] = footprint.reduce(([x, y], [lon, lat]) => [x + lon / n, y + lat / n], [0, 0]);
  const apex = Cartesian3.fromDegrees(cLon, cLat, eaveHeight + ridgeHeight);
  const eaves = footprint.map(([lon, lat]) => Cartesian3.fromDegrees(lon, lat, eaveHeight));
  const up = Cartesian3.normalize(apex, new Cartesian3());

  const positions: number[] = [];
  const normals: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = eaves[i]!;
    const b = eaves[(i + 1) % n]!;
    let normal = Cartesian3.normalize(
      Cartesian3.cross(Cartesian3.subtract(b, a, new Cartesian3()), Cartesian3.subtract(apex, a, new Cartesian3()), new Cartesian3()),
      new Cartesian3(),
    );
    // Контур мог быть задан по часовой — разворачиваем грань наружу (вверх).
    const [p, q] = Cartesian3.dot(normal, up) < 0 ? [b, a] : [a, b];
    if (p !== a) normal = Cartesian3.negate(normal, new Cartesian3());
    for (const v of [p, q, apex]) {
      positions.push(v.x, v.y, v.z);
      normals.push(normal.x, normal.y, normal.z);
    }
  }

  const values = new Float64Array(positions);
  // В типах конструктор GeometryAttributes без аргументов — заполняем поля после создания.
  const attributes = new GeometryAttributes();
  attributes.position = new GeometryAttribute({ componentDatatype: ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values });
  attributes.normal = new GeometryAttribute({
    componentDatatype: ComponentDatatype.FLOAT,
    componentsPerAttribute: 3,
    values: new Float32Array(normals),
  });
  return new Geometry({
    attributes,
    indices: new Uint16Array(Array.from({ length: n * 3 }, (_, i) => i)),
    primitiveType: PrimitiveType.TRIANGLES,
    boundingSphere: BoundingSphere.fromVertices(Array.from(values)),
  });
}

export const isUserBuildingId = (id: string) => id.startsWith(ID_PREFIX);
export const userBuildingId = (id: string) => `${ID_PREFIX}${id}`;

/** Здание пользователя как препятствие для пешехода и новых участков. */
export function toObstacle({ id, spec, building }: UserBuilding): BaseBuildingFeature {
  const ring = [...building.footprint, building.footprint[0]!];
  return {
    type: 'Feature',
    id: userBuildingId(id),
    properties: toProperties({ id, spec, building }),
    geometry: { type: 'Polygon', coordinates: [ring] },
  };
}

/** Свойства для карточки здания. */
export function toProperties({ id, spec, building }: UserBuilding): BaseBuildingProperties {
  return {
    id: userBuildingId(id),
    building: spec.type,
    name: `Ваш проект · ${BUILDING_TYPES[spec.type].label}`,
    levels: spec.floors,
    height: Math.round(building.totalHeight * 10) / 10,
    minHeight: 0,
    heightSource: 'height',
  };
}
