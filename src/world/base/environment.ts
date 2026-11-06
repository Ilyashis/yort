import { territoryDataUrl, type Territory } from '../../config/territory';
import type { Ring } from './types';

/** Тип поверхности земли (порядок отрисовки задаёт GroundLayer). */
export type GroundKind =
  | 'green'
  | 'pitch'
  | 'water'
  | 'parking'
  | 'paving'
  | 'sidewalk'
  | 'road'
  | 'footway';

export interface GroundFeature {
  type: 'Feature';
  properties: { kind: GroundKind; name?: string };
  geometry:
    | { type: 'Polygon'; coordinates: Ring[] }
    | { type: 'MultiPolygon'; coordinates: Ring[][] };
}

export interface GroundCollection {
  type: 'FeatureCollection';
  features: GroundFeature[];
}

/** [долгота, широта, высота м (0 — неизвестна)]. */
export type TreePoint = [number, number, number];

export interface Environment {
  ground: GroundFeature[];
  trees: TreePoint[];
}

/**
 * Загружает окружение территории. Если файлов ещё нет (старая выгрузка) —
 * возвращает пустое окружение: город откроется без дорог и деревьев.
 */
export async function loadEnvironment(territory: Territory): Promise<Environment> {
  const [ground, trees] = await Promise.all([
    fetchOptional<GroundCollection>(territoryDataUrl(territory, 'ground.geojson')),
    fetchOptional<{ trees: TreePoint[] }>(territoryDataUrl(territory, 'trees.json')),
  ]);
  if (!ground || !trees) {
    console.warn('[environment] нет ground.geojson / trees.json — выполните npm run data:fetch:environment');
  }
  return { ground: ground?.features ?? [], trees: trees?.trees ?? [] };
}

async function fetchOptional<T>(url: string): Promise<T | undefined> {
  try {
    const response = await fetch(url);
    return response.ok ? ((await response.json()) as T) : undefined;
  } catch {
    return undefined;
  }
}

export function polygonsOfGround(feature: GroundFeature): Ring[][] {
  return feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
}
