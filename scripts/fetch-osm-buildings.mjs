#!/usr/bin/env node
// Подготовка Base World: выгружает здания территории из OpenStreetMap (Overpass API),
// считает высоты и сохраняет компактный GeoJSON в public/data/territories/<id>/buildings.geojson.
//
//   npm run data:fetch
//   OVERPASS_URL=https://... npm run data:fetch   — свой сервер Overpass

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const territory = JSON.parse(readFileSync(join(root, 'src/config/territory.json'), 'utf8'));

const ENDPOINTS = process.env.OVERPASS_URL
  ? [process.env.OVERPASS_URL]
  : [
      'https://overpass-api.de/api/interpreter',
      'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
      'https://overpass.private.coffee/api/interpreter',
    ];

/** Высота одного этажа, м. */
const LEVEL_HEIGHT = 3.2;
/** Высота по умолчанию, если в OSM нет ни height, ни building:levels, м. */
const DEFAULT_HEIGHT_BY_TYPE = {
  house: 7, detached: 7, semidetached_house: 7, terrace: 7, bungalow: 4,
  residential: 12, apartments: 15, dormitory: 15, hotel: 15,
  garage: 3, garages: 3, shed: 3, hut: 3, kiosk: 3, service: 4, roof: 4,
  transformer_tower: 4, toilets: 3, construction: 6,
  retail: 6, commercial: 9, office: 12, industrial: 8, warehouse: 7,
  school: 12, kindergarten: 7, college: 12, university: 15, hospital: 15,
  public: 12, civic: 12, government: 15,
  church: 15, cathedral: 20, chapel: 7, mosque: 12, synagogue: 12,
  theatre: 18,
};
const FALLBACK_HEIGHT = 9;
const COORD_PRECISION = 1e7; // ~1 см

// ---------------------------------------------------------------------------

/** Публичные серверы Overpass часто перегружены — обходим их по кругу несколько раз. */
async function fetchOverpass(query, rounds = 3) {
  for (let round = 1; round <= rounds; round++) {
    if (round > 1) {
      const pause = 20 * (round - 1);
      console.log(`  …повтор через ${pause} с (попытка ${round}/${rounds})`);
      await new Promise((resolve) => setTimeout(resolve, pause * 1000));
    }
    const result = await tryEndpoints(query);
    if (result) return result;
  }
  throw new Error('Ни один сервер Overpass не ответил. Попробуйте позже или задайте OVERPASS_URL.');
}

async function tryEndpoints(query) {
  for (const url of ENDPOINTS) {
    try {
      console.log(`→ ${url}`);
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'citia-prototype/0.1',
        },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = await response.json();
      if (json.remark) console.warn(`  ! Overpass: ${json.remark}`);
      return { json, url };
    } catch (error) {
      console.warn(`  ✗ ${error.message}`);
    }
  }
  return undefined;
}

// --- разбор тегов ----------------------------------------------------------

/** "12", "12 m", "12,5 м" → 12.5; футы и мусор → undefined. */
function parseMeters(value) {
  if (value == null) return undefined;
  const match = String(value).replace(',', '.').match(/^\s*(\d+(?:\.\d+)?)\s*(m|м|meters?|метр\S*)?\s*$/i);
  if (!match) return undefined;
  const meters = Number(match[1]);
  return meters > 0 && meters < 1000 ? meters : undefined;
}

/** "5", "5;9", "5-9" → максимальное число (≥ 0). */
function parseCount(value) {
  if (value == null) return undefined;
  const numbers = String(value)
    .split(/[;,\-]/)
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isFinite(n) && n >= 0 && n < 200);
  return numbers.length ? Math.max(...numbers) : undefined;
}

const round1 = (n) => Math.round(n * 10) / 10;

function computeHeights(tags) {
  const levels = parseCount(tags['building:levels']) || undefined;
  const roofLevels = parseCount(tags['roof:levels']) ?? 0;
  const explicitHeight = parseMeters(tags.height);

  let height;
  let heightSource;
  if (explicitHeight) {
    height = explicitHeight;
    heightSource = 'height';
  } else if (levels) {
    height = (levels + roofLevels) * LEVEL_HEIGHT;
    heightSource = 'levels';
  } else {
    height = DEFAULT_HEIGHT_BY_TYPE[tags.building] ?? FALLBACK_HEIGHT;
    heightSource = 'default';
  }

  let minHeight =
    parseMeters(tags.min_height) ?? (parseCount(tags['building:min_level']) ?? 0) * LEVEL_HEIGHT;
  // Навесы (building=roof) стоят на опорах — рисуем их как тонкую плиту.
  if (tags.building === 'roof' && minHeight === 0) minHeight = Math.max(height - 1, 0);
  if (minHeight >= height) minHeight = 0;

  return { height: round1(height), minHeight: round1(minHeight), heightSource, levels };
}

function buildProperties(type, element) {
  const tags = element.tags ?? {};
  const street = tags['addr:street'];
  const house = tags['addr:housenumber'];
  const properties = {
    id: `${type}/${element.id}`,
    building: tags.building,
    ...computeHeights(tags),
  };
  if (tags.name) properties.name = tags.name;
  if (street || house) properties.address = [street, house].filter(Boolean).join(', ');
  if (properties.levels === undefined) delete properties.levels;
  return properties;
}

// --- геометрия -------------------------------------------------------------

const toCoord = (p) => [
  Math.round(p.lon * COORD_PRECISION) / COORD_PRECISION,
  Math.round(p.lat * COORD_PRECISION) / COORD_PRECISION,
];
const key = (c) => `${c[0]},${c[1]}`;
const isClosed = (line) => line.length >= 4 && key(line[0]) === key(line[line.length - 1]);

/** Склеивает отрезки (части колец мультиполигона) в замкнутые кольца. */
function assembleRings(lines) {
  const rings = [];
  const open = [];
  for (const line of lines) (isClosed(line) ? rings : open).push(line);

  while (open.length) {
    let ring = open.shift();
    let extended = true;
    while (!isClosed(ring) && extended) {
      extended = false;
      const head = key(ring[0]);
      const tail = key(ring[ring.length - 1]);
      for (let i = 0; i < open.length; i++) {
        const seg = open[i];
        const segHead = key(seg[0]);
        const segTail = key(seg[seg.length - 1]);
        if (segHead === tail) ring = ring.concat(seg.slice(1));
        else if (segTail === tail) ring = ring.concat(seg.slice(0, -1).reverse());
        else if (segTail === head) ring = seg.concat(ring.slice(1));
        else if (segHead === head) ring = seg.slice().reverse().concat(ring.slice(1));
        else continue;
        open.splice(i, 1);
        extended = true;
        break;
      }
    }
    if (isClosed(ring)) rings.push(ring);
  }
  return rings;
}

function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function wayToGeometry(way) {
  const ring = (way.geometry ?? []).map(toCoord);
  return isClosed(ring) ? { type: 'Polygon', coordinates: [ring] } : undefined;
}

function relationToGeometry(relation) {
  const linesFor = (role) =>
    relation.members
      .filter((m) => m.type === 'way' && (m.role || 'outer') === role && m.geometry)
      .map((m) => m.geometry.map(toCoord));

  const outers = assembleRings(linesFor('outer'));
  const inners = assembleRings(linesFor('inner'));
  if (!outers.length) return undefined;

  const polygons = outers.map((outer) => [outer]);
  for (const inner of inners) {
    const host = polygons.find(([outer]) => pointInRing(inner[0], outer));
    if (host) host.push(inner);
  }
  return polygons.length === 1
    ? { type: 'Polygon', coordinates: polygons[0] }
    : { type: 'MultiPolygon', coordinates: polygons };
}

// --- основной сценарий ----------------------------------------------------

const { south, west, north, east } = territory.bbox;
const bbox = `${south},${west},${north},${east}`;
const query = `[out:json][timeout:150];
(
  way["building"](${bbox});
  relation["building"]["type"="multipolygon"](${bbox});
);
out geom;`;

console.log(`Территория: ${territory.name} (${territory.id}), bbox ${bbox}`);
const { json, url } = await fetchOverpass(query);

const features = [];
let skipped = 0;
for (const element of json.elements) {
  if (element.tags?.building === 'no') continue;
  const geometry =
    element.type === 'way' ? wayToGeometry(element)
    : element.type === 'relation' ? relationToGeometry(element)
    : undefined;
  if (!geometry) {
    skipped++;
    continue;
  }
  features.push({
    type: 'Feature',
    id: `${element.type}/${element.id}`,
    properties: buildProperties(element.type, element),
    geometry,
  });
}

const bySource = { height: 0, levels: 0, default: 0 };
for (const f of features) bySource[f.properties.heightSource]++;

const collection = {
  type: 'FeatureCollection',
  metadata: {
    territory: territory.id,
    name: territory.name,
    bbox: territory.bbox,
    source: 'OpenStreetMap',
    license: 'ODbL 1.0 — © участники OpenStreetMap',
    osmTimestamp: json.osm3s?.timestamp_osm_base,
    fetchedAt: new Date().toISOString(),
    overpass: url,
    levelHeight: LEVEL_HEIGHT,
  },
  features,
};

const outDir = join(root, 'public', 'data', 'territories', territory.id);
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, 'buildings.geojson');
writeFileSync(outFile, JSON.stringify(collection));

const pct = (n) => `${Math.round((n / features.length) * 100)}%`;
console.log(`\n✓ Зданий: ${features.length} (пропущено без замкнутой геометрии: ${skipped})`);
console.log(`  высота из тега height:      ${bySource.height} (${pct(bySource.height)})`);
console.log(`  высота по этажности:        ${bySource.levels} (${pct(bySource.levels)})`);
console.log(`  высота по умолчанию (оценка): ${bySource.default} (${pct(bySource.default)})`);
console.log(`  данные OSM на: ${json.osm3s?.timestamp_osm_base ?? '—'}`);
console.log(`  → ${outFile.replace(`${root}/`, '')}`);
