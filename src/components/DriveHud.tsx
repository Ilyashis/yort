import { useAppStore } from '../store/useAppStore';

/** Приборы и подсказки поверх сцены за рулём. */
export function DriveHud() {
  const street = useAppStore((s) => s.walkStreet);
  const hud = useAppStore((s) => s.driveHud);
  const view = useAppStore((s) => s.driveView);
  const drive = useAppStore((s) => s.driveControls);
  const walk = useAppStore((s) => s.walkControls);

  return (
    <>
      {street && <div className="walk-street">{street}</div>}
      <div className="panel drive-speed" aria-live="off">
        <span className="drive-speed-value">{hud.speed}</span>
        <span className="drive-speed-unit">км/ч</span>
        <span className="drive-gear" title="Передача">
          {hud.gear}
        </span>
      </div>
      <div className="panel walk-hud">
        <div className="walk-keys">
          <span>
            <kbd>W</kbd>
            <kbd>S</kbd> газ, тормоз
          </span>
          <span>
            <kbd>A</kbd>
            <kbd>D</kbd> руль
          </span>
          <span>
            <kbd>Пробел</kbd> ручник
          </span>
          <span>
            <kbd>Shift</kbd> быстрее
          </span>
          <span>
            <button type="button" className="link-button" onClick={() => drive?.toggleView()}>
              <kbd>C</kbd> {view === 'chase' ? 'из кабины' : 'вид сзади'}
            </button>
          </span>
          <span>
            <button type="button" className="link-button" onClick={() => drive?.backToRoad()}>
              <kbd>R</kbd> на дорогу
            </button>
          </span>
        </div>
        <button type="button" className="button" onClick={() => walk?.exit()}>
          Выйти <kbd>Esc</kbd>
        </button>
      </div>
    </>
  );
}
