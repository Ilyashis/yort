import { BuildingCard } from './components/BuildingCard';
import { CityViewer } from './components/CityViewer';
import { InfoPanel } from './components/InfoPanel';
import { PlotPanel } from './components/PlotPanel';

export function App() {
  return (
    <main className="app">
      <CityViewer />
      <div className="sidebar">
        <InfoPanel />
        <PlotPanel />
      </div>
      <BuildingCard />
    </main>
  );
}
