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
import { meshFromTriangles } from '../../cesium/meshGeometry';
import { sampleMinHeights } from '../../cesium/terrainHeights';
import { hashString } from '../../utils/hash';
import type { LonLat } from '../user/plot';
import type { LocalFrame, Vec2 } from '../walk/localFrame';
import { facadeStyle, type FacadeStyle } from './facades';
import type { PartsAssignment } from './parts';
import {
  defaultRoofHeight,
  openRing,
  orientedBox,
  rectangularity,
  roofTriangles,
  signedArea,
  type RoofShape,
} from './roofGeometry';
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

const palette = (colors: string[]) => colors.map((c) => Color.fromCssColorString(c));

/** Типичные цвета фасадов центра: штукатурка, светлый камень. */
const FACADE_PALETTE = palette(['#e9dcc3', '#f1e7d3', '#dcc6a6', '#e6d2b5', '#d5dadb', '#ece6da', '#d9b99f', '#c99f84', '#f3f0e9', '#e3d7c0']);
const UTILITY_PALETTE = palette(['#b9bcbf', '#a9adb1', '#c4c2bd']);
const TEMPLE_COLOR = Color.fromCssColorString('#f4f2ec');
/** Цвета по материалу стен (building:material). */
const MATERIAL_PALETTES: Record<string, Color[]> = {
  brick: palette(['#a9563d', '#b5654a', '#9c4f3a', '#c27b5f', '#a45f48']),
  concrete: palette(['#bfc2c2', '#cfd1cf', '#b4b7b8']),
  reinforced_concrete: palette(['#bfc2c2', '#cfd1cf', '#b4b7b8']),
  panel: palette(['#d4d6d3', '#c7cbcc', '#dcdad2']),
  stone: palette(['#e3dccb', '#d8cfbb', '#cfc6b1']),
  limestone: palette(['#e8e0cc', '#ddd3bd']),
  sandstone: palette(['#d9c49a', '#cdb68a']),
  glass: palette(['#8fa8b8', '#7f9cae', '#9ab4c2']),
  metal: palette(['#a7adb2', '#9aa1a7']),
  wood: palette(['#a58058', '#8d6a47']),
  plaster: FACADE_PALETTE,
};
/** Цвета скатных крыш (крашеный металл) и куполов. */
const ROOF_PALETTE = palette(['#7c4a3a', '#4f6b5a', '#6d7378', '#8a5a44', '#5d6f7a', '#5b5f63']);
const DOME_PALETTE = palette(['#c9a14a', '#4f8a72', '#5f7f99']);
/** Деревня: бревенчатые и обшитые доской дома, крашеная обшивка, белый силикатный и красный кирпич. */
const VILLAGE_FACADE_PALETTE = palette([
  '#8a6a4a', '#a07a52', '#c4ad86', '#7fa2b6', '#9fb48e', '#e6dcc4', '#dcd7cb', '#b0644b', '#cdb874', '#6f8ea4',
]);
/** Деревня: профнастил и железо — зелёный, синий, вишнёвый, серый, коричневый. */
const VILLAGE_ROOF_PALETTE = palette(['#3f6b4f', '#3d5f7f', '#843a2f', '#6b7176', '#5b4636', '#7d8a8e']);

const UTILITY_TYPES = new Set(['garage', 'garages', 'shed', 'service', 'industrial', 'warehouse', 'transformer_tower', 'roof', 'construction']);
const TEMPLE_TYPES = new Set(['church', 'cathedral', 'chapel', 'mosque', 'synagogue', 'temple']);
/** Здания без окон на фасаде. */
const BLANK_TYPES = new Set(['garage', 'garages', 'shed', 'service', 'transformer_tower', 'roof', 'construction', 'hut']);
/** Типы старой малоэтажной застройки, которым по умолчанию достаётся скатная крыша. */
const PITCHED_BY_DEFAULT = new Set(['house', 'detached', 'semidetached_house', 'terrace', 'residential', 'yes', 'dormitory', 'kindergarten', 'church', 'chapel']);

const LEVEL_HEIGHT = 3.2;

const known = Color.fromCssColorString(BUILDING_COLORS.known);
const estimated = Color.fromCssColorString(BUILDING_COLORS.estimated);
const selected = Color.fromCssColorString(BUILDING_COLORS.selected);
const conflict = Color.fromCssColorString(BUILDING_COLORS.conflict);

/** Форма объёма для слоя деталей (балконы, подъезды, карнизы). */
export interface BuildingShape {
  props: BaseBuildingProperties;
  /** Внешний контур в lon/lat (замкнутый) и в локальных метрах (открытый). */
  ring: LonLat[];
  localRing: Vec2[];
  ground: number;
  /** Верх стен над землёй, м (без крыши). */
  wallTop: number;
  flatRoof: boolean;
  floorHeight: number;
  facadeColor: Color;
  /** Тип окон и витрин — чтобы детали вставали напротив нарисованных окон. */
  style: FacadeStyle;
}

interface InstanceRef {
  primitive: 'walls' | 'roofs';
  id: string;
  /** Для крыш — свой цвет, не зависящий от режима раскраски. */
  roofColor?: Color;
}

/**
 * Слой зданий Base World: стены одним асинхронным Primitive (окна, витрины — в шейдере),
 * скатные крыши и купола — вторым (готовая геометрия). Части зданий (building:part)
 * рисуются вместо общего контура. Выбор, подсветка, раскраска по режиму.
 */
export class BaseBuildingsLayer {
  readonly primitives: Primitive[];
  private readonly wallsPrimitive: Primitive;
  private readonly roofsPrimitive: Primitive | undefined;
  private readonly buildings = new Map<string, BaseBuildingProperties>();
  private readonly refs = new Map<string, InstanceRef[]>();
  private readonly shapesList: BuildingShape[] = [];
  private selectedId: string | undefined;
  private conflicts = new Set<string>();
  private colorMode: BuildingColorMode = 'city';

  private constructor(
    private readonly scene: Scene,
    collection: BaseBuildingsCollection,
    groundHeights: number[],
    center: Cartesian3,
    streetFront: ReadonlySet<string>,
    parts: PartsAssignment,
    frame: LocalFrame,
    /** Деревня: почти все дома под скатной крышей, деревенские цвета стен и кровли. */
    private readonly village: boolean,
  ) {
    const walls: GeometryInstance[] = [];
    const roofs: GeometryInstance[] = [];

    /** simple — здание без частей: только для них считаем форму под балконы и карнизы. */
    const addBuilding = (owner: BaseBuildingProperties, elements: BaseBuildingFeature[], ground: number, simple: boolean) => {
      this.buildings.set(owner.id, owner);
      const refs: InstanceRef[] = [];
      const style = facadeStyle(owner, streetFront.has(owner.id), village);
      const color = facadeColor(owner, village);
      let n = 0;

      for (const element of elements) {
        const props = element.properties;
        for (const rings of polygonsOf(element)) {
          const outer = rings[0] ?? [];
          const localRing = openRing(outer.map(frame.toLocal));
          const roof = planRoof(props, localRing, rings.length > 1, village);
          const wallTop = roof.osm ? props.height - roof.height : props.height;
          const floorH = floorHeight(props, wallTop);

          const wallId = `${owner.id}#w${n++}`;
          refs.push({ primitive: 'walls', id: wallId });
          walls.push(
            new GeometryInstance({
              id: wallId,
              geometry: new PolygonGeometry({
                polygonHierarchy: toHierarchy(rings),
                height: ground + props.minHeight,
                extrudedHeight: ground + Math.max(wallTop, props.minHeight + 0.5),
                vertexFormat: PerInstanceColorAppearance.VERTEX_FORMAT,
              }),
              attributes: attributesFor(this.colorOf(owner.id, owner), [ground, props.minHeight, wallTop, floorH], [
                style.shopfront ? 1 : 0,
                style.variant,
                style.seed,
                0,
              ]),
            }),
          );

          if (roof.triangles) {
            const roofColor = roofColorFor(props, roof.shape, village);
            const base = ground + wallTop;
            const triangles = roof.triangles.map(
              (t) => t.map(([x, y, z]) => Cartesian3.fromDegrees(...frame.toLonLat([x, y]), base + z)) as [Cartesian3, Cartesian3, Cartesian3],
            );
            const roofId = `${owner.id}#r${n++}`;
            refs.push({ primitive: 'roofs', id: roofId, roofColor });
            roofs.push(
              new GeometryInstance({
                id: roofId,
                geometry: meshFromTriangles(triangles),
                attributes: attributesFor(roofColor, [ground, 0, 0, 0], [0, 0, style.seed, 1]),
              }),
            );
          }

          if (simple && this.shapesList[this.shapesList.length - 1]?.props !== owner) {
            this.shapesList.push({
              props: owner,
              ring: outer as LonLat[],
              localRing,
              ground,
              wallTop,
              flatRoof: !roof.triangles,
              floorHeight: floorH,
              facadeColor: color,
              style,
            });
          }
        }
      }
      this.refs.set(owner.id, refs);
    };

    collection.features.forEach((feature, i) => {
      const ground = groundHeights[i] ?? 0;
      const ownParts = parts.byBuilding.get(feature.properties.id);
      if (ownParts?.length) addBuilding(feature.properties, ownParts, ground, false);
      else addBuilding(feature.properties, [feature], ground, true);
    });
    parts.orphans.forEach((part, j) => {
      addBuilding(part.properties, [part], groundHeights[collection.features.length + j] ?? 0, false);
    });

    const appearance = () => createBuildingAppearance(center);
    // Нормали без сжатия: шейдер считает сетку окон как проекцию на стену от центра района,
    // и 8-битная нормаль (ошибка ~0,5°) на расстоянии в сотни метров сдвигала окна на метры —
    // мимо дверей и балконов, которые ставятся по той же сетке.
    this.wallsPrimitive = new Primitive({
      geometryInstances: walls,
      appearance: appearance(),
      shadows: ShadowMode.ENABLED,
      compressVertices: false,
    });
    // Крыши — готовая геометрия (не описания), поэтому собираются синхронно; их немного.
    this.roofsPrimitive = roofs.length
      ? new Primitive({ geometryInstances: roofs, appearance: appearance(), shadows: ShadowMode.ENABLED, asynchronous: false })
      : undefined;
    this.primitives = this.roofsPrimitive ? [this.wallsPrimitive, this.roofsPrimitive] : [this.wallsPrimitive];
  }

  /** Создаёт слой; при наличии рельефа ставит каждое здание на землю. */
  static async create(
    scene: Scene,
    collection: BaseBuildingsCollection,
    terrainProvider: TerrainProvider,
    center: Cartesian3,
    frame: LocalFrame,
    /** Здания вдоль улиц — с витринами на первом этаже. */
    streetFront: ReadonlySet<string> = new Set(),
    parts: PartsAssignment = { byBuilding: new Map(), orphans: [] },
    village = false,
  ): Promise<BaseBuildingsLayer> {
    const outlines = [...collection.features, ...parts.orphans].map((f) =>
      polygonsOf(f).flatMap(([outer]) => outer ?? []),
    );
    const groundHeights = await sampleMinHeights(outlines, terrainProvider);
    return new BaseBuildingsLayer(scene, collection, groundHeights, center, streetFront, parts, frame, village);
  }

  /** Формы зданий для слоя деталей. */
  shapes(): readonly BuildingShape[] {
    return this.shapesList;
  }

  /**
   * Геометрия собирается в воркерах асинхронно; в requestRenderMode просим кадры,
   * пока примитивы не будут готовы, иначе здания появятся только после движения камеры.
   */
  renderUntilReady(): void {
    const removeListener = this.scene.postRender.addEventListener(() => {
      const done = this.primitives.every((p) => p.isDestroyed() || p.ready);
      if (done) {
        removeListener();
        // Подсветка/раскраска, заданные до готовности, применяем сейчас.
        for (const id of this.buildings.keys()) this.paint(id);
      }
      this.scene.requestRender();
    });
    this.scene.requestRender();
  }

  /** Определяет здание по результату scene.pick(). */
  buildingFromPick(picked: unknown): BaseBuildingProperties | undefined {
    if (!picked || typeof picked !== 'object') return undefined;
    const { primitive, id } = picked as { primitive?: unknown; id?: unknown };
    if (!this.primitives.includes(primitive as Primitive) || typeof id !== 'string') return undefined;
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
    for (const p of this.primitives) if (!p.isDestroyed()) p.destroy();
  }

  /** Приоритет цвета: выбранное → конфликт с участком → цвет режима раскраски. */
  private colorOf(buildingId: string, props: BaseBuildingProperties): Color {
    if (buildingId === this.selectedId) return selected;
    if (this.conflicts.has(buildingId)) return conflict;
    if (this.colorMode === 'data') return props.heightSource === 'default' ? estimated : known;
    return facadeColor(props, this.village);
  }

  private paint(buildingId: string): void {
    const props = this.buildings.get(buildingId);
    if (!props) return;
    const wallColor = this.colorOf(buildingId, props);
    const highlighted = buildingId === this.selectedId || this.conflicts.has(buildingId);
    for (const ref of this.refs.get(buildingId) ?? []) {
      const primitive = ref.primitive === 'walls' ? this.wallsPrimitive : this.roofsPrimitive;
      if (!primitive?.ready) continue;
      const value = ref.roofColor && !highlighted ? ref.roofColor : wallColor;
      const attributes = primitive.getGeometryInstanceAttributes(ref.id);
      attributes.color = ColorGeometryInstanceAttribute.toValue(value, attributes.color);
    }
  }
}

function attributesFor(color: Color, facade: number[], style: number[]) {
  return {
    color: ColorGeometryInstanceAttribute.fromColor(color),
    facade: new GeometryInstanceAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 4, value: facade }),
    facadeStyle: new GeometryInstanceAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 4, value: style }),
  };
}

interface RoofPlan {
  shape: RoofShape;
  height: number;
  /** Крыша описана в OSM — её высота уже входит в height здания. */
  osm: boolean;
  triangles: ReturnType<typeof roofTriangles>;
}

/**
 * Крыша здания: форма из OSM, а для невысоких почти прямоугольных домов старой застройки —
 * скатная по умолчанию (вальмовая или двускатная). Не строится — плоская.
 */
function planRoof(props: BaseBuildingProperties, localRing: Vec2[], hasHoles: boolean, village: boolean): RoofPlan {
  const flat: RoofPlan = { shape: 'flat', height: 0, osm: false, triangles: undefined };
  if (hasHoles || localRing.length < 3) return flat;
  const box = orientedBox(localRing);
  const area = Math.abs(signedArea(localRing));

  let shape: RoofShape = props.roofShape ?? 'flat';
  const osm = !!props.roofShape;
  if (!osm) {
    const levels = props.levels ?? Math.round(props.height / LEVEL_HEIGHT);
    const pick = hashString(props.id) % 10;
    const eligible =
      PITCHED_BY_DEFAULT.has(props.building) &&
      levels <= 3 &&
      props.minHeight === 0 &&
      area >= (village ? 8 : 40) &&
      area <= 1500 &&
      rectangularity(localRing, box) >= 0.6;
    // В городе плоская крыша у трети малоэтажных домов, в деревне — почти ни у кого.
    if (!eligible || pick < (village ? 1 : 3)) return flat;
    shape = pick < (village ? 5 : 7) ? 'hipped' : 'gabled';
  }

  const height = props.roofHeight ?? defaultRoofHeight(shape, box, area);
  const triangles = roofTriangles(
    localRing,
    shape,
    height,
    props.roofOrientation === 'across' ? 'across' : 'along',
  );
  return triangles ? { shape, height, osm, triangles } : flat;
}

function roofColorFor(props: BaseBuildingProperties, shape: RoofShape, village: boolean): Color {
  const own = props.roofColour ? Color.fromCssColorString(props.roofColour) : undefined;
  if (own) return own;
  const options = shape === 'dome' || shape === 'onion' ? DOME_PALETTE : village ? VILLAGE_ROOF_PALETTE : ROOF_PALETTE;
  return options[hashString(`${props.id}:roof`) % options.length]!;
}

/** Цвет фасада: из OSM (building:colour), по материалу или стабильный по хешу id с учётом типа. */
export function facadeColor(props: BaseBuildingProperties, village = false): Color {
  const own = props.colour ? Color.fromCssColorString(props.colour) : undefined;
  if (own) return own;
  if (TEMPLE_TYPES.has(props.building)) return TEMPLE_COLOR;
  const byMaterial = props.material ? MATERIAL_PALETTES[props.material.toLowerCase()] : undefined;
  const options =
    byMaterial ?? (UTILITY_TYPES.has(props.building) ? UTILITY_PALETTE : village ? VILLAGE_FACADE_PALETTE : FACADE_PALETTE);
  return options[hashString(props.id) % options.length]!;
}

/** Высота этажа для рисования окон; 0 — без окон. */
function floorHeight(props: BaseBuildingProperties, wallTop: number): number {
  if (BLANK_TYPES.has(props.building) || wallTop < 3) return 0;
  if (!props.levels) return LEVEL_HEIGHT;
  return Math.min(Math.max((wallTop - props.minHeight) / props.levels, 2.8), 4.5);
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
