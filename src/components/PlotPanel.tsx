import { PLOT_COLORS } from '../cesium/PlotDrawingTool';
import { useAppStore } from '../store/useAppStore';
import { formatArea, formatLength } from '../utils/format';
import { PLOT_LIMITS, plotArea } from '../world/user/plot';

export function PlotPanel() {
  const status = useAppStore((s) => s.status);
  const mode = useAppStore((s) => s.mode);
  const draft = useAppStore((s) => s.plotDraft);
  const plot = useAppStore((s) => s.plot);
  const controls = useAppStore((s) => s.plotControls);

  const ready = status === 'ready' && !!controls && mode === 'explore';

  if (mode === 'draw-plot') {
    const area = plotArea(draft);
    return (
      <section className="panel plot-panel">
        <h2>Рисуем участок</h2>
        <p className="muted">
          Кликайте по земле, чтобы поставить углы участка. Завершить — двойной клик, Enter или клик
          по первой точке.
        </p>
        <dl className="stats stats-2">
          <div>
            <dt>Углов</dt>
            <dd>{draft.length}</dd>
          </div>
          <div>
            <dt>Площадь</dt>
            <dd>{draft.length >= 3 ? formatArea(area) : '—'}</dd>
          </div>
        </dl>
        <p className="hint muted">
          Правый клик или Backspace — убрать последнюю точку, Esc — отмена.
        </p>
        <div className="button-row">
          <button
            type="button"
            className="button button-primary"
            onClick={() => controls?.finish()}
            disabled={draft.length < 3}
          >
            Готово
          </button>
          <button
            type="button"
            className="button"
            onClick={() => controls?.undo()}
            disabled={draft.length === 0}
          >
            Убрать точку
          </button>
          <button type="button" className="button" onClick={() => controls?.cancel()}>
            Отмена
          </button>
        </div>
      </section>
    );
  }

  if (plot) {
    return (
      <section className="panel plot-panel">
        <h2>Участок</h2>
        <dl className="stats">
          <div>
            <dt>Площадь</dt>
            <dd>{formatArea(plot.areaM2)}</dd>
          </div>
          <div>
            <dt>Периметр</dt>
            <dd>{formatLength(plot.perimeterM)}</dd>
          </div>
          <div>
            <dt>Углов</dt>
            <dd>{plot.polygon.length}</dd>
          </div>
        </dl>

        {plot.valid ? (
          <p className="plot-status" style={{ color: PLOT_COLORS.valid }}>
            ✓ Участок свободен — здесь можно строить
          </p>
        ) : (
          <ul className="plot-issues" style={{ color: PLOT_COLORS.invalid }}>
            {plot.issues.map((issue) => (
              <li key={issue.code}>
                {issue.message}
                {issue.code === 'overlaps-buildings' && (
                  <span className="muted"> — подсвечены красным</span>
                )}
              </li>
            ))}
          </ul>
        )}

        <div className="button-row">
          <button type="button" className="button" onClick={() => controls?.start()} disabled={!ready}>
            Перерисовать
          </button>
          <button type="button" className="button" onClick={() => controls?.clear()} disabled={!ready}>
            Удалить участок
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="panel plot-panel">
      <h2>Участок</h2>
      <p className="muted">
        Нарисуйте на карте участок под будущее здание: от {PLOT_LIMITS.minAreaM2} м² до{' '}
        {formatArea(PLOT_LIMITS.maxAreaM2)}, без пересечений с существующими зданиями.
      </p>
      <button
        type="button"
        className="button button-primary"
        onClick={() => controls?.start()}
        disabled={!ready}
      >
        Выбрать участок
      </button>
    </section>
  );
}
