import { hashString } from '../../utils/hash';
import { polygonsOfGround, type GroundFeature } from './environment';
import type { BaseBuildingFeature, BaseBuildingProperties } from './types';
import { distanceToPolygon, toLocalPolygon, type LocalFrame, type LocalPolygon, type Vec2 } from '../walk/localFrame';

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
  const nearStreet = nearNamedStreet(ground, frame, STREET_DISTANCE);
  const result = new Set<string>();
  for (const building of buildings) {
    if (!SHOP_TYPES.has(building.properties.building)) continue;
    const outlines =
      building.geometry.type === 'Polygon' ? [building.geometry.coordinates] : building.geometry.coordinates;
    const near = outlines.some(([outer]) => (outer ?? []).some((vertex) => nearStreet(frame.toLocal(vertex))));
    if (near) result.add(building.properties.id);
  }
  return result;
}

/** Проверка «точка (в локальных метрах) не дальше distance от проезжей части улицы с названием». */
export function nearNamedStreet(
  ground: readonly GroundFeature[],
  frame: LocalFrame,
  distance: number,
): (point: Vec2) => boolean {
  const roads: LocalPolygon[] = ground
    .filter((f) => f.properties.kind === 'road' && f.properties.name)
    .flatMap(polygonsOfGround)
    .map((rings) => toLocalPolygon(rings, frame));
  return (point) =>
    roads.some(
      (r) =>
        point[0] >= r.minX - distance &&
        point[0] <= r.maxX + distance &&
        point[1] >= r.minY - distance &&
        point[1] <= r.maxY + distance &&
        distanceToPolygon(point, r) <= distance,
    );
}

/** Сетка окон вдоль стены: шаг и ширина стекла, м. */
export interface WindowGrid {
  bay: number;
  width: number;
}

/**
 * Те же шаги и доли, что в шейдере фасадов (buildingAppearance.ts): по ним двери и балконы
 * встают ровно напротив нарисованных окон. Центр окна — середина шага у всех типов.
 */
export function windowGrid(style: FacadeStyle, groundFloor: boolean): WindowGrid {
  if (groundFloor && style.shopfront) return { bay: 4.5, width: 4.5 * 0.88 };
  if (style.variant === 2) return { bay: 3.4, width: 3.4 * 0.8 };
  if (style.variant === 1) return { bay: 2.6, width: 2.6 * 0.4 };
  return { bay: 3, width: 3 * 0.56 };
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
