// Общие функции подготовки данных из OpenStreetMap: запросы к Overpass,
// разбор тегов, сборка полигонов, запись результата.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const territories = JSON.parse(readFileSync(join(root, 'src/config/territories.json'), 'utf8'));
/**
 * Какую территорию выгружать: аргумент --territory=<id>, переменная TERRITORY или первая в списке.
 *   TERRITORY=itkulovo-1 npm run data:fetch
 */
const requested =
  process.argv.find((arg) => arg.startsWith('--territory='))?.slice('--territory='.length) ?? process.env.TERRITORY;
export const territory = requested ? territories.find((t) => t.id === requested) : territories[0];
if (!territory) {
  console.error(`Нет территории «${requested}». Есть: ${territories.map((t) => t.id).join(', ')}`);
  process.exit(1);
}

const { south, west, north, east } = territory.bbox;
/** bbox в формате Overpass: south,west,north,east. */
export const overpassBbox = `${south},${west},${north},${east}`;

const ENDPOINTS = process.env.OVERPASS_URL
  ? [process.env.OVERPASS_URL]
  : [
      'https://overpass-api.de/api/interpreter',
      'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
      'https://overpass.private.coffee/api/interpreter',
    ];

/** Публичные серверы Overpass часто перегружены — обходим их по кругу несколько раз. */
export async function fetchOverpass(query, rounds = 4) {
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

// --- теги -------------------------------------------------------------------

/** "12", "12 m", "12,5 м" → 12.5; футы и мусор → undefined. */
export function parseMeters(value) {
  if (value == null) return undefined;
  const match = String(value)
    .replace(',', '.')
    .match(/^\s*(\d+(?:\.\d+)?)\s*(m|м|meters?|метр\S*)?\s*$/i);
  if (!match) return undefined;
  const meters = Number(match[1]);
  return meters > 0 && meters < 1000 ? meters : undefined;
}

/** "5", "5;9", "5-9" → максимальное число (≥ 0). */
export function parseCount(value) {
  if (value == null) return undefined;
  const numbers = String(value)
    .split(/[;,\-]/)
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isFinite(n) && n >= 0 && n < 200);
  return numbers.length ? Math.max(...numbers) : undefined;
}

export const round1 = (n) => Math.round(n * 10) / 10;

// --- геометрия ----------------------------------------------------------------

const COORD_PRECISION = 1e7; // ~1 см

export const roundCoord = (c) => [
  Math.round(c[0] * COORD_PRECISION) / COORD_PRECISION,
  Math.round(c[1] * COORD_PRECISION) / COORD_PRECISION,
];
export const toCoord = (p) => roundCoord([p.lon, p.lat]);
const key = (c) => `${c[0]},${c[1]}`;
export const isClosed = (line) => line.length >= 4 && key(line[0]) === key(line[line.length - 1]);

/** Склеивает отрезки (части колец мультиполигона) в замкнутые кольца. */
export function assembleRings(lines) {
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

export function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Замкнутый way → Polygon, иначе undefined. */
export function wayToPolygon(way) {
  const ring = (way.geometry ?? []).map(toCoord);
  return isClosed(ring) ? { type: 'Polygon', coordinates: [ring] } : undefined;
}

export function wayToLine(way) {
  const line = (way.geometry ?? []).map(toCoord);
  return line.length >= 2 ? { type: 'LineString', coordinates: line } : undefined;
}

/** Мультиполигон-отношение → Polygon / MultiPolygon. */
export function relationToGeometry(relation) {
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

/** Округляет все координаты геометрии (после буферизации и т. п.). */
export function roundGeometry(geometry) {
  const walk = (value) => (typeof value[0] === 'number' ? roundCoord(value) : value.map(walk));
  return { type: geometry.type, coordinates: walk(geometry.coordinates) };
}

// --- запись -------------------------------------------------------------------

export function writeTerritoryFile(fileName, data) {
  const outDir = join(root, 'public', 'data', 'territories', territory.id);
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, fileName);
  writeFileSync(outFile, JSON.stringify(data));
  return outFile.replace(`${root}/`, '');
}

export function baseMetadata(json, url) {
  return {
    territory: territory.id,
    name: territory.name,
    bbox: territory.bbox,
    source: 'OpenStreetMap',
    license: 'ODbL 1.0 — © участники OpenStreetMap',
    osmTimestamp: json.osm3s?.timestamp_osm_base,
    fetchedAt: new Date().toISOString(),
    overpass: url,
  };
}
