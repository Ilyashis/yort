import { useAppStore } from '../store/useAppStore';

/** Подсказки поверх сцены во время прогулки. */
export function WalkHud() {
  const street = useAppStore((s) => s.walkStreet);
  const controls = useAppStore((s) => s.walkControls);
  const locked = useAppStore((s) => s.walkMouseLocked);

  return (
    <>
      {street && <div className="walk-street">{street}</div>}
      {locked && <div className="crosshair" aria-hidden="true" />}
      <div className="panel walk-hud">
        <div className="walk-keys">
          <span>
            <kbd>W</kbd>
            <kbd>A</kbd>
            <kbd>S</kbd>
            <kbd>D</kbd> идти
          </span>
          <span>
            <kbd>Q</kbd>
            <kbd>E</kbd> поворот
          </span>
          <span>
            <kbd>Shift</kbd> бег
          </span>
          <span>{locked ? 'Esc — отпустить курсор' : 'клик по сцене — смотреть мышью'}</span>
        </div>
        <button type="button" className="button" onClick={() => controls?.exit()}>
          Выйти {locked ? '' : <kbd>Esc</kbd>}
        </button>
      </div>
    </>
  );
}
