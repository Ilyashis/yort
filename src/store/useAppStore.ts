import { create } from 'zustand';
import type { TerrainKind } from '../cesium/terrain';
import type { BaseBuildingProperties, BaseBuildingsStats } from '../world/base/types';

export type LoadStatus = 'loading' | 'ready' | 'error';

interface AppState {
  status: LoadStatus;
  error?: string;
  terrain?: TerrainKind;
  stats?: BaseBuildingsStats;
  selectedBuilding?: BaseBuildingProperties;
  /** Регистрирует сцена; UI вызывает, чтобы вернуть камеру к территории. */
  flyHome?: () => void;

  setStatus: (status: LoadStatus, error?: string) => void;
  setTerrain: (terrain: TerrainKind) => void;
  setStats: (stats: BaseBuildingsStats) => void;
  selectBuilding: (building: BaseBuildingProperties | undefined) => void;
  setFlyHome: (flyHome: (() => void) | undefined) => void;
}

export const useAppStore = create<AppState>()((set) => ({
  status: 'loading',

  setStatus: (status, error) => set({ status, error }),
  setTerrain: (terrain) => set({ terrain }),
  setStats: (stats) => set({ stats }),
  selectBuilding: (selectedBuilding) => set({ selectedBuilding }),
  setFlyHome: (flyHome) => set({ flyHome }),
}));
