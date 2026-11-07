#!/usr/bin/env node
// Base World, рельеф: высоты Copernicus DEM GLO-30 для района с запасом вокруг.
// Читаем только нужное окно тайла (COG по HTTP range), убираем «горбы» зданий
// (Copernicus — модель поверхности: дома в ней видны), слегка сглаживаем и сохраняем
//   public/data/territories/<id>/terrain.json
//
//   npm run data:fetch:terrain

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bbox as turfBbox, booleanPointInPolygon, buffer, polygon } from '@turf/turf';
import { fromUrl } from 'geotiff';
import { root, territory, writeTerritoryFile } from './lib/osm.mjs';

/** Запас вокруг района, градусы (~4 км): рельеф виден до горизонта при взгляде сверху. */
const MARGIN_DEG = 0.04;
/** Узлы ближе этого расстояния к зданию считаем «крышей», а не землёй, м. */
const BUILDING_MARGIN_M = 8;
const SCALE = 0.1; // дециметры
const CREDIT =
  'Рельеф: Copernicus DEM GLO-30 © DLR e.V. 2010–2014, © Airbus Defence and Space GmbH 2014–2018, ' +
  'предоставлено в рамках программы Copernicus ЕС и ЕКА';

const { south, west, north, east } = territory.bbox;
const area = { south: south - MARGIN_DEG, west: west - MARGIN_DEG, north: north + MARGIN_DEG, east: east + MARGIN_DEG };

const tileLat = Math.floor(area.south);
const tileLon = Math.floor(area.west);
if (Math.floor(area.north) !== tileLat || Math.floor(area.east) !== tileLon) {
  throw new Error('Район с запасом пересекает границу тайлов Copernicus 1°×1° — нужна склейка нескольких тайлов.');
}
const ns = tileLat >= 0 ? 'N' : 'S';
const ew = tileLon >= 0 ? 'E' : 'W';
const name = `Copernicus_DSM_COG_10_${ns}${String(Math.abs(tileLat)).padStart(2, '0')}_00_${ew}${String(Math.abs(tileLon)).padStart(3, '0')}_00_DEM`;
const url = `https://copernicus-dem-30m.s3.amazonaws.com/${name}/${name}.tif`;

console.log(`Рельеф: ${territory.name} (${territory.id})`);
console.log(`→ ${url}`);
const tiff = await fromUrl(url);
const image = await tiff.getImage();
const [originLon, originLat] = image.getOrigin();
const [resLon, resLat] = image.getResolution(); // resLat < 0

const x0 = Math.floor((area.west - originLon) / resLon);
const x1 = Math.ceil((area.east - originLon) / resLon) + 1;
const y0 = Math.floor((area.north - originLat) / resLat);
const y1 = Math.ceil((area.south - originLat) / resLat) + 1;
const [raster] = await image.readRasters({ window: [x0, y0, x1, y1], samples: [0] });
const width = x1 - x0;
const height = y1 - y0;
const values = Float32Array.from(raster);

// Узлы сетки — центры пикселей.
const lonAt = (x) => originLon + (x0 + x + 0.5) * resLon;
const latAt = (y) => originLat + (y0 + y + 0.5) * resLat;
const gridBbox = { west: lonAt(0), east: lonAt(width - 1), north: latAt(0), south: latAt(height - 1) };
console.log(`  окно ${width}×${height} узлов, шаг ≈ ${Math.round(Math.abs(resLat) * 111_320)} м`);

// --- убираем здания -----------------------------------------------------------
const buildings = JSON.parse(
  readFileSync(join(root, 'public', 'data', 'territories', territory.id, 'buildings.geojson'), 'utf8'),
).features;
const masked = new Uint8Array(width * height);
const col = (lon) => (lon - gridBbox.west) / (gridBbox.east - gridBbox.west) * (width - 1);
const row = (lat) => (gridBbox.north - lat) / (gridBbox.north - gridBbox.south) * (height - 1);

for (const feature of buildings) {
  const grown = buffer(feature, BUILDING_MARGIN_M, { units: 'meters', steps: 2 });
  if (!grown) continue;
  const [minX, minY, maxX, maxY] = turfBbox(grown);
  for (let y = Math.max(0, Math.floor(row(maxY))); y <= Math.min(height - 1, Math.ceil(row(minY))); y++) {
    for (let x = Math.max(0, Math.floor(col(minX))); x <= Math.min(width - 1, Math.ceil(col(maxX))); x++) {
      if (!masked[y * width + x] && booleanPointInPolygon([lonAt(x), latAt(y)], grown)) masked[y * width + x] = 1;
    }
  }
}
const maskedCount = masked.reduce((sum, m) => sum + m, 0);

// Заполняем узлы под зданиями: сначала «заливкой» от соседей, потом релаксацией (Лаплас).
const neighbors = (i) => {
  const x = i % width;
  const y = (i - x) / width;
  const list = [];
  if (x > 0) list.push(i - 1);
  if (x < width - 1) list.push(i + 1);
  if (y > 0) list.push(i - width);
  if (y < height - 1) list.push(i + width);
  return list;
};
const known = new Uint8Array(width * height);
for (let i = 0; i < known.length; i++) known[i] = masked[i] ? 0 : 1;
let frontier = true;
while (frontier) {
  frontier = false;
  const next = [];
  for (let i = 0; i < values.length; i++) {
    if (known[i]) continue;
    const around = neighbors(i).filter((j) => known[j]);
    if (!around.length) continue;
    next.push([i, around.reduce((s, j) => s + values[j], 0) / around.length]);
  }
  for (const [i, v] of next) {
    values[i] = v;
    known[i] = 1;
    frontier = true;
  }
}
for (let iteration = 0; iteration < 60; iteration++) {
  for (let i = 0; i < values.length; i++) {
    if (!masked[i]) continue;
    const around = neighbors(i);
    values[i] = around.reduce((s, j) => s + values[j], 0) / around.length;
  }
}

// Лёгкое сглаживание 3×3 — убирает шум радарной съёмки.
const smoothed = new Float32Array(values.length);
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    let sum = 0;
    let weight = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
        const w = dx === 0 && dy === 0 ? 4 : dx === 0 || dy === 0 ? 2 : 1;
        sum += values[yy * width + xx] * w;
        weight += w;
      }
    }
    smoothed[y * width + x] = sum / weight;
  }
}

// --- запись --------------------------------------------------------------------
const packed = new Int16Array(smoothed.length);
let min = Infinity;
let max = -Infinity;
for (let i = 0; i < smoothed.length; i++) {
  packed[i] = Math.round(smoothed[i] / SCALE);
  min = Math.min(min, smoothed[i]);
  max = Math.max(max, smoothed[i]);
}

const file = writeTerritoryFile('terrain.json', {
  metadata: {
    source: `Copernicus DEM GLO-30 (${name})`,
    license: 'Copernicus DEM — свободная лицензия с указанием источника',
    credit: CREDIT,
    fetchedAt: new Date().toISOString(),
    buildingsMasked: maskedCount,
  },
  bbox: gridBbox,
  width,
  height,
  scale: SCALE,
  offset: 0,
  heights: Buffer.from(packed.buffer).toString('base64'),
});

console.log(`\n✓ Рельеф: ${width}×${height} узлов, высоты ${min.toFixed(0)}–${max.toFixed(0)} м над уровнем моря`);
console.log(`  узлов под зданиями заменено: ${maskedCount}`);
console.log(`  → ${file}`);
