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
import { fetchOverpass, relationToGeometry, root, territory, wayToPolygon, writeTerritoryFile } from './lib/osm.mjs';

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

/** Имя тайла Copernicus 1°×1° по его юго-западному углу. */
function tileName(lat, lon) {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `Copernicus_DSM_COG_10_${ns}${String(Math.abs(lat)).padStart(2, '0')}_00_${ew}${String(Math.abs(lon)).padStart(3, '0')}_00_DEM`;
}
const tileUrl = (name) => `https://copernicus-dem-30m.s3.amazonaws.com/${name}/${name}.tif`;

// Район с запасом может задевать несколько тайлов — читаем из каждого своё окно и склеиваем.
const tiles = [];
for (let lat = Math.floor(area.north); lat >= Math.floor(area.south); lat--) {
  for (let lon = Math.floor(area.west); lon <= Math.floor(area.east); lon++) tiles.push(tileName(lat, lon));
}

console.log(`Рельеф: ${territory.name} (${territory.id})`);
// Сетку задаёт северо-западный тайл; у соседних тот же шаг, их пиксели продолжают её без зазоров.
const reference = await (await fromUrl(tileUrl(tiles[0]))).getImage();
const [originLon, originLat] = reference.getOrigin();
const [resLon, resLat] = reference.getResolution(); // resLat < 0

const x0 = Math.floor((area.west - originLon) / resLon);
const x1 = Math.ceil((area.east - originLon) / resLon) + 1;
const y0 = Math.floor((area.north - originLat) / resLat);
const y1 = Math.ceil((area.south - originLat) / resLat) + 1;
const width = x1 - x0;
const height = y1 - y0;
const values = new Float32Array(width * height).fill(Number.NaN);

for (const name of tiles) {
  console.log(`→ ${tileUrl(name)}`);
  const image = name === tiles[0] ? reference : await (await fromUrl(tileUrl(name))).getImage();
  const [tileLon, tileLat] = image.getOrigin();
  const [tileResLon, tileResLat] = image.getResolution();
  if (Math.abs(tileResLon - resLon) > 1e-12 || Math.abs(tileResLat - resLat) > 1e-12) {
    throw new Error(`У тайла ${name} другой шаг сетки — склейка таких тайлов не поддерживается.`);
  }
  // Сдвиг тайла в пикселях общей сетки.
  const dx = Math.round((tileLon - originLon) / resLon);
  const dy = Math.round((tileLat - originLat) / resLat);
  const tx0 = Math.max(0, x0 - dx);
  const tx1 = Math.min(image.getWidth(), x1 - dx);
  const ty0 = Math.max(0, y0 - dy);
  const ty1 = Math.min(image.getHeight(), y1 - dy);
  if (tx0 >= tx1 || ty0 >= ty1) continue;
  const [raster] = await image.readRasters({ window: [tx0, ty0, tx1, ty1], samples: [0] });
  const windowWidth = tx1 - tx0;
  for (let ty = ty0; ty < ty1; ty++) {
    for (let tx = tx0; tx < tx1; tx++) {
      values[(dy + ty - y0) * width + (dx + tx - x0)] = raster[(ty - ty0) * windowWidth + (tx - tx0)];
    }
  }
}
if (values.some((v) => Number.isNaN(v))) {
  throw new Error('Часть района не покрыта тайлами Copernicus (нет тайла над водой?) — рельеф не собрать.');
}

// Узлы сетки — центры пикселей. У тайлов Copernicus растр «PixelIsPoint»: координата угла —
// это уже центр первого пикселя, а не его край (иначе рельеф съезжает на полпикселя, ~15 м).
const pixelIsPoint = reference.getGeoKeys()?.GTRasterTypeGeoKey === 2;
const half = pixelIsPoint ? 0 : 0.5;
const lonAt = (x) => originLon + (x0 + x + half) * resLon;
const latAt = (y) => originLat + (y0 + y + half) * resLat;
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

// --- лес -------------------------------------------------------------------------
// Copernicus — модель поверхности: в лесу это верх крон, и залесённые склоны «вспухают»
// на высоту деревьев. Берём леса из OSM на всё окно рельефа, оцениваем высоту крон
// на опушках и опускаем лес на неё — плавно, от опушки вглубь.
const CANOPY = { feather: 40, sampleDepth: [45, 120], openDistance: [30, 150], window: 5, minSamples: 30, min: 3, max: 25 };
const mPerDegLat = 111_320;
const stepX = Math.abs(resLon) * mPerDegLat * Math.cos((((area.south + area.north) / 2) * Math.PI) / 180);
const stepY = Math.abs(resLat) * mPerDegLat;

const forestBox = `${area.south},${area.west},${area.north},${area.east}`;
console.log('  леса для поправки на кроны (OSM)…');
const { json: forestJson } = await fetchOverpass(`[out:json][timeout:180];
(
  way["landuse"="forest"](${forestBox});
  way["natural"="wood"](${forestBox});
  relation["landuse"="forest"]["type"="multipolygon"](${forestBox});
  relation["natural"="wood"]["type"="multipolygon"](${forestBox});
);
out geom;`);
const forestPolygons = forestJson.elements.flatMap((el) => {
  const geometry = el.type === 'way' ? wayToPolygon(el) : el.type === 'relation' ? relationToGeometry(el) : undefined;
  if (!geometry) return [];
  return geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
});
const forest = rasterize(forestPolygons);
const forestCount = forest.reduce((sum, f) => sum + f, 0);
const depth = distanceTo(forest, 1); // в лесу: расстояние до опушки, м
const openDistance = distanceTo(forest, 0); // на открытом месте: расстояние до леса, м

let canopy = 0;
const samples = [];
for (let y = 0; y < height; y += 2) {
  for (let x = 0; x < width; x += 2) {
    const i = y * width + x;
    if (!forest[i] || depth[i] < CANOPY.sampleDepth[0] || depth[i] > CANOPY.sampleDepth[1]) continue;
    // Плоскость по открытой земле вокруг: насколько лес над ней — это и есть кроны (склон учтён).
    const points = [];
    for (let dy = -CANOPY.window; dy <= CANOPY.window; dy++) {
      for (let dx = -CANOPY.window; dx <= CANOPY.window; dx++) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
        const j = yy * width + xx;
        if (forest[j] || openDistance[j] < CANOPY.openDistance[0] || openDistance[j] > CANOPY.openDistance[1]) continue;
        points.push([dx * stepX, dy * stepY, values[j]]);
      }
    }
    const plane = fitPlane(points);
    if (plane !== undefined) samples.push(values[i] - plane);
  }
}
if (samples.length >= CANOPY.minSamples) {
  samples.sort((a, b) => a - b);
  canopy = Math.min(Math.max(samples[Math.floor(samples.length / 2)], CANOPY.min), CANOPY.max);
  for (let i = 0; i < values.length; i++) {
    if (!forest[i]) continue;
    const t = Math.min(depth[i] / CANOPY.feather, 1);
    values[i] -= canopy * t * t * (3 - 2 * t);
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
    source: `Copernicus DEM GLO-30 (${tiles.join(', ')})`,
    license: 'Copernicus DEM — свободная лицензия с указанием источника',
    credit: CREDIT,
    fetchedAt: new Date().toISOString(),
    buildingsMasked: maskedCount,
    pixelIsPoint,
    forestNodes: forestCount,
    forestCanopyM: Math.round(canopy * 10) / 10,
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
console.log(
  canopy
    ? `  лес: ${forestCount} узлов, высота крон по опушкам ≈ ${canopy.toFixed(1)} м (замеров ${samples.length}) — вычтена`
    : `  лес: ${forestCount} узлов, замеров на опушках мало (${samples.length}) — поправки нет`,
);
console.log(`  → ${file}`);

// --- вспомогательное ------------------------------------------------------------

/** Полигоны [lon, lat] → маска узлов сетки (чётно-нечётное правило внутри полигона, дыры — дыры). */
function rasterize(polygons) {
  const mask = new Uint8Array(width * height);
  const colOf = (lon) => (lon - lonAt(0)) / resLon;
  for (const rings of polygons) {
    const edges = rings.flatMap((ring) => ring.slice(1).map((b, k) => [ring[k], b]));
    let minLat = Infinity;
    let maxLat = -Infinity;
    for (const ring of rings) for (const [, lat] of ring) { minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat); }
    const yFrom = Math.max(0, Math.ceil((maxLat - latAt(0)) / resLat));
    const yTo = Math.min(height - 1, Math.floor((minLat - latAt(0)) / resLat));
    for (let y = yFrom; y <= yTo; y++) {
      const lat = latAt(y);
      const crossings = [];
      for (const [[ax, ay], [bx, by]] of edges) {
        if (ay > lat !== by > lat) crossings.push(ax + ((lat - ay) * (bx - ax)) / (by - ay));
      }
      crossings.sort((a, b) => a - b);
      for (let k = 0; k + 1 < crossings.length; k += 2) {
        const from = Math.max(0, Math.ceil(colOf(crossings[k])));
        const to = Math.min(width - 1, Math.floor(colOf(crossings[k + 1])));
        for (let x = from; x <= to; x++) mask[y * width + x] = 1;
      }
    }
  }
  return mask;
}

/** Для узлов со значением value в маске — расстояние (м) до ближайшего узла с другим значением (фаска 3×3). */
function distanceTo(mask, value) {
  const dist = new Float32Array(width * height);
  for (let i = 0; i < dist.length; i++) dist[i] = mask[i] === value ? Infinity : 0;
  const diagonal = Math.hypot(stepX, stepY);
  const relax = (i, j, step) => {
    if (dist[j] + step < dist[i]) dist[i] = dist[j] + step;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (x > 0) relax(i, i - 1, stepX);
      if (y > 0) {
        relax(i, i - width, stepY);
        if (x > 0) relax(i, i - width - 1, diagonal);
        if (x < width - 1) relax(i, i - width + 1, diagonal);
      }
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      if (x < width - 1) relax(i, i + 1, stepX);
      if (y < height - 1) {
        relax(i, i + width, stepY);
        if (x < width - 1) relax(i, i + width + 1, diagonal);
        if (x > 0) relax(i, i + width - 1, diagonal);
      }
    }
  }
  return dist;
}

/** Плоскость z = a + b·x + c·y по точкам [x, y, z] (МНК); возвращает a — высоту в начале координат. */
function fitPlane(points) {
  if (points.length < 8) return undefined;
  let n = 0, sx = 0, sy = 0, sz = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0;
  for (const [x, y, z] of points) {
    n++; sx += x; sy += y; sz += z; sxx += x * x; syy += y * y; sxy += x * y; sxz += x * z; syz += y * z;
  }
  // Нормальные уравнения 3×3, правило Крамера.
  const m = [[n, sx, sy], [sx, sxx, sxy], [sy, sxy, syy]];
  const r = [sz, sxz, syz];
  const det = (a) =>
    a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) -
    a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) +
    a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
  const d = det(m);
  if (Math.abs(d) < 1e-6) return undefined;
  const withR = m.map((row, k) => [r[k], row[1], row[2]]);
  return det(withR) / d;
}
