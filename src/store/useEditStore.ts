import { create } from 'zustand';
import { CAN_EDIT } from '../config/mode';
import { EMPTY_EDITS, parseEdits, type EditRoadKind, type EditedBuilding, type Edits, type FenceLook, type HouseModelRef } from '../world/edit/edits';
import type { FenceStyle } from '../world/village/estates';
import type { HouseModelId } from '../world/village/houseModels';
import type { SculptLevelBy, SculptMode } from '../world/base/sculpt';
import { fetchRetry } from '../utils/fetchRetry';

/** Инструменты редактора (как в градостроителях): выбор, дом растяжкой, дорога и забор линией, кисть рельефа. */
export type EditTool = 'select' | 'house' | 'road' | 'fence' | 'terrain';

/** Настройки кисти рельефа. */
export interface SculptSettings {
  mode: SculptMode;
  /** Радиус, м. */
  radius: number;
  /** Сила, 0.05…1. */
  strength: number;
  /** Кистью или обвести область (только «выровнять» и «сгладить»). */
  shape?: 'brush' | 'area';
  /** «Выровнять» обводкой: к какой высоте (по умолчанию — средняя). */
  levelBy?: SculptLevelBy;
}

/** Вид выделенного забора для панели. */
export interface FenceInfo {
  own: boolean;
  style: FenceStyle;
  height: number;
  color?: string;
  /** У участка есть уличный забор (иначе вид — у всех его заборов). */
  hasStreet: boolean;
  /** Ворота и калитка: есть ли, сторона калитки, козырёк. */
  gate: { gate: boolean; wicket: boolean; wicketSide: -1 | 1; canopy: boolean };
}

/** Как рисовать дорогу: по точкам, линией (карандаш) или кистью (свободная форма, своя ширина). */
export type RoadDraw = 'points' | 'line' | 'brush';

export type Selection =
  | { type: 'building'; id: string }
  | { type: 'road'; id: string }
  | { type: 'fence'; id: string }
  /** Мелочь двора посёлка (id — ключ «участок#номер»). */
  | { type: 'prop'; id: string };

const HISTORY_LIMIT = 100;
const storageKey = (territoryId: string) => `citia:edits:${territoryId}`;

/** Черновик редактора в браузере (неопубликованные правки); у зрителя черновиков нет. */
function loadDraft(territoryId: string): Edits | undefined {
  if (!CAN_EDIT) return undefined;
  try {
    const raw = window.localStorage.getItem(storageKey(territoryId));
    return (raw && parseEdits(JSON.parse(raw))) || undefined;
  } catch {
    return undefined;
  }
}

/** Черновик в браузер; совпадает с опубликованным — черновика нет. */
function saveEdits(territoryId: string, edits: Edits, published: Edits): void {
  if (!CAN_EDIT) return;
  try {
    if (sameEdits(edits, published)) window.localStorage.removeItem(storageKey(territoryId));
    else window.localStorage.setItem(storageKey(territoryId), JSON.stringify(edits));
  } catch {
    // Хранилище недоступно — правки живут до перезагрузки вкладки.
  }
}

export const sameEdits = (a: Edits, b: Edits) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** Опубликованные правки района (файл данных); нет файла — правок нет. */
export async function fetchPublishedEdits(url: string): Promise<Edits> {
  try {
    const response = await fetchRetry(url, { cache: 'no-cache' });
    if (!response.ok || !(response.headers.get('content-type') ?? '').includes('json')) return EMPTY_EDITS;
    return parseEdits(await response.json()) ?? EMPTY_EDITS;
  } catch {
    return EMPTY_EDITS;
  }
}

interface EditState {
  territoryId?: string;
  edits: Edits;
  /** Опубликованные правки (из файла данных): то, что видят все. edits — они же плюс черновик редактора. */
  published: Edits;
  past: Edits[];
  future: Edits[];
  tool?: EditTool;
  selection?: Selection;
  /** Тип дороги для инструмента «Дорога». */
  roadKind: EditRoadKind;
  /** Модель для инструмента «Дом» (изба, кирпичный…); нет — простой объём растяжкой. */
  houseModel?: HouseModelId;
  /** Кисть для инструмента «Рельеф». */
  sculpt: SculptSettings;
  /** Забор: карандашом (ведите линию) или по точкам (клик — точка). */
  fenceDraw: 'pencil' | 'points';
  /** Заборы участков: есть ли правки у участка и сброс (регистрирует сцена). */
  fenceTools?: {
    edited: (id: string) => boolean;
    reset: (id: string) => void;
    info: (id: string) => FenceInfo | undefined;
    setLook: (id: string, target: 'street' | 'all', look: FenceLook) => void;
    setGate: (id: string, patch: { wicketSide?: -1 | 1; canopy?: boolean; gate?: boolean; wicket?: boolean }) => void;
  };
  /** Мелочь дворов: что это и поворот (регистрирует сцена). */
  propTools?: { info: (key: string) => { kind: string; angle: number } | undefined; rotate: (key: string, delta: number) => void };
  /** Опубликовать правки и деревья по карте в файлы данных (только у редактора; регистрирует сцена). */
  publisher?: () => Promise<string[]>;
  /** Дорога: как рисовать и ширина (нет — по типу дороги). */
  roadDraw: RoadDraw;
  roadWidth?: number;
  /** Короткое сообщение внизу экрана (почему нельзя поставить дом и т. п.). */
  notice?: { text: string; at: number };
  /** Дом для правки по id: уже изменённый или дом OSM в виде правки (регистрирует сцена). */
  resolveBuilding?: (id: string) => EditedBuilding | undefined;
  /** Поставить модель на место дома (фасадом к улице) или снять её (регистрирует сцена — знает улицы). */
  applyModel?: (building: EditedBuilding, model: HouseModelRef | undefined) => EditedBuilding;

  /** Загрузить правки населённого пункта: опубликованные и (у редактора) черновик поверх них. */
  load: (territoryId: string, published: Edits) => void;
  /** Опубликовано: черновика больше нет. */
  markPublished: () => void;
  setTool: (tool: EditTool | undefined) => void;
  select: (selection: Selection | undefined) => void;
  setRoadKind: (kind: EditRoadKind) => void;
  setHouseModel: (model: HouseModelId | undefined) => void;
  setSculpt: (patch: Partial<SculptSettings>) => void;
  setFenceDraw: (mode: 'pencil' | 'points') => void;
  setRoadDraw: (mode: RoadDraw) => void;
  setRoadWidth: (width: number | undefined) => void;
  setFenceTools: (tools: EditState['fenceTools']) => void;
  setPropTools: (tools: EditState['propTools']) => void;
  setPublisher: (publisher: EditState['publisher']) => void;
  /** Новое состояние правок — в историю и в браузер. */
  commit: (next: Edits) => void;
  undo: () => void;
  redo: () => void;
  /** Заменить все правки (импорт из файла, сброс). */
  replace: (next: Edits) => void;
  notify: (text: string) => void;
  setResolver: (resolve: ((id: string) => EditedBuilding | undefined) | undefined) => void;
  setModelApplier: (apply: ((building: EditedBuilding, model: HouseModelRef | undefined) => EditedBuilding) | undefined) => void;
}

export const useEditStore = create<EditState>()((set, get) => ({
  edits: EMPTY_EDITS,
  published: EMPTY_EDITS,
  past: [],
  future: [],
  roadKind: 'lane',
  sculpt: { mode: 'raise', radius: 8, strength: 0.5 },
  fenceDraw: 'points',
  roadDraw: 'points',

  load: (territoryId, published) =>
    set({ territoryId, published, edits: loadDraft(territoryId) ?? published, past: [], future: [], selection: undefined, tool: undefined }),
  markPublished: () => {
    const { edits, territoryId } = get();
    set({ published: edits });
    if (territoryId) saveEdits(territoryId, edits, edits);
  },
  setTool: (tool) => set({ tool, selection: tool === 'select' ? get().selection : undefined }),
  select: (selection) => set({ selection }),
  // Другой тип дороги — его обычной ширины.
  setRoadKind: (roadKind) => set({ roadKind, roadWidth: undefined }),
  setHouseModel: (houseModel) => set({ houseModel }),
  setSculpt: (patch) => set({ sculpt: { ...get().sculpt, ...patch } }),
  setFenceDraw: (fenceDraw) => set({ fenceDraw }),
  setRoadDraw: (roadDraw) => set({ roadDraw }),
  setRoadWidth: (roadWidth) => set({ roadWidth }),
  setFenceTools: (fenceTools) => set({ fenceTools }),
  setPropTools: (propTools) => set({ propTools }),
  setPublisher: (publisher) => set({ publisher }),

  commit: (next) => {
    const { edits, past, territoryId } = get();
    if (next === edits) return;
    if (territoryId) saveEdits(territoryId, next, get().published);
    set({ edits: next, past: [...past, edits].slice(-HISTORY_LIMIT), future: [] });
  },
  undo: () => {
    const { edits, past, future, territoryId } = get();
    const previous = past[past.length - 1];
    if (!previous) return;
    if (territoryId) saveEdits(territoryId, previous, get().published);
    set({ edits: previous, past: past.slice(0, -1), future: [edits, ...future], selection: undefined });
  },
  redo: () => {
    const { edits, past, future, territoryId } = get();
    const next = future[0];
    if (!next) return;
    if (territoryId) saveEdits(territoryId, next, get().published);
    set({ edits: next, past: [...past, edits], future: future.slice(1), selection: undefined });
  },
  replace: (next) => get().commit(next),
  notify: (text) => set({ notice: { text, at: Date.now() } }),
  setResolver: (resolveBuilding) => set({ resolveBuilding }),
  setModelApplier: (applyModel) => set({ applyModel }),
}));
