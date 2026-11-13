// Загрузка данных территории (OSM, рельеф, съёмка с дрона) и перевод в координаты мира.

import territoriesJson from '../config/territories.json';
import { Frame, normalizeRing, type BBox, type P2 } from './geo';

export interface Territory {
  id: string;
  name: string;
  shortName: string;
  kind: 'city' | 'village';
  description: string;
  bbox: BBox;
  /** Деревня: улицы с асфальтом по названию (кроме проходящей дороги — она асфальтовая всегда). */
  pavedStreets?: string[];
}

export const TERRITORIES = territoriesJson as Territory[];
export const findTerritory = (id: string | null | undefined) => TERRITORIES.find((t) => t.id === id);

export interface BuildingProps {
  id: string;
  building: string;
  name?: string;
  address?: string;
  levels?: number;
  height: number;
  minHeight: number;
  heightSource: 'height' | 'levels' | 'default';
  roofShape?: string;
  roofHeight?: number;
  roofOrientation?: 'across';
  roofColour?: string;
  colour?: string;
  material?: string;
  /** Постройка найдена по съёмке с дрона. */
  survey?: 'shed' | 'house';
}

/** Контур здания в координатах мира: первое кольцо — внешнее (площадь > 0), остальные — дворы. */
export interface Footprint {
  props: BuildingProps;
  rings: P2[][];
}

export type GroundKind = 'green' | 'pitch' | 'water' | 'parking' | 'paving' | 'sidewalk' | 'road' | 'footway';

export interface GroundArea {
  kind: GroundKind;
  cover?: 'wood' | 'meadow';
  rings: P2[][];
}

export interface Road {
  highway: string;
  width: number;
  name?: string;
  oneway?: boolean;
  lanes?: number;
  pts: P2[];
}

export interface World {
  territory: Territory;
  frame: Frame;
  dem: Dem;
  /** Подробный рельеф со своей съёмки (файл как есть): его разбирает и выравнивает world/base/detailTerrain. */
  detailFile?: unknown;
  buildings: Footprint[];
  parts: Footprint[];
  ground: GroundArea[];
  /** Поверхности земли как в файле (долгота, широта) — для звуковых зон. */
  groundRaw: unknown[];
  roads: Road[];
  paths: Road[];
  crossings: P2[][];
  lamps: P2[];
  benches: P2[];
  trees: P2[];
  /** Настоящие деревья по своей съёмке: место, высота и радиус кроны (м), порода. */
  surveyTrees: { x: number; z: number; height: number; radius: number; spruce: boolean; dense?: boolean }[];
  /** Настоящие заборы (линии в координатах мира), снятые с картинки-рендера. */
  surveyFences: P2[][];
  /** Снято ли это место съёмкой: там деревья не сажаются наугад. */
  surveyed: (x: number, z: number) => boolean;
  /** Цвета домов по съёмке с дрона: id → крыша и стены. */
  surveyColours: Record<string, { roof?: string; wall?: string }>;
  osmTimestamp?: string;
}

interface TerrainFile {
  bbox: { west: number; south: number; east: number; north: number };
  width: number;
  height: number;
  scale: number;
  offset: number;
  heights: string;
  nodata?: number;
  fade?: number;
}

function decodeHeights(file: TerrainFile): Float32Array {
  const bin = atob(file.heights);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const raw = new Int16Array(bytes.buffer, 0, bytes.length >> 1);
  const out = new Float32Array(raw.length);
  const nodata = file.nodata;
  for (let i = 0; i < raw.length; i++) out[i] = raw[i] === nodata ? NaN : raw[i] * file.scale + file.offset;
  return out;
}

/** Общий рельеф (Copernicus, ~30 м): сетка по долготе и широте, строка 0 — север. */
export class Dem {
  readonly mean: number;
  private readonly v: Float32Array;
  private readonly b: TerrainFile['bbox'];
  private readonly w: number;
  private readonly h: number;
  private readonly kx: number;

  constructor(file: TerrainFile) {
    this.v = decodeHeights(file);
    this.b = file.bbox;
    this.w = file.width;
    this.h = file.height;
    let sum = 0;
    for (let i = 0; i < this.v.length; i++) sum += this.v[i];
    this.mean = sum / this.v.length;
    this.kx = 111_320 * Math.cos((((this.b.south + this.b.north) / 2) * Math.PI) / 180);
  }

  at(lon: number, lat: number): number {
    const b = this.b;
    const cl = Math.min(Math.max(lon, b.west), b.east);
    const ct = Math.min(Math.max(lat, b.south), b.north);
    const fx = ((cl - b.west) / (b.east - b.west)) * (this.w - 1);
    const fy = ((b.north - ct) / (b.north - b.south)) * (this.h - 1);
    const x0 = Math.min(Math.floor(fx), this.w - 2);
    const y0 = Math.min(Math.floor(fy), this.h - 2);
    const tx = fx - x0;
    const ty = fy - y0;
    const i = y0 * this.w + x0;
    const v = this.v;
    const inside =
      (v[i] * (1 - tx) + v[i + 1] * tx) * (1 - ty) + (v[i + this.w] * (1 - tx) + v[i + this.w + 1] * tx) * ty;
    if (cl === lon && ct === lat) return inside;
    // За краем сетки рельеф плавно выходит на среднюю высоту.
    const d = Math.hypot((lon - cl) * this.kx, (lat - ct) * 111_320);
    const t = Math.min(d / 3000, 1);
    return inside + (this.mean - inside) * t * t * (3 - 2 * t);
  }
}

type Coords = number[][];
interface Feature<P> {
  properties: P;
  geometry: { type: 'Polygon'; coordinates: Coords[] } | { type: 'MultiPolygon'; coordinates: Coords[][] };
}

function toRings(frame: Frame, polygon: Coords[]): P2[][] {
  const rings: P2[][] = [];
  polygon.forEach((ring, i) => {
    const r = normalizeRing(ring.map((c) => frame.xz(c[0], c[1])), i === 0);
    if (r.length >= 3) rings.push(r);
    else if (i === 0) rings.length = 0;
  });
  return rings;
}

function polygonsOf<P>(frame: Frame, f: Feature<P>): P2[][][] {
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  return polys.map((p) => toRings(frame, p)).filter((r) => r.length > 0);
}

async function getJson<T>(territory: Territory, file: string): Promise<T | undefined> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}data/territories/${territory.id}/${file}`);
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return undefined;
    return (await res.json()) as T;
  } catch {
    return undefined;
  }
}

interface StreetsFile {
  roads?: { highway: string; width: number; name?: string; oneway?: boolean; lanes?: number; coords: number[][] }[];
  paths?: { highway: string; width: number; coords: number[][] }[];
  crossings?: number[][][];
  lamps?: number[][];
  benches?: number[][];
}

interface SurveyFile {
  houses?: Record<string, { roof?: string; wall?: string }>;
  buildings?: { id: string; kind: 'shed' | 'house'; footprint: number[][]; height: number; roof?: string }[];
}

interface TreeSurveyFile {
  trees?: [number, number, number, number, 'b' | 's', (0 | 1)?][];
  coverage?: { west: number; south: number; east: number; north: number; width: number; height: number; cells: string };
}

/** Сетка «где съёмка есть» (биты построчно с севера) → проверка точки мира. */
function coverage(frame: Frame, c: TreeSurveyFile['coverage']): (x: number, z: number) => boolean {
  if (!c) return () => false;
  const bin = atob(c.cells);
  const x0 = frame.x(c.west), z0 = frame.z(c.north), w = frame.x(c.east) - x0, h = frame.z(c.south) - z0;
  return (x, z) => {
    const i = Math.floor(((x - x0) / w) * c.width), j = Math.floor(((z - z0) / h) * c.height);
    if (i < 0 || j < 0 || i >= c.width || j >= c.height) return false;
    const k = j * c.width + i;
    return ((bin.charCodeAt(k >> 3) >> (7 - (k & 7))) & 1) === 1;
  };
}

export async function loadWorld(territory: Territory, progress: (label: string) => void): Promise<World> {
  progress('Загружаем данные');
  const [terrain, detailFile, buildingsFile, partsFile, groundFile, streets, treesFile, survey, treeSurvey, streetSurvey, treeRender, fenceRender] = await Promise.all([
    getJson<TerrainFile>(territory, 'terrain.json'),
    getJson<TerrainFile>(territory, 'terrain-detail.json'),
    getJson<{ metadata?: { osmTimestamp?: string }; features: Feature<BuildingProps>[] }>(territory, 'buildings.geojson'),
    getJson<{ features: Feature<BuildingProps>[] }>(territory, 'building-parts.geojson'),
    getJson<{ features: Feature<{ kind: GroundKind; cover?: 'wood' | 'meadow' }>[] }>(territory, 'ground.geojson'),
    getJson<StreetsFile>(territory, 'streets.json'),
    getJson<{ trees: number[][] }>(territory, 'trees.json'),
    getJson<SurveyFile>(territory, 'survey.json'),
    getJson<TreeSurveyFile>(territory, 'trees-survey.json'),
    getJson<StreetsFile>(territory, 'streets-survey.json'),
    getJson<TreeSurveyFile>(territory, 'trees-render.json'),
    getJson<{ fences?: number[][][] }>(territory, 'fences-render.json'),
  ]);
  if (!terrain || !buildingsFile) throw new Error(`Нет данных территории «${territory.name}»`);

  progress('Разбираем рельеф');
  await new Promise((r) => setTimeout(r));
  const frame = new Frame(territory.bbox);
  const dem = new Dem(terrain);

  const footprints = (features: Feature<BuildingProps>[]): Footprint[] =>
    features.flatMap((f) => polygonsOf(frame, f).map((rings) => ({ props: f.properties, rings })));

  const buildings = footprints(buildingsFile.features);
  for (const b of survey?.buildings ?? []) {
    const ring = normalizeRing(b.footprint.map((c) => frame.xz(c[0], c[1])), true);
    if (ring.length < 3) continue;
    buildings.push({
      props: { id: b.id, building: b.kind, height: b.height, minHeight: 0, heightSource: 'height', roofColour: b.roof, survey: b.kind },
      rings: [ring],
    });
  }

  const line = (coords: number[][]): P2[] => coords.map((c) => frame.xz(c[0], c[1]));
  const point = (c: number[]): P2 => frame.xz(c[0], c[1]);

  return {
    territory,
    frame,
    dem,
    detailFile,
    buildings,
    parts: footprints(partsFile?.features ?? []),
    groundRaw: groundFile?.features ?? [],
    ground: (groundFile?.features ?? []).flatMap((f) =>
      polygonsOf(frame, f).map((rings) => ({ kind: f.properties.kind, cover: f.properties.cover, rings })),
    ),
    roads: (streets?.roads ?? []).map((r) => ({ ...r, pts: line(r.coords) })),
    // К тропам OSM — дороги, обведённые по своей съёмке.
    paths: [...(streets?.paths ?? []), ...(streetSurvey?.paths ?? [])].map((r) => ({ ...r, pts: line(r.coords) })),
    crossings: (streets?.crossings ?? []).map(line),
    lamps: (streets?.lamps ?? []).map(point),
    benches: (streets?.benches ?? []).map(point),
    trees: (treesFile?.trees ?? []).map(point),
    // Сначала деревья со съёмки с дрона (с настоящими высотами), потом — снятые с рендера там, где дрона нет.
    surveyTrees: [...(treeSurvey?.trees ?? []), ...(treeRender?.trees ?? [])].map(([lon, lat, height, radius, kind, dense]) => {
      const [x, z] = frame.xz(lon, lat);
      return { x, z, height, radius, spruce: kind === 's', dense: dense === undefined ? undefined : dense === 1 };
    }),
    surveyed: ((a, b) => (x: number, z: number) => a(x, z) || b(x, z))(coverage(frame, treeSurvey?.coverage), coverage(frame, treeRender?.coverage)),
    surveyFences: (fenceRender?.fences ?? []).map(line),
    surveyColours: survey?.houses ?? {},
    osmTimestamp: buildingsFile.metadata?.osmTimestamp,
  };
}
