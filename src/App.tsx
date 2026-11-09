import { BuilderPanel } from './components/BuilderPanel';
import { BuildingCard } from './components/BuildingCard';
import { CityViewer } from './components/CityViewer';
import { CornerControls } from './components/CornerControls';
import { EditPanel } from './components/EditPanel';
import { EditorToolbar } from './components/EditorToolbar';
import { HelpPanel } from './components/HelpPanel';
import { InfoPanel } from './components/InfoPanel';
import { PlotPanel } from './components/PlotPanel';
import { DriveHud } from './components/DriveHud';
import { Minimap } from './components/Minimap';
import { WalkHud } from './components/WalkHud';
import { WalkPanel } from './components/WalkPanel';
import { defaultTerritory, findTerritory } from './config/territory';
import { isOnStreet, useAppStore } from './store/useAppStore';

export function App() {
  const mode = useAppStore((s) => s.mode);
  const building = useAppStore((s) => !!s.builder);
  const loading = useAppStore((s) => s.status === 'loading');
  const territory = useAppStore((s) => findTerritory(s.territoryId) ?? defaultTerritory);
  // Данные съёмки с дрона меняют рельеф и дома — сцену проще собрать заново.
  const surveyOn = useAppStore((s) => s.surveyOn);

  return (
    <main className="app">
      {/* Свой ключ у каждого населённого пункта: при переключении сцена собирается заново. */}
      <CityViewer key={`${territory.id}:${surveyOn ? 'survey' : 'osm'}`} territory={territory} />
      {/* Плавное появление: пока город грузится, его закрывает мягкая вуаль. */}
      <div className={`intro-veil ${loading ? '' : 'intro-veil-hidden'}`} aria-hidden={!loading}>
        <div className="intro-title">
          AI UFA
          <span>Загружаем: {territory.shortName}…</span>
        </div>
      </div>
      {isOnStreet(mode) ? (
        <>
          {mode === 'drive' ? <DriveHud /> : <WalkHud />}
          <Minimap />
        </>
      ) : (
        <>
          <div className="sidebar">
            <InfoPanel />
            {building ? (
              <BuilderPanel />
            ) : (
              <>
                <WalkPanel />
                <PlotPanel />
              </>
            )}
          </div>
          <BuildingCard />
          <EditPanel />
          <EditorToolbar />
        </>
      )}
      <HelpPanel />
      <CornerControls />
    </main>
  );
}
