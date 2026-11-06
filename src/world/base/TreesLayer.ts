import {
  Cartesian3,
  Color,
  ColorGeometryInstanceAttribute,
  CylinderGeometry,
  EllipsoidGeometry,
  GeometryInstance,
  Matrix4,
  PerInstanceColorAppearance,
  Primitive,
  ShadowMode,
  Transforms,
  type TerrainProvider,
} from 'cesium';
import { sampleMinHeights } from '../../cesium/terrainHeights';
import { random01 } from '../../utils/hash';
import type { TreePoint } from './environment';

const CROWN_COLORS = ['#4e7c3a', '#5a8a40', '#456f35', '#679447', '#3f6a33'].map((c) =>
  Color.fromCssColorString(c),
);
const TRUNK_COLOR = Color.fromCssColorString('#6b5238');

// Дерево единичной высоты; реальный размер задаётся масштабом в modelMatrix.
const TRUNK = new CylinderGeometry({
  length: 0.42,
  topRadius: 0.022,
  bottomRadius: 0.03,
  slices: 6,
  vertexFormat: PerInstanceColorAppearance.VERTEX_FORMAT,
});
const CROWN = new EllipsoidGeometry({
  radii: new Cartesian3(0.27, 0.27, 0.33),
  stackPartitions: 8,
  slicePartitions: 10,
  vertexFormat: PerInstanceColorAppearance.VERTEX_FORMAT,
});
const TRUNK_OFFSET = Matrix4.fromTranslation(new Cartesian3(0, 0, 0.21));
const CROWN_OFFSET = Matrix4.fromTranslation(new Cartesian3(0, 0, 0.64));

/** Стилизованные деревья: ствол + крона, все одним Primitive, с тенями. */
export class TreesLayer {
  private constructor(readonly primitive: Primitive) {}

  static async create(trees: readonly TreePoint[], terrainProvider: TerrainProvider): Promise<TreesLayer> {
    const grounds = await sampleMinHeights(
      trees.map(([lon, lat]) => [[lon, lat]]),
      terrainProvider,
    );

    const instances: GeometryInstance[] = [];
    trees.forEach(([lon, lat, knownHeight], i) => {
      const r = random01(Math.round(lon * 1e7) ^ Math.round(lat * 1e7));
      const height = knownHeight > 2 ? knownHeight : 7 + r * 6;
      const base = Matrix4.multiplyByUniformScale(
        Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(lon, lat, grounds[i] ?? 0)),
        height,
        new Matrix4(),
      );
      instances.push(
        new GeometryInstance({
          geometry: TRUNK,
          modelMatrix: Matrix4.multiply(base, TRUNK_OFFSET, new Matrix4()),
          attributes: { color: ColorGeometryInstanceAttribute.fromColor(TRUNK_COLOR) },
        }),
        new GeometryInstance({
          geometry: CROWN,
          modelMatrix: Matrix4.multiply(base, CROWN_OFFSET, new Matrix4()),
          attributes: {
            color: ColorGeometryInstanceAttribute.fromColor(
              CROWN_COLORS[Math.floor(r * CROWN_COLORS.length)] ?? CROWN_COLORS[0]!,
            ),
          },
        }),
      );
    });

    return new TreesLayer(
      new Primitive({
        geometryInstances: instances,
        appearance: new PerInstanceColorAppearance({ closed: true, translucent: false }),
        shadows: ShadowMode.ENABLED,
        allowPicking: false,
      }),
    );
  }

  destroy(): void {
    if (!this.primitive.isDestroyed()) this.primitive.destroy();
  }
}
