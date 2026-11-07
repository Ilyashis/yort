import { baseBuildingsUrl, territoryDataUrl, type Territory } from '../../config/territory';
import type { BaseBuildingsCollection, BaseBuildingsStats } from './types';

export async function loadBaseBuildings(territory: Territory): Promise<BaseBuildingsCollection> {
  const url = baseBuildingsUrl(territory);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Не найдены данные зданий (${url}, HTTP ${response.status}). Выполните: npm run data:fetch`,
    );
  }
  return (await response.json()) as BaseBuildingsCollection;
}

/** Части зданий (building:part); файла может не быть — тогда частей нет. */
export async function loadBuildingParts(territory: Territory): Promise<BaseBuildingsCollection['features']> {
  try {
    const response = await fetch(territoryDataUrl(territory, 'building-parts.geojson'));
    if (!response.ok) return [];
    return ((await response.json()) as BaseBuildingsCollection).features;
  } catch {
    return [];
  }
}

export function computeStats(collection: BaseBuildingsCollection): BaseBuildingsStats {
  const bySource = { height: 0, levels: 0, default: 0 };
  for (const feature of collection.features) bySource[feature.properties.heightSource]++;
  return {
    total: collection.features.length,
    bySource,
    osmTimestamp: collection.metadata.osmTimestamp,
  };
}
