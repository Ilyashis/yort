// Пьедестал памятника и место вокруг него — без привязки к движку.

import type { Landmark } from '../../config/landmarks';
import type { LonLat } from '../user/plot';
import { createLocalFrame } from '../walk/localFrame';
import type { BaseBuildingFeature, Ring } from './types';

export const PEDESTAL_COLORS = { graniteLight: '#a29b92', granite: '#857c74', graniteDark: '#6f6862', bronze: '#4d4335' };

/** Площадка в две ступени; «юбка» вниз, м: на склоне (памятник — на краю обрыва) под ней не будет щели. */
export const STEPS = [
  { radius: 7.2, height: 0.25 },
  { radius: 6.4, height: 0.25 },
];
export const PLATFORM_HEIGHT = STEPS.reduce((sum, step) => sum + step.height, 0);
export const PLATFORM_SKIRT = 3;
/** Пьедестал: цоколь, ствол и карниз — как у классических постаментов, общая высота ~4,1 м. */
export const PLINTH = { width: 4.8, length: 7.1, height: 0.45 };
export const SHAFT = { width: 4.2, length: 6.5, height: 3.0 };
export const CORNICE = { width: 4.6, length: 6.9, height: 0.35 };
export const PEDESTAL_TOP = PLATFORM_HEIGHT + PLINTH.height + SHAFT.height + CORNICE.height;
/** Бронзовая доска с надписью на лицевой стороне ствола. */
export const PLAQUE = { width: 2.6, height: 0.9, depth: 0.06 };

/** Высота статуи над пьедесталом, м (модель собрана в этой высоте, см. scripts/sculpt-statue.mjs). */
export const STATUE_HEIGHT = 9.8;
/** Высота верха фигуры над землёй, м. */
export const STATUE_TOP = PEDESTAL_TOP + STATUE_HEIGHT;

/** Открытая площадка вокруг памятника — туда не досаживаем деревья. */
export function landmarkClearance(landmark: Landmark, radius = 20): Ring[] {
  const frame = createLocalFrame(landmark.position);
  const ring: LonLat[] = Array.from({ length: 24 }, (_, i) => {
    const a = (i / 24) * Math.PI * 2;
    return frame.toLonLat([radius * Math.cos(a), radius * Math.sin(a)]);
  });
  return [[...ring, ring[0]!]];
}

/** Пьедестал как препятствие для пешехода (в формате здания Base World). */
export function landmarkObstacle(landmark: Landmark): BaseBuildingFeature {
  const frame = createLocalFrame(landmark.position);
  const h = (landmark.heading * Math.PI) / 180;
  const halfW = PLINTH.width / 2;
  const halfL = PLINTH.length / 2;
  // Поворот локальных осей фигуры (x — вправо, y — вперёд) на курс памятника.
  const toWorld = ([x, y]: [number, number]): LonLat =>
    frame.toLonLat([x * Math.cos(h) + y * Math.sin(h), -x * Math.sin(h) + y * Math.cos(h)]);
  const corners: [number, number][] = [[-halfW, -halfL], [halfW, -halfL], [halfW, halfL], [-halfW, halfL]];
  const ring = corners.map(toWorld);
  return {
    type: 'Feature',
    id: `landmark/${landmark.id}`,
    properties: {
      id: `landmark/${landmark.id}`,
      building: 'monument',
      name: landmark.name,
      height: PEDESTAL_TOP,
      minHeight: 0,
      heightSource: 'height',
    },
    geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]!]] },
  };
}
