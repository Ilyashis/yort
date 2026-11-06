import { territory } from '../config/territory';
import { useAppStore } from '../store/useAppStore';
import { BUILDING_COLORS } from '../world/base/BaseBuildingsLayer';

const percent = (part: number, total: number) => (total ? Math.round((part / total) * 100) : 0);

export function InfoPanel() {
  const status = useAppStore((s) => s.status);
  const error = useAppStore((s) => s.error);
  const stats = useAppStore((s) => s.stats);
  const terrain = useAppStore((s) => s.terrain);
  const flyHome = useAppStore((s) => s.flyHome);
  const colorMode = useAppStore((s) => s.buildingColorMode);
  const setColorMode = useAppStore((s) => s.setBuildingColorMode);

  const knownHeight = stats ? stats.bySource.height + stats.bySource.levels : 0;

  return (
    <aside className="panel info-panel">
      <header>
        <div className="brand">
          AI UFA <span className="badge">прототип</span>
        </div>
        <h1>{territory.name}</h1>
        <p className="muted">{territory.description}</p>
      </header>

      {status === 'loading' && <p className="status">Загрузка сцены…</p>}
      {status === 'error' && <p className="status status-error">{error}</p>}

      {stats && (
        <dl className="stats">
          <div>
            <dt>Зданий</dt>
            <dd>{stats.total}</dd>
          </div>
          <div>
            <dt>Высота из OSM</dt>
            <dd>{percent(knownHeight, stats.total)}%</dd>
          </div>
          <div>
            <dt>Рельеф</dt>
            <dd>{terrain === 'world' ? 'есть' : 'плоский'}</dd>
          </div>
        </dl>
      )}

      <label className="toggle">
        <input
          type="checkbox"
          checked={colorMode === 'data'}
          onChange={(event) => setColorMode(event.target.checked ? 'data' : 'city')}
        />
        Раскрасить по качеству данных о высоте
      </label>
      {colorMode === 'data' && (
        <ul className="legend">
          <li>
            <i style={{ background: BUILDING_COLORS.known }} /> высота из OSM (height или этажность)
          </li>
          <li>
            <i style={{ background: BUILDING_COLORS.estimated }} /> высота — оценка по типу здания
          </li>
        </ul>
      )}

      <p className="hint muted">
        Перетаскивание — сдвиг, колесо — масштаб, Ctrl + перетаскивание — наклон и поворот. Клик по
        зданию — подробности.
      </p>

      <button type="button" className="button" onClick={() => flyHome?.()} disabled={!flyHome}>
        Вернуться к району
      </button>

      {stats?.osmTimestamp && (
        <p className="footnote muted">
          Данные OSM на {new Date(stats.osmTimestamp).toLocaleDateString('ru-RU')}
          {terrain === 'flat' && ' · рельеф включается токеном Cesium ion'}
        </p>
      )}
    </aside>
  );
}
