import { BuildingCard } from './components/BuildingCard';
import { CityViewer } from './components/CityViewer';
import { InfoPanel } from './components/InfoPanel';

export function App() {
  return (
    <main className="app">
      <CityViewer />
      <InfoPanel />
      <BuildingCard />
    </main>
  );
}
