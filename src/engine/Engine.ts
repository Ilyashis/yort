// Движок: рендер, сборка сцены территории, режимы камеры, выбор зданий, связь с интерфейсом.

import {
  ACESFilmicToneMapping,
  BufferAttribute,
  BufferGeometry,
  Group,
  HalfFloatType,
  LineBasicMaterial,
  LineSegments,
  PCFSoftShadowMap,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Vector2,
  type Texture,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { findTerritory, loadWorld, type Territory, type World } from '../core/data';
import { RingIndex, RoadIndex, SegmentGrid } from '../core/spatial';
import { urlParams, useStore, type Ground, type Mode } from '../state/store';
import { createBuildings, type Building, type BuildingSet } from './buildings';
import { CAR_COLOURS, Drive, Overview, Walk, type Ctx, type Player } from './controls';
import { createMonument, createProps, placeLamps, type Props } from './props';
import { breathe, shared, type Rect } from './shared';
import { Atmosphere } from './sky';
import { createTerrainMaterial, createTerrainMeshes, HeightMap, paintMasks, paintMiniMap, type Masks } from './terrain';
import { createGrass, type Grass } from './grass';
import { applyShapes, applySpots, computeLevels, type LevelHouse } from './levelling';
import { createOrthoUniforms, findOrtho, loadOrtho, loadSatellite, satelliteSource } from './ortho';
import { probe } from './probe';
import { createTrees } from './trees';
import { createEditing, loadSculpt, roadsWithEdits } from './editing';
import { GroundUnderlay } from '../three/groundUnderlay';
import type { Animator, CityScene } from '../three/CityScene';
import { useEditStore } from '../store/useEditStore';
import { useUnderlayStore } from '../store/useUnderlayStore';
import { plotKey, type Edits } from '../world/edit/edits';
import type { Footprint } from '../core/data';
import type { P2 } from '../core/geo';
import { createVillageLayers, planVillage, shapedHeights, type VillageLayers } from './village';
import { Soundscape } from '../audio/Soundscape';
import { SoundZones } from '../audio/soundZones';
import { NIGHT } from '../three/nightUniforms';
import { createLocalFrame } from '../world/walk/localFrame';

const TYPE_NAMES: Record<string, string> = {
  yes: 'Здание', apartments: 'Многоквартирный дом', house: 'Жилой дом', residential: 'Жилой дом', detached: 'Жилой дом',
  retail: 'Магазин', commercial: 'Коммерческое здание', office: 'Офисное здание', university: 'Университет', school: 'Школа',
  dormitory: 'Общежитие', industrial: 'Промышленное здание', garage: 'Гараж', garages: 'Гаражи', service: 'Служебная постройка',
  government: 'Административное здание', mosque: 'Мечеть', church: 'Церковь', cathedral: 'Собор', hospital: 'Больница',
  hotel: 'Гостиница', kindergarten: 'Детский сад', theatre: 'Театр', shed: 'Сарай', roof: 'Навес', public: 'Общественное здание',
  civic: 'Общественное здание', college: 'Колледж', museum: 'Музей', kiosk: 'Киоск',
};

export class Engine {
  /** План района и положение игрока — для мини-карты. */
  miniMap?: { canvas: HTMLCanvasElement; rect: Rect };
  player?: Player;

  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(45, 1, 1, 40000);
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;
  private readonly atmosphere: Atmosphere;
  private readonly keys = new Set<string>();
  private readonly abort = new AbortController();
  private readonly ctx: Ctx;
  private readonly overview: Overview;
  private readonly walk: Walk;
  private readonly drive: Drive;
  private readonly outline: LineSegments;
  private readonly raycaster = new Raycaster();
  private readonly cleanup: (() => void)[] = [];
  private readonly animators = new Set<Animator>();
  private readonly underlay: GroundUnderlay;
  /** Сцена глазами слоёв и инструментов первой версии (редактор, подложка, дома-модели). */
  private readonly host: CityScene;

  private world?: World;
  private worldGroup?: Group;
  private worldDisposers: (() => void)[] = [];
  private buildings?: BuildingSet;
  private props?: Props;
  private village?: VillageLayers;
  private grass?: Grass;
  private showGround?: (mode: Ground) => void;
  private treesUpdate?: (camera: { position: Vector3 }) => void;
  private soundscape?: Soundscape;
  private mode: Mode = 'overview';
  private time = useStore.getState().time;
  private loadToken = 0;
  private raf = 0;
  private last = performance.now();
  private hudAt = 0;
  private pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  private slow = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFSoftShadowMap;
    this.renderer = renderer;

    const target = new WebGLRenderTarget(4, 4, { type: HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new Vector2(256, 256), 0.15, 0.55, 1.0);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.atmosphere = new Atmosphere(this.scene, renderer, 4096);
    this.scene.add(this.camera);

    this.outline = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ color: 0xffc857, depthTest: false, transparent: true, opacity: 0.95 }));
    this.outline.renderOrder = 999;
    this.outline.frustumCulled = false;
    this.outline.visible = false;
    this.scene.add(this.outline);

    this.ctx = {
      signal: this.abort.signal,
      camera: this.camera, dom: canvas, keys: this.keys,
      hm: undefined as unknown as HeightMap, walls: new SegmentGrid<number>(16), roads: new RoadIndex([]),
      rect: { x0: -1, z0: -1, x1: 1, z1: 1 }, city: true, night: 0,
      ground: (nx, ny) => this.groundPoint(nx, ny),
    };
    this.overview = new Overview(this.ctx);
    this.overview.onPick = (x, y) => this.pickAt(x, y);
    this.walk = new Walk(this.ctx);
    this.drive = new Drive(this.ctx);
    this.scene.add(this.drive.car.root);
    this.drive.setColour(CAR_COLOURS[useStore.getState().carColour] ?? CAR_COLOURS[0]);

    this.underlay = new GroundUnderlay(renderer.capabilities.getMaxAnisotropy());
    const ndc = (clientX: number, clientY: number) => {
      const r = canvas.getBoundingClientRect();
      return new Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    };
    const rayAt = (clientX: number, clientY: number) => {
      const raycaster = new Raycaster();
      raycaster.setFromCamera(ndc(clientX, clientY), this.camera);
      return raycaster;
    };
    this.host = {
      scene: this.scene, camera: this.camera, canvas, renderer, csm: undefined,
      requestRender: () => undefined,
      addAnimator: (animator) => {
        this.animators.add(animator);
        return () => this.animators.delete(animator);
      },
      pickGround: (x, y) => {
        const p = ndc(x, y);
        return this.groundPoint(p.x, p.y) ?? undefined;
      },
      pickObject: (x, y, objects) => rayAt(x, y).intersectObjects(objects, true)[0],
      rayAt,
      flyTo: (position, target) => this.overview.setPose(target.x, target.z, Math.max(40, position.distanceTo(target)), undefined, 1.52),
      orbitPosition: (target, _heading, _pitch, distance) => target.clone().add(new Vector3(0, distance, 0)),
    };

    this.listen();
    const observer = new ResizeObserver(() => this.resize());
    observer.observe(canvas);
    this.cleanup.push(() => observer.disconnect());
    this.resize();

    const place = findTerritory(useStore.getState().place);
    if (place) void this.load(place);
    this.raf = requestAnimationFrame(this.frame);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.loadToken++;
    // Прежний движок не должен больше ни ловить мышь, ни держать курсор захваченным.
    this.walk.exit();
    this.drive.exit();
    this.abort.abort();
    this.cleanup.forEach((fn) => fn());
    this.disposeWorld();
    this.atmosphere.dispose();
    this.composer.dispose();
    this.renderer.dispose();
  }

  private listen(): void {
    const onKeyDown = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      this.keys.add(e.code);
      const s = useStore.getState();
      if (e.code === 'Escape') {
        if (s.help) s.set({ help: false });
        else if (this.mode !== 'overview') s.set({ mode: 'overview' });
        else if (s.selected && !useEditStore.getState().tool) this.select(undefined);
      } else if (this.mode === 'drive' && e.code === 'KeyC') this.drive.cabin = !this.drive.cabin;
      else if (this.mode === 'drive' && e.code === 'KeyR') this.drive.reset();
    };
    const onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.code);
    const onBlur = () => this.keys.clear();
    const onLock = () => {
      const locked = document.pointerLockElement === this.canvas;
      // Курсор захватывается только на прогулке: в обзоре и за рулём он должен оставаться на экране.
      if (locked && this.mode !== 'walk') document.exitPointerLock();
      useStore.getState().set({ locked: locked && this.mode === 'walk' });
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    document.addEventListener('pointerlockchange', onLock);
    const unsubscribe = useStore.subscribe((s, prev) => {
      if (s.place !== prev.place) {
        const place = findTerritory(s.place);
        if (place) void this.load(place);
      }
      if (s.mode !== this.mode) this.setMode(s.mode);
      if (s.time !== this.time) {
        this.time = s.time;
        this.applyTime();
      }
      if (s.carColour !== prev.carColour) this.drive.setColour(CAR_COLOURS[s.carColour] ?? CAR_COLOURS[0]);
      if (s.topView !== prev.topView) this.overview.setView(s.topView);
      if (s.estates !== prev.estates && this.world?.territory.kind === 'village') void this.load(this.world.territory);
      if (s.sound !== prev.sound) this.soundscape?.setEnabled(s.sound);
      if (s.ground !== prev.ground) this.showGround?.(s.ground);
    });
    this.cleanup.push(() => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('pointerlockchange', onLock);
      unsubscribe();
    });
  }

  private resize(): void {
    const w = Math.max(1, this.canvas.clientWidth), h = Math.max(1, this.canvas.clientHeight);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(this.pixelRatio);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private disposeWorld(): void {
    if (this.worldGroup) this.scene.remove(this.worldGroup);
    this.worldDisposers.forEach((fn) => fn());
    this.worldDisposers = [];
    this.worldGroup = undefined;
    this.buildings = undefined;
    this.props = undefined;
    this.village = undefined;
    this.grass = undefined;
    this.showGround = undefined;
    this.treesUpdate = undefined;
    this.soundscape?.destroy();
    this.soundscape = undefined;
    Object.assign(this.ctx, { onWalk: undefined, onDrive: undefined, onBump: undefined });
    this.world = undefined;
    probe.current = undefined;
    useStore.getState().set({ relief: null });
    this.miniMap = undefined;
    this.outline.visible = false;
  }

  private async load(territory: Territory): Promise<void> {
    const token = ++this.loadToken;
    const store = useStore.getState();
    const progress = (label: string) => {
      if (token === this.loadToken) useStore.getState().set({ loading: label });
    };
    store.set({ loading: 'Загружаем данные', error: null, selected: null, mode: 'overview', stats: null, street: '' });
    try {
      const world = await loadWorld(territory, progress);
      if (token !== this.loadToken) return;
      this.disposeWorld();
      const city = territory.kind === 'city';
      const { frame, bbox } = { frame: world.frame, bbox: territory.bbox };
      const M = 250;
      const want: Rect = { x0: frame.x(bbox.west) - M, x1: frame.x(bbox.east) + M, z0: frame.z(bbox.north) - M, z1: frame.z(bbox.south) + M };

      progress(city ? 'Строим рельеф' : 'Размечаем участки и выравниваем рельеф');
      await breathe();
      const villagePlan = planVillage(world, useStore.getState().estates);
      const hm = new HeightMap(world, want, city ? 5 : 3, shapedHeights(world, villagePlan));
      const rect = hm.rect;
      // Правки места — до постройки слоёв: всё встаёт на уже поправленную землю.
      useEditStore.getState().load(world.territory.id);
      /** Площадки под домами, полотно улиц по высотам домов, ровное русло — по текущим правкам. */
      const padsOf = new Map<string, P2[][]>();
      for (const g of villagePlan?.plotGround ?? []) {
        const owner = g.id.slice(0, g.id.lastIndexOf(':'));
        padsOf.set(owner, [...(padsOf.get(owner) ?? []), ...g.pads]);
      }
      const water = world.ground.filter((g) => g.kind === 'water').map((g) => g.rings);
      const level = (edits: Edits) => {
        const lifts = edits.plotLifts ?? {};
        const gone = new Set(edits.removedBuildings);
        const houses: LevelHouse[] = [];
        if (!city) {
          for (const b of world.buildings) {
            if (!gone.has(b.props.id)) houses.push({ id: b.props.id, ring: b.rings[0], pads: padsOf.get(b.props.id), lift: lifts[b.props.id] });
          }
          for (const b of edits.buildings) {
            houses.push({ id: b.id, ring: b.footprint.map(([lon, lat]) => world.frame.xz(lon, lat)), pads: b.source ? padsOf.get(b.source) : undefined, lift: lifts[plotKey(b)] });
          }
        }
        const roads = city ? [] : roadsWithEdits(world, edits).roads;
        const grid = { rect: hm.rect, step: hm.step, nx: hm.nx, nz: hm.nz, natural: hm.natural };
        const { lev } = computeLevels({ ...grid, houses, roads, water });
        applyShapes(grid, lev, (edits.shapes ?? []).map((s) => {
          const [x, z] = world.frame.xz(s.at[0], s.at[1]);
          return { ...s, x, z, ring: s.ring?.map(([lon, lat]): P2 => world.frame.xz(lon, lat)), height: s.height === undefined ? undefined : s.height - hm.origin };
        }));
        applySpots(grid, lev, (edits.spots ?? []).map((s) => {
          const [x, z] = world.frame.xz(s.at[0], s.at[1]);
          return { x, z, height: s.height - hm.origin, radius: s.radius };
        }));
        return hm.relevel(lev);
      };
      level(useEditStore.getState().edits);
      const sculpt = loadSculpt(world, hm);
      const edits0 = useEditStore.getState().edits;
      const paths = new RoadIndex(world.paths);
      const anisotropy = this.renderer.capabilities.getMaxAnisotropy();

      progress('Строим здания');
      await breathe();
      const buildings = createBuildings(world, hm, new RoadIndex(world.roads), villagePlan?.replaced);
      const monument = createMonument(world, hm);
      const lonLatRing = (ring: [number, number][]): P2[] => ring.map(([lon, lat]) => world.frame.xz(lon, lat));

      /** Кто мешает пройти и где нельзя ставить фонари и деревья — с учётом правок. */
      const obstacles = (edits: Edits, hiddenPlots: ReadonlySet<string>) => {
        const footprints = new RingIndex();
        const walls = new SegmentGrid<number>(16);
        const addWalls = (ring: readonly P2[], ref: number) => {
          for (let i = 0; i < ring.length; i++) {
            const a = ring[i], c = ring[(i + 1) % ring.length];
            walls.add(a[0], a[1], c[0], c[1], ref);
          }
        };
        const removed = new Set(edits.removedBuildings);
        buildings.list.forEach((b, i) => {
          if (b.parent >= 0 || removed.has(b.props.id)) return;
          footprints.add(b.rings[0]);
          if (b.solid) b.rings.forEach((ring) => addWalls(ring, i));
        });
        for (const plot of villagePlan?.plotGround ?? []) {
          if (hiddenPlots.has(plot.id)) continue;
          for (const pad of plot.pads) {
            footprints.add(pad);
            addWalls(pad, -1);
          }
        }
        for (const b of edits.buildings) {
          const ring = lonLatRing(b.footprint);
          footprints.add(ring);
          addWalls(ring, -1);
        }
        if (monument) addWalls(monument.ring, -1);
        return { footprints, walls };
      };
      let solid = obstacles(edits0, new Set());

      progress('Красим землю');
      await breathe();
      /** Дороги, маски земли, фонари и разметка — по текущим правкам (первый раз и после каждой правки дорог). */
      let masks: Masks | undefined;
      let props: Props | undefined;
      let roads = new RoadIndex([]);
      const group = new Group();
      const layRoads = (edits: Edits, hiddenPlots: ReadonlySet<string>) => {
        const now: World = { ...world, ...roadsWithEdits(world, edits) };
        roads = new RoadIndex(now.roads);
        const lamps = placeLamps(now, solid.footprints);
        const shown = (villagePlan?.plotGround ?? []).filter((g) => !hiddenPlots.has(g.id));
        const removed = new Set(edits.removedBuildings);
        const footprintList = [
          ...world.buildings.filter((f) => !removed.has(f.props.id)),
          ...edits.buildings.map((e) => ({ props: { minHeight: 0 } as Footprint['props'], rings: [lonLatRing(e.footprint)] })),
        ];
        masks = paintMasks(now, rect, lamps.map((l): P2 => [l.x + l.dx * 1.3, l.z + l.dz * 1.3]), footprintList, anisotropy,
          { dirt: shown.flatMap((g) => (g.driveway ? [g.driveway] : [])), gardens: shown.flatMap((g) => (g.garden ? [g.garden] : [])), pads: shown.flatMap((g) => g.pads) }, masks);
        if (props) {
          group.remove(props.group);
          props.dispose();
        }
        props = createProps(now, hm, lamps, roads, paths);
        props.setLamps(shared.uLamps.value);
        group.add(props.group);
        this.props = props;
        this.miniMap = { canvas: paintMiniMap(now, rect, footprintList), rect };
        Object.assign(this.ctx, { roads });
      };
      layRoads(edits0, new Set());
      // Чем красить землю: рисунком, снимком с дрона или спутниковым. Снимки грузятся в фоне и только когда
      // выбраны; земля и трава подхватывают их на лету.
      const ortho = createOrthoUniforms();
      const orthoFile = await findOrtho(world);
      if (token !== this.loadToken) return;
      const photos: Partial<Record<Ground, { texture: Texture; rect: [number, number, number, number] }>> = {};
      const pending = new Set<Ground>();
      const showGround = (mode: Ground) => {
        const want = mode === 'drone' && !orthoFile ? 'drawn' : mode;
        const ready = want === 'drawn' ? undefined : photos[want];
        if (ready) {
          ortho.uOrtho.value = ready.texture;
          ortho.uOrthoRect.value = ready.rect;
        }
        ortho.uOrthoOn.value = ready ? 1 : 0;
        if (want === 'drawn' || ready || pending.has(want)) return;
        pending.add(want);
        const keep = (photo: { texture: Texture; rect: [number, number, number, number] }) => {
          if (token !== this.loadToken) return photo.texture.dispose();
          photos[want] = photo;
          showGround(useStore.getState().ground);
        };
        if (want === 'drone') void loadOrtho(world, orthoFile!, anisotropy).then(keep).catch(() => pending.delete(want));
        else {
          const source = satelliteSource();
          const satellite = loadSatellite(world, source, anisotropy, () => token === this.loadToken);
          keep(satellite);
          useStore.getState().set({ groundCredit: `спутниковый снимок ${source.credit}` });
          void satellite.done.then((count) => {
            if (!count && token === this.loadToken) useStore.getState().set({ groundCredit: 'спутниковый снимок не загрузился — нет сети или источник недоступен' });
          });
        }
      };
      this.showGround = showGround;
      useStore.getState().set({ hasPhoto: !!orthoFile, groundCredit: '' });
      showGround(useStore.getState().ground);
      const terrainMaterial = createTerrainMaterial(masks!, rect, city, this.underlay, ortho);
      const terrain = createTerrainMeshes(hm, terrainMaterial);

      progress('Сажаем деревья');
      await breathe();
      const trees = createTrees({ world, hm, roads, paths, footprints: solid.footprints, buildings: buildings.list, clearings: monument ? [[monument.x, monument.z, 22]] : [], yardTrees: villagePlan?.estates ? villagePlan.trees : undefined });
      if (token !== this.loadToken) return;

      const grass = createGrass(hm, masks!, rect, city, solid.footprints, ortho);
      this.grass = grass;
      this.treesUpdate = trees.update;
      group.add(terrain.group, buildings.mesh, trees.group, grass.group);
      if (monument) group.add(monument.group);
      this.scene.add(group);
      this.worldGroup = group;
      const village = villagePlan && createVillageLayers(villagePlan, world, hm, this.host);
      this.village = village;
      Object.assign(this.ctx, { hm, walls: solid.walls, roads, rect, city });

      progress('Готовим редактор');
      const editing = createEditing({
        host: this.host, world, hm, buildings, village, overview: this.overview, underlay: this.underlay, sculpt,
        level,
        groundChanged: (area) => {
          useStore.getState().set({ terrainRev: useStore.getState().terrainRev + 1 });
          terrain.refresh(area);
          buildings.reseat(hm, area);
          trees.reseat(area);
          grass.refresh(area);
          props?.reseat(area);
        },
        roadsChanged: layRoads,
        obstaclesChanged: (edits, hiddenPlots) => {
          solid = obstacles(edits, hiddenPlots);
          grass.setFootprints(solid.footprints);
          Object.assign(this.ctx, { walls: solid.walls });
        },
        setCityVisible: (visible) => {
          buildings.mesh.visible = visible;
          trees.group.visible = visible;
          grass.setVisible(visible);
          village?.setVisible(visible);
        },
        pickables: () => [buildings.mesh, ...(village?.pickables() ?? [])],
      });

      // Звук: музыка, звуки места, шаги и мотор — как в первой версии.
      const soundFrame = createLocalFrame([world.frame.lon0, world.frame.lat0]);
      const soundscape = new Soundscape(new SoundZones(world.groundRaw as never, soundFrame, !city), () => {
        const p = this.camera.position;
        return { point: [p.x, -p.z], altitude: p.y - hm.at(p.x, p.z) };
      });
      soundscape.setEnabled(useStore.getState().sound);
      this.soundscape = soundscape;
      Object.assign(this.ctx, {
        onWalk: (distance: number, running: boolean, x: number, z: number) => soundscape.walked(distance, running, [x, -z]),
        onDrive: (car?: { rpm: number; throttle: number; speed: number; x: number; z: number }) =>
          soundscape.drove(car && { rpm: car.rpm, throttle: car.throttle, speed: car.speed, surface: soundscape.surfaceAt([car.x, -car.z]) }),
        onBump: (strength: number) => soundscape.bumped(strength),
      });
      this.worldDisposers = [
        editing.dispose, () => village?.dispose(), () => masks?.dispose(), buildings.dispose, trees.dispose, grass.dispose, () => (this.grass = undefined), () => Object.values(photos).forEach((photo) => photo.texture.dispose()), () => props?.dispose(), () => monument?.dispose(), () => terrainMaterial.dispose(),
        () => terrain.group.traverse((o) => (o as { geometry?: BufferGeometry }).geometry?.dispose()),
      ];
      this.world = world;
      probe.current = { world, hm, focus: () => ({ x: this.overview.focus.x, z: this.overview.focus.z }) };
      this.buildings = buildings;
      this.atmosphere.fog.density = city ? 0.00022 : 0.00032;

      this.mode = 'overview';
      this.walk.exit();
      this.drive.exit();
      this.overview.enter();
      this.overview.flyTo(monument ? monument.x * 0.5 : 0, monument ? monument.z * 0.5 : 0, city ? 950 : 1250, true);
      this.camera.fov = 45;
      this.camera.updateProjectionMatrix();
      this.applyTime();
      // Вид и режим из ссылки — только при первой загрузке.
      const view = (urlParams.get('view') ?? '').split(',').map(Number);
      if (token === 1 && view.length >= 3 && view.every(Number.isFinite)) this.overview.setPose(view[0], view[1], view[2], view[3], view[4]);
      const startMode = token === 1 ? urlParams.get('mode') : null;
      if (startMode === 'walk' || startMode === 'drive') setTimeout(() => useStore.getState().set({ mode: startMode }), 0);
      useStore.getState().set({
        loading: null,
        stats: { buildings: buildings.list.filter((b) => b.parent < 0).length, trees: trees.count, osm: world.osmTimestamp },
      });
    } catch (error) {
      console.error(error);
      if (token === this.loadToken) useStore.getState().set({ loading: null, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private applyTime(): void {
    const frame = this.world?.frame;
    this.atmosphere.setTime(this.time, frame?.lat0 ?? 54.72, frame?.lon0 ?? 55.94);
    this.renderer.toneMappingExposure = this.atmosphere.exposure;
    this.bloom.strength = this.atmosphere.bloom;
    this.props?.setLamps(shared.uLamps.value);
    NIGHT.windows.value = shared.uWindows.value;
    NIGHT.lamps.value = shared.uLamps.value;
    this.ctx.night = this.atmosphere.night;
  }

  private setMode(mode: Mode): void {
    if (!this.world || mode === this.mode) return;
    const prev = this.mode;
    const from = prev === 'overview' ? this.overview.focus : this.player ? new Vector3(this.player.x, 0, this.player.z) : this.overview.focus;
    this.overview.exit();
    this.walk.exit();
    this.drive.exit();
    this.mode = mode;
    this.select(undefined);
    if (mode === 'overview') {
      this.overview.enter();
      this.overview.flyTo(from.x, from.z, 240, true);
      this.player = undefined;
      this.camera.fov = 45;
      this.camera.near = 1;
    } else {
      // Встаём на ближайшую улицу, лицом туда, куда смотрела камера.
      const view = new Vector3();
      this.camera.getWorldDirection(view);
      const hit = this.ctx.roads.nearest(from.x, from.z, 400);
      let x = from.x, z = from.z, heading = Math.atan2(view.x, -view.z);
      if (hit) {
        const along = hit.dx * view.x + hit.dz * view.z >= 0 ? 1 : -1;
        heading = Math.atan2(hit.dx * along, -hit.dz * along);
        const lane = mode === 'drive' && !hit.road.oneway ? Math.min(hit.road.width / 4, 2) : 0;
        x = hit.x + Math.cos(heading) * lane;
        z = hit.z + Math.sin(heading) * lane;
      }
      if (mode === 'walk') {
        this.walk.enter(x, z, heading);
        this.player = this.walk;
        this.camera.fov = 68;
        this.camera.near = 0.15;
      } else {
        this.drive.enter(x, z, heading);
        this.player = this.drive;
        this.camera.fov = 58;
        this.camera.near = 0.3;
      }
    }
    this.camera.updateProjectionMatrix();
    useStore.getState().set({ street: '', speed: 0 });
  }

  /** Точка земли под точкой экрана: шагаем вдоль луча до пересечения с рельефом. */
  private groundPoint(nx: number, ny: number): Vector3 | null {
    this.raycaster.setFromCamera(new Vector2(nx, ny), this.camera);
    const { origin: o, direction: d } = this.raycaster.ray;
    const hm = this.ctx.hm;
    let t0 = 0;
    for (let t = 2; t < 30000; t += Math.max(2, t * 0.03)) {
      if (o.y + d.y * t < hm.at(o.x + d.x * t, o.z + d.z * t)) {
        let lo = t0, hi = t;
        for (let i = 0; i < 14; i++) {
          const mid = (lo + hi) / 2;
          if (o.y + d.y * mid < hm.at(o.x + d.x * mid, o.z + d.z * mid)) hi = mid;
          else lo = mid;
        }
        return new Vector3(o.x + d.x * hi, o.y + d.y * hi, o.z + d.z * hi);
      }
      t0 = t;
    }
    return null;
  }

  private pickAt(clientX: number, clientY: number): void {
    // Пока работает инструмент редактора или подложка, щелчки — их.
    if (!this.buildings || useEditStore.getState().tool || useUnderlayStore.getState().mode) return;
    const r = this.canvas.getBoundingClientRect();
    this.raycaster.setFromCamera(new Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), this.camera);
    const hit = this.raycaster.intersectObject(this.buildings.mesh, false)[0];
    const model = this.village?.pick(this.raycaster);
    if (model && (!hit || model.distance < hit.distance)) this.select(this.buildings.byId(model.id));
    else this.select(hit?.faceIndex != null ? this.buildings.pick(hit.faceIndex) : undefined);
  }

  private select(b: Building | undefined): void {
    const set = useStore.getState().set;
    if (!b) {
      this.outline.visible = false;
      if (useStore.getState().selected) set({ selected: null });
      return;
    }
    const pts: number[] = [];
    const top = b.base + (b.hasParts ? b.props.height : b.wallH);
    for (const ring of b.rings) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], c = ring[(i + 1) % ring.length];
        pts.push(a[0], top, a[1], c[0], top, c[1], a[0], b.base, a[1], c[0], b.base, c[1], a[0], b.base, a[1], a[0], top, a[1]);
      }
    }
    this.outline.geometry.dispose();
    this.outline.geometry = new BufferGeometry();
    this.outline.geometry.setAttribute('position', new BufferAttribute(new Float32Array(pts), 3));
    this.outline.visible = true;
    const p = b.props;
    const village = this.world?.territory.kind === 'village';
    const type = p.survey === 'shed' ? 'Постройка (по съёмке с дрона)' : p.survey === 'house' ? 'Дом (по съёмке с дрона)'
      : p.building === 'yes' ? (village ? (b.layout === 3 ? 'Жилой дом' : b.levels === 0 ? 'Хозяйственная постройка' : 'Здание') : 'Здание')
      : TYPE_NAMES[p.building] ?? 'Здание';
    set({
      selected: {
        id: p.id, title: p.name ?? p.address ?? type, type, address: p.address, levels: p.levels ?? (b.levels || undefined),
        height: Math.round((b.hasParts ? p.height : b.wallH + b.roofH) * 10) / 10,
        heightSource: village && p.heightSource === 'default' ? 'по правилу для деревни' : p.heightSource === 'height' ? 'из OSM' : p.heightSource === 'levels' ? 'по числу этажей' : 'по типу здания',
        area: Math.round(b.area),
      },
    });
  }

  private frame = (now: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.05, (now - this.last) / 1000);
    const raw = now - this.last;
    this.last = now;
    shared.uTime.value += dt;
    if (!this.world) return;

    const state = useStore.getState();
    if (state.flow) {
      this.time = (this.time + (dt * 24) / 360) % 24;
      this.applyTime();
    }

    const mode = this.mode === 'overview' ? this.overview : this.mode === 'walk' ? this.walk : this.drive;
    mode.update(dt);
    for (const animator of this.animators) animator(dt);
    this.treesUpdate?.(this.camera);
    if (urlParams.get('grass') !== '0') this.grass?.update(this.camera);
    this.atmosphere.update(this.camera, mode.focus, mode.shadowRadius, now);

    if (now - this.hudAt > 120) {
      this.hudAt = now;
      const patch: Record<string, unknown> = {};
      if (state.flow && Math.abs(state.time - this.time) > 0.01) patch.time = this.time;
      if (this.player) {
        const street = this.ctx.roads.nearest(this.player.x, this.player.z, 30, (r) => !!r.name)?.road.name ?? '';
        const speed = Math.round(Math.abs(this.player.speed) * 3.6);
        if (street !== state.street) patch.street = street;
        if (speed !== state.speed) patch.speed = speed;
      }
      if (Object.keys(patch).length) state.set(patch);
    }

    this.composer.render(dt);

    // Если кадр стабильно тяжёлый — снижаем разрешение, но не ниже 1.
    if (raw > 30 && raw < 200) this.slow++;
    else this.slow = Math.max(0, this.slow - 2);
    if (this.slow > 90 && this.pixelRatio > 1) {
      this.slow = 0;
      this.pixelRatio = Math.max(1, this.pixelRatio - 0.25);
      this.resize();
    }
  };
}
