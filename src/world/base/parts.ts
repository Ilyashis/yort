import type { BaseBuildingFeature, Ring } from './types';

/** Часть здания (building:part) из OSM — те же поля, что у здания. */
export type BuildingPartFeature = BaseBuildingFeature;

export interface PartsAssignment {
  /** id здания → его части. */
  byBuilding: Map<string, BuildingPartFeature[]>;
  /** Части, не попавшие ни в один контур, — рисуем как отдельные здания. */
  orphans: BuildingPartFeature[];
}

const outerRings = (f: BaseBuildingFeature): Ring[] =>
  (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates)
    .map((rings) => rings[0])
    .filter((r): r is Ring => !!r);

function centroidOf(f: BaseBuildingFeature): [number, number] {
  const points = outerRings(f).flatMap((r) => r.slice(0, -1));
  const n = points.length || 1;
  return points.reduce<[number, number]>((acc, [x, y]) => [acc[0] + x / n, acc[1] + y / n], [0, 0]);
}

function pointInRing([x, y]: [number, number], ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Привязывает части к зданиям по центру части внутри контура здания.
 * По правилам Simple 3D Buildings у здания с частями рисуются только части, а контур — нет.
 */
export function assignParts(
  buildings: readonly BaseBuildingFeature[],
  parts: readonly BuildingPartFeature[],
): PartsAssignment {
  const boxes = buildings.map((b) => {
    const rings = outerRings(b);
    const xs = rings.flatMap((r) => r.map(([x]) => x));
    const ys = rings.flatMap((r) => r.map(([, y]) => y));
    return { building: b, rings, minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  });
  const byBuilding = new Map<string, BuildingPartFeature[]>();
  const orphans: BuildingPartFeature[] = [];
  for (const part of parts) {
    const c = centroidOf(part);
    const host = boxes.find(
      (b) =>
        c[0] >= b.minX && c[0] <= b.maxX && c[1] >= b.minY && c[1] <= b.maxY && b.rings.some((r) => pointInRing(c, r)),
    );
    if (!host) {
      orphans.push(part);
      continue;
    }
    const list = byBuilding.get(host.building.properties.id) ?? [];
    list.push(part);
    byBuilding.set(host.building.properties.id, list);
  }
  return { byBuilding, orphans };
}
