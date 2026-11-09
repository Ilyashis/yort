#!/usr/bin/env node
// Подробный рельеф по своей съёмке с дрона: модель земли (DTM, GeoTIFF с привязкой к карте) из OpenDroneMap
// → сетка в долготе/широте с шагом ~1 м → public/data/territories/<id>/terrain-detail.json.
// Приложение кладёт её поверх общего рельефа Copernicus: внутри снятого — съёмка, к краям — плавный переход.
//
//   TERRITORY=itkulovo-1 node scripts/drone-terrain.mjs --dtm=/путь/к/dtm.tif [--res=1] [--fade=40] [--no-align]
//
// Перепроецирует GDAL из образа OpenDroneMap (нужен запущенный Docker) — ставить GDAL отдельно не нужно.
// Высоты подгоняются к Copernicus одной поправкой (медиана разницы по снятому): у съёмки без координат
// абсолютной высоты нет, а форма рельефа у неё точнее. --no-align — оставить высоты как в файле.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fromFile } from 'geotiff';
import { root, territory, writeTerritoryFile } from './lib/osm.mjs';

const ODM_IMAGE = 'opendronemap/odm:latest';
const GDALWARP = '/code/SuperBuild/install/bin/gdalwarp';
const M_PER_DEG_LAT = 111_320;
const NODATA = -32768;
const SCALE = 0.1;

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true;
};

const dtm = arg('dtm');
if (!dtm || dtm === true) {
  console.error('Укажите модель земли: --dtm=/путь/к/dtm.tif (GeoTIFF с привязкой, например odm_dem/dtm.tif)');
  process.exit(1);
}
const res = Number(arg('res', 1));
const fade = Number(arg('fade', 40));
const align = !arg('no-align', false);
const { south, west, north, east } = territory.bbox;
const lat0 = (south + north) / 2;

console.log(`Подробный рельеф: ${territory.name} (${territory.id}) из ${dtm}, шаг ${res} м`);

// 1. GDAL: в долготу/широту с нужным шагом (билинейно), «нет данных» — −9999.
const input = resolve(String(dtm));
const work = mkdtempSync(join(tmpdir(), 'citia-drone-'));
const dLat = res / M_PER_DEG_LAT;
const dLon = res / (M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180));
try {
  execFileSync(
    'docker',
    [
      'run', '--rm',
      '-v', `${dirname(input)}:/in:ro`,
      '-v', `${work}:/out`,
      '--entrypoint', GDALWARP,
      ODM_IMAGE,
      '-q', '-overwrite',
      '-t_srs', 'EPSG:4326',
      '-tr', String(dLon), String(dLat),
      '-r', 'bilinear',
      '-dstnodata', '-9999',
      '-ot', 'Float32',
      `/in/${basename(input)}`,
      '/out/dtm-4326.tif',
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );

  // 2. Читаем сетку: узлы — центры пикселей, строка 0 — север.
  const image = await (await fromFile(join(work, 'dtm-4326.tif'))).getImage();
  const [minX, minY, maxX, maxY] = image.getBoundingBox();
  const width = image.getWidth();
  const height = image.getHeight();
  const pw = (maxX - minX) / width;
  const ph = (maxY - minY) / height;
  const raster = await image.readRasters({ interleave: true });
  const noData = image.getGDALNoData() ?? -9999;

  // Обрезаем по границам района.
  const col = (lon) => (lon - (minX + pw / 2)) / pw;
  const row = (lat) => (maxY - ph / 2 - lat) / ph;
  const c0 = Math.max(0, Math.ceil(col(west)));
  const c1 = Math.min(width - 1, Math.floor(col(east)));
  const r0 = Math.max(0, Math.ceil(row(north)));
  const r1 = Math.min(height - 1, Math.floor(row(south)));
  if (c1 - c0 < 2 || r1 - r0 < 2) throw new Error('Модель земли не пересекается с районом — проверьте привязку GeoTIFF.');
  const w = c1 - c0 + 1;
  const h = r1 - r0 + 1;
  const bbox = {
    west: minX + pw / 2 + c0 * pw,
    east: minX + pw / 2 + c1 * pw,
    north: maxY - ph / 2 - r0 * ph,
    south: maxY - ph / 2 - r1 * ph,
  };
  const values = new Float32Array(w * h);
  let valid = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = raster[(r0 + y) * width + (c0 + x)];
      const ok = Number.isFinite(v) && v !== noData && v > -1000;
      values[y * w + x] = ok ? v : Number.NaN;
      if (ok) valid++;
    }
  }
  console.log(`  сетка ${w} × ${h}, снято ${((valid / values.length) * 100).toFixed(0)}% площади`);

  // 3. Подгонка к Copernicus одной поправкой по высоте (медиана разницы).
  const base = baseHeights();
  const diffs = [];
  for (let y = 0; y < h; y += 4) {
    for (let x = 0; x < w; x += 4) {
      const v = values[y * w + x];
      if (Number.isNaN(v)) continue;
      const lon = bbox.west + ((bbox.east - bbox.west) * x) / (w - 1);
      const lat = bbox.north - ((bbox.north - bbox.south) * y) / (h - 1);
      diffs.push(v - base(lon, lat));
    }
  }
  diffs.sort((a, b) => a - b);
  const pct = (p) => diffs[Math.min(diffs.length - 1, Math.floor(diffs.length * p))] ?? 0;
  const shift = align ? pct(0.5) : 0;
  console.log(
    `  съёмка − Copernicus: медиана ${pct(0.5).toFixed(2)} м, 10–90%: ${pct(0.1).toFixed(2)}…${pct(0.9).toFixed(2)} м` +
      (align ? ` → сдвигаем на ${(-shift).toFixed(2)} м` : ' (без подгонки)'),
  );

  // 4. Дециметры Int16 со сдвигом, «нет данных» — −32768.
  let sum = 0;
  for (const v of values) if (!Number.isNaN(v)) sum += v - shift;
  const offset = Math.round(sum / Math.max(valid, 1));
  const ints = new Int16Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    ints[i] = Number.isNaN(v) ? NODATA : Math.max(-32767, Math.min(32767, Math.round((v - shift - offset) / SCALE)));
  }
  const file = writeTerritoryFile('terrain-detail.json', {
    metadata: {
      source: `Своя съёмка с дрона, модель земли OpenDroneMap (${basename(input)})`,
      license: 'Собственная съёмка',
      credit: 'Рельеф деревни: своя съёмка с дрона',
      resolution: res,
      alignedShift: Number((-shift).toFixed(3)),
      createdAt: new Date().toISOString(),
    },
    bbox,
    width: w,
    height: h,
    scale: SCALE,
    offset,
    nodata: NODATA,
    fade,
    heights: Buffer.from(ints.buffer).toString('base64'),
  });
  console.log(`  → ${file}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

/** Общий рельеф района (terrain.json): билинейно по сетке Copernicus. */
function baseHeights() {
  const path = join(root, 'public', 'data', 'territories', territory.id, 'terrain.json');
  const t = JSON.parse(readFileSync(path, 'utf8'));
  const bytes = Buffer.from(t.heights, 'base64');
  const raw = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  const at = (x, y) => raw[y * t.width + x] * t.scale + t.offset;
  return (lon, lat) => {
    const fx = Math.min(Math.max(((lon - t.bbox.west) / (t.bbox.east - t.bbox.west)) * (t.width - 1), 0), t.width - 1.001);
    const fy = Math.min(Math.max(((t.bbox.north - lat) / (t.bbox.north - t.bbox.south)) * (t.height - 1), 0), t.height - 1.001);
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    return (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty;
  };
}
