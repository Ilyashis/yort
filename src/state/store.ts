// Состояние интерфейса. Движок читает его и пишет сюда то, что надо показать (улица, скорость, выбранный дом).

import { create } from 'zustand';
import { TERRITORIES, findTerritory } from '../core/data';

export type Mode = 'overview' | 'walk' | 'drive';
/** Чем раскрашена земля: рисунком движка, снимком своей съёмки с дрона или спутниковым. */
export type Ground = 'drawn' | 'drone' | 'satellite' | 'render';

export interface Selected {
  id: string;
  title: string;
  type: string;
  address?: string;
  levels?: number;
  height: number;
  heightSource: string;
  area: number;
}

interface State {
  place: string;
  mode: Mode;
  /** Местное время, часы 0..24. */
  time: number;
  flow: boolean;
  loading: string | null;
  error: string | null;
  selected: Selected | null;
  street: string;
  speed: number;
  locked: boolean;
  help: boolean;
  topView: boolean;
  carColour: number;
  /** Обустроенный посёлок: участки, заборы, дворовые постройки (деревня). */
  estates: boolean;
  sound: boolean;
  ground: Ground;
  /** Подпись источника спутникового снимка (её обязаны показывать) или сообщение, что он не загрузился. */
  groundCredit: string;
  /** У текущего места есть снимок с дрона. */
  hasPhoto: boolean;
  /** У текущего места есть сгенерированная карта (лежит только локально). */
  hasRender: boolean;
  stats: { buildings: number; trees: number; osm?: string } | null;
  /** Открыто окно «Рельеф»: центр куска земли (мир) и сторона, м. */
  relief: { x: number; z: number; size: number } | null;
  /** Растёт, когда земля поменялась — окно «Рельеф» перечитывает высоты. */
  terrainRev: number;
  set: (patch: Partial<State>) => void;
}

const read = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(`citia2.${key}`);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
};
const write = (key: string, value: unknown) => {
  try {
    localStorage.setItem(`citia2.${key}`, JSON.stringify(value));
  } catch {
    /* хранилище недоступно — не страшно */
  }
};

/** Параметры ссылки: ?place=…&time=13.5&mode=walk&view=x,z,dist,yaw,pitch&help=0 — открыть нужный вид. */
export const urlParams = new URLSearchParams(location.search);
const fromUrl = findTerritory(urlParams.get('place'))?.id;
const urlTime = Number.parseFloat(urlParams.get('time') ?? '');

export const useStore = create<State>((set) => ({
  place: fromUrl ?? findTerritory(read('place', ''))?.id ?? TERRITORIES[0].id,
  mode: 'overview',
  time: Number.isFinite(urlTime) ? ((urlTime % 24) + 24) % 24 : read('time', 17.5),
  flow: Number.isFinite(urlTime) ? false : read('flow', false),
  loading: 'Загружаем данные',
  error: null,
  selected: null,
  street: '',
  speed: 0,
  locked: false,
  help: urlParams.get('help') !== '0' && !read('seenHelp', false),
  topView: false,
  carColour: read('car', 0),
  estates: read('estates', true),
  sound: read('sound', true),
  ground: (['drawn', 'drone', 'satellite', 'render'] as Ground[]).find((g) => g === (urlParams.get('ground') ?? read('ground', 'drone'))) ?? 'drone',
  groundCredit: '',
  hasPhoto: false,
  hasRender: false,
  stats: null,
  relief: null,
  terrainRev: 0,
  set: (patch) => set(patch),
}));

let savedAt = 0;
useStore.subscribe((s, prev) => {
  if (s.place !== prev.place) {
    write('place', s.place);
    const url = new URL(location.href);
    url.searchParams.set('place', s.place);
    history.replaceState(null, '', url);
  }
  if (s.flow !== prev.flow) write('flow', s.flow);
  if (s.carColour !== prev.carColour) write('car', s.carColour);
  if (s.estates !== prev.estates) write('estates', s.estates);
  if (s.sound !== prev.sound) write('sound', s.sound);
  if (s.ground !== prev.ground) write('ground', s.ground);
  if (s.help !== prev.help && !s.help) write('seenHelp', true);
  if (s.time !== prev.time && performance.now() - savedAt > 1000) {
    savedAt = performance.now();
    write('time', s.time);
  }
});
