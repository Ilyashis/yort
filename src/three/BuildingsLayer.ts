// Что редактору нужно от слоя зданий (в v2 — прослойка над engine/buildings).

import type { Intersection, Object3D } from 'three';
import type { LonLat } from '../world/edit/edits';

export interface BuildingInfo {
  props: { building: string; levels?: number };
  /** Контур без замыкающей точки. */
  outline: LonLat[];
  wallTop: number;
  roof: string;
  facadeColor: string;
  roofColor?: string;
}

export interface BuildingsLayer {
  buildingInfo(id: string): BuildingInfo | undefined;
  setHidden(ids: ReadonlySet<string>): void;
  readonly pickables: Object3D[];
  buildingFromPick(hit: Intersection | undefined): { id: string } | undefined;
}
