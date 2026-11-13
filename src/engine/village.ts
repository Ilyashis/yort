// Деревня из доработок первой версии: дома OSM — моделями башкирских домов, участки с заборами,
// воротами, сараями и банями («обустроенный посёлок»), палисадники перед домами.
// Планировщики (src/world/village) и их слои (src/three) взяты из v1 как есть; здесь — перевод
// данных v2 в их координаты (x — восток, y — север) и подключение к движку.

import { Raycaster, type Object3D } from 'three';
import type { World } from '../core/data';
import type { P2 } from '../core/geo';
import type { CityScene } from '../three/CityScene';
import type { GroundArea, GroundDelta } from '../three/merged';
import { EstateLayer } from '../three/EstateLayer';
import { FrontGardensLayer, type GardenSite } from '../three/FrontGardensLayer';
import { VillageModelsLayer } from '../three/VillageModelsLayer';
import { decodeDetailFile, DetailHeights, type DetailTerrainFile } from '../world/base/detailTerrain';
import { openRing, signedArea } from '../world/base/roofGeometry';
import { VILLAGE_HOUSE_TYPES, type Yard } from '../world/base/yards';
import { planEstates, type EstateInput, type EstatePlan } from '../world/village/estates';
import { hashString } from '../utils/hash';
import { modelFootprint } from '../world/edit/edits';
import { chooseVillageModel, modelFacadeShift, VILLAGE_VARIANTS, type VillageHouse } from '../world/village/villagePlan';
import { createLocalFrame, type Vec2 } from '../world/walk/localFrame';
import { tame } from './buildings';
import type { HeightMap } from './terrain';

/** Здания меньше — хозпостройки (стоят внутри участков), м². */
const SHED_AREA = 45;
/** Жилой дом не больше этого; больше — ферма, склад: ничья земля вокруг, м². */
const HOUSE_AREA = 320;
/** Общественные здания: вокруг них участков нет. */
const PUBLIC_TYPES = new Set(['school', 'mosque', 'church', 'kindergarten', 'public', 'civic', 'commercial', 'retail', 'industrial', 'hospital', 'office']);

const toLocal = (p: P2): Vec2 => [p[0], -p[1]];
const toWorld = (p: Vec2): P2 => [p[0], -p[1]];
/** Кольцо v2 (мир) → кольцо v1 (локальные метры, против часовой). */
const ringLocal = (ring: readonly P2[]): Vec2[] => ring.map(toLocal).reverse();

export interface VillagePlan {
  /** Дома OSM, которые рисуются моделями: в общей сетке зданий их пропускаем. */
  replaced: Set<string>;
  houses: VillageHouse[];
  estates?: EstatePlan;
  outbuildings: VillageHouse[];
  gardens: GardenSite[];
  /** Для земли и деревьев (координаты мира): подъезды, огороды, контуры дворовых построек, деревья участков. */
  driveways: P2[][];
  vegetable: P2[][];
  pads: P2[][];
  trees: P2[];
  /** Подъезды и огороды по участкам — чтобы убирать их вместе с двором. */
  plotGround: { id: string; driveway?: P2[]; garden?: P2[]; pads: P2[][] }[];
}

/**
 * Участки без выдуманного наполнения: остаются только границы — заборы с воротами. Сараи, бани, теплицы,
 * колодцы и прочая дворовая утварь, палисадники, огороды с грядками и подъезды планировщик придумывал сам;
 * в жизни на этих местах другое, поэтому их не показываем. Проёмы в заборах, оставленные под палисадники и
 * стены построек, закрываются; проёмы ворот остаются.
 */
function bare(plan: EstatePlan): EstatePlan {
  const gates = plan.plots.flatMap((p) => (p.gate ? [p.gate] : []));
  const at = (line: readonly Vec2[], s: number): Vec2 => {
    for (let n = 0; n + 1 < line.length; n++) {
      const a = line[n], b = line[n + 1], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (s <= len || n + 2 === line.length) return [a[0] + ((b[0] - a[0]) * Math.min(s, len)) / (len || 1), a[1] + ((b[1] - a[1]) * Math.min(s, len)) / (len || 1)];
      s -= len;
    }
    return line[0];
  };
  return {
    plots: plan.plots.map((p) => ({ ...p, outbuildings: [], props: [], trees: [], garden: undefined, palisade: undefined, driveway: undefined })),
    runs: plan.runs.map((run) => ({
      ...run,
      cuts: run.cuts.filter(([from, to]) => {
        const mid = at(run.line, (from + to) / 2);
        return gates.some((g) => Math.hypot(g.at[0] - mid[0], g.at[1] - mid[1]) < (to - from) / 2 + 1);
      }),
    })),
  };
}

/** Модели, перед которыми бывает палисадник (жилые дома). */
const GARDEN_MODELS = new Set(['izba', 'pyatistenok', 'veranda', 'hipped', 'brick']);
const GARDEN_DEPTH = 3.4;

/**
 * Палисадник у стороны дома: side 0 — уличный фасад (первая сторона прямоугольника), 1 — справа, 2 — сзади,
 * 3 — слева, если смотреть с улицы. Глубина — до GARDEN_DEPTH м, но не залезая на дорогу; не помещается
 * (меньше 1,2 м) — палисадника нет.
 */
export function gardenSite(world: World, id: string, model: string, rect: readonly Vec2[], side: number): GardenSite | undefined {
  if (!GARDEN_MODELS.has(model) || side < 0 || rect.length !== 4) return undefined;
  const a = rect[side % 4], b = rect[(side + 1) % 4];
  const width = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (width < 3) return undefined;
  // Прямоугольник обходится против часовой: наружу от стороны — вправо от её направления.
  const toStreet: Vec2 = [(b[1] - a[1]) / width, -(b[0] - a[0]) / width];
  const origin: Vec2 = [(a[0] + b[0]) / 2 + toStreet[0] * 0.25, (a[1] + b[1]) / 2 + toStreet[1] * 0.25];
  let depth = GARDEN_DEPTH;
  for (const road of world.roads) {
    for (let n = 0; n + 1 < road.pts.length; n++) {
      const p = toLocal(road.pts[n]), q = toLocal(road.pts[n + 1]);
      const dx = q[0] - p[0], dy = q[1] - p[1], l2 = dx * dx + dy * dy || 1;
      const t = Math.min(1, Math.max(0, ((origin[0] - p[0]) * dx + (origin[1] - p[1]) * dy) / l2));
      const nx = p[0] + dx * t - origin[0], ny = p[1] + dy * t - origin[1];
      // Дорога считается, только если она со стороны палисадника.
      if (nx * toStreet[0] + ny * toStreet[1] > 0) depth = Math.min(depth, Math.hypot(nx, ny) - road.width / 2 - 1.2);
    }
  }
  if (depth < 1.2) return undefined;
  return { owner: `${id}:0`, origin, toStreet, width, depth, seed: 1 + (hashString(id) % 997) };
}

export function planVillage(world: World, withEstates: boolean): VillagePlan | undefined {
  if (world.territory.kind !== 'village') return undefined;
  const roads = world.roads.map((r) => ({ coords: r.pts.map(toLocal), width: r.width }));
  const roadLines = roads.map((r) => r.coords);

  // Дома → модели.
  const count = new Map<string, number>();
  for (const b of world.buildings) count.set(b.props.id, (count.get(b.props.id) ?? 0) + 1);
  const houses: VillageHouse[] = [];
  for (const b of world.buildings) {
    if (count.get(b.props.id) !== 1) continue;
    const house = chooseVillageModel(b.props.id, ringLocal(b.rings[0]), roadLines, b.props.building);
    if (!house) continue;
    const survey = world.surveyColours[b.props.id];
    const calm = (hex?: string) => (hex ? `#${tame(hex).getHexString()}` : undefined);
    const roof = calm(survey?.roof ?? b.props.roofColour);
    const wall = calm(survey?.wall ?? b.props.colour);
    houses.push(roof || wall ? { ...house, colors: { roof, wall } } : house);
  }

  // Участки.
  let estates: EstatePlan | undefined;
  if (withEstates) {
    const input = { houses: [], sheds: [], blockers: [], roads, tracks: world.paths.map((p) => ({ coords: p.pts.map(toLocal), width: p.width })) } as {
      [K in keyof EstateInput]: EstateInput[K] extends readonly (infer T)[] ? T[] : never;
    };
    const seen = new Map<string, number>();
    for (const b of world.buildings) {
      const i = seen.get(b.props.id) ?? 0;
      seen.set(b.props.id, i + 1);
      const ring = openRing(ringLocal(b.rings[0]));
      if (ring.length < 3) continue;
      const area = Math.abs(signedArea(ring));
      const id = `${b.props.id}:${i}`;
      if (VILLAGE_HOUSE_TYPES.has(b.props.building) && area >= SHED_AREA && area <= HOUSE_AREA) input.houses.push({ id, ring });
      else if (area < SHED_AREA * 2.5 && !PUBLIC_TYPES.has(b.props.building)) input.sheds.push({ id, ring });
      else input.blockers.push({ rings: [ring], margin: 2.5 });
    }
    for (const g of world.ground) {
      const water = g.kind === 'water';
      if (!water && !(g.kind === 'green' && g.cover === 'wood')) continue;
      input.blockers.push({ rings: g.rings.map((r) => r.map(toLocal)), margin: water ? 3 : 0 });
    }
    estates = bare(planEstates(input));
  }

  // Дворовые постройки с карты: гараж и сарай — моделью сарая (ворота гаража — длинной стороной к улице),
  // баня — баней. Прямоугольник ставится фасадом к ближайшей улице.
  const outbuildings: VillageHouse[] = world.yardBuildings.map((b) => ({
    id: b.id,
    model: b.kind === 'banya' ? 'banya' : 'shed',
    seed: 1 + (hashString(b.id) % VILLAGE_VARIANTS),
    rect: modelFootprint(ringLocal(b.ring), roadLines),
  }));

  // Палисадники: у каждого жилого дома-модели, по умолчанию — перед уличным фасадом.
  const gardens: GardenSite[] = houses.flatMap((h) => {
    const site = gardenSite(world, h.id, h.model, h.rect, 0);
    return site ? [site] : [];
  });

  const plots = estates?.plots ?? [];
  return {
    replaced: new Set(houses.map((h) => h.id)),
    houses,
    estates,
    outbuildings,
    gardens,
    driveways: plots.flatMap((p) => (p.driveway ? [p.driveway.map(toWorld)] : [])),
    vegetable: plots.flatMap((p) => (p.garden ? [p.garden.ring.map(toWorld)] : [])),
    pads: outbuildings.map((b) => b.rect.map(toWorld)),
    trees: plots.flatMap((p) => p.trees.map(toWorld)),
    // Каждая постройка — своя запись: по ней она мешает пройти и получает площадку на земле.
    plotGround: outbuildings.map((b) => ({ id: `${b.id}:0`, pads: [b.rect.map(toWorld)] })),
  };
}

/**
 * Подробный рельеф съёмки под жизнь деревни (как в v1): участок — плоскостью по своему уклону, под дорогами
 * и тропинками — ровное полотно, под домами и дворовыми постройками — площадки. Возвращает высоту по
 * долготе и широте или undefined, если съёмки нет.
 */
export function shapedHeights(world: World, plan: VillagePlan | undefined): ((lon: number, lat: number) => number) | undefined {
  if (!world.detailFile) return undefined;
  const detail = new DetailHeights(decodeDetailFile(world.detailFile as DetailTerrainFile), (lon, lat) => world.dem.at(lon, lat));
  const lonLat = (p: P2): [number, number] => [world.frame.lon(p[0]), world.frame.lat(p[1])];
  if (plan?.estates) detail.flattenPlots(plan.estates.plots.map((p) => p.ring.map((v) => lonLat(toWorld(v)))));
  detail.flattenRoads([...world.roads, ...world.paths].map((r) => ({ coords: r.pts.map(lonLat), width: r.width })));
  detail.flattenPads([...world.buildings.map((b) => b.rings[0].map(lonLat)), ...(plan?.pads ?? []).map((ring) => ring.map(lonLat))]);
  return (lon, lat) => detail.heightAt(lon, lat);
}

/** Участок посёлка как двор (для редактора: выбор забора, «убрать двор»). */
function plotYards(plan: EstatePlan): Yard[] {
  const fences = new Map<string, [Vec2, Vec2][]>();
  for (const run of plan.runs) {
    const segments = run.line.slice(1).map((b, i): [Vec2, Vec2] => [run.line[i], b]);
    for (const id of run.owners) fences.set(id, [...(fences.get(id) ?? []), ...segments]);
  }
  return plan.plots.map((plot) => {
    const xs = plot.ring.map((p) => p[0]), ys = plot.ring.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    return {
      houseId: plot.id,
      corners: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
      fence: fences.get(plot.id) ?? [],
      ...(plot.palisade ? { palisade: plot.palisade } : {}),
      seed: plot.seed,
    };
  });
}

/** Что из правок касается деревни. */
export interface VillageEdits {
  /** Дома-модели из правок: палисадник у них — со своей стороны (или его нет). */
  edited?: readonly { id: string; source?: string; model: string; rect: Vec2[]; garden: number }[];
  /** Дома OSM, заменённые правкой или убранные: модель не рисуем. */
  replaced: ReadonlySet<string>;
  /** Дворы с убранным забором и дома, удалённые совсем (их двор уходит целиком). */
  removedYards: ReadonlySet<string>;
  deleted: ReadonlySet<string>;
}

export interface VillageLayers {
  models?: VillageModelsLayer;
  /** Дворы участков — редактору (выбор забора). */
  yards: Yard[];
  /** id дома OSM под лучом (дом-модель) и расстояние до него. */
  pick: (raycaster: Raycaster) => { id: string; distance: number } | undefined;
  /** Применить правки; возвращает скрытые участки (id). */
  setEdits: (edits: VillageEdits) => Set<string>;
  shiftGround: (delta: GroundDelta, area: GroundArea) => void;
  setVisible: (visible: boolean) => void;
  pickables: () => Object3D[];
  dispose: () => void;
}

export function createVillageLayers(plan: VillagePlan, world: World, hm: HeightMap, host: CityScene): VillageLayers {
  const heightAt = (x: number, y: number) => hm.at(x, -y);
  const frame = createLocalFrame([world.frame.lon0, world.frame.lat0]);
  const noCsm = undefined as never;

  const models = plan.houses.length ? new VillageModelsLayer(host, frame, heightAt, plan.houses, noCsm) : undefined;
  const estateLayer = plan.estates ? new EstateLayer(host, heightAt, undefined, plan.estates) : undefined;
  const estateModels = plan.outbuildings.length ? new VillageModelsLayer(host, frame, heightAt, plan.outbuildings, noCsm, 60) : undefined;
  const gardens = new FrontGardensLayer(host, heightAt, undefined);
  gardens.setSites(plan.gardens);
  let gardenKey = '';
  const yards = plan.estates ? plotYards(plan.estates) : [];
  const outbuildingsOf = new Map((plan.estates?.plots ?? []).map((p) => [p.id, p.outbuildings.map((b) => b.id)]));
  const yardOwner = (houseId: string) => houseId.slice(0, houseId.lastIndexOf(':'));

  return {
    models,
    yards,
    pick: (raycaster) => {
      if (!models?.visible) return undefined;
      const hit = raycaster.intersectObjects(models.pickables, false)[0];
      const id = models.buildingFromPick(hit);
      return id && hit ? { id, distance: hit.distance } : undefined;
    },
    setEdits: ({ replaced, removedYards, deleted, edited = [] }) => {
      // Палисадники: у нетронутых домов — как в плане, у изменённых — по их новому месту и выбранной стороне.
      const key = JSON.stringify(edited) + [...replaced].sort().join();
      if (key !== gardenKey) {
        gardenKey = key;
        const moved = new Set(edited.map((e) => e.source ?? e.id));
        const own = edited.flatMap((e) => {
          const site = gardenSite(world, e.source ?? e.id, e.model, e.rect, e.garden);
          return site ? [site] : [];
        });
        gardens.setSites([...plan.gardens.filter((g) => !moved.has(g.owner.slice(0, g.owner.lastIndexOf(':'))) && !replaced.has(g.owner.slice(0, g.owner.lastIndexOf(':')))), ...own]);
      }
      const hidden = new Set([...removedYards, ...yards.filter((y) => deleted.has(yardOwner(y.houseId))).map((y) => y.houseId)]);
      models?.setHidden(replaced);
      estateLayer?.setHidden(hidden);
      estateModels?.setHidden(new Set([...hidden].flatMap((id) => outbuildingsOf.get(id) ?? [])));
      gardens.setHidden(new Set(removedYards), new Set());
      return hidden;
    },
    shiftGround: (delta, area) => {
      for (const layer of [models, estateModels, estateLayer, gardens]) layer?.shiftGround(delta, area);
    },
    setVisible: (visible) => {
      for (const layer of [models, estateModels, estateLayer, gardens]) layer?.setVisible(visible);
    },
    pickables: () => models?.pickables ?? [],
    dispose: () => {
      models?.destroy();
      estateLayer?.destroy();
      estateModels?.destroy();
      gardens.destroy();
    },
  };
}
