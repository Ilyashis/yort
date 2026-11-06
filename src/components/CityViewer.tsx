import { ScreenSpaceEventHandler, ScreenSpaceEventType, type Viewer } from 'cesium';
import { useEffect, useRef } from 'react';
import { PlotDrawingTool } from '../cesium/PlotDrawingTool';
import { createViewer, flyToTerritory } from '../cesium/createViewer';
import { createTerrain } from '../cesium/terrain';
import { territory } from '../config/territory';
import { useAppStore } from '../store/useAppStore';
import { BaseBuildingsLayer } from '../world/base/BaseBuildingsLayer';
import { computeStats, loadBaseBuildings } from '../world/base/loadBaseBuildings';
import { analyzePlot } from '../world/user/plot';

/** 3D-сцена: создаёт Cesium Viewer, загружает Base World, связывает инструменты со стором. */
export function CityViewer() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const store = useAppStore.getState();
    let disposed = false;
    let viewer: Viewer | undefined;
    let layer: BaseBuildingsLayer | undefined;
    let plotTool: PlotDrawingTool | undefined;
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

      const collection = await loadBaseBuildings(territory);
      if (disposed) return;

      const l = await BaseBuildingsLayer.create(v.scene, collection, terrain.provider);
      if (disposed) {
        l.destroy();
        return;
      }
      layer = l;
      v.scene.primitives.add(l.primitive);
      l.renderUntilReady();
      store.setStats(computeStats(collection));

      // Участок: инструмент рисует, проверка идёт против Base World, результат — в стор.
      const tool = new PlotDrawingTool(v, {
        onChange: (points) => store.setPlotDraft(points),
        onFinish: (points) => {
          const plot = analyzePlot(points, collection.features, territory.bbox);
          l.setConflicts(plot.conflictingBuildingIds);
          tool.showResult(plot.valid);
          store.plotFinished(plot);
        },
        onCancel: () => store.plotDrawingCancelled(),
      });
      plotTool = tool;
      store.setPlotControls({
        start: () => {
          l.setConflicts([]);
          tool.start();
          store.plotDrawingStarted();
        },
        finish: () => tool.finish(),
        undo: () => tool.undo(),
        cancel: () => tool.cancel(),
        clear: () => {
          tool.reset();
          l.setConflicts([]);
          store.plotCleared();
        },
      });

      // Левый клик: во время рисования ставит вершину, иначе выбирает здание.
      clickHandler = new ScreenSpaceEventHandler(v.scene.canvas);
      clickHandler.setInputAction((event: ScreenSpaceEventHandler.PositionedEvent) => {
        if (tool.isDrawing) {
          tool.handleClick(event.position);
          return;
        }
        store.selectBuilding(l.buildingFromPick(v.scene.pick(event.position)));
      }, ScreenSpaceEventType.LEFT_CLICK);

      // Подсветка следует за стором (в т.ч. при закрытии карточки).
      unsubscribe = useAppStore.subscribe((state, prev) => {
        if (state.selectedBuilding !== prev.selectedBuilding) l.select(state.selectedBuilding?.id);
      });

      store.setStatus('ready');
    }

    init().catch((error: unknown) => {
      if (disposed) return;
      console.error(error);
      store.setStatus('error', error instanceof Error ? error.message : String(error));
    });

    return () => {
      disposed = true;
      unsubscribe?.();
      clickHandler?.destroy();
      plotTool?.destroy();
      // Viewer уничтожает и добавленные в сцену примитивы (слой зданий).
      if (viewer && !viewer.isDestroyed()) viewer.destroy();
      else layer?.destroy();
      store.setFlyHome(undefined);
      store.setPlotControls(undefined);
      store.plotDrawingCancelled();
      store.plotCleared();
      store.selectBuilding(undefined);
    };
  }, []);

  return <div ref={containerRef} className="city-viewer" />;
}
