// То, что окну «Рельеф» нужно знать о земле текущего места. Заполняет движок после загрузки.

import type { World } from '../core/data';
import type { HeightMap } from './terrain';

export interface TerrainProbe {
  world: World;
  hm: HeightMap;
  /** Куда сейчас смотрит камера обзора (мир). */
  focus: () => { x: number; z: number };
}

export const probe: { current?: TerrainProbe } = {};
