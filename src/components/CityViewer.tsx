import { SRGBColorSpace, TextureLoader, type Texture, type Vector3 } from 'three';
import { buffer, lineString } from '@turf/turf';
import { useEffect, useRef, useState } from 'react';
import { Soundscape } from '../audio/Soundscape';
import { SoundZones } from '../audio/soundZones';
import { LANDMARKS } from '../config/landmarks';
import { territoryDataUrl, type Territory } from '../config/territory';
import { isOnStreet, useAppStore } from '../store/useAppStore';
import { CAN_EDIT, DEBUG, PUBLISH_URL, PUBLISHED_EDITS, PUBLISHED_MAP_TREES } from '../config/mode';
import { fetchPublishedEdits, useEditStore } from '../store/useEditStore';
import { useUnderlayStore } from '../store/useUnderlayStore';
import { BuildingsLayer } from '../three/BuildingsLayer';
import { CityScene } from '../three/CityScene';
import { DetailsLayer } from '../three/DetailsLayer';
import { FurnitureLayer } from '../three/FurnitureLayer';
import { TIME_FLOW_HOURS_PER_SECOND } from '../three/dayNight';
import { AddressPlatesLayer, type AddressPlate } from '../three/AddressPlatesLayer';
import { GrassLayer } from '../three/GrassLayer';
import { PublicDetailsLayer, type PublicBuilding } from '../three/PublicDetailsLayer';
import { GroundLayer } from '../three/GroundLayer';
import { LandmarksLayer } from '../three/LandmarksLayer';
import { EditLayer } from '../three/EditLayer';
import { EditorTool } from '../three/EditorTool';
import { TerrainBrush } from '../three/TerrainBrush';
import { OverviewControls } from '../three/OverviewControls';
import { PlotTool } from '../three/PlotTool';
import { UserBuildingsLayer } from '../three/UserBuildingsLayer';
import { GarlandsLayer, type GarlandHouse } from '../three/GarlandsLayer';
import { SnowfallLayer } from '../three/SnowfallLayer';
import { TreesLayer } from '../three/TreesLayer';
import { UnderlayLayer } from '../three/UnderlayLayer';
import { WalkController } from '../three/WalkController';
import { DriveController } from '../three/DriveController';
import { flyToArea, flyToTerritory, focusOf, setIntroView } from '../three/views';
import { addStroke, centroidOf, replacedOsmIds, roadWidth, toFeature, wallHeightOf } from '../world/edit/edits';
import { findHouseModel } from '../world/village/houseModels';
import { SculptField, changeAt, changeRect, replayStrokes, type SculptChange, type SculptStroke } from '../world/base/sculpt';
import { loadEnvironment, polygonsOfGround, type Environment, type TreePoint } from '../world/base/environment';
import { findStreetFrontBuildings, nearNamedStreet } from '../world/base/facades';
import { BARE_GROUND_COLOR, VILLAGE_GROUND_COLOR } from '../world/base/groundStyle';
import { decodeTerrainFile, type TerrainFile, type TerrainKind } from '../world/base/heightGrid';
import { decodeDetailFile, DetailHeights, type DetailTerrainFile } from '../world/base/detailTerrain';
import { openRing, signedArea } from '../world/base/roofGeometry';
import { applySurvey, type SurveyFile } from '../world/base/survey';
import { computeStats, loadBaseBuildings, loadBuildingParts } from '../world/base/loadBaseBuildings';
import { addressLabel, loadParcels, ParcelIndex, type Parcel } from '../world/base/parcels';
import { assignParts } from '../world/base/parts';
import { landmarkClearance, landmarkObstacle } from '../world/base/pedestal';
import { orientBenches, placeLamps, roadMarkings } from '../world/base/streetFurniture';
import { scatterForest, scatterTrees, scatterYardTrees } from '../world/base/vegetation';
import { planYards, VILLAGE_HOUSE_TYPES, type Yard } from '../world/base/yards';
import type { BaseBuildingFeature } from '../world/base/types';
import { planEstates, type EstateInput, type EstatePlan, type Plot } from '../world/village/estates';
import { EstateLayer } from '../three/EstateLayer';
import { editPlan, movePalisade, runKey, type Palisade } from '../world/village/fenceEdits';
import type { GroundArea, GroundDelta } from '../three/merged';
import { BlockedGrid, findTreeSpots, inside as insideRing, MAP_TREE_MODES, type MapTreesMode } from '../world/base/mapTrees';
import type { HouseModelId } from '../world/village/houseModels';
import { analyzePlot } from '../world/user/plot';
import { toObstacle, toProperties, userBuildingId } from '../world/user/userBuildings';
import { Collider } from '../world/walk/collider';
import { CAR, type RoadLine } from '../world/drive/car';
import { MinimapBase, minimapRadius } from '../world/map/minimap';
import { createLocalFrame, toLocalPolygon, type LocalFrame, type Vec2 } from '../world/walk/localFrame';
import { StreetIndex } from '../world/walk/streets';
import { chooseVillageModel, growRect, modelFacadeShift, type VillageHouse } from '../world/village/villagePlan';
import { VillageModelsLayer } from '../three/VillageModelsLayer';
import { FrontGardensLayer, type GardenSite } from '../three/FrontGardensLayer';

/** Камера при пересборке сцены (смена рельефа, съёмки, плана): тот же район открывается с того же места. */
let keptView: { territory: string; position: Vector3; target: Vector3 } | undefined;

/** Рельеф района: сетка DEM из terrain.json; нет файла — плоская земля. */
async function loadHeights(territory: Territory, survey: boolean): Promise<{ heightAt: (lon: number, lat: number) => number; kind: TerrainKind; credit?: string; detail?: DetailHeights }> {
  try {
    const response = await fetch(territoryDataUrl(territory, 'terrain.json'));
    if (response.ok) {
      const file = (await response.json()) as TerrainFile;
      const grid = decodeTerrainFile(file);
      const base = (lon: number, lat: number) => grid.heightAt(lon, lat);
      // Своя съёмка с дрона (если есть): подробный рельеф поверх Copernicus.
      const detail = survey ? await loadDetail(territory, base) : undefined;
      if (detail) {
        return { heightAt: (lon, lat) => detail.heights.heightAt(lon, lat), kind: 'drone', credit: `${file.metadata.credit} · ${detail.credit}`, detail: detail.heights };
      }
      return { heightAt: base, kind: 'dem', credit: file.metadata.credit };
    }
  } catch (error) {
    console.warn('[terrain] не удалось загрузить terrain.json, рельеф будет плоским', error);
  }
  return { heightAt: () => 0, kind: 'flat' };
}

/** Есть ли файл данных района (без скачивания: запрос HEAD; сервер разработки на нет файла отдаёт HTML). */
async function dataExists(territory: Territory, name: string): Promise<boolean> {
  try {
    const response = await fetch(territoryDataUrl(territory, name), { method: 'HEAD' });
    return response.ok && !!response.headers.get('content-type')?.includes('json');
  } catch {
    return false;
  }
}

/** Находки по съёмке с дрона (survey.json): цвета домов и новые постройки; нет файла — нет и находок. */
async function loadSurvey(territory: Territory): Promise<SurveyFile | undefined> {
  try {
    const response = await fetch(territoryDataUrl(territory, 'survey.json'));
    if (!response.ok || !response.headers.get('content-type')?.includes('json')) return undefined;
    return (await response.json()) as SurveyFile;
  } catch {
    return undefined;
  }
}

/** Подробный рельеф terrain-detail.json — по своей съёмке с дрона; нет файла — нет и уточнения. */
async function loadDetail(territory: Territory, base: (lon: number, lat: number) => number): Promise<{ heights: DetailHeights; credit: string } | undefined> {
  try {
    const response = await fetch(territoryDataUrl(territory, 'terrain-detail.json'));
    if (!response.ok || !response.headers.get('content-type')?.includes('json')) return undefined;
    const file = (await response.json()) as DetailTerrainFile;
    return { heights: new DetailHeights(decodeDetailFile(file), base), credit: file.metadata.credit };
  } catch {
    return undefined;
  }
}

/** Здания меньше — хозпостройки (стоят внутри участков), м². */
const SHED_AREA = 45;
/** Жилой дом не больше этого; больше — ферма, склад: ничья земля вокруг, м². */
const HOUSE_AREA = 320;

/** Что знает планировщик посёлка: дома, хозпостройки, ничья земля, улицы и просёлки (локальные метры). */
/** Общественные здания из OSM, которым — вход, вывеска и флаги (форма — как в данных). */
const PUBLIC_DETAIL_TYPES = new Set(['school', 'kindergarten', 'college']);

function estateInput(features: readonly BaseBuildingFeature[], environment: Environment, frame: LocalFrame, parcels?: readonly Parcel[]): EstateInput {
  const input: EstateInput & {
    houses: EstateInput['houses'][number][];
    sheds: EstateInput['sheds'][number][];
    blockers: EstateInput['blockers'][number][];
  } = {
    houses: [],
    sheds: [],
    blockers: [],
    roads: environment.streets.roads.map((r) => ({
      coords: r.coords.map(frame.toLocal),
      width: r.width,
    })),
    tracks: environment.streets.paths.map((p) => ({
      coords: p.coords.map(frame.toLocal),
      width: p.width,
    })),
    ...(parcels?.length ? { parcels: parcels.map((p) => p.ring.map(frame.toLocal)) } : {}),
  };
  for (const f of features) {
    const polygons = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    polygons.forEach((rings, i) => {
      const ring = openRing((rings[0] ?? []).map(frame.toLocal));
      if (ring.length < 3) return;
      const area = Math.abs(signedArea(ring));
      const id = `${f.properties.id}:${i}`;
      if (VILLAGE_HOUSE_TYPES.has(f.properties.building) && area >= SHED_AREA && area <= HOUSE_AREA) input.houses.push({ id, ring });
      else if (area < SHED_AREA * 2.5 && !PUBLIC_TYPES.has(f.properties.building)) input.sheds.push({ id, ring });
      else input.blockers.push({ rings: [ring], margin: 2.5 });
    });
  }
  for (const feature of environment.ground) {
    const water = feature.properties.kind === 'water';
    const wood = feature.properties.kind === 'green' && feature.properties.cover === 'wood';
    if (!water && !wood) continue;
    // Все кольца (с дырами — полянами в лесу) — ничья земля только внутри контура.
    for (const rings of polygonsOfGround(feature)) input.blockers.push({ rings: rings.map((ring) => ring.map(frame.toLocal)), margin: water ? 3 : 0 });
  }
  return input;
}

/** Общественные здания: вокруг них участков нет. */
const PUBLIC_TYPES = new Set(['school', 'mosque', 'church', 'kindergarten', 'public', 'civic', 'commercial', 'retail', 'industrial', 'hospital', 'office']);

/** Участок посёлка как двор (для редактора: выбор забора, «убрать двор», палисадник). */
function plotYard(plot: Plot, fences: readonly [Vec2, Vec2][]): Yard {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of plot.ring) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return {
    houseId: plot.id,
    corners: [
      [minX, minY],
      [maxX, minY],
      [maxX, maxY],
      [minX, maxY],
    ],
    fence: [...fences],
    ...(plot.palisade ? { palisade: plot.palisade } : {}),
    seed: plot.seed,
  };
}

/** Дворы из участков посёлка: заборы каждого участка (общий — у обоих соседей). */
function plotYards(plan: EstatePlan): Yard[] {
  const fences = new Map<string, [Vec2, Vec2][]>();
  for (const run of plan.runs) {
    const segments = run.line.slice(1).map((b, i): [Vec2, Vec2] => [run.line[i]!, b]);
    for (const id of run.owners) fences.set(id, [...(fences.get(id) ?? []), ...segments]);
  }
  return plan.plots.map((plot) => plotYard(plot, fences.get(plot.id) ?? []));
}

/** 3D-сцена на three.js: загружает Base World и связывает инструменты со стором. */
export function CityViewer({ territory }: { territory: Territory }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [credit, setCredit] = useState<string>();

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const store = useAppStore.getState();
    let disposed = false;
    const owned: { destroy: () => void }[] = [];
    let city: CityScene | undefined;

    async function init() {
      store.setStatus('loading');
      const surveyOn = useAppStore.getState().surveyOn;
      const loaded = await loadHeights(territory, surveyOn);
      if (disposed) return;
      // Усиление рельефа (настройка «Рельеф ×k»): перепады от высоты центра района умножаются на k.
      const k = useAppStore.getState().reliefScale;
      const { south: s0, west: w0, north: n0, east: e0 } = territory.bbox;
      const h0 = loaded.heightAt((w0 + e0) / 2, (s0 + n0) / 2);
      const heights = k === 1 ? loaded : { ...loaded, heightAt: (lon: number, lat: number) => h0 + (loaded.heightAt(lon, lat) - h0) * k };
      store.setTerrain(heights.kind);
      setCredit(heights.credit);

      const { south, west, north, east } = territory.bbox;
      const village = territory.kind === 'village';
      // Локальные метры вокруг центра района: вся геометрия сцены, прогулка, редактор.
      const frame = createLocalFrame([(west + east) / 2, (south + north) / 2]);
      const [x0, y0] = frame.toLocal([west, south]);
      const [x1, y1] = frame.toLocal([east, north]);
      const area = { x0, y0, x1, y1 };
      // Рельеф: общий (и съёмка с дрона) плюс ручные правки кистью — их поле подставляется, когда загружены правки.
      const sculpt: { field: SculptField; strokes: readonly SculptStroke[] } = { field: new SculptField(), strokes: [] };
      /** Земля без ручных правок (кисть считает от неё). */
      const ground0 = (x: number, y: number) => heights.heightAt(...frame.toLonLat([x, y]));
      const localHeight = (x: number, y: number) => ground0(x, y) + sculpt.field.offsetAt(x, y);

      const c = new CityScene(container!, { lat: (south + north) / 2, lon: (west + east) / 2 });
      city = c;
      // В разработке — доступ к сцене и сторам из консоли (проверки, отладка).
      if (DEBUG) Object.assign(window, { __city: c, __stores: { app: useAppStore, edit: useEditStore } });
      c.setGroundSampler((x, z) => localHeight(x, -z));

      // Время суток — из стора; если «время идёт», сутки проходят за 6 минут.
      c.setTime(useAppStore.getState().timeOfDay);
      c.setHaze(useAppStore.getState().haze);
      c.setBlur(useAppStore.getState().blur);
      c.setOutlines(useAppStore.getState().outlines);
      let sinceSync = 0;
      owned.push({
        destroy: c.addAnimator((dt) => {
          const state = useAppStore.getState();
          if (!state.timeFlowing) return false;
          const hours = (c.time + dt * TIME_FLOW_HOURS_PER_SECOND) % 24;
          c.setTime(hours);
          sinceSync += dt;
          if (sinceSync > 0.25) {
            sinceSync = 0;
            state.setTimeOfDay(hours);
          }
          return true;
        }),
      });
      owned.push({
        destroy: useAppStore.subscribe((state, prev) => {
          if (state.timeOfDay !== prev.timeOfDay && Math.abs(state.timeOfDay - c.time) > 1e-4) c.setTime(state.timeOfDay);
          if (state.timeFlowing && !prev.timeFlowing) c.requestRender();
        }),
      });
      // Пересборка того же района (рельеф, съёмка, план) — камера остаётся, где была.
      const kept = keptView?.territory === territory.id ? keptView : undefined;
      keptView = undefined;
      if (kept) c.setView(kept.position, kept.target);
      else setIntroView(c, territory, frame, localHeight);
      store.setFlyHome(() => flyToTerritory(c, territory, frame, localHeight, 1.5));

      const [osmCollection, buildingParts, environment, surveyFile, parcelsFile] = await Promise.all([
        loadBaseBuildings(territory),
        loadBuildingParts(territory),
        loadEnvironment(territory),
        loadSurvey(territory),
        loadParcels(territory),
      ]);
      if (disposed) return;
      // Находки по съёмке с дрона: цвета домов и постройки, которых нет в OSM.
      const surveyApplied = surveyOn && surveyFile ? applySurvey(osmCollection, surveyFile) : undefined;
      const collection = surveyApplied?.collection ?? osmCollection;
      // Адреса из кадастра (НСПД): дому — адрес участка, на котором он стоит (в карточке здания и на табличке).
      const parcelIndex = parcelsFile ? new ParcelIndex(parcelsFile.parcels) : undefined;
      if (parcelsFile) setCredit([heights.credit, `участки и адреса ${parcelsFile.metadata.credit}`].filter(Boolean).join(' · '));
      if (parcelIndex) {
        for (const f of collection.features) {
          if (f.properties.address) continue;
          const ring = f.geometry.type === 'Polygon' ? f.geometry.coordinates[0] : f.geometry.coordinates[0]?.[0];
          if (!ring?.length) continue;
          const at: [number, number] = [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];
          const label = addressLabel(parcelIndex.at(at));
          if (label) f.properties.address = label;
        }
      }
      // Есть ли у района съёмка (даже если она сейчас выключена — чтобы её можно было включить).
      const hasSurvey = !!surveyFile || !!heights.detail || (!surveyOn && (await dataExists(territory, 'terrain-detail.json')));
      if (disposed) return;
      store.setSurvey(
        hasSurvey ? { terrain: !!heights.detail, colored: surveyApplied?.stats.colored ?? 0, added: surveyApplied?.stats.added ?? 0 } : undefined,
      );

      const buildingFootprints = collection.features.flatMap((f) => (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates));
      const localBuildings = buildingFootprints.map((rings) => toLocalPolygon(rings, frame));
      const roadSurfaces = environment.ground
        .filter((f) => f.properties.kind === 'road')
        .flatMap(polygonsOfGround)
        .map((rings) => toLocalPolygon(rings, frame));
      const markings = roadMarkings(environment.streets, frame, roadSurfaces);
      const bareGround = village ? VILLAGE_GROUND_COLOR : BARE_GROUND_COLOR;
      // «Моя версия» посёлка: земля нарезана на участки вплотную — заборы, ворота, постройки, сады.
      const estates = village && useAppStore.getState().villagePlan ? planEstates(estateInput(collection.features, environment, frame, parcelsFile?.parcels)) : undefined;
      if (DEBUG) Object.assign(window, { __estates: estates });
      // Деревня: дворы у домов — забор с воротами и огород за домом (в OSM участков нет).
      const yards: Yard[] = estates
        ? plotYards(estates)
        : village
          ? planYards(
              collection.features
                .filter((f) => VILLAGE_HOUSE_TYPES.has(f.properties.building))
                .flatMap((f) =>
                  (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates).map((rings, i) => ({
                    id: `${f.properties.id}:${i}`,
                    ring: (rings[0] ?? []).map(frame.toLocal),
                  })),
                ),
              environment.streets.roads.map((r) => ({ coords: r.coords.map(frame.toLocal), width: r.width })),
            )
          : [];
      /** Точка в палисаднике (с запасом): туда деревья двора не сажаем — у палисадника свой сад. */
      const inPalisade = (point: Vec2) =>
        yards.some(({ palisade: p }) => {
          if (!p) return false;
          const dx = point[0] - p.origin[0];
          const dy = point[1] - p.origin[1];
          const v = dx * p.toStreet[0] + dy * p.toStreet[1];
          const u = -dx * p.toStreet[1] + dy * p.toStreet[0];
          return Math.abs(u) <= p.width / 2 + 1 && v >= -1 && v <= p.depth + 1.5;
        });
      const parts = assignParts(collection.features, buildingParts);

      // Деревня из моделей: домам OSM подобраны башкирские дома (изба, пятистенок, вальмовый, кирпичный, баня)
      // по размеру контура и по тому, какой стороной дом стоит к улице. Дома из частей и сложные — как были.
      const roadLines = environment.streets.roads.map((r) => r.coords.map(frame.toLocal));
      const villageHouses: VillageHouse[] = village
        ? collection.features.flatMap((f) => {
            if (parts.byBuilding.get(f.properties.id)?.length) return [];
            if (f.geometry.type === 'MultiPolygon' && f.geometry.coordinates.length > 1) return [];
            const ring = f.geometry.type === 'Polygon' ? f.geometry.coordinates[0] : f.geometry.coordinates[0]?.[0];
            const house = ring && chooseVillageModel(f.properties.id, ring.map(frame.toLocal), roadLines, f.properties.building);
            // Цвета кровли и стен — из OSM или по съёмке с дрона (если есть).
            const roof = f.properties.roofColour;
            const wall = f.properties.colour;
            return house ? [roof || wall ? { ...house, colors: { roof, wall } } : house] : [];
          })
        : [];

      // Подробный рельеф (съёмка с дрона) — под жизнь деревни: двор — плоскостью по уклону, под дорогами и
      // тропинками — полотно, под домами и сараями — ровные площадки. Иначе бугры съёмки в пару десятков
      // сантиметров поднимают дома на высокий цоколь и делают дороги волнистыми.
      if (heights.detail) {
        if (estates) {
          // Участок выравнивается по уровню дома: опора — середина прямоугольника дома-модели.
          const houseAt = new Map(villageHouses.map((h) => [h.id, frame.toLonLat([h.rect.reduce((s, v) => s + v[0], 0) / h.rect.length, h.rect.reduce((s, v) => s + v[1], 0) / h.rect.length])]));
          heights.detail.flattenPlots(
            estates.plots.map((p) => p.ring.map(frame.toLonLat)),
            estates.plots.map((p) => houseAt.get(p.id)),
          );
        }
        else heights.detail.flattenYards(yards.map((y) => y.corners.map(frame.toLonLat)));
        heights.detail.flattenRoads([...environment.streets.roads, ...environment.streets.paths]);
        // Площадки — последними: дом у самой дороги не должен съезжать на её обочину.
        // Под домами-моделями — по прямоугольнику модели (он шире контура OSM), иначе край цоколя висит над склоном.
        const modelled = new Set(villageHouses.map((h) => h.id));
        heights.detail.flattenPads([
          ...collection.features
            .filter((f) => !modelled.has(f.properties.id))
            .flatMap((f) => (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates))
            .map((rings) => openRing(rings[0] ?? [])),
          ...villageHouses.map((h) => h.rect.map(frame.toLonLat)),
          ...(estates?.plots.flatMap((p) => p.outbuildings.map((b) => b.rect.map(frame.toLonLat))) ?? []),
        ]);
      }
      const gardens = estates
        ? estates.plots.flatMap((p) =>
            p.garden ? [{ ring: [...p.garden.ring, p.garden.ring[0]!].map(frame.toLonLat), rows: p.garden.rows, seed: p.seed, houseId: p.id }] : [],
          )
        : yards.flatMap((yard) =>
            yard.garden
              ? [{ ring: [...yard.garden.corners, yard.garden.corners[0]].map(frame.toLonLat), rows: yard.garden.rows, seed: yard.seed, houseId: yard.houseId }]
              : [],
          );
      // Подъезды от ворот во двор — утоптанной землёй.
      const yardDirt = (estates?.plots ?? []).flatMap((p) => (p.driveway ? [{ ring: [...p.driveway, p.driveway[0]!].map(frame.toLonLat), houseId: p.id }] : []));

      // Где есть подробный рельеф — густая сетка земли: шаг 2 м (до 2 км²) или 3 м.
      const coverage = heights.detail?.coverage;
      let detailRegion: { rect: { x0: number; y0: number; x1: number; y1: number }; subdivide: number } | undefined;
      if (coverage) {
        const [dx0, dy0] = frame.toLocal([coverage.west, coverage.south]);
        const [dx1, dy1] = frame.toLocal([coverage.east, coverage.north]);
        detailRegion = { rect: { x0: dx0, y0: dy0, x1: dx1, y1: dy1 }, subdivide: (dx1 - dx0) * (dy1 - dy0) <= 2e6 ? 3 : 2 };
      }
      // Правки места (и мазки кисти рельефа) — до постройки слоёв: всё встаёт на уже поправленную землю.
      // Опубликованные правки (одни для всех) и у редактора — его черновик поверх них.
      const publishedEdits = await fetchPublishedEdits(territoryDataUrl(territory, PUBLISHED_EDITS));
      if (disposed) return;
      useEditStore.getState().load(territory.id, publishedEdits);
      sculpt.strokes = useEditStore.getState().edits.terrain;
      if (sculpt.strokes.length) sculpt.field = replayStrokes(sculpt.strokes, frame.toLocal, ground0);
      const sculpted = { heightAt: (lon: number, lat: number) => heights.heightAt(lon, lat) + sculpt.field.offsetAt(...frame.toLocal([lon, lat])) };
      // Оси дорог: асфальт — улицы, грунтовки — проезды (track); по ним — колеи, заплатки, лужи.
      const roadAxes = [
        ...environment.streets.roads.map((r) => ({ coords: r.coords, width: r.width, kind: 'asphalt' as const })),
        ...environment.streets.paths.filter((p) => p.highway === 'track').map((p) => ({ coords: p.coords, width: p.width, kind: 'track' as const })),
      ];
      const ground = new GroundLayer(c, sculpted, frame, area, [...environment.ground, ...markings], gardens, bareGround, !village, c.csm, detailRegion, yardDirt, roadAxes);
      owned.push(ground);
      // Карта деревни (render.webp + render.json с рамкой в lon/lat) поверх земли — по кнопке «Карта» в редакторе.
      // Картинка большая: грузится при первом включении.
      let mapTexture: Promise<{ texture: Texture; rect: { x0: number; y0: number; x1: number; y1: number } } | undefined> | undefined;
      const loadMap = () =>
        (mapTexture ??= (async () => {
          try {
            const response = await fetch(territoryDataUrl(territory, 'render.json'));
            if (!response.ok || !(response.headers.get('content-type') ?? '').includes('json')) return undefined;
            const meta = (await response.json()) as { west: number; south: number; east: number; north: number };
            const texture = await new TextureLoader().loadAsync(territoryDataUrl(territory, 'render.webp'));
            texture.colorSpace = SRGBColorSpace;
            texture.anisotropy = c.renderer.capabilities.getMaxAnisotropy();
            const [x0, y0] = frame.toLocal([meta.west, meta.south]);
            const [x1, y1] = frame.toLocal([meta.east, meta.north]);
            owned.push({ destroy: () => texture.dispose() });
            return { texture, rect: { x0, y0, x1, y1 } };
          } catch (error) {
            console.warn('[map] карта деревни не загрузилась', error);
            return undefined;
          }
        })());
      const applyMap = async () => {
        const { mapOverlay, mapOpacity } = useAppStore.getState();
        const map = mapOverlay ? await loadMap() : undefined;
        if (disposed) return;
        ground.texture.setMapOverlay(useAppStore.getState().mapOverlay ? map?.texture : undefined, map?.rect ?? { x0: 0, y0: 0, x1: 1, y1: 1 }, mapOpacity);
        c.requestRender();
      };
      void applyMap();
      owned.push({
        destroy: useAppStore.subscribe((state, prev) => {
          if (state.mapOverlay !== prev.mapOverlay || state.mapOpacity !== prev.mapOpacity) void applyMap();
        }),
      });
      if (DEBUG) (window as unknown as { __ground?: GroundLayer }).__ground = ground;

      const landmarks = LANDMARKS.filter(({ position: [lon, lat] }) => lon >= west && lon <= east && lat >= south && lat <= north);
      const parkTrees = [
        ...environment.trees,
        ...scatterTrees(environment.ground, environment.trees, [...buildingFootprints, ...landmarks.map((l) => landmarkClearance(l))]),
        // В деревне деревья растут во дворах, а в OSM их там почти не отмечают (в палисадниках — свои деревца).
        // В обустроенном посёлке — сады участков (яблони, вишни) и берёзы у заборов.
        ...(estates
          ? estates.plots.flatMap((p) => p.trees.map((t, i): TreePoint => [...frame.toLonLat(t), 4 + ((p.seed >>> i) % 5) * 0.5]))
          : village
            ? scatterYardTrees(
                collection.features.flatMap((f) =>
                  (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates).map((rings, i) => ({ id: `${f.properties.id}:${i}`, rings })),
                ),
                environment.ground,
              ).filter(([lon, lat]) => !inPalisade(frame.toLocal([lon, lat])))
            : []),
      ];
      // Лесные массивы: упрощённые деревья, число ограничено.
      const forestTrees = scatterForest(environment.ground, buildingFootprints);
      const lamps = placeLamps(environment.streets, frame, roadSurfaces, localBuildings, village ? { spacing: 45, bothSides: false } : {});
      const benches = orientBenches(environment.streets, frame);
      // Витрины и вывески — только в городе.
      const streetFront = village ? new Set<string>() : findStreetFrontBuildings(collection.features, environment.ground, frame);

      const buildings = new BuildingsLayer(c, collection, parts, frame, localHeight, village, streetFront, c.csm);
      owned.push(buildings);
      // Школа и лицей из OSM — в своей форме, а на стене к улице — вход с крыльцом, вывеска и флаги.
      const publicTitles = new Map<string, string>();
      const publicDetails = new PublicDetailsLayer(
        c,
        collection.features.flatMap((f): PublicBuilding[] => {
          const { building, name, height, roofHeight } = f.properties;
          if (!PUBLIC_DETAIL_TYPES.has(building)) return [];
          const ring = f.geometry.type === 'Polygon' ? f.geometry.coordinates[0] : f.geometry.coordinates[0]?.[0];
          if (!ring || ring.length < 4) return [];
          const title = (name ?? (building === 'kindergarten' ? 'Детский сад' : 'Школа')).toUpperCase();
          publicTitles.set(f.properties.id, title);
          return [{ id: f.properties.id, ring: openRing(ring.map(frame.toLocal)), wallTop: height - (roofHeight ?? 0), title }];
        }),
        environment.streets.roads.map((r) => r.coords.map(frame.toLocal)),
        localHeight,
        c.csm,
      );
      owned.push(publicDetails);
      const details = new DetailsLayer(
        c,
        buildings.shapes(),
        // Заборы участков посёлка рисует EstateLayer.
        { frame, isStreetSide: nearNamedStreet(environment.ground, frame, 15), heightAt: localHeight, yards: estates ? [] : yards },
        c.csm,
      );
      owned.push(details);

      if (DEBUG) Object.assign(window, { __localHeight: localHeight, __villageHouses: villageHouses, __estates: estates, __sculpt: sculpt });
      const villageModels = villageHouses.length ? new VillageModelsLayer(c, frame, localHeight, villageHouses, c.csm) : undefined;
      if (villageModels) owned.push(villageModels);
      // Таблички с адресом — на домах-моделях, у которых участок с улицей и номером.
      const plates = parcelIndex
        ? villageHouses.flatMap((h): AddressPlate[] => {
            const center = frame.toLonLat([h.rect.reduce((s, p) => s + p[0], 0) / h.rect.length, h.rect.reduce((s, p) => s + p[1], 0) / h.rect.length]);
            const parcel = parcelIndex.at(center);
            return h.model !== 'banya' && parcel?.street && parcel.number ? [{ houseId: h.id, rect: h.rect, model: h.model, street: parcel.street, number: parcel.number }] : [];
          })
        : [];
      const addressPlates = plates.length ? new AddressPlatesLayer(c, plates, localHeight, c.csm) : undefined;
      if (addressPlates) owned.push(addressPlates);
      const modelIds = new Set(villageHouses.map((h) => h.id));
      const featureById = new Map(collection.features.map((f) => [f.properties.id, f]));
      /** Прямоугольники домов-моделей с запасом 1,5 м: деревья и фонари с них убираем. */
      const modelAreas = new Map(villageHouses.map((h) => [h.id, growRect(h.rect, 1.5).map(frame.toLonLat) as [number, number][]]));
      const villageModelsOn = () => !!villageModels && useAppStore.getState().villageModels;
      // Палисадники: от стены дома до забора по улице. У дома-модели фасад может стоять чуть иначе,
      // чем контур OSM, — палисадник тогда короче или длиннее.
      const frontGardens = yards.some((y) => y.palisade) ? new FrontGardensLayer(c, localHeight, c.csm) : undefined;
      if (frontGardens) owned.push(frontGardens);
      const villageHouseById = new Map(villageHouses.map((h) => [h.id, h]));
      /** Где дом стоял и где стоит сейчас (передвинутые и повёрнутые в редакторе): середина и угол фасада. */
      const houseFrame = (rect: readonly Vec2[]) => ({ center: centroidOf(rect.slice(0, 4)), angle: Math.atan2(rect[1]![1] - rect[0]![1], rect[1]![0] - rect[0]![0]) });
      const originalRect = (id: string): Vec2[] | undefined => {
        const model = villageHouseById.get(id);
        if (model) return model.rect;
        const f = featureById.get(id);
        const ring = f && (f.geometry.type === 'Polygon' ? f.geometry.coordinates[0] : f.geometry.coordinates[0]?.[0]);
        return ring ? openRing(ring).map(frame.toLocal) : undefined;
      };
      /** Передвинутые дома: id дома OSM → новый прямоугольник (локальные метры), модель, сдвиг и поворот. */
      const movedHouses = () => {
        const out = new Map<string, { rect: Vec2[]; model?: HouseModelId; from: ReturnType<typeof houseFrame>; to: ReturnType<typeof houseFrame> }>();
        for (const b of useEditStore.getState().edits.buildings) {
          if (!b.source || b.footprint.length < 3) continue;
          const before = originalRect(b.source);
          if (!before || before.length < 3) continue;
          const rect = b.footprint.map(frame.toLocal);
          const from = houseFrame(before);
          const to = houseFrame(rect);
          if (Math.hypot(to.center[0] - from.center[0], to.center[1] - from.center[1]) < 0.05 && Math.abs(Math.sin(to.angle - from.angle)) < 0.002) continue;
          out.set(b.source, { rect, ...(b.model ? { model: b.model.id } : {}), from, to });
        }
        return out;
      };
      const round7 = (v: number) => Math.round(v * 1e7) / 1e7;
      /** Палисадник двора с учётом передвинутого дома (перед — до уличного забора, если он рядом). */
      const palisadeOf = (houseId: string, palisade: NonNullable<Yard['palisade']>, moved: ReturnType<typeof movedHouses>, streets: readonly (readonly Vec2[])[]) => {
        const m = moved.get(houseId.slice(0, houseId.lastIndexOf(':')));
        return m ? movePalisade(palisade, m.from, m.to, streets) : palisade;
      };
      let gardensKey: string | undefined;
      const placeGardens = (models: boolean) => {
        if (!frontGardens) return;
        const moved = movedHouses();
        const plan = currentPlan?.();
        const key = `${models}|${[...moved].map(([id, m]) => `${id}:${m.rect.flat().map((v) => v.toFixed(2)).join(',')}`).join(';')}|${plan === estates ? '' : 'e'}`;
        if (key === gardensKey && !plan) return;
        gardensKey = key;
        const palisadeAt = new Map((plan ?? estates)?.plots.map((p) => [p.id, p.palisade]) ?? []);
        const sites: GardenSite[] = yards.flatMap((y) => {
          const own = plan ? palisadeAt.get(y.houseId) : y.palisade && palisadeOf(y.houseId, y.palisade, moved, []);
          if (!own) return [];
          const { origin, toStreet, width, depth } = own;
          const id = y.houseId.slice(0, y.houseId.lastIndexOf(':'));
          const m = moved.get(id);
          const base = models ? villageHouseById.get(id) : undefined;
          // Передвинутый дом-модель — по его новому прямоугольнику.
          const house = base && m ? { ...base, rect: m.rect, model: (m.model ?? base.model) as VillageHouse['model'] } : base;
          const shift = house ? modelFacadeShift(house, origin, toStreet) : 0;
          // Сдвигаем начало палисадника к стене модели — штакетник по улице остаётся на месте.
          const at: Vec2 = [origin[0] + toStreet[0] * shift, origin[1] + toStreet[1] * shift];
          return [{ owner: y.houseId, origin: at, toStreet, width, depth: depth - shift, seed: y.seed }];
        });
        const sitesKey = JSON.stringify(sites);
        if (sitesKey === lastSites) return;
        lastSites = sitesKey;
        frontGardens.setSites(sites);
      };
      let lastSites = '';
      /** План участков с правками (заборы, ворота, палисадники передвинутых домов); задаётся ниже, с редактором. */
      let currentPlan: (() => EstatePlan | undefined) | undefined;
      placeGardens(villageModelsOn());
      if (DEBUG) Object.assign(window, { __gardens: frontGardens });
      const applyVillageModels = () => {
        placeGardens(villageModelsOn());
        if (!villageModels) return;
        const on = villageModelsOn();
        villageModels.setVisible(on && !useUnderlayStore.getState().hideCity);
        addressPlates?.setVisible(on && !useUnderlayStore.getState().hideCity);
        buildings.setReplaced(on ? modelIds : new Set());
        details.setReplaced(on ? modelIds : new Set());
      };
      applyVillageModels();
      if (DEBUG) Object.assign(window, { __village: villageModels });

      // Посёлок «моя версия»: заборы, ворота и мелочь дворов; постройки дворов — моделями (всегда, а не только
      // когда дома OSM нарисованы моделями).
      const estateLayer = estates ? new EstateLayer(c, localHeight, c.csm, estates) : undefined;
      if (estateLayer) owned.push(estateLayer);
      const estateHouses: VillageHouse[] = (estates?.plots ?? []).flatMap((p) =>
        p.outbuildings.map((b) => ({
          id: b.id,
          model: b.model,
          seed: b.seed,
          rect: b.rect,
        })),
      );
      const estateModels = estateHouses.length ? new VillageModelsLayer(c, frame, localHeight, estateHouses, c.csm, 60) : undefined;
      if (estateModels) owned.push(estateModels);
      const outbuildingsOf = new Map((estates?.plots ?? []).map((p) => [p.id, p.outbuildings.map((b) => b.id)]));
      if (DEBUG)
        Object.assign(window, {
          __estateLayer: estateLayer,
          __estateModels: estateModels,
        });

      const trees = new TreesLayer(c, [...parkTrees, ...forestTrees], parkTrees.length, frame, localHeight, c.csm);
      // Деревья по карте (снимку с дрона) — своим слоем: режим пышности меняют на временной панели, чтобы сравнить.
      const mapTrees: { layer?: TreesLayer; mode?: MapTreesMode; published?: { detailed: number; trees: TreePoint[] }; pixels?: Promise<{ rgba: Uint8ClampedArray; w: number; h: number; meta: { west: number; south: number; east: number; north: number } } | undefined>; blocked?: (x: number, y: number) => boolean } = {};
      /** Опубликованные деревья по карте: { detailed, trees: [lon, lat, высота][] }. */
      const fetchMapTrees = async (): Promise<{ detailed: number; trees: TreePoint[] } | undefined> => {
        try {
          const response = await fetch(territoryDataUrl(territory, PUBLISHED_MAP_TREES), { cache: 'no-cache' });
          if (!response.ok || !(response.headers.get('content-type') ?? '').includes('json')) return undefined;
          const data = (await response.json()) as { detailed?: number; trees?: unknown };
          const trees = (Array.isArray(data.trees) ? data.trees : []).filter(
            (t): t is TreePoint => Array.isArray(t) && t.length === 3 && t.every((n) => typeof n === 'number' && Number.isFinite(n)),
          );
          return { detailed: Math.min(trees.length, Math.max(0, Number(data.detailed) || 0)), trees };
        } catch {
          return undefined;
        }
      };
      const loadMapPixels = () =>
        (mapTrees.pixels ??= (async () => {
          try {
            const response = await fetch(territoryDataUrl(territory, 'render.json'));
            if (!response.ok || !(response.headers.get('content-type') ?? '').includes('json')) return undefined;
            const meta = (await response.json()) as { west: number; south: number; east: number; north: number };
            const blob = await (await fetch(territoryDataUrl(territory, 'render.webp'))).blob();
            const image = await createImageBitmap(blob);
            // Вдвое мельче (≈1,4 м на пиксель): кроны видны, а считать вчетверо быстрее.
            const w = Math.round(image.width / 2);
            const h = Math.round(image.height / 2);
            const canvas = new OffscreenCanvas(w, h);
            const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
            ctx.drawImage(image, 0, 0, w, h);
            image.close();
            return { rgba: ctx.getImageData(0, 0, w, h).data, w, h, meta };
          } catch (error) {
            console.warn('[map-trees] карта не загрузилась', error);
            return undefined;
          }
        })());
      /** Куда деревья по карте не сажаем: дома и постройки, дороги и тропы, уже стоящие деревья, леса OSM, даль. */
      const mapTreesBlocked = () => {
        if (mapTrees.blocked) return mapTrees.blocked;
        const grid = new BlockedGrid(1.5);
        for (const rings of buildingFootprints) grid.polygon(openRing(rings[0] ?? []).map(frame.toLocal), 2);
        for (const h of villageHouses) grid.polygon(h.rect, 1.5);
        for (const h of estateHouses) grid.polygon(h.rect, 1);
        for (const r of environment.streets.roads) grid.line(r.coords.map(frame.toLocal), r.width / 2 + 1.5);
        for (const p of environment.streets.paths) grid.line(p.coords.map(frame.toLocal), p.width / 2 + 1);
        for (const [lon, lat] of parkTrees) grid.circle(...frame.toLocal([lon, lat]), 3);
        const woods = environment.ground
          .filter((f) => f.properties.kind === 'green' && f.properties.cover === 'wood')
          .flatMap(polygonsOfGround)
          .map((rings) => {
            const ring = (rings[0] ?? []).map(frame.toLocal);
            const xs = ring.map((p) => p[0]);
            const ys = ring.map((p) => p[1]);
            return { ring, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] as const };
          });
        // Сажаем вокруг деревни: в прямоугольнике домов с запасом 300 м.
        const hx = villageHouses.flatMap((h) => h.rect.map((p) => p[0]));
        const hy = villageHouses.flatMap((h) => h.rect.map((p) => p[1]));
        const region = hx.length ? [Math.min(...hx) - 300, Math.min(...hy) - 300, Math.max(...hx) + 300, Math.max(...hy) + 300] : [-Infinity, -Infinity, Infinity, Infinity];
        mapTrees.blocked = (x, y) =>
          x < region[0]! || y < region[1]! || x > region[2]! || y > region[3]! || grid.has(x, y) || woods.some((w) => x >= w.box[0] && x <= w.box[2] && y >= w.box[1] && y <= w.box[3] && insideRing(x, y, w.ring));
        return mapTrees.blocked;
      };
      const applyMapTrees = async () => {
        const mode = useAppStore.getState().mapTrees;
        if (mode === mapTrees.mode) return;
        mapTrees.mode = mode;
        mapTrees.layer?.destroy();
        mapTrees.layer = undefined;
        if (mode === 'off') {
          store.setMapTreesCount(undefined);
          c.requestRender();
          return;
        }
        store.setMapTreesCount(undefined);
        // Зритель: деревья — из опубликованного файла (снимка с дрона на сайте нет).
        if (!CAN_EDIT) {
          const published = await fetchMapTrees();
          if (disposed || mapTrees.mode !== mode) return;
          if (!published) return store.setMapTreesCount(0);
          mapTrees.layer = new TreesLayer(c, published.trees, published.detailed, frame, localHeight, c.csm);
          mapTrees.layer.setWinter(useAppStore.getState().season === 'winter');
          store.setMapTreesCount(published.trees.length);
          refreshObstacles();
          c.requestRender();
          return;
        }
        const map = await loadMapPixels();
        if (disposed || mapTrees.mode !== mode) return;
        if (!map) return store.setMapTreesCount(0);
        const { rgba, w, h, meta } = map;
        const blocked = mapTreesBlocked();
        const lonPer = (meta.east - meta.west) / w;
        const latPer = (meta.north - meta.south) / h;
        const pixel = latPer * 110_574;
        const { spacing, cover } = MAP_TREE_MODES[mode];
        const spots = findTreeSpots(rgba, w, h, (px, py) => frame.toLocal([meta.west + (px + 0.5) * lonPer, meta.north - (py + 0.5) * latPer]), {
          spacing,
          cover,
          pixel,
          allowed: (x, y) => !blocked(x, y),
        });
        // У домов — подробные деревья, дальше — лесные (упрощённые): первыми идут ближние к домам.
        const near = villageHouses.length ? new BlockedGrid(20) : undefined;
        for (const v of villageHouses) near?.circle(v.rect[0]![0], v.rect[0]![1], 60);
        const ordered = [...spots.filter(([x, y]) => near?.has(x, y)), ...spots.filter(([x, y]) => !near?.has(x, y))];
        const detailed = spots.filter(([x, y]) => near?.has(x, y)).length;
        const points: TreePoint[] = ordered.map(([x, y, height]) => [...frame.toLonLat([x, y]), height]);
        mapTrees.layer = new TreesLayer(c, points, detailed, frame, localHeight, c.csm);
        mapTrees.layer.setWinter(useAppStore.getState().season === 'winter');
        // Для «Опубликовать»: эти же деревья — в файл, зритель возьмёт их оттуда.
        mapTrees.published = { detailed, trees: points.map(([lon, lat, height]): TreePoint => [round7(lon), round7(lat), Math.round(height * 10) / 10]) };
        store.setMapTreesCount(points.length);
        refreshObstacles();
        c.requestRender();
      };
      owned.push({ destroy: () => mapTrees.layer?.destroy() });
      owned.push({
        destroy: useAppStore.subscribe((state, prev) => {
          if (state.mapTrees !== prev.mapTrees) void applyMapTrees();
        }),
      });
      owned.push(trees);
      const furniture = new FurnitureLayer(c, lamps, benches, frame, localHeight, c.csm);
      owned.push(furniture);
      // Трава у ног: только на зелёном покрытии земли, цвет — от него же.
      const grass = new GrassLayer(c, localHeight, ground.texture.landLevels, c.csm, useAppStore.getState().graphicsQuality === 'high' ? 'high' : 'normal');
      // Зимой травы нет — снег.
      const grassWanted = () => useAppStore.getState().grassOn && useAppStore.getState().season !== 'winter';
      grass.setEnabled(grassWanted());
      owned.push(grass);
      owned.push({
        destroy: useAppStore.subscribe((state, prev) => {
          if (state.grassOn !== prev.grassOn || state.season !== prev.season) grass.setEnabled(grassWanted());
          if (state.graphicsQuality !== prev.graphicsQuality) grass.setDensity(state.graphicsQuality === 'high' ? 'high' : 'normal');
        }),
      });
      // Зима: снег, зимнее солнце, голые лиственные деревья, снегопад, гирлянды на домах и ёлка.
      const snowfall = new SnowfallLayer(c, (x, z) => localHeight(x, -z));
      owned.push(snowfall);
      const garlands = new GarlandsLayer(c, localHeight, c.csm);
      owned.push(garlands);
      let garlandsKey = '';
      /** Место для ёлки: у главной дороги в середине деревни, на свободной земле. */
      const treeSpot = (() => {
        if (!village || !villageHouses.length) return undefined;
        const cx = villageHouses.reduce((s, h) => s + h.rect[0]![0], 0) / villageHouses.length;
        const cy = villageHouses.reduce((s, h) => s + h.rect[0]![1], 0) / villageHouses.length;
        const blocked = new BlockedGrid(1.5);
        for (const rings of buildingFootprints) blocked.polygon(openRing(rings[0] ?? []).map(frame.toLocal), 3);
        for (const h of villageHouses) blocked.polygon(h.rect, 3);
        for (const r of environment.streets.roads) blocked.line(r.coords.map(frame.toLocal), r.width / 2 + 2);
        let best: { p: Vec2; d: number } | undefined;
        for (const r of environment.streets.roads) {
          const line = r.coords.map(frame.toLocal);
          for (let k = 1; k < line.length; k++) {
            const [ax, ay] = line[k - 1]!;
            const [bx, by] = line[k]!;
            const len = Math.hypot(bx - ax, by - ay) || 1;
            const nx = -(by - ay) / len;
            const ny = (bx - ax) / len;
            for (let t = 0; t <= 1; t += 0.25) {
              for (const side of [1, -1]) {
                const p: Vec2 = [ax + (bx - ax) * t + nx * side * (r.width / 2 + 7), ay + (by - ay) * t + ny * side * (r.width / 2 + 7)];
                if (blocked.has(p[0], p[1])) continue;
                const d = Math.hypot(p[0] - cx, p[1] - cy);
                if (!best || d < best.d) best = { p, d };
              }
            }
          }
        }
        return best?.p;
      })();
      /** Гирлянды — на домах, какими их видно сейчас: дома-модели и изменённые в редакторе (с моделью). */
      const refreshGarlands = () => {
        if (useAppStore.getState().season !== 'winter') return;
        const { edits } = useEditStore.getState();
        const replaced = replacedOsmIds(edits);
        const houses: GarlandHouse[] = [
          ...(villageModelsOn() ? villageHouses.filter((h) => !replaced.has(h.id)) : []),
          ...edits.buildings.flatMap((b) => (b.model && b.footprint.length === 4 ? [{ rect: b.footprint.map(frame.toLocal), model: b.model.id, seed: b.model.seed }] : [])),
        ];
        const key = JSON.stringify(houses.map((h) => [h.model, h.seed, h.rect.flat().map((v) => v.toFixed(2))]));
        if (key === garlandsKey) return;
        garlandsKey = key;
        garlands.build(houses, treeSpot);
      };
      const applySeason = () => {
        const winter = useAppStore.getState().season === 'winter';
        c.setSeason(winter);
        trees.setWinter(winter);
        mapTrees.layer?.setWinter(winter);
        snowfall.setEnabled(winter);
        refreshGarlands();
        garlands.setVisible(winter);
      };
      owned.push({
        destroy: useAppStore.subscribe((state, prev) => {
          if (state.season !== prev.season) applySeason();
        }),
      });
      ground.setLamps(furniture.lampSpots());
      const monuments = await LandmarksLayer.create(c, landmarks, frame, localHeight, c.csm);
      owned.push(monuments);
      if (disposed) return;
      store.setStats(computeStats(collection));

      // Пьедесталы памятников мешают проходу так же, как здания.
      const outbuildingObstacles: BaseBuildingFeature[] = estateHouses.map((h) => {
        const ring = h.rect.map(frame.toLonLat);
        return {
          type: 'Feature',
          id: h.id,
          properties: {
            id: h.id,
            building: 'shed',
            height: h.model === 'outhouse' || h.model === 'well' ? 2.2 : 3,
            minHeight: 0,
            heightSource: 'default',
          },
          geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]!]] },
        };
      });
      const obstacles = [...collection.features, ...outbuildingObstacles, ...landmarks.map(landmarkObstacle)];
      const collider = new Collider(obstacles, frame);
      // Машине — свой «толстый» коллайдер: кузов — три круга радиусом почти в полмашины.
      const carCollider = new Collider(obstacles, frame, { radius: CAR.collisionRadius, walkUnderHeight: 2.6, maxStep: 0.5 });

      // Здания пользователя (User World) — отдельным слоем поверх Base World.
      const userLayer = new UserBuildingsLayer(c, frame, localHeight);
      owned.push(userLayer);
      const userObstacles = () => useAppStore.getState().userBuildings.map(toObstacle);

      // Участок: инструмент рисует, проверка идёт против Base World и уже построенного, результат — в стор.
      const plotTool = new PlotTool(c, frame, localHeight, {
        onChange: (points) => store.setPlotDraft(points),
        onFinish: (points) => {
          const plot = analyzePlot(points, [...obstacles, ...userObstacles()], territory.bbox);
          buildings.setConflicts(plot.conflictingBuildingIds);
          plotTool.showResult(plot.valid);
          store.plotFinished(plot);
        },
        onCancel: () => store.plotDrawingCancelled(),
      });
      owned.push(plotTool);
      store.setPlotControls({
        start: () => {
          buildings.setConflicts([]);
          plotTool.start();
          store.plotDrawingStarted();
        },
        finish: () => plotTool.finish(),
        undo: () => plotTool.undo(),
        cancel: () => plotTool.cancel(),
        clear: () => {
          plotTool.reset();
          buildings.setConflicts([]);
          store.plotCleared();
        },
      });

      /** Препятствия и скрытие деревьев/фонарей: здания из конструктора + свои дома + новые и убранные дороги. */
      const refreshObstacles = () => {
        const { edits } = useEditStore.getState();
        const { userBuildings, builder } = useAppStore.getState();
        const preview = builder?.result.building;
        for (const c of [collider, carCollider]) {
          c.setIgnored(new Set(edits.removedBuildings));
          // Поле и площадки — не стены: по ним ходят (сетки и заборчики — не помеха для прогулки).
          c.setExtraObstacles([...userBuildings.map(toObstacle), ...edits.buildings.filter((b) => !b.model || findHouseModel(b.model.id)?.group !== 'leisure').map(toFeature)]);
        }
        const footprints = [
          ...userBuildings.map((b) => b.building.footprint),
          ...(preview ? [preview.footprint] : []),
          ...edits.buildings.map((b) => b.footprint),
        ];
        // Новые дороги: полоса проезжей части — деревья и фонари с неё убираем.
        const newRoads = edits.roads.flatMap((r) => {
          const strip = buffer(lineString(r.axis), roadWidth(r) / 2 + 0.5, { units: 'meters', steps: 4 })?.geometry;
          if (!strip) return [];
          return strip.type === 'Polygon' ? [strip.coordinates[0] as [number, number][]] : strip.coordinates.map((p) => p[0] as [number, number][]);
        });
        // Дома-модели (кроме изменённых правками — их контур уже в footprints).
        const replaced = replacedOsmIds(edits);
        const modelRects = villageModelsOn() ? [...modelAreas].filter(([id]) => !replaced.has(id)).map(([, area]) => area) : [];
        trees.hideWithin([...footprints, ...newRoads], 2, modelRects);
        mapTrees.layer?.hideWithin([...footprints, ...newRoads], 2, modelRects);
        // Фонари у убранных дорог тоже уходят: проезжая часть + отступ фонаря от бордюра.
        const removedRoads = edits.removedRoads.flatMap((key) => ground.roadOutline(key).map((rings) => rings[0] ?? []));
        if (furniture.hideWithin([...footprints, ...newRoads, ...removedRoads], 2, modelRects)) ground.setLamps(furniture.lampSpots());
      };

      // Камера над городом: мышь как в стройках, WASD/QE/RF, двойной клик — подлёт. На прогулке выключено.
      const overview = new OverviewControls(c, (x, z) => localHeight(x, -z), () => !isOnStreet(useAppStore.getState().mode));
      owned.push(overview);

      // Звук: музыка и звуки города по месту, где сейчас камера или пешеход.
      const soundscape = new Soundscape(new SoundZones(environment.ground, frame, village), () => {
        const p = c.camera.position;
        return { point: [p.x, -p.z] as Vec2, altitude: p.y - localHeight(p.x, -p.z) };
      });
      soundscape.setEnabled(useAppStore.getState().soundOn);
      soundscape.setVolumes(useAppStore.getState().volumes);
      owned.push(soundscape);

      // Прогулка: столкновения со зданиями и памятниками, названия улиц, шаги.
      const streetIndex = new StreetIndex(environment.ground, frame);
      const walk = new WalkController(c, frame, collider, streetIndex, localHeight, {
        onExit: () => store.setMode('explore'),
        onStreet: (street) => store.setWalkStreet(street),
        onMove: (distance, running, position) => soundscape.walked(distance, running, position),
        onMouseLock: (locked) => store.setWalkMouseLocked(locked),
      });
      owned.push(walk);

      // Поездка: машина на ближайшей дороге (OSM и нарисованные в редакторе), свой коллайдер, звук мотора.
      // Просёлки (highway=track) — тоже дороги для машины: в деревне по ним ездят к полям и на окраины.
      const osmRoadLines: RoadLine[] = [
        ...environment.streets.roads.map((r) => ({ coords: r.coords.map(frame.toLocal), width: r.width, oneway: r.oneway })),
        ...environment.streets.paths.filter((p) => p.highway === 'track').map((p) => ({ coords: p.coords.map(frame.toLocal), width: p.width })),
      ];
      const roadsForCar = (): RoadLine[] => [
        ...osmRoadLines,
        ...useEditStore
          .getState()
          .edits.roads.filter((r) => r.kind !== 'path')
          .map((r) => ({ coords: r.axis.map(frame.toLocal), width: roadWidth(r) })),
      ];
      const drive = new DriveController(c, carCollider, streetIndex, localHeight, (point) => soundscape.surfaceAt(point), roadsForCar, c.csm, {
        onExit: () => store.setMode('explore'),
        onStreet: (street) => store.setWalkStreet(street),
        onHud: (hud) => store.setDriveHud(hud),
        onView: (view) => store.setDriveView(view),
        onSound: (sound) => soundscape.drove(sound),
        onBump: (strength) => soundscape.bumped(strength),
      });
      drive.setColor(useAppStore.getState().carColor);
      owned.push(drive);
      if (DEBUG) Object.assign(window, { __drive: drive, __walk: walk, __roads: roadsForCar, __frame: frame });
      store.setDriveControls({
        toggleView: () => drive.toggleView(),
        backToRoad: () => drive.backToRoad(),
        setTouch: (throttle, steer) => drive.setTouch(throttle, steer),
      });
      owned.push({ destroy: () => store.setDriveControls(undefined) });

      // Мини-карта: план района, повёрнутый по курсу пешехода или машины.
      const minimapBase = new MinimapBase(environment.ground, collection.features, frame, village);
      store.setMinimap({
        draw: (ctx, size, dpr, zoom) => {
          const driving = drive.isDriving;
          const pose = driving ? drive.pose() : walk.pose();
          const marker = driving ? 'car' : 'walker';
          minimapBase.draw(ctx, Math.round(size * dpr), { center: pose.position, heading: pose.heading, radius: minimapRadius(marker, pose.speed, zoom), marker });
        },
      });
      owned.push({ destroy: () => store.setMinimap(undefined) });

      // Подложка: свой снимок сверху (или ортофото), по которому обводят дома и заборы.
      const underlay = new UnderlayLayer(c, ground, frame, {
        setCameraEnabled: (enabled) => overview.setEnabled(enabled),
        pickables: () => [...buildings.pickables, ...userLayer.pickables],
      });
      owned.push(underlay);
      void useUnderlayStore.getState().load(territory.id);
      // При обводке дома и деревья OSM можно спрятать — снимок под ними станет виден.
      const showCity = (show: boolean) => {
        buildings.setVisible(show);
        publicDetails.setVisible(show);
        details.setVisible(show);
        frontGardens?.setVisible(show);
        estateLayer?.setVisible(show);
        estateModels?.setVisible(show);
        trees.setVisible(show);
        applyVillageModels();
      };
      const unsubscribeUnderlay = useUnderlayStore.subscribe((state, prev) => {
        if (state.hideCity !== prev.hideCity) showCity(!state.hideCity);
      });
      owned.push({ destroy: unsubscribeUnderlay });

      // Редактор: свои и изменённые дома, дороги и заборы поверх Base World (как в градостроителях).
      const editStore = useEditStore.getState();
      const editLayer = new EditLayer(c, frame, localHeight, village);
      owned.push(editLayer);
      // Участки посёлка с правками заборов (точки) и ворот (место на заборе): пересчёт — только когда они меняются.
      const runKeyList = estates?.runs.map(runKey) ?? [];
      let planCache: { fences: unknown; gates: unknown; buildings: unknown; props: unknown; plan: EstatePlan } | undefined;
      currentPlan = (): EstatePlan | undefined => {
        if (!estates) return undefined;
        const { estateFences, gates, buildings: editedBuildings, props } = useEditStore.getState().edits;
        if (planCache?.fences === estateFences && planCache.gates === gates && planCache.buildings === editedBuildings && planCache.props === props) return planCache.plan;
        // Палисадники передвинутых домов — вместе с домом.
        const moved = movedHouses();
        const palisades = new Map<string, Palisade>();
        for (const p of estates.plots) {
          if (!p.palisade || !moved.size) continue;
          const id = p.id.slice(0, p.id.lastIndexOf(':'));
          if (!moved.has(id)) continue;
          const streets = estates.runs.filter((r) => r.kind === 'street' && r.owners.includes(p.id)).map((r) => r.line);
          palisades.set(p.id, palisadeOf(p.id, p.palisade, moved, streets));
        }
        const known = new Set(runKeyList);
        const mine = estateFences.filter((f) => known.has(f.key));
        const plan = editPlan(estates, {
          lines: new Map(mine.flatMap((f) => (f.line ? [[f.key, f.line.map(frame.toLocal)] as const] : []))),
          gates: new Map(gates.flatMap((g) => (g.at ? [[g.plot, frame.toLocal(g.at)] as const] : []))),
          looks: new Map(mine.map((f) => [f.key, { style: f.style, height: f.height, color: f.color }])),
          gateOptions: new Map(gates.map((g) => [g.plot, { wicketSide: g.wicketSide, canopy: g.canopy, gate: g.gate, wicket: g.wicket }])),
          palisades,
          props: new Map(props.map((q) => [q.key, { ...(q.at ? { at: frame.toLocal(q.at) } : {}), angle: q.angle, removed: q.removed }])),
        });
        planCache = { fences: estateFences, gates, buildings: editedBuildings, props, plan };
        return plan;
      };
      const editor = new EditorTool({
        city: c,
        frame,
        base: buildings,
        layer: editLayer,
        ground,
        controls: overview,
        village,
        osmRoads: roadLines,
        osmBuildings: collection.features,
        yards,
        models: villageModels,
        yardModels: estateModels,
        ...(estates ? { estate: { base: estates, plan: () => currentPlan!()! } } : {}),
      });
      owned.push(editor);
      editStore.setFenceTools({
        edited: (id) => editor.fenceEdited(id),
        reset: (id) => editor.resetFence(id),
        info: (id) => editor.fenceInfo(id),
        setLook: (id, target, look) => editor.setFenceLook(id, target, look),
        setGate: (id, patch) => editor.setGateOption(id, patch),
      });
      editStore.setPropTools({ info: (key) => editor.propInfo(key), rotate: (key, delta) => editor.rotateProp(key, delta) });
      // «Опубликовать»: правки и деревья по карте — в файлы данных района (пишет локальный сервер разработки).
      if (CAN_EDIT)
        editStore.setPublisher(async () => {
          const response = await fetch(PUBLISH_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              territory: territory.id,
              edits: useEditStore.getState().edits,
              mapTrees: mapTrees.published,
              // Вид, в котором редактор видит деревню (перепады, слои), — сайт покажет её так же.
              view: (({ reliefScale, surveyOn, villagePlan, villageModels, grassOn, timeOfDay, timeFlowing, graphicsQuality, haze, blur, outlines }) => ({
                reliefScale,
                surveyOn,
                villagePlan,
                villageModels,
                grassOn,
                timeOfDay: Math.round(timeOfDay * 100) / 100,
                timeFlowing,
                graphicsQuality,
                haze,
                blur,
                outlines,
              }))(useAppStore.getState()),
            }),
          });
          const result = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; files?: string[] };
          if (!response.ok || !result.ok) throw new Error(result.error ?? `сервер ответил ${response.status}`);
          useEditStore.getState().markPublished();
          return result.files ?? [];
        });

      // Кисть рельефа: земля и всё, что на ней, меняются по ходу мазка; мазок — в правки (отмена — Ctrl+Z).
      const groundFollowers: ({ shiftGround: (delta: GroundDelta, area: GroundArea) => void } | undefined)[] = [
        buildings,
        publicDetails,
        details,
        villageModels,
        addressPlates,
        estateModels,
        estateLayer,
        frontGardens,
        trees,
        furniture,
        grass,
        { shiftGround: (delta, area) => mapTrees.layer?.shiftGround(delta, area) },
        garlands,
      ];
      const followGround = (change: SculptChange) => {
        const changed = changeRect(change);
        ground.refreshTerrain(changed);
        const delta = (x: number, y: number) => changeAt(change, x, y);
        for (const layer of groundFollowers) layer?.shiftGround(delta, changed);
        c.requestRender();
      };
      const brush = new TerrainBrush({
        city: c,
        controls: overview,
        heightAt: localHeight,
        toLonLat: frame.toLonLat,
        onDab: (b, center) => followGround(sculpt.field.dab(b, center, ground0)),
        onArea: (b, polygon) => followGround(sculpt.field.area(b, polygon, ground0)),
        onStroke: (stroke) => {
          const { edits, commit } = useEditStore.getState();
          const next = addStroke(edits, stroke);
          sculpt.strokes = next.terrain;
          commit(next);
        },
      });
      owned.push(brush);
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
      editStore.setResolver((id) => editor.resolve(id));
      editStore.setModelApplier((b, model) => editor.applyModel(b, model));

      /** Правки → сцена: что скрыть из OSM, что дорисовать, кто мешает пешеходу. */
      const applyEdits = () => {
        syncTerrain();
        const { edits, selection } = useEditStore.getState();
        const removed = new Set(edits.removedBuildings);
        // Удалённые (а не сдвинутые или перестроенные) дома уходят вместе с двором и огородом.
        const replaced = new Set(edits.buildings.map((b) => b.source).filter((s): s is string => !!s));
        const deleted = new Set([...removed].filter((id) => !replaced.has(id)));
        buildings.setHidden(removed);
        publicDetails.setHidden(removed);
        // Изменённая копия школы (своя форма, без модели дома) — детали по её контуру.
        publicDetails.setEdited(
          edits.buildings.flatMap((b): PublicBuilding[] => {
            const title = b.source && !b.model ? publicTitles.get(b.source) : undefined;
            return title ? [{ id: b.id, ring: openRing(b.footprint.map(frame.toLocal)), wallTop: wallHeightOf(b, village), title }] : [];
          }),
        );
        details.setHidden(removed, new Set(edits.removedYards), deleted);
        frontGardens?.setHidden(new Set(edits.removedYards), deleted);
        villageModels?.setHidden(replacedOsmIds(edits));
        addressPlates?.setHidden(replacedOsmIds(edits));
        const yardOwner = (houseId: string) => houseId.slice(0, houseId.lastIndexOf(':'));
        const hiddenYards = new Set([...edits.removedYards, ...yards.filter((y) => deleted.has(yardOwner(y.houseId))).map((y) => y.houseId)]);
        ground.setEdits({
          removedRoads: new Set(edits.removedRoads),
          addedRoads: edits.roads.map((r) => ({ kind: r.kind, axis: r.axis, width: r.width })),
          hiddenGardens: hiddenYards,
        });
        const plan = currentPlan?.();
        if (plan) estateLayer?.setPlan(plan);
        placeGardens(villageModelsOn());
        estateLayer?.setHidden(hiddenYards);
        // Постройки убранных дворов и постройки, передвинутые или убранные в редакторе.
        estateModels?.setHidden(new Set([...[...hiddenYards].flatMap((id) => outbuildingsOf.get(id) ?? []), ...replacedOsmIds(edits)]));
        editLayer.render(edits, selection?.type === 'building' ? selection.id : undefined);
        refreshObstacles();
        refreshGarlands();
        showSelection();
      };

      /** Выделение в редакторе: ручки у дома, подсветка дороги или забора. */
      const showSelection = () => {
        const { selection, edits } = useEditStore.getState();
        const own = selection?.type === 'building' ? edits.buildings.find((b) => b.id === selection.id) : undefined;
        if (selection?.type === 'building') {
          const resolved = own ?? editor.resolve(selection.id);
          buildings.select(own ? undefined : selection.id);
          editLayer.setHandles(resolved);
        } else {
          buildings.select(useAppStore.getState().selectedBuilding?.id);
          editLayer.setHandles(undefined);
        }
        let lines: [number, number][][] = [];
        if (selection?.type !== 'fence') editor.showFence();
        if (selection?.type === 'road') {
          const road = edits.roads.find((r) => r.id === selection.id);
          lines = road ? [road.axis] : ground.roadOutline(selection.id).map((rings) => rings[0] ?? []);
        } else if (selection?.type === 'prop' && editor.showProp()) {
          return;
        } else if (selection?.type === 'fence' && editor.showFence()) {
          // Свой забор и забор участка — с ручками: подсветку рисует редактор.
          return;
        } else if (selection?.type === 'fence') {
          const fence = edits.fences.find((f) => f.id === selection.id);
          const yard = yards.find((y) => y.houseId === selection.id);
          lines = fence ? [fence.line] : (yard?.fence ?? []).map((segment) => segment.map(frame.toLonLat));
        }
        editLayer.highlight(lines);
      };
      applyEdits();
      applySeason();
      void applyMapTrees();
      const unsubscribeEdits = useEditStore.subscribe((state, prev) => {
        if (state.edits !== prev.edits) applyEdits();
        else if (state.selection !== prev.selection) {
          editLayer.render(state.edits, state.selection?.type === 'building' ? state.selection.id : undefined);
          showSelection();
        }
        if (state.tool !== prev.tool || state.fenceDraw !== prev.fenceDraw || state.roadDraw !== prev.roadDraw) editor.cancelDraft();
        if (state.tool !== prev.tool) {
          c.canvas.style.cursor = state.tool && state.tool !== 'select' ? 'crosshair' : '';
          if (state.tool) store.selectBuilding(undefined);
        }
      });
      owned.push({ destroy: unsubscribeEdits });
      owned.push({
        destroy: () => {
          const s = useEditStore.getState();
          s.setResolver(undefined);
          s.setModelApplier(undefined);
          s.setFenceTools(undefined);
          s.setPropTools(undefined);
          s.setPublisher(undefined);
          s.setTool(undefined);
          s.select(undefined);
        },
      });

      // Чёткая земля — вокруг взгляда: у пешехода впереди, в обзоре — вокруг точки вращения (ближе к камере).
      ground.setFocus((distance) => {
        if (walk.isWalking) return walk.pointAhead(distance);
        if (drive.isDriving) return drive.pointAhead(distance);
        const t = c.target;
        const toCamera = c.camera.position.clone().sub(t).setY(0);
        const pull = Math.min(distance, toCamera.length() * 0.5);
        if (toCamera.lengthSq() > 1) toCamera.setLength(pull);
        else toCamera.set(0, 0, 0);
        return [t.x + toCamera.x, -(t.z + toCamera.z)];
      });

      // Вид сверху / под углом: кнопка в углу; подсветка — по фактическому наклону камеры.
      store.setChangeView((mode) => c.changeView(mode));
      owned.push({ destroy: () => store.setChangeView(undefined) });
      let lastView = c.viewMode();
      owned.push({
        destroy: c.addAnimator(() => {
          const view = c.viewMode();
          if (view !== lastView) {
            lastView = view;
            store.setViewMode(view);
          }
          // Компас: курс обзора, с точностью до градуса.
          if (!walk.isWalking && !drive.isDriving) store.setCameraHeading(Math.round(c.heading()) % 360);
          return false;
        }),
      });
      store.setFaceNorth(() => {
        const distance = c.camera.position.distanceTo(c.target);
        c.flyTo(c.orbitPosition(c.target, 0, c.pitch(), distance), c.target, 0.8);
      });
      owned.push({ destroy: () => store.setFaceNorth(undefined) });

      store.setWalkControls({
        pickStart: (kind = 'walk') => {
          store.selectBuilding(undefined);
          store.setMode(kind === 'drive' ? 'pick-drive-start' : 'pick-walk-start');
          c.canvas.style.cursor = 'crosshair';
        },
        cancelPick: () => {
          store.setMode('explore');
          c.canvas.style.cursor = '';
        },
        exit: () => {
          walk.exit();
          drive.exit();
        },
        switchTo: (kind) => {
          if (kind === 'drive' && walk.isWalking) {
            const { position, heading } = walk.pose();
            const saved = walk.leave();
            store.setMode('drive');
            drive.enter(position, heading, saved);
          } else if (kind === 'walk' && drive.isDriving) {
            const { position, heading } = drive.pose();
            const saved = drive.leave();
            store.setMode('walk');
            // Выходим сбоку от машины, слева по ходу.
            const side: [number, number] = [position[0] - Math.cos(heading) * 2.2, position[1] + Math.sin(heading) * 2.2];
            walk.enter(frame.toLonLat(side), (heading * 180) / Math.PI, saved);
          }
        },
        setStick: (forward, right) => walk.setStick(forward, right),
      });

      // Клик (не перетаскивание): старт прогулки или выбор здания.
      let down: [number, number] | undefined;
      const onPointerDown = (event: PointerEvent) => {
        if (event.button === 0) down = [event.clientX, event.clientY];
      };
      const onPointerUp = (event: PointerEvent) => {
        if (event.button !== 0 || !down) return;
        const moved = Math.hypot(event.clientX - down[0], event.clientY - down[1]);
        down = undefined;
        if (moved > 5) return;
        const { mode } = useAppStore.getState();
        if (mode === 'draw-plot') {
          plotTool.handleClick(event.clientX, event.clientY);
        } else if (mode === 'pick-walk-start') {
          const point = c.pickGround(event.clientX, event.clientY);
          if (!point) return;
          c.canvas.style.cursor = '';
          store.setMode('walk');
          walk.enter(frame.toLonLat([point.x, -point.z]), c.heading());
        } else if (mode === 'pick-drive-start') {
          const point = c.pickGround(event.clientX, event.clientY);
          if (!point) return;
          c.canvas.style.cursor = '';
          store.setMode('drive');
          drive.enter([point.x, -point.z], (c.heading() * Math.PI) / 180);
        } else if (mode === 'explore') {
          // Включён инструмент редактора или подложку двигают/совмещают — клики обрабатывают они.
          if (useEditStore.getState().tool || useUnderlayStore.getState().mode) return;
          const hit = c.pickObject(event.clientX, event.clientY, [...buildings.pickables, ...userLayer.pickables, ...(villageModels?.pickables ?? [])]);
          const ownId = userLayer.idFromPick(hit);
          const own = ownId && useAppStore.getState().userBuildings.find((b) => userBuildingId(b.id) === ownId);
          const modelId = villageModels?.buildingFromPick(hit);
          store.selectBuilding(own ? toProperties(own) : (buildings.buildingFromPick(hit) ?? (modelId ? featureById.get(modelId)?.properties : undefined)));
        }
      };
      c.canvas.addEventListener('pointerdown', onPointerDown);
      c.canvas.addEventListener('pointerup', onPointerUp);
      owned.push({
        destroy: () => {
          c.canvas.removeEventListener('pointerdown', onPointerDown);
          c.canvas.removeEventListener('pointerup', onPointerUp);
        },
      });

      // Сцена следует за стором: подсветка, раскраска, звук, качество графики.
      const unsubscribe = useAppStore.subscribe((state, prev) => {
        if (state.selectedBuilding !== prev.selectedBuilding) buildings.select(state.selectedBuilding?.id);
        if (state.buildingColorMode !== prev.buildingColorMode) buildings.setColorMode(state.buildingColorMode);
        if (state.soundOn !== prev.soundOn) soundscape.setEnabled(state.soundOn);
        if (state.volumes !== prev.volumes) soundscape.setVolumes(state.volumes);
        if (state.graphicsQuality !== prev.graphicsQuality) {
          c.setQuality(state.graphicsQuality);
          c.setBlur(state.blur);
          c.setOutlines(state.outlines);
        }
        if (state.outlines !== prev.outlines) c.setOutlines(state.outlines);
        if (state.haze !== prev.haze) c.setHaze(state.haze);
        if (state.blur !== prev.blur) c.setBlur(state.blur);
        if (state.carColor !== prev.carColor) drive.setColor(state.carColor);
        if (state.villageModels !== prev.villageModels) {
          applyVillageModels();
          refreshObstacles();
          showSelection();
        }
        if (state.builder !== prev.builder || state.userBuildings !== prev.userBuildings) {
          const preview = state.builder?.result.building;
          userLayer.render(state.userBuildings, preview && state.builder ? { id: 'preview', spec: state.builder.spec, building: preview } : undefined);
          // Деревья, фонари и скамейки на пятне застройки убираем (и возвращаем, если здание снесли).
          refreshObstacles();
        }
        // Открыли конструктор — показываем участок крупно в свободной от панели части экрана.
        if (state.builder && !prev.builder && state.plot) {
          const sidebar = document.querySelector('.sidebar');
          const sidebarShare = sidebar ? (sidebar.getBoundingClientRect().right + 16) / c.canvas.clientWidth : 0;
          flyToArea(c, state.plot.polygon, frame, localHeight, state.builder.result.building?.totalHeight ?? 30, Math.min(sidebarShare, 0.6));
        }
      });
      owned.push({ destroy: unsubscribe });
      buildings.setColorMode(useAppStore.getState().buildingColorMode);
      c.setQuality(useAppStore.getState().graphicsQuality);

      store.setStatus('ready');
      // Всё загружено — плавный пролёт к району (у деревни — к домам).
      const focus = village ? focusOf(villageHouses.map((h) => h.rect[0]!)) : undefined;
      store.setFlyHome(() => flyToTerritory(c, territory, frame, localHeight, 1.5, focus));
      if (!kept) flyToTerritory(c, territory, frame, localHeight, 3.2, focus);
    }

    init().catch((error: unknown) => {
      if (disposed) return;
      console.error(error);
      store.setStatus('error', error instanceof Error ? error.message : String(error));
    });

    // Esc отменяет выбор точки старта прогулки (сама прогулка ловит Esc в контроллере).
    const onKeyDown = (event: KeyboardEvent) => {
      const { mode } = useAppStore.getState();
      if (event.code === 'Escape' && (mode === 'pick-walk-start' || mode === 'pick-drive-start')) {
        useAppStore.getState().walkControls?.cancelPick();
      }
    };
    window.addEventListener('keydown', onKeyDown);

    return () => {
      disposed = true;
      window.removeEventListener('keydown', onKeyDown);
      for (const item of owned.reverse()) item.destroy();
      if (city) keptView = { territory: territory.id, position: city.camera.position.clone(), target: city.target.clone() };
      city?.dispose();
      store.setFlyHome(undefined);
      store.setPlotControls(undefined);
      store.setWalkControls(undefined);
      store.setMode('explore');
      store.setWalkStreet(undefined);
      store.plotDrawingCancelled();
      store.plotCleared();
      store.selectBuilding(undefined);
    };
  }, [territory]);

  return (
    <div ref={containerRef} className="city-viewer">
      <div className="city-credits">
        © участники OpenStreetMap, ODbL{credit ? ` · ${credit}` : ''}
      </div>
    </div>
  );
}
