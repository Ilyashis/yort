import {
  BoundingSphere,
  Cartesian3,
  Color,
  Credit,
  HeadingPitchRange,
  ImageryLayer,
  JulianDate,
  Math as CesiumMath,
  OpenStreetMapImageryProvider,
  PostProcessStageLibrary,
  ScreenSpaceEventType,
  SunLight,
  Viewer,
  type TerrainProvider,
} from 'cesium';
import type { Territory } from '../config/territory';

/** Время для положения солнца (UTC): 17:30 по Уфе — мягкий предвечерний свет и длинные тени. */
const SUN_TIME = '2026-07-15T12:30:00Z';
/** Чуть тёплый оттенок солнечного света. */
const SUN_COLOR = '#fff1dc';

/** high — со сглаживанием и мягкими тенями в углах (ambient occlusion), normal — только сглаживание. */
export type GraphicsQuality = 'high' | 'normal';

export function territoryCenter(territory: Territory): Cartesian3 {
  const { south, west, north, east } = territory.bbox;
  return Cartesian3.fromDegrees((west + east) / 2, (south + north) / 2);
}

export function createViewer(container: HTMLElement, terrainProvider: TerrainProvider): Viewer {
  const viewer = new Viewer(container, {
    terrainProvider,
    // Подложка OSM не требует ключей. Для продакшена её нужно заменить
    // на свой тайл-сервер или коммерческого провайдера (политика tile.openstreetmap.org).
    baseLayer: new ImageryLayer(
      new OpenStreetMapImageryProvider({
        url: 'https://tile.openstreetmap.org/',
        credit: '© участники OpenStreetMap',
        // Глубже 19-го уровня тайлов у OSM нет — иначе сыплются ошибки CORS/404.
        maximumLevel: 19,
      }),
    ),
    // Все виджеты, завязанные на Cesium ion, выключены.
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    animation: false,
    timeline: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
    // Перерисовка только при изменениях — бережём батарею и GPU.
    requestRenderMode: true,
    maximumRenderTimeChange: Number.POSITIVE_INFINITY,
    // Только 3D: проще шейдеры и меньше данных на GPU.
    scene3DOnly: true,
    shadows: true,
    // Небо без звёзд и диска луны: на уровне улицы они выглядят странно.
    // Освещение и тени от солнца при этом остаются (scene.light).
    skyBox: false,
  });

  const { scene } = viewer;
  scene.globe.depthTestAgainstTerrain = true;

  // Солнце: летний вечер, фасады освещены с запада тёплым светом, тени длинные.
  viewer.clock.currentTime = JulianDate.fromIso8601(SUN_TIME);
  viewer.clock.shouldAnimate = false;
  scene.light = new SunLight({ color: Color.fromCssColorString(SUN_COLOR), intensity: 2.0 });
  scene.globe.enableLighting = true;
  configureShadows(viewer);

  scene.backgroundColor = Color.fromCssColorString('#bcd3e6');
  // Сглаживание краёв («лесенки» у стен и столбов) — дёшево, включено всегда.
  scene.postProcessStages.fxaa.enabled = true;

  // Стандартные действия Viewer (выбор сущности, «слежение» по двойному клику)
  // конфликтуют с нашими инструментами — клики обрабатываем сами.
  viewer.cesiumWidget.screenSpaceEventHandler.removeInputAction(ScreenSpaceEventType.LEFT_CLICK);
  viewer.cesiumWidget.screenSpaceEventHandler.removeInputAction(ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
  viewer.creditDisplay.addStaticCredit(new Credit('Здания: © участники OpenStreetMap, ODbL'));

  return viewer;
}

interface ShadowBias {
  normalOffsetScale: number;
  depthBias: number;
}

/**
 * Тени от солнца. Смещения по умолчанию у Cesium рассчитаны на 3D Tiles и дают
 * «рябь» (shadow acne) на плоских крышах наших зданий; публичного API для смещений нет,
 * поэтому аккуратно правим внутреннее поле, если оно есть.
 */
function configureShadows(viewer: Viewer): void {
  const shadowMap = viewer.shadowMap;
  shadowMap.softShadows = true;
  shadowMap.darkness = 0.4;
  shadowMap.size = 2048;
  shadowMap.maximumDistance = 1200;

  const bias = (shadowMap as unknown as { _primitiveBias?: ShadowBias })._primitiveBias;
  if (bias) {
    bias.normalOffsetScale = SHADOW_NORMAL_OFFSET;
    bias.depthBias = SHADOW_DEPTH_BIAS;
  }
}

// Подобрано на виде с 250–300 м: меньшие значения дают рябь на крышах, тени на земле при этом сохраняются.
const SHADOW_NORMAL_OFFSET = 2.5;
const SHADOW_DEPTH_BIAS = 0.001;

/**
 * Мягкие тени в углах (ambient occlusion): между домами, у стен, под деревьями.
 * Заметно добавляет «уюта», но нагружает видеокарту — поэтому отдельный переключатель.
 */
export function setGraphicsQuality(viewer: Viewer, quality: GraphicsQuality): void {
  const ao = viewer.scene.postProcessStages.ambientOcclusion;
  const supported = PostProcessStageLibrary.isAmbientOcclusionSupported(viewer.scene);
  ao.enabled = supported && quality === 'high';
  if (ao.enabled) {
    ao.uniforms.intensity = 2.2;
    ao.uniforms.bias = 0.12;
    ao.uniforms.lengthCap = 0.3;
    ao.uniforms.stepSize = 1.6;
    ao.uniforms.blurStepSize = 1.0;
  }
  viewer.scene.requestRender();
}

/** Стартовый вид издалека — потом камера плавно прилетает к району. */
export function setIntroView(viewer: Viewer, territory: Territory): void {
  const { south, west, east } = territory.bbox;
  viewer.camera.setView({
    destination: Cartesian3.fromDegrees((west + east) / 2 - 0.06, south - 0.11, 9000),
    orientation: { heading: CesiumMath.toRadians(25), pitch: CesiumMath.toRadians(-38), roll: 0 },
  });
}

/**
 * Наклонный вид на участок с запасом по высоте под будущее здание.
 * sidebarShare — доля ширины экрана, закрытая панелью слева: участок сдвигаем в свободную часть.
 */
export function flyToArea(
  viewer: Viewer,
  points: readonly [number, number][],
  expectedHeight = 30,
  sidebarShare = 0,
  /** Высота земли под участком (рельеф), м. */
  groundHeight = 0,
): void {
  if (!points.length) return;
  const sphere = BoundingSphere.fromPoints(
    points.map(([lon, lat]) => Cartesian3.fromDegrees(lon, lat, groundHeight + expectedHeight / 2)),
  );
  const radius = Math.max(sphere.radius, 25) + expectedHeight;
  const range = radius * 2.6;
  viewer.camera.flyToBoundingSphere(new BoundingSphere(sphere.center, radius), {
    offset: new HeadingPitchRange(viewer.camera.heading, CesiumMath.toRadians(-28), range),
    duration: 1.2,
    complete: () => {
      // Видимая ширина на расстоянии range ≈ 2·range·tg(fov/2); сдвигаем на половину ширины панели.
      const frustum = viewer.camera.frustum as { fov?: number };
      const visibleWidth = 2 * range * Math.tan((frustum.fov ?? Math.PI / 3) / 2);
      viewer.camera.moveLeft((visibleWidth * sidebarShare) / 2);
      viewer.scene.requestRender();
    },
  });
}

/** Наклонный вид на территорию с юго-запада; groundHeight — высота земли в центре (рельеф). */
export function flyToTerritory(viewer: Viewer, territory: Territory, duration = 1.5, groundHeight = 0): void {
  const { south, west, north, east } = territory.bbox;
  const center = Cartesian3.fromDegrees((west + east) / 2, (south + north) / 2, groundHeight);
  const corner = Cartesian3.fromDegrees(west, south, groundHeight);
  const radius = Cartesian3.distance(center, corner);

  viewer.camera.flyToBoundingSphere(new BoundingSphere(center, radius), {
    offset: new HeadingPitchRange(CesiumMath.toRadians(25), CesiumMath.toRadians(-35), radius * 1.9),
    duration,
  });
}
