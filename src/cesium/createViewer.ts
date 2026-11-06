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
  ScreenSpaceEventType,
  Viewer,
  type TerrainProvider,
} from 'cesium';
import type { Territory } from '../config/territory';

/** Время для положения солнца (UTC). */
const SUN_TIME = '2026-07-15T10:30:00Z';

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
    // Тени пока выключены: на плоских слоях земли они не видны, а на крышах дают
    // артефакты (shadow acne). Примитивы уже размечены ShadowMode — включим после настройки.
    shadows: false,
    // Небо без звёзд и диска луны: на уровне улицы они выглядят странно.
    // Освещение и тени от солнца при этом остаются (scene.light).
    skyBox: false,
  });

  const { scene } = viewer;
  scene.globe.depthTestAgainstTerrain = true;

  // Солнце: летний день, около 15:30 по Уфе — фасады освещены с юго-запада.
  viewer.clock.currentTime = JulianDate.fromIso8601(SUN_TIME);
  viewer.clock.shouldAnimate = false;
  scene.globe.enableLighting = true;

  scene.backgroundColor = Color.fromCssColorString('#bcd3e6');

  // Стандартные действия Viewer (выбор сущности, «слежение» по двойному клику)
  // конфликтуют с нашими инструментами — клики обрабатываем сами.
  viewer.cesiumWidget.screenSpaceEventHandler.removeInputAction(ScreenSpaceEventType.LEFT_CLICK);
  viewer.cesiumWidget.screenSpaceEventHandler.removeInputAction(ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
  viewer.creditDisplay.addStaticCredit(new Credit('Здания: © участники OpenStreetMap, ODbL'));

  return viewer;
}

/** Наклонный вид на территорию с юго-запада. */
export function flyToTerritory(viewer: Viewer, territory: Territory, duration = 1.5): void {
  const { south, west, north, east } = territory.bbox;
  const center = Cartesian3.fromDegrees((west + east) / 2, (south + north) / 2);
  const corner = Cartesian3.fromDegrees(west, south);
  const radius = Cartesian3.distance(center, corner);

  viewer.camera.flyToBoundingSphere(new BoundingSphere(center, radius), {
    offset: new HeadingPitchRange(CesiumMath.toRadians(25), CesiumMath.toRadians(-35), radius * 1.9),
    duration,
  });
}
