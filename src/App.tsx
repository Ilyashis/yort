import { useEffect, useState } from 'react';
import { BuilderPanel } from './components/BuilderPanel';
import { BuildingCard } from './components/BuildingCard';
import { CityViewer } from './components/CityViewer';
import { EditPanel } from './components/EditPanel';
import { EditorToolbar } from './components/EditorToolbar';
import { HelpPanel } from './components/HelpPanel';
import { InfoPanel } from './components/InfoPanel';
import { CAN_EDIT, PUBLISHED_VIEW } from './config/mode';
import { MapTreesPanel } from './components/MapTreesPanel';

import { PlotPanel } from './components/PlotPanel';
import { DesktopUi } from './components/DesktopUi';
import { MobileUi, useDevice } from './components/MobileUi';
import { defaultTerritory, findTerritory, territoryDataUrl } from './config/territory';
import { isOnStreet, useAppStore } from './store/useAppStore';

/** Панель «Деревья по карте» (сравнить режимы пышности) — скрыта, режим «Средне»; вдруг пригодится. */
const SHOW_MAP_TREES_PANEL = false;

export function App() {
  const mode = useAppStore((s) => s.mode);
  const building = useAppStore((s) => !!s.builder);
  const loading = useAppStore((s) => s.status === 'loading');
  const territory = useAppStore((s) => findTerritory(s.territoryId) ?? defaultTerritory);
  // Данные съёмки с дрона меняют рельеф и дома — сцену проще собрать заново.
  const surveyOn = useAppStore((s) => s.surveyOn);
  // «Моя версия» посёлка меняет участки, рельеф и постройки — тоже собираем заново.
  const villagePlan = useAppStore((s) => s.villagePlan && territory.kind === 'village');
  const reliefScale = useAppStore((s) => s.reliefScale);
  const device = useDevice();
  const mobile = device !== 'desktop';
  const hudHidden = useAppStore((s) => s.hudHidden);
  // Зритель: сначала — опубликованный вид (перепады и слои, как у редактора), потом сцена.
  const [viewFor, setViewFor] = useState<string | undefined>(CAN_EDIT ? territory.id : undefined);
  useEffect(() => {
    if (CAN_EDIT) return setViewFor(territory.id);
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(territoryDataUrl(territory, PUBLISHED_VIEW), { cache: 'no-cache' });
        if (response.ok && (response.headers.get('content-type') ?? '').includes('json')) useAppStore.getState().applyView(await response.json());
      } catch {
        // Нет опубликованного вида — как по умолчанию.
      }
      if (!cancelled) setViewFor(territory.id);
    })();
    return () => {
      cancelled = true;
    };
  }, [territory]);

  return (
    <main className="app">
      {/* Свой ключ у каждого населённого пункта: при переключении сцена собирается заново. */}
      {viewFor === territory.id && (
        <CityViewer key={`${territory.id}:${surveyOn ? 'survey' : 'osm'}:${villagePlan ? 'plan' : 'yards'}:${reliefScale}`} territory={territory} />
      )}
      {/* Плавное появление: пока город грузится, его закрывает мягкая вуаль. */}
      <div className={`intro-veil ${loading ? '' : 'intro-veil-hidden'}`} aria-hidden={!loading}>
        <div className="intro-title">
          AI UFA
          <span>Загружаем: {territory.shortName}…</span>
        </div>
      </div>
      {mobile ? (
        <>
          {!isOnStreet(mode) && <BuildingCard />}
          <MobileUi tablet={device === 'tablet'} />
        </>
      ) : (
        <>
          {/* Редактор (только локально) — поверх общего каркаса: панель слева, инструменты внизу. */}
          {CAN_EDIT && !isOnStreet(mode) && !hudHidden && (
            <>
              <div className="sidebar">
                <InfoPanel />
                {SHOW_MAP_TREES_PANEL && <MapTreesPanel />}
                {building ? <BuilderPanel /> : <PlotPanel />}
              </div>
              <EditPanel />
              <EditorToolbar />
              <HelpPanel />
            </>
          )}
          {!isOnStreet(mode) && !hudHidden && <BuildingCard />}
          <DesktopUi />
        </>
      )}
    </main>
  );
}
