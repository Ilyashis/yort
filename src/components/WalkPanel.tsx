import { useAppStore } from '../store/useAppStore';
import { CAR_COLORS } from '../world/drive/carModel';

/** Вход в прогулку или поездку: кнопки и ожидание клика по улице. */
export function WalkPanel() {
  const status = useAppStore((s) => s.status);
  const mode = useAppStore((s) => s.mode);
  const controls = useAppStore((s) => s.walkControls);
  const carColor = useAppStore((s) => s.carColor);
  const setCarColor = useAppStore((s) => s.setCarColor);

  if (mode === 'pick-walk-start' || mode === 'pick-drive-start') {
    const driving = mode === 'pick-drive-start';
    return (
      <section className="panel walk-panel walk-panel-active">
        <h2>Где начнём?</h2>
        <p className="muted">
          {driving
            ? 'Кликните по улице — машина встанет на ближайшую дорогу, по направлению взгляда.'
            : 'Кликните по улице или площади — окажетесь там на уровне глаз.'}
        </p>
        <div className="button-row">
          <button type="button" className="button" onClick={() => controls?.cancelPick()}>
            Отмена
          </button>
        </div>
      </section>
    );
  }

  const disabled = status !== 'ready' || !controls || mode !== 'explore';
  return (
    <section className="panel walk-panel">
      <h2>Прогулка и поездка</h2>
      <p className="muted">Опуститесь на улицу: пройдитесь пешком или прокатитесь на машине.</p>
      <div className="button-row">
        <button type="button" className="button button-primary" onClick={() => controls?.pickStart('walk')} disabled={disabled}>
          Пешком
        </button>
        <button type="button" className="button button-primary" onClick={() => controls?.pickStart('drive')} disabled={disabled}>
          На машине
        </button>
      </div>
      <div className="car-colors" role="radiogroup" aria-label="Цвет машины">
        <span className="muted">Машина:</span>
        {CAR_COLORS.map(({ color, name }) => (
          <button
            key={color}
            type="button"
            role="radio"
            aria-checked={carColor === color}
            className={`car-color ${carColor === color ? 'on' : ''}`}
            style={{ background: color }}
            title={name}
            aria-label={name}
            onClick={() => setCarColor(color)}
          />
        ))}
      </div>
    </section>
  );
}
