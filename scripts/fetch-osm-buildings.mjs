#!/usr/bin/env node
// Base World, здания: выгружает здания территории из OpenStreetMap (Overpass API),
// считает высоты и сохраняет public/data/territories/<id>/buildings.geojson.
//
//   npm run data:fetch:buildings
//   OVERPASS_URL=https://... npm run data:fetch:buildings   — свой сервер Overpass

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

const query = `[out:json][timeout:150];
(
  way["building"](${overpassBbox});
  relation["building"]["type"="multipolygon"](${overpassBbox});
);
out geom;`;

console.log(`Здания: ${territory.name} (${territory.id}), bbox ${overpassBbox}`);
const { json, url } = await fetchOverpass(query);

const features = [];
let skipped = 0;
for (const element of json.elements) {
  if (element.tags?.building === 'no') continue;
  const geometry =
    element.type === 'way' ? wayToPolygon(element)
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

const file = writeTerritoryFile('buildings.geojson', {
  type: 'FeatureCollection',
  metadata: { ...baseMetadata(json, url), levelHeight: LEVEL_HEIGHT },
  features,
});

const pct = (n) => `${Math.round((n / features.length) * 100)}%`;
console.log(`\n✓ Зданий: ${features.length} (пропущено без замкнутой геометрии: ${skipped})`);
console.log(`  высота из тега height:        ${bySource.height} (${pct(bySource.height)})`);
console.log(`  высота по этажности:          ${bySource.levels} (${pct(bySource.levels)})`);
console.log(`  высота по умолчанию (оценка): ${bySource.default} (${pct(bySource.default)})`);
console.log(`  данные OSM на: ${json.osm3s?.timestamp_osm_base ?? '—'}`);
console.log(`  → ${file}`);
