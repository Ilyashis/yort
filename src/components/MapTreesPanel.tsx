import { useAppStore } from '../store/useAppStore';
import { MAP_TREE_MODES, type MapTreesMode } from '../world/base/mapTrees';

const MODES: MapTreesMode[] = ['off', 'sparse', 'normal', 'lush'];

/**
 * Временная панель: деревья по карте (снимку с дрона) — выключить или посадить реже/гуще, чтобы сравнить
 * с тем, как было. Когда выберем режим, панель уберём, а режим оставим.
 */
export function MapTreesPanel() {
  const ready = useAppStore((s) => s.status === 'ready');
  const mode = useAppStore((s) => s.mapTrees);
  const count = useAppStore((s) => s.mapTreesCount);
  const setMode = useAppStore((s) => s.setMapTrees);
  if (!ready) return null;
  return (
    <section className="panel map-trees-panel">
      <h2>Деревья по карте</h2>
      <p className="muted">Кроны со снимка с дрона: дерево — там, где на карте деревья, а в сцене их нет.</p>
      <div className="segmented segmented-small" role="group" aria-label="Пышность">
        {MODES.map((m) => (
          <button key={m} type="button" className={mode === m ? 'active' : ''} onClick={() => setMode(m)}>
            {m === 'off' ? 'Как было' : MAP_TREE_MODES[m].label}
          </button>
        ))}
      </div>
      {mode !== 'off' && <p className="muted">{count === undefined ? 'Сажаю…' : `Посажено деревьев: ${count.toLocaleString('ru-RU')}`}</p>}
    </section>
  );
}
