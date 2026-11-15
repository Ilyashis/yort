import { CAN_EDIT } from './mode';
import territoriesJson from './territories.json';

export interface Territory {
  /** Идентификатор — совпадает с папкой данных public/data/territories/<id>. */
  id: string;
  name: string;
  /** Короткое название для списка населённых пунктов. */
  shortName: string;
  /** Город или деревня: от этого зависят высоты зданий без тегов, крыши, цвета, витрины. */
  kind: 'city' | 'village';
  description: string;
  bbox: { south: number; west: number; north: number; east: number };
}

/**
 * Населённые пункты, между которыми можно переключаться. Новый — добавьте в territories.json
 * и выгрузите данные: TERRITORY=<id> npm run data:fetch.
 */
const allTerritories = territoriesJson as Territory[];

/** На сайте пока только деревни (Уфа — у редактора, локально). */
export const territories: readonly Territory[] = CAN_EDIT ? allTerritories : allTerritories.filter((t) => t.kind === 'village');

export const defaultTerritory: Territory = territories[0]!;

export function findTerritory(id: string | null | undefined): Territory | undefined {
  return territories.find((t) => t.id === id);
}

export function territoryDataUrl(t: Territory, fileName: string): string {
  return `${import.meta.env.BASE_URL}data/territories/${t.id}/${fileName}`;
}

export function baseBuildingsUrl(t: Territory): string {
  return territoryDataUrl(t, 'buildings.geojson');
}
