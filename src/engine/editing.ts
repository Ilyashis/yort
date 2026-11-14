// Редактор и подложка из первой версии поверх движка v2: слой правок (свои дома, заборы, ручки),
// инструменты (дом, дорога, забор, выбор), кисть рельефа, снимок-подложка. Сами инструменты и модель
// правок — код v1 (src/three, src/world/edit); здесь — связь правок со сценой v2.

import type { Object3D } from 'three';
import type { Road, World } from '../core/data';
import type { P2 } from '../core/geo';
import { RoadIndex } from '../core/spatial';
import { useStore } from '../state/store';
import { useEditStore } from '../store/useEditStore';
import { useUnderlayStore } from '../store/useUnderlayStore';
import type { BuildingsLayer } from '../three/BuildingsLayer';
import type { CityScene } from '../three/CityScene';
import { EditLayer } from '../three/EditLayer';
import { EditorTool } from '../three/EditorTool';
import type { GroundLayer } from '../three/GroundLayer';
import type { GroundUnderlay } from '../three/groundUnderlay';
import { TerrainBrush } from '../three/TerrainBrush';
import { UnderlayLayer } from '../three/UnderlayLayer';
import { changeAt, changeRect, replayStrokes, SculptField, type SculptChange, type SculptStroke } from '../world/base/sculpt';
import type { BaseBuildingFeature } from '../world/base/types';
import { addStroke, modelOptions, parseOsmAddress, plateText, plotKey, replacedOsmIds, ROAD_KINDS, type Edits, type HouseAddress, type LonLat } from '../world/edit/edits';
import { AddressPlates, type PlateItem } from '../three/AddressPlates';
import { createLocalFrame, type LocalFrame } from '../world/walk/localFrame';
import type { BuildingSet } from './buildings';
import type { Rect } from './shared';
import type { HeightMap } from './terrain';
import type { TreesLayer } from './trees';
import type { VillageLayers } from './village';

/** Поправки кисти рельефа: поле и мазки, из которых оно собрано. */
export interface SculptState {
  field: SculptField;
  strokes: readonly SculptStroke[];
}

const localFrame = (world: World): LocalFrame => createLocalFrame([world.frame.lon0, world.frame.lat0]);
export const roadKey = (index: number) => `road/${index}`;

/** Повторить мазки кисти из правок места (правки уже загружены) — всё остальное строится на поправленной земле. */
export function loadSculpt(world: World, hm: HeightMap): SculptState {
  const strokes = useEditStore.getState().edits.terrain;
  const field = strokes.length ? replayStrokes(strokes, localFrame(world).toLocal, (x, y) => hm.atBase(x, -y)) : new SculptField();
  if (strokes.length) hm.applyOffsets((x, z) => field.offsetAt(x, -z));
  return { field, strokes };
}

/** Дороги с учётом правок: убранные дороги OSM пропадают, нарисованные добавляются. */
export function roadsWithEdits(world: World, edits: Edits): { roads: Road[]; paths: Road[] } {
  const frame = world.frame;
  const removed = new Set(edits.removedRoads);
  const roads = world.roads.filter((_, i) => !removed.has(roadKey(i)));
  const paths = [...world.paths];
  for (const r of edits.roads) {
    const pts = r.axis.map(([lon, lat]) => frame.xz(lon, lat));
    const width = ROAD_KINDS[r.kind].width;
    if (r.kind === 'path') paths.push({ highway: 'path', width, pts });
    else roads.push({ highway: r.kind === 'street' ? 'residential' : r.kind === 'lane' ? 'service' : 'track', width, pts });
  }
  return { roads, paths };
}

export interface EditingDeps {
  host: CityScene;
  world: World;
  hm: HeightMap;
  buildings: BuildingSet;
  village?: VillageLayers;
  overview: { setEnabled: (enabled: boolean) => void };
  underlay: GroundUnderlay;
  sculpt: SculptState;
  /** Земля поменялась в прямоугольнике (координаты мира): сетка рельефа и всё, что на ней стоит. */
  groundChanged: (area: Rect) => void;
  /** Пересчитать выравнивание земли (площадки домов, улицы) по правкам; возвращает, что сдвинулось. */
  level: (edits: Edits) => { area: Rect; delta: (x: number, z: number) => number } | undefined;
  /** Дороги или дворы поменялись: маски земли, фонари, разметка. */
  roadsChanged: (edits: Edits, hiddenPlots: ReadonlySet<string>) => void;
  /** Поменялось, кто мешает пройти: убранные дома OSM, свои дома, скрытые участки. */
  obstaclesChanged: (edits: Edits, hiddenPlots: ReadonlySet<string>) => void;
  setCityVisible: (visible: boolean) => void;
  /** Остальное, что стоит на земле и должно ехать за ней (настоящие заборы). */
  /** Заборы с карты: их можно выбрать (тогда забор переходит в правки) и спрятать. */
  mapFences?: readonly { id: string; line: [number, number][] }[];
  setMapFencesHidden?: (keys: ReadonlySet<string>) => void;
  shiftExtra?: (delta: (x: number, y: number) => number, area: { x0: number; x1: number; y0: number; y1: number }) => void;
  pickables: () => Object3D[];
  /** Деревья: свои из правок и убранные ластиком. */
  trees?: Pick<TreesLayer, 'setOwn' | 'setCleared' | 'ownCrowns'>;
}

export function createEditing(d: EditingDeps): { dispose: () => void } {
  const { host, world, hm, buildings, village, sculpt } = d;
  const frame = localFrame(world);
  const isVillage = world.territory.kind === 'village';
  const heightAt = (x: number, y: number) => hm.at(x, -y);
  const ground0 = (x: number, y: number) => hm.atBase(x, -y);
  const lonLat = (p: P2): LonLat => [world.frame.lon(p[0]), world.frame.lat(p[1])];
  const osmRoads = new RoadIndex(world.roads);
  const roadIndex = new Map(world.roads.map((r, i) => [r, i]));

  const base: BuildingsLayer = {
    buildingInfo: (id) => {
      const b = buildings.byId(id);
      if (!b) return undefined;
      return {
        props: { building: b.props.building, levels: b.props.levels ?? (b.levels || 1) },
        outline: b.rings[0].map(lonLat).reverse(),
        wallTop: b.wallH,
        roof: b.roof === 'flat' ? 'flat' : b.roof === 'gabled' || b.roof === 'skillion' ? 'gabled' : 'hipped',
        facadeColor: `#${b.wall.getHexString()}`,
        roofColor: `#${b.roofColour.getHexString()}`,
      };
    },
    setHidden: (ids) => buildings.setHidden(ids),
    pickables: [buildings.mesh],
    buildingFromPick: (hit) => {
      if (!hit || hit.object !== buildings.mesh || hit.faceIndex == null) return undefined;
      const b = buildings.pick(hit.faceIndex);
      return b && { id: b.props.id };
    },
  };
  const ground: GroundLayer = {
    roadAt: (lon, lat) => {
      const [x, z] = world.frame.xz(lon, lat);
      const removed = new Set(useEditStore.getState().edits.removedRoads);
      const hit = osmRoads.nearest(x, z, 14, (r) => !removed.has(roadKey(roadIndex.get(r)!)));
      return hit && hit.dist <= hit.road.width / 2 + 1 ? { key: roadKey(roadIndex.get(hit.road)!) } : undefined;
    },
    setUnderlay: (view) => d.underlay.set(view),
    heightAt,
  };

  const editLayer = new EditLayer(host, frame, heightAt, isVillage);
  const xzOf = ([lon, lat]: LonLat) => {
    const [x, z] = world.frame.xz(lon, lat);
    return { x, z };
  };
  // Адресные таблички: адрес из правок, иначе из OSM (addr:street + addr:housenumber).
  const plates = new AddressPlates(host, heightAt);
  const osmAddresses: Record<string, HouseAddress> = {};
  for (const b of world.buildings) {
    const address = parseOsmAddress(b.props.address);
    if (address) osmAddresses[b.props.id] = address;
  }
  const streetNames = [...new Set([...world.roads.map((r) => r.name), ...Object.values(osmAddresses).map((a) => a.street)].filter((n): n is string => !!n))].sort((a, b) => a.localeCompare(b, 'ru'));
  useEditStore.getState().setAddressBook({ streets: streetNames, osm: osmAddresses });
  // Оси дорог в локальных метрах (y — на север).
  const roadAxes = world.roads.map((r) => r.pts.map(([x, z]): [number, number] => [x, -z]));
  /** Стена контура, обращённая к ближайшей дороге, и её внешняя нормаль. */
  const streetWall = (ring: [number, number][]): { wall: [[number, number], [number, number]]; normal: [number, number] } | undefined => {
    const pts = ring.length > 1 && ring[0]![0] === ring[ring.length - 1]![0] && ring[0]![1] === ring[ring.length - 1]![1] ? ring.slice(0, -1) : ring;
    if (pts.length < 3) return undefined;
    const area = pts.reduce((s, p, i) => s + p[0] * pts[(i + 1) % pts.length]![1] - pts[(i + 1) % pts.length]![0] * p[1], 0);
    let best: { d: number; wall: [[number, number], [number, number]]; normal: [number, number] } | undefined;
    pts.forEach((a, i) => {
      const b = pts[(i + 1) % pts.length]!;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 2) return;
      // Наружу: для обхода против часовой — вправо от направления стены.
      const sign = area > 0 ? 1 : -1;
      const normal: [number, number] = [((b[1] - a[1]) / len) * sign, (-(b[0] - a[0]) / len) * sign];
      const probe: [number, number] = [(a[0] + b[0]) / 2 + normal[0] * 3, (a[1] + b[1]) / 2 + normal[1] * 3];
      let d = Number.POSITIVE_INFINITY;
      for (const axis of roadAxes) for (let k = 1; k < axis.length; k++) d = Math.min(d, segDistance(probe, axis[k - 1]!, axis[k]!));
      if (!best || d < best.d) best = { d, wall: [a, b], normal };
    });
    return best && { wall: best.wall, normal: best.normal };
  };
  // Свои деревья и ластик: координаты мира (x на восток, z на юг).
  let lastTrees: unknown;
  const layTrees = (edits: Edits) => {
    const key = [edits.trees, edits.clearedTrees];
    if (lastTrees && same(key, lastTrees as unknown[])) return;
    lastTrees = key;
    d.trees?.setOwn(
      (edits.trees ?? []).map((t) => {
        return { id: t.id, ...xzOf(t.at), species: t.kind, s: t.scale };
      }),
    );
    d.trees?.setCleared((edits.clearedTrees ?? []).map((c): [number, number, number] => [...world.frame.xz(c.at[0], c.at[1]), c.radius]));
  };
  const layPlates = (edits: Edits) => {
    const address = (key: string) => edits.addresses?.[key] ?? osmAddresses[key];
    const replaced = replacedOsmIds(edits);
    const removed = new Set(edits.removedBuildings);
    const items: PlateItem[] = [];
    for (const h of village?.models?.houses ?? []) {
      const a = !replaced.has(h.id) && !removed.has(h.id) ? address(h.id) : undefined;
      if (a) items.push({ id: h.id, rect: h.rect, model: h.model, seed: h.seed, text: plateText(a) });
    }
    const modelled = new Set((village?.models?.houses ?? []).map((h) => h.id));
    for (const b of edits.buildings) {
      const a = address(plotKey(b));
      if (!a) continue;
      const ring = b.footprint.map(frame.toLocal);
      if (b.model && b.footprint.length === 4) items.push({ id: b.id, rect: ring, model: b.model.id, seed: b.model.seed, text: plateText(a), exact: { mirror: b.model.mirror, options: modelOptions(b.model) } });
      else {
        const wall = streetWall(ring);
        if (wall) items.push({ id: b.id, ...wall, text: plateText(a) });
      }
    }
    // Здания OSM без модели (школа, магазин): табличка на стене, что смотрит на ближайшую дорогу.
    for (const f of world.buildings) {
      const id = f.props.id;
      if (modelled.has(id) || replaced.has(id) || removed.has(id) || f.props.minHeight > 0) continue;
      const a = address(id);
      const ring = a && f.rings[0]?.map(([x, z]): [number, number] => [x, -z]);
      const wall = ring && streetWall(ring);
      if (a && wall) items.push({ id, ...wall, text: plateText(a) });
    }
    plates.update(items);
  };
  const osmBuildings = world.buildings.map((b) => ({
    type: 'Feature',
    id: b.props.id,
    properties: b.props,
    geometry: { type: 'Polygon', coordinates: b.rings.map((ring) => [...ring, ring[0]].map(lonLat)) },
  })) as unknown as BaseBuildingFeature[];
  const editor = new EditorTool({
    city: host,
    frame,
    base,
    layer: editLayer,
    ground,
    controls: d.overview,
    village: isVillage,
    osmRoads: world.roads.map((r) => r.pts.map(([x, z]): [number, number] => [x, -z])),
    osmBuildings,
    yards: village?.yards ?? [],
    models: village?.models,
    yardModels: village?.yardModels,
    mapFences: d.mapFences ?? [],
    ownTrees: () => d.trees?.ownCrowns().map((c) => ({ x: c.x, y: c.y, z: c.z, id: c.id })) ?? [],
    previewTrees: (trees) => d.trees?.setOwn(trees.map((t) => ({ id: t.id, ...xzOf(t.at), species: t.kind, s: t.scale }))),
  });
  useEditStore.getState().setMapFenceIds((d.mapFences ?? []).map((f) => f.id));

  // Кисть рельефа: земля и всё, что на ней, меняются по ходу мазка; мазок — в правки (отмена — Ctrl+Z).
  const followGround = (change: SculptChange) => {
    const changed = changeRect(change);
    const area: Rect = { x0: changed.x0, x1: changed.x1, z0: -changed.y1, z1: -changed.y0 };
    hm.applyOffsets((x, z) => sculpt.field.offsetAt(x, -z), area);
    d.groundChanged(area);
    village?.shiftGround((x, y) => changeAt(change, x, y), changed);
    d.shiftExtra?.((x, y) => changeAt(change, x, y), changed);
  };
  const brush = new TerrainBrush({
    city: host,
    controls: d.overview,
    heightAt,
    toLonLat: frame.toLonLat,
    onDab: (b, center) => followGround(sculpt.field.dab(b, center, ground0)),
    onStroke: (stroke) => {
      const { edits, commit } = useEditStore.getState();
      const next = addStroke(edits, stroke);
      sculpt.strokes = next.terrain;
      commit(next);
    },
  });
  /** Мазки в правках поменялись не кистью (отмена, повтор, файл правок) — повторить их и сдвинуть землю. */
  const syncTerrain = () => {
    const { terrain } = useEditStore.getState().edits;
    if (terrain === sculpt.strokes) return;
    const next = replayStrokes(terrain, frame.toLocal, ground0);
    const changes = sculpt.field.changesTo(next);
    sculpt.field = next;
    sculpt.strokes = terrain;
    for (const change of changes) followGround(change);
  };

  const store = useEditStore.getState();
  store.setResolver((id) => editor.resolve(id));
  store.setModelApplier((b, model) => editor.applyModel(b, model));

  let lastLevel: unknown[] = [useEditStore.getState().edits.lines, useEditStore.getState().edits.shapes, useEditStore.getState().edits.spots, useEditStore.getState().edits.plotLifts, useEditStore.getState().edits.buildings, useEditStore.getState().edits.removedBuildings, useEditStore.getState().edits.roads, useEditStore.getState().edits.removedRoads];
  let lastRoads: unknown[] = [];
  let lastObstacles: unknown[] = [];
  const same = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((v, i) => v === b[i]);

  /** Выделение в редакторе: ручки у дома, подсветка дороги или забора. */
  const showSelection = () => {
    const { selection, edits } = useEditStore.getState();
    editLayer.setHandles(selection?.type === 'building' ? (edits.buildings.find((b) => b.id === selection.id) ?? editor.resolve(selection.id)) : undefined);
    let lines: LonLat[][] = [];
    if (selection?.type === 'road') {
      const own = edits.roads.find((r) => r.id === selection.id);
      const osm = world.roads.find((_, i) => roadKey(i) === selection.id);
      lines = own ? [own.axis] : osm ? [osm.pts.map(lonLat)] : [];
    } else if (selection?.type === 'tree') {
      // Выбранное дерево — круг по земле под кроной.
      const tree = edits.trees?.find((t) => t.id === selection.id);
      if (tree) {
        const [x, y] = frame.toLocal(tree.at);
        const r = 1.6 * tree.scale + 0.6;
        lines = [Array.from({ length: 25 }, (_, i) => frame.toLonLat([x + Math.cos((i / 24) * Math.PI * 2) * r, y + Math.sin((i / 24) * Math.PI * 2) * r]) as LonLat)];
      }
    } else if (selection?.type === 'fence') {
      const fence = edits.fences.find((f) => f.id === selection.id);
      const yard = village?.yards.find((y) => y.houseId === selection.id);
      lines = fence ? [fence.line] : (yard?.fence ?? []).map((segment) => segment.map(frame.toLonLat) as LonLat[]);
    }
    editLayer.highlight(lines);
    // У своего забора — ручки на изломах: точку можно тянуть, чуть снаружи — повернуть.
    const ownFence = selection?.type === 'fence' ? edits.fences.find((f) => f.id === selection.id) : undefined;
    if (ownFence) editLayer.setLineHandles(ownFence.line, ownFence.gates);
  };

  /** Правки → сцена: что скрыть из OSM, что дорисовать, кто мешает пешеходу. */
  const applyEdits = () => {
    syncTerrain();
    const { edits, selection } = useEditStore.getState();
    // Подняли участок, подвинули дом или дорогу — площадки и полотно улиц пересчитываются.
    const levelKey = [edits.lines, edits.shapes, edits.spots, edits.plotLifts, edits.buildings, edits.removedBuildings, edits.roads, edits.removedRoads];
    if (!same(levelKey, lastLevel)) {
      lastLevel = levelKey;
      const moved = d.level(edits);
      if (moved) {
        d.groundChanged(moved.area);
        const local = { x0: moved.area.x0, x1: moved.area.x1, y0: -moved.area.z1, y1: -moved.area.z0 };
        village?.shiftGround((x, y) => moved.delta(x, -y), local);
        d.shiftExtra?.((x, y) => moved.delta(x, -y), local);
      }
    }
    const removed = new Set(edits.removedBuildings);
    const replaced = new Set(edits.buildings.map((b) => b.source).filter((s): s is string => !!s));
    const deleted = new Set([...removed].filter((id) => !replaced.has(id)));
    buildings.setHidden(removed);
    d.setMapFencesHidden?.(new Set(edits.removedFences ?? []));
    const edited = edits.buildings
      .filter((b) => b.model && b.footprint.length === 4)
      .map((b) => ({ id: b.id, source: b.source, model: b.model!.id, rect: b.footprint.map(frame.toLocal), garden: b.garden ?? 0 }));
    const hiddenPlots = village?.setEdits({ replaced: replacedOsmIds(edits), removedYards: new Set(edits.removedYards), deleted, edited }) ?? new Set<string>();
    // Дома тоже: под каждым домом в масках земли своё пятно (тень у стен, место без снимка) — оно должно
    // переезжать вместе с домом.
    const roadsKey = [edits.roads, edits.removedRoads, edits.removedYards, edits.buildings, edits.removedBuildings, [...hiddenPlots].sort().join()];
    const obstaclesKey = [edits.buildings, edits.removedBuildings, [...hiddenPlots].sort().join()];
    if (!same(obstaclesKey, lastObstacles)) {
      lastObstacles = obstaclesKey;
      d.obstaclesChanged(edits, hiddenPlots);
    }
    if (!same(roadsKey, lastRoads)) {
      lastRoads = roadsKey;
      d.roadsChanged(edits, hiddenPlots);
    }
    editLayer.render(edits, selection?.type === 'building' ? selection.id : undefined);
    layPlates(edits);
    layTrees(edits);
    showSelection();
  };
  applyEdits();

  const unsubscribeEdits = useEditStore.subscribe((state, prev) => {
    if (state.edits !== prev.edits) applyEdits();
    else if (state.selection !== prev.selection) {
      editLayer.render(state.edits, state.selection?.type === 'building' ? state.selection.id : undefined);
      showSelection();
    }
    if (state.tool !== prev.tool) {
      host.canvas.style.cursor = state.tool && state.tool !== 'select' ? 'crosshair' : '';
      if (state.tool) useStore.getState().set({ selected: null });
    }
  });

  // Подложка: свой снимок сверху (или ортофото), по которому обводят дома и заборы.
  const underlayLayer = new UnderlayLayer(host, ground, frame, {
    setCameraEnabled: (enabled) => d.overview.setEnabled(enabled),
    pickables: d.pickables,
  });
  void useUnderlayStore.getState().load(world.territory.id);
  if (useUnderlayStore.getState().hideCity) d.setCityVisible(false);
  const unsubscribeUnderlay = useUnderlayStore.subscribe((state, prev) => {
    if (state.hideCity !== prev.hideCity) d.setCityVisible(!state.hideCity);
  });

  return {
    dispose: () => {
      unsubscribeEdits();
      unsubscribeUnderlay();
      underlayLayer.destroy();
      brush.destroy();
      editor.destroy();
      editLayer.destroy();
      plates.destroy();
      d.underlay.set(undefined);
      host.canvas.style.cursor = '';
      const s = useEditStore.getState();
      s.setResolver(undefined);
      s.setModelApplier(undefined);
      s.setTool(undefined);
      s.select(undefined);
    },
  };
}

function segDistance(p: [number, number], a: [number, number], b: [number, number]): number {
  const abx = b[0] - a[0], aby = b[1] - a[1];
  const l2 = abx * abx + aby * aby;
  const t = l2 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - abx * t, p[1] - a[1] - aby * t);
}
