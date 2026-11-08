// Цвета земли Base World (без привязки к движку).

import type { GroundKind } from './environment';

export const GROUND_COLORS: Record<GroundKind, string> = {
  green: '#8cb06a',
  pitch: '#77a75d',
  water: '#6f9ec4',
  parking: '#8d9095',
  paving: '#c8c3b8',
  sidewalk: '#bcb8af',
  road: '#6e7177',
  footway: '#d6ccb8',
  marking: '#ecebe4',
};

/** Цвет «пустой» земли (дворы, пустыри): притоптанная трава — в режиме прогулки и вместо карты. */
export const BARE_GROUND_COLOR = '#c1c39c';
/** В деревне между домами — не пустыри, а трава: выгоревшая, светлее леса. */
export const VILLAGE_GROUND_COLOR = '#a4b674';
/** Лесная подстилка и луг из OSM. */
export const WOOD_COLOR = '#6f8f4f';
export const MEADOW_COLOR = '#a9bb76';
