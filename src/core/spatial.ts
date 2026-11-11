// Пространственные индексы: стены зданий (столкновения), улицы (название, покрытие), контуры домов.

import type { Road } from './data';
import { pointInRing, segDist2, type P2 } from './geo';

const key = (ix: number, iz: number) => (ix + 32768) * 65536 + (iz + 32768);

/** Отрезки в равномерной сетке. */
export class SegmentGrid<T> {
  private readonly cells = new Map<number, number[]>();
  private readonly seg: number[] = [];
  private readonly refs: T[] = [];

  constructor(private readonly cell: number) {}

  add(ax: number, az: number, bx: number, bz: number, ref: T): void {
    const id = this.refs.length;
    this.refs.push(ref);
    this.seg.push(ax, az, bx, bz);
    const c = this.cell;
    const x0 = Math.floor(Math.min(ax, bx) / c), x1 = Math.floor(Math.max(ax, bx) / c);
    const z0 = Math.floor(Math.min(az, bz) / c), z1 = Math.floor(Math.max(az, bz) / c);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const k = key(ix, iz);
        const list = this.cells.get(k);
        if (list) list.push(id);
        else this.cells.set(k, [id]);
      }
    }
  }

  /** Вызывает fn для отрезков не дальше r от точки: расстояние, параметр, координаты, ссылка. */
  near(
    x: number,
    z: number,
    r: number,
    fn: (dist: number, t: number, ax: number, az: number, bx: number, bz: number, ref: T) => void,
  ): void {
    const c = this.cell;
    const seen = new Set<number>();
    for (let ix = Math.floor((x - r) / c); ix <= Math.floor((x + r) / c); ix++) {
      for (let iz = Math.floor((z - r) / c); iz <= Math.floor((z + r) / c); iz++) {
        const list = this.cells.get(key(ix, iz));
        if (!list) continue;
        for (const id of list) {
          if (seen.has(id)) continue;
          seen.add(id);
          const s = this.seg;
          const o = id * 4;
          const [d2, t] = segDist2(x, z, s[o], s[o + 1], s[o + 2], s[o + 3]);
          if (d2 <= r * r) fn(Math.sqrt(d2), t, s[o], s[o + 1], s[o + 2], s[o + 3], this.refs[id]);
        }
      }
    }
  }
}

export interface RoadHit {
  road: Road;
  dist: number;
  x: number;
  z: number;
  /** Направление улицы в этой точке (единичный вектор). */
  dx: number;
  dz: number;
}

export class RoadIndex {
  private readonly grid = new SegmentGrid<Road>(40);

  constructor(roads: readonly Road[]) {
    for (const road of roads) {
      for (let i = 1; i < road.pts.length; i++) {
        const a = road.pts[i - 1];
        const b = road.pts[i];
        this.grid.add(a[0], a[1], b[0], b[1], road);
      }
    }
  }

  nearest(x: number, z: number, radius: number, filter?: (road: Road) => boolean): RoadHit | undefined {
    let best: RoadHit | undefined;
    this.grid.near(x, z, radius, (dist, t, ax, az, bx, bz, road) => {
      if ((best && dist >= best.dist) || (filter && !filter(road))) return;
      const len = Math.hypot(bx - ax, bz - az) || 1;
      best = { road, dist, x: ax + (bx - ax) * t, z: az + (bz - az) * t, dx: (bx - ax) / len, dz: (bz - az) / len };
    });
    return best;
  }

  /** Точка на проезжей части (с запасом margin)? */
  onRoad(x: number, z: number, margin = 0): boolean {
    let hit = false;
    this.grid.near(x, z, 12 + margin, (dist, _t, _ax, _az, _bx, _bz, road) => {
      if (dist <= road.width / 2 + margin) hit = true;
    });
    return hit;
  }
}

/** Контуры (внешние кольца) в сетке — проверка «точка внутри здания». */
export class RingIndex {
  private readonly cells = new Map<number, number[]>();
  private readonly rings: P2[][] = [];
  private readonly cell = 32;

  add(ring: P2[]): number {
    const id = this.rings.length;
    this.rings.push(ring);
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of ring) {
      x0 = Math.min(x0, p[0]);
      x1 = Math.max(x1, p[0]);
      z0 = Math.min(z0, p[1]);
      z1 = Math.max(z1, p[1]);
    }
    const c = this.cell;
    for (let ix = Math.floor(x0 / c); ix <= Math.floor(x1 / c); ix++) {
      for (let iz = Math.floor(z0 / c); iz <= Math.floor(z1 / c); iz++) {
        const k = key(ix, iz);
        const list = this.cells.get(k);
        if (list) list.push(id);
        else this.cells.set(k, [id]);
      }
    }
    return id;
  }

  /** Номер контура, в котором лежит точка, или −1. */
  find(x: number, z: number): number {
    const list = this.cells.get(key(Math.floor(x / this.cell), Math.floor(z / this.cell)));
    if (list) for (const id of list) if (pointInRing(x, z, this.rings[id])) return id;
    return -1;
  }
}
