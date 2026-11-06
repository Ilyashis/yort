import { hashString } from '../../utils/hash';
import { polygonsOfGround, type GroundFeature } from './environment';
import type { BaseBuildingFeature, BaseBuildingProperties } from './types';
import { distanceToPolygon, toLocalPolygon, type LocalFrame, type LocalPolygon } from '../walk/localFrame';

/** Тип окон: классические, высокие узкие («сталинки»), ленточные («панельки»). */
export type WindowVariant = 0 | 1 | 2;

export interface FacadeStyle {
  /** Витрины и вывески на первом этаже. */
  shopfront: boolean;
  variant: WindowVariant;
  /** Стабильное число [0, 1) для разброса оттенков стёкол и вывесок. */
  seed: number;
}

/** Типы, у которых на первом этаже вдоль улицы бывают магазины и кафе. */
const SHOP_TYPES = new Set(['yes', 'apartments', 'residential', 'commercial', 'retail', 'office', 'hotel', 'mixed_use']);
/** Не дальше этого расстояния (м) от проезжей части здание считается «уличным». */
const STREET_DISTANCE = 12;
const PANEL_MIN_LEVELS = 9;

/**
 * Здания, стоящие вдоль улиц с названием (по контуру проезжей части из OSM):
 * у них на первом этаже рисуем витрины.
 */
export function findStreetFrontBuildings(
  buildings: readonly BaseBuildingFeature[],
  ground: readonly GroundFeature[],
  frame: LocalFrame,
): Set<string> {
  const roads: LocalPolygon[] = ground
    .filter((f) => f.properties.kind === 'road' && f.properties.name)
    .flatMap(polygonsOfGround)
    .map((rings) => toLocalPolygon(rings, frame));

  const result = new Set<string>();
  for (const building of buildings) {
    if (!SHOP_TYPES.has(building.properties.building)) continue;
    const outlines =
      building.geometry.type === 'Polygon' ? [building.geometry.coordinates] : building.geometry.coordinates;
    const near = outlines.some(([outer]) =>
      (outer ?? []).some((vertex) => {
        const point = frame.toLocal(vertex);
        return roads.some(
          (r) =>
            point[0] >= r.minX - STREET_DISTANCE &&
            point[0] <= r.maxX + STREET_DISTANCE &&
            point[1] >= r.minY - STREET_DISTANCE &&
            point[1] <= r.maxY + STREET_DISTANCE &&
            distanceToPolygon(point, r) <= STREET_DISTANCE,
        );
      }),
    );
    if (near) result.add(building.properties.id);
  }
  return result;
}

export function facadeStyle(props: BaseBuildingProperties, streetFront: boolean): FacadeStyle {
  const hash = hashString(props.id);
  const levels = props.levels ?? Math.round(props.height / 3.2);
  const variant: WindowVariant =
    levels >= PANEL_MIN_LEVELS ? 2 : ((hash % 3) as WindowVariant);
  return {
    shopfront: streetFront && SHOP_TYPES.has(props.building) && props.minHeight === 0,
    variant,
    seed: (hash % 10_000) / 10_000,
  };
}
