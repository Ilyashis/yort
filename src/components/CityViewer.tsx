import { Color, ScreenSpaceEventHandler, ScreenSpaceEventType, type Viewer } from 'cesium';
import { useEffect, useRef } from 'react';
import { PlotDrawingTool } from '../cesium/PlotDrawingTool';
import { WalkController } from '../cesium/WalkController';
import { createViewer, flyToArea, flyToTerritory, territoryCenter } from '../cesium/createViewer';
import { pickGround, toLonLat } from '../cesium/pick';
import { createTerrain } from '../cesium/terrain';
import { territory } from '../config/territory';
import { useAppStore } from '../store/useAppStore';
import { LANDMARKS } from '../config/landmarks';
import { BaseBuildingsLayer } from '../world/base/BaseBuildingsLayer';
import { BARE_GROUND_COLOR, GroundLayer } from '../world/base/GroundLayer';
import { LandmarksLayer, landmarkClearance, landmarkObstacle } from '../world/base/LandmarksLayer';
import { StreetFurnitureLayer } from '../world/base/StreetFurnitureLayer';
import { findStreetFrontBuildings } from '../world/base/facades';
import { orientBenches, placeLamps, roadMarkings } from '../world/base/streetFurniture';
import { TreesLayer } from '../world/base/TreesLayer';
import { loadEnvironment, polygonsOfGround } from '../world/base/environment';
import { computeStats, loadBaseBuildings } from '../world/base/loadBaseBuildings';
import { scatterTrees } from '../world/base/vegetation';
import { analyzePlot } from '../world/user/plot';
import { UserBuildingsLayer, toObstacle, toProperties, userBuildingId } from '../world/user/UserBuildingsLayer';
import { Collider } from '../world/walk/collider';
import { createLocalFrame, toLocalPolygon } from '../world/walk/localFrame';
import { StreetIndex } from '../world/walk/streets';

/** 3D-сцена: создаёт Cesium Viewer, загружает Base World, связывает инструменты со стором. */
export function CityViewer() {
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

      const terrain = await createTerrain();
      if (disposed) return;
      store.setTerrain(terrain.kind);

      const v = createViewer(container!, terrain.provider);
      viewer = v;
      // Только в dev: доступ к сцене из консоли браузера для отладки.
      if (import.meta.env.DEV) (window as unknown as { __citiaViewer?: Viewer }).__citiaViewer = v;
      flyToTerritory(v, territory, 0);
      store.setFlyHome(() => flyToTerritory(v, territory));

      const [collection, environment] = await Promise.all([
        loadBaseBuildings(territory),
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
      GroundLayer.create([...environment.ground, ...markings], terrain.kind).addTo(v.scene);

      const landmarks = LANDMARKS.filter(
        ({ position: [lon, lat] }) => lon >= west && lon <= east && lat >= south && lat <= north,
      );
      const allTrees = [
        ...environment.trees,
        ...scatterTrees(environment.ground, environment.trees, [
          ...buildingFootprints,
          ...landmarks.map((l) => landmarkClearance(l)),
        ]),
      ];
      const lamps = placeLamps(environment.streets, frame, roadSurfaces, localBuildings);
      const benches = orientBenches(environment.streets, frame);
      const streetFront = findStreetFrontBuildings(collection.features, environment.ground, frame);

      const [buildings, trees, furniture, monuments] = await Promise.all([
        BaseBuildingsLayer.create(v.scene, collection, terrain.provider, territoryCenter(territory), streetFront),
        TreesLayer.create(allTrees, terrain.provider),
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
      v.scene.primitives.add(buildings.primitive);
      monuments.addTo(v.scene);
      buildings.renderUntilReady();
      store.setStats(computeStats(collection));
      // Пьедесталы памятников мешают проходу и стройке так же, как здания.
      const obstacles = [...collection.features, ...landmarks.map(landmarkObstacle)];
      // Здания пользователя (User World) — отдельным слоем поверх Base World.
      const userLayer = new UserBuildingsLayer(v.scene, territoryCenter(territory));
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

      // Прогулка: столкновения со зданиями, памятниками и постройками пользователя, названия улиц.
      const collider = new Collider(obstacles, frame);
      const walk = new WalkController(
        v,
        frame,
        collider,
        new StreetIndex(environment.ground, frame),
        Color.fromCssColorString(BARE_GROUND_COLOR),
        {
          onExit: () => store.setMode('explore'),
          onStreet: (street) => store.setWalkStreet(street),
        },
      );
      owned.push(walk);
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
          collider.setExtraObstacles(state.userBuildings.map(toObstacle));
          // Деревья, фонари и скамейки на пятне застройки убираем (и возвращаем, если здание снесли).
          const footprints = [...state.userBuildings.map((b) => b.building.footprint), ...(preview ? [preview.footprint] : [])];
          trees.visibility.hideWithin(v.scene, footprints, 2);
          furniture.visibility.hideWithin(v.scene, footprints, 0.5);
        }
        // Открыли конструктор — показываем участок крупно в свободной от панели части экрана.
        if (state.builder && !prev.builder && state.plot) {
          const sidebar = document.querySelector('.sidebar');
          const sidebarShare = sidebar ? (sidebar.getBoundingClientRect().right + 16) / v.canvas.clientWidth : 0;
          flyToArea(v, state.plot.polygon, state.builder.result.building?.totalHeight ?? 30, Math.min(sidebarShare, 0.6));
        }
      });
      buildings.setColorMode(useAppStore.getState().buildingColorMode);

      store.setStatus('ready');
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
  }, []);

  return <div ref={containerRef} className="city-viewer" />;
}
