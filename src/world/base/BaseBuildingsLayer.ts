import {
  Cartesian3,
  Cartographic,
  Color,
  ColorGeometryInstanceAttribute,
  EllipsoidTerrainProvider,
  GeometryInstance,
  PerInstanceColorAppearance,
  PolygonGeometry,
  PolygonHierarchy,
  Primitive,
  sampleTerrainMostDetailed,
  type Scene,
  type TerrainProvider,
} from 'cesium';
import type { BaseBuildingFeature, BaseBuildingProperties, BaseBuildingsCollection, Ring } from './types';

export const BUILDING_COLORS = {
  /** Высота известна из OSM (height или этажность). */
  known: '#ece6da',
  /** Высота — оценка по типу здания. */
  estimated: '#a8b8cc',
  selected: '#f5a524',
} as const;

const known = Color.fromCssColorString(BUILDING_COLORS.known);
const estimated = Color.fromCssColorString(BUILDING_COLORS.estimated);
const selected = Color.fromCssColorString(BUILDING_COLORS.selected);

/**
 * Слой зданий Base World: все здания территории одним Primitive
 * (один draw call вместо тысяч Entity), с выбором и подсветкой по клику.
 */
export class BaseBuildingsLayer {
  readonly primitive: Primitive;
  private readonly buildings = new Map<string, BaseBuildingProperties>();
  private readonly instanceIds = new Map<string, string[]>();
  private selectedId: string | undefined;

  private constructor(
    private readonly scene: Scene,
    collection: BaseBuildingsCollection,
    groundHeights: Map<string, number>,
  ) {
    const instances: GeometryInstance[] = [];

    for (const feature of collection.features) {
      const props = feature.properties;
      const ground = groundHeights.get(props.id) ?? 0;
      const ids: string[] = [];

      polygonsOf(feature).forEach((rings, index) => {
        const instanceId = `${props.id}#${index}`;
        ids.push(instanceId);
        instances.push(
          new GeometryInstance({
            id: instanceId,
            geometry: new PolygonGeometry({
              polygonHierarchy: toHierarchy(rings),
              height: ground + props.minHeight,
              extrudedHeight: ground + props.height,
              vertexFormat: PerInstanceColorAppearance.VERTEX_FORMAT,
            }),
            attributes: { color: ColorGeometryInstanceAttribute.fromColor(baseColor(props)) },
          }),
        );
      });

      this.buildings.set(props.id, props);
      this.instanceIds.set(props.id, ids);
    }

    this.primitive = new Primitive({
      geometryInstances: instances,
      appearance: new PerInstanceColorAppearance({ closed: true, translucent: false }),
    });
  }

  /**
   * Геометрия собирается в воркерах асинхронно; в requestRenderMode просим кадры,
   * пока примитив не будет готов, иначе здания появятся только после движения камеры.
   */
  renderUntilReady(): void {
    const removeListener = this.scene.postRender.addEventListener(() => {
      if (this.primitive.isDestroyed() || this.primitive.ready) removeListener();
      this.scene.requestRender();
    });
    this.scene.requestRender();
  }

  /** Создаёт слой; при наличии рельефа ставит каждое здание на землю. */
  static async create(
    scene: Scene,
    collection: BaseBuildingsCollection,
    terrainProvider: TerrainProvider,
  ): Promise<BaseBuildingsLayer> {
    const groundHeights = await sampleGroundHeights(collection.features, terrainProvider);
    return new BaseBuildingsLayer(scene, collection, groundHeights);
  }

  /** Определяет здание по результату scene.pick(). */
  buildingFromPick(picked: unknown): BaseBuildingProperties | undefined {
    if (!picked || typeof picked !== 'object') return undefined;
    const { primitive, id } = picked as { primitive?: unknown; id?: unknown };
    if (primitive !== this.primitive || typeof id !== 'string') return undefined;
    return this.buildings.get(id.slice(0, id.lastIndexOf('#')));
  }

  select(buildingId: string | undefined): void {
    if (buildingId === this.selectedId) return;
    if (this.selectedId) this.paint(this.selectedId, undefined);
    this.selectedId = buildingId && this.buildings.has(buildingId) ? buildingId : undefined;
    if (this.selectedId) this.paint(this.selectedId, selected);
    this.scene.requestRender();
  }

  destroy(): void {
    if (!this.primitive.isDestroyed()) this.primitive.destroy();
  }

  private paint(buildingId: string, color: Color | undefined): void {
    const props = this.buildings.get(buildingId);
    if (!props || !this.primitive.ready) return;
    const value = color ?? baseColor(props);
    for (const instanceId of this.instanceIds.get(buildingId) ?? []) {
      const attributes = this.primitive.getGeometryInstanceAttributes(instanceId);
      attributes.color = ColorGeometryInstanceAttribute.toValue(value, attributes.color);
    }
  }
}

function baseColor(props: BaseBuildingProperties): Color {
  return props.heightSource === 'default' ? estimated : known;
}

function polygonsOf(feature: BaseBuildingFeature): Ring[][] {
  return feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
}

/** GeoJSON-кольцо → позиции Cesium (без повторной замыкающей точки). */
function ringToPositions(ring: Ring): Cartesian3[] {
  const open = ring.length > 1 ? ring.slice(0, -1) : ring;
  return Cartesian3.fromDegreesArray(open.flat());
}

function toHierarchy([outer, ...holes]: Ring[]): PolygonHierarchy {
  return new PolygonHierarchy(
    ringToPositions(outer ?? []),
    holes.map((hole) => new PolygonHierarchy(ringToPositions(hole))),
  );
}

/**
 * Высота земли под каждым зданием = минимум по вершинам внешнего контура,
 * чтобы на склонах (а в центре Уфы они есть) здания не висели в воздухе.
 */
async function sampleGroundHeights(
  features: BaseBuildingFeature[],
  terrainProvider: TerrainProvider,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (terrainProvider instanceof EllipsoidTerrainProvider) return result;

  const owners: string[] = [];
  const points: Cartographic[] = [];
  for (const feature of features) {
    for (const [outer] of polygonsOf(feature)) {
      for (const [lon, lat] of outer ?? []) {
        owners.push(feature.properties.id);
        points.push(Cartographic.fromDegrees(lon, lat));
      }
    }
  }

  try {
    await sampleTerrainMostDetailed(terrainProvider, points);
  } catch (error) {
    console.warn('[terrain] не удалось получить высоты рельефа, здания стоят на нуле', error);
    return result;
  }

  points.forEach((point, i) => {
    const id = owners[i]!;
    const current = result.get(id);
    if (current === undefined || point.height < current) result.set(id, point.height);
  });
  return result;
}
