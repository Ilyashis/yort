// Как выглядит здание Base World — без привязки к движку: форма и высота крыши, высота этажа
// для окон, цвета фасада и кровли (строки CSS).

import { hashString } from '../../utils/hash';
import type { Vec2 } from '../walk/localFrame';
import {
  defaultRoofHeight,
  orientedBox,
  rectangularity,
  roofFrame,
  roofTriangles,
  signedArea,
  type RoofFrame,
  type RoofShape,
} from './roofGeometry';
import type { BaseBuildingFeature, BaseBuildingProperties, Ring } from './types';

/** city — правдоподобные фасады; data — раскраска по источнику высоты (качество данных). */
export type BuildingColorMode = 'city' | 'data';

export const BUILDING_COLORS = {
  /** Высота известна из OSM (height или этажность). */
  known: '#ece6da',
  /** Высота — оценка по типу здания. */
  estimated: '#a8b8cc',
  selected: '#f5a524',
  /** Здание пересекается с участком пользователя. */
  conflict: '#ff6b6b',
} as const;

/** Типичные цвета фасадов центра: штукатурка, светлый камень. */
export const FACADE_PALETTE = ['#e9dcc3', '#f1e7d3', '#dcc6a6', '#e6d2b5', '#d5dadb', '#ece6da', '#d9b99f', '#c99f84', '#f3f0e9', '#e3d7c0'];
const UTILITY_PALETTE = ['#b9bcbf', '#a9adb1', '#c4c2bd'];
const TEMPLE_COLOR = '#f4f2ec';
/** Цвета по материалу стен (building:material). */
const MATERIAL_PALETTES: Record<string, string[]> = {
  brick: ['#a9563d', '#b5654a', '#9c4f3a', '#c27b5f', '#a45f48'],
  concrete: ['#bfc2c2', '#cfd1cf', '#b4b7b8'],
  reinforced_concrete: ['#bfc2c2', '#cfd1cf', '#b4b7b8'],
  panel: ['#d4d6d3', '#c7cbcc', '#dcdad2'],
  stone: ['#e3dccb', '#d8cfbb', '#cfc6b1'],
  limestone: ['#e8e0cc', '#ddd3bd'],
  sandstone: ['#d9c49a', '#cdb68a'],
  glass: ['#8fa8b8', '#7f9cae', '#9ab4c2'],
  metal: ['#a7adb2', '#9aa1a7'],
  wood: ['#a58058', '#8d6a47'],
  plaster: FACADE_PALETTE,
};
/** Цвета скатных крыш (крашеный металл) и куполов. */
const ROOF_PALETTE = ['#b0533a', '#9c4632', '#c06a45', '#7c4a3a', '#4f6b5a', '#6d7378', '#8a5a44', '#5d6f7a', '#a65a3c'];
const DOME_PALETTE = ['#c9a14a', '#4f8a72', '#5f7f99'];
/** Деревня: бревенчатые и обшитые доской дома, крашеная обшивка, белый силикатный и красный кирпич. */
const VILLAGE_FACADE_PALETTE = ['#8a6a4a', '#a07a52', '#c4ad86', '#7fa2b6', '#9fb48e', '#e6dcc4', '#dcd7cb', '#b0644b', '#cdb874', '#6f8ea4'];
/** Деревня: профнастил и железо — зелёный, синий, вишнёвый, серый, коричневый. */
const VILLAGE_ROOF_PALETTE = ['#3f6b4f', '#3d5f7f', '#843a2f', '#6b7176', '#5b4636', '#7d8a8e'];

const UTILITY_TYPES = new Set(['garage', 'garages', 'shed', 'service', 'industrial', 'warehouse', 'transformer_tower', 'roof', 'construction']);
const TEMPLE_TYPES = new Set(['church', 'cathedral', 'chapel', 'mosque', 'synagogue', 'temple']);
/** Здания без окон на фасаде. */
const BLANK_TYPES = new Set(['garage', 'garages', 'shed', 'service', 'transformer_tower', 'roof', 'construction', 'hut']);
/** Типы старой малоэтажной застройки, которым по умолчанию достаётся скатная крыша. */
const PITCHED_BY_DEFAULT = new Set(['house', 'detached', 'semidetached_house', 'terrace', 'residential', 'yes', 'dormitory', 'kindergarten', 'church', 'chapel']);

export const LEVEL_HEIGHT = 3.2;

export interface RoofPlan {
  shape: RoofShape;
  height: number;
  /** Крыша описана в OSM — её высота уже входит в height здания. */
  osm: boolean;
  triangles: ReturnType<typeof roofTriangles>;
  frame?: RoofFrame;
}

/**
 * Крыша здания: форма из OSM, а для невысоких почти прямоугольных домов старой застройки —
 * скатная по умолчанию (вальмовая или двускатная). Не строится — плоская.
 */
export function planRoof(props: BaseBuildingProperties, localRing: Vec2[], hasHoles: boolean, village: boolean): RoofPlan {
  const flat: RoofPlan = { shape: 'flat', height: 0, osm: false, triangles: undefined };
  if (hasHoles || localRing.length < 3) return flat;
  const box = orientedBox(localRing);
  const area = Math.abs(signedArea(localRing));

  let shape: RoofShape = props.roofShape ?? 'flat';
  const osm = !!props.roofShape;
  if (!osm) {
    const levels = props.levels ?? Math.round(props.height / LEVEL_HEIGHT);
    const pick = hashString(props.id) % 10;
    const eligible =
      PITCHED_BY_DEFAULT.has(props.building) &&
      levels <= 3 &&
      props.minHeight === 0 &&
      area >= (village ? 8 : 40) &&
      area <= 1500 &&
      rectangularity(localRing, box) >= 0.6;
    // В городе плоская крыша у трети малоэтажных домов, в деревне — почти ни у кого.
    if (!eligible || pick < (village ? 1 : 3)) return flat;
    shape = pick < (village ? 5 : 7) ? 'hipped' : 'gabled';
  }

  const height = props.roofHeight ?? defaultRoofHeight(shape, box, area);
  const orientation = props.roofOrientation === 'across' ? 'across' : 'along';
  // Свес скатов за стены: у деревенского дома ~0,5 м, у больших зданий пропорционально, но не больше 0,6 м.
  const overhang = village ? 0.5 : Math.min(Math.max(box.halfV * 0.06, 0.25), 0.6);
  const triangles = roofTriangles(localRing, shape, height, orientation, overhang);
  return triangles ? { shape, height, osm, triangles, frame: roofFrame(localRing, shape, height, orientation) } : flat;
}

/** Цвет кровли (CSS): из OSM (roof:colour) или стабильный по хешу id. */
export function roofColorHex(props: BaseBuildingProperties, shape: RoofShape, village: boolean): string {
  if (props.roofColour && isCssColor(props.roofColour)) return props.roofColour;
  const options = shape === 'dome' || shape === 'onion' ? DOME_PALETTE : village ? VILLAGE_ROOF_PALETTE : ROOF_PALETTE;
  return options[hashString(`${props.id}:roof`) % options.length]!;
}

/** Цвет фасада (CSS): из OSM (building:colour), по материалу или стабильный по хешу id с учётом типа. */
export function facadeColorHex(props: BaseBuildingProperties, village = false): string {
  if (props.colour && isCssColor(props.colour)) return props.colour;
  if (TEMPLE_TYPES.has(props.building)) return TEMPLE_COLOR;
  const byMaterial = props.material ? MATERIAL_PALETTES[props.material.toLowerCase()] : undefined;
  const options = byMaterial ?? (UTILITY_TYPES.has(props.building) ? UTILITY_PALETTE : village ? VILLAGE_FACADE_PALETTE : FACADE_PALETTE);
  return options[hashString(props.id) % options.length]!;
}

/** Высота этажа для рисования окон; 0 — без окон. */
export function floorHeight(props: BaseBuildingProperties, wallTop: number): number {
  if (BLANK_TYPES.has(props.building) || wallTop < 3) return 0;
  if (!props.levels) return LEVEL_HEIGHT;
  return Math.min(Math.max((wallTop - props.minHeight) / props.levels, 2.8), 4.5);
}

export function polygonsOf(feature: BaseBuildingFeature): Ring[][] {
  return feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
}

/** Цвет из OSM годится, если его понимает CSS (в тестах без браузера — #rgb/#rrggbb). */
function isCssColor(value: string): boolean {
  const v = value.trim();
  if (typeof CSS !== 'undefined' && typeof CSS.supports === 'function') return CSS.supports('color', v);
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v);
}
