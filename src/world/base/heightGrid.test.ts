import { describe, expect, it } from 'vitest';
import { HeightGrid, decodeTerrainFile, type TerrainFile } from './heightGrid';

// Сетка 3 × 3: высота растёт на восток (0, 10, 20) и на юг (+100 на строку).
const grid = new HeightGrid({
  bbox: { west: 55.9, south: 54.7, east: 56.0, north: 54.8 },
  width: 3,
  height: 3,
  values: new Float32Array([0, 10, 20, 100, 110, 120, 200, 210, 220]),
});

describe('HeightGrid', () => {
  it('в узлах возвращает значения сетки', () => {
    expect(grid.heightAt(55.9, 54.8)).toBeCloseTo(0, 5);
    expect(grid.heightAt(56.0, 54.7)).toBeCloseTo(220, 5);
    expect(grid.heightAt(55.95, 54.75)).toBeCloseTo(110, 5);
  });

  it('между узлами интерполирует билинейно', () => {
    expect(grid.heightAt(55.925, 54.8)).toBeCloseTo(5, 5);
    expect(grid.heightAt(55.925, 54.775)).toBeCloseTo(55, 5);
  });

  it('за краем плавно уходит к средней высоте', () => {
    const edge = grid.heightAt(56.0, 54.75); // 120
    const near = grid.heightAt(56.001, 54.75); // ~64 м за краем
    const far = grid.heightAt(56.5, 54.75); // десятки км за краем
    expect(edge).toBeCloseTo(120, 5);
    expect(Math.abs(near - edge)).toBeLessThan(2);
    expect(far).toBeCloseTo(grid.mean, 5);
    expect(grid.mean).toBeCloseTo(110, 5);
  });
});

describe('decodeTerrainFile', () => {
  it('раскодирует дециметры из base64', () => {
    const raw = new Int16Array([1000, 1005, 990, 1010]); // 100,0 / 100,5 / 99,0 / 101,0 м
    const bytes = new Uint8Array(raw.buffer);
    const file: TerrainFile = {
      metadata: { source: 'test', license: 'test', credit: 'test' },
      bbox: { west: 0, south: 0, east: 1, north: 1 },
      width: 2,
      height: 2,
      scale: 0.1,
      offset: 0,
      heights: btoa(String.fromCharCode(...bytes)),
    };
    const decoded = decodeTerrainFile(file);
    expect(decoded.heightAt(0, 1)).toBeCloseTo(100, 5);
    expect(decoded.heightAt(1, 1)).toBeCloseTo(100.5, 5);
    expect(decoded.min).toBeCloseTo(99, 5);
    expect(decoded.max).toBeCloseTo(101, 5);
  });
});
