/**
 * Сетка высот рельефа (Base World): равномерная по долготе/широте, строки — с севера на юг.
 * Высоты в метрах над уровнем моря; между узлами — билинейная интерполяция.
 * За пределами сетки рельеф плавно переходит к средней высоте, чтобы на краю не было «стены».
 */

/** dem — свой рельеф Copernicus из файла района; flat — без рельефа (файла нет). */
export type TerrainKind = 'dem' | 'flat';

export interface HeightGridData {
  /** Границы сетки: узлы лежат точно на краях. */
  bbox: { west: number; south: number; east: number; north: number };
  width: number;
  height: number;
  /** width × height значений, строка 0 — северный край. */
  values: Float32Array;
}

const M_PER_DEG_LAT = 111_320;
/** На каком расстоянии за краем сетки (м) рельеф выходит на среднюю высоту. */
const FADE_OUTSIDE_M = 3000;

export class HeightGrid {
  readonly bbox: HeightGridData['bbox'];
  readonly width: number;
  readonly height: number;
  readonly mean: number;
  readonly min: number;
  readonly max: number;
  private readonly values: Float32Array;
  private readonly mPerDegLon: number;

  constructor(data: HeightGridData) {
    this.bbox = data.bbox;
    this.width = data.width;
    this.height = data.height;
    this.values = data.values;
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    for (const v of data.values) {
      sum += v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    this.mean = sum / data.values.length;
    this.min = min;
    this.max = max;
    this.mPerDegLon = M_PER_DEG_LAT * Math.cos((((data.bbox.south + data.bbox.north) / 2) * Math.PI) / 180);
  }

  /** Высота в точке (долгота, широта в градусах). */
  heightAt(lon: number, lat: number): number {
    const { west, south, east, north } = this.bbox;
    const clampedLon = Math.min(Math.max(lon, west), east);
    const clampedLat = Math.min(Math.max(lat, south), north);
    const inside = this.sample(clampedLon, clampedLat);
    if (clampedLon === lon && clampedLat === lat) return inside;

    // Снаружи: значение с края сетки, плавно уходящее к средней высоте.
    const outside = Math.hypot((lon - clampedLon) * this.mPerDegLon, (lat - clampedLat) * M_PER_DEG_LAT);
    const t = Math.min(outside / FADE_OUTSIDE_M, 1);
    const smooth = t * t * (3 - 2 * t);
    return inside + (this.mean - inside) * smooth;
  }

  private sample(lon: number, lat: number): number {
    const { west, south, east, north } = this.bbox;
    const fx = ((lon - west) / (east - west)) * (this.width - 1);
    const fy = ((north - lat) / (north - south)) * (this.height - 1);
    const x0 = Math.min(Math.floor(fx), this.width - 2);
    const y0 = Math.min(Math.floor(fy), this.height - 2);
    const tx = fx - x0;
    const ty = fy - y0;
    const at = (x: number, y: number) => this.values[y * this.width + x]!;
    const top = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx;
    const bottom = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx;
    return top * (1 - ty) + bottom * ty;
  }
}

/** Файл рельефа территории: высоты в дециметрах (Int16) в base64 — компактно и без потерь для 30-м данных. */
export interface TerrainFile {
  metadata: { source: string; license: string; credit: string };
  bbox: HeightGridData['bbox'];
  width: number;
  height: number;
  /** Высота = value × scale + offset, м. */
  scale: number;
  offset: number;
  heights: string;
}

export function decodeTerrainFile(file: TerrainFile): HeightGrid {
  const bytes = Uint8Array.from(atob(file.heights), (c) => c.charCodeAt(0));
  const raw = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  const values = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) values[i] = raw[i]! * file.scale + file.offset;
  return new HeightGrid({ bbox: file.bbox, width: file.width, height: file.height, values });
}
