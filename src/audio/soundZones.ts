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
const RANGE = { traffic: 60, park: 35, water: 70, stream: 40 } as const;
/** Выше этой высоты (м) над землёй слышен только далёкий гул города. */
const STREET_LEVEL_FADE = 250;
const DISTANT_CITY_TRAFFIC = 0.25;
/** В деревне машин мало, а птиц слышно везде — не только у газонов. */
const VILLAGE = { birds: 0.6 } as const;
/** С высоты (обзор) птиц всё равно немного слышно — деревня не замолкает. */
const BIRDS_FROM_ABOVE = 0.25;
/** Деревья вокруг слушателя: ячейки сетки, радиус «рощи» и сколько деревьев — уже лес, м и шт. */
const TREE_CELL = 25;
const WOODS_RADIUS = 45;
const WOODS_FULL = 30;

const HARD: GroundKind[] = ['road', 'sidewalk', 'footway', 'paving', 'parking', 'marking'];

const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);

/** Звуковые «зоны» города по поверхностям земли из OSM: дороги, парки, вода. */
export class SoundZones {
  private readonly roads: LocalPolygon[];
  private readonly greens: LocalPolygon[];
  private readonly waters: LocalPolygon[];
  private readonly streams: LocalPolygon[];
  private readonly hard: LocalPolygon[];
  /** Сколько деревьев в каждой ячейке TREE_CELL × TREE_CELL. */
  private readonly treeCells = new Map<string, number>();

  constructor(
    ground: readonly GroundFeature[],
    frame: LocalFrame,
    private readonly village = false,
    /** Деревья (локальные метры): у леса и в рощах птиц больше. */
    trees: readonly Vec2[] = [],
  ) {
    for (const [x, y] of trees) {
      const key = `${Math.floor(x / TREE_CELL)}:${Math.floor(y / TREE_CELL)}`;
      this.treeCells.set(key, (this.treeCells.get(key) ?? 0) + 1);
    }
    const of = (kinds: GroundKind[], keep: (f: GroundFeature) => boolean = () => true) =>
      ground
        .filter((f) => kinds.includes(f.properties.kind) && keep(f))
        .flatMap(polygonsOfGround)
        .map((rings) => toLocalPolygon(rings, frame));
    this.roads = of(['road']);
    this.greens = of(['green', 'pitch']);
    this.waters = of(['water'], (f) => !f.properties.stream);
    this.streams = of(['water'], (f) => !!f.properties.stream);
    this.hard = of(HARD);
  }

  /** Громкость слоёв в точке; altitude — высота слушателя над землёй, м. */
  levelsAt(point: Vec2, altitude: number): AmbienceLevels {
    const street = clamp01(1 - (altitude - 3) / STREET_LEVEL_FADE);
    const distant = this.village ? 0 : DISTANT_CITY_TRAFFIC;
    if (street === 0) return { traffic: distant, park: this.village ? BIRDS_FROM_ABOVE : 0, leaves: 0, water: 0 };

    const traffic = clamp01(1 - nearest(point, this.roads, RANGE.traffic) / RANGE.traffic);
    const park = clamp01(1 - nearest(point, this.greens, RANGE.park) / RANGE.park);
    const water = Math.max(
      clamp01(1 - nearest(point, this.waters, RANGE.water) / RANGE.water),
      // Ручей журчит только рядом.
      clamp01(1 - nearest(point, this.streams, RANGE.stream) / RANGE.stream),
    );
    if (this.village) {
      // В деревне — только птицы и вода рядом: без гула машин и шипения листвы. У леса и в рощах птиц больше.
      const birds = Math.max(park, VILLAGE.birds + (1 - VILLAGE.birds) * this.woodsAt(point));
      return { traffic: 0, park: Math.max(BIRDS_FROM_ABOVE, birds * street), leaves: 0, water: water * street };
    }
    return {
      traffic: DISTANT_CITY_TRAFFIC + (traffic - DISTANT_CITY_TRAFFIC) * street,
      park: park * street,
      leaves: park * street,
      water: water * street,
    };
  }

  /** Насколько вокруг лес: 0 — деревьев нет, 1 — густо (WOODS_FULL и больше в радиусе WOODS_RADIUS). */
  woodsAt([x, y]: Vec2): number {
    if (!this.treeCells.size) return 0;
    const reach = Math.ceil(WOODS_RADIUS / TREE_CELL);
    const ci = Math.floor(x / TREE_CELL);
    const cj = Math.floor(y / TREE_CELL);
    let count = 0;
    for (let i = ci - reach; i <= ci + reach; i++) {
      for (let j = cj - reach; j <= cj + reach; j++) {
        const dx = Math.max(0, Math.abs((i + 0.5) * TREE_CELL - x) - TREE_CELL / 2);
        const dy = Math.max(0, Math.abs((j + 0.5) * TREE_CELL - y) - TREE_CELL / 2);
        if (Math.hypot(dx, dy) <= WOODS_RADIUS) count += this.treeCells.get(`${i}:${j}`) ?? 0;
      }
    }
    return clamp01(count / WOODS_FULL);
  }

  /** По чему идёт пешеход: дорожки, тротуары и площади — «плитка», газон — «трава». */
  surfaceAt(point: Vec2): Surface {
    if (containedIn(point, this.hard)) return 'pavement';
    // В деревне вне дорог — дворы и улицы без асфальта: под ногами трава и земля.
    return this.village || containedIn(point, this.greens) ? 'grass' : 'pavement';
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
