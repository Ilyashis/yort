import { useAppStore } from '../store/useAppStore';

/** Подсказки поверх сцены во время прогулки. */
export function WalkHud() {
  const street = useAppStore((s) => s.walkStreet);
  const controls = useAppStore((s) => s.walkControls);

  return (
    <>
      {street && <div className="walk-street">{street}</div>}
      <div className="panel walk-hud">
        <div className="walk-keys">
          <span>
            <kbd>W</kbd>
            <kbd>A</kbd>
            <kbd>S</kbd>
            <kbd>D</kbd> идти
          </span>
          <span>
            <kbd>Shift</kbd> бежать
          </span>
          <span>зажмите мышь — осмотреться</span>
        </div>
        <button type="button" className="button" onClick={() => controls?.exit()}>
          Выйти <kbd>Esc</kbd>
        </button>
      </div>
    </>
  );
}
