import territoryJson from './territory.json';

export interface Territory {
  /** Идентификатор — совпадает с папкой данных public/data/territories/<id>. */
  id: string;
  name: string;
  description: string;
  bbox: { south: number; west: number; north: number; east: number };
}

/** Текущая территория MVP. Чтобы сменить район — правьте territory.json и запускайте npm run data:fetch. */
export const territory: Territory = territoryJson;

export function territoryDataUrl(t: Territory, fileName: string): string {
  return `${import.meta.env.BASE_URL}data/territories/${t.id}/${fileName}`;
}

export function baseBuildingsUrl(t: Territory): string {
  return territoryDataUrl(t, 'buildings.geojson');
}
