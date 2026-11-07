import { booleanPointInPolygon, buffer, lineString, polygon } from '@turf/turf';
import {
  Cartesian3,
  ClassificationType,
  Color,
  ColorGeometryInstanceAttribute,
  GeometryInstance,
  GroundPrimitive,
  ImageryLayer,
  PerInstanceColorAppearance,
  PolygonGeometry,
  PolygonHierarchy,
  Primitive,
  ShadowMode,
  type Viewer,
} from 'cesium';
import type { TerrainKind } from '../../cesium/terrain';
import { polygonsOfGround, type GroundFeature, type GroundKind } from './environment';
import { createLandTileProvider } from '../../cesium/LandTileProvider';
import { LandTextureRenderer, type GardenPatch } from './landTexture';
import type { Ring } from './types';
import { hashString } from '../../utils/hash';
import { ROAD_KINDS, type EditRoadKind, type LonLat } from '../edit/edits';

/** Порядок снизу вверх: дороги лежат поверх газонов, дорожки — поверх всего. */
const ORDER: GroundKind[] = ['green', 'pitch', 'water', 'parking', 'paving', 'sidewalk', 'road', 'footway', 'marking'];

export const GROUND_COLORS: Record<GroundKind, string> = {
  green: '#8cb06a',
  pitch: '#77a75d',
  water: '#6f9ec4',
  parking: '#8d9095',
  paving: '#c8c3b8',
  sidewalk: '#bcb8af',
  road: '#6e7177',
  footway: '#d6ccb8',
  marking: '#ecebe4',
};

/** Цвет «пустой» земли (дворы, пустыри): притоптанная трава — в режиме прогулки и вместо карты. */
export const BARE_GROUND_COLOR = '#c1c39c';
/** В деревне между домами — не пустыри, а трава: выгоревшая, светлее леса. */
export const VILLAGE_GROUND_COLOR = '#a4b674';
/** Лесная подстилка и луг из OSM. */
const WOOD_COLOR = '#6f8f4f';
const MEADOW_COLOR = '#a9bb76';

/**
 * На плоском рельефе каждый слой лежит на своей высоте: газон ниже тротуара,
 * тротуар ниже дороги, разметка выше всех. Порядок отрисовки у Cesium не гарантирован,
 * поэтому слои разводим по высоте (2 см — на глаз незаметно, для буфера глубины достаточно).
 */
const FLAT_BASE_HEIGHT = 0.06;
const FLAT_LAYER_STEP = 0.02;


/** Дорога, нарисованная в редакторе: ось и тип (ширина и покрытие). */
export interface RoadEdit {
  kind: EditRoadKind;
  axis: LonLat[];
}

/** Что редактор поменял на земле. */
export interface GroundEdits {
  /** Убранные дороги OSM (ключ полигона проезжей части, см. roadKey). */
  removedRoads: ReadonlySet<string>;
  addedRoads: readonly RoadEdit[];
  /** Дворы (id дома), чьи огороды больше не рисуем. */
  hiddenGardens: ReadonlySet<string>;
}

const NO_EDITS: GroundEdits = { removedRoads: new Set(), addedRoads: [], hiddenGardens: new Set() };
/** Тротуар вдоль новой городской улицы, м с каждой стороны. */
const NEW_SIDEWALK = 1.6;

/** Стабильный ключ дороги OSM: по первым точкам контура и названию (переживает перезагрузку). */
export function roadKey(feature: GroundFeature): string {
  const [first] = polygonsOfGround(feature);
  const head = (first?.[0] ?? []).slice(0, 3).map(([lon, lat]) => `${lon.toFixed(6)},${lat.toFixed(6)}`);
  return `road:${hashString(head.join(';') + (feature.properties.name ?? ''))}`;
}

interface RoadEntry {
  key: string;
  feature: GroundFeature;
  shapes: ReturnType<typeof polygon>[];
}

/**
 * Поверхности земли Base World (и правки дорог поверх них).
 *
 * Плоский рельеф: обычные примитивы, разнесённые по высоте, с освещением и тенями.
 * С рельефом: дороги, газоны, вода и т. п. рисуются по тайлам с вектора (LandTextureRenderer)
 * и ложатся на рельеф как подложка — её освещает солнце вместе со склонами и на неё падают тени.
 * (Классификационные «наклейки» GroundPrimitive закрасили бы склоны плоским цветом.)
 * Тонкая разметка поверх — GroundPrimitive, чтобы оставаться чёткой.
 */
export class GroundLayer {
  private viewer?: Viewer;
  private primitives: (Primitive | GroundPrimitive)[] = [];
  private imagery?: ImageryLayer;
  private edits: GroundEdits = NO_EDITS;
  private readonly roads: RoadEntry[];
  private readonly bounds: Bounds | undefined;

  /** Где лежат покрытия района (непрозрачный слой тайлов): под ним базовую карту можно не грузить. */
  get landBounds(): Readonly<Bounds> | undefined {
    return this.bounds;
  }

  private constructor(
    private readonly features: readonly GroundFeature[],
    private readonly terrain: TerrainKind,
    private readonly bareColor: string,
    private readonly gardens: readonly GardenPatch[],
    /** Город: у новых улиц — тротуары. */
    private readonly city: boolean,
  ) {
    this.roads = features
      .filter((f) => f.properties.kind === 'road')
      .map((feature) => ({ key: roadKey(feature), feature, shapes: polygonsOfGround(feature).map((rings) => polygon(rings)) }));
    // Разметка — отдельные примитивы, в текстуру не входит; по ней границы не считаем.
    this.bounds = boundsOf(features.filter((f) => f.properties.kind !== 'marking'));
  }

  static create(
    features: readonly GroundFeature[],
    terrain: TerrainKind,
    /** Цвет земли там, где в OSM ничего нет. */
    bareColor = BARE_GROUND_COLOR,
    /** Огороды во дворах (деревня) — рисуются в текстуру земли. */
    gardens: readonly GardenPatch[] = [],
    city = true,
  ): GroundLayer {
    return new GroundLayer(features, terrain, bareColor, gardens, city);
  }

  addTo(viewer: Viewer): void {
    this.viewer = viewer;
    this.rebuild();
  }

  /** Применить правки дорог и огородов: земля перерисуется (тайлы — заново). */
  setEdits(edits: GroundEdits): void {
    const same =
      sameSet(edits.removedRoads, this.edits.removedRoads) &&
      sameSet(edits.hiddenGardens, this.edits.hiddenGardens) &&
      JSON.stringify(edits.addedRoads) === JSON.stringify(this.edits.addedRoads);
    this.edits = edits;
    if (!same && this.viewer) this.rebuild();
  }

  /** Дорога OSM под точкой (не убранная), для выбора в редакторе. */
  roadAt(lon: number, lat: number): { key: string; rings: Ring[][] } | undefined {
    const point: [number, number] = [lon, lat];
    const hit = this.roads.find(
      (r) => !this.edits.removedRoads.has(r.key) && r.shapes.some((shape) => booleanPointInPolygon(point, shape)),
    );
    return hit ? { key: hit.key, rings: polygonsOfGround(hit.feature) } : undefined;
  }

  /** Контур дороги OSM по ключу — для подсветки выделенной. */
  roadOutline(key: string): Ring[][] {
    const road = this.roads.find((r) => r.key === key);
    return road ? polygonsOfGround(road.feature) : [];
  }

  destroy(): void {
    this.clear();
  }

  private clear(): void {
    const viewer = this.viewer && !this.viewer.isDestroyed() ? this.viewer : undefined;
    for (const primitive of this.primitives) {
      if (viewer?.scene.primitives.contains(primitive)) viewer.scene.primitives.remove(primitive);
      else if (!primitive.isDestroyed()) primitive.destroy();
    }
    this.primitives = [];
    if (this.imagery && viewer) viewer.imageryLayers.remove(this.imagery, true);
    this.imagery = undefined;
  }

  private rebuild(): void {
    const viewer = this.viewer;
    if (!viewer || viewer.isDestroyed()) return;
    const { byKind, dirt } = this.effective();

    for (const primitive of this.primitives) viewer.scene.primitives.remove(primitive);
    this.primitives = [];

    if (this.terrain === 'flat') {
      byKind.set('footway', [...(byKind.get('footway') ?? []), ...dirt]);
      this.primitives = flatPrimitives(byKind);
    } else {
      const markings = byKind.get('marking') ?? [];
      if (markings.length) {
        this.primitives.push(
          new GroundPrimitive({
            geometryInstances: markings.map((rings) => instance(rings, 'marking', undefined, false)),
            classificationType: ClassificationType.TERRAIN,
            allowPicking: false,
          }),
        );
      }
      if (this.bounds) {
        const covers = { wood: [] as Ring[][], meadow: [] as Ring[][] };
        for (const feature of this.features) {
          const cover = feature.properties.kind === 'green' ? feature.properties.cover : undefined;
          if (cover) covers[cover].push(...polygonsOfGround(feature));
        }
        const style = { bare: this.bareColor, colors: GROUND_COLORS, wood: WOOD_COLOR, meadow: MEADOW_COLOR };
        const gardens = this.gardens.filter((g) => !g.houseId || !this.edits.hiddenGardens.has(g.houseId));
        const renderer = new LandTextureRenderer({ byKind, covers, gardens, dirt, style }, this.bounds);
        // Новый слой тайлов — поверх старого; старый убираем, когда новые тайлы догрузятся (без мигания).
        // Поверх базовой карты (слой 0): её на прогулке скрываем, покрытия района остаются.
        const previous = this.imagery;
        this.imagery = viewer.imageryLayers.addImageryProvider(createLandTileProvider(renderer, this.bounds));
        if (previous) {
          const remove = viewer.scene.postRender.addEventListener(() => {
            if (!viewer.scene.globe.tilesLoaded) return;
            remove();
            if (!viewer.isDestroyed() && viewer.imageryLayers.contains(previous)) viewer.imageryLayers.remove(previous, true);
          });
        }
      }
    }
    for (const primitive of this.primitives) viewer.scene.primitives.add(primitive);
    viewer.scene.requestRender();
  }

  /** Покрытия с учётом правок: без убранных дорог (и их тротуаров, разметки), с нарисованными. */
  private effective(): { byKind: Map<GroundKind, Ring[][]>; dirt: Ring[][] } {
    const removed = this.roads.filter((r) => this.edits.removedRoads.has(r.key));
    const removedShapes = removed.flatMap((r) => r.shapes);
    const removedFeatures = new Set(removed.map((r) => r.feature));
    // Тротуар и разметка «принадлежат» дороге, если её точки лежат внутри (тротуар шире дороги).
    const covers = (rings: Ring[]) => {
      const sample = (rings[0] ?? []).filter((_, i, all) => i % Math.max(1, Math.floor(all.length / 6)) === 0);
      return (shape: ReturnType<typeof polygon>) => sample.length > 0 && sample.every((p) => booleanPointInPolygon(p, shape));
    };

    const byKind = new Map<GroundKind, Ring[][]>();
    const push = (kind: GroundKind, rings: Ring[]) => {
      const list = byKind.get(kind) ?? [];
      list.push(rings);
      byKind.set(kind, list);
    };
    for (const feature of this.features) {
      if (removedFeatures.has(feature)) continue;
      const { kind } = feature.properties;
      for (const rings of polygonsOfGround(feature)) {
        if (removedShapes.length && kind === 'sidewalk') {
          const sidewalk = polygon(rings);
          if (removed.some((r) => polygonsOfGround(r.feature).some((roadRings) => covers(roadRings)(sidewalk)))) continue;
        }
        if (removedShapes.length && kind === 'marking' && removedShapes.some(covers(rings))) continue;
        push(kind, rings);
      }
    }

    const dirt: Ring[][] = [];
    for (const road of this.edits.addedRoads) {
      if (road.axis.length < 2) continue;
      const { width } = ROAD_KINDS[road.kind];
      const strip = (half: number) => {
        const result = buffer(lineString(road.axis), half, { units: 'meters', steps: 4 });
        const geometry = result?.geometry;
        if (!geometry) return [];
        return geometry.type === 'Polygon' ? [geometry.coordinates as Ring[]] : (geometry.coordinates as Ring[][]);
      };
      if (road.kind === 'track') dirt.push(...strip(width / 2));
      else if (road.kind === 'path') for (const rings of strip(width / 2)) push('footway', rings);
      else {
        if (this.city && road.kind === 'street') for (const rings of strip(width / 2 + NEW_SIDEWALK)) push('sidewalk', rings);
        for (const rings of strip(width / 2)) push('road', rings);
      }
    }
    return { byKind, dirt };
  }
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

function flatPrimitives(byKind: Map<GroundKind, Ring[][]>): Primitive[] {
  const primitives: Primitive[] = [];
  ORDER.forEach((kind, layer) => {
    const polygons = byKind.get(kind);
    if (!polygons?.length) return;
    const height = FLAT_BASE_HEIGHT + layer * FLAT_LAYER_STEP;
    primitives.push(
      new Primitive({
        geometryInstances: polygons.map((rings) => instance(rings, kind, height, true)),
        // Не flat: приёмнику теней Cesium нужны v_positionEC и v_normalEC в шейдере.
        // closed: true — иначе Cesium включает FACE_FORWARD, который сверяет нормаль с осью
        // экрана, а не с направлением взгляда: стоило пешеходу чуть поднять глаза, нормаль
        // земли переворачивалась вниз и асфальт терял солнечный свет (темнел вдвое).
        appearance: new PerInstanceColorAppearance({ flat: false, translucent: false, closed: true }),
        shadows: ShadowMode.RECEIVE_ONLY,
        allowPicking: false,
      }),
    );
  });
  return primitives;
}

function instance(rings: Ring[], kind: GroundKind, height: number | undefined, lit: boolean): GeometryInstance {
  return new GeometryInstance({
    geometry: new PolygonGeometry({
      polygonHierarchy: toHierarchy(rings),
      height,
      // Нормали нужны, чтобы земля освещалась солнцем и принимала тени.
      vertexFormat: lit ? PerInstanceColorAppearance.VERTEX_FORMAT : PerInstanceColorAppearance.FLAT_VERTEX_FORMAT,
    }),
    attributes: { color: ColorGeometryInstanceAttribute.fromColor(Color.fromCssColorString(GROUND_COLORS[kind])) },
  });
}

function boundsOf(features: readonly GroundFeature[]): Bounds | undefined {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const feature of features) {
    for (const rings of polygonsOfGround(feature)) {
      for (const [lon, lat] of rings[0] ?? []) {
        west = Math.min(west, lon);
        east = Math.max(east, lon);
        south = Math.min(south, lat);
        north = Math.max(north, lat);
      }
    }
  }
  return Number.isFinite(west) ? { west, south, east, north } : undefined;
}

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
