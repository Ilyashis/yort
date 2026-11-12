// Ортофото своей съёмки с дрона как цвет земли: одна текстура с прозрачностью (её готовит
// scripts/drone/web_ortho.py) и привязка к миру. Землю и траву красят по ней там, где снимок есть.

import { CanvasTexture, LinearFilter, LinearMipmapLinearFilter, SRGBColorSpace, TextureLoader, type Texture } from 'three';
import type { World } from '../core/data';

/** Общие для земли и травы значения: снимок, его прямоугольник в мире (x0, z0, ширина, глубина), включён ли. */
export interface OrthoUniforms {
  uOrtho: { value: Texture | null };
  uOrthoRect: { value: [number, number, number, number] };
  uOrthoOn: { value: number };
}

export const createOrthoUniforms = (): OrthoUniforms => ({ uOrtho: { value: null }, uOrthoRect: { value: [0, 0, 1, 1] }, uOrthoOn: { value: 0 } });

/** Цвет снимка в точке мира и его непрозрачность (0 — снимка здесь нет или он выключен). */
export const ORTHO_GLSL = /* glsl */ `
uniform sampler2D uOrtho;
uniform vec4 uOrthoRect;
uniform float uOrthoOn;
vec4 orthoAt(vec2 xz) {
  vec2 uv = (xz - uOrthoRect.xy) / uOrthoRect.zw;
  if (uOrthoOn < 0.5 || uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec4(0.0);
  vec4 c = texture2D(uOrtho, uv);
  // Снимок сделан на солнце и уже светлый; как цвет поверхности его надо приглушить, иначе грунт выгорает добела.
  float luma = dot(c.rgb, vec3(0.3, 0.55, 0.15));
  return vec4(c.rgb * (0.86 - 0.3 * smoothstep(0.35, 0.9, luma)), c.a);
}
`;

interface OrthoFile {
  west: number;
  south: number;
  east: number;
  north: number;
}

const base = (world: World) => `${import.meta.env.BASE_URL}data/territories/${world.territory.id}/`;

/** Есть ли у места ортофото: его привязка или undefined. */
export async function findOrtho(world: World): Promise<OrthoFile | undefined> {
  try {
    const res = await fetch(`${base(world)}ortho.json`);
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return undefined;
    return (await res.json()) as OrthoFile;
  } catch {
    return undefined;
  }
}

/** Загрузить снимок с дрона: текстура и её прямоугольник в мире. */
export async function loadOrtho(world: World, file: OrthoFile, anisotropy: number): Promise<{ texture: Texture; rect: [number, number, number, number] }> {
  const texture = await new TextureLoader().loadAsync(`${base(world)}ortho.webp`);
  texture.colorSpace = SRGBColorSpace;
  texture.flipY = false;
  texture.generateMipmaps = true;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.anisotropy = anisotropy;
  const x0 = world.frame.x(file.west), z0 = world.frame.z(file.north);
  return { texture, rect: [x0, z0, world.frame.x(file.east) - x0, world.frame.z(file.south) - z0] };
}

/** Откуда берётся спутниковый снимок: адрес плитки и подпись, которую обязан показывать сайт. */
export interface SatelliteSource {
  id: 'esri' | 'mapbox' | 'microsoft';
  credit: string;
  url: (z: number, x: number, y: number) => string;
}

/**
 * Источник спутникового снимка — по тому, какой ключ лежит в .env.local:
 *   VITE_MAPBOX_TOKEN — Mapbox Satellite (публичный токен pk.…);
 *   VITE_AZURE_MAPS_KEY — аэрофотоснимки Microsoft, те же, что в Bing Maps (отдельных ключей Bing Maps
 *   Microsoft больше не выдаёт, их снимки раздаёт Azure Maps);
 *   без ключей — Esri World Imagery.
 */
export function satelliteSource(): SatelliteSource {
  const mapbox = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined;
  if (mapbox) {
    return {
      id: 'mapbox',
      credit: '© Mapbox © OpenStreetMap © Maxar',
      url: (z, x, y) => `https://api.mapbox.com/v4/mapbox.satellite/${z}/${x}/${y}.jpg90?access_token=${encodeURIComponent(mapbox)}`,
    };
  }
  const key = import.meta.env.VITE_AZURE_MAPS_KEY as string | undefined;
  if (key) {
    return {
      id: 'microsoft',
      credit: '© Microsoft, Vexcel Imaging, Maxar',
      url: (z, x, y) => `https://atlas.microsoft.com/map/tile?api-version=2024-04-01&tilesetId=microsoft.imagery&zoom=${z}&x=${x}&y=${y}&tileSize=256&subscription-key=${encodeURIComponent(key)}`,
    };
  }
  return {
    id: 'esri',
    credit: '© Esri, Maxar, Earthstar Geographics',
    url: (z, x, y) => `https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
  };
}

/** Сторона мозаики не больше этого, пикселей. */
const MOSAIC = 5120;

/**
 * Спутниковый снимок места: плитки веб-карты (проекция Меркатора) складываются в один холст, растянутый
 * равномерно по долготе и широте — как сам мир приложения. Холст сразу становится текстурой и дорисовывается
 * по мере загрузки плиток; alive() = false — место сменили, грузить дальше незачем.
 */
export function loadSatellite(world: World, source: SatelliteSource, anisotropy: number, alive: () => boolean): { texture: CanvasTexture; rect: [number, number, number, number]; done: Promise<number> } {
  const { west, south, east, north } = world.territory.bbox;
  const metresWide = world.frame.x(east) - world.frame.x(west), metresTall = world.frame.z(south) - world.frame.z(north);
  // Самый подробный уровень, при котором мозаика ещё помещается в одну текстуру.
  const mercY = (lat: number, n: number) => ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n;
  let z = 19;
  for (; z > 10; z--) {
    const n = 2 ** z;
    if (((east - west) / 360) * n * 256 <= MOSAIC && (mercY(south, n) - mercY(north, n)) * 256 <= MOSAIC) break;
  }
  const n = 2 ** z;
  const x0 = Math.floor(((west + 180) / 360) * n), x1 = Math.floor(((east + 180) / 360) * n);
  const y0 = Math.floor(mercY(north, n)), y1 = Math.floor(mercY(south, n));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(((east - west) / 360) * n * 256);
  canvas.height = Math.round((canvas.width * metresTall) / metresWide);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#4a5a3c';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.flipY = false;
  texture.generateMipmaps = true;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.anisotropy = anisotropy;

  const lonOf = (x: number) => (x / n) * 360 - 180;
  const latOf = (y: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  const px = (lon: number) => ((lon - west) / (east - west)) * canvas.width;
  const py = (lat: number) => ((north - lat) / (north - south)) * canvas.height;
  const queue: [number, number][] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) queue.push([x, y]);
  // Сначала середина: туда камера смотрит при открытии.
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  queue.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy));
  let loaded = 0, since = 0;
  const worker = async () => {
    for (let tile = queue.shift(); tile && alive(); tile = queue.shift()) {
      const [x, y] = tile;
      await new Promise<void>((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          // Внутри одной плитки широта меняется почти линейно — растягиваем плитку по её краям.
          const left = px(lonOf(x)), top = py(latOf(y));
          ctx.drawImage(img, left, top, px(lonOf(x + 1)) - left + 0.6, py(latOf(y + 1)) - top + 0.6);
          loaded++;
          if (++since >= 12) {
            since = 0;
            texture.needsUpdate = true;
          }
          resolve();
        };
        img.onerror = () => resolve();
        img.src = source.url(z, x, y);
      });
    }
  };
  const done = Promise.all(Array.from({ length: 8 }, worker)).then(() => {
    texture.needsUpdate = true;
    return loaded;
  });
  return { texture, rect: [world.frame.x(west), world.frame.z(north), metresWide, metresTall], done };
}
