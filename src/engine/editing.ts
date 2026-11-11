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
import { addStroke, replacedOsmIds, ROAD_KINDS, type Edits, type LonLat } from '../world/edit/edits';
import { createLocalFrame, type LocalFrame } from '../world/walk/localFrame';
import type { BuildingSet } from './buildings';
import type { Rect } from './shared';
import type { HeightMap } from './terrain';
import type { VillageLayers } from './village';

/** Поправки кисти рельефа: поле и мазки, из которых оно собрано. */
export interface SculptState {
  field: SculptField;
  strokes: readonly SculptStroke[];
}

const localFrame = (world: World): LocalFrame => createLocalFrame([world.frame.lon0, world.frame.lat0]);
export const roadKey = (index: number) => `road/${index}`;

/** Загрузить правки места и сразу повторить мазки кисти — всё остальное строится уже на поправленной земле. */
export function loadSculpt(world: World, hm: HeightMap): SculptState {
  useEditStore.getState().load(world.territory.id);
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
  /** Дороги или дворы поменялись: маски земли, фонари, разметка. */
  roadsChanged: (edits: Edits, hiddenPlots: ReadonlySet<string>) => void;
  /** Поменялось, кто мешает пройти: убранные дома OSM, свои дома, скрытые участки. */
  obstaclesChanged: (edits: Edits, hiddenPlots: ReadonlySet<string>) => void;
  setCityVisible: (visible: boolean) => void;
  pickables: () => Object3D[];
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
  });

  // Кисть рельефа: земля и всё, что на ней, меняются по ходу мазка; мазок — в правки (отмена — Ctrl+Z).
  const followGround = (change: SculptChange) => {
    const changed = changeRect(change);
    const area: Rect = { x0: changed.x0, x1: changed.x1, z0: -changed.y1, z1: -changed.y0 };
    hm.applyOffsets((x, z) => sculpt.field.offsetAt(x, -z), area);
    d.groundChanged(area);
    village?.shiftGround((x, y) => changeAt(change, x, y), changed);
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
    } else if (selection?.type === 'fence') {
      const fence = edits.fences.find((f) => f.id === selection.id);
      const yard = village?.yards.find((y) => y.houseId === selection.id);
      lines = fence ? [fence.line] : (yard?.fence ?? []).map((segment) => segment.map(frame.toLonLat) as LonLat[]);
    }
    editLayer.highlight(lines);
  };

  /** Правки → сцена: что скрыть из OSM, что дорисовать, кто мешает пешеходу. */
  const applyEdits = () => {
    syncTerrain();
    const { edits, selection } = useEditStore.getState();
    const removed = new Set(edits.removedBuildings);
    const replaced = new Set(edits.buildings.map((b) => b.source).filter((s): s is string => !!s));
    const deleted = new Set([...removed].filter((id) => !replaced.has(id)));
    buildings.setHidden(removed);
    const hiddenPlots = village?.setEdits({ replaced: replacedOsmIds(edits), removedYards: new Set(edits.removedYards), deleted }) ?? new Set<string>();
    const roadsKey = [edits.roads, edits.removedRoads, edits.removedYards, [...hiddenPlots].sort().join()];
    if (!same(roadsKey, lastRoads)) {
      lastRoads = roadsKey;
      d.roadsChanged(edits, hiddenPlots);
    }
    const obstaclesKey = [edits.buildings, edits.removedBuildings, [...hiddenPlots].sort().join()];
    if (!same(obstaclesKey, lastObstacles)) {
      lastObstacles = obstaclesKey;
      d.obstaclesChanged(edits, hiddenPlots);
    }
    editLayer.render(edits, selection?.type === 'building' ? selection.id : undefined);
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
