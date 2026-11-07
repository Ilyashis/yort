// Чтение ортофото GeoTIFF (с дрона: WebODM, DJI Terra, Pix4D, Agisoft) прямо в браузере:
// пиксели — уменьшенными до MAX_SIDE по длинной стороне, привязка — опорными точками «пиксель → долгота/широта».
// Модуль грузится лениво (вместе с библиотекой geotiff), только когда выбрали .tif.

import { fromBlob, type GeoTIFF, type GeoTIFFImage } from 'geotiff';
import { controlPoints, crsFromGeoKeys } from '../world/edit/geoReference';
import type { ImageSize } from '../world/edit/underlay';
import type { LonLat } from '../world/user/plot';
import type { Vec2 } from '../world/walk/localFrame';

/** Длинная сторона снимка в браузере, px: 4096² — около 64 МБ памяти, на участок хватает с запасом. */
const MAX_SIDE = 4096;
/** Сколько исходных пикселей читать за раз: большие файлы идут полосами, чтобы не съесть всю память. */
const BAND_PIXELS = 6_000_000;

export interface GeoTiffResult {
  blob: Blob;
  bitmap: ImageBitmap;
  size: ImageSize;
  /** Опорные точки: пиксель уменьшенного снимка → долгота/широта. */
  points: { pixel: Vec2; lonLat: LonLat }[];
  /** Система координат файла — для подписи. */
  crs: string;
  /** Исходный размер, если снимок уменьшен. */
  reducedFrom?: ImageSize;
}

export async function readGeoTiff(file: Blob): Promise<GeoTiffResult | { error: string }> {
  let tiff: GeoTIFF;
  try {
    tiff = await fromBlob(file);
  } catch {
    return { error: 'Это не TIFF или файл повреждён.' };
  }
  try {
    const main = await tiff.getImage(0);
    const width = main.getWidth();
    const height = main.getHeight();
    const keys = main.getGeoKeys();
    const crs = crsFromGeoKeys(keys);
    if ('error' in crs) return { error: crs.error };
    const directory = main.fileDirectory;
    const points = controlPoints(
      {
        modelTransformation: directory.getValue('ModelTransformation') as ArrayLike<number> | undefined,
        modelTiepoint: directory.getValue('ModelTiepoint') as ArrayLike<number> | undefined,
        modelPixelScale: directory.getValue('ModelPixelScale') as ArrayLike<number> | undefined,
        pixelIsPoint: keys?.GTRasterTypeGeoKey === 2,
      },
      [width, height],
    );
    if (!points) return { error: 'В файле нет привязки к координатам (это обычный TIFF, не GeoTIFF).' };

    const scale = Math.max(1, Math.max(width, height) / MAX_SIDE);
    const outW = Math.max(1, Math.round(width / scale));
    const outH = Math.max(1, Math.round(height / scale));
    const source = await pickSource(tiff, main, outW);
    const rgba = await readPixels(source, outW, outH, main.getGDALNoData());

    const canvas = new OffscreenCanvas(outW, outH);
    const ctx = canvas.getContext('2d');
    if (!ctx) return { error: 'Браузер не дал холст для снимка.' };
    ctx.putImageData(new ImageData(rgba, outW, outH), 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.92 });
    const bitmap = await createImageBitmap(canvas);
    const sx = outW / width;
    const sy = outH / height;
    return {
      blob,
      bitmap,
      size: [outW, outH],
      points: points.map(({ pixel, model }) => ({ pixel: [pixel[0] * sx, pixel[1] * sy], lonLat: crs.toLonLat(model) })),
      crs: crs.name,
      reducedFrom: scale > 1 ? [width, height] : undefined,
    };
  } catch (error) {
    return { error: `Не получилось прочитать GeoTIFF${error instanceof Error && error.message ? `: ${error.message}` : '.'}` };
  }
}

/** Самый мелкий из уровней (обзоров) файла, который ещё не уже нужной ширины, — читать меньше. */
async function pickSource(tiff: GeoTIFF, main: GeoTIFFImage, outW: number): Promise<GeoTIFFImage> {
  let best = main;
  const count = await tiff.getImageCount();
  for (let i = 1; i < count; i++) {
    const image = await tiff.getImage(i);
    const subfile = Number(image.fileDirectory.getValue('NewSubfileType') ?? 0);
    // Маски прозрачности (бит 4) и чужие страницы (другие пропорции) не годятся.
    if (subfile & 4) continue;
    if (Math.abs(image.getWidth() / image.getHeight() - main.getWidth() / main.getHeight()) > 0.02) continue;
    if (image.getWidth() >= outW && image.getWidth() < best.getWidth()) best = image;
  }
  return best;
}

type Samples = ArrayLike<number> & { width: number; height: number };

/** RGBA уменьшенного снимка: полосами, 16-битные и вещественные значения — растяжкой по яркости. */
async function readPixels(source: GeoTIFFImage, outW: number, outH: number, noData: number | null): Promise<Uint8ClampedArray<ArrayBuffer>> {
  const srcW = source.getWidth();
  const srcH = source.getHeight();
  const rowsPerBand = Math.max(1, Math.floor(BAND_PIXELS / Math.max(1, (srcW * srcH) / outH)));
  const bands = async (each: (data: Samples, row0: number) => void) => {
    for (let row0 = 0; row0 < outH; row0 += rowsPerBand) {
      const row1 = Math.min(outH, row0 + rowsPerBand);
      const y0 = Math.round((row0 * srcH) / outH);
      const y1 = Math.max(y0 + 1, Math.round((row1 * srcH) / outH));
      const data = (await source.readRGB({
        window: [0, y0, srcW, y1],
        width: outW,
        height: row1 - row0,
        interleave: true,
        enableAlpha: true,
        resampleMethod: 'bilinear',
      })) as unknown as Samples;
      each(data, row0);
    }
  };

  // 8 бит — как есть; иначе сначала проход за диапазоном яркости (2–98 %), потом растяжка.
  let lo = 0;
  let hi = 255;
  let alphaMax = 255;
  const bits = source.getBitsPerSample(0);
  const sampleFormat = source.getSampleFormat(0);
  const eightBit = bits === 8 && sampleFormat !== 3;
  if (!eightBit) {
    const values: number[] = [];
    await bands((data) => {
      const channels = Math.round(data.length / (data.width * data.height));
      const step = Math.max(1, Math.floor(data.width * data.height / 20_000));
      for (let p = 0; p < data.width * data.height; p += step) {
        for (let c = 0; c < Math.min(3, channels); c++) {
          const value = data[p * channels + c]!;
          if (Number.isFinite(value) && value !== noData) values.push(value);
        }
      }
    });
    values.sort((a, b) => a - b);
    lo = values[Math.floor(values.length * 0.02)] ?? 0;
    hi = values[Math.floor(values.length * 0.98)] ?? 1;
    if (hi <= lo) hi = lo + 1;
    alphaMax = bits === 16 ? 65535 : 1;
  }

  const rgba = new Uint8ClampedArray(outW * outH * 4);
  const k = 255 / (hi - lo);
  await bands((data, row0) => {
    const count = data.width * data.height;
    const channels = Math.round(data.length / count);
    for (let p = 0; p < count; p++) {
      const base = p * channels;
      const r = data[base]!;
      const g = channels >= 3 ? data[base + 1]! : r;
      const b = channels >= 3 ? data[base + 2]! : r;
      const alpha = channels === 2 ? data[base + 1]! : channels >= 4 ? data[base + 3]! : alphaMax;
      const empty = noData !== null && r === noData && g === noData && b === noData;
      const o = (row0 * outW + p) * 4;
      rgba[o] = (r - lo) * k;
      rgba[o + 1] = (g - lo) * k;
      rgba[o + 2] = (b - lo) * k;
      rgba[o + 3] = empty ? 0 : (alpha / alphaMax) * 255;
    }
  });
  return rgba;
}
