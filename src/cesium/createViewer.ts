import {
  BoundingSphere,
  Cartesian3,
  Credit,
  HeadingPitchRange,
  ImageryLayer,
  Math as CesiumMath,
  OpenStreetMapImageryProvider,
  Viewer,
  type TerrainProvider,
} from 'cesium';
import type { Territory } from '../config/territory';

export function createViewer(container: HTMLElement, terrainProvider: TerrainProvider): Viewer {
  const viewer = new Viewer(container, {
    terrainProvider,
    // Подложка OSM не требует ключей. Для продакшена её нужно заменить
    // на свой тайл-сервер или коммерческого провайдера (политика tile.openstreetmap.org).
    baseLayer: new ImageryLayer(
      new OpenStreetMapImageryProvider({
        url: 'https://tile.openstreetmap.org/',
        credit: '© участники OpenStreetMap',
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
  });

  viewer.scene.globe.depthTestAgainstTerrain = true;
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
