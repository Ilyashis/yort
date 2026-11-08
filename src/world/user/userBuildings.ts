// User World: здания пользователя без привязки к движку — идентификаторы в сцене,
// препятствия для пешехода и новых участков, свойства для карточки здания.
// Слои сцены берут отсюда общие части.

import type { BaseBuildingFeature, BaseBuildingProperties } from '../base/types';
import { BUILDING_TYPES, type BuildingSpec, type GeneratedBuilding } from './building';

/** Здание пользователя: спецификация + сгенерированная геометрия. */
export interface UserBuilding {
  id: string;
  spec: BuildingSpec;
  building: GeneratedBuilding;
}

/** Приставка id зданий пользователя в сцене — чтобы не путать с домами OSM ("way/…"). */
export const USER_BUILDING_ID_PREFIX = 'user/';

export const isUserBuildingId = (id: string) => id.startsWith(USER_BUILDING_ID_PREFIX);
export const userBuildingId = (id: string) => `${USER_BUILDING_ID_PREFIX}${id}`;

/** Здание пользователя как препятствие для пешехода и новых участков. */
export function toObstacle({ id, spec, building }: UserBuilding): BaseBuildingFeature {
  const ring = [...building.footprint, building.footprint[0]!];
  return {
    type: 'Feature',
    id: userBuildingId(id),
    properties: toProperties({ id, spec, building }),
    geometry: { type: 'Polygon', coordinates: [ring] },
  };
}

/** Свойства для карточки здания. */
export function toProperties({ id, spec, building }: UserBuilding): BaseBuildingProperties {
  return {
    id: userBuildingId(id),
    building: spec.type,
    name: `Ваш проект · ${BUILDING_TYPES[spec.type].label}`,
    levels: spec.floors,
    height: Math.round(building.totalHeight * 10) / 10,
    minHeight: 0,
    heightSource: 'height',
  };
}
