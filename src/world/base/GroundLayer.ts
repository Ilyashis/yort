import {
  Cartesian3,
  ClassificationType,
  Color,
  ColorGeometryInstanceAttribute,
  GeometryInstance,
  GroundPrimitive,
  PerInstanceColorAppearance,
  PolygonGeometry,
  PolygonHierarchy,
  Primitive,
  ShadowMode,
  type Scene,
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

/**
 * Поверхности земли Base World. На плоском рельефе — обычные примитивы,
 * разнесённые по высоте, с освещением и приёмом теней.
 * С рельефом — GroundPrimitive, прижатые к земле.
 */
export class GroundLayer {
  private constructor(private readonly primitives: (Primitive | GroundPrimitive)[]) {}

  static create(features: readonly GroundFeature[], terrain: TerrainKind): GroundLayer {
    const byKind = new Map<GroundKind, Ring[][]>();
    for (const feature of features) {
      const list = byKind.get(feature.properties.kind) ?? [];
      list.push(...polygonsOfGround(feature));
      byKind.set(feature.properties.kind, list);
    }

    const primitives: (Primitive | GroundPrimitive)[] = [];
    ORDER.forEach((kind, layer) => {
      const polygons = byKind.get(kind);
      if (!polygons?.length) return;
      const color = ColorGeometryInstanceAttribute.fromColor(Color.fromCssColorString(GROUND_COLORS[kind]));
      const height = FLAT_BASE_HEIGHT + layer * FLAT_LAYER_STEP;
      const geometryInstances = polygons.map(
        (rings) =>
          new GeometryInstance({
            geometry: new PolygonGeometry({
              polygonHierarchy: toHierarchy(rings),
              height: terrain === 'flat' ? height : undefined,
              // Нормали нужны, чтобы земля освещалась солнцем и принимала тени.
              vertexFormat:
                terrain === 'flat'
                  ? PerInstanceColorAppearance.VERTEX_FORMAT
                  : PerInstanceColorAppearance.FLAT_VERTEX_FORMAT,
            }),
            attributes: { color },
          }),
      );

      primitives.push(
        terrain === 'flat'
          ? new Primitive({
              geometryInstances,
              // Не flat: приёмнику теней Cesium нужны v_positionEC и v_normalEC в шейдере.
              // closed: true — иначе Cesium включает FACE_FORWARD, который сверяет нормаль с осью
              // экрана, а не с направлением взгляда: стоило пешеходу чуть поднять глаза, нормаль
              // земли переворачивалась вниз и асфальт терял солнечный свет (темнел вдвое).
              appearance: new PerInstanceColorAppearance({ flat: false, translucent: false, closed: true }),
              shadows: ShadowMode.RECEIVE_ONLY,
              allowPicking: false,
            })
          : new GroundPrimitive({
              geometryInstances,
              classificationType: ClassificationType.TERRAIN,
              allowPicking: false,
            }),
      );
    });
    return new GroundLayer(primitives);
  }

  addTo(scene: Scene): void {
    for (const primitive of this.primitives) scene.primitives.add(primitive);
  }

  destroy(): void {
    for (const primitive of this.primitives) if (!primitive.isDestroyed()) primitive.destroy();
  }
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
