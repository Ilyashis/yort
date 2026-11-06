#!/usr/bin/env node
// Base World, окружение: дороги и тротуары (линии OSM → полосы нужной ширины),
// газоны, площади, парковки, вода и деревья. Результат:
//   public/data/territories/<id>/ground.geojson — поверхности земли с типом (kind)
//   public/data/territories/<id>/trees.json     — точки деревьев
//
//   npm run data:fetch:environment

import { along, buffer, length as lineLength, lineString } from '@turf/turf';
import {
  baseMetadata,
  fetchOverpass,
  overpassBbox,
  parseCount,
  parseMeters,
  relationToGeometry,
  round1,
  roundCoord,
  roundGeometry,
  territory,
  wayToLine,
  wayToPolygon,
  writeTerritoryFile,
} from './lib/osm.mjs';

/** Ширина проезжей части по типу дороги, м. */
const ROAD_WIDTH = {
  motorway: 16, trunk: 16, primary: 14, secondary: 12, tertiary: 10,
  unclassified: 7, residential: 7, road: 7, busway: 7, living_street: 6, service: 4.5,
  motorway_link: 7, trunk_link: 7, primary_link: 7, secondary_link: 7, tertiary_link: 7,
};
/** Ширина пешеходных путей, м. */
const PATH_WIDTH = { pedestrian: 6, footway: 2.5, path: 2, cycleway: 2, steps: 2.5, track: 3, bridleway: 2 };
const SIDEWALK_WIDTH = 2.5;
/** Улицы, вдоль которых рисуем тротуары, если они не замаплены отдельно. */
const WITH_SIDEWALK = new Set([
  'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential',
  'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
]);
const LANE_WIDTH = 3.2;
const TREE_ROW_STEP_M = 8;

const GREEN_LEISURE = new Set(['park', 'garden']);
const GREEN_LANDUSE = new Set(['grass', 'recreation_ground', 'village_green', 'meadow', 'flowerbed', 'forest']);
const GREEN_NATURAL = new Set(['wood', 'scrub', 'grassland']);

/** Тип поверхности для площадного объекта (не дороги). */
function areaKind(tags) {
  if (tags.natural === 'water') return 'water';
  if (tags.leisure === 'pitch') return 'pitch';
  if (tags.amenity === 'parking') return 'parking';
  if (tags.place === 'square' || tags.leisure === 'playground') return 'paving';
  if (GREEN_LEISURE.has(tags.leisure) || GREEN_LANDUSE.has(tags.landuse) || GREEN_NATURAL.has(tags.natural)) {
    return 'green';
  }
  return undefined;
}

function bufferLine(coordinates, width) {
  const result = buffer(lineString(coordinates), width / 2, { units: 'meters', steps: 4 });
  return result ? roundGeometry(result.geometry) : undefined;
}

const query = `[out:json][timeout:150];
(
  way["highway"](${overpassBbox});
  way["area:highway"](${overpassBbox});
  way["leisure"~"^(park|garden|pitch|playground)$"](${overpassBbox});
  relation["leisure"~"^(park|garden)$"]["type"="multipolygon"](${overpassBbox});
  way["landuse"~"^(grass|recreation_ground|village_green|meadow|flowerbed|forest)$"](${overpassBbox});
  way["natural"~"^(wood|scrub|grassland|water|tree_row)$"](${overpassBbox});
  relation["natural"="water"]["type"="multipolygon"](${overpassBbox});
  way["amenity"="parking"](${overpassBbox});
  way["place"="square"](${overpassBbox});
  node["natural"="tree"](${overpassBbox});
);
out geom;`;

console.log(`Окружение: ${territory.name} (${territory.id}), bbox ${overpassBbox}`);
const { json, url } = await fetchOverpass(query);

const features = [];
const trees = [];
const add = (kind, geometry, name) => {
  if (!geometry) return;
  const properties = { kind };
  if (name) properties.name = name;
  features.push({ type: 'Feature', properties, geometry });
};

for (const el of json.elements) {
  const tags = el.tags ?? {};

  if (el.type === 'node') {
    if (tags.natural === 'tree') trees.push([...roundCoord([el.lon, el.lat]), round1(parseMeters(tags.height) ?? 0)]);
    continue;
  }

  if (tags.natural === 'tree_row' && el.type === 'way') {
    const line = wayToLine(el);
    if (!line) continue;
    const feature = lineString(line.coordinates);
    const total = lineLength(feature, { units: 'meters' });
    for (let d = 0; d <= total; d += TREE_ROW_STEP_M) {
      trees.push([...roundCoord(along(feature, d, { units: 'meters' }).geometry.coordinates), 0]);
    }
    continue;
  }

  if (tags.tunnel === 'yes' || tags.indoor === 'yes' || tags.tunnel === 'building_passage') continue;

  // Дорожные площади (area:highway=* или highway=* + area=yes).
  const areaHighway = tags['area:highway'] ?? (tags.area === 'yes' ? tags.highway : undefined);
  if (areaHighway && el.type === 'way') {
    add(ROAD_WIDTH[areaHighway] ? 'road' : 'paving', wayToPolygon(el), tags.name);
    continue;
  }

  if (tags.highway && el.type === 'way') {
    const line = wayToLine(el);
    if (!line) continue;
    const explicitWidth = parseMeters(tags.width);
    const lanes = parseCount(tags.lanes);

    if (ROAD_WIDTH[tags.highway]) {
      const width = explicitWidth ?? (lanes ? lanes * LANE_WIDTH : ROAD_WIDTH[tags.highway]);
      const sidewalk = tags.sidewalk ?? '';
      if (WITH_SIDEWALK.has(tags.highway) && !['no', 'none', 'separate'].includes(sidewalk)) {
        add('sidewalk', bufferLine(line.coordinates, width + 2 * SIDEWALK_WIDTH));
      }
      add('road', bufferLine(line.coordinates, width), tags.name);
    } else if (PATH_WIDTH[tags.highway]) {
      const kind = tags.highway === 'pedestrian' ? 'paving' : 'footway';
      add(kind, bufferLine(line.coordinates, explicitWidth ?? PATH_WIDTH[tags.highway]), tags.name);
    }
    continue;
  }

  const kind = areaKind(tags);
  if (!kind) continue;
  const geometry =
    el.type === 'way' ? wayToPolygon(el) : el.type === 'relation' ? relationToGeometry(el) : undefined;
  add(kind, geometry, tags.name);
}

const metadata = baseMetadata(json, url);
const groundFile = writeTerritoryFile('ground.geojson', { type: 'FeatureCollection', metadata, features });
const treesFile = writeTerritoryFile('trees.json', { metadata, trees });

const byKind = {};
for (const f of features) byKind[f.properties.kind] = (byKind[f.properties.kind] ?? 0) + 1;
console.log(`\n✓ Поверхностей: ${features.length}`);
for (const [kind, count] of Object.entries(byKind)) console.log(`  ${kind.padEnd(9)} ${count}`);
console.log(`✓ Деревьев: ${trees.length}`);
console.log(`  данные OSM на: ${json.osm3s?.timestamp_osm_base ?? '—'}`);
console.log(`  → ${groundFile}\n  → ${treesFile}`);
