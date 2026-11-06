import {
  BoxGeometry,
  Cartesian3,
  Color,
  ColorGeometryInstanceAttribute,
  CylinderGeometry,
  GeometryInstance,
  Matrix3,
  Matrix4,
  PerInstanceColorAppearance,
  Primitive,
  ShadowMode,
  Transforms,
  type TerrainProvider,
} from 'cesium';
import { sampleMinHeights } from '../../cesium/terrainHeights';
import type { Placed } from './streetFurniture';

const VERTEX_FORMAT = PerInstanceColorAppearance.VERTEX_FORMAT;
const METAL = Color.fromCssColorString('#3c4045');
const LAMP_GLASS = Color.fromCssColorString('#e4e0cf');
const WOOD = Color.fromCssColorString('#8a6a4a');

const box = (x: number, y: number, z: number) =>
  BoxGeometry.fromDimensions({ dimensions: new Cartesian3(x, y, z), vertexFormat: VERTEX_FORMAT });

// Фонарь: столб 7 м, консоль к дороге (вдоль локальной оси y), плафон на конце.
const LAMP_POLE = new CylinderGeometry({ length: 7, topRadius: 0.06, bottomRadius: 0.09, slices: 8, vertexFormat: VERTEX_FORMAT });
const LAMP_ARM = box(0.07, 1.4, 0.07);
const LAMP_HEAD = box(0.28, 0.55, 0.12);
// Скамейка: сиденье, спинка, две опоры; длинная сторона — вдоль локальной оси y (вдоль дорожки).
const BENCH_SEAT = box(0.45, 1.6, 0.06);
const BENCH_BACK = box(0.06, 1.6, 0.4);
const BENCH_LEG = box(0.45, 0.06, 0.45);

/** Фонари и скамейки одним Primitive. */
export class StreetFurnitureLayer {
  private constructor(readonly primitive: Primitive) {}

  static async create(
    lamps: readonly Placed[],
    benches: readonly Placed[],
    terrainProvider: TerrainProvider,
  ): Promise<StreetFurnitureLayer> {
    const all = [...lamps, ...benches];
    const grounds = await sampleMinHeights(
      all.map(({ position }) => [position]),
      terrainProvider,
    );

    const instances: GeometryInstance[] = [];
    const add = (geometry: BoxGeometry | CylinderGeometry, modelMatrix: Matrix4, color: Color) =>
      instances.push(
        new GeometryInstance({
          geometry,
          modelMatrix,
          attributes: { color: ColorGeometryInstanceAttribute.fromColor(color) },
        }),
      );
    /** Система координат объекта: y — по heading, z — вверх. */
    const frameAt = ({ position, heading }: Placed, ground: number) =>
      Matrix4.multiply(
        Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(position[0], position[1], ground)),
        Matrix4.fromRotation(Matrix3.fromRotationZ(-heading)),
        new Matrix4(),
      );
    const offset = (base: Matrix4, x: number, y: number, z: number) =>
      Matrix4.multiplyByTranslation(base, new Cartesian3(x, y, z), new Matrix4());

    lamps.forEach((lamp, i) => {
      const base = frameAt(lamp, grounds[i] ?? 0);
      add(LAMP_POLE, offset(base, 0, 0, 3.5), METAL);
      add(LAMP_ARM, offset(base, 0, 0.65, 6.9), METAL);
      add(LAMP_HEAD, offset(base, 0, 1.3, 6.82), LAMP_GLASS);
    });

    benches.forEach((bench, j) => {
      const base = frameAt(bench, grounds[lamps.length + j] ?? 0);
      add(BENCH_SEAT, offset(base, 0, 0, 0.45), WOOD);
      add(BENCH_BACK, offset(base, -0.22, 0, 0.72), WOOD);
      add(BENCH_LEG, offset(base, 0, 0.7, 0.22), METAL);
      add(BENCH_LEG, offset(base, 0, -0.7, 0.22), METAL);
    });

    return new StreetFurnitureLayer(
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
