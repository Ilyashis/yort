import { Cartographic, EllipsoidTerrainProvider, sampleTerrainMostDetailed, type TerrainProvider } from 'cesium';
import type { LonLat } from '../world/user/plot';
import { gridFor } from './terrain';

/**
 * Высоты рельефа для групп точек: для каждой группы — минимум по её точкам
 * (чтобы объекты на склонах не висели в воздухе). На плоском рельефе — нули,
 * на своём рельефе — мгновенно по сетке высот, на Cesium World Terrain — запросом тайлов.
 */
export async function sampleMinHeights(
  groups: readonly (readonly LonLat[])[],
  terrainProvider: TerrainProvider,
): Promise<number[]> {
  const result = groups.map(() => 0);
  if (terrainProvider instanceof EllipsoidTerrainProvider) return result;

  const grid = gridFor(terrainProvider);
  if (grid) {
    return groups.map((group) =>
      group.length ? Math.min(...group.map(([lon, lat]) => grid.heightAt(lon, lat))) : 0,
    );
  }

  const owners: number[] = [];
  const points: Cartographic[] = [];
  groups.forEach((group, index) => {
    for (const [lon, lat] of group) {
      owners.push(index);
      points.push(Cartographic.fromDegrees(lon, lat));
    }
  });

  try {
    await sampleTerrainMostDetailed(terrainProvider, points);
  } catch (error) {
    console.warn('[terrain] не удалось получить высоты рельефа, объекты стоят на нуле', error);
    return result;
  }

  const seen = new Set<number>();
  points.forEach((point, i) => {
    const owner = owners[i]!;
    if (!seen.has(owner) || point.height < result[owner]!) result[owner] = point.height;
    seen.add(owner);
  });
  return result;
}
