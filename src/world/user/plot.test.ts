import { describe, expect, it } from 'vitest';
import type { BaseBuildingFeature } from '../base/types';
import { analyzePlot, plotArea, plotPerimeter, type Bbox, type LonLat } from './plot';

// Около центра Уфы.
const ORIGIN: LonLat = [55.946, 54.7225];
const TERRITORY: Bbox = { south: 54.7165, west: 55.9345, north: 54.7285, east: 55.9575 };

const M_PER_DEG_LAT = 111_320;
const mPerDegLon = (lat: number) => M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);

/** Точка, смещённая от origin на dx метров к востоку и dy к северу. */
function offset([lon, lat]: LonLat, dx: number, dy: number): LonLat {
  return [lon + dx / mPerDegLon(lat), lat + dy / M_PER_DEG_LAT];
}

/** Прямоугольник w × h метров с юго-западным углом в origin. */
function rect(origin: LonLat, w: number, h: number): LonLat[] {
  return [offset(origin, 0, 0), offset(origin, w, 0), offset(origin, w, h), offset(origin, 0, h)];
}

function building(id: string, ring: LonLat[]): BaseBuildingFeature {
  return {
    type: 'Feature',
    id,
    properties: { id, building: 'yes', height: 9, minHeight: 0, heightSource: 'default' },
    geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]!]] },
  };
}

describe('plotArea / plotPerimeter', () => {
  it('считает площадь и периметр прямоугольника 20 × 30 м', () => {
    const points = rect(ORIGIN, 20, 30);
    expect(plotArea(points)).toBeCloseTo(600, -1);
    expect(plotPerimeter(points)).toBeCloseTo(100, 0);
  });

  it('возвращает 0 для контура меньше трёх точек', () => {
    expect(plotArea([ORIGIN, offset(ORIGIN, 10, 0)])).toBe(0);
  });
});

describe('analyzePlot', () => {
  const codes = (points: LonLat[], buildings: BaseBuildingFeature[] = []) =>
    analyzePlot(points, buildings, TERRITORY).issues.map((i) => i.code);

  it('признаёт свободный участок допустимым', () => {
    const result = analyzePlot(rect(ORIGIN, 25, 40), [], TERRITORY);
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.areaM2).toBeGreaterThan(990);
    expect(result.areaM2).toBeLessThan(1010);
  });

  it('требует минимум три точки', () => {
    expect(codes([ORIGIN, offset(ORIGIN, 10, 0)])).toEqual(['too-few-points']);
  });

  it('находит самопересечение («бантик»)', () => {
    const bowtie = [offset(ORIGIN, 0, 0), offset(ORIGIN, 30, 30), offset(ORIGIN, 30, 0), offset(ORIGIN, 0, 30)];
    expect(codes(bowtie)).toContain('self-intersection');
  });

  it('отклоняет слишком маленький и слишком большой участок', () => {
    expect(codes(rect(ORIGIN, 5, 5))).toEqual(['too-small']);
    expect(codes(rect(ORIGIN, 200, 200))).toEqual(['too-large']);
  });

  it('отклоняет участок за границей района', () => {
    const outside = rect(offset([TERRITORY.east, 54.72], -10, 0), 30, 30);
    expect(codes(outside)).toEqual(['outside-territory']);
  });

  it('находит пересечения только с задетыми зданиями', () => {
    const plot = rect(ORIGIN, 30, 30);
    const overlapping = building('way/1', rect(offset(ORIGIN, 20, 20), 20, 20));
    const inside = building('way/2', rect(offset(ORIGIN, 5, 5), 5, 5));
    const farAway = building('way/3', rect(offset(ORIGIN, 100, 100), 20, 20));

    const result = analyzePlot(plot, [overlapping, inside, farAway], TERRITORY);
    expect(result.valid).toBe(false);
    expect(result.conflictingBuildingIds.sort()).toEqual(['way/1', 'way/2']);
    expect(result.issues.map((i) => i.code)).toEqual(['overlaps-buildings']);
  });
});
