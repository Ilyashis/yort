// Окно «Рельеф»: кусок земли блок-моделью с горизонталями, опорные отметки (земля проходит через
// высоту, введённую числом) и разрез по линии. Правит те же правки, что и остальной редактор.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { P2 } from '../core/geo';
import { probe } from '../engine/probe';
import { useStore } from '../state/store';
import { useEditStore } from '../store/useEditStore';
import { SPOT_RADIUS, removeSpot, upsertSpot, type TerrainSpot } from '../world/edit/edits';
import { ReliefBlock } from './reliefBlock';

const SIZES = [60, 120, 250, 500];
const STEPS = [0.1, 0.25, 0.5, 1, 2];
const RADII = [6, 10, 14, 20, 30, 50, 80];
type Tool = 'view' | 'spot' | 'section';

const metres = (v: number, digits = 2) => v.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** График разреза: естественная земля пунктиром, нынешняя — линией. */
function Section({ a, b, rev }: { a: P2; b: P2; rev: number }) {
  const data = useMemo(() => {
    const p = probe.current;
    if (!p) return undefined;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(2, Math.min(240, Math.ceil(length / 0.5)));
    const now: number[] = [], was: number[] = [];
    for (let k = 0; k <= n; k++) {
      const x = a[0] + ((b[0] - a[0]) * k) / n, z = a[1] + ((b[1] - a[1]) * k) / n;
      now.push(p.hm.at(x, z) + p.hm.origin);
      was.push(p.hm.atNatural(x, z) + p.hm.origin);
    }
    return { length, now, was };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a, b, rev]);
  if (!data || data.length < 0.5) return null;
  const { length, now, was } = data;
  const lo = Math.min(...now, ...was), hi = Math.max(...now, ...was);
  const span = Math.max(hi - lo, 0.2);
  const W = 560, H = 120, pad = 6;
  const path = (values: number[]) => values.map((v, k) => `${k ? 'L' : 'M'}${(pad + (k / (values.length - 1)) * (W - pad * 2)).toFixed(1)},${(H - pad - ((v - lo) / span) * (H - pad * 2)).toFixed(1)}`).join(' ');
  const rise = now[now.length - 1] - now[0];
  return (
    <div className="relief-section">
      <p>
        <span>Разрез <b>{metres(length, 1)} м</b></span>
        <span>перепад <b>{rise > 0 ? '+' : rise < 0 ? '−' : ''}{metres(Math.abs(rise))} м</b></span>
        <span>уклон <b>{metres((Math.abs(rise) / length) * 100, 1)} %</b></span>
        <span className="muted">{metres(lo, 1)}…{metres(hi, 1)} м · пунктир — естественная земля</span>
      </p>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Профиль земли вдоль разреза">
        <path d={`${path(now)} L${W - pad},${H} L${pad},${H} Z`} className="fill" />
        <path d={path(was)} className="was" />
        <path d={path(now)} className="now" />
      </svg>
    </div>
  );
}

/** Высота отметки: вводится числом и применяется по Enter или уходу из поля; кнопки двигают на 10 см. */
function SpotHeight({ spot, label, onChange }: { spot: TerrainSpot; label: string; onChange: (height: number) => void }) {
  const [draft, setDraft] = useState<string>();
  const apply = () => {
    const value = Number.parseFloat((draft ?? '').replace(',', '.'));
    if (draft !== undefined && Number.isFinite(value) && Math.abs(value - spot.height) < 500) onChange(value);
    setDraft(undefined);
  };
  return (
    <span className="relief-height">
      <button type="button" title="Ниже на 10 см" onClick={() => onChange(spot.height - 0.1)}>
        −
      </button>
      <input
        inputMode="decimal" aria-label={label} title="Высота над уровнем моря, м. Enter — применить"
        value={draft ?? metres(spot.height)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={apply}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
      />
      <button type="button" title="Выше на 10 см" onClick={() => onChange(spot.height + 0.1)}>
        +
      </button>
    </span>
  );
}

export function Relief() {
  const relief = useStore((s) => s.relief);
  const rev = useStore((s) => s.terrainRev);
  const set = useStore((s) => s.set);
  const edits = useEditStore((s) => s.edits);
  const commit = useEditStore((s) => s.commit);
  const canvas = useRef<HTMLCanvasElement>(null);
  const block = useRef<ReliefBlock | null>(null);
  const [tool, setTool] = useState<Tool>('view');
  const [exaggeration, setExaggeration] = useState(3);
  const [step, setStep] = useState(0.5);
  const [selected, setSelected] = useState<string>();
  const [section, setSection] = useState<[P2, P2?]>();
  const [hover, setHover] = useState<{ x: number; z: number; height: number }>();
  const [range, setRange] = useState<[number, number]>([0, 0]);
  // Обработчик щелчка по блоку живёт в сцене дольше одного рендера — держим свежий через ref.
  const onPick = useRef<(x: number, z: number) => void>(() => undefined);

  const spots = edits.spots ?? [];
  const p = probe.current;
  const inBlock = (x: number, z: number) => !!relief && Math.abs(x - relief.x) <= relief.size / 2 && Math.abs(z - relief.z) <= relief.size / 2;
  const local = useMemo(
    () => (p ? spots.map((s) => ({ spot: s, xz: p.world.frame.xz(s.at[0], s.at[1]) })).filter(({ xz }) => inBlock(xz[0], xz[1])) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [spots, relief, p],
  );

  onPick.current = (x, z) => {
    if (!p) return;
    if (tool === 'spot') {
      const id = `spot/${Date.now().toString(36)}`;
      const spot: TerrainSpot = { id, at: [p.world.frame.lon(x), p.world.frame.lat(z)], height: p.hm.at(x, z) + p.hm.origin, radius: SPOT_RADIUS.initial };
      commit(upsertSpot(useEditStore.getState().edits, spot));
      setSelected(id);
    } else if (tool === 'section') {
      setSection((current) => (!current || current[1] ? [[x, z]] : [current[0], [x, z]]));
    } else {
      // В режиме просмотра щелчок рядом с отметкой выбирает её.
      const near = local.map(({ spot, xz }) => ({ spot, d: Math.hypot(xz[0] - x, xz[1] - z) })).sort((m, n) => m.d - n.d)[0];
      setSelected(near && near.d < (relief?.size ?? 100) / 25 ? near.spot.id : undefined);
    }
  };

  useEffect(() => {
    if (!relief || !canvas.current) return;
    const instance = new ReliefBlock(canvas.current, { onPick: (x, z) => onPick.current(x, z), onHover: setHover });
    block.current = instance;
    return () => {
      instance.dispose();
      block.current = null;
    };
  }, [!!relief]);

  useEffect(() => {
    const b = block.current;
    if (!b || !relief || !p) return;
    b.setData({ x: relief.x, z: relief.z, size: relief.size, heightAt: (x, z) => p.hm.at(x, z), buildings: p.world.buildings.map((f) => f.rings), roads: p.world.roads });
    setRange([b.min + p.hm.origin, b.max + p.hm.origin]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relief, rev, p]);

  useEffect(() => {
    block.current?.setMarks({ spots: local.map(({ spot, xz }) => ({ id: spot.id, x: xz[0], z: xz[1], radius: spot.radius })), selected, section });
  }, [local, selected, section, rev, relief]);
  useEffect(() => block.current?.setExaggeration(exaggeration), [exaggeration, relief]);
  useEffect(() => block.current?.setContourStep(step), [step, relief]);

  useEffect(() => {
    if (!relief) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        set({ relief: null });
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [!!relief, set]);

  if (!relief || !p) return null;
  const update = (spot: TerrainSpot, patch: Partial<TerrainSpot>) => commit(upsertSpot(useEditStore.getState().edits, { ...spot, ...patch }));
  const hints: Record<Tool, string> = {
    view: 'Тяните блок мышью, чтобы повернуть; колесо — ближе и дальше. Щелчок по отметке выбирает её.',
    spot: 'Щёлкните по земле — появится отметка с нынешней высотой. Впишите нужную высоту: земля пройдёт через неё.',
    section: 'Щёлкните две точки — внизу появится профиль земли между ними.',
  };

  return (
    <div className="veil relief-veil" onClick={() => set({ relief: null })}>
      <div className="panel relief" role="dialog" aria-label="Рельеф" onClick={(e) => e.stopPropagation()}>
        <header>
          <div>
            <h2>Рельеф</h2>
            <small>
              {relief.size} × {relief.size} м · от {metres(range[0], 1)} до {metres(range[1], 1)} м над морем · перепад {metres(range[1] - range[0], 1)} м
            </small>
          </div>
          <div className="segmented" role="group" aria-label="Размер куска">
            {SIZES.map((size) => (
              <button key={size} type="button" className={relief.size === size ? 'on' : ''} onClick={() => set({ relief: { ...relief, size } })}>
                {size} м
              </button>
            ))}
          </div>
          <button type="button" className="icon" title="Закрыть" onClick={() => set({ relief: null })}>
            ×
          </button>
        </header>

        <div className="relief-body">
          <div className="relief-view">
            <canvas ref={canvas} className={tool === 'view' ? '' : 'aim'} />
            <output>{hover ? `${metres(hover.height + p.hm.origin)} м` : ''}</output>
            <p className="relief-hint">{hints[tool]}</p>
          </div>

          <aside>
            <div className="segmented" role="group" aria-label="Инструмент">
              {([['view', 'Смотреть'], ['spot', 'Отметка'], ['section', 'Разрез']] as [Tool, string][]).map(([id, label]) => (
                <button key={id} type="button" className={tool === id ? 'on' : ''} onClick={() => setTool(id)}>
                  {label}
                </button>
              ))}
            </div>

            <label className="relief-field">
              <span>Высоты преувеличены <b>× {exaggeration}</b></span>
              <input type="range" min={1} max={12} step={1} value={exaggeration} onChange={(e) => setExaggeration(Number(e.target.value))} />
            </label>

            <div className="relief-field">
              <span>Горизонтали через</span>
              <div className="segmented" role="group" aria-label="Шаг горизонталей">
                {STEPS.map((value) => (
                  <button key={value} type="button" className={step === value ? 'on' : ''} onClick={() => setStep(value)}>
                    {String(value).replace('.', ',')}
                  </button>
                ))}
              </div>
            </div>

            <div className="relief-field">
              <span>Опорные отметки {local.length ? <b>{local.length}</b> : null}</span>
              {local.length === 0 && <p className="muted">Пока нет. Включите «Отметка» и щёлкните по земле.</p>}
              <ul className="relief-spots">
                {local.map(({ spot }, n) => (
                  <li key={spot.id} className={spot.id === selected ? 'on' : ''} onClick={() => setSelected(spot.id)}>
                    <i>{n + 1}</i>
                    <SpotHeight spot={spot} label={`Высота отметки ${n + 1}, м`} onChange={(height) => update(spot, { height })} />
                    <select value={spot.radius} aria-label={`Радиус отметки ${n + 1}`} title="Докуда отметка меняет землю" onChange={(e) => update(spot, { radius: Number(e.target.value) })}>
                      {[...new Set([...RADII, spot.radius])].sort((m, k) => m - k).map((r) => (
                        <option key={r} value={r}>
                          {r} м вокруг
                        </option>
                      ))}
                    </select>
                    <button type="button" title="Убрать отметку" onClick={(e) => { e.stopPropagation(); commit(removeSpot(useEditStore.getState().edits, spot.id)); }}>
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </aside>
        </div>

        {section?.[1] && <Section a={section[0]} b={section[1]} rev={rev} />}
      </div>
    </div>
  );
}
