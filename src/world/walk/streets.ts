import { polygonsOfGround, type GroundFeature, type GroundKind } from '../base/environment';
import { distanceToPolygon, insidePolygon, toLocalPolygon, type LocalFrame, type LocalPolygon, type Vec2 } from './localFrame';

interface NamedArea {
  name: string;
  kind: GroundKind;
  polygon: LocalPolygon;
}

/** Улицы предпочтительнее дорожек, если точка попала в несколько полигонов. */
const PRIORITY: Partial<Record<GroundKind, number>> = { road: 0, paving: 1, footway: 2 };

/** Название улицы под ногами пешехода — по полигонам дорог из OSM. */
export class StreetIndex {
  private readonly areas: NamedArea[];

  constructor(ground: readonly GroundFeature[], frame: LocalFrame) {
    this.areas = ground
      .filter((f) => f.properties.name && PRIORITY[f.properties.kind] !== undefined)
      .flatMap((f) =>
        polygonsOfGround(f).map((rings) => ({
          name: f.properties.name!,
          kind: f.properties.kind,
          polygon: toLocalPolygon(rings, frame),
        })),
      );
  }

  /** Улица, на которой стоит точка, или ближайшая в пределах maxDistance метров. */
  nameAt(point: Vec2, maxDistance = 20): string | undefined {
    const [x, y] = point;
    let best: { name: string; distance: number; priority: number } | undefined;
    for (const { name, kind, polygon: p } of this.areas) {
      if (x < p.minX - maxDistance || x > p.maxX + maxDistance || y < p.minY - maxDistance || y > p.maxY + maxDistance) {
        continue;
      }
      const distance = insidePolygon(point, p) ? 0 : distanceToPolygon(point, p);
      if (distance > maxDistance) continue;
      const priority = PRIORITY[kind] ?? 9;
      if (!best || distance < best.distance || (distance === best.distance && priority < best.priority)) {
        best = { name, distance, priority };
      }
    }
    return best?.name;
  }
}
