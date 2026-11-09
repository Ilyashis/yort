import { create } from 'zustand';
import { DEFAULT_VOLUMES, type Volumes } from '../audio/AudioEngine';
import type { GraphicsQuality } from '../three/CityScene';
import type { DriveHudState, DriveView } from '../three/DriveController';
import { CAR_COLORS } from '../world/drive/carModel';
import type { MinimapSource } from '../world/map/minimap';
import { DEFAULT_TIME } from '../three/dayNight';
import { defaultTerritory, findTerritory, territories } from '../config/territory';
import type { TerrainKind } from '../world/base/heightGrid';
import { readPref, writePref } from '../utils/prefs';
import type { BuildingColorMode } from '../world/base/buildingPlan';
import type { BaseBuildingProperties, BaseBuildingsStats } from '../world/base/types';
import type { UserBuilding } from '../world/user/userBuildings';
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
export type InteractionMode = 'explore' | 'draw-plot' | 'pick-walk-start' | 'walk' | 'pick-drive-start' | 'drive';

/** На улице от первого лица: пешком или на машине (боковые панели прячутся, видна мини-карта). */
export const isOnStreet = (mode: InteractionMode) => mode === 'walk' || mode === 'drive';

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
  /** Ждать клика по улице, с которой начнётся прогулка (или поездка — машина встанет на ближайшую дорогу). */
  pickStart: (kind?: 'walk' | 'drive') => void;
  cancelPick: () => void;
  exit: () => void;
}

/** Команды машины; регистрирует сцена, вызывает UI. */
export interface DriveControls {
  toggleView: () => void;
  backToRoad: () => void;
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

/** Время суток из браузера (если сохранено и в порядке). */
function readTime(): number {
  try {
    const saved = Number(window.localStorage.getItem('citia:time'));
    return window.localStorage.getItem('citia:time') !== null && saved >= 0 && saved < 24 ? saved : DEFAULT_TIME;
  } catch {
    return DEFAULT_TIME;
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
  /** Время суток (местное, часы 0..24) и идёт ли оно само (запоминается в браузере). */
  timeOfDay: number;
  timeFlowing: boolean;
  /** Деревня из моделей: дома OSM нарисованы башкирскими домами (запоминается в браузере). */
  villageModels: boolean;
  /** Дымка вдали и мягкое размытие дали (запоминаются в браузере). */
  haze: boolean;
  blur: boolean;
  /** Контуры, как на рисунке. */
  outlines: boolean;
  /** Уточнения по своей съёмке с дрона: рельеф, цвета домов, новые постройки (запоминается в браузере). */
  surveyOn: boolean;
  /** Что из съёмки есть у этого района (undefined — съёмки нет). */
  survey?: { terrain: boolean; colored: number; added: number };
  /** За рулём: приборы, камера, цвет машины (цвет запоминается в браузере). */
  driveHud: DriveHudState;
  driveView: DriveView;
  carColor: string;
  /** Мини-карта на улице (запоминается в браузере) и кто её рисует (регистрирует сцена). */
  minimapOn: boolean;
  minimap?: MinimapSource;

  /** Регистрирует сцена; UI вызывает, чтобы вернуть камеру к территории. */
  flyHome?: () => void;
  plotControls?: PlotControls;
  walkControls?: WalkControls;
  driveControls?: DriveControls;

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
  setTimeOfDay: (hours: number) => void;
  setTimeFlowing: (on: boolean) => void;
  setVillageModels: (on: boolean) => void;
  setHaze: (on: boolean) => void;
  setBlur: (on: boolean) => void;
  setOutlines: (on: boolean) => void;
  setSurveyOn: (on: boolean) => void;
  setSurvey: (survey: AppState['survey']) => void;
  setWalkMouseLocked: (locked: boolean) => void;
  setDriveControls: (controls: DriveControls | undefined) => void;
  setDriveHud: (hud: DriveHudState) => void;
  setDriveView: (view: DriveView) => void;
  setCarColor: (color: string) => void;
  setMinimapOn: (on: boolean) => void;
  setMinimap: (source: MinimapSource | undefined) => void;
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
  timeOfDay: readTime(),
  timeFlowing: readPref('time-flow', ['on', 'off'] as const, 'off') === 'on',
  villageModels: readPref('village-models', ['on', 'off'] as const, 'on') === 'on',
  haze: readPref('haze', ['on', 'off'] as const, 'on') === 'on',
  blur: readPref('blur', ['on', 'off'] as const, 'off') === 'on',
  outlines: readPref('outlines', ['on', 'off'] as const, 'off') === 'on',
  surveyOn: readPref('survey', ['on', 'off'] as const, 'on') === 'on',
  walkMouseLocked: false,
  driveHud: { speed: 0, gear: 'N' },
  driveView: 'chase',
  carColor: readPref('car-color', CAR_COLORS.map((c) => c.color), CAR_COLORS[0]!.color),
  minimapOn: readPref('minimap', ['on', 'off'] as const, 'on') === 'on',
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
  setTimeOfDay: (hours) => {
    const timeOfDay = ((hours % 24) + 24) % 24;
    writePref('time', timeOfDay.toFixed(3));
    set({ timeOfDay });
  },
  setTimeFlowing: (timeFlowing) => {
    writePref('time-flow', timeFlowing ? 'on' : 'off');
    set({ timeFlowing });
  },
  setVillageModels: (villageModels) => {
    writePref('village-models', villageModels ? 'on' : 'off');
    set({ villageModels });
  },
  setHaze: (haze) => {
    writePref('haze', haze ? 'on' : 'off');
    set({ haze });
  },
  setBlur: (blur) => {
    writePref('blur', blur ? 'on' : 'off');
    set({ blur });
  },
  setOutlines: (outlines) => {
    writePref('outlines', outlines ? 'on' : 'off');
    set({ outlines });
  },
  setSurveyOn: (surveyOn) => {
    writePref('survey', surveyOn ? 'on' : 'off');
    set({ surveyOn });
  },
  setSurvey: (survey) => set({ survey }),
  setWalkMouseLocked: (walkMouseLocked) => set({ walkMouseLocked }),
  setDriveControls: (driveControls) => set({ driveControls }),
  setDriveHud: (driveHud) => {
    const prev = get().driveHud;
    if (prev.speed !== driveHud.speed || prev.gear !== driveHud.gear) set({ driveHud });
  },
  setDriveView: (driveView) => set({ driveView }),
  setCarColor: (carColor) => {
    writePref('car-color', carColor);
    set({ carColor });
  },
  setMinimapOn: (minimapOn) => {
    writePref('minimap', minimapOn ? 'on' : 'off');
    set({ minimapOn });
  },
  setMinimap: (minimap) => set({ minimap }),
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
