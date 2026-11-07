import {
  Event,
  GeographicTilingScheme,
  Math as CesiumMath,
  Rectangle,
  type Credit,
  type ImageryProvider,
  type Request,
} from 'cesium';
import type { LandBounds, LandTextureRenderer } from '../world/base/landTexture';

const TILE_SIZE = 256;
/** Самый мелкий уровень: ~4 см на пиксель — травинки и швы плитки у ног пешехода. */
const MAXIMUM_LEVEL = 21;
/** Сколько миллисекунд за раз рисовать тайлы, чтобы не подвешивать интерфейс. */
const SLICE_MS = 8;

interface Job {
  x: number;
  y: number;
  level: number;
  resolve: (canvas: HTMLCanvasElement) => void;
}

/**
 * Подложка покрытий района по тайлам: каждый тайл рисуется с вектора (LandTextureRenderer)
 * в своём масштабе, как у тайл-сервера, только прямо в браузере. Cesium сам просит тайлы
 * нужного уровня по мере приближения камеры и кэширует их.
 */
export function createLandTileProvider(renderer: LandTextureRenderer, bounds: LandBounds): ImageryProvider {
  const tilingScheme = new GeographicTilingScheme();
  const rectangle = Rectangle.fromDegrees(bounds.west, bounds.south, bounds.east, bounds.north);
  const queue: Job[] = [];
  let scheduled = false;

  // Рисуем очередь порциями через MessageChannel: в отличие от setTimeout, его не душит фон браузера.
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    scheduled = false;
    const end = performance.now() + SLICE_MS;
    while (queue.length && performance.now() < end) {
      const job = queue.shift()!;
      job.resolve(drawTile(job));
    }
    if (queue.length) schedule();
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    channel.port2.postMessage(0);
  };

  const drawTile = ({ x, y, level }: Job): HTMLCanvasElement => {
    const tile = tilingScheme.tileXYToRectangle(x, y, level);
    const canvas = document.createElement('canvas');
    canvas.width = TILE_SIZE;
    canvas.height = TILE_SIZE;
    renderer.draw(canvas, {
      west: CesiumMath.toDegrees(tile.west),
      south: CesiumMath.toDegrees(tile.south),
      east: CesiumMath.toDegrees(tile.east),
      north: CesiumMath.toDegrees(tile.north),
    });
    return canvas;
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
    hasAlphaChannel: false,
    getTileCredits: (): Credit[] => [],
    requestImage: (x: number, y: number, level: number, _request?: Request) =>
      new Promise<HTMLCanvasElement>((resolve) => {
        queue.push({ x, y, level, resolve });
        schedule();
      }),
    pickFeatures: () => undefined,
  };
  return provider as unknown as ImageryProvider;
}
