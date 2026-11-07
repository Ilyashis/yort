import {
  BoundingSphere,
  CallbackProperty,
  Cartesian2,
  Cartographic,
  Cartesian3,
  Color,
  Event,
  GeographicTilingScheme,
  HeadingPitchRange,
  ImageryLayer,
  Math as CesiumMath,
  PointPrimitiveCollection,
  Rectangle,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  type Credit,
  type Entity,
  type ImageryProvider,
  type Viewer,
} from 'cesium';
import { useUnderlayStore, type UnderlayImage } from '../store/useUnderlayStore';
import {
  applyH,
  imageCorners,
  imageMatrix,
  imageToLocal,
  invertH,
  isProjective,
  localToImage,
  translatePlacement,
  type Mat3,
  type UnderlayPlacement,
} from '../world/edit/underlay';
import type { LocalFrame, Vec2 } from '../world/walk/localFrame';
import { pickGround, toLonLat } from './pick';

const TILE_SIZE = 256;
const MAXIMUM_LEVEL = 21;
const ACCENT = Color.fromCssColorString('#f5a524');
const MAP_POINT = Color.fromCssColorString('#3fb27f');
/** Допустимое отклонение кусочно-аффинной отрисовки от точной перспективы, px тайла. */
const WARP_TOLERANCE = 0.35;
const MAX_CELLS = 16;

/**
 * Подложка в сцене: свой снимок поверх земли (тайлами — чётко вблизи и по склонам),
 * перетаскивание мышью и совмещение по точкам (точка на снимке → та же точка на карте):
 * по двум — масштаб и поворот, по четырём — ещё и перспектива кадра.
 */
export class UnderlayController {
  private layer?: ImageryLayer;
  private readonly handler: ScreenSpaceEventHandler;
  private readonly markers = new PointPrimitiveCollection();
  private readonly outline: Entity;
  private outlinePoints: Cartesian3[] = [];
  private drag?: { start: Vec2; placement: UnderlayPlacement; delta: Vec2 };
  private readonly unsubscribe: () => void;
  private readonly removeLayerWatch: () => void;

  constructor(
    private readonly viewer: Viewer,
    private readonly frame: LocalFrame,
  ) {
    viewer.scene.primitives.add(this.markers);
    this.outline = viewer.entities.add({
      show: false,
      polyline: {
        positions: new CallbackProperty(() => this.outlinePoints, false),
        clampToGround: true,
        width: 3,
        material: ACCENT,
      },
    });
    this.handler = new ScreenSpaceEventHandler(viewer.scene.canvas);
    this.handler.setInputAction((e: ScreenSpaceEventHandler.PositionedEvent) => this.down(e.position), ScreenSpaceEventType.LEFT_DOWN);
    this.handler.setInputAction((e: ScreenSpaceEventHandler.MotionEvent) => this.move(e.endPosition), ScreenSpaceEventType.MOUSE_MOVE);
    this.handler.setInputAction((e: ScreenSpaceEventHandler.PositionedEvent) => this.up(e.position), ScreenSpaceEventType.LEFT_UP);
    this.handler.setInputAction((e: ScreenSpaceEventHandler.PositionedEvent) => this.click(e.position), ScreenSpaceEventType.LEFT_CLICK);

    // Слои покрытий земли пересоздаются при правках дорог и ложатся сверху — поднимаем подложку обратно.
    this.removeLayerWatch = viewer.imageryLayers.layerAdded.addEventListener((added: ImageryLayer) => {
      if (this.layer && added !== this.layer && viewer.imageryLayers.contains(this.layer)) viewer.imageryLayers.raiseToTop(this.layer);
    });

    useUnderlayStore.getState().setScene({
      viewCenter: () => this.viewCenter(),
      toLocal: (point) => frame.toLocal(point),
      focus: (corners) => this.focus(corners),
    });
    this.unsubscribe = useUnderlayStore.subscribe((state, prev) => {
      if (state.image !== prev.image || state.placement !== prev.placement) this.rebuild();
      if (this.layer && state.opacity !== prev.opacity) this.layer.alpha = state.opacity;
      if (this.layer && state.visible !== prev.visible) this.layer.show = state.visible;
      if (state.align !== prev.align || state.mode !== prev.mode) this.showMarkers();
      if (state.mode !== prev.mode) viewer.canvas.style.cursor = state.mode ? (state.mode === 'move' ? 'move' : 'crosshair') : '';
      if (state.busy !== prev.busy) viewer.canvas.style.cursor = state.busy ? 'progress' : '';
      viewer.scene.requestRender();
    });
    this.rebuild();
  }

  destroy(): void {
    this.unsubscribe();
    this.removeLayerWatch();
    this.handler.destroy();
    useUnderlayStore.getState().setScene(undefined);
    if (!this.viewer.isDestroyed()) {
      if (this.layer) this.viewer.imageryLayers.remove(this.layer, true);
      this.viewer.scene.primitives.remove(this.markers);
      this.viewer.entities.remove(this.outline);
    }
  }

  private rebuild(): void {
    const { image, placement, opacity, visible } = useUnderlayStore.getState();
    if (this.layer) this.viewer.imageryLayers.remove(this.layer, true);
    this.layer = undefined;
    if (image && placement) {
      this.layer = this.viewer.imageryLayers.addImageryProvider(imageTileProvider(image, placement, this.frame));
      this.layer.alpha = opacity;
      this.layer.show = visible;
    }
    this.viewer.scene.requestRender();
  }

  /** Центр вида на земле, в локальных метрах. */
  private viewCenter(): Vec2 | undefined {
    const canvas = this.viewer.scene.canvas;
    const hit = pickGround(this.viewer, new Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2));
    return hit ? this.frame.toLocal(toLonLat(hit)) : undefined;
  }

  /** Перелёт сверху к снимку (ортофото после загрузки): весь снимок в кадре, над рельефом, север вверху. */
  private focus(corners: Vec2[]): void {
    const globe = this.viewer.scene.globe;
    const points = corners.map((corner) => {
      const [lon, lat] = this.frame.toLonLat(corner);
      return Cartesian3.fromDegrees(lon, lat, globe.getHeight(Cartographic.fromDegrees(lon, lat)) ?? 0);
    });
    const sphere = BoundingSphere.fromPoints(points);
    this.viewer.camera.flyToBoundingSphere(sphere, {
      offset: new HeadingPitchRange(0, -CesiumMath.PI_OVER_TWO + 0.0001, sphere.radius * 2.2),
      duration: 1.2,
    });
  }

  private ground(position: Cartesian2): Vec2 | undefined {
    const hit = pickGround(this.viewer, position);
    return hit ? this.frame.toLocal(toLonLat(hit)) : undefined;
  }

  // --- двигать мышью ----------------------------------------------------------

  private down(position: Cartesian2): void {
    const { mode, placement } = useUnderlayStore.getState();
    if (mode !== 'move' || !placement) return;
    const start = this.ground(position);
    if (!start) return;
    this.drag = { start, placement, delta: [0, 0] };
    this.viewer.scene.screenSpaceCameraController.enableInputs = false;
  }

  private move(position: Cartesian2): void {
    const { image } = useUnderlayStore.getState();
    if (!this.drag || !image) return;
    const point = this.ground(position);
    if (!point) return;
    this.drag.delta = [point[0] - this.drag.start[0], point[1] - this.drag.start[1]];
    const { placement, delta } = this.drag;
    const corners = imageCorners(image.size, translatePlacement(placement, delta));
    this.outlinePoints = [...corners, corners[0]!].map((p) => Cartesian3.fromDegrees(...this.frame.toLonLat(p)));
    this.outline.show = true;
    this.viewer.scene.requestRender();
  }

  private up(_position: Cartesian2): void {
    if (!this.drag) return;
    const { placement, delta } = this.drag;
    this.drag = undefined;
    this.outline.show = false;
    if (!this.viewer.isDestroyed()) this.viewer.scene.screenSpaceCameraController.enableInputs = true;
    if (Math.hypot(delta[0], delta[1]) > 0.05) {
      useUnderlayStore.getState().setPlacement(translatePlacement(placement, delta));
    }
  }

  // --- совмещение по точкам ---------------------------------------------------

  private click(position: Cartesian2): void {
    const { mode, align, image, placement, alignPoint } = useUnderlayStore.getState();
    if ((mode !== 'align2' && mode !== 'align4') || !image || !placement) return;
    if (align.images.length === align.maps.length) {
      // Точка на снимке: где кликнули по земле — тот пиксель снимка.
      const ground = this.ground(position);
      if (ground) alignPoint(localToImage(ground, image.size, placement));
      return;
    }
    // Точка на карте: если попали в дом — его настоящая точка (угол крыши над углом стены), иначе земля.
    const picked = this.viewer.scene.pick(position);
    const world = picked && this.viewer.scene.pickPositionSupported ? this.viewer.scene.pickPosition(position) : undefined;
    const point = world ? this.frame.toLocal(toLonLat(world)) : this.ground(position);
    if (point) alignPoint(point);
  }

  private showMarkers(): void {
    this.markers.removeAll();
    const { mode, align, image, placement } = useUnderlayStore.getState();
    if ((mode !== 'align2' && mode !== 'align4') || !image || !placement) return;
    const add = (local: Vec2, color: Color) => {
      const [lon, lat] = this.frame.toLonLat(local);
      const height = this.viewer.scene.globe.getHeight(Cartographic.fromDegrees(lon, lat)) ?? 0;
      this.markers.add({
        position: Cartesian3.fromDegrees(lon, lat, height + 0.5),
        pixelSize: 12,
        color,
        outlineColor: Color.WHITE,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
    };
    // Точка снимка — там, где она сейчас лежит на карте.
    const imageToMap = (p: Vec2) => imageToLocal(p, image.size, placement);
    for (const point of align.images) add(imageToMap(point), ACCENT);
    for (const point of align.maps) add(point, MAP_POINT);
  }
}

/**
 * Тайлы подложки: каждый рисуется из снимка в своём масштабе (canvas сам режет и масштабирует).
 * Перспективу canvas не умеет — тайл режется на клетки, в каждой своя аффинная картинка,
 * клеток столько, чтобы отличие от точной перспективы было меньше трети пикселя.
 */
function imageTileProvider(image: UnderlayImage, placement: UnderlayPlacement, frame: LocalFrame): ImageryProvider {
  const tilingScheme = new GeographicTilingScheme();
  const quad = imageCorners(image.size, placement);
  const corners = quad.map(frame.toLonLat);
  const lons = corners.map(([lon]) => lon);
  const lats = corners.map(([, lat]) => lat);
  const rectangle = Rectangle.fromDegrees(Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats));
  const inverse = isProjective(placement) ? invertH(placement.homography) : undefined;

  const draw = (ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number) => {
    const sx = TILE_SIZE / (x1 - x0);
    const sy = TILE_SIZE / (y1 - y0);
    // Метры → пиксели тайла (ось y холста — вниз).
    ctx.setTransform(sx, 0, 0, -sy, -x0 * sx, y1 * sy);
    ctx.imageSmoothingQuality = 'high';
    if (!isProjective(placement)) {
      ctx.transform(...imageMatrix(image.size, placement));
      ctx.drawImage(image.bitmap, 0, 0);
      return;
    }
    if (!inverse) return;
    // Только внутри четырёхугольника снимка: за его краем перспектива уходит «за горизонт».
    ctx.beginPath();
    quad.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
    ctx.clip();
    const toImage = (px: number, py: number) => projectToImage(inverse, [x0 + px / sx, y1 - py / sy]);
    const cells = cellCount(toImage);
    const size = TILE_SIZE / cells;
    const [w, h] = image.size;
    const margin = Math.max(w, h) * 0.02;
    for (let row = 0; row < cells; row++) {
      for (let col = 0; col < cells; col++) {
        const px = col * size;
        const py = row * size;
        const q0 = toImage(px, py);
        const q1 = toImage(px + size, py);
        const q2 = toImage(px, py + size);
        if (!q0 || !q1 || !q2) continue;
        // Клетка целиком мимо снимка — рисовать нечего.
        const us = [q0[0], q1[0], q2[0], q1[0] + q2[0] - q0[0]];
        const vs = [q0[1], q1[1], q2[1], q1[1] + q2[1] - q0[1]];
        if (Math.max(...us) < -margin || Math.min(...us) > w + margin || Math.max(...vs) < -margin || Math.min(...vs) > h + margin) continue;
        const m = affineImageToTile(q0, q1, q2, [px, py], size);
        if (!m) continue;
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.beginPath();
        // Клетки чуть внахлёст — без швов на стыках.
        ctx.rect(px - 0.5, py - 0.5, size + 1, size + 1);
        ctx.clip();
        ctx.setTransform(...m);
        ctx.drawImage(image.bitmap, 0, 0);
        ctx.restore();
      }
    }
  };

  const provider = {
    tilingScheme,
    rectangle,
    tileWidth: TILE_SIZE,
    tileHeight: TILE_SIZE,
    minimumLevel: 0,
    maximumLevel: MAXIMUM_LEVEL,
    tileDiscardPolicy: undefined,
    errorEvent: new Event(),
    credit: undefined as Credit | undefined,
    proxy: undefined,
    hasAlphaChannel: true,
    getTileCredits: (): Credit[] => [],
    requestImage: (x: number, y: number, level: number) => {
      const tile = tilingScheme.tileXYToRectangle(x, y, level);
      const [x0, y0] = frame.toLocal([CesiumMath.toDegrees(tile.west), CesiumMath.toDegrees(tile.south)]);
      const [x1, y1] = frame.toLocal([CesiumMath.toDegrees(tile.east), CesiumMath.toDegrees(tile.north)]);
      const canvas = document.createElement('canvas');
      canvas.width = TILE_SIZE;
      canvas.height = TILE_SIZE;
      const ctx = canvas.getContext('2d');
      if (ctx) draw(ctx, x0, y0, x1, y1);
      return Promise.resolve(canvas);
    },
    pickFeatures: () => undefined,
  };
  return provider as unknown as ImageryProvider;
}

/** Метры → пиксель снимка; undefined — за «горизонтом» перспективы. */
function projectToImage(inverse: Mat3, point: Vec2): Vec2 | undefined {
  const w = inverse[6] * point[0] + inverse[7] * point[1] + inverse[8];
  return w > 1e-12 || w < -1e-12 ? applyH(inverse, point) : undefined;
}

/**
 * Сколько клеток по стороне тайла: ошибка аффинного приближения растёт как квадрат размера клетки,
 * поэтому меряем её на целом тайле (четвёртый угол против трёх) и делим сторону как нужно.
 */
function cellCount(toImage: (px: number, py: number) => Vec2 | undefined): number {
  const q0 = toImage(0, 0);
  const q1 = toImage(TILE_SIZE, 0);
  const q2 = toImage(0, TILE_SIZE);
  const q3 = toImage(TILE_SIZE, TILE_SIZE);
  if (!q0 || !q1 || !q2 || !q3) return MAX_CELLS;
  const m = affineImageToTile(q0, q1, q2, [0, 0], TILE_SIZE);
  if (!m) return MAX_CELLS;
  const [a, b, c, d, e, f] = m;
  const error = Math.hypot(a * q3[0] + c * q3[1] + e - TILE_SIZE, b * q3[0] + d * q3[1] + f - TILE_SIZE);
  return Math.min(MAX_CELLS, Math.max(1, Math.ceil(Math.sqrt(error / WARP_TOLERANCE))));
}

/**
 * Аффинная матрица canvas «пиксель снимка → пиксель тайла» по трём углам квадратной клетки:
 * q0 → (px, py), q1 → (px + size, py), q2 → (px, py + size).
 */
function affineImageToTile(q0: Vec2, q1: Vec2, q2: Vec2, [px, py]: Vec2, size: number): [number, number, number, number, number, number] | undefined {
  // Столбцы матрицы снимка: q1 − q0 и q2 − q0; обратная к ней даёт переход в клетку.
  const ux = q1[0] - q0[0];
  const uy = q1[1] - q0[1];
  const vx = q2[0] - q0[0];
  const vy = q2[1] - q0[1];
  const det = ux * vy - vx * uy;
  if (Math.abs(det) < 1e-12) return undefined;
  // M = size · [[1,0],[0,1]] · inv([[ux, vx],[uy, vy]])
  const a = (size * vy) / det;
  const c = (-size * vx) / det;
  const b = (-size * uy) / det;
  const d = (size * ux) / det;
  const e = px - (a * q0[0] + c * q0[1]);
  const f = py - (b * q0[0] + d * q0[1]);
  return [a, b, c, d, e, f];
}
