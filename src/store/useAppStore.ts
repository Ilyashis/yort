import { create } from 'zustand';
import { DEFAULT_VOLUMES, type Volumes } from '../audio/AudioEngine';
import type { GraphicsQuality } from '../cesium/createViewer';
import { defaultTerritory, findTerritory, territories } from '../config/territory';
import type { TerrainKind } from '../cesium/terrain';
import { readPref, writePref } from '../utils/prefs';
import type { BuildingColorMode } from '../world/base/BaseBuildingsLayer';
import type { BaseBuildingProperties, BaseBuildingsStats } from '../world/base/types';
import type { UserBuilding } from '../world/user/UserBuildingsLayer';
import {
  defaultSpec,
  generateBuilding,
  type BuildingSpec,
  type BuildingType,
  type BuildResult,
} from '../world/user/building';
import type { LonLat, PlotAnalysis } from '../world/user/plot';

export type LoadStatus = 'loading' | 'ready' | 'error';

/** Конструктор здания на участке: текущая спецификация и результат генерации. */
export interface BuilderState {
  spec: BuildingSpec;
  result: BuildResult;
}

const builderFor = (spec: BuildingSpec, plot: readonly LonLat[]): BuilderState => ({
  spec,
  result: generateBuilding(spec, plot),
});

let buildingCounter = 0;
const newBuildingId = () => `${Date.now().toString(36)}-${(buildingCounter++).toString(36)}`;

/** Что сейчас делает левый клик по сцене. */
export type InteractionMode = 'explore' | 'draw-plot' | 'pick-walk-start' | 'walk';

/** Команды инструменту участка; регистрирует сцена, вызывает UI. */
export interface PlotControls {
  start: () => void;
  finish: () => void;
  undo: () => void;
  cancel: () => void;
  clear: () => void;
}

/** Команды прогулки; регистрирует сцена, вызывает UI. */
export interface WalkControls {
  /** Ждать клика по улице, с которой начнётся прогулка. */
  pickStart: () => void;
  cancelPick: () => void;
  exit: () => void;
}

/** Громкость по группам из браузера (если сохранена и в порядке). */
function readVolumes(): Volumes {
  try {
    const saved = JSON.parse(window.localStorage.getItem('citia:volumes') ?? 'null') as Partial<Volumes> | null;
    const pick = (key: keyof Volumes) => {
      const v = saved?.[key];
      return typeof v === 'number' && v >= 0 && v <= 1 ? v : DEFAULT_VOLUMES[key];
    };
    return { master: pick('master'), music: pick('music'), ambience: pick('ambience'), sfx: pick('sfx') };
  } catch {
    return DEFAULT_VOLUMES;
  }
}

/** Населённый пункт при открытии: из ссылки (?place=…), иначе последний выбранный. */
function initialTerritoryId(): string {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('place');
    if (findTerritory(fromUrl)) return fromUrl!;
  } catch {
    // Нет адресной строки (тесты) — берём из настроек.
  }
  return readPref('place', territories.map((t) => t.id), defaultTerritory.id);
}

/** Ссылка на текущий населённый пункт — её можно отправить. */
function writeTerritoryToUrl(id: string): void {
  try {
    const url = new URL(window.location.href);
    if (id === defaultTerritory.id) url.searchParams.delete('place');
    else url.searchParams.set('place', id);
    window.history.replaceState(null, '', url);
  } catch {
    // Не критично: просто не будет ссылки.
  }
}

interface AppState {
  /** Выбранный населённый пункт (id из territories.json). */
  territoryId: string;
  status: LoadStatus;
  error?: string;
  terrain?: TerrainKind;
  stats?: BaseBuildingsStats;
  selectedBuilding?: BaseBuildingProperties;
  buildingColorMode: BuildingColorMode;
  mode: InteractionMode;
  /** Вершины участка, пока он рисуется. */
  plotDraft: LonLat[];
  /** Готовый участок и результат его проверки. */
  plot?: PlotAnalysis;
  /** Улица под ногами во время прогулки. */
  walkStreet?: string;
  /** На прогулке курсор захвачен для обзора мышью. */
  walkMouseLocked: boolean;
  /** Открыта подсказка по управлению (при первом визите — сама). */
  helpOpen: boolean;
  /** Открыт конструктор здания на текущем участке. */
  builder?: BuilderState;
  /** Размещённые здания пользователя (User World, пока — в памяти вкладки). */
  userBuildings: UserBuilding[];
  /** Музыка и звуки города (запоминается в браузере). */
  soundOn: boolean;
  /** Громкость по группам (запоминается в браузере). */
  volumes: Volumes;
  /** Вид камеры: сверху (план) или под углом — для подсветки кнопки. */
  viewMode: 'top' | 'tilt';
  /** Качество графики (запоминается в браузере). */
  graphicsQuality: GraphicsQuality;

  /** Регистрирует сцена; UI вызывает, чтобы вернуть камеру к территории. */
  flyHome?: () => void;
  plotControls?: PlotControls;
  walkControls?: WalkControls;

  /** Переключает населённый пункт: сцена пересоздаётся, постройки пользователя сбрасываются. */
  setTerritory: (id: string) => void;
  setStatus: (status: LoadStatus, error?: string) => void;
  setTerrain: (terrain: TerrainKind) => void;
  setStats: (stats: BaseBuildingsStats) => void;
  selectBuilding: (building: BaseBuildingProperties | undefined) => void;
  setBuildingColorMode: (mode: BuildingColorMode) => void;
  setFlyHome: (flyHome: (() => void) | undefined) => void;
  setPlotControls: (controls: PlotControls | undefined) => void;
  setWalkControls: (controls: WalkControls | undefined) => void;
  setMode: (mode: InteractionMode) => void;
  setWalkStreet: (street: string | undefined) => void;
  setSoundOn: (on: boolean) => void;
  setVolumes: (patch: Partial<Volumes>) => void;
  setViewMode: (mode: 'top' | 'tilt') => void;
  /** Регистрирует сцена: перелёт к виду сверху или под углом. */
  changeView?: (mode: 'top' | 'tilt') => void;
  setChangeView: (change: ((mode: 'top' | 'tilt') => void) | undefined) => void;
  setGraphicsQuality: (quality: GraphicsQuality) => void;
  setWalkMouseLocked: (locked: boolean) => void;
  setHelpOpen: (open: boolean) => void;

  plotDrawingStarted: () => void;
  setPlotDraft: (points: LonLat[]) => void;
  plotFinished: (plot: PlotAnalysis) => void;
  plotDrawingCancelled: () => void;
  plotCleared: () => void;

  startBuilder: () => void;
  setBuildingType: (type: BuildingType) => void;
  updateSpec: (patch: Partial<BuildingSpec>) => void;
  cancelBuilder: () => void;
  /** Переносит здание из конструктора в User World; true — если разместили. */
  placeBuilding: () => boolean;
  removeUserBuilding: (id: string) => void;
}

export const useAppStore = create<AppState>()((set, get) => ({
  territoryId: initialTerritoryId(),
  status: 'loading',
  buildingColorMode: 'city',
  mode: 'explore',
  plotDraft: [],
  userBuildings: [],
  soundOn: readPref('sound', ['on', 'off'], 'on') === 'on',
  volumes: readVolumes(),
  viewMode: 'tilt',
  graphicsQuality: readPref('graphics', ['high', 'normal'] as const, 'high'),
  walkMouseLocked: false,
  helpOpen: readPref('help', ['seen', 'new'] as const, 'new') !== 'seen',

  setTerritory: (territoryId) => {
    if (territoryId === get().territoryId || !findTerritory(territoryId)) return;
    writePref('place', territoryId);
    writeTerritoryToUrl(territoryId);
    set({
      territoryId,
      status: 'loading',
      error: undefined,
      stats: undefined,
      terrain: undefined,
      selectedBuilding: undefined,
      mode: 'explore',
      plotDraft: [],
      plot: undefined,
      builder: undefined,
      userBuildings: [],
      walkStreet: undefined,
    });
  },
  setStatus: (status, error) => set({ status, error }),
  setTerrain: (terrain) => set({ terrain }),
  setStats: (stats) => set({ stats }),
  selectBuilding: (selectedBuilding) => set({ selectedBuilding }),
  setBuildingColorMode: (buildingColorMode) => set({ buildingColorMode }),
  setFlyHome: (flyHome) => set({ flyHome }),
  setPlotControls: (plotControls) => set({ plotControls }),
  setWalkControls: (walkControls) => set({ walkControls }),
  setMode: (mode) => set({ mode }),
  setWalkStreet: (walkStreet) => set({ walkStreet }),
  setSoundOn: (soundOn) => {
    writePref('sound', soundOn ? 'on' : 'off');
    set({ soundOn });
  },
  setVolumes: (patch) => {
    const volumes = { ...get().volumes, ...patch };
    writePref('volumes', JSON.stringify(volumes));
    set({ volumes });
  },
  setViewMode: (viewMode) => {
    if (viewMode !== get().viewMode) set({ viewMode });
  },
  setChangeView: (changeView) => set({ changeView }),
  setGraphicsQuality: (graphicsQuality) => {
    writePref('graphics', graphicsQuality);
    set({ graphicsQuality });
  },
  setWalkMouseLocked: (walkMouseLocked) => set({ walkMouseLocked }),
  setHelpOpen: (helpOpen) => {
    if (!helpOpen) writePref('help', 'seen');
    set({ helpOpen });
  },

  plotDrawingStarted: () =>
    set({ mode: 'draw-plot', plotDraft: [], plot: undefined, selectedBuilding: undefined, builder: undefined }),
  setPlotDraft: (plotDraft) => set({ plotDraft }),
  plotFinished: (plot) => set({ mode: 'explore', plotDraft: [], plot }),
  plotDrawingCancelled: () => set({ mode: 'explore', plotDraft: [] }),
  plotCleared: () => set({ plot: undefined, builder: undefined }),

  startBuilder: () => {
    const { plot } = get();
    if (!plot?.valid) return;
    set({ builder: builderFor(defaultSpec('residential'), plot.polygon), selectedBuilding: undefined });
  },
  setBuildingType: (type) => {
    const { plot, builder } = get();
    if (!plot || !builder) return;
    set({ builder: builderFor(defaultSpec(type, builder.spec.setback), plot.polygon) });
  },
  updateSpec: (patch) => {
    const { plot, builder } = get();
    if (!plot || !builder) return;
    set({ builder: builderFor({ ...builder.spec, ...patch }, plot.polygon) });
  },
  cancelBuilder: () => set({ builder: undefined }),
  placeBuilding: () => {
    const { builder, userBuildings } = get();
    const building = builder?.result.building;
    if (!builder || !building || builder.result.issues.length > 0) return false;
    set({
      userBuildings: [...userBuildings, { id: newBuildingId(), spec: builder.spec, building }],
      builder: undefined,
    });
    return true;
  },
  removeUserBuilding: (id) =>
    set((state) => ({
      userBuildings: state.userBuildings.filter((b) => b.id !== id),
      selectedBuilding: undefined,
    })),
}));
