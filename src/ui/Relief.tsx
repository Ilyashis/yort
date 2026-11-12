// Окно «Рельеф»: кусок земли блок-моделью с горизонталями. Землю уточняют опорными отметками (высота
// числом), сдвигом горизонтали мышью и правками по областям (плоскость с уклоном, терраса, сглаживание);
// разрез показывает профиль. Всё это — те же правки, что и у остального редактора.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { P2 } from '../core/geo';
import { fitPlaneAt } from '../engine/levelling';
import { probe } from '../engine/probe';
import { useStore } from '../state/store';
import { useEditStore } from '../store/useEditStore';
import { SPOT_RADIUS, removeShape, removeSpot, upsertShape, upsertSpot, type TerrainShape, type TerrainSpot } from '../world/edit/edits';
import { ReliefBlock } from './reliefBlock';

const SIZES = [60, 120, 250, 500];
const STEPS = [0.1, 0.25, 0.5, 1, 2];
const RADII = [6, 10, 14, 20, 30, 50, 80];
type Tool = 'view' | 'spot' | 'pull' | 'area' | 'section';
type AreaOp = 'fit' | 'level' | 'terrace' | 'smooth' | 'natural';

const TOOLS: [Tool, string][] = [['view', 'Смотреть'], ['spot', 'Отметка'], ['pull', 'Горизонталь'], ['area', 'Область'], ['section', 'Разрез']];
const AREA_OPS: [AreaOp, string, string][] = [
  ['fit', 'Плоскость', 'Ровная плоскость по нынешнему уклону: бугры и ямы уходят, уклон остаётся'],
  ['level', 'Ровно', 'Горизонтальная площадка с мягкими краями'],
  ['terrace', 'Терраса', 'Горизонтальная площадка с крутым откосом по краю'],
  ['smooth', 'Сгладить', 'Сгладить неровности, не меняя общий уклон'],
  ['natural', 'Как было', 'Вернуть здесь естественную землю — без площадок, улиц и правок'],
];
const HINTS: Record<Tool, string> = {
  view: 'Тяните блок мышью, чтобы повернуть; колесо — ближе и дальше. Щелчок по отметке или области выбирает её.',
  spot: 'Щёлкните по земле — появится отметка с нынешней высотой. Впишите нужную: земля пройдёт через неё.',
  pull: 'Возьмите горизонталь и перетащите: она пройдёт через точку, где вы отпустите. Вращать — с Shift.',
  area: 'Выберите, что сделать, и щёлкните по земле — правка ляжет кругом вокруг этой точки.',
  section: 'Щёлкните две точки — внизу появится профиль земли между ними.',
};

const metres = (v: number, digits = 2) => v.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const newId = (prefix: string) => `${prefix}/${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

/** Число, которое вводят руками: применяется по Enter или уходу из поля; кнопки двигают на шаг. */
function Num({ value, step, digits, label, title, suffix, onChange }: { value: number; step: number; digits: number; label: string; title: string; suffix?: string; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState<string>();
  const apply = () => {
    const next = Number.parseFloat((draft ?? '').replace(',', '.').replace(/\s/g, ''));
    if (draft !== undefined && Number.isFinite(next)) onChange(next);
    setDraft(undefined);
  };
  return (
    <span className="relief-num" title={title}>
      <button type="button" aria-label={`${label}: меньше`} onClick={() => onChange(value - step)}>
        −
      </button>
      <input
        inputMode="decimal" aria-label={label}
        value={draft ?? metres(value, digits)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={apply}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
      />
      {suffix && <em>{suffix}</em>}
      <button type="button" aria-label={`${label}: больше`} onClick={() => onChange(value + step)}>
        +
      </button>
    </span>
  );
}

function Radius({ value, label, onChange }: { value: number; label: string; onChange: (radius: number) => void }) {
  return (
    <select value={value} aria-label={label} title="Докуда правка меняет землю" onChange={(e) => onChange(Number(e.target.value))}>
      {[...new Set([...RADII, value])].sort((m, k) => m - k).map((r) => (
        <option key={r} value={r}>
          {r} м вокруг
        </option>
      ))}
    </select>
  );
}

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

const shapeName = (shape: TerrainShape) =>
  shape.kind === 'smooth' ? 'Сглажено' : shape.kind === 'natural' ? 'Как было' : (shape.slope ?? 0) > 0 ? 'Плоскость' : shape.edge < 0.2 ? 'Терраса' : 'Ровно';

export function Relief() {
  const relief = useStore((s) => s.relief);
  const rev = useStore((s) => s.terrainRev);
  const set = useStore((s) => s.set);
  const edits = useEditStore((s) => s.edits);
  const commit = useEditStore((s) => s.commit);
  const canvas = useRef<HTMLCanvasElement>(null);
  const block = useRef<ReliefBlock | null>(null);
  const [tool, setTool] = useState<Tool>('view');
  const [areaOp, setAreaOp] = useState<AreaOp>('fit');
  const [exaggeration, setExaggeration] = useState(3);
  const [step, setStep] = useState(0.5);
  const [selected, setSelected] = useState<string>();
  const [section, setSection] = useState<[P2, P2?]>();
  const [pull, setPull] = useState<[P2, P2]>();
  const [hover, setHover] = useState<{ x: number; z: number; height: number }>();
  const [range, setRange] = useState<[number, number]>([0, 0]);
  // Обработчики блока живут в сцене дольше одного рендера — держим свежие через ref.
  const touched = useRef(false);
  const onPick = useRef<(x: number, z: number) => void>(() => undefined);
  const onLine = useRef<(from: P2, to: P2, done: boolean) => void>(() => undefined);

  const p = probe.current;
  const inBlock = (x: number, z: number) => !!relief && Math.abs(x - relief.x) <= relief.size / 2 && Math.abs(z - relief.z) <= relief.size / 2;
  const spots = useMemo(
    () => (p ? (edits.spots ?? []).map((spot) => ({ spot, xz: p.world.frame.xz(spot.at[0], spot.at[1]) })).filter(({ xz }) => inBlock(xz[0], xz[1])) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [edits.spots, relief, p],
  );
  const shapes = useMemo(
    () => (p ? (edits.shapes ?? []).map((shape) => ({ shape, xz: p.world.frame.xz(shape.at[0], shape.at[1]) })).filter(({ xz }) => inBlock(xz[0], xz[1])) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [edits.shapes, relief, p],
  );
  const now = () => useEditStore.getState().edits;

  onPick.current = (x, z) => {
    if (!p) return;
    const at: [number, number] = [p.world.frame.lon(x), p.world.frame.lat(z)];
    const sea = (h: number) => h + p.hm.origin;
    if (tool === 'spot') {
      const id = newId('spot');
      commit(upsertSpot(now(), { id, at, height: sea(p.hm.at(x, z)), radius: SPOT_RADIUS.initial }));
      setSelected(id);
    } else if (tool === 'area') {
      const id = newId('area');
      const radius = Math.min(SPOT_RADIUS.max, Math.max(6, Math.round(relief!.size / 10)));
      const plane = fitPlaneAt((px, pz) => p.hm.at(px, pz), x, z, radius);
      const shape: TerrainShape =
        areaOp === 'smooth' || areaOp === 'natural'
          ? { id, kind: areaOp, at, radius, edge: 0.4 }
          : { id, kind: 'plane', at, radius, edge: areaOp === 'terrace' ? 0.12 : 0.4, height: sea(plane.height), slope: areaOp === 'fit' ? plane.slope : 0, bearing: areaOp === 'fit' ? plane.bearing : 0 };
      commit(upsertShape(now(), shape));
      setSelected(id);
    } else if (tool === 'section') {
      setSection((current) => (!current || current[1] ? [[x, z]] : [current[0], [x, z]]));
    } else if (tool === 'view') {
      const near = [...spots.map(({ spot, xz }) => ({ id: spot.id, d: Math.hypot(xz[0] - x, xz[1] - z) })), ...shapes.map(({ shape, xz }) => ({ id: shape.id, d: Math.hypot(xz[0] - x, xz[1] - z) }))].sort((m, n) => m.d - n.d)[0];
      setSelected(near && near.d < relief!.size / 20 ? near.id : undefined);
    }
  };
  onLine.current = (from, to, done) => {
    if (!p) return;
    if (!done) return setPull([from, to]);
    setPull(undefined);
    // Горизонталь, взятая в точке from, теперь проходит через to: там земля получает высоту точки from.
    const id = newId('spot');
    const reach = Math.hypot(to[0] - from[0], to[1] - from[1]);
    commit(upsertSpot(now(), { id, at: [p.world.frame.lon(to[0]), p.world.frame.lat(to[1])], height: p.hm.at(from[0], from[1]) + p.hm.origin, radius: Math.max(6, Math.round(reach * 1.25)) }));
    setSelected(id);
  };

  useEffect(() => {
    if (!relief || !canvas.current) return;
    const instance = new ReliefBlock(canvas.current, { onPick: (x, z) => onPick.current(x, z), onHover: setHover, onLine: (from, to, done) => onLine.current(from, to, done) });
    block.current = instance;
    return () => {
      instance.dispose();
      block.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!relief]);

  useEffect(() => {
    const b = block.current;
    if (!b || !relief || !p) return;
    b.setData({ x: relief.x, z: relief.z, size: relief.size, origin: p.hm.origin, heightAt: (x, z) => p.hm.at(x, z), buildings: p.world.buildings.map((f) => f.rings), roads: p.world.roads });
    setRange([b.min + p.hm.origin, b.max + p.hm.origin]);
    // Пока ползунок не трогали, преувеличение подбирается само: блок высотой примерно в пятую часть стороны.
    if (!touched.current) setExaggeration(Math.min(8, Math.max(1, Math.round((relief.size * 0.2) / Math.max(b.max - b.min, 0.5)))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relief, rev, p]);

  useEffect(() => {
    block.current?.setMarks({
      spots: spots.map(({ spot, xz }) => ({ id: spot.id, x: xz[0], z: xz[1], radius: spot.radius })),
      areas: shapes.map(({ shape, xz }) => ({ id: shape.id, x: xz[0], z: xz[1], radius: shape.radius, uphill: shape.kind === 'plane' && (shape.slope ?? 0) > 0 ? shape.bearing : undefined })),
      selected,
      section,
      pull,
    });
  }, [spots, shapes, selected, section, pull, rev, relief]);
  useEffect(() => block.current?.setExaggeration(exaggeration), [exaggeration, relief]);
  useEffect(() => block.current?.setContourStep(step), [step, relief]);
  useEffect(() => {
    if (block.current) block.current.lineDrag = tool === 'pull';
  }, [tool, relief]);

  /** Сдвинуть кусок на четверть его стороны — в ту сторону, куда показывает стрелка на экране. */
  const shift = (right: number, away: number) => {
    const b = block.current;
    if (!b || !relief) return;
    const h = b.heading(), d = relief.size / 4;
    set({ relief: { ...relief, x: relief.x + (h.right[0] * right + h.away[0] * away) * d, z: relief.z + (h.right[1] * right + h.away[1] * away) * d } });
  };

  useEffect(() => {
    if (!relief) return;
    const onKey = (e: KeyboardEvent) => {
      const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes((e.target as HTMLElement | null)?.tagName ?? '');
      const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
      if (e.key === 'Escape') set({ relief: null });
      else if (arrows[e.key] && !typing) shift(...arrows[e.key]);
      else if (!typing && !(e.metaKey || e.ctrlKey)) {
        // Клавиши обзора (W A S D и прочие) под открытым окном не должны двигать камеру.
        e.stopPropagation();
        return;
      } else return;
      e.stopPropagation();
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relief, set]);

  if (!relief || !p) return null;
  const setSpot = (spot: TerrainSpot, patch: Partial<TerrainSpot>) => commit(upsertSpot(now(), { ...spot, ...patch }));
  const setShape = (shape: TerrainShape, patch: Partial<TerrainShape>) => commit(upsertShape(now(), { ...shape, ...patch }));

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
          <button type="button" className="icon" title="Закрыть" aria-label="Закрыть" onClick={() => set({ relief: null })}>
            ×
          </button>
        </header>

        <div className="relief-body">
          <div className="relief-view">
            <canvas ref={canvas} className={tool === 'view' ? '' : 'aim'} />
            <output>{hover ? `${metres(hover.height + p.hm.origin)} м` : ''}</output>
            <div className="relief-pan" role="group" aria-label="Сдвинуть кусок">
              <button type="button" title="Сдвинуть кусок от себя (↑)" style={{ gridArea: 'u' }} onClick={() => shift(0, 1)}>↑</button>
              <button type="button" title="Сдвинуть кусок влево (←)" style={{ gridArea: 'l' }} onClick={() => shift(-1, 0)}>←</button>
              <button type="button" title="Сдвинуть кусок вправо (→)" style={{ gridArea: 'r' }} onClick={() => shift(1, 0)}>→</button>
              <button type="button" title="Сдвинуть кусок к себе (↓)" style={{ gridArea: 'd' }} onClick={() => shift(0, -1)}>↓</button>
            </div>
            <p className="relief-hint">{HINTS[tool]}</p>
          </div>

          <aside>
            <div className="segmented relief-tools" role="group" aria-label="Инструмент">
              {TOOLS.map(([id, label]) => (
                <button key={id} type="button" className={tool === id ? 'on' : ''} onClick={() => setTool(id)}>
                  {label}
                </button>
              ))}
            </div>

            {tool === 'area' && (
              <div className="relief-field">
                <span>Что сделать с областью</span>
                <div className="segmented relief-tools" role="group" aria-label="Правка области">
                  {AREA_OPS.map(([id, label, title]) => (
                    <button key={id} type="button" title={title} className={areaOp === id ? 'on' : ''} onClick={() => setAreaOp(id)}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <label className="relief-field">
              <span>Высоты преувеличены <b>× {exaggeration}</b></span>
              <input type="range" min={1} max={12} step={1} value={exaggeration} onChange={(e) => { touched.current = true; setExaggeration(Number(e.target.value)); }} />
            </label>

            <div className="relief-field">
              <span>Горизонтали через, м</span>
              <div className="segmented" role="group" aria-label="Шаг горизонталей">
                {STEPS.map((value) => (
                  <button key={value} type="button" className={step === value ? 'on' : ''} onClick={() => setStep(value)}>
                    {String(value).replace('.', ',')}
                  </button>
                ))}
              </div>
            </div>

            <div className="relief-field">
              <span>Области {shapes.length ? <b>{shapes.length}</b> : null}</span>
              {shapes.length === 0 && <p className="muted">Пока нет. «Область» — плоскость, терраса, сглаживание.</p>}
              <ul className="relief-list">
                {shapes.map(({ shape }) => (
                  <li key={shape.id} className={shape.id === selected ? 'on' : ''} onClick={() => setSelected(shape.id)}>
                    <div>
                      <strong>{shapeName(shape)}</strong>
                      <Radius value={shape.radius} label={`${shapeName(shape)}: радиус`} onChange={(radius) => setShape(shape, { radius })} />
                      <button type="button" title="Убрать правку" aria-label="Убрать правку" onClick={(e) => { e.stopPropagation(); commit(removeShape(now(), shape.id)); }}>
                        ×
                      </button>
                    </div>
                    {shape.kind === 'plane' && (
                      <>
                        <div>
                          <Num value={shape.height ?? 0} step={0.1} digits={2} suffix="м" label="Высота в центре, м" title="Высота в центре над уровнем моря, м" onChange={(height) => setShape(shape, { height })} />
                          <button type="button" className={`wide ${shape.edge < 0.2 ? 'on' : ''}`} title="Крутой откос по краю вместо плавного перехода" onClick={(e) => { e.stopPropagation(); setShape(shape, { edge: shape.edge < 0.2 ? 0.4 : 0.12 }); }}>
                            откос
                          </button>
                        </div>
                        <div>
                          <Num value={shape.slope ?? 0} step={0.5} digits={1} suffix="%" label="Уклон, %" title="Уклон, %: сколько сантиметров подъёма на метр" onChange={(slope) => setShape(shape, { slope })} />
                          <Num value={shape.bearing ?? 0} step={15} digits={0} suffix="°" label="Куда поднимается, градусы" title="Куда поднимается: 0° — на север, 90° — на восток" onChange={(bearing) => setShape(shape, { bearing })} />
                        </div>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </div>

            <div className="relief-field">
              <span>Опорные отметки {spots.length ? <b>{spots.length}</b> : null}</span>
              {spots.length === 0 && <p className="muted">Пока нет. «Отметка» — высота числом, «Горизонталь» — сдвиг мышью.</p>}
              <ul className="relief-list">
                {spots.map(({ spot }, n) => (
                  <li key={spot.id} className={spot.id === selected ? 'on' : ''} onClick={() => setSelected(spot.id)}>
                    <div>
                      <i>{n + 1}</i>
                      <Num value={spot.height} step={0.1} digits={2} suffix="м" label={`Высота отметки ${n + 1}, м`} title="Высота над уровнем моря, м. Enter — применить" onChange={(height) => setSpot(spot, { height })} />
                      <Radius value={spot.radius} label={`Радиус отметки ${n + 1}`} onChange={(radius) => setSpot(spot, { radius })} />
                      <button type="button" title="Убрать отметку" aria-label="Убрать отметку" onClick={(e) => { e.stopPropagation(); commit(removeSpot(now(), spot.id)); }}>
                        ×
                      </button>
                    </div>
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
