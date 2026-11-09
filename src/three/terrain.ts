// Рельеф района одной сеткой из нашего DEM (Copernicus): вблизи — шаг 6 м, вокруг до горизонта —
// грубое кольцо с шагом 48 м и цветом травы. Высоты — та же билинейная выборка, что у прогулки.
// Где есть подробный рельеф (своя съёмка с дрона), сетка там гуще — вырез в основной сетке, ровно по её
// клеткам; на краю выреза узлы густой сетки лежат на рёбрах основной — щелей нет.

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
  /** Густая сетка над подробным рельефом (если он есть). */
  detail?: Mesh;
  rect: LocalRect;
  /** Пересчитать высоты и нормали сетки в прямоугольнике (после правки рельефа кистью). */
  refresh: (area: LocalRect) => void;
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

/** Где рельеф подробный (локальные метры) и во сколько раз гуще там сетка (шаг 6 м / subdivide). */
export interface DetailRegion {
  rect: LocalRect;
  subdivide: number;
}

export function createTerrain(
  grid: HeightSource,
  frame: LocalFrame,
  rect: LocalRect,
  groundMaterial: Material,
  outerColor: string,
  detailRegion?: DetailRegion,
): Terrain {
  const heightAt = (x: number, y: number) => grid.heightAt(...frame.toLonLat([x, y]));
  const nx = Math.max(2, Math.ceil((rect.x1 - rect.x0) / INNER_STEP) + 1);
  const ny = Math.max(2, Math.ceil((rect.y1 - rect.y0) / INNER_STEP) + 1);
  const xAt = (i: number) => rect.x0 + ((rect.x1 - rect.x0) * i) / (nx - 1);
  const yAt = (j: number) => rect.y0 + ((rect.y1 - rect.y0) * j) / (ny - 1);

  // Вырез под густую сетку — по клеткам основной, чтобы узлы совпадали.
  const cells = detailRegion && cellRange(detailRegion.rect, rect, nx, ny);
  const inner = new Mesh(
    gridGeometry(nx, ny, xAt, yAt, heightAt, cells ? (i, j) => i >= cells.i0 && i < cells.i1 && j >= cells.j0 && j < cells.j1 : undefined),
    groundMaterial,
  );
  inner.receiveShadow = true;
  inner.name = 'terrain';

  const refreshers = [gridRefresher(inner, nx, ny, xAt, yAt, (i, j) => heightAt(xAt(i), yAt(j)))];
  let detail: Mesh | undefined;
  if (cells && detailRegion) {
    const k = Math.max(1, Math.round(detailRegion.subdivide));
    const dx = (i: number) => xAt(cells.i0 + i / k);
    const dy = (j: number) => yAt(cells.j0 + j / k);
    const dnx = (cells.i1 - cells.i0) * k + 1;
    const dny = (cells.j1 - cells.j0) * k + 1;
    // На краю выреза — высота на ребре основной сетки (линейно между её узлами): без щелей.
    const edgeHeight = (i: number, j: number): number => {
      const onX = i === 0 || i === dnx - 1;
      const onY = j === 0 || j === dny - 1;
      if (!onX && !onY) return heightAt(dx(i), dy(j));
      if (onX && j % k === 0) return heightAt(dx(i), dy(j));
      if (onX) {
        const j0 = Math.floor(j / k) * k;
        const t = (j - j0) / k;
        return heightAt(dx(i), dy(j0)) * (1 - t) + heightAt(dx(i), dy(Math.min(j0 + k, dny - 1))) * t;
      }
      const i0 = Math.floor(i / k) * k;
      const t = (i - i0) / k;
      return heightAt(dx(i0), dy(j)) * (1 - t) + heightAt(dx(Math.min(i0 + k, dnx - 1)), dy(j)) * t;
    };
    detail = new Mesh(gridGeometryIndexed(dnx, dny, dx, dy, edgeHeight), groundMaterial);
    detail.receiveShadow = true;
    detail.name = 'terrain-detail';
    refreshers.push(gridRefresher(detail, dnx, dny, dx, dy, edgeHeight));
  }

  const outerRect = { x0: rect.x0 - OUTER_MARGIN, y0: rect.y0 - OUTER_MARGIN, x1: rect.x1 + OUTER_MARGIN, y1: rect.y1 + OUTER_MARGIN };
  const onx = Math.max(2, Math.ceil((outerRect.x1 - outerRect.x0) / OUTER_STEP) + 1);
  const ony = Math.max(2, Math.ceil((outerRect.y1 - outerRect.y0) / OUTER_STEP) + 1);
  const oxAt = (i: number) => outerRect.x0 + ((outerRect.x1 - outerRect.x0) * i) / (onx - 1);
  const oyAt = (j: number) => outerRect.y0 + ((outerRect.y1 - outerRect.y0) * j) / (ony - 1);
  const margin = OUTER_STEP * 1.5;
  const outerGeometry = gridGeometry(
    onx,
    ony,
    oxAt,
    oyAt,
    (x, y) => heightAt(x, y) - OUTER_DROP,
    (i, j) => {
      // Дыра под основной сеткой (с перекрытием — кольцо ниже, на стыке не мерцает).
      const cx = (oxAt(i) + oxAt(i + 1)) / 2;
      const cy = (oyAt(j) + oyAt(j + 1)) / 2;
      return cx > rect.x0 + margin && cx < rect.x1 - margin && cy > rect.y0 + margin && cy < rect.y1 - margin;
    },
  );
  const outer = new Mesh(outerGeometry, new MeshStandardMaterial({ color: outerColor, roughness: 1 }));
  outer.receiveShadow = true;
  outer.name = 'terrain-outer';
  return { heightAt, inner, outer, detail, rect, refresh: (area) => refreshers.forEach((refresh) => refresh(area)) };
}

/**
 * Пересчёт части сетки nx × ny: высоты узлов в прямоугольнике и нормали в нём и у соседей (центральные
 * разности). В видеокарту уходят только изменённые строки.
 */
function gridRefresher(
  mesh: Mesh,
  nx: number,
  ny: number,
  xAt: (i: number) => number,
  yAt: (j: number) => number,
  heightOf: (i: number, j: number) => number,
): (area: LocalRect) => void {
  const sx = (xAt(nx - 1) - xAt(0)) / (nx - 1);
  const sy = (yAt(ny - 1) - yAt(0)) / (ny - 1);
  return (area) => {
    const i0 = Math.max(0, Math.floor((area.x0 - xAt(0)) / sx));
    const i1 = Math.min(nx - 1, Math.ceil((area.x1 - xAt(0)) / sx));
    const j0 = Math.max(0, Math.floor((area.y0 - yAt(0)) / sy));
    const j1 = Math.min(ny - 1, Math.ceil((area.y1 - yAt(0)) / sy));
    if (i0 > i1 || j0 > j1) return;
    const position = mesh.geometry.getAttribute('position') as BufferAttribute;
    const normal = mesh.geometry.getAttribute('normal') as BufferAttribute;
    const p = position.array as Float32Array;
    const n = normal.array as Float32Array;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) p[(j * nx + i) * 3 + 1] = heightOf(i, j);
    const h = (i: number, j: number) => p[(j * nx + i) * 3 + 1]!;
    const ni0 = Math.max(0, i0 - 1);
    const ni1 = Math.min(nx - 1, i1 + 1);
    const nj0 = Math.max(0, j0 - 1);
    const nj1 = Math.min(ny - 1, j1 + 1);
    for (let j = nj0; j <= nj1; j++) {
      for (let i = ni0; i <= ni1; i++) {
        const il = Math.max(0, i - 1);
        const ir = Math.min(nx - 1, i + 1);
        const jd = Math.max(0, j - 1);
        const ju = Math.min(ny - 1, j + 1);
        const hx = (h(ir, j) - h(il, j)) / (xAt(ir) - xAt(il));
        const hy = (h(i, ju) - h(i, jd)) / (yAt(ju) - yAt(jd));
        // Поверхность (x, h, −y): нормаль (−∂h/∂x, 1, ∂h/∂y).
        const len = Math.hypot(hx, 1, hy);
        const k = (j * nx + i) * 3;
        n[k] = -hx / len;
        n[k + 1] = 1 / len;
        n[k + 2] = hy / len;
      }
      position.addUpdateRange((j * nx + ni0) * 3, (ni1 - ni0 + 1) * 3);
      normal.addUpdateRange((j * nx + ni0) * 3, (ni1 - ni0 + 1) * 3);
    }
    position.needsUpdate = true;
    normal.needsUpdate = true;
  };
}

/** Клетки основной сетки, целиком покрывающие прямоугольник (не выходя за сетку). */
function cellRange(r: LocalRect, rect: LocalRect, nx: number, ny: number): { i0: number; i1: number; j0: number; j1: number } | undefined {
  const sx = (rect.x1 - rect.x0) / (nx - 1);
  const sy = (rect.y1 - rect.y0) / (ny - 1);
  const i0 = Math.max(0, Math.floor((r.x0 - rect.x0) / sx));
  const i1 = Math.min(nx - 1, Math.ceil((r.x1 - rect.x0) / sx));
  const j0 = Math.max(0, Math.floor((r.y0 - rect.y0) / sy));
  const j1 = Math.min(ny - 1, Math.ceil((r.y1 - rect.y0) / sy));
  return i1 > i0 && j1 > j0 ? { i0, i1, j0, j1 } : undefined;
}

/** Сетка-«простыня» nx × ny узлов; skip(i, j) — клетка не нужна (там другая сетка). */
function gridGeometry(
  nx: number,
  ny: number,
  xAt: (i: number) => number,
  yAt: (j: number) => number,
  height: (x: number, y: number) => number,
  skip?: (i: number, j: number) => boolean,
): BufferGeometry {
  return gridGeometryIndexed(nx, ny, xAt, yAt, (i, j) => height(xAt(i), yAt(j)), skip);
}

function gridGeometryIndexed(
  nx: number,
  ny: number,
  xAt: (i: number) => number,
  yAt: (j: number) => number,
  heightOf: (i: number, j: number) => number,
  skip?: (i: number, j: number) => boolean,
): BufferGeometry {
  const positions = new Float32Array(nx * ny * 3);
  for (let j = 0; j < ny; j++) {
    const y = yAt(j);
    for (let i = 0; i < nx; i++) {
      const k = (j * nx + i) * 3;
      positions[k] = xAt(i);
      positions[k + 1] = heightOf(i, j);
      positions[k + 2] = -y;
    }
  }
  const count = (nx - 1) * (ny - 1) * 6;
  const indices = nx * ny > 65535 ? new Uint32Array(count) : new Uint16Array(count);
  let n = 0;
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      if (skip?.(i, j)) continue;
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      // Обход против часовой, если смотреть сверху (в three ось Z — на юг).
      indices[n++] = a;
      indices[n++] = b;
      indices[n++] = d;
      indices[n++] = a;
      indices[n++] = d;
      indices[n++] = c;
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setIndex(new BufferAttribute(indices.subarray(0, n), 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}
