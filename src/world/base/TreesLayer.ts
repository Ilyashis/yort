import {
  Cartesian3,
  Color,
  ColorGeometryInstanceAttribute,
  CylinderGeometry,
  EllipsoidGeometry,
  GeometryInstance,
  Matrix3,
  Matrix4,
  PerInstanceColorAppearance,
  Primitive,
  ShadowMode,
  ShowGeometryInstanceAttribute,
  Transforms,
  type TerrainProvider,
} from 'cesium';
import { InstanceVisibility } from '../../cesium/instanceVisibility';
import { sampleMinHeights } from '../../cesium/terrainHeights';
import { random01 } from '../../utils/hash';
import type { TreePoint } from './environment';

const LEAF_COLORS = ['#4e7c3a', '#5a8a40', '#456f35', '#679447', '#3f6a33', '#6f9a4a'].map((c) =>
  Color.fromCssColorString(c),
);
const NEEDLE_COLORS = ['#2f5634', '#2a4d30', '#365f3a'].map((c) => Color.fromCssColorString(c));
const TRUNK_COLOR = Color.fromCssColorString('#6b5238');
/** Доля хвойных среди деревьев без данных о породе. */
const CONIFER_SHARE = 0.15;

const VERTEX_FORMAT = PerInstanceColorAppearance.VERTEX_FORMAT;

// Детали дерева единичной высоты; реальный размер — масштабом в modelMatrix.
const TRUNK = new CylinderGeometry({ length: 0.42, topRadius: 0.022, bottomRadius: 0.03, slices: 6, vertexFormat: VERTEX_FORMAT });
const BLOB = new EllipsoidGeometry({
  radii: new Cartesian3(1, 1, 1),
  stackPartitions: 7,
  slicePartitions: 9,
  vertexFormat: VERTEX_FORMAT,
});
const CONE = new CylinderGeometry({ length: 1, topRadius: 0, bottomRadius: 1, slices: 9, vertexFormat: VERTEX_FORMAT });

/** Лиственная крона: главное «облако» и несколько боковых (x, y, z, радиус) в долях высоты. */
const LEAF_BLOBS: [number, number, number, number][] = [
  [0, 0, 0.66, 0.25],
  [0.13, 0.04, 0.58, 0.17],
  [-0.1, 0.1, 0.6, 0.16],
  [0.02, -0.13, 0.57, 0.16],
  [0, 0, 0.82, 0.15],
];
/** Ель: ярусы конусов (центр по z, высота, радиус основания) в долях высоты. */
const CONIFER_TIERS: [number, number, number][] = [
  [0.38, 0.42, 0.22],
  [0.6, 0.36, 0.17],
  [0.82, 0.3, 0.11],
];

/** Стилизованные деревья: лиственные с кроной из нескольких «облаков» и ели из ярусов. */
export class TreesLayer {
  private constructor(
    readonly primitive: Primitive,
    /** Прячет деревья на пятне застройки зданий пользователя. */
    readonly visibility: InstanceVisibility,
  ) {}

  static async create(trees: readonly TreePoint[], terrainProvider: TerrainProvider): Promise<TreesLayer> {
    const grounds = await sampleMinHeights(
      trees.map(([lon, lat]) => [[lon, lat]]),
      terrainProvider,
    );

    const instances: GeometryInstance[] = [];
    const instanceIds: string[][] = trees.map(() => []);
    let tree = 0;
    const add = (geometry: CylinderGeometry | EllipsoidGeometry, modelMatrix: Matrix4, color: Color) => {
      const id = `tree/${tree}#${instanceIds[tree]!.length}`;
      instanceIds[tree]!.push(id);
      instances.push(
        new GeometryInstance({
          id,
          geometry,
          modelMatrix,
          attributes: {
            color: ColorGeometryInstanceAttribute.fromColor(color),
            show: new ShowGeometryInstanceAttribute(true),
          },
        }),
      );
    };

    trees.forEach(([lon, lat, knownHeight], i) => {
      tree = i;
      const seed = Math.round(lon * 1e7) ^ Math.round(lat * 1e7);
      const r = random01(seed);
      const conifer = random01(seed + 1) < CONIFER_SHARE;
      const height = knownHeight > 2 ? knownHeight : (conifer ? 9 : 7) + r * 6;
      // Дерево единичной высоты, повёрнутое на случайный угол, масштабированное до реального.
      const base = Matrix4.multiply(
        Matrix4.multiplyByUniformScale(
          Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(lon, lat, grounds[i] ?? 0)),
          height,
          new Matrix4(),
        ),
        Matrix4.fromRotation(Matrix3.fromRotationZ(random01(seed + 2) * Math.PI * 2)),
        new Matrix4(),
      );
      const at = (x: number, y: number, z: number, scale: Cartesian3) =>
        Matrix4.multiplyByScale(
          Matrix4.multiplyByTranslation(base, new Cartesian3(x, y, z), new Matrix4()),
          scale,
          new Matrix4(),
        );

      add(TRUNK, at(0, 0, 0.21, new Cartesian3(1, 1, 1)), TRUNK_COLOR);

      if (conifer) {
        const color = NEEDLE_COLORS[Math.floor(r * NEEDLE_COLORS.length)] ?? NEEDLE_COLORS[0]!;
        for (const [z, length, radius] of CONIFER_TIERS) {
          add(CONE, at(0, 0, z, new Cartesian3(radius, radius, length)), color);
        }
      } else {
        LEAF_BLOBS.forEach(([x, y, z, radius], blob) => {
          const size = radius * (0.85 + 0.3 * random01(seed + 10 + blob));
          const color = LEAF_COLORS[Math.floor(random01(seed + 20 + blob) * LEAF_COLORS.length)] ?? LEAF_COLORS[0]!;
          add(BLOB, at(x, y, z, new Cartesian3(size, size, size * 0.9)), color);
        });
      }
    });

    const primitive = new Primitive({
      geometryInstances: instances,
      appearance: new PerInstanceColorAppearance({ closed: true, translucent: false }),
      shadows: ShadowMode.ENABLED,
      allowPicking: false,
    });
    return new TreesLayer(
      primitive,
      new InstanceVisibility(
        primitive,
        instanceIds,
        trees.map(([lon, lat]) => [lon, lat]),
      ),
    );
  }

  destroy(): void {
    if (!this.primitive.isDestroyed()) this.primitive.destroy();
  }
}
