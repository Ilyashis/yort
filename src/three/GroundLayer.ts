// Что редактору и подложке нужно от земли (в v2 — прослойка над engine/terrain).

import type { UnderlayView } from './groundUnderlay';

export interface GroundLayer {
  /** Дорога OSM под точкой: ключ для «убрать дорогу». */
  roadAt(lon: number, lat: number): { key: string } | undefined;
  setUnderlay(view: UnderlayView | undefined): void;
  /** Высота земли в локальных метрах (x — восток, y — север). */
  heightAt: (x: number, y: number) => number;
}
