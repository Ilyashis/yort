import { bbox, booleanPointInPolygon, buffer, polygon } from '@turf/turf';
import type { LonLat } from '../user/plot';

/**
 * Какие точки (деревья, скамейки, фонари) попадают на пятно застройки с запасом margin метров —
 * их прячем, когда на этом месте появляется здание пользователя.
 */
export function pointsInsideAreas(
  points: readonly LonLat[],
  areas: readonly (readonly LonLat[])[],
  margin: number,
): boolean[] {
  const shapes = areas
    .filter((ring) => ring.length >= 3)
    .map((ring) => {
      const base = polygon([[...ring, ring[0]!]]);
      const grown = margin > 0 ? (buffer(base, margin, { units: 'meters', steps: 2 }) ?? base) : base;
      return { shape: grown, box: bbox(grown) };
    });
  return points.map(
    (point) =>
      shapes.some(
        ({ shape, box: [x0, y0, x1, y1] }) =>
          point[0] >= x0 && point[0] <= x1 && point[1] >= y0 && point[1] <= y1 && booleanPointInPolygon(point, shape),
      ),
  );
}
