import { useAppStore } from '../store/useAppStore';

const Key = ({ children }: { children: string }) => <kbd>{children}</kbd>;

/** Подсказка по управлению для текущего режима: вид сверху или прогулка. */
export function HelpPanel() {
  const open = useAppStore((s) => s.helpOpen);
  const ready = useAppStore((s) => s.status === 'ready');
  const walking = useAppStore((s) => s.mode === 'walk');
  const setOpen = useAppStore((s) => s.setHelpOpen);
  if (!open || !ready) return null;

  return (
    <aside className="panel help-panel" role="dialog" aria-label="Управление">
      <button type="button" className="close" aria-label="Закрыть" onClick={() => setOpen(false)}>
        ×
      </button>
      <h2>{walking ? 'Управление на прогулке' : 'Управление камерой'}</h2>
      {walking ? (
        <dl className="help-keys">
          <dt>
            <Key>W</Key>
            <Key>S</Key>
          </dt>
          <dd>вперёд / назад</dd>
          <dt>
            <Key>A</Key>
            <Key>D</Key>
          </dt>
          <dd>шаг влево / вправо</dd>
          <dt>
            <Key>Q</Key>
            <Key>E</Key> или <Key>←</Key>
            <Key>→</Key>
          </dt>
          <dd>повернуться</dd>
          <dt>
            <Key>Shift</Key>
          </dt>
          <dd>бежать</dd>
          <dt>клик по сцене</dt>
          <dd>смотреть мышью или тачпадом, ничего не зажимая</dd>
          <dt>
            <Key>Esc</Key>
          </dt>
          <dd>отпустить курсор; ещё раз — выйти из прогулки</dd>
        </dl>
      ) : (
        <dl className="help-keys">
          <dt>левая кнопка</dt>
          <dd>двигать карту</dd>
          <dt>правая кнопка или Shift + левая</dt>
          <dd>повернуть и наклонить</dd>
          <dt>колесо, щипок</dt>
          <dd>ближе / дальше</dd>
          <dt>двойной клик</dt>
          <dd>подлететь к точке</dd>
          <dt>
            <Key>W</Key>
            <Key>A</Key>
            <Key>S</Key>
            <Key>D</Key> или стрелки
          </dt>
          <dd>лететь над городом (с Shift — быстрее)</dd>
          <dt>
            <Key>Q</Key>
            <Key>E</Key>
          </dt>
          <dd>повернуть вид</dd>
          <dt>
            <Key>R</Key>
            <Key>F</Key>
          </dt>
          <dd>ближе / дальше</dd>
        </dl>
      )}
    </aside>
  );
}
