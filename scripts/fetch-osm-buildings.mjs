#!/usr/bin/env node
// Base World, здания: выгружает здания территории из OpenStreetMap (Overpass API),
// считает высоты стен и крыш, форму крыши, материал и сохраняет:
//   public/data/territories/<id>/buildings.geojson       — контуры зданий
//   public/data/territories/<id>/building-parts.geojson  — части зданий (building:part): башни, купола, ярусы
//
//   npm run data:fetch:buildings
//   OVERPASS_URL=https://... npm run data:fetch:buildings   — свой сервер Overpass

import { area, length as lineLength, polygonToLine } from '@turf/turf';
import {
  baseMetadata,
  fetchOverpass,
  overpassBbox,
  parseCount,
  parseMeters,
  relationToGeometry,
  round1,
  territory,
  wayToPolygon,
  writeTerritoryFile,
} from './lib/osm.mjs';

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

/** Формы крыш, которые умеем рисовать (остальные → flat). */
const ROOF_ALIASES = {
  flat: 'flat',
  gabled: 'gabled', saltbox: 'gabled', gambrel: 'gabled', round: 'gabled',
  hipped: 'hipped', 'half-hipped': 'hipped', mansard: 'hipped', side_hipped: 'hipped',
  pyramidal: 'pyramidal',
  skillion: 'skillion',
  dome: 'dome',
  onion: 'onion',
  cone: 'pyramidal',
};

function roofShape(tags) {
  const raw = String(tags['roof:shape'] ?? 'flat').toLowerCase().trim();
  return ROOF_ALIASES[raw] ?? 'flat';
}

/** Высота крыши по умолчанию: от «полуширины» контура (2·площадь/периметр) и формы. */
function defaultRoofHeight(shape, geometry) {
  const feature = { type: 'Feature', properties: {}, geometry };
  const surface = area(feature);
  const perimeter = lineLength(polygonToLine(feature), { units: 'meters' });
  const halfWidth = perimeter > 0 ? (2 * surface) / perimeter : 5;
  const radius = Math.sqrt(surface / Math.PI);
  switch (shape) {
    case 'dome':
      return Math.min(radius, 25);
    case 'onion':
      return Math.min(radius * 1.6, 30);
    case 'skillion':
      return Math.min(Math.max(halfWidth * 0.35, 1), 5);
    default:
      // ~30° уклона.
      return Math.min(Math.max(halfWidth * 0.58, 1.5), 12);
  }
}

function computeHeights(tags, geometry) {
  const levels = parseCount(tags['building:levels']) || undefined;
  const roofLevels = parseCount(tags['roof:levels']) ?? 0;
  const explicitHeight = parseMeters(tags.height);
  const shape = roofShape(tags);
  let roofHeight =
    shape === 'flat'
      ? 0
      : (parseMeters(tags['roof:height']) ?? (roofLevels ? roofLevels * LEVEL_HEIGHT : defaultRoofHeight(shape, geometry)));

  let height;
  let heightSource;
  if (explicitHeight) {
    // height в OSM — до самого верха, включая крышу.
    height = explicitHeight;
    heightSource = 'height';
    if (height - roofHeight < 2) roofHeight = Math.max(height * 0.4, 0);
  } else if (levels) {
    height = levels * LEVEL_HEIGHT + roofHeight;
    heightSource = 'levels';
  } else {
    height = (DEFAULT_HEIGHT_BY_TYPE[tags.building] ?? FALLBACK_HEIGHT) + roofHeight;
    heightSource = 'default';
  }

  let minHeight =
    parseMeters(tags.min_height) ?? (parseCount(tags['building:min_level']) ?? 0) * LEVEL_HEIGHT;
  // Навесы (building=roof) стоят на опорах — рисуем их как тонкую плиту.
  if (tags.building === 'roof' && minHeight === 0) minHeight = Math.max(height - 1, 0);
  if (minHeight >= height) minHeight = 0;
  if (height - roofHeight < minHeight) roofHeight = Math.max(height - minHeight, 0);

  return { height: round1(height), minHeight: round1(minHeight), roofHeight: round1(roofHeight), roofShape: shape, heightSource, levels };
}

function buildProperties(type, element, geometry, isPart) {
  const tags = element.tags ?? {};
  const street = tags['addr:street'];
  const house = tags['addr:housenumber'];
  const properties = {
    id: `${type}/${element.id}`,
    building: isPart ? tags['building:part'] : tags.building,
    ...computeHeights(tags, geometry),
  };
  if (tags.name) properties.name = tags.name;
  if (street || house) properties.address = [street, house].filter(Boolean).join(', ');
  if (properties.levels === undefined) delete properties.levels;
  if (properties.roofShape === 'flat') {
    delete properties.roofShape;
    delete properties.roofHeight;
  }
  if (tags['roof:orientation'] === 'across') properties.roofOrientation = 'across';
  if (tags['roof:colour']) properties.roofColour = tags['roof:colour'];
  if (tags['building:colour']) properties.colour = tags['building:colour'];
  if (tags['building:material']) properties.material = tags['building:material'];
  return properties;
}

const query = `[out:json][timeout:150];
(
  way["building"](${overpassBbox});
  relation["building"]["type"="multipolygon"](${overpassBbox});
  way["building:part"](${overpassBbox});
  relation["building:part"]["type"="multipolygon"](${overpassBbox});
);
out geom;`;

console.log(`Здания: ${territory.name} (${territory.id}), bbox ${overpassBbox}`);
const { json, url } = await fetchOverpass(query);

const features = [];
const parts = [];
let skipped = 0;
for (const element of json.elements) {
  const tags = element.tags ?? {};
  const isBuilding = tags.building && tags.building !== 'no';
  const isPart = !isBuilding && tags['building:part'] && tags['building:part'] !== 'no';
  if (!isBuilding && !isPart) continue;
  const geometry =
    element.type === 'way' ? wayToPolygon(element)
    : element.type === 'relation' ? relationToGeometry(element)
    : undefined;
  if (!geometry) {
    skipped++;
    continue;
  }
  (isPart ? parts : features).push({
    type: 'Feature',
    id: `${element.type}/${element.id}`,
    properties: buildProperties(element.type, element, geometry, isPart),
    geometry,
  });
}

const bySource = { height: 0, levels: 0, default: 0 };
for (const f of features) bySource[f.properties.heightSource]++;
const roofs = {};
for (const f of [...features, ...parts]) {
  const shape = f.properties.roofShape ?? 'flat';
  roofs[shape] = (roofs[shape] ?? 0) + 1;
}
const materials = features.filter((f) => f.properties.material).length;

const metadata = { ...baseMetadata(json, url), levelHeight: LEVEL_HEIGHT };
const file = writeTerritoryFile('buildings.geojson', { type: 'FeatureCollection', metadata, features });
const partsFile = writeTerritoryFile('building-parts.geojson', { type: 'FeatureCollection', metadata, features: parts });

const pct = (n) => `${Math.round((n / features.length) * 100)}%`;
console.log(`\n✓ Зданий: ${features.length}, частей зданий: ${parts.length} (пропущено без замкнутой геометрии: ${skipped})`);
console.log(`  высота из тега height:        ${bySource.height} (${pct(bySource.height)})`);
console.log(`  высота по этажности:          ${bySource.levels} (${pct(bySource.levels)})`);
console.log(`  высота по умолчанию (оценка): ${bySource.default} (${pct(bySource.default)})`);
console.log(`  крыши: ${Object.entries(roofs).map(([k, v]) => `${k} ${v}`).join(', ')}`);
console.log(`  с материалом стен: ${materials}`);
console.log(`  данные OSM на: ${json.osm3s?.timestamp_osm_base ?? '—'}`);
console.log(`  → ${file}\n  → ${partsFile}`);
