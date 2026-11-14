import type { ReactNode } from 'react';
import { findTerritory } from '../core/data';
import { CAR_COLOURS } from '../engine/controls';
import { probe } from '../engine/probe';
import { useStore, type Ground, type Mode } from '../state/store';
import { toggleContours } from './Contours';

const Icon = ({ d, fill }: { d: string; fill?: boolean }) => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill={fill ? 'currentColor' : 'none'} stroke={fill ? 'none' : 'currentColor'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);
const ICONS = {
  overview: 'M3 7l6-3 6 3 6-3v13l-6 3-6-3-6 3V7zM9 4v13M15 7v13',
  walk: 'M13 4.5a1.5 1.5 0 1 0 0-.01M9.5 21l2-6-2.5-2.5 1-5 3 2.5 3 1M14 21l-1.5-5M7 12l1.5-4.5',
  drive: 'M5 16V12l1.8-4.5A2 2 0 0 1 8.7 6h6.6a2 2 0 0 1 1.9 1.5L19 12v4M4 16h16M7.5 16v2M16.5 16v2M5 12h14',
  play: 'M7 4.5v15l12-7.5z',
  pause: 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z',
  help: 'M9.2 9a3 3 0 1 1 4.6 2.5c-.9.6-1.8 1.3-1.8 2.5M12 17.5v.01',
  sound: 'M4 9.5h3l4.5-4v13l-4.5-4H4zM15 9a4 4 0 0 1 0 6M17.5 6.5a7.5 7.5 0 0 1 0 11',
  mute: 'M4 9.5h3l4.5-4v13l-4.5-4H4zM15.5 9.5l5 5M20.5 9.5l-5 5',
  top: 'M4 4h16v16H4zM4 12h16M12 4v16',
  contours: 'M3 12c3-5 6 5 9 0s6 5 9 0M3 6.5c3-5 6 5 9 0s6 5 9 0M3 17.5c3-5 6 5 9 0s6 5 9 0',
  relief: 'M3 18l5.5-9 3.5 5 3-4 6 8zM3 21h18',
  tilt: 'M3 17l9-12 9 12zM7.5 11h9',
  close: 'M6 6l12 12M18 6L6 18',
};

const formatTime = (h: number) => {
  const total = Math.round((((h % 24) + 24) % 24) * 60) % 1440;
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

export function PlaceBar() {
  const place = useStore((s) => s.place);
  const stats = useStore((s) => s.stats);
  const set = useStore((s) => s.set);
  const mode = useStore((s) => s.mode);
  const ground = useStore((s) => s.ground);
  const groundCredit = useStore((s) => s.groundCredit);
  const hasPhoto = useStore((s) => s.hasPhoto);
  const hasRender = useStore((s) => s.hasRender);
  const current = findTerritory(place);
  if (mode !== 'overview') return null;
  return (
    <header className="panel placebar">
      <div className="brand">
        <span className="logo">C</span>
        <div>
          <strong>Citia</strong>
          <small>цифровая копия · v2</small>
        </div>
      </div>
      {current && <h1 className="place-name">{current.name}</h1>}
      {current && <p className="about">{current.description}</p>}
      <div className="ground-pick">
        <span>Земля</span>
        <div className="segmented" role="group" aria-label="Чем раскрашена земля">
          {(
            [
              ['drawn', 'Рисунок', 'Земля нарисована движком по данным карты'],
              ['drone', 'Дрон', 'Снимок своей съёмки с дрона (июль 2023)'],
              ['satellite', 'Спутник', 'Спутниковый снимок — загружается из сети'],
              ['render', 'Карта', 'Сгенерированная карта деревни (вид сверху)'],
            ] as [Ground, string, string][]
          )
            .filter(([id]) => (id !== 'drone' || hasPhoto) && (id !== 'render' || hasRender))
            .map(([id, label, title]) => (
              <button key={id} type="button" title={title} className={((ground === 'drone' && !hasPhoto) || (ground === 'render' && !hasRender) ? 'drawn' : ground) === id ? 'on' : ''} onClick={() => set({ ground: id })}>
                {label}
              </button>
            ))}
        </div>
      </div>
      {stats && (
        <p className="stats">
          <span><b>{stats.buildings.toLocaleString('ru')}</b> зданий</span>
          <span><b>{stats.trees.toLocaleString('ru')}</b> деревьев</span>
          <span>данные © OpenStreetMap, Copernicus DEM</span>
          {ground === 'satellite' && groundCredit && <span>{groundCredit}</span>}
        </p>
      )}
    </header>
  );
}

export function Dock() {
  const mode = useStore((s) => s.mode);
  const set = useStore((s) => s.set);
  const items: [Mode, string, string][] = [['overview', 'Обзор', ICONS.overview], ['walk', 'Пешком', ICONS.walk], ['drive', 'За рулём', ICONS.drive]];
  return (
    <nav className="panel dock" aria-label="Режим">
      {items.map(([id, label, icon]) => (
        <button key={id} className={mode === id ? 'on' : ''} onClick={() => set({ mode: id })}>
          <Icon d={icon} />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}

const PRESETS: [string, number][] = [['Утро', 6.5], ['День', 13], ['Закат', 21.3], ['Ночь', 0.5]];

export function TimePanel() {
  const time = useStore((s) => s.time);
  const flow = useStore((s) => s.flow);
  const set = useStore((s) => s.set);
  const night = time < 4.8 || time > 22.2;
  return (
    <section className="panel timepanel" aria-label="Время суток">
      <div className="timehead">
        <span className={`orb ${night ? 'moon' : 'sun'}`} />
        <output>{formatTime(time)}</output>
        <div className="chips">
          {PRESETS.map(([label, hours]) => (
            <button key={label} className={Math.abs(time - hours) < 0.3 ? 'on' : ''} onClick={() => set({ time: hours, flow: false })}>
              {label}
            </button>
          ))}
        </div>
        <button className={`icon ${flow ? 'on' : ''}`} title={flow ? 'Остановить время' : 'Время идёт: сутки за 6 минут'} onClick={() => set({ flow: !flow })}>
          <Icon d={flow ? ICONS.pause : ICONS.play} fill />
        </button>
      </div>
      <input
        type="range" min={0} max={24} step={0.05} value={time} aria-label="Время"
        onChange={(e) => set({ time: Number(e.target.value), flow: false })}
        onPointerUp={(e) => e.currentTarget.blur()}
      />
    </section>
  );
}

export function Tools() {
  const mode = useStore((s) => s.mode);
  const topView = useStore((s) => s.topView);
  const carColour = useStore((s) => s.carColour);
  const sound = useStore((s) => s.sound);
  const contours = useStore((s) => s.contours);
  const set = useStore((s) => s.set);
  return (
    <aside className="tools">
      {mode === 'overview' && (
        <button className="panel round" title={topView ? 'Вид под углом' : 'Вид сверху'} onClick={() => set({ topView: !topView })}>
          <Icon d={topView ? ICONS.tilt : ICONS.top} />
        </button>
      )}
      {mode === 'overview' && (
        <button className={`panel round ${contours ? 'on' : ''}`} title="Править рельеф на сцене: горизонтали поверх карты и отметки высот" aria-pressed={contours} onClick={toggleContours}>
          <Icon d={ICONS.contours} />
        </button>
      )}
      {mode === 'overview' && (
        <button
          className="panel round" title="Рельеф: блок-модель, горизонтали, отметки высот и разрез"
          onClick={() => {
            const focus = probe.current?.focus();
            if (focus) set({ relief: { ...focus, size: 120 } });
          }}
        >
          <Icon d={ICONS.relief} />
        </button>
      )}
      {mode === 'drive' && (
        <div className="panel swatches" aria-label="Цвет машины">
          {CAR_COLOURS.map((c, i) => (
            <button key={c} className={i === carColour ? 'on' : ''} style={{ background: c }} title="Цвет машины" onClick={() => set({ carColour: i })} />
          ))}
        </div>
      )}
      <button className="panel round" title={sound ? 'Выключить звук' : 'Включить звук'} aria-pressed={sound} onClick={() => set({ sound: !sound })}>
        <Icon d={sound ? ICONS.sound : ICONS.mute} />
      </button>
      <button className="panel round" title="Управление" onClick={() => set({ help: true })}>
        <Icon d={ICONS.help} />
      </button>
    </aside>
  );
}

export function BuildingCard() {
  const b = useStore((s) => s.selected);
  const set = useStore((s) => s.set);
  if (!b) return null;
  const rows: [string, ReactNode][] = [
    ['Тип', b.type],
    ...(b.address && b.address !== b.title ? ([['Адрес', b.address]] as [string, ReactNode][]) : []),
    ...(b.levels ? ([['Этажей', b.levels]] as [string, ReactNode][]) : []),
    ['Высота', <>{b.height} м <em>· {b.heightSource}</em></>],
    ['Площадь', <>{b.area.toLocaleString('ru')} м²</>],
    ['Источник', b.id.startsWith('survey/') ? 'своя съёмка с дрона' : <a href={`https://www.openstreetmap.org/${b.id}`} target="_blank" rel="noreferrer">OSM · {b.id}</a>],
  ];
  return (
    <article className="panel card">
      <header>
        <h2>{b.title}</h2>
        <button className="icon" title="Закрыть" onClick={() => set({ selected: null })}>
          <Icon d={ICONS.close} />
        </button>
      </header>
      <dl>
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </article>
  );
}

export function Hud() {
  const mode = useStore((s) => s.mode);
  const street = useStore((s) => s.street);
  const speed = useStore((s) => s.speed);
  const locked = useStore((s) => s.locked);
  const set = useStore((s) => s.set);
  if (mode === 'overview') return null;
  return (
    <>
      <div className="hud-top">
        <button className="panel pill" onClick={() => set({ mode: 'overview' })}>← Обзор <kbd>Esc</kbd></button>
        {street && <div className="panel pill street">{street}</div>}
      </div>
      {mode === 'walk' && !locked && <div className="panel pill hint">Щёлкните по сцене, чтобы осматриваться мышью · <kbd>W A S D</kbd> — идти · <kbd>Shift</kbd> — бег</div>}
      {mode === 'drive' && (
        <div className="panel speedo">
          <output>{speed}</output>
          <small>км/ч</small>
        </div>
      )}
    </>
  );
}

const KEYS: Record<Mode, [string, string][]> = {
  overview: [
    ['Левая кнопка', 'двигать карту'], ['Правая кнопка / Shift', 'повернуть и наклонить'], ['Колесо', 'ближе и дальше'],
    ['Двойной щелчок', 'подлететь к точке'], ['W A S D', 'лететь над местностью'], ['Q E', 'поворот'], ['Щелчок по дому', 'сведения о здании'], ['V Y T B G', 'редактор: выбор, дом, дорога, забор, рельеф'], ['Ctrl+Z / Ctrl+Shift+Z', 'отменить / повторить правку'], ['Delete', 'убрать выбранное'],
  ],
  walk: [['W A S D', 'идти'], ['Мышь', 'осматриваться (после щелчка)'], ['Q E / ← →', 'поворот'], ['Shift', 'бег'], ['Esc', 'отпустить курсор, затем выйти']],
  drive: [['W / S', 'газ / тормоз и задний ход'], ['A D', 'руль'], ['Пробел', 'ручной тормоз'], ['Shift', 'быстрее (до 90 км/ч)'], ['C', 'камера из кабины'], ['R', 'вернуть на дорогу'], ['Колесо', 'камера ближе и дальше']],
};
const TITLES: Record<Mode, string> = { overview: 'Обзор', walk: 'Пешком', drive: 'За рулём' };

export function Help() {
  const help = useStore((s) => s.help);
  const set = useStore((s) => s.set);
  if (!help) return null;
  return (
    <div className="veil" onClick={() => set({ help: false })}>
      <div className="panel help" role="dialog" aria-label="Управление" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Управление</h2>
          <button className="icon" title="Закрыть" onClick={() => set({ help: false })}>
            <Icon d={ICONS.close} />
          </button>
        </header>
        <div className="helpgrid">
          {(Object.keys(KEYS) as Mode[]).map((m) => (
            <section key={m}>
              <h3>{TITLES[m]}</h3>
              {KEYS[m].map(([k, v]) => (
                <p key={k}>
                  <kbd>{k}</kbd>
                  <span>{v}</span>
                </p>
              ))}
            </section>
          ))}
        </div>
        <button className="primary" onClick={() => set({ help: false })}>Понятно</button>
      </div>
    </div>
  );
}

export function Loader() {
  const loading = useStore((s) => s.loading);
  const error = useStore((s) => s.error);
  const place = useStore((s) => s.place);
  if (!loading && !error) return null;
  return (
    <div className="veil loader">
      <div>
        <span className="logo big">C</span>
        <h1>{findTerritory(place)?.name ?? 'Citia'}</h1>
        {error ? <p className="error">{error}</p> : (
          <>
            <p>{loading}…</p>
            <div className="bar"><i /></div>
          </>
        )}
      </div>
    </div>
  );
}
