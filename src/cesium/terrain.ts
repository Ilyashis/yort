import { EllipsoidTerrainProvider, Ion, createWorldTerrainAsync, type TerrainProvider } from 'cesium';

export type TerrainKind = 'world' | 'flat';

export interface TerrainSetup {
  provider: TerrainProvider;
  kind: TerrainKind;
}

/**
 * С токеном Cesium ion — рельеф Cesium World Terrain, без токена — плоский эллипсоид.
 * Если ion недоступен, тихо откатываемся на плоский вариант, чтобы сцена всё равно открылась.
 */
export async function createTerrain(): Promise<TerrainSetup> {
  const token = import.meta.env.VITE_CESIUM_ION_TOKEN?.trim();
  if (!token) {
    return { provider: new EllipsoidTerrainProvider(), kind: 'flat' };
  }

  Ion.defaultAccessToken = token;
  try {
    return { provider: await createWorldTerrainAsync(), kind: 'world' };
  } catch (error) {
    console.warn('[terrain] Cesium World Terrain недоступен, использую плоский рельеф', error);
    return { provider: new EllipsoidTerrainProvider(), kind: 'flat' };
  }
}
