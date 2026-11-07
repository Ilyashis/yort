import {
  Cartographic,
  Math as CesiumMath,
  Color,
  Credit,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  type Viewer,
} from 'cesium';
import { useEffect, useRef } from 'react';
import { Soundscape } from '../audio/Soundscape';
import { SoundZones } from '../audio/soundZones';
import { OverviewControls } from '../cesium/OverviewControls';
import { PlotDrawingTool } from '../cesium/PlotDrawingTool';
import { WalkController } from '../cesium/WalkController';
import {
  createViewer,
  flyToArea,
  flyToTerritory,
  setGraphicsQuality,
  setIntroView,
  skipBaseMapUnder,
  territoryCenter,
  changeViewMode,
  viewModeOf,
} from '../cesium/createViewer';
import { pickGround, toLonLat } from '../cesium/pick';
import { createTerrain, heightSampler } from '../cesium/terrain';
import type { Territory } from '../config/territory';
import { useAppStore } from '../store/useAppStore';
import { LANDMARKS } from '../config/landmarks';
import { BaseBuildingsLayer } from '../world/base/BaseBuildingsLayer';
import { BARE_GROUND_COLOR, GroundLayer, VILLAGE_GROUND_COLOR } from '../world/base/GroundLayer';
import { LandmarksLayer, landmarkClearance, landmarkObstacle } from '../world/base/LandmarksLayer';
import { StreetFurnitureLayer } from '../world/base/StreetFurnitureLayer';
import { EditorTool } from '../cesium/EditorTool';
import { useEditStore } from '../store/useEditStore';
import { useUnderlayStore } from '../store/useUnderlayStore';
import { UnderlayController } from '../cesium/UnderlayController';
import { BuildingDetailsLayer } from '../world/base/BuildingDetailsLayer';
import { ROAD_KINDS, toFeature } from '../world/edit/edits';
import { buffer, lineString } from '@turf/turf';
import { EditLayer } from '../world/edit/EditLayer';
import { findStreetFrontBuildings, nearNamedStreet } from '../world/base/facades';
import { assignParts } from '../world/base/parts';
import { planYards, VILLAGE_HOUSE_TYPES } from '../world/base/yards';
import { orientBenches, placeLamps, roadMarkings } from '../world/base/streetFurniture';
import { TreesLayer } from '../world/base/TreesLayer';
import { loadEnvironment, polygonsOfGround } from '../world/base/environment';
import { computeStats, loadBaseBuildings, loadBuildingParts } from '../world/base/loadBaseBuildings';
import { scatterForest, scatterTrees, scatterYardTrees } from '../world/base/vegetation';
import { analyzePlot } from '../world/user/plot';
import { UserBuildingsLayer, toObstacle, toProperties, userBuildingId } from '../world/user/UserBuildingsLayer';
import { Collider } from '../world/walk/collider';
import { createLocalFrame, toLocalPolygon } from '../world/walk/localFrame';
import { StreetIndex } from '../world/walk/streets';

/** 3D-сцена: создаёт Cesium Viewer, загружает Base World, связывает инструменты со стором. */
export function CityViewer({ territory }: { territory: Territory }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const store = useAppStore.getState();
    let disposed = false;
    let viewer: Viewer | undefined;
    const owned: { destroy: () => void }[] = [];
    let clickHandler: ScreenSpaceEventHandler | undefined;
    let unsubscribe: (() => void) | undefined;

    async function init() {
      store.setStatus('loading');

      const terrain = await createTerrain(territory);
      if (disposed) return;
      store.setTerrain(terrain.kind);

      const v = createViewer(container!, terrain.provider);
      viewer = v;
      // Только в dev: доступ к сцене из консоли браузера для отладки.
      if (import.meta.env.DEV) (window as unknown as { __citiaViewer?: Viewer }).__citiaViewer = v;
      if (terrain.credit) v.creditDisplay.addStaticCredit(new Credit(terrain.credit));

      // Высота земли в любой точке — для камеры, прогулки, своих зданий и звука.
      const heightAt = heightSampler(terrain, (lon, lat) =>
        v.isDestroyed() ? undefined : v.scene.globe.getHeight(Cartographic.fromDegrees(lon, lat)),
      );
      const { south: s, west: w, north: n, east: e } = territory.bbox;
      const centerGround = heightAt((w + e) / 2, (s + n) / 2);

      // Пока грузятся данные — вид издалека; когда всё готово, камера плавно прилетит к району.
      setIntroView(v, territory);
      setGraphicsQuality(v, useAppStore.getState().graphicsQuality);
      store.setFlyHome(() => flyToTerritory(v, territory, 1.5, centerGround));

      const [collection, buildingParts, environment] = await Promise.all([
        loadBaseBuildings(territory),
        loadBuildingParts(territory),
        loadEnvironment(territory),
      ]);
      if (disposed) return;

      // Локальные метры вокруг центра района: прогулка, витрины, фонари, разметка.
      const { south, west, north, east } = territory.bbox;
      const frame = createLocalFrame([(west + east) / 2, (south + north) / 2]);
      const buildingFootprints = collection.features.flatMap((f) =>
        f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates,
      );
      const localBuildings = buildingFootprints.map((rings) => toLocalPolygon(rings, frame));
      const roadSurfaces = environment.ground
        .filter((f) => f.properties.kind === 'road')
        .flatMap(polygonsOfGround)
        .map((rings) => toLocalPolygon(rings, frame));

      // Поверхности земли (с разметкой). Добавленные в сцену примитивы уничтожит сам Viewer.
      const markings = roadMarkings(environment.streets, frame, roadSurfaces);
      const bareGround = territory.kind === 'village' ? VILLAGE_GROUND_COLOR : BARE_GROUND_COLOR;
      // Деревня: дворы у домов — забор с воротами и огород за домом (в OSM участков нет).
      const yards =
        territory.kind === 'village'
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
          ? [
              {
                ring: [...yard.garden.corners, yard.garden.corners[0]].map(frame.toLonLat),
                rows: yard.garden.rows,
                seed: yard.seed,
                houseId: yard.houseId,
              },
            ]
          : [],
      );
      const ground = GroundLayer.create(
        [...environment.ground, ...markings],
        terrain.kind,
        bareGround,
        gardens,
        territory.kind !== 'village',
      );
      ground.addTo(v);
      owned.push(ground);
      if (ground.landBounds) skipBaseMapUnder(v, ground.landBounds);

      const landmarks = LANDMARKS.filter(
        ({ position: [lon, lat] }) => lon >= west && lon <= east && lat >= south && lat <= north,
      );
      const village = territory.kind === 'village';
      const allTrees = [
        ...environment.trees,
        ...scatterTrees(environment.ground, environment.trees, [
          ...buildingFootprints,
          ...landmarks.map((l) => landmarkClearance(l)),
        ]),
        // В деревне деревья растут во дворах, а в OSM их там почти не отмечают.
        ...(village
          ? scatterYardTrees(
              collection.features.flatMap((f) =>
                (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates).map((rings, i) => ({
                  id: `${f.properties.id}:${i}`,
                  rings,
                })),
              ),
              environment.ground,
            )
          : []),
      ];
      // Лесные массивы: упрощённые деревья, число ограничено.
      const forestTrees = scatterForest(environment.ground, buildingFootprints);
      // В деревне фонари реже и по одной стороне улицы.
      const lamps = placeLamps(
        environment.streets,
        frame,
        roadSurfaces,
        localBuildings,
        village ? { spacing: 45, bothSides: false } : {},
      );
      const benches = orientBenches(environment.streets, frame);
      // Витрины и вывески — только в городе; в деревне у домов вдоль улицы их нет.
      const streetFront = village ? new Set<string>() : findStreetFrontBuildings(collection.features, environment.ground, frame);
      // Части зданий (building:part) рисуются вместо общего контура: башни, купола, ступени этажности.
      const parts = assignParts(collection.features, buildingParts);

      const [buildings, trees, furniture, monuments] = await Promise.all([
        BaseBuildingsLayer.create(
          v.scene,
          collection,
          terrain.provider,
          territoryCenter(territory),
          frame,
          streetFront,
          parts,
          village,
        ),
        TreesLayer.create(allTrees, terrain.provider, forestTrees),
        StreetFurnitureLayer.create(lamps, benches, terrain.provider),
        LandmarksLayer.create(landmarks, terrain.provider),
      ]);
      if (disposed) {
        buildings.destroy();
        trees.destroy();
        furniture.destroy();
        monuments.destroy();
        return;
      }
      v.scene.primitives.add(trees.primitive);
      v.scene.primitives.add(furniture.primitive);
      for (const primitive of buildings.primitives) v.scene.primitives.add(primitive);
      // Балконы, подъезды и карнизы; подъезды — со двора, не на улицу.
      const details = BuildingDetailsLayer.create(buildings.shapes(), {
        yards,
        frame,
        center: territoryCenter(territory),
        isStreetSide: nearNamedStreet(environment.ground, frame, 15),
        heightAt,
      });
      if (details.primitive) v.scene.primitives.add(details.primitive);
      // Скрытие деталей убранных домов применяется, когда примитив деталей соберётся.
      const removeDetailsApply = v.scene.postRender.addEventListener(() => {
        if (details.apply()) v.scene.requestRender();
      });
      owned.push({ destroy: removeDetailsApply });
      monuments.addTo(v.scene);
      buildings.renderUntilReady();
      store.setStats(computeStats(collection));
      // Пьедесталы памятников мешают проходу и стройке так же, как здания.
      const obstacles = [...collection.features, ...landmarks.map(landmarkObstacle)];
      // Здания пользователя (User World) — отдельным слоем поверх Base World.
      const userLayer = new UserBuildingsLayer(v.scene, territoryCenter(territory), heightAt);
      owned.push(userLayer);
      const userObstacles = () => useAppStore.getState().userBuildings.map(toObstacle);

      // Участок: инструмент рисует, проверка идёт против Base World и уже построенного, результат — в стор.
      const plotTool = new PlotDrawingTool(
        v,
        {
          onChange: (points) => store.setPlotDraft(points),
          onFinish: (points) => {
            const plot = analyzePlot(points, [...obstacles, ...userObstacles()], territory.bbox);
            buildings.setConflicts(plot.conflictingBuildingIds);
            plotTool.showResult(plot.valid);
            store.plotFinished(plot);
          },
          onCancel: () => store.plotDrawingCancelled(),
        },
        terrain.kind !== 'flat',
      );
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

      // Звук: музыка и звуки города по месту, где сейчас камера или пешеход.
      const soundscape = new Soundscape(new SoundZones(environment.ground, frame, village), () => {
        if (v.isDestroyed()) return undefined;
        const c = v.camera.positionCartographic;
        const lonLat: [number, number] = [CesiumMath.toDegrees(c.longitude), CesiumMath.toDegrees(c.latitude)];
        return { point: frame.toLocal(lonLat), altitude: c.height - heightAt(...lonLat) };
      });
      soundscape.setEnabled(useAppStore.getState().soundOn);
      soundscape.setVolumes(useAppStore.getState().volumes);
      owned.push(soundscape);
      if (import.meta.env.DEV) (window as unknown as { __citiaSound?: Soundscape }).__citiaSound = soundscape;

      // Прогулка: столкновения со зданиями, памятниками и постройками пользователя, названия улиц.
      const collider = new Collider(obstacles, frame);
      const walk = new WalkController(
        v,
        frame,
        collider,
        new StreetIndex(environment.ground, frame),
        Color.fromCssColorString(bareGround),
        heightAt,
        {
          onExit: () => store.setMode('explore'),
          onStreet: (street) => store.setWalkStreet(street),
          onMove: (distance, running, position) => soundscape.walked(distance, running, position),
          onMouseLock: (locked) => store.setWalkMouseLocked(locked),
        },
      );
      owned.push(walk);

      // Редактор: свои и изменённые дома, дороги и заборы поверх Base World (как в градостроителях).
      const editStore = useEditStore.getState();
      editStore.load(territory.id);
      const editLayer = new EditLayer(v, frame, territoryCenter(territory), heightAt, village);
      owned.push(editLayer);
      const editor = new EditorTool({
        viewer: v,
        frame,
        base: buildings,
        layer: editLayer,
        ground,
        village,
        osmRoads: environment.streets.roads.map((r) => r.coords.map(frame.toLocal)),
        osmBuildings: collection.features,
        yards,
      });
      owned.push(editor);
      editStore.setResolver((id) => editor.resolve(id));

      // Подложка: свой снимок сверху, по которому обводят дома и заборы.
      const underlay = new UnderlayController(v, frame);
      owned.push(underlay);
      void useUnderlayStore.getState().load(territory.id);
      // При обводке дома и деревья OSM можно спрятать — снимок под ними станет виден.
      const showCity = (show: boolean) => {
        for (const primitive of buildings.primitives) primitive.show = show;
        if (details.primitive) details.primitive.show = show;
        trees.primitive.show = show;
        v.scene.requestRender();
      };
      const unsubscribeUnderlay = useUnderlayStore.subscribe((state, prev) => {
        if (state.hideCity !== prev.hideCity) showCity(!state.hideCity);
      });
      owned.push({ destroy: unsubscribeUnderlay });

      /** Препятствия и скрытие деревьев/фонарей: здания из конструктора + свои дома + убранные дороги. */
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
        trees.visibility.hideWithin(v.scene, [...footprints, ...newRoads], 2);
        // Фонари у убранных дорог тоже уходят: проезжая часть + отступ фонаря от бордюра.
        const removedRoads = edits.removedRoads.flatMap((key) => ground.roadOutline(key).map((rings) => rings[0] ?? []));
        furniture.visibility.hideWithin(v.scene, [...footprints, ...newRoads, ...removedRoads], 2);
      };

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
          hiddenGardens: new Set([
            ...edits.removedYards,
            ...yards.filter((y) => deleted.has(yardOwner(y.houseId))).map((y) => y.houseId),
          ]),
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
          v.canvas.style.cursor = state.tool && state.tool !== 'select' ? 'crosshair' : '';
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

      // «Юбки» тайлов рельефа закрывают щели на стыках разных уровней детализации, но их
      // микроступеньки затенение в углах (AO) превращает в тёмный пунктир — сетку по земле.
      // На обычных видах соседние тайлы почти одинаковые и щели волосяные — юбки выключаем;
      // оставляем только для самого дальнего вида, где уровни тайлов различаются сильнее.
      const SKIRTS_FROM_ALTITUDE = 3000;
      const removeSkirtsToggle = v.scene.preRender.addEventListener(() => {
        const c = v.camera.positionCartographic;
        const altitude = c.height - heightAt(CesiumMath.toDegrees(c.longitude), CesiumMath.toDegrees(c.latitude));
        v.scene.globe.showSkirts = altitude > SKIRTS_FROM_ALTITUDE;
      });
      owned.push({ destroy: removeSkirtsToggle });

      // Камера над городом: мышь как в стройках, WASD/QE/RF, двойной клик — подлёт. На прогулке выключено.
      const overview = new OverviewControls(v, {
        heightAt,
        isActive: () => useAppStore.getState().mode !== 'walk',
      });
      owned.push(overview);

      // Вид сверху / под углом: кнопка в углу; подсветка — по фактическому наклону камеры.
      store.setChangeView((mode) => changeViewMode(v, mode, heightAt));
      const removeViewWatch = v.camera.moveEnd.addEventListener(() => store.setViewMode(viewModeOf(v)));
      owned.push({ destroy: removeViewWatch });
      owned.push({ destroy: () => store.setChangeView(undefined) });
      if (import.meta.env.DEV) (window as unknown as { __citiaOverview?: OverviewControls }).__citiaOverview = overview;

      store.setWalkControls({
        pickStart: () => {
          store.selectBuilding(undefined);
          store.setMode('pick-walk-start');
          v.canvas.style.cursor = 'crosshair';
        },
        cancelPick: () => {
          store.setMode('explore');
          v.canvas.style.cursor = '';
        },
        exit: () => walk.exit(),
      });

      // Левый клик: зависит от режима — вершина участка, старт прогулки или выбор здания.
      clickHandler = new ScreenSpaceEventHandler(v.scene.canvas);
      clickHandler.setInputAction((event: ScreenSpaceEventHandler.PositionedEvent) => {
        const { mode } = useAppStore.getState();
        if (mode === 'draw-plot') {
          plotTool.handleClick(event.position);
        } else if (mode === 'pick-walk-start') {
          const point = pickGround(v, event.position);
          if (!point) return;
          store.setMode('walk');
          walk.enter(toLonLat(point), v.camera.heading);
        } else if (mode === 'explore') {
          // Включён инструмент редактора или подложку двигают/совмещают — клики обрабатывают они.
          if (useEditStore.getState().tool || useUnderlayStore.getState().mode) return;
          const picked = v.scene.pick(event.position);
          const ownId = userLayer.idFromPick(picked);
          const own = ownId && useAppStore.getState().userBuildings.find((b) => userBuildingId(b.id) === ownId);
          store.selectBuilding(own ? toProperties(own) : buildings.buildingFromPick(picked));
        }
      }, ScreenSpaceEventType.LEFT_CLICK);

      // Сцена следует за стором: подсветка, раскраска, здания пользователя и предпросмотр.
      unsubscribe = useAppStore.subscribe((state, prev) => {
        if (state.selectedBuilding !== prev.selectedBuilding) buildings.select(state.selectedBuilding?.id);
        if (state.buildingColorMode !== prev.buildingColorMode) buildings.setColorMode(state.buildingColorMode);
        if (state.builder !== prev.builder || state.userBuildings !== prev.userBuildings) {
          const preview = state.builder?.result.building;
          userLayer.render(
            state.userBuildings,
            preview && state.builder ? { id: 'preview', spec: state.builder.spec, building: preview } : undefined,
          );
          // Деревья, фонари и скамейки на пятне застройки убираем (и возвращаем, если здание снесли).
          refreshObstacles();
        }
        // Открыли конструктор — показываем участок крупно в свободной от панели части экрана.
        if (state.builder && !prev.builder && state.plot) {
          const sidebar = document.querySelector('.sidebar');
          const sidebarShare = sidebar ? (sidebar.getBoundingClientRect().right + 16) / v.canvas.clientWidth : 0;
          const [plotLon, plotLat] = state.plot.polygon[0] ?? [0, 0];
          flyToArea(
            v,
            state.plot.polygon,
            state.builder.result.building?.totalHeight ?? 30,
            Math.min(sidebarShare, 0.6),
            heightAt(plotLon, plotLat),
          );
        }
        if (state.soundOn !== prev.soundOn) soundscape.setEnabled(state.soundOn);
        if (state.volumes !== prev.volumes) soundscape.setVolumes(state.volumes);
        if (state.graphicsQuality !== prev.graphicsQuality) setGraphicsQuality(v, state.graphicsQuality);
      });
      buildings.setColorMode(useAppStore.getState().buildingColorMode);

      store.setStatus('ready');
      // Всё загружено — плавный пролёт к району.
      flyToTerritory(v, territory, 3.2, centerGround);
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
      unsubscribe?.();
      clickHandler?.destroy();
      for (const item of owned) item.destroy();
      // Viewer уничтожает и добавленные в сцену примитивы (здания, деревья, земля).
      if (viewer && !viewer.isDestroyed()) viewer.destroy();
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

  return <div ref={containerRef} className="city-viewer" />;
}
