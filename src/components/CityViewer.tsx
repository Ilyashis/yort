import { Color, ScreenSpaceEventHandler, ScreenSpaceEventType, type Viewer } from 'cesium';
import { useEffect, useRef } from 'react';
import { PlotDrawingTool } from '../cesium/PlotDrawingTool';
import { WalkController } from '../cesium/WalkController';
import { createViewer, flyToTerritory, territoryCenter } from '../cesium/createViewer';
import { pickGround, toLonLat } from '../cesium/pick';
import { createTerrain } from '../cesium/terrain';
import { territory } from '../config/territory';
import { useAppStore } from '../store/useAppStore';
import { BaseBuildingsLayer } from '../world/base/BaseBuildingsLayer';
import { BARE_GROUND_COLOR, GroundLayer } from '../world/base/GroundLayer';
import { TreesLayer } from '../world/base/TreesLayer';
import { loadEnvironment } from '../world/base/environment';
import { computeStats, loadBaseBuildings } from '../world/base/loadBaseBuildings';
import { scatterTrees } from '../world/base/vegetation';
import { analyzePlot } from '../world/user/plot';
import { Collider } from '../world/walk/collider';
import { createLocalFrame } from '../world/walk/localFrame';
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

      // Поверхности земли — первыми: они рисуются без записи глубины, порядок важен.
      // Добавленные в сцену примитивы уничтожит сам Viewer.
      GroundLayer.create(environment.ground, terrain.kind).addTo(v.scene);

      const buildingFootprints = collection.features.flatMap((f) =>
        f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates,
      );
      const allTrees = [
        ...environment.trees,
        ...scatterTrees(environment.ground, environment.trees, buildingFootprints),
      ];

      const [buildings, trees] = await Promise.all([
        BaseBuildingsLayer.create(v.scene, collection, terrain.provider, territoryCenter(territory)),
        TreesLayer.create(allTrees, terrain.provider),
      ]);
      if (disposed) {
        buildings.destroy();
        trees.destroy();
        return;
      }
      v.scene.primitives.add(trees.primitive);
      v.scene.primitives.add(buildings.primitive);
      buildings.renderUntilReady();
      store.setStats(computeStats(collection));

      // Участок: инструмент рисует, проверка идёт против Base World, результат — в стор.
      const plotTool = new PlotDrawingTool(
        v,
        {
          onChange: (points) => store.setPlotDraft(points),
          onFinish: (points) => {
            const plot = analyzePlot(points, collection.features, territory.bbox);
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

      // Прогулка: столкновения со зданиями и названия улиц — в локальных метрах.
      const { south, west, north, east } = territory.bbox;
      const frame = createLocalFrame([(west + east) / 2, (south + north) / 2]);
      const walk = new WalkController(
        v,
        frame,
        new Collider(collection.features, frame),
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
          store.selectBuilding(buildings.buildingFromPick(v.scene.pick(event.position)));
        }
      }, ScreenSpaceEventType.LEFT_CLICK);

      // Подсветка и раскраска следуют за стором (в т.ч. при закрытии карточки).
      unsubscribe = useAppStore.subscribe((state, prev) => {
        if (state.selectedBuilding !== prev.selectedBuilding) buildings.select(state.selectedBuilding?.id);
        if (state.buildingColorMode !== prev.buildingColorMode) buildings.setColorMode(state.buildingColorMode);
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
