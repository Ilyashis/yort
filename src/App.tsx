import { BuilderPanel } from './components/BuilderPanel';
import { BuildingCard } from './components/BuildingCard';
import { CityViewer } from './components/CityViewer';
import { InfoPanel } from './components/InfoPanel';
import { PlotPanel } from './components/PlotPanel';
import { WalkHud } from './components/WalkHud';
import { WalkPanel } from './components/WalkPanel';
import { useAppStore } from './store/useAppStore';

export function App() {
  const walking = useAppStore((s) => s.mode === 'walk');
  const building = useAppStore((s) => !!s.builder);

  return (
    <main className="app">
      <CityViewer />
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
    </main>
  );
}
