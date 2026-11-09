import { useAppStore } from '../store/useAppStore';

const Key = ({ children }: { children: string }) => <kbd>{children}</kbd>;

/** Подсказка по управлению для текущего режима: вид сверху или прогулка. */
export function HelpPanel() {
  const open = useAppStore((s) => s.helpOpen);
  const ready = useAppStore((s) => s.status === 'ready');
  const walking = useAppStore((s) => s.mode === 'walk');
  const driving = useAppStore((s) => s.mode === 'drive');
  const setOpen = useAppStore((s) => s.setHelpOpen);
  if (!open || !ready) return null;

  return (
    <aside className="panel help-panel" role="dialog" aria-label="Управление">
      <button type="button" className="close" aria-label="Закрыть" onClick={() => setOpen(false)}>
        ×
      </button>
      <h2>{driving ? 'Управление машиной' : walking ? 'Управление на прогулке' : 'Управление камерой'}</h2>
      {driving ? (
        <dl className="help-keys">
          <dt>
            <Key>W</Key>
            <Key>S</Key> или <Key>↑</Key>
            <Key>↓</Key>
          </dt>
          <dd>газ / тормоз; стоя — задний ход</dd>
          <dt>
            <Key>A</Key>
            <Key>D</Key> или <Key>←</Key>
            <Key>→</Key>
          </dt>
          <dd>руль</dd>
          <dt>
            <Key>Пробел</Key>
          </dt>
          <dd>ручник</dd>
          <dt>
            <Key>Shift</Key>
          </dt>
          <dd>быстрее: до 90 км/ч вместо 60</dd>
          <dt>
            <Key>C</Key>
          </dt>
          <dd>камера: сзади или из кабины</dd>
          <dt>мышь с кнопкой, колесо</dt>
          <dd>оглядеться; ближе / дальше</dd>
          <dt>
            <Key>R</Key>
          </dt>
          <dd>вернуть машину на ближайшую дорогу</dd>
          <dt>
            <Key>M</Key>
          </dt>
          <dd>мини-карта: спрятать / показать</dd>
          <dt>
            <Key>Esc</Key>
          </dt>
          <dd>выйти из машины</dd>
        </dl>
      ) : walking ? (
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
          <dt>
            <Key>M</Key>
          </dt>
          <dd>мини-карта: спрятать / показать</dd>
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
          <dt className="help-section">Редактор</dt>
          <dd />
          <dt>
            <Key>V</Key>
          </dt>
          <dd>выбор: дом тянуть мышью, точки — растянуть и повернуть</dd>
          <dt>
            <Key>Y</Key>
          </dt>
          <dd>дом: тяните по земле — вырастет под участок</dd>
          <dt>
            <Key>T</Key>
          </dt>
          <dd>дорога: ведите от любой дороги</dd>
          <dt>
            <Key>B</Key>
          </dt>
          <dd>забор: ведите линию по земле</dd>
          <dt>
            <Key>G</Key>
          </dt>
          <dd>рельеф: кистью поднять, опустить, выровнять, сгладить</dd>
          <dt>
            <Key>[</Key>
            <Key>]</Key>
          </dt>
          <dd>кисть рельефа меньше / больше</dd>
          <dt>
            <Key>Del</Key>
          </dt>
          <dd>убрать выбранное</dd>
          <dt>
            <Key>Ctrl</Key>
            <Key>Z</Key>
          </dt>
          <dd>отменить (с Shift — повторить)</dd>
          <dt>
            <Key>Backspace</Key>
          </dt>
          <dd>совмещение подложки: шаг назад</dd>
        </dl>
      )}
    </aside>
  );
}
