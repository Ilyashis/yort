// Base World — исходная модель города. Только чтение: пользовательские изменения
// живут отдельно (User World) и никогда не переписывают эти данные.

/** Откуда взята высота здания. */
export type HeightSource = 'height' | 'levels' | 'default';

export interface BaseBuildingProperties {
  /** Стабильный идентификатор из OSM: "way/123" или "relation/456". */
  id: string;
  /** Значение тега building (yes, apartments, house, …). */
  building: string;
  name?: string;
  address?: string;
  levels?: number;
  /** Высота верха здания над землёй (вместе с крышей), м. */
  height: number;
  /** Высота низа (для навесов и частей на опорах), м. */
  minHeight: number;
  heightSource: HeightSource;
  /** Форма крыши из OSM (roof:shape); нет — плоская или по правилу для старой застройки. */
  roofShape?: 'gabled' | 'hipped' | 'pyramidal' | 'skillion' | 'dome' | 'onion';
  /** Высота крыши, м (входит в height). */
  roofHeight?: number;
  /** Конёк поперёк длинной стороны (roof:orientation=across). */
  roofOrientation?: 'across';
  roofColour?: string;
  /** Цвет фасада (building:colour) и материал стен (building:material) из OSM. */
  colour?: string;
  material?: string;
  /** Постройка найдена по своей съёмке с дрона (в OSM её нет). */
  source?: 'drone';
}

export type Ring = [number, number][];

export interface BaseBuildingFeature {
  type: 'Feature';
  id: string;
  properties: BaseBuildingProperties;
  geometry:
    | { type: 'Polygon'; coordinates: Ring[] }
    | { type: 'MultiPolygon'; coordinates: Ring[][] };
}

export interface BaseBuildingsMetadata {
  territory: string;
  name: string;
  source: string;
  license: string;
  osmTimestamp?: string;
  fetchedAt: string;
}

export interface BaseBuildingsCollection {
  type: 'FeatureCollection';
  metadata: BaseBuildingsMetadata;
  features: BaseBuildingFeature[];
}

export interface BaseBuildingsStats {
  total: number;
  bySource: Record<HeightSource, number>;
  osmTimestamp?: string;
}
