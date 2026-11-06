import {
  BoxGeometry,
  Cartesian2,
  Cartesian3,
  Color,
  ColorGeometryInstanceAttribute,
  CylinderGeometry,
  DistanceDisplayCondition,
  EllipsoidGeometry,
  GeometryInstance,
  HorizontalOrigin,
  LabelCollection,
  LabelStyle,
  Math as CesiumMath,
  Matrix3,
  Matrix4,
  PerInstanceColorAppearance,
  Primitive,
  ShadowMode,
  Transforms,
  VerticalOrigin,
  type Scene,
  type TerrainProvider,
} from 'cesium';
import type { Landmark } from '../../config/landmarks';
import { sampleMinHeights } from '../../cesium/terrainHeights';
import type { LonLat } from '../user/plot';
import { createLocalFrame } from '../walk/localFrame';
import type { BaseBuildingFeature, Ring } from './types';

const VERTEX_FORMAT = PerInstanceColorAppearance.VERTEX_FORMAT;
const GRANITE_LIGHT = Color.fromCssColorString('#a29b92');
const GRANITE_DARK = Color.fromCssColorString('#6f6862');
const BRONZE = Color.fromCssColorString('#4d4335');

/** Масштаб фигуры: при 1.5 высота от пьедестала до кнута ≈ 9,8 м, как у настоящей статуи. */
const STATUE_SCALE = 1.5;
const PLATFORM = { radius: 7, height: 0.5 };
const PEDESTAL = { width: 4.2, length: 6.5, height: 3.5 };
const PEDESTAL_TOP = PLATFORM.height + PEDESTAL.height;

type Shape =
  | { type: 'ellipsoid'; radii: [number, number, number] }
  | { type: 'cylinder'; length: number; top: number; bottom: number };

interface Part {
  shape: Shape;
  /** Центр детали в координатах фигуры: x — вправо, y — вперёд (куда смотрит конь), z — вверх. */
  at: [number, number, number];
  /** Наклон, градусы: rx поднимает перед (+) детали, вытянутой вдоль y; ry наклоняет верх вправо. */
  rx?: number;
  ry?: number;
}

const ellipsoid = (rx: number, ry: number, rz: number): Shape => ({ type: 'ellipsoid', radii: [rx, ry, rz] });
const cylinder = (length: number, top: number, bottom = top): Shape => ({ type: 'cylinder', length, top, bottom });

/** Конь, вставший на дыбы, и всадник с поднятой рукой — стилизация из простых форм. */
const EQUESTRIAN: Part[] = [
  // Конь
  { shape: cylinder(2.0, 0.16, 0.13), at: [-0.35, -1.2, 1.0], rx: -15 },
  { shape: cylinder(2.0, 0.16, 0.13), at: [0.35, -1.15, 1.0], rx: -10 },
  { shape: ellipsoid(0.75, 1.7, 0.85), at: [0, -0.2, 2.3], rx: 32 },
  { shape: ellipsoid(0.7, 0.9, 0.9), at: [0, 0.9, 3.0], rx: 32 },
  { shape: ellipsoid(0.4, 0.5, 1.0), at: [0, 1.35, 3.9], rx: -25 },
  { shape: ellipsoid(0.28, 0.6, 0.32), at: [0, 1.75, 4.7], rx: -30 },
  { shape: cylinder(1.5, 0.15, 0.11), at: [-0.35, 1.55, 2.6], rx: 50 },
  { shape: cylinder(1.4, 0.15, 0.11), at: [0.35, 1.65, 2.75], rx: 65 },
  { shape: ellipsoid(0.15, 0.25, 0.9), at: [0, -1.85, 1.6], rx: -35 },
  // Всадник
  { shape: ellipsoid(0.42, 0.32, 0.85), at: [0, 0.15, 3.85], rx: -15 },
  { shape: ellipsoid(0.26, 0.26, 0.3), at: [0, 0.35, 4.85] },
  { shape: ellipsoid(0.18, 0.6, 0.22), at: [-0.62, 0.3, 3.15], rx: 20 },
  { shape: ellipsoid(0.18, 0.6, 0.22), at: [0.62, 0.3, 3.15], rx: 20 },
  { shape: cylinder(0.9, 0.12, 0.1), at: [-0.7, 0.55, 2.65], rx: -20 },
  { shape: cylinder(0.9, 0.12, 0.1), at: [0.7, 0.55, 2.65], rx: -20 },
  { shape: cylinder(1.1, 0.1, 0.09), at: [0.55, 0.25, 4.85], ry: 35 },
  { shape: cylinder(1.3, 0.035, 0.03), at: [0.95, 0.35, 5.8], ry: 15 },
  { shape: cylinder(0.9, 0.1, 0.09), at: [-0.45, 0.6, 4.1], rx: 60 },
];

/** Высота верха фигуры над землёй, м. */
const STATUE_TOP = PEDESTAL_TOP + 6.5 * STATUE_SCALE;

/** Памятники: гранитный пьедестал, бронзовая фигура и подпись. */
export class LandmarksLayer {
  private constructor(
    readonly primitive: Primitive,
    readonly labels: LabelCollection,
  ) {}

  static async create(landmarks: readonly Landmark[], terrainProvider: TerrainProvider): Promise<LandmarksLayer> {
    const grounds = await sampleMinHeights(
      landmarks.map((l) => [l.position]),
      terrainProvider,
    );
    const instances: GeometryInstance[] = [];
    const labels = new LabelCollection();

    landmarks.forEach((landmark, i) => {
      const ground = grounds[i] ?? 0;
      const base = Matrix4.multiply(
        Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(...landmark.position, ground)),
        Matrix4.fromRotationTranslation(Matrix3.fromRotationZ(CesiumMath.toRadians(-landmark.heading))),
        new Matrix4(),
      );
      const place = (offset: [number, number, number], rx = 0, ry = 0) => {
        const rotation = Matrix3.multiply(
          Matrix3.fromRotationX(CesiumMath.toRadians(rx)),
          Matrix3.fromRotationY(CesiumMath.toRadians(ry)),
          new Matrix3(),
        );
        return Matrix4.multiply(
          base,
          Matrix4.fromRotationTranslation(rotation, new Cartesian3(...offset)),
          new Matrix4(),
        );
      };
      const add = (geometry: CylinderGeometry | EllipsoidGeometry | BoxGeometry, modelMatrix: Matrix4, color: Color) =>
        instances.push(
          new GeometryInstance({
            geometry,
            modelMatrix,
            attributes: { color: ColorGeometryInstanceAttribute.fromColor(color) },
          }),
        );

      add(
        new CylinderGeometry({
          length: PLATFORM.height,
          topRadius: PLATFORM.radius,
          bottomRadius: PLATFORM.radius,
          slices: 32,
          vertexFormat: VERTEX_FORMAT,
        }),
        place([0, 0, PLATFORM.height / 2]),
        GRANITE_LIGHT,
      );
      add(
        BoxGeometry.fromDimensions({
          dimensions: new Cartesian3(PEDESTAL.width, PEDESTAL.length, PEDESTAL.height),
          vertexFormat: VERTEX_FORMAT,
        }),
        place([0, 0, PLATFORM.height + PEDESTAL.height / 2]),
        GRANITE_DARK,
      );

      const s = STATUE_SCALE;
      for (const part of EQUESTRIAN) {
        const geometry =
          part.shape.type === 'ellipsoid'
            ? new EllipsoidGeometry({
                radii: new Cartesian3(...part.shape.radii.map((r) => r * s) as [number, number, number]),
                stackPartitions: 12,
                slicePartitions: 14,
                vertexFormat: VERTEX_FORMAT,
              })
            : new CylinderGeometry({
                length: part.shape.length * s,
                topRadius: part.shape.top * s,
                bottomRadius: part.shape.bottom * s,
                slices: 10,
                vertexFormat: VERTEX_FORMAT,
              });
        const [x, y, z] = part.at;
        add(geometry, place([x * s, y * s, PEDESTAL_TOP + z * s], part.rx, part.ry), BRONZE);
      }

      labels.add({
        text: landmark.name,
        position: Cartesian3.fromDegrees(...landmark.position, ground + STATUE_TOP + 3),
        font: '600 15px -apple-system, "Segoe UI", Roboto, sans-serif',
        fillColor: Color.WHITE,
        outlineColor: Color.fromCssColorString('#12161e'),
        outlineWidth: 3,
        style: LabelStyle.FILL_AND_OUTLINE,
        showBackground: true,
        backgroundColor: Color.fromCssColorString('#12161e').withAlpha(0.75),
        backgroundPadding: new Cartesian2(8, 5),
        horizontalOrigin: HorizontalOrigin.CENTER,
        verticalOrigin: VerticalOrigin.BOTTOM,
        distanceDisplayCondition: new DistanceDisplayCondition(0, 3000),
      });
    });

    return new LandmarksLayer(
      new Primitive({
        geometryInstances: instances,
        appearance: new PerInstanceColorAppearance({ closed: true, translucent: false }),
        shadows: ShadowMode.ENABLED,
        allowPicking: false,
      }),
      labels,
    );
  }

  addTo(scene: Scene): void {
    scene.primitives.add(this.primitive);
    scene.primitives.add(this.labels);
  }

  destroy(): void {
    if (!this.primitive.isDestroyed()) this.primitive.destroy();
    if (!this.labels.isDestroyed()) this.labels.destroy();
  }
}

/** Открытая площадка вокруг памятника — туда не досаживаем деревья. */
export function landmarkClearance(landmark: Landmark, radius = 20): Ring[] {
  const frame = createLocalFrame(landmark.position);
  const ring: LonLat[] = Array.from({ length: 24 }, (_, i) => {
    const a = (i / 24) * Math.PI * 2;
    return frame.toLonLat([radius * Math.cos(a), radius * Math.sin(a)]);
  });
  return [[...ring, ring[0]!]];
}

/** Пьедестал как препятствие для пешехода (в формате здания Base World). */
export function landmarkObstacle(landmark: Landmark): BaseBuildingFeature {
  const frame = createLocalFrame(landmark.position);
  const h = CesiumMath.toRadians(landmark.heading);
  const halfW = PEDESTAL.width / 2;
  const halfL = PEDESTAL.length / 2;
  // Поворот локальных осей фигуры (x — вправо, y — вперёд) на курс памятника.
  const toWorld = ([x, y]: [number, number]): LonLat =>
    frame.toLonLat([x * Math.cos(h) + y * Math.sin(h), -x * Math.sin(h) + y * Math.cos(h)]);
  const corners: [number, number][] = [[-halfW, -halfL], [halfW, -halfL], [halfW, halfL], [-halfW, halfL]];
  const ring = corners.map(toWorld);
  return {
    type: 'Feature',
    id: `landmark/${landmark.id}`,
    properties: {
      id: `landmark/${landmark.id}`,
      building: 'monument',
      name: landmark.name,
      height: PEDESTAL_TOP,
      minHeight: 0,
      heightSource: 'height',
    },
    geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]!]] },
  };
}
