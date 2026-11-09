import { MeshBasicMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import { createLocalFrame } from '../world/walk/localFrame';
import { createTerrain } from './terrain';

const frame = createLocalFrame([57.96, 52.63]);
// Холмистый рельеф: на рёбрах грубой сетки высота заметно не линейна — щель была бы видна.
const heights = {
  heightAt: (lon: number, lat: number) => {
    const [x, y] = frame.toLocal([lon, lat]);
    return 300 + 8 * Math.sin(x / 9) + 6 * Math.cos(y / 7);
  },
};
const rect = { x0: -300, y0: -200, x1: 300, y1: 200 };

describe('рельеф с густой сеткой над подробным участком', () => {
  const t = createTerrain(heights, frame, rect, new MeshBasicMaterial(), '#888', { rect: { x0: -100, y0: -50, x1: 120, y1: 80 }, subdivide: 3 });

  it('густая сетка есть и в 3 раза чаще', () => {
    const p = t.detail!.geometry.getAttribute('position');
    const xs = new Set<number>();
    for (let i = 0; i < p.count; i++) xs.add(Math.round(p.getX(i) * 1000));
    const sorted = [...xs].sort((a, b) => a - b);
    expect((sorted[1]! - sorted[0]!) / 1000).toBeLessThan(2.1);
    expect((sorted[1]! - sorted[0]!) / 1000).toBeGreaterThan(1.9);
  });

  it('на краю выреза узлы густой сетки лежат на рёбрах основной — щелей нет', () => {
    const inner = t.inner.geometry.getAttribute('position');
    const coarse = new Map<string, number>();
    for (let i = 0; i < inner.count; i++) coarse.set(`${inner.getX(i).toFixed(3)},${inner.getZ(i).toFixed(3)}`, inner.getY(i));
    const xsCoarse = [...new Set([...Array(inner.count).keys()].map((i) => +inner.getX(i).toFixed(3)))].sort((a, b) => a - b);
    const zsCoarse = [...new Set([...Array(inner.count).keys()].map((i) => +inner.getZ(i).toFixed(3)))].sort((a, b) => a - b);
    const detail = t.detail!.geometry.getAttribute('position');
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < detail.count; i++) {
      minX = Math.min(minX, detail.getX(i));
      maxX = Math.max(maxX, detail.getX(i));
      minZ = Math.min(minZ, detail.getZ(i));
      maxZ = Math.max(maxZ, detail.getZ(i));
    }
    const near = (a: number, b: number) => Math.abs(a - b) < 1e-3;
    let checked = 0;
    for (let i = 0; i < detail.count; i++) {
      const x = detail.getX(i);
      const z = detail.getZ(i);
      const onX = near(x, minX) || near(x, maxX);
      const onZ = near(z, minZ) || near(z, maxZ);
      if (!onX && !onZ) continue;
      // Высота на ребре основной сетки — линейно между соседними узлами вдоль края.
      let expected: number;
      if (onX) {
        const k = zsCoarse.findIndex((v) => v >= z - 1e-3);
        const z1 = zsCoarse[k]!;
        const z0 = near(z1, z) ? z1 : zsCoarse[k - 1]!;
        const t0 = near(z0, z1) ? 0 : (z - z0) / (z1 - z0);
        const xk = xsCoarse.find((v) => near(v, x))!;
        expected = coarse.get(`${xk.toFixed(3)},${z0.toFixed(3)}`)! * (1 - t0) + coarse.get(`${xk.toFixed(3)},${z1.toFixed(3)}`)! * t0;
      } else {
        const k = xsCoarse.findIndex((v) => v >= x - 1e-3);
        const x1 = xsCoarse[k]!;
        const x0 = near(x1, x) ? x1 : xsCoarse[k - 1]!;
        const t0 = near(x0, x1) ? 0 : (x - x0) / (x1 - x0);
        const zk = zsCoarse.find((v) => near(v, z))!;
        expected = coarse.get(`${x0.toFixed(3)},${zk.toFixed(3)}`)! * (1 - t0) + coarse.get(`${x1.toFixed(3)},${zk.toFixed(3)}`)! * t0;
      }
      expect(Math.abs(detail.getY(i) - expected)).toBeLessThan(1e-3);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('в основной сетке под густой — вырез, остальное на месте', () => {
    const plain = createTerrain(heights, frame, rect, new MeshBasicMaterial(), '#888');
    const full = plain.inner.geometry.getIndex()!.count;
    const cut = t.inner.geometry.getIndex()!.count;
    const detailTriangles = t.detail!.geometry.getIndex()!.count;
    expect(cut).toBeLessThan(full);
    // Густая сетка закрывает ровно вырез: треугольников в 9 раз больше на ту же площадь.
    expect(detailTriangles).toBe((full - cut) * 9);
    expect(plain.detail).toBeUndefined();
  });
});
