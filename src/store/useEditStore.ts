import { create } from 'zustand';
import { EMPTY_EDITS, isEmpty, parseEdits, type EditRoadKind, type EditedBuilding, type Edits, type HouseModelRef } from '../world/edit/edits';
import type { HouseModelId } from '../world/village/houseModels';
import type { SculptMode } from '../world/base/sculpt';

/** Инструменты редактора (как в градостроителях): выбор, дом растяжкой, дорога и забор линией, кисть рельефа. */
export type EditTool = 'select' | 'house' | 'road' | 'fence' | 'terrain';

/** Настройки кисти рельефа. */
export interface SculptSettings {
  mode: SculptMode;
  /** Радиус, м. */
  radius: number;
  /** Сила, 0.05…1. */
  strength: number;
}

export type Selection =
  | { type: 'building'; id: string }
  | { type: 'road'; id: string }
  | { type: 'fence'; id: string };

const HISTORY_LIMIT = 100;
const storageKey = (territoryId: string) => `citia:edits:${territoryId}`;

function loadEdits(territoryId: string): Edits {
  try {
    const raw = window.localStorage.getItem(storageKey(territoryId));
    return (raw && parseEdits(JSON.parse(raw))) || EMPTY_EDITS;
  } catch {
    return EMPTY_EDITS;
  }
}

function saveEdits(territoryId: string, edits: Edits): void {
  try {
    if (isEmpty(edits)) window.localStorage.removeItem(storageKey(territoryId));
    else window.localStorage.setItem(storageKey(territoryId), JSON.stringify(edits));
  } catch {
    // Хранилище недоступно — правки живут до перезагрузки вкладки.
  }
}

interface EditState {
  territoryId?: string;
  edits: Edits;
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
  /** Короткое сообщение внизу экрана (почему нельзя поставить дом и т. п.). */
  notice?: { text: string; at: number };
  /** Дом для правки по id: уже изменённый или дом OSM в виде правки (регистрирует сцена). */
  resolveBuilding?: (id: string) => EditedBuilding | undefined;
  /** Поставить модель на место дома (фасадом к улице) или снять её (регистрирует сцена — знает улицы). */
  applyModel?: (building: EditedBuilding, model: HouseModelRef | undefined) => EditedBuilding;

  /** Загрузить правки населённого пункта (из браузера). */
  load: (territoryId: string) => void;
  setTool: (tool: EditTool | undefined) => void;
  select: (selection: Selection | undefined) => void;
  setRoadKind: (kind: EditRoadKind) => void;
  setHouseModel: (model: HouseModelId | undefined) => void;
  setSculpt: (patch: Partial<SculptSettings>) => void;
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
  past: [],
  future: [],
  roadKind: 'lane',
  sculpt: { mode: 'raise', radius: 8, strength: 0.5 },

  load: (territoryId) =>
    set({ territoryId, edits: loadEdits(territoryId), past: [], future: [], selection: undefined, tool: undefined }),
  setTool: (tool) => set({ tool, selection: tool === 'select' ? get().selection : undefined }),
  select: (selection) => set({ selection }),
  setRoadKind: (roadKind) => set({ roadKind }),
  setHouseModel: (houseModel) => set({ houseModel }),
  setSculpt: (patch) => set({ sculpt: { ...get().sculpt, ...patch } }),

  commit: (next) => {
    const { edits, past, territoryId } = get();
    if (next === edits) return;
    if (territoryId) saveEdits(territoryId, next);
    set({ edits: next, past: [...past, edits].slice(-HISTORY_LIMIT), future: [] });
  },
  undo: () => {
    const { edits, past, future, territoryId } = get();
    const previous = past[past.length - 1];
    if (!previous) return;
    if (territoryId) saveEdits(territoryId, previous);
    set({ edits: previous, past: past.slice(0, -1), future: [edits, ...future], selection: undefined });
  },
  redo: () => {
    const { edits, past, future, territoryId } = get();
    const next = future[0];
    if (!next) return;
    if (territoryId) saveEdits(territoryId, next);
    set({ edits: next, past: [...past, edits], future: future.slice(1), selection: undefined });
  },
  replace: (next) => get().commit(next),
  notify: (text) => set({ notice: { text, at: Date.now() } }),
  setResolver: (resolveBuilding) => set({ resolveBuilding }),
  setModelApplier: (applyModel) => set({ applyModel }),
}));
