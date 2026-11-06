import { polygonsOfGround, type GroundFeature, type GroundKind } from '../world/base/environment';
import {
  distanceToPolygon,
  insidePolygon,
  toLocalPolygon,
  type LocalFrame,
  type LocalPolygon,
  type Vec2,
} from '../world/walk/localFrame';
import type { AmbienceLevels, Surface } from './ambience';

/** На каком расстоянии (м) слой затихает до нуля. */
const RANGE = { traffic: 60, park: 35, water: 150 } as const;
/** Выше этой высоты (м) над землёй слышен только далёкий гул города. */
const STREET_LEVEL_FADE = 250;
const DISTANT_CITY_TRAFFIC = 0.25;

const HARD: GroundKind[] = ['road', 'sidewalk', 'footway', 'paving', 'parking', 'marking'];

const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);

/** Звуковые «зоны» города по поверхностям земли из OSM: дороги, парки, вода. */
export class SoundZones {
  private readonly roads: LocalPolygon[];
  private readonly greens: LocalPolygon[];
  private readonly waters: LocalPolygon[];
  private readonly hard: LocalPolygon[];

  constructor(ground: readonly GroundFeature[], frame: LocalFrame) {
    const of = (kinds: GroundKind[]) =>
      ground
        .filter((f) => kinds.includes(f.properties.kind))
        .flatMap(polygonsOfGround)
        .map((rings) => toLocalPolygon(rings, frame));
    this.roads = of(['road']);
    this.greens = of(['green', 'pitch']);
    this.waters = of(['water']);
    this.hard = of(HARD);
  }

  /** Громкость слоёв в точке; altitude — высота слушателя над землёй, м. */
  levelsAt(point: Vec2, altitude: number): AmbienceLevels {
    const street = clamp01(1 - (altitude - 3) / STREET_LEVEL_FADE);
    if (street === 0) return { traffic: DISTANT_CITY_TRAFFIC, park: 0, water: 0 };

    const traffic = clamp01(1 - nearest(point, this.roads, RANGE.traffic) / RANGE.traffic);
    const park = clamp01(1 - nearest(point, this.greens, RANGE.park) / RANGE.park);
    const water = clamp01(1 - nearest(point, this.waters, RANGE.water) / RANGE.water);
    return {
      traffic: DISTANT_CITY_TRAFFIC + (traffic - DISTANT_CITY_TRAFFIC) * street,
      park: park * street,
      water: water * street,
    };
  }

  /** По чему идёт пешеход: дорожки, тротуары и площади — «плитка», газон — «трава». */
  surfaceAt(point: Vec2): Surface {
    if (containedIn(point, this.hard)) return 'pavement';
    return containedIn(point, this.greens) ? 'grass' : 'pavement';
  }
}

const inBox = ([x, y]: Vec2, p: LocalPolygon, margin: number) =>
  x >= p.minX - margin && x <= p.maxX + margin && y >= p.minY - margin && y <= p.maxY + margin;

/** Расстояние до ближайшего полигона (0 — внутри); дальше maxDistance не ищем. */
function nearest(point: Vec2, polygons: readonly LocalPolygon[], maxDistance: number): number {
  let best = maxDistance;
  for (const p of polygons) {
    if (!inBox(point, p, best)) continue;
    best = Math.min(best, distanceToPolygon(point, p));
    if (best === 0) break;
  }
  return best;
}

function containedIn(point: Vec2, polygons: readonly LocalPolygon[]): boolean {
  return polygons.some((p) => inBox(point, p, 0) && insidePolygon(point, p));
}
