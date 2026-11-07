import { BuilderPanel } from './components/BuilderPanel';
import { BuildingCard } from './components/BuildingCard';
import { CityViewer } from './components/CityViewer';
import { CornerControls } from './components/CornerControls';
import { HelpPanel } from './components/HelpPanel';
import { InfoPanel } from './components/InfoPanel';
import { PlotPanel } from './components/PlotPanel';
import { WalkHud } from './components/WalkHud';
import { WalkPanel } from './components/WalkPanel';
import { useAppStore } from './store/useAppStore';

export function App() {
  const walking = useAppStore((s) => s.mode === 'walk');
  const building = useAppStore((s) => !!s.builder);
  const loading = useAppStore((s) => s.status === 'loading');

  return (
    <main className="app">
      <CityViewer />
      {/* Плавное появление: пока город грузится, его закрывает мягкая вуаль. */}
      <div className={`intro-veil ${loading ? '' : 'intro-veil-hidden'}`} aria-hidden={!loading}>
        <div className="intro-title">
          AI UFA
          <span>Загружаем Уфу…</span>
        </div>
      </div>
      {walking ? (
        <WalkHud />
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
        </>
      )}
      <HelpPanel />
      <CornerControls />
    </main>
  );
}
