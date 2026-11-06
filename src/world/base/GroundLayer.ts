import {
  Cartesian3,
  ClassificationType,
  Color,
  ColorGeometryInstanceAttribute,
  DepthFunction,
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
const ORDER: GroundKind[] = ['green', 'pitch', 'water', 'parking', 'paving', 'sidewalk', 'road', 'footway'];

export const GROUND_COLORS: Record<GroundKind, string> = {
  green: '#8cb06a',
  pitch: '#77a75d',
  water: '#6f9ec4',
  parking: '#8d9095',
  paving: '#cfc8ba',
  sidewalk: '#bfb8aa',
  road: '#5f6268',
  footway: '#d6ccb8',
};

/** Цвет «пустой» земли (дворы, пустыри) — в режиме прогулки вместо карты. */
export const BARE_GROUND_COLOR = '#c9c2b0';

/** На плоском рельефе поверхности лежат чуть выше эллипсоида, чтобы не мерцать. */
const FLAT_HEIGHT = 0.08;

/**
 * Поверхности земли Base World. На плоском рельефе — обычные примитивы на одной высоте
 * без записи глубины (порядок отрисовки = порядок слоёв) и с приёмом теней.
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
    for (const kind of ORDER) {
      const polygons = byKind.get(kind);
      if (!polygons?.length) continue;
      const color = ColorGeometryInstanceAttribute.fromColor(Color.fromCssColorString(GROUND_COLORS[kind]));
      const geometryInstances = polygons.map(
        (rings) =>
          new GeometryInstance({
            geometry: new PolygonGeometry({
              polygonHierarchy: toHierarchy(rings),
              height: terrain === 'flat' ? FLAT_HEIGHT : undefined,
              vertexFormat: PerInstanceColorAppearance.FLAT_VERTEX_FORMAT,
            }),
            attributes: { color },
          }),
      );

      primitives.push(
        terrain === 'flat'
          ? new Primitive({
              geometryInstances,
              appearance: new PerInstanceColorAppearance({
                flat: true,
                translucent: false,
                renderState: {
                  depthTest: { enabled: true, func: DepthFunction.LESS_OR_EQUAL },
                  depthMask: false,
                },
              }),
              shadows: ShadowMode.RECEIVE_ONLY,
              allowPicking: false,
            })
          : new GroundPrimitive({
              geometryInstances,
              classificationType: ClassificationType.TERRAIN,
              allowPicking: false,
            }),
      );
    }
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
