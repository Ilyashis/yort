import { create } from 'zustand';
import type { TerrainKind } from '../cesium/terrain';
import type { BaseBuildingProperties, BaseBuildingsStats } from '../world/base/types';
import type { LonLat, PlotAnalysis } from '../world/user/plot';

export type LoadStatus = 'loading' | 'ready' | 'error';

/** Что сейчас делает левый клик по сцене. */
export type InteractionMode = 'explore' | 'draw-plot';

/** Команды инструменту участка; регистрирует сцена, вызывает UI. */
export interface PlotControls {
  start: () => void;
  finish: () => void;
  undo: () => void;
  cancel: () => void;
  clear: () => void;
}

interface AppState {
  status: LoadStatus;
  error?: string;
  terrain?: TerrainKind;
  stats?: BaseBuildingsStats;
  selectedBuilding?: BaseBuildingProperties;
  mode: InteractionMode;
  /** Вершины участка, пока он рисуется. */
  plotDraft: LonLat[];
  /** Готовый участок и результат его проверки. */
  plot?: PlotAnalysis;

  /** Регистрирует сцена; UI вызывает, чтобы вернуть камеру к территории. */
  flyHome?: () => void;
  plotControls?: PlotControls;

  setStatus: (status: LoadStatus, error?: string) => void;
  setTerrain: (terrain: TerrainKind) => void;
  setStats: (stats: BaseBuildingsStats) => void;
  selectBuilding: (building: BaseBuildingProperties | undefined) => void;
  setFlyHome: (flyHome: (() => void) | undefined) => void;
  setPlotControls: (controls: PlotControls | undefined) => void;

  plotDrawingStarted: () => void;
  setPlotDraft: (points: LonLat[]) => void;
  plotFinished: (plot: PlotAnalysis) => void;
  plotDrawingCancelled: () => void;
  plotCleared: () => void;
}

export const useAppStore = create<AppState>()((set) => ({
  status: 'loading',
  mode: 'explore',
  plotDraft: [],

  setStatus: (status, error) => set({ status, error }),
  setTerrain: (terrain) => set({ terrain }),
  setStats: (stats) => set({ stats }),
  selectBuilding: (selectedBuilding) => set({ selectedBuilding }),
  setFlyHome: (flyHome) => set({ flyHome }),
  setPlotControls: (plotControls) => set({ plotControls }),

  plotDrawingStarted: () =>
    set({ mode: 'draw-plot', plotDraft: [], plot: undefined, selectedBuilding: undefined }),
  setPlotDraft: (plotDraft) => set({ plotDraft }),
  plotFinished: (plot) => set({ mode: 'explore', plotDraft: [], plot }),
  plotDrawingCancelled: () => set({ mode: 'explore', plotDraft: [] }),
  plotCleared: () => set({ plot: undefined }),
}));
