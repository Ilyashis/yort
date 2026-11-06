import {
  Cartesian3,
  Color,
  ColorGeometryInstanceAttribute,
  ComponentDatatype,
  GeometryInstance,
  GeometryInstanceAttribute,
  PerInstanceColorAppearance,
  PolygonGeometry,
  PolygonHierarchy,
  Primitive,
  ShadowMode,
  type Scene,
  type TerrainProvider,
} from 'cesium';
import { createBuildingAppearance } from '../../cesium/buildingAppearance';
import { sampleMinHeights } from '../../cesium/terrainHeights';
import { hashString } from '../../utils/hash';
import type { BaseBuildingFeature, BaseBuildingProperties, BaseBuildingsCollection, Ring } from './types';

/** city — правдоподобные фасады; data — раскраска по источнику высоты (качество данных). */
export type BuildingColorMode = 'city' | 'data';

export const BUILDING_COLORS = {
  /** Высота известна из OSM (height или этажность). */
  known: '#ece6da',
  /** Высота — оценка по типу здания. */
  estimated: '#a8b8cc',
  selected: '#f5a524',
  /** Здание пересекается с участком пользователя. */
  conflict: '#ff6b6b',
} as const;

/** Типичные цвета фасадов центра: штукатурка, кирпич, светлый камень. */
const FACADE_PALETTE = [
  '#e9dcc3', '#f1e7d3', '#dcc6a6', '#e6d2b5', '#d5dadb',
  '#ece6da', '#d9b99f', '#c99f84', '#f3f0e9', '#e3d7c0',
].map((c) => Color.fromCssColorString(c));
const UTILITY_PALETTE = ['#b9bcbf', '#a9adb1', '#c4c2bd'].map((c) => Color.fromCssColorString(c));
const TEMPLE_COLOR = Color.fromCssColorString('#f4f2ec');

const UTILITY_TYPES = new Set(['garage', 'garages', 'shed', 'service', 'industrial', 'warehouse', 'transformer_tower', 'roof', 'construction']);
const TEMPLE_TYPES = new Set(['church', 'cathedral', 'chapel', 'mosque', 'synagogue', 'temple']);
/** Здания без окон на фасаде. */
const BLANK_TYPES = new Set(['garage', 'garages', 'shed', 'service', 'transformer_tower', 'roof', 'construction', 'hut']);

const LEVEL_HEIGHT = 3.2;

const known = Color.fromCssColorString(BUILDING_COLORS.known);
const estimated = Color.fromCssColorString(BUILDING_COLORS.estimated);
const selected = Color.fromCssColorString(BUILDING_COLORS.selected);
const conflict = Color.fromCssColorString(BUILDING_COLORS.conflict);

/**
 * Слой зданий Base World: все здания территории одним Primitive
 * (один draw call вместо тысяч Entity), с окнами, тенями, выбором и подсветкой.
 */
export class BaseBuildingsLayer {
  readonly primitive: Primitive;
  private readonly buildings = new Map<string, BaseBuildingProperties>();
  private readonly instanceIds = new Map<string, string[]>();
  private selectedId: string | undefined;
  private conflicts = new Set<string>();
  private colorMode: BuildingColorMode = 'city';

  private constructor(
    private readonly scene: Scene,
    collection: BaseBuildingsCollection,
    groundHeights: number[],
    center: Cartesian3,
  ) {
    const instances: GeometryInstance[] = [];

    collection.features.forEach((feature, featureIndex) => {
      const props = feature.properties;
      const ground = groundHeights[featureIndex] ?? 0;
      const ids: string[] = [];
      const facade = new GeometryInstanceAttribute({
        componentDatatype: ComponentDatatype.FLOAT,
        componentsPerAttribute: 4,
        value: [ground, props.minHeight, props.height, floorHeight(props)],
      });

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
            attributes: {
              color: ColorGeometryInstanceAttribute.fromColor(this.colorOf(props.id, props)),
              facade,
            },
          }),
        );
      });

      this.buildings.set(props.id, props);
      this.instanceIds.set(props.id, ids);
    });

    this.primitive = new Primitive({
      geometryInstances: instances,
      appearance: createBuildingAppearance(center),
      shadows: ShadowMode.ENABLED,
    });
  }

  /** Создаёт слой; при наличии рельефа ставит каждое здание на землю. */
  static async create(
    scene: Scene,
    collection: BaseBuildingsCollection,
    terrainProvider: TerrainProvider,
    center: Cartesian3,
  ): Promise<BaseBuildingsLayer> {
    const outlines = collection.features.map((f) => polygonsOf(f).flatMap(([outer]) => outer ?? []));
    const groundHeights = await sampleMinHeights(outlines, terrainProvider);
    return new BaseBuildingsLayer(scene, collection, groundHeights, center);
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

  /** Определяет здание по результату scene.pick(). */
  buildingFromPick(picked: unknown): BaseBuildingProperties | undefined {
    if (!picked || typeof picked !== 'object') return undefined;
    const { primitive, id } = picked as { primitive?: unknown; id?: unknown };
    if (primitive !== this.primitive || typeof id !== 'string') return undefined;
    return this.buildings.get(id.slice(0, id.lastIndexOf('#')));
  }

  select(buildingId: string | undefined): void {
    if (buildingId === this.selectedId) return;
    const previous = this.selectedId;
    this.selectedId = buildingId && this.buildings.has(buildingId) ? buildingId : undefined;
    if (previous) this.paint(previous);
    if (this.selectedId) this.paint(this.selectedId);
    this.scene.requestRender();
  }

  /** Подсвечивает здания, которые задевает участок пользователя. */
  setConflicts(buildingIds: readonly string[]): void {
    const previous = this.conflicts;
    this.conflicts = new Set(buildingIds);
    for (const id of previous) this.paint(id);
    for (const id of this.conflicts) this.paint(id);
    this.scene.requestRender();
  }

  setColorMode(mode: BuildingColorMode): void {
    if (mode === this.colorMode) return;
    this.colorMode = mode;
    for (const id of this.buildings.keys()) this.paint(id);
    this.scene.requestRender();
  }

  destroy(): void {
    if (!this.primitive.isDestroyed()) this.primitive.destroy();
  }

  /** Приоритет цвета: выбранное → конфликт с участком → цвет режима раскраски. */
  private colorOf(buildingId: string, props: BaseBuildingProperties): Color {
    if (buildingId === this.selectedId) return selected;
    if (this.conflicts.has(buildingId)) return conflict;
    if (this.colorMode === 'data') return props.heightSource === 'default' ? estimated : known;
    return facadeColor(props);
  }

  private paint(buildingId: string): void {
    const props = this.buildings.get(buildingId);
    if (!props || !this.primitive.ready) return;
    const value = this.colorOf(buildingId, props);
    for (const instanceId of this.instanceIds.get(buildingId) ?? []) {
      const attributes = this.primitive.getGeometryInstanceAttributes(instanceId);
      attributes.color = ColorGeometryInstanceAttribute.toValue(value, attributes.color);
    }
  }
}

/** Цвет фасада: стабильный для здания (по хешу id), с учётом типа. */
function facadeColor(props: BaseBuildingProperties): Color {
  if (TEMPLE_TYPES.has(props.building)) return TEMPLE_COLOR;
  const palette = UTILITY_TYPES.has(props.building) ? UTILITY_PALETTE : FACADE_PALETTE;
  return palette[hashString(props.id) % palette.length]!;
}

/** Высота этажа для рисования окон; 0 — без окон. */
function floorHeight(props: BaseBuildingProperties): number {
  if (BLANK_TYPES.has(props.building) || props.height < 3) return 0;
  if (!props.levels) return LEVEL_HEIGHT;
  return Math.min(Math.max((props.height - props.minHeight) / props.levels, 2.8), 4.5);
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
