import { useAppStore } from '../store/useAppStore';
import { formatArea } from '../utils/format';
import {
  BUILDING_TYPES,
  FACADE_SWATCHES,
  SPEC_LIMITS,
  type BuildingType,
  type RoofKind,
} from '../world/user/building';

const TYPES = Object.keys(BUILDING_TYPES) as BuildingType[];
const ROOFS: { kind: RoofKind; label: string }[] = [
  { kind: 'flat', label: 'Плоская' },
  { kind: 'pitched', label: 'Скатная' },
];

const formatMeters = (m: number) => `${m.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} м`;

/**
 * Конструктор здания на участке. Форма заполняет BuildingSpec — тот же JSON,
 * который на следующем шаге будет собирать ИИ по текстовому запросу.
 */
export function BuilderPanel() {
  const builder = useAppStore((s) => s.builder);
  const setType = useAppStore((s) => s.setBuildingType);
  const update = useAppStore((s) => s.updateSpec);
  const cancel = useAppStore((s) => s.cancelBuilder);
  if (!builder) return null;

  const { spec, result } = builder;
  const { building, issues, warnings } = result;

  const place = () => {
    const { placeBuilding, plotControls } = useAppStore.getState();
    // Участок «занят» зданием — убираем его контур со сцены.
    if (placeBuilding()) plotControls?.clear();
  };

  return (
    <section className="panel builder-panel">
      <h2>Новое здание</h2>

      <div className="segmented" role="group" aria-label="Тип здания">
        {TYPES.map((type) => (
          <button
            key={type}
            type="button"
            className={spec.type === type ? 'active' : ''}
            onClick={() => setType(type)}
          >
            {BUILDING_TYPES[type].label}
          </button>
        ))}
      </div>

      <label className="field">
        <span>
          Этажей <b>{spec.floors}</b>
        </span>
        <input
          type="range"
          min={SPEC_LIMITS.floors.min}
          max={SPEC_LIMITS.floors.max}
          step={1}
          value={spec.floors}
          onChange={(e) => update({ floors: Number(e.target.value) })}
        />
      </label>

      <label className="field">
        <span>
          Отступ от границ участка <b>{formatMeters(spec.setback)}</b>
        </span>
        <input
          type="range"
          min={SPEC_LIMITS.setback.min}
          max={SPEC_LIMITS.setback.max}
          step={0.5}
          value={spec.setback}
          onChange={(e) => update({ setback: Number(e.target.value) })}
        />
      </label>

      <div className="field">
        <span>Крыша</span>
        <div className="segmented segmented-small" role="group" aria-label="Крыша">
          {ROOFS.map(({ kind, label }) => (
            <button
              key={kind}
              type="button"
              className={spec.roof === kind ? 'active' : ''}
              onClick={() => update({ roof: kind })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <span>Цвет фасада</span>
        <div className="swatches" role="group" aria-label="Цвет фасада">
          {FACADE_SWATCHES.map((color) => (
            <button
              key={color}
              type="button"
              aria-label={color}
              className={spec.facadeColor === color ? 'active' : ''}
              style={{ background: color }}
              onClick={() => update({ facadeColor: color })}
            />
          ))}
        </div>
      </div>

      <label className="toggle">
        <input type="checkbox" checked={spec.shops} onChange={(e) => update({ shops: e.target.checked })} />
        Витрины на первом этаже
      </label>

      {building && (
        <dl className="stats">
          <div>
            <dt>Высота</dt>
            <dd>{formatMeters(building.totalHeight)}</dd>
          </div>
          <div>
            <dt>Пятно</dt>
            <dd>{formatArea(building.footprintArea)}</dd>
          </div>
          <div>
            <dt>Площадь этажей</dt>
            <dd>{formatArea(building.grossArea)}</dd>
          </div>
        </dl>
      )}

      {issues.length > 0 && (
        <ul className="plot-issues builder-issues">
          {issues.map((issue) => (
            <li key={issue.code}>{issue.message}</li>
          ))}
        </ul>
      )}
      {warnings.length > 0 && (
        <ul className="builder-warnings">
          {warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}

      <details className="spec-json">
        <summary>Спецификация (JSON для ИИ)</summary>
        <pre>{JSON.stringify(spec, null, 2)}</pre>
      </details>

      <div className="button-row">
        <button
          type="button"
          className="button button-primary"
          onClick={place}
          disabled={!building || issues.length > 0}
        >
          Разместить
        </button>
        <button type="button" className="button" onClick={cancel}>
          Отмена
        </button>
      </div>
    </section>
  );
}
