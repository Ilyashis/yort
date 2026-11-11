// Совместимость с первой версией: редактор и подложка из v1 читают отсюда режим и готовность сцены.
// Настоящее состояние — в state/store.ts.

import { useStore } from '../state/store';

type View = 'top' | 'tilt';
interface Compat {
  /** explore — обзор сверху (в нём работает редактор). */
  mode: 'explore' | 'walk' | 'drive';
  status: 'ready' | 'loading';
  territoryId: string;
  /** Здания из конструктора v1 — в v2 его нет. */
  userBuildings: { building: { footprint: [number, number][] } }[];
  changeView: (view: View) => void;
}

const NONE: Compat['userBuildings'] = [];
const changeView = (view: View) => useStore.getState().set({ topView: view === 'top' });
const adapt = (s: ReturnType<typeof useStore.getState>): Compat => ({
  mode: s.mode === 'overview' ? 'explore' : s.mode,
  status: s.loading || s.error ? 'loading' : 'ready',
  territoryId: s.place,
  userBuildings: NONE,
  changeView,
});

export const useAppStore = Object.assign(<T,>(selector: (s: Compat) => T): T => useStore((s) => selector(adapt(s))), {
  getState: () => adapt(useStore.getState()),
});
