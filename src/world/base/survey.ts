/**
 * Находки по своей съёмке с дрона (survey.json района): цвета кровли и стен домов OSM и постройки,
 * которых в OSM нет (дома, сараи, гаражи, бани). Применяются поверх Base World при загрузке: цвета — как
 * теги roof:colour / building:colour, новые постройки — как дома с id «survey/…». Сам OSM не меняется.
 * Чистые функции.
 */

import type { BaseBuildingFeature, BaseBuildingsCollection } from './types';
import type { LonLat } from '../user/plot';

export type SurveyBuildingKind = 'house' | 'shed' | 'garage';

export interface SurveyHouseColors {
  /** #rrggbb */
  roof?: string;
  wall?: string;
}

export interface SurveyBuilding {
  id: string;
  kind: SurveyBuildingKind;
  /** Контур (кольцо, без повтора первой точки), долгота/широта. */
  footprint: LonLat[];
  /** Высота до конька, м. */
  height: number;
  roof?: string;
  wall?: string;
}

export interface SurveyFile {
  metadata: { source: string; credit: string; createdAt?: string };
  /** Цвета домов OSM: ключ — id дома («way/123»). */
  houses: Record<string, SurveyHouseColors>;
  buildings: SurveyBuilding[];
}

export interface SurveyStats {
  colored: number;
  added: number;
}

const HEX = /^#[0-9a-f]{6}$/i;
const OSM_TYPE: Record<SurveyBuildingKind, string> = { house: 'house', shed: 'shed', garage: 'garage' };

/**
 * Base World с находками по съёмке: цвета — домам, у которых в OSM своих нет (OSM главнее),
 * и новые постройки (кроме тех, что налезают на дома OSM, — их, видимо, уже дорисовали).
 */
export function applySurvey(collection: BaseBuildingsCollection, survey: SurveyFile): { collection: BaseBuildingsCollection; stats: SurveyStats } {
  let colored = 0;
  const features = collection.features.map((f): BaseBuildingFeature => {
    const colors = survey.houses[f.properties.id];
    if (!colors) return f;
    const roof = colors.roof && HEX.test(colors.roof) && !f.properties.roofColour ? colors.roof : undefined;
    const wall = colors.wall && HEX.test(colors.wall) && !f.properties.colour ? colors.wall : undefined;
    if (!roof && !wall) return f;
    colored++;
    return { ...f, properties: { ...f.properties, ...(roof ? { roofColour: roof } : {}), ...(wall ? { colour: wall } : {}) } };
  });

  const boxes = collection.features.map(bboxOf);
  const added: BaseBuildingFeature[] = [];
  for (const b of survey.buildings) {
    if (b.footprint.length < 3 || !(b.height > 0)) continue;
    const ring = [...b.footprint, b.footprint[0]!];
    const box = bboxOf({ geometry: { type: 'Polygon', coordinates: [ring] } } as BaseBuildingFeature);
    if (boxes.some((o) => overlap(o, box) > 0.3 * area(box))) continue;
    added.push({
      type: 'Feature',
      id: b.id,
      properties: {
        id: b.id,
        building: OSM_TYPE[b.kind],
        height: b.height,
        minHeight: 0,
        heightSource: 'default',
        roofShape: 'gabled',
        ...(b.roof && HEX.test(b.roof) ? { roofColour: b.roof } : {}),
        ...(b.wall && HEX.test(b.wall) ? { colour: b.wall } : {}),
        source: 'drone',
      },
      geometry: { type: 'Polygon', coordinates: [ring] },
    });
  }
  return { collection: { ...collection, features: [...features, ...added] }, stats: { colored, added: added.length } };
}

type Box = [number, number, number, number];

function bboxOf(f: Pick<BaseBuildingFeature, 'geometry'>): Box {
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const rings of polys) {
    for (const [x, y] of rings[0] ?? []) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  return [x0, y0, x1, y1];
}

const area = (b: Box) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
const overlap = (a: Box, b: Box) => area([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]);
