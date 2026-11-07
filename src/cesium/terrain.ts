import {
  CustomHeightmapTerrainProvider,
  EllipsoidTerrainProvider,
  GeographicTilingScheme,
  Ion,
  Math as CesiumMath,
  createWorldTerrainAsync,
  type TerrainProvider,
} from 'cesium';
import { territoryDataUrl, type Territory } from '../config/territory';
import { HeightGrid, decodeTerrainFile, type TerrainFile } from '../world/base/heightGrid';

/** world — Cesium World Terrain (токен ion); dem — свой рельеф Copernicus из файла района; flat — без рельефа. */
export type TerrainKind = 'world' | 'dem' | 'flat';

export interface TerrainSetup {
  provider: TerrainProvider;
  kind: TerrainKind;
  /** Сетка высот своего рельефа (только для dem). */
  grid?: HeightGrid;
  /** Подпись источника данных рельефа. */
  credit?: string;
}

/** Узлов на сторону тайла рельефа: 33 = 32 ячейки, края соседних тайлов совпадают. */
const TILE_SAMPLES = 33;

const grids = new WeakMap<TerrainProvider, HeightGrid>();

/** Сетка высот, если провайдер — наш рельеф (для точной и мгновенной выборки высот). */
export function gridFor(provider: TerrainProvider): HeightGrid | undefined {
  return grids.get(provider);
}

/**
 * Рельеф по приоритету: токен Cesium ion → Cesium World Terrain;
 * иначе свой рельеф из terrain.json района (Copernicus DEM, без внешних сервисов);
 * иначе плоская земля. Любая ошибка — откат на следующий вариант, сцена всё равно откроется.
 */
export async function createTerrain(territory: Territory): Promise<TerrainSetup> {
  const token = import.meta.env.VITE_CESIUM_ION_TOKEN?.trim();
  if (token) {
    Ion.defaultAccessToken = token;
    try {
      return { provider: withFastMeshes(await createWorldTerrainAsync()), kind: 'world' };
    } catch (error) {
      console.warn('[terrain] Cesium World Terrain недоступен, пробую свой рельеф', error);
    }
  }

  try {
    const response = await fetch(territoryDataUrl(territory, 'terrain.json'));
    if (response.ok) {
      const file = (await response.json()) as TerrainFile;
      const grid = decodeTerrainFile(file);
      const provider = withFastMeshes(createDemProvider(grid, file.metadata.credit));
      grids.set(provider, grid);
      return { provider, kind: 'dem', grid, credit: file.metadata.credit };
    }
  } catch (error) {
    console.warn('[terrain] не удалось загрузить terrain.json, рельеф будет плоским', error);
  }

  return { provider: new EllipsoidTerrainProvider(), kind: 'flat' };
}

/** Высота земли в точке для любого вида рельефа. */
export function heightSampler(
  terrain: TerrainSetup,
  globeHeight: (lon: number, lat: number) => number | undefined,
): (lon: number, lat: number) => number {
  if (terrain.grid) {
    const grid = terrain.grid;
    return (lon, lat) => grid.heightAt(lon, lat);
  }
  if (terrain.kind === 'world') return (lon, lat) => globeHeight(lon, lat) ?? 0;
  return () => 0;
}

/**
 * Сетки тайлов рельефа — без очереди «не больше 5 за раз» (TerrainData.maximumAsynchronousTasks).
 * С ней после поворота камеры видимые тайлы уточнялись по ~5 за кадр, и земля оставалась
 * размытой 2–5 секунд; сетка 33×33 строится в воркере за доли миллисекунды — ограничение лишнее.
 */
interface MeshSource {
  createMesh: (options: Record<string, unknown>) => unknown;
}

function withFastMeshes<T extends TerrainProvider>(provider: T): T {
  const request = provider.requestTileGeometry.bind(provider);
  provider.requestTileGeometry = (x, y, level, ...rest) =>
    request(x, y, level, ...rest)?.then((data) => {
      // createMesh у Cesium внутренний (@private), в типах его нет.
      const mesh = data as unknown as MeshSource;
      const createMesh = mesh.createMesh.bind(mesh);
      mesh.createMesh = (options) => createMesh({ ...options, throttle: false });
      return data;
    });
  return provider;
}

/** Провайдер Cesium поверх нашей сетки: каждый тайл — выборка высот с билинейной интерполяцией. */
function createDemProvider(grid: HeightGrid, credit: string): CustomHeightmapTerrainProvider {
  const tilingScheme = new GeographicTilingScheme();
  return new CustomHeightmapTerrainProvider({
    width: TILE_SAMPLES,
    height: TILE_SAMPLES,
    tilingScheme,
    credit,
    callback: (x, y, level) => {
      const rect = tilingScheme.tileXYToRectangle(x, y, level);
      const west = CesiumMath.toDegrees(rect.west);
      const east = CesiumMath.toDegrees(rect.east);
      const north = CesiumMath.toDegrees(rect.north);
      const south = CesiumMath.toDegrees(rect.south);
      const heights = new Float32Array(TILE_SAMPLES * TILE_SAMPLES);
      for (let row = 0; row < TILE_SAMPLES; row++) {
        const lat = north - ((north - south) * row) / (TILE_SAMPLES - 1);
        for (let col = 0; col < TILE_SAMPLES; col++) {
          const lon = west + ((east - west) * col) / (TILE_SAMPLES - 1);
          heights[row * TILE_SAMPLES + col] = grid.heightAt(lon, lat);
        }
      }
      return heights;
    },
  });
}
