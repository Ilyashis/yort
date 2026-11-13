// Правка рельефа на сцене: панель режима «Горизонтали» и подписи высот поверх сцены.
// Сами линии, отметки и мышь — в engine/contours.ts.

import { useEffect } from 'react';
import { probe } from '../engine/probe';
import { useStore } from '../state/store';
import { useEditStore } from '../store/useEditStore';
import { removeSpot, upsertSpot, type TerrainSpot } from '../world/edit/edits';
import { Num, Radius } from './Relief';

const STEPS = [0.25, 0.5, 1, 2, 5];
const metres = (v: number) => v.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Включить или выключить правку рельефа на сцене; при включении — вид сверху, инструменты редактора сняты. */
export function toggleContours(): void {
  const s = useStore.getState();
  if (!s.contours) useEditStore.getState().setTool(undefined);
  s.set(s.contours ? { contours: false, contourSpot: null } : { contours: true, topView: true, selected: null });
}

export function Contours() {
  const on = useStore((s) => s.contours);
  const mode = useStore((s) => s.mode);
  const step = useStore((s) => s.contourStep);
  const selected = useStore((s) => s.contourSpot);
  const hover = useStore((s) => s.contourHover);
  const labels = useStore((s) => s.contourLabels);
  const relief = useStore((s) => s.relief);
  const set = useStore((s) => s.set);
  const spots = useEditStore((s) => s.edits.spots) ?? [];
  const commit = useEditStore((s) => s.commit);
  const tool = useEditStore((s) => s.tool);

  // Взяли инструмент редактора — правка рельефа уступает место.
  useEffect(() => {
    if (tool && useStore.getState().contours) set({ contours: false, contourSpot: null });
  }, [tool, set]);

  useEffect(() => {
    if (!on) return;
    const onKey = (e: KeyboardEvent) => {
      const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes((e.target as HTMLElement | null)?.tagName ?? '');
      const s = useStore.getState();
      if (typing || s.relief) return;
      if (e.key === 'Escape') {
        set(s.contourSpot ? { contourSpot: null } : { contours: false });
        e.stopPropagation();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && s.contourSpot) {
        commit(removeSpot(useEditStore.getState().edits, s.contourSpot));
        set({ contourSpot: null });
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [on, set, commit]);

  if (!on || mode !== 'overview') return null;
  const spot = spots.find((s) => s.id === selected);
  const update = (patch: Partial<TerrainSpot>) => spot && commit(upsertSpot(useEditStore.getState().edits, { ...spot, ...patch }));

  return (
    <>
      {!relief && (
        <div className="contour-labels" aria-hidden>
          {labels.map((l, i) => (
            <span key={i} className={l.spot ? 'spot' : ''} style={{ left: l.x, top: l.y }}>
              {l.text}
            </span>
          ))}
          {hover && <output style={{ left: hover.x + 14, top: hover.y + 16 }}>{metres(hover.height)} м</output>}
        </div>
      )}
      <aside className="panel contour-panel" aria-label="Правка рельефа">
        <header>
          <h2>Рельеф на сцене</h2>
          <button type="button" className="icon" title="Закончить правку рельефа (Esc)" aria-label="Закрыть" onClick={() => set({ contours: false, contourSpot: null })}>
            ×
          </button>
        </header>
        <p className="muted">
          Щелчок по земле ставит отметку высоты. Горизонталь можно взять и перетащить — она пройдёт через точку, где отпустите. Карта двигается как обычно.
        </p>
        <div className="relief-field">
          <span>Горизонтали через, м</span>
          <div className="segmented" role="group" aria-label="Шаг горизонталей">
            {STEPS.map((value) => (
              <button key={value} type="button" className={step === value ? 'on' : ''} onClick={() => set({ contourStep: value })}>
                {String(value).replace('.', ',')}
              </button>
            ))}
          </div>
        </div>
        <div className="relief-field">
          <span>
            Отметка {spots.length ? <b>{spot ? `${spots.indexOf(spot) + 1} из ${spots.length}` : `всего ${spots.length}`}</b> : null}
          </span>
          {spot ? (
            <ul className="relief-list">
              <li className="on">
                <div>
                  <Num value={spot.height} step={0.1} digits={2} suffix="м" label="Высота отметки, м" title="Высота над уровнем моря, м. Enter — применить" onChange={(height) => update({ height })} />
                  <Radius value={spot.radius} label="Радиус отметки" onChange={(radius) => update({ radius })} />
                  <button
                    type="button" title="Убрать отметку (Delete)" aria-label="Убрать отметку"
                    onClick={() => {
                      commit(removeSpot(useEditStore.getState().edits, spot.id));
                      set({ contourSpot: null });
                    }}
                  >
                    ×
                  </button>
                </div>
              </li>
            </ul>
          ) : (
            <p className="muted">{spots.length ? 'Щёлкните по отметке, чтобы изменить её высоту.' : 'Пока нет ни одной.'}</p>
          )}
        </div>
        <button
          type="button" className="contour-more" title="Тот же кусок земли блок-моделью: области, лассо, разрез"
          onClick={() => {
            const focus = probe.current?.focus();
            if (focus) set({ relief: { ...focus, size: 120 } });
          }}
        >
          Блок-модель, области и разрез…
        </button>
      </aside>
    </>
  );
}
