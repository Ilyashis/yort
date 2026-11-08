import { buffer, lineString } from '@turf/turf';
import { useEffect, useRef, useState } from 'react';
import { Soundscape } from '../audio/Soundscape';
import { SoundZones } from '../audio/soundZones';
import { LANDMARKS } from '../config/landmarks';
import { territoryDataUrl, type Territory } from '../config/territory';
import { useAppStore } from '../store/useAppStore';
import { useEditStore } from '../store/useEditStore';
import { useUnderlayStore } from '../store/useUnderlayStore';
import { BuildingsLayer } from '../three/BuildingsLayer';
import { CityScene } from '../three/CityScene';
import { DetailsLayer } from '../three/DetailsLayer';
import { FurnitureLayer } from '../three/FurnitureLayer';
import { TIME_FLOW_HOURS_PER_SECOND } from '../three/dayNight';
import { GroundLayer } from '../three/GroundLayer';
import { LandmarksLayer } from '../three/LandmarksLayer';
import { EditLayer } from '../three/EditLayer';
import { EditorTool } from '../three/EditorTool';
import { OverviewControls } from '../three/OverviewControls';
import { PlotTool } from '../three/PlotTool';
import { UserBuildingsLayer } from '../three/UserBuildingsLayer';
import { TreesLayer } from '../three/TreesLayer';
import { UnderlayLayer } from '../three/UnderlayLayer';
import { WalkController } from '../three/WalkController';
import { flyToArea, flyToTerritory, setIntroView } from '../three/views';
import { ROAD_KINDS, toFeature } from '../world/edit/edits';
import { loadEnvironment, polygonsOfGround } from '../world/base/environment';
import { findStreetFrontBuildings, nearNamedStreet } from '../world/base/facades';
import { BARE_GROUND_COLOR, VILLAGE_GROUND_COLOR } from '../world/base/groundStyle';
import { decodeTerrainFile, type TerrainFile, type TerrainKind } from '../world/base/heightGrid';
import { computeStats, loadBaseBuildings, loadBuildingParts } from '../world/base/loadBaseBuildings';
import { assignParts } from '../world/base/parts';
import { landmarkClearance, landmarkObstacle } from '../world/base/pedestal';
import { orientBenches, placeLamps, roadMarkings } from '../world/base/streetFurniture';
import { scatterForest, scatterTrees, scatterYardTrees } from '../world/base/vegetation';
import { planYards, VILLAGE_HOUSE_TYPES } from '../world/base/yards';
import { analyzePlot } from '../world/user/plot';
import { toObstacle, toProperties, userBuildingId } from '../world/user/userBuildings';
import { Collider } from '../world/walk/collider';
import { createLocalFrame, toLocalPolygon, type Vec2 } from '../world/walk/localFrame';
import { StreetIndex } from '../world/walk/streets';

/** Рельеф района: сетка DEM из terrain.json; нет файла — плоская земля. */
async function loadHeights(territory: Territory): Promise<{ heightAt: (lon: number, lat: number) => number; kind: TerrainKind; credit?: string }> {
  try {
    const response = await fetch(territoryDataUrl(territory, 'terrain.json'));
    if (response.ok) {
      const file = (await response.json()) as TerrainFile;
      const grid = decodeTerrainFile(file);
      return { heightAt: (lon, lat) => grid.heightAt(lon, lat), kind: 'dem', credit: file.metadata.credit };
    }
  } catch (error) {
    console.warn('[terrain] не удалось загрузить terrain.json, рельеф будет плоским', error);
  }
  return { heightAt: () => 0, kind: 'flat' };
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
      const heights = await loadHeights(territory);
      if (disposed) return;
      store.setTerrain(heights.kind);
      setCredit(heights.credit);

      const { south, west, north, east } = territory.bbox;
      const village = territory.kind === 'village';
      // Локальные метры вокруг центра района: вся геометрия сцены, прогулка, редактор.
      const frame = createLocalFrame([(west + east) / 2, (south + north) / 2]);
      const [x0, y0] = frame.toLocal([west, south]);
      const [x1, y1] = frame.toLocal([east, north]);
      const area = { x0, y0, x1, y1 };
      const localHeight = (x: number, y: number) => heights.heightAt(...frame.toLonLat([x, y]));

      const c = new CityScene(container!, { lat: (south + north) / 2, lon: (west + east) / 2 });
      city = c;
      if (import.meta.env.DEV) (window as unknown as { __city?: CityScene }).__city = c;
      c.setGroundSampler((x, z) => localHeight(x, -z));

      // Время суток — из стора; если «время идёт», сутки проходят за 6 минут.
      c.setTime(useAppStore.getState().timeOfDay);
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
      setIntroView(c, territory, frame, localHeight);
      store.setFlyHome(() => flyToTerritory(c, territory, frame, localHeight, 1.5));

      const [collection, buildingParts, environment] = await Promise.all([
        loadBaseBuildings(territory),
        loadBuildingParts(territory),
        loadEnvironment(territory),
      ]);
      if (disposed) return;

      const buildingFootprints = collection.features.flatMap((f) => (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates));
      const localBuildings = buildingFootprints.map((rings) => toLocalPolygon(rings, frame));
      const roadSurfaces = environment.ground
        .filter((f) => f.properties.kind === 'road')
        .flatMap(polygonsOfGround)
        .map((rings) => toLocalPolygon(rings, frame));
      const markings = roadMarkings(environment.streets, frame, roadSurfaces);
      const bareGround = village ? VILLAGE_GROUND_COLOR : BARE_GROUND_COLOR;
      // Деревня: дворы у домов — забор с воротами и огород за домом (в OSM участков нет).
      const yards = village
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
      const gardens = yards.flatMap((yard) =>
        yard.garden
          ? [{ ring: [...yard.garden.corners, yard.garden.corners[0]].map(frame.toLonLat), rows: yard.garden.rows, seed: yard.seed, houseId: yard.houseId }]
          : [],
      );

      const ground = new GroundLayer(c, heights, frame, area, [...environment.ground, ...markings], gardens, bareGround, !village, c.csm);
      owned.push(ground);
      if (import.meta.env.DEV) (window as unknown as { __ground?: GroundLayer }).__ground = ground;

      const landmarks = LANDMARKS.filter(({ position: [lon, lat] }) => lon >= west && lon <= east && lat >= south && lat <= north);
      const parkTrees = [
        ...environment.trees,
        ...scatterTrees(environment.ground, environment.trees, [...buildingFootprints, ...landmarks.map((l) => landmarkClearance(l))]),
        // В деревне деревья растут во дворах, а в OSM их там почти не отмечают.
        ...(village
          ? scatterYardTrees(
              collection.features.flatMap((f) =>
                (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates).map((rings, i) => ({ id: `${f.properties.id}:${i}`, rings })),
              ),
              environment.ground,
            )
          : []),
      ];
      // Лесные массивы: упрощённые деревья, число ограничено.
      const forestTrees = scatterForest(environment.ground, buildingFootprints);
      const lamps = placeLamps(environment.streets, frame, roadSurfaces, localBuildings, village ? { spacing: 45, bothSides: false } : {});
      const benches = orientBenches(environment.streets, frame);
      // Витрины и вывески — только в городе.
      const streetFront = village ? new Set<string>() : findStreetFrontBuildings(collection.features, environment.ground, frame);
      const parts = assignParts(collection.features, buildingParts);

      const buildings = new BuildingsLayer(c, collection, parts, frame, localHeight, village, streetFront, c.csm);
      owned.push(buildings);
      const details = new DetailsLayer(
        c,
        buildings.shapes(),
        { frame, isStreetSide: nearNamedStreet(environment.ground, frame, 15), heightAt: localHeight, yards },
        c.csm,
      );
      owned.push(details);
      const trees = new TreesLayer(c, [...parkTrees, ...forestTrees], parkTrees.length, frame, localHeight, c.csm);
      owned.push(trees);
      const furniture = new FurnitureLayer(c, lamps, benches, frame, localHeight, c.csm);
      owned.push(furniture);
      ground.setLamps(furniture.lampSpots());
      const monuments = await LandmarksLayer.create(c, landmarks, frame, localHeight, c.csm);
      owned.push(monuments);
      if (disposed) return;
      store.setStats(computeStats(collection));

      // Пьедесталы памятников мешают проходу так же, как здания.
      const obstacles = [...collection.features, ...landmarks.map(landmarkObstacle)];
      const collider = new Collider(obstacles, frame);

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
        collider.setIgnored(new Set(edits.removedBuildings));
        collider.setExtraObstacles([...userBuildings.map(toObstacle), ...edits.buildings.map(toFeature)]);
        const footprints = [
          ...userBuildings.map((b) => b.building.footprint),
          ...(preview ? [preview.footprint] : []),
          ...edits.buildings.map((b) => b.footprint),
        ];
        // Новые дороги: полоса проезжей части — деревья и фонари с неё убираем.
        const newRoads = edits.roads.flatMap((r) => {
          const strip = buffer(lineString(r.axis), ROAD_KINDS[r.kind].width / 2 + 0.5, { units: 'meters', steps: 4 })?.geometry;
          if (!strip) return [];
          return strip.type === 'Polygon' ? [strip.coordinates[0] as [number, number][]] : strip.coordinates.map((p) => p[0] as [number, number][]);
        });
        trees.hideWithin([...footprints, ...newRoads], 2);
        // Фонари у убранных дорог тоже уходят: проезжая часть + отступ фонаря от бордюра.
        const removedRoads = edits.removedRoads.flatMap((key) => ground.roadOutline(key).map((rings) => rings[0] ?? []));
        if (furniture.hideWithin([...footprints, ...newRoads, ...removedRoads], 2)) ground.setLamps(furniture.lampSpots());
      };

      // Камера над городом: мышь как в стройках, WASD/QE/RF, двойной клик — подлёт. На прогулке выключено.
      const overview = new OverviewControls(c, (x, z) => localHeight(x, -z), () => useAppStore.getState().mode !== 'walk');
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
      const walk = new WalkController(c, frame, collider, new StreetIndex(environment.ground, frame), localHeight, {
        onExit: () => store.setMode('explore'),
        onStreet: (street) => store.setWalkStreet(street),
        onMove: (distance, running, position) => soundscape.walked(distance, running, position),
        onMouseLock: (locked) => store.setWalkMouseLocked(locked),
      });
      owned.push(walk);

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
        details.setVisible(show);
        trees.setVisible(show);
      };
      const unsubscribeUnderlay = useUnderlayStore.subscribe((state, prev) => {
        if (state.hideCity !== prev.hideCity) showCity(!state.hideCity);
      });
      owned.push({ destroy: unsubscribeUnderlay });

      // Редактор: свои и изменённые дома, дороги и заборы поверх Base World (как в градостроителях).
      const editStore = useEditStore.getState();
      editStore.load(territory.id);
      const editLayer = new EditLayer(c, frame, localHeight, village);
      owned.push(editLayer);
      const editor = new EditorTool({
        city: c,
        frame,
        base: buildings,
        layer: editLayer,
        ground,
        controls: overview,
        village,
        osmRoads: environment.streets.roads.map((r) => r.coords.map(frame.toLocal)),
        osmBuildings: collection.features,
        yards,
      });
      owned.push(editor);
      editStore.setResolver((id) => editor.resolve(id));

      /** Правки → сцена: что скрыть из OSM, что дорисовать, кто мешает пешеходу. */
      const applyEdits = () => {
        const { edits, selection } = useEditStore.getState();
        const removed = new Set(edits.removedBuildings);
        // Удалённые (а не сдвинутые или перестроенные) дома уходят вместе с двором и огородом.
        const replaced = new Set(edits.buildings.map((b) => b.source).filter((s): s is string => !!s));
        const deleted = new Set([...removed].filter((id) => !replaced.has(id)));
        buildings.setHidden(removed);
        details.setHidden(removed, new Set(edits.removedYards), deleted);
        const yardOwner = (houseId: string) => houseId.slice(0, houseId.lastIndexOf(':'));
        ground.setEdits({
          removedRoads: new Set(edits.removedRoads),
          addedRoads: edits.roads.map((r) => ({ kind: r.kind, axis: r.axis })),
          hiddenGardens: new Set([...edits.removedYards, ...yards.filter((y) => deleted.has(yardOwner(y.houseId))).map((y) => y.houseId)]),
        });
        editLayer.render(edits, selection?.type === 'building' ? selection.id : undefined);
        refreshObstacles();
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
        if (selection?.type === 'road') {
          const road = edits.roads.find((r) => r.id === selection.id);
          lines = road ? [road.axis] : ground.roadOutline(selection.id).map((rings) => rings[0] ?? []);
        } else if (selection?.type === 'fence') {
          const fence = edits.fences.find((f) => f.id === selection.id);
          const yard = yards.find((y) => y.houseId === selection.id);
          lines = fence ? [fence.line] : (yard?.fence ?? []).map((segment) => segment.map(frame.toLonLat));
        }
        editLayer.highlight(lines);
      };
      applyEdits();
      const unsubscribeEdits = useEditStore.subscribe((state, prev) => {
        if (state.edits !== prev.edits) applyEdits();
        else if (state.selection !== prev.selection) {
          editLayer.render(state.edits, state.selection?.type === 'building' ? state.selection.id : undefined);
          showSelection();
        }
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
          s.setTool(undefined);
          s.select(undefined);
        },
      });

      // Чёткая земля — вокруг взгляда: у пешехода впереди, в обзоре — вокруг точки вращения (ближе к камере).
      ground.setFocus((distance) => {
        if (walk.isWalking) return walk.pointAhead(distance);
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
          return false;
        }),
      });

      store.setWalkControls({
        pickStart: () => {
          store.selectBuilding(undefined);
          store.setMode('pick-walk-start');
          c.canvas.style.cursor = 'crosshair';
        },
        cancelPick: () => {
          store.setMode('explore');
          c.canvas.style.cursor = '';
        },
        exit: () => walk.exit(),
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
        } else if (mode === 'explore') {
          // Включён инструмент редактора или подложку двигают/совмещают — клики обрабатывают они.
          if (useEditStore.getState().tool || useUnderlayStore.getState().mode) return;
          const hit = c.pickObject(event.clientX, event.clientY, [...buildings.pickables, ...userLayer.pickables]);
          const ownId = userLayer.idFromPick(hit);
          const own = ownId && useAppStore.getState().userBuildings.find((b) => userBuildingId(b.id) === ownId);
          store.selectBuilding(own ? toProperties(own) : buildings.buildingFromPick(hit));
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
        if (state.graphicsQuality !== prev.graphicsQuality) c.setQuality(state.graphicsQuality);
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
      // Всё загружено — плавный пролёт к району.
      flyToTerritory(c, territory, frame, localHeight, 3.2);
    }

    init().catch((error: unknown) => {
      if (disposed) return;
      console.error(error);
      store.setStatus('error', error instanceof Error ? error.message : String(error));
    });

    // Esc отменяет выбор точки старта прогулки (сама прогулка ловит Esc в контроллере).
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === 'Escape' && useAppStore.getState().mode === 'pick-walk-start') {
        useAppStore.getState().walkControls?.cancelPick();
      }
    };
    window.addEventListener('keydown', onKeyDown);

    return () => {
      disposed = true;
      window.removeEventListener('keydown', onKeyDown);
      for (const item of owned.reverse()) item.destroy();
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
