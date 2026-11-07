#!/usr/bin/env node
// Base World, окружение: дороги и тротуары (линии OSM → полосы нужной ширины),
// газоны, площади, парковки, вода, деревья и уличные объекты. Результат:
//   public/data/territories/<id>/ground.geojson — поверхности земли с типом (kind)
//   public/data/territories/<id>/trees.json     — точки деревьев
//   public/data/territories/<id>/streets.json   — оси дорог, переходы, дорожки, фонари, скамейки
//
//   npm run data:fetch:environment

import {
  along,
  bbox,
  bboxClip,
  bboxPolygon,
  buffer,
  featureCollection,
  intersect,
  length as lineLength,
  lineString,
} from '@turf/turf';
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

/**
 * Что растёт на «зелёном»: лес (в браузере засаживается лесом) или луг (деревьев нет).
 * Без отметки — газоны и парки.
 */
function coverOf(tags) {
  if (tags.landuse === 'forest' || tags.natural === 'wood' || tags.natural === 'scrub') return 'wood';
  if (tags.landuse === 'meadow' || tags.natural === 'grassland') return 'meadow';
  return undefined;
}

/**
 * Большие объекты (река Белая, лесные массивы) тянутся далеко за район —
 * обрезаем их по границе с запасом, чтобы файл оставался маленьким.
 */
const CLIP_MARGIN_DEG = 0.002;
const { south, west, north, east } = territory.bbox;
const clipBox = [west - CLIP_MARGIN_DEG, south - CLIP_MARGIN_DEG, east + CLIP_MARGIN_DEG, north + CLIP_MARGIN_DEG];
const insideClipBox = ([lon, lat]) => lon >= clipBox[0] && lon <= clipBox[2] && lat >= clipBox[1] && lat <= clipBox[3];

/** Тип поверхности для площадного объекта (не дороги). */
function areaKind(tags) {
  if (tags.natural === 'water') return 'water';
  if (tags.leisure === 'pitch') return 'pitch';
  if (tags.amenity === 'parking') return 'parking';
  if (tags.place === 'square' || tags.leisure === 'playground' || tags.man_made === 'pier') return 'paving';
  if (GREEN_LEISURE.has(tags.leisure) || GREEN_LANDUSE.has(tags.landuse) || GREEN_NATURAL.has(tags.natural)) {
    return 'green';
  }
  return undefined;
}

const clipPolygon = bboxPolygon(clipBox);

/**
 * Обрезка по границе района честным пересечением полигонов. bboxClip (Сазерленд — Ходжмен)
 * здесь не годится: у огромных вогнутых полигонов (река Белая на сотни км) внешние петли
 * «проецируются» на края и углы рамки, и на суше появляются лишние куски воды.
 */
function clip(geometry) {
  if (!geometry) return undefined;
  const feature = { type: 'Feature', properties: {}, geometry };
  const [minX, minY, maxX, maxY] = bbox(feature);
  const insideBox = minX >= clipBox[0] && minY >= clipBox[1] && maxX <= clipBox[2] && maxY <= clipBox[3];
  if (insideBox) return roundGeometry(geometry);
  const clipped = intersect(featureCollection([feature, clipPolygon]));
  return clipped ? roundGeometry(clipped.geometry) : undefined;
}

/**
 * Оси дорог — тоже по границе района: трасса через деревню тянется на десятки километров,
 * и без обрезки по ней встали бы фонари и разметка далеко за пределами района.
 * Для линий bboxClip годится (беда с «петлями» — только у полигонов).
 */
function clipLine(coordinates) {
  const clipped = bboxClip(lineString(coordinates), clipBox).geometry;
  const parts = clipped.type === 'LineString' ? [clipped.coordinates] : clipped.coordinates;
  return parts.filter((part) => part.length >= 2).map((part) => part.map(roundCoord));
}

function bufferLine(coordinates, width) {
  const result = buffer(lineString(coordinates), width / 2, { units: 'meters', steps: 4 });
  return result ? clip(result.geometry) : undefined;
}

const query = `[out:json][timeout:180];
(
  way["highway"](${overpassBbox});
  way["area:highway"](${overpassBbox});
  way["leisure"~"^(park|garden|pitch|playground)$"](${overpassBbox});
  relation["leisure"~"^(park|garden)$"]["type"="multipolygon"](${overpassBbox});
  way["landuse"~"^(grass|recreation_ground|village_green|meadow|flowerbed|forest)$"](${overpassBbox});
  relation["landuse"~"^(grass|forest|recreation_ground)$"]["type"="multipolygon"](${overpassBbox});
  way["natural"~"^(wood|scrub|grassland|water|tree_row)$"](${overpassBbox});
  relation["natural"~"^(water|wood|scrub)$"]["type"="multipolygon"](${overpassBbox});
  way["amenity"="parking"](${overpassBbox});
  way["place"="square"](${overpassBbox});
  way["man_made"="pier"](${overpassBbox});
  node["natural"="tree"](${overpassBbox});
  node["highway"="street_lamp"](${overpassBbox});
  node["amenity"="bench"](${overpassBbox});
);
out geom;`;

console.log(`Окружение: ${territory.name} (${territory.id}), bbox ${overpassBbox}`);
const { json, url } = await fetchOverpass(query);

const features = [];
const trees = [];
const streets = { roads: [], paths: [], crossings: [], lamps: [], benches: [] };
const add = (kind, geometry, name, cover) => {
  if (!geometry) return;
  const properties = { kind };
  if (name) properties.name = name;
  if (cover) properties.cover = cover;
  features.push({ type: 'Feature', properties, geometry });
};

for (const el of json.elements) {
  const tags = el.tags ?? {};

  if (el.type === 'node') {
    const point = roundCoord([el.lon, el.lat]);
    if (tags.natural === 'tree') trees.push([...point, round1(parseMeters(tags.height) ?? 0)]);
    else if (tags.highway === 'street_lamp') streets.lamps.push(point);
    else if (tags.amenity === 'bench') streets.benches.push(point);
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
    add(ROAD_WIDTH[areaHighway] ? 'road' : 'paving', clip(wayToPolygon(el)), tags.name);
    continue;
  }

  if (tags.highway && el.type === 'way') {
    const line = wayToLine(el);
    if (!line || !line.coordinates.some(insideClipBox)) continue;
    const explicitWidth = parseMeters(tags.width);
    const lanes = parseCount(tags.lanes);

    if (ROAD_WIDTH[tags.highway]) {
      const width = explicitWidth ?? (lanes ? lanes * LANE_WIDTH : ROAD_WIDTH[tags.highway]);
      const sidewalk = tags.sidewalk ?? '';
      // В деревне тротуаров вдоль улиц нет — дорисовываем их только в городе.
      const city = territory.kind !== 'village';
      if (city && WITH_SIDEWALK.has(tags.highway) && !['no', 'none', 'separate'].includes(sidewalk)) {
        add('sidewalk', bufferLine(line.coordinates, width + 2 * SIDEWALK_WIDTH));
      }
      add('road', bufferLine(line.coordinates, width), tags.name);
      for (const coords of clipLine(line.coordinates)) {
        const road = { highway: tags.highway, width: round1(width), coords };
        if (tags.name) road.name = tags.name;
        if (tags.oneway === 'yes') road.oneway = true;
        if (lanes) road.lanes = lanes;
        streets.roads.push(road);
      }
    } else if (PATH_WIDTH[tags.highway]) {
      const width = explicitWidth ?? PATH_WIDTH[tags.highway];
      if (tags.footway === 'crossing' || tags.cycleway === 'crossing') {
        // Переход лежит на проезжей части — рисуем его зеброй, а не полосой дорожки.
        streets.crossings.push(...clipLine(line.coordinates));
        continue;
      }
      const kind = tags.highway === 'pedestrian' ? 'paving' : 'footway';
      add(kind, bufferLine(line.coordinates, width), tags.name);
      if (tags.highway !== 'steps') {
        for (const coords of clipLine(line.coordinates)) {
          streets.paths.push({ highway: tags.highway, width: round1(width), coords });
        }
      }
    }
    continue;
  }

  const kind = areaKind(tags);
  if (!kind) continue;
  const geometry =
    el.type === 'way' ? wayToPolygon(el) : el.type === 'relation' ? relationToGeometry(el) : undefined;
  add(kind, clip(geometry), tags.name, kind === 'green' ? coverOf(tags) : undefined);
}

const metadata = baseMetadata(json, url);
const groundFile = writeTerritoryFile('ground.geojson', { type: 'FeatureCollection', metadata, features });
const treesFile = writeTerritoryFile('trees.json', { metadata, trees });
const streetsFile = writeTerritoryFile('streets.json', { metadata, ...streets });

const byKind = {};
for (const f of features) {
  const key = f.properties.cover ? `${f.properties.kind}/${f.properties.cover}` : f.properties.kind;
  byKind[key] = (byKind[key] ?? 0) + 1;
}
console.log(`\n✓ Поверхностей: ${features.length}`);
for (const [kind, count] of Object.entries(byKind)) console.log(`  ${kind.padEnd(13)} ${count}`);
console.log(`✓ Деревьев: ${trees.length}`);
console.log(
  `✓ Улицы: осей дорог ${streets.roads.length}, дорожек ${streets.paths.length}, переходов ${streets.crossings.length}, ` +
    `фонарей ${streets.lamps.length}, скамеек ${streets.benches.length}`,
);
console.log(`  данные OSM на: ${json.osm3s?.timestamp_osm_base ?? '—'}`);
console.log(`  → ${groundFile}\n  → ${treesFile}\n  → ${streetsFile}`);
