import {
  Axis,
  BoxGeometry,
  Cartesian2,
  Cartesian3,
  Color,
  ColorGeometryInstanceAttribute,
  CylinderGeometry,
  DistanceDisplayCondition,
  GeometryInstance,
  HorizontalOrigin,
  LabelCollection,
  LabelStyle,
  Math as CesiumMath,
  Matrix3,
  Matrix4,
  Model,
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
const GRANITE = Color.fromCssColorString('#857c74');
const GRANITE_DARK = Color.fromCssColorString('#6f6862');
const BRONZE = Color.fromCssColorString('#4d4335');

/** Площадка в две ступени; «юбка» вниз, м: на склоне (памятник — на краю обрыва) под ней не будет щели. */
const STEPS = [
  { radius: 7.2, height: 0.25 },
  { radius: 6.4, height: 0.25 },
];
const PLATFORM_HEIGHT = STEPS.reduce((sum, step) => sum + step.height, 0);
const PLATFORM_SKIRT = 3;
/** Пьедестал: цоколь, ствол и карниз — как у классических постаментов, общая высота ~4,1 м. */
const PLINTH = { width: 4.8, length: 7.1, height: 0.45 };
const SHAFT = { width: 4.2, length: 6.5, height: 3.0 };
const CORNICE = { width: 4.6, length: 6.9, height: 0.35 };
const PEDESTAL_TOP = PLATFORM_HEIGHT + PLINTH.height + SHAFT.height + CORNICE.height;
/** Бронзовая доска с надписью на лицевой стороне ствола. */
const PLAQUE = { width: 2.6, height: 0.9, depth: 0.06 };

/** Высота статуи над пьедесталом, м (модель собрана в этой высоте, см. scripts/sculpt-statue.mjs). */
const STATUE_HEIGHT = 9.8;
/** Высота верха фигуры над землёй, м. */
const STATUE_TOP = PEDESTAL_TOP + STATUE_HEIGHT;

/** Памятники: гранитный пьедестал, бронзовая статуя (модель GLB) и подпись. */
export class LandmarksLayer {
  private constructor(
    readonly primitive: Primitive,
    readonly labels: LabelCollection,
    readonly statues: Model[],
  ) {}

  static async create(landmarks: readonly Landmark[], terrainProvider: TerrainProvider): Promise<LandmarksLayer> {
    // Земля — самая низкая точка под площадкой: на склоне площадка не повиснет в воздухе.
    const grounds = await sampleMinHeights(
      landmarks.map((l) => [l.position, ...(landmarkClearance(l, STEPS[0]!.radius)[0] ?? [])]),
      terrainProvider,
    );
    const instances: GeometryInstance[] = [];
    const labels = new LabelCollection();
    const statues: Promise<Model | undefined>[] = [];

    landmarks.forEach((landmark, i) => {
      const ground = grounds[i] ?? 0;
      // Оси памятника: x — вправо, y — вперёд (куда смотрит конь), z — вверх.
      const base = Matrix4.multiply(
        Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(...landmark.position, ground)),
        Matrix4.fromRotationTranslation(Matrix3.fromRotationZ(CesiumMath.toRadians(-landmark.heading))),
        new Matrix4(),
      );
      const place = (offset: [number, number, number]) =>
        Matrix4.multiply(base, Matrix4.fromTranslation(new Cartesian3(...offset)), new Matrix4());
      const add = (geometry: CylinderGeometry | BoxGeometry, modelMatrix: Matrix4, color: Color) =>
        instances.push(
          new GeometryInstance({
            geometry,
            modelMatrix,
            attributes: { color: ColorGeometryInstanceAttribute.fromColor(color) },
          }),
        );
      const box = (size: { width: number; length: number; height: number }, z: number, color: Color) =>
        add(
          BoxGeometry.fromDimensions({
            dimensions: new Cartesian3(size.width, size.length, size.height),
            vertexFormat: VERTEX_FORMAT,
          }),
          place([0, 0, z + size.height / 2]),
          color,
        );

      // Ступени: нижняя уходит «юбкой» в склон.
      let z = 0;
      STEPS.forEach((step, k) => {
        const skirt = k === 0 ? PLATFORM_SKIRT : 0;
        add(
          new CylinderGeometry({
            length: step.height + skirt,
            topRadius: step.radius,
            bottomRadius: step.radius,
            slices: 48,
            vertexFormat: VERTEX_FORMAT,
          }),
          place([0, 0, z + (step.height - skirt) / 2]),
          k === 0 ? GRANITE_LIGHT : GRANITE,
        );
        z += step.height;
      });
      box(PLINTH, z, GRANITE);
      z += PLINTH.height;
      box(SHAFT, z, GRANITE_DARK);
      // Доска на лицевой стороне ствола, по центру высоты.
      add(
        BoxGeometry.fromDimensions({
          dimensions: new Cartesian3(PLAQUE.width, PLAQUE.depth * 2, PLAQUE.height),
          vertexFormat: VERTEX_FORMAT,
        }),
        place([0, SHAFT.length / 2, z + SHAFT.height * 0.55]),
        BRONZE,
      );
      z += SHAFT.height;
      box(CORNICE, z, GRANITE);

      if (landmark.model) statues.push(loadStatue(landmark.model, place([0, 0, PEDESTAL_TOP])));

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
      (await Promise.all(statues)).filter((model): model is Model => !!model),
    );
  }

  addTo(scene: Scene): void {
    scene.primitives.add(this.primitive);
    for (const statue of this.statues) scene.primitives.add(statue);
    scene.primitives.add(this.labels);
  }

  destroy(): void {
    if (!this.primitive.isDestroyed()) this.primitive.destroy();
    for (const statue of this.statues) if (!statue.isDestroyed()) statue.destroy();
    if (!this.labels.isDestroyed()) this.labels.destroy();
  }
}

/**
 * Статуя из GLB. Модель собрана в метрах: основание в нуле, вперёд — −z glTF; с forwardAxis = X
 * Cesium кладёт её так, что вперёд — ось y памятника, вверх — z. Не загрузилась — остаётся пьедестал.
 */
async function loadStatue(url: string, modelMatrix: Matrix4): Promise<Model | undefined> {
  try {
    return await Model.fromGltfAsync({
      url: `${import.meta.env.BASE_URL}${url}`,
      modelMatrix,
      forwardAxis: Axis.X,
      shadows: ShadowMode.ENABLED,
      allowPicking: false,
    });
  } catch (error) {
    console.warn('[landmarks] модель статуи не загрузилась', url, error);
    return undefined;
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
  const halfW = PLINTH.width / 2;
  const halfL = PLINTH.length / 2;
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
