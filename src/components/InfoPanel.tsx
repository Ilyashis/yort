import { defaultTerritory, findTerritory, territories } from '../config/territory';
import { useAppStore } from '../store/useAppStore';
import { BUILDING_COLORS } from '../world/base/buildingPlan';

const percent = (part: number, total: number) => (total ? Math.round((part / total) * 100) : 0);

export function InfoPanel() {
  const territoryId = useAppStore((s) => s.territoryId);
  const setTerritory = useAppStore((s) => s.setTerritory);
  const territory = findTerritory(territoryId) ?? defaultTerritory;
  const status = useAppStore((s) => s.status);
  const error = useAppStore((s) => s.error);
  const stats = useAppStore((s) => s.stats);
  const terrain = useAppStore((s) => s.terrain);
  const flyHome = useAppStore((s) => s.flyHome);
  const colorMode = useAppStore((s) => s.buildingColorMode);
  const setColorMode = useAppStore((s) => s.setBuildingColorMode);

  const knownHeight = stats ? stats.bySource.height + stats.bySource.levels : 0;

  const choosePlace = (id: string) => {
    const own = useAppStore.getState().userBuildings.length;
    const target = findTerritory(id);
    if (!target) return;
    // Постройки пока живут только в памяти вкладки — предупреждаем, прежде чем их потерять.
    if (own && !window.confirm(`Ваши постройки (${own}) пропадут. Перейти в «${target.shortName}»?`)) return;
    setTerritory(id);
  };

  return (
    <aside className="panel info-panel">
      <header>
        <div className="brand">
          AI UFA <span className="badge">прототип</span>
        </div>
        <label className="place-picker">
          <span className="place-picker-label">Населённый пункт</span>
          <select value={territory.id} onChange={(event) => choosePlace(event.target.value)}>
            {territories.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
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
            <dd>{terrain === 'flat' || !terrain ? 'плоский' : 'есть'}</dd>
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
        Левая кнопка — двигать, правая — повернуть и наклонить, колесо — масштаб, WASD — лететь над
        городом. Клик по зданию — подробности. Все клавиши — кнопка «?» справа внизу.
      </p>

      <button type="button" className="button" onClick={() => flyHome?.()} disabled={!flyHome}>
        Вернуться к району
      </button>

      {stats?.osmTimestamp && (
        <p className="footnote muted">
          Данные OSM на {new Date(stats.osmTimestamp).toLocaleDateString('ru-RU')}
          {terrain === 'flat' && ' · рельеф: npm run data:fetch:terrain'}
          {terrain === 'dem' && ' · рельеф Copernicus DEM'}
        </p>
      )}
    </aside>
  );
}
