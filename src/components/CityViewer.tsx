import { ScreenSpaceEventHandler, ScreenSpaceEventType, type Viewer } from 'cesium';
import { useEffect, useRef } from 'react';
import { createViewer, flyToTerritory } from '../cesium/createViewer';
import { createTerrain } from '../cesium/terrain';
import { territory } from '../config/territory';
import { useAppStore } from '../store/useAppStore';
import { BaseBuildingsLayer } from '../world/base/BaseBuildingsLayer';
import { computeStats, loadBaseBuildings } from '../world/base/loadBaseBuildings';

/** 3D-сцена: создаёт Cesium Viewer, загружает Base World и обрабатывает клики. */
export function CityViewer() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const store = useAppStore.getState();
    let disposed = false;
    let viewer: Viewer | undefined;
    let layer: BaseBuildingsLayer | undefined;
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

      // Клик → выбор здания в сторе; подсветка следует за стором (в т.ч. при закрытии карточки).
      clickHandler = new ScreenSpaceEventHandler(v.scene.canvas);
      clickHandler.setInputAction((event: ScreenSpaceEventHandler.PositionedEvent) => {
        useAppStore.getState().selectBuilding(l.buildingFromPick(v.scene.pick(event.position)));
      }, ScreenSpaceEventType.LEFT_CLICK);
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
      // Viewer уничтожает и добавленные в сцену примитивы (слой зданий).
      if (viewer && !viewer.isDestroyed()) viewer.destroy();
      else layer?.destroy();
      store.setFlyHome(undefined);
      store.selectBuilding(undefined);
    };
  }, []);

  return <div ref={containerRef} className="city-viewer" />;
}
