// Рельеф района одной сеткой из нашего DEM (Copernicus): вблизи — шаг 6 м, вокруг до горизонта —
// грубое кольцо с шагом 48 м и цветом травы. Высоты — та же билинейная выборка, что у прогулки.

import { BufferAttribute, BufferGeometry, Mesh, MeshStandardMaterial, type Material } from 'three';
import type { LocalFrame } from '../world/walk/localFrame';

/** Прямоугольник в локальных метрах: x0, y0 — юго-запад, x1, y1 — северо-восток. */
export interface LocalRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Terrain {
  /** Высота земли в локальных метрах. */
  heightAt: (x: number, y: number) => number;
  inner: Mesh;
  outer: Mesh;
  rect: LocalRect;
}

const INNER_STEP = 6;
const OUTER_STEP = 48;
/** Кольцо вокруг района, м: дальше — дымка. */
const OUTER_MARGIN = 9000;
/** Кольцо чуть ниже, чтобы на стыке не мерцало с основной сеткой. */
const OUTER_DROP = 1.5;

/** Источник высот: сетка DEM или плоская земля. */
export interface HeightSource {
  heightAt: (lon: number, lat: number) => number;
}

export function createTerrain(grid: HeightSource, frame: LocalFrame, rect: LocalRect, groundMaterial: Material, outerColor: string): Terrain {
  const heightAt = (x: number, y: number) => grid.heightAt(...frame.toLonLat([x, y]));
  const inner = new Mesh(gridGeometry(rect, INNER_STEP, heightAt), groundMaterial);
  inner.receiveShadow = true;
  inner.name = 'terrain';

  const outerRect = { x0: rect.x0 - OUTER_MARGIN, y0: rect.y0 - OUTER_MARGIN, x1: rect.x1 + OUTER_MARGIN, y1: rect.y1 + OUTER_MARGIN };
  const outerGeometry = gridGeometry(outerRect, OUTER_STEP, (x, y) => heightAt(x, y) - OUTER_DROP, rect);
  const outer = new Mesh(outerGeometry, new MeshStandardMaterial({ color: outerColor, roughness: 1 }));
  outer.receiveShadow = true;
  outer.name = 'terrain-outer';
  return { heightAt, inner, outer, rect };
}

/** Сетка-«простыня» над прямоугольником; hole — где треугольники не нужны (там основная сетка). */
function gridGeometry(rect: LocalRect, step: number, height: (x: number, y: number) => number, hole?: LocalRect): BufferGeometry {
  const nx = Math.max(2, Math.ceil((rect.x1 - rect.x0) / step) + 1);
  const ny = Math.max(2, Math.ceil((rect.y1 - rect.y0) / step) + 1);
  const positions = new Float32Array(nx * ny * 3);
  for (let j = 0; j < ny; j++) {
    const y = rect.y0 + ((rect.y1 - rect.y0) * j) / (ny - 1);
    for (let i = 0; i < nx; i++) {
      const x = rect.x0 + ((rect.x1 - rect.x0) * i) / (nx - 1);
      const k = (j * nx + i) * 3;
      positions[k] = x;
      positions[k + 1] = height(x, y);
      positions[k + 2] = -y;
    }
  }
  const indices: number[] = [];
  const margin = step * 1.5;
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      if (hole) {
        const cx = rect.x0 + ((rect.x1 - rect.x0) * (i + 0.5)) / (nx - 1);
        const cy = rect.y0 + ((rect.y1 - rect.y0) * (j + 0.5)) / (ny - 1);
        if (cx > hole.x0 + margin && cx < hole.x1 - margin && cy > hole.y0 + margin && cy < hole.y1 - margin) continue;
      }
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      // Обход против часовой, если смотреть сверху (в three ось Z — на юг).
      indices.push(a, b, d, a, d, c);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}
