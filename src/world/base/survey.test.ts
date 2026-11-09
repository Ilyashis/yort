import { describe, expect, it } from 'vitest';
import { applySurvey, type SurveyFile } from './survey';
import type { BaseBuildingFeature, BaseBuildingsCollection } from './types';
import { findHouseModel } from '../village/houseModels';
import { toneOf } from '../village/houseParts';

const square = (x: number, y: number, d: number): [number, number][] => [
  [x, y],
  [x + d, y],
  [x + d, y + d],
  [x, y + d],
  [x, y],
];

const house = (id: string, x: number, extra: Partial<BaseBuildingFeature['properties']> = {}): BaseBuildingFeature => ({
  type: 'Feature',
  id,
  properties: { id, building: 'house', height: 6, minHeight: 0, heightSource: 'default', ...extra },
  geometry: { type: 'Polygon', coordinates: [square(x, 52, 0.0001)] },
});

const osm: BaseBuildingsCollection = {
  type: 'FeatureCollection',
  metadata: { territory: 't', name: 't', source: 'OSM', license: 'ODbL', fetchedAt: '' },
  features: [house('way/1', 57), house('way/2', 57.001, { roofColour: '#112233' })],
};

const survey: SurveyFile = {
  metadata: { source: 'дрон', credit: '' },
  houses: { 'way/1': { roof: '#2f5f8f', wall: '#c9b48a' }, 'way/2': { roof: '#aa0000' }, 'way/404': { roof: '#00ff00' } },
  buildings: [
    { id: 'survey/1', kind: 'shed', footprint: square(57.002, 52, 0.00005).slice(0, 4), height: 3, roof: '#5a3a2e' },
    // Налезает на дом OSM — уже дорисован, второй раз не нужен.
    { id: 'survey/2', kind: 'house', footprint: square(57.00001, 52.00001, 0.00008).slice(0, 4), height: 6 },
  ],
};

describe('находки по съёмке с дрона', () => {
  it('цвета — домам без своих цветов в OSM (OSM главнее), неизвестные id — мимо', () => {
    const { collection, stats } = applySurvey(osm, survey);
    const byId = new Map(collection.features.map((f) => [f.id, f.properties]));
    expect(byId.get('way/1')?.roofColour).toBe('#2f5f8f');
    expect(byId.get('way/1')?.colour).toBe('#c9b48a');
    expect(byId.get('way/2')?.roofColour).toBe('#112233');
    expect(stats.colored).toBe(1);
  });

  it('новые постройки — отдельными домами, кроме налезающих на дома OSM', () => {
    const { collection, stats } = applySurvey(osm, survey);
    expect(stats.added).toBe(1);
    const shed = collection.features.find((f) => f.id === 'survey/1')!;
    expect(shed.properties.building).toBe('shed');
    expect(shed.properties.source).toBe('drone');
    expect(shed.properties.roofColour).toBe('#5a3a2e');
    // Кольцо замкнуто.
    const ring = shed.geometry.type === 'Polygon' ? shed.geometry.coordinates[0]! : [];
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    // Исходные данные не тронуты.
    expect(osm.features).toHaveLength(2);
    expect(osm.features[0]!.properties.roofColour).toBeUndefined();
  });
});

describe('метки кровли и стен у моделей', () => {
  it('оттенок цвета: тот же цвет темнее или светлее — да, другой цвет — нет', () => {
    expect(toneOf('#2f5f8f', '#2f5f8f')).toBe(1);
    expect(toneOf('#284f79', '#2f5f8f')).toBeCloseTo(0.85, 1);
    expect(toneOf('#8f2f2f', '#2f5f8f')).toBeUndefined();
    expect(toneOf('#ffffff', '#2f5f8f')).toBeUndefined();
  });

  it('у жилых моделей помечены кровля и стены', () => {
    for (const id of ['izba', 'pyatistenok', 'veranda', 'hipped', 'brick', 'banya'] as const) {
      const plan = findHouseModel(id)!.plan({ seed: 3 });
      const roof = plan.parts.filter((p) => 'paint' in p && p.paint?.role === 'roof').length;
      const wall = plan.parts.filter((p) => 'paint' in p && p.paint?.role === 'wall').length;
      expect(roof, id).toBeGreaterThan(0);
      expect(wall, id).toBeGreaterThan(3);
    }
  });
});
