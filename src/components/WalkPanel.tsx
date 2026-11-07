import { useAppStore } from '../store/useAppStore';

/** Вход в прогулку: кнопка и ожидание клика по улице. */
export function WalkPanel() {
  const status = useAppStore((s) => s.status);
  const mode = useAppStore((s) => s.mode);
  const controls = useAppStore((s) => s.walkControls);

  if (mode === 'pick-walk-start') {
    return (
      <section className="panel walk-panel walk-panel-active">
        <h2>Где начнём?</h2>
        <p className="muted">Кликните по улице или площади — окажетесь там на уровне глаз.</p>
        <div className="button-row">
          <button type="button" className="button" onClick={() => controls?.cancelPick()}>
            Отмена
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="panel walk-panel">
      <h2>Прогулка</h2>
      <p className="muted">Опуститесь на улицу и пройдитесь пешком.</p>
      <button
        type="button"
        className="button button-primary"
        onClick={() => controls?.pickStart()}
        disabled={status !== 'ready' || !controls || mode !== 'explore'}
      >
        Начать прогулку
      </button>
    </section>
  );
}
