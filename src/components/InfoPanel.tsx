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
  const villageModels = useAppStore((s) => s.villageModels);
  const setVillageModels = useAppStore((s) => s.setVillageModels);
  const survey = useAppStore((s) => s.survey);
  const surveyOn = useAppStore((s) => s.surveyOn);
  const setSurveyOn = useAppStore((s) => s.setSurveyOn);

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
            <dd>{terrain === 'flat' || !terrain ? 'плоский' : terrain === 'drone' ? 'есть, уточнён съёмкой с дрона' : 'есть'}</dd>
          </div>
        </dl>
      )}

      {survey && (
        <label className="toggle" title="Своя съёмка с дрона: подробный рельеф, цвета крыш и стен домов, постройки, которых нет в OSM">
          <input type="checkbox" checked={surveyOn} onChange={(event) => setSurveyOn(event.target.checked)} />
          <span>
            Уточнения по съёмке с дрона
            {surveyOn && (survey.terrain || survey.colored || survey.added) ? (
              <span className="muted toggle-note">
                {[
                  survey.terrain && 'рельеф 1 м',
                  survey.colored && `цвет крыш у ${survey.colored} ${plural(survey.colored, 'дома', 'домов', 'домов')}`,
                  survey.added && `${survey.added} ${plural(survey.added, 'новая постройка', 'новые постройки', 'новых построек')}`,
                ]
                  .filter(Boolean)
                  .join(', ')}
              </span>
            ) : null}
          </span>
        </label>
      )}

      {territory.kind === 'village' && (
        <label className="toggle" title="Дома из OSM нарисованы башкирскими домами: изба, пятистенок, дом с верандой, вальмовый, кирпичный, баня">
          <input type="checkbox" checked={villageModels} onChange={(event) => setVillageModels(event.target.checked)} />
          Башкирские дома-модели вместо простых объёмов
        </label>
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
          {terrain === 'drone' && ' · рельеф Copernicus DEM и своя съёмка с дрона'}
        </p>
      )}
    </aside>
  );
}

/** Русское окончание по числу: 1 дом, 2 дома, 5 домов (для «у N …» — родительный: 1 дома, 2 домов). */
function plural(n: number, one: string, few: string, many: string): string {
  const d = n % 10;
  const dd = n % 100;
  if (d === 1 && dd !== 11) return one;
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return few;
  return many;
}
