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
  Rectangle,
  ShadowMode,
  SingleTileImageryProvider,
  type Viewer,
} from 'cesium';
import type { TerrainKind } from '../../cesium/terrain';
import { polygonsOfGround, type GroundFeature, type GroundKind } from './environment';
import type { Ring } from './types';

/** Порядок снизу вверх: дороги лежат поверх газонов, дорожки — поверх всего. */
const ORDER: GroundKind[] = ['green', 'pitch', 'water', 'parking', 'paving', 'sidewalk', 'road', 'footway', 'marking'];

export const GROUND_COLORS: Record<GroundKind, string> = {
  green: '#8cb06a',
  pitch: '#77a75d',
  water: '#6f9ec4',
  parking: '#8d9095',
  paving: '#cfc8ba',
  sidewalk: '#bfb8aa',
  road: '#6e7177',
  footway: '#d6ccb8',
  marking: '#ecebe4',
};

/** Цвет «пустой» земли (дворы, пустыри) — в режиме прогулки вместо карты. */
export const BARE_GROUND_COLOR = '#c9c2b0';

/**
 * На плоском рельефе каждый слой лежит на своей высоте: газон ниже тротуара,
 * тротуар ниже дороги, разметка выше всех. Порядок отрисовки у Cesium не гарантирован,
 * поэтому слои разводим по высоте (2 см — на глаз незаметно, для буфера глубины достаточно).
 */
const FLAT_BASE_HEIGHT = 0.06;
const FLAT_LAYER_STEP = 0.02;

/** Длинная сторона текстуры покрытий на рельефе, пикселей (~0,5 м на пиксель для района 2 км). */
const LAND_USE_TEXTURE_SIZE = 4096;

/**
 * Поверхности земли Base World.
 *
 * Плоский рельеф: обычные примитивы, разнесённые по высоте, с освещением и тенями.
 * С рельефом: дороги, газоны, вода и т. п. рисуются в одну текстуру района, которая ложится
 * на рельеф как подложка — её освещает солнце вместе со склонами и на неё падают тени.
 * (Классификационные «наклейки» GroundPrimitive закрасили бы склоны плоским цветом.)
 * Тонкая разметка поверх — GroundPrimitive, чтобы оставаться чёткой.
 */
export class GroundLayer {
  private constructor(
    private readonly primitives: (Primitive | GroundPrimitive)[],
    private readonly landUse: HTMLCanvasElement | undefined,
    private readonly bounds: Bounds | undefined,
  ) {}

  static create(features: readonly GroundFeature[], terrain: TerrainKind): GroundLayer {
    const byKind = new Map<GroundKind, Ring[][]>();
    for (const feature of features) {
      const list = byKind.get(feature.properties.kind) ?? [];
      list.push(...polygonsOfGround(feature));
      byKind.set(feature.properties.kind, list);
    }

    if (terrain === 'flat') return new GroundLayer(flatPrimitives(byKind), undefined, undefined);

    const markings = byKind.get('marking') ?? [];
    const primitives = markings.length
      ? [
          new GroundPrimitive({
            geometryInstances: markings.map((rings) => instance(rings, 'marking', undefined, false)),
            classificationType: ClassificationType.TERRAIN,
            allowPicking: false,
          }),
        ]
      : [];
    const bounds = boundsOf(features);
    return new GroundLayer(primitives, bounds ? drawLandUse(byKind, bounds) : undefined, bounds);
  }

  addTo(viewer: Viewer): void {
    for (const primitive of this.primitives) viewer.scene.primitives.add(primitive);
    const canvas = this.landUse;
    const bounds = this.bounds;
    if (!canvas || !bounds) return;
    SingleTileImageryProvider.fromUrl(canvas.toDataURL('image/png'), {
      rectangle: Rectangle.fromDegrees(bounds.west, bounds.south, bounds.east, bounds.north),
    })
      .then((provider) => {
        if (viewer.isDestroyed()) return;
        // Поверх базовой карты (слой 0): её на прогулке скрываем, покрытия района остаются.
        viewer.imageryLayers.add(new ImageryLayer(provider));
        viewer.scene.requestRender();
      })
      .catch((error: unknown) => console.warn('[ground] не удалось создать текстуру покрытий', error));
    // Пиксели уже в data URL — отпускаем память холста.
    canvas.width = 0;
    canvas.height = 0;
  }

  destroy(): void {
    for (const primitive of this.primitives) if (!primitive.isDestroyed()) primitive.destroy();
  }
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

/** Покрытия района в текстуру (равнопромежуточная проекция — как у тайлов Cesium). */
function drawLandUse(byKind: Map<GroundKind, Ring[][]>, bounds: Bounds): HTMLCanvasElement {
  const { west, south, east, north } = bounds;
  const mPerDegLat = 111_320;
  const mPerDegLon = mPerDegLat * Math.cos((((south + north) / 2) * Math.PI) / 180);
  const widthM = (east - west) * mPerDegLon;
  const heightM = (north - south) * mPerDegLat;
  const pxPerM = LAND_USE_TEXTURE_SIZE / Math.max(widthM, heightM);

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(widthM * pxPerM));
  canvas.height = Math.max(1, Math.round(heightM * pxPerM));
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  const x = (lon: number) => ((lon - west) / (east - west)) * canvas.width;
  const y = (lat: number) => ((north - lat) / (north - south)) * canvas.height;

  ctx.fillStyle = BARE_GROUND_COLOR;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (const kind of ORDER) {
    if (kind === 'marking') continue;
    ctx.fillStyle = GROUND_COLORS[kind];
    for (const rings of byKind.get(kind) ?? []) {
      // Каждый полигон отдельно: evenodd вырезает дворы-дыры, а перекрытия полигонов просто закрашиваются.
      ctx.beginPath();
      for (const ring of rings) {
        ring.forEach(([lon, lat], i) => (i === 0 ? ctx.moveTo(x(lon), y(lat)) : ctx.lineTo(x(lon), y(lat))));
        ctx.closePath();
      }
      ctx.fill('evenodd');
    }
  }
  return canvas;
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
