// Мобильная версия: сцена на весь экран, крупные кнопки по краям, переключатель режимов внизу.
// Обзор — жесты карты; «Пешком» — стик слева, осмотр пальцем справа, касание земли — дойти туда;
// «Машина» — руль слева, газ и тормоз справа. Настройки — в листах снизу. Подсказки — один раз.

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { findTerritory, territories } from '../config/territory';
import { useAppStore } from '../store/useAppStore';
import { formatTime, lightingAt, sunElevationAt } from '../three/dayNight';
import { CAR_COLORS } from '../world/drive/carModel';
import { Minimap } from './Minimap';
import { useDismiss } from './useDismiss';

// --- когда показывать -----------------------------------------------------------------------------

/** Телефон или планшет (палец), или узкое окно; ?mobile — принудительно (проверить на компьютере). */
const MOBILE_QUERY = '(pointer: coarse), (max-width: 760px)';
const FORCED = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('mobile');

export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() => FORCED || window.matchMedia(MOBILE_QUERY).matches);
  useEffect(() => {
    if (FORCED) return;
    const query = window.matchMedia(MOBILE_QUERY);
    const update = () => setMobile(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return mobile;
}

/** Подсказка показывается один раз: после первого действия запоминаем. */
function useOnce(key: string, active: boolean): [boolean, () => void] {
  const storageKey = `citia:hint:${key}`;
  const [seen, setSeen] = useState(() => {
    try {
      return window.localStorage.getItem(storageKey) === '1';
    } catch {
      return false;
    }
  });
  const done = useCallback(() => {
    setSeen(true);
    try {
      window.localStorage.setItem(storageKey, '1');
    } catch {
      // без хранилища — подскажем и в следующий раз
    }
  }, [storageKey]);
  return [active && !seen, done];
}

/** Убрать подсказку при первом касании сцены (или через timeout мс). */
function useDismissOnTouch(show: boolean, done: () => void, timeout = 0) {
  useEffect(() => {
    if (!show) return;
    const onDown = (event: PointerEvent) => {
      if ((event.target as Element | null)?.closest?.('canvas, .m-stick-zone, .m-hold')) done();
    };
    window.addEventListener('pointerdown', onDown, true);
    const timer = timeout ? window.setTimeout(done, timeout) : 0;
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.clearTimeout(timer);
    };
  }, [show, done, timeout]);
}

// --- значки ---------------------------------------------------------------------------------------

const Icon = ({ children, size = 24 }: { children: ReactNode; size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);
const OverviewIcon = () => (
  <Icon>
    <path d="M3 18l5-7 4 5 3-4 6 6z" />
    <circle cx="17" cy="6" r="2" />
  </Icon>
);
const WalkIcon = () => (
  <Icon>
    <circle cx="13" cy="4.5" r="2" />
    <path d="M10 21l2-6 3 3v3M9 11l3-3 3 3 3 1M12 8l-1 6" />
  </Icon>
);
const CarIcon = () => (
  <Icon>
    <path d="M4 16v-4l2-5h12l2 5v4z" />
    <circle cx="7.5" cy="16.5" r="1.8" />
    <circle cx="16.5" cy="16.5" r="1.8" />
  </Icon>
);
const SunIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="4.2" fill="currentColor" stroke="none" />
    <path d="M12 2.5v2.3M12 19.2v2.3M2.5 12h2.3M19.2 12h2.3M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6" />
  </Icon>
);
const MoonIcon = () => (
  <Icon>
    <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" fill="currentColor" stroke="none" />
  </Icon>
);
const SnowIcon = () => (
  <Icon>
    <path d="M12 2.5v19M3.8 7.2l16.4 9.6M20.2 7.2L3.8 16.8M9 3.8l3 2 3-2M9 20.2l3-2 3 2" />
  </Icon>
);
const SoundOnIcon = () => (
  <Icon>
    <path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor" />
    <path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" />
  </Icon>
);
const SoundOffIcon = () => (
  <Icon>
    <path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor" />
    <path d="M16.5 9.5l5 5m0-5l-5 5" />
  </Icon>
);
const MoreIcon = () => (
  <Icon>
    <circle cx="6" cy="12" r="1.4" fill="currentColor" />
    <circle cx="12" cy="12" r="1.4" fill="currentColor" />
    <circle cx="18" cy="12" r="1.4" fill="currentColor" />
  </Icon>
);
const BackIcon = () => (
  <Icon>
    <path d="M15 5l-7 7 7 7" />
  </Icon>
);
const ChevronDown = () => (
  <Icon size={18}>
    <path d="M6 9l6 6 6-6" />
  </Icon>
);
const CameraIcon = () => (
  <Icon>
    <path d="M4 8h3l2-2.5h6L17 8h3v11H4z" />
    <circle cx="12" cy="13" r="3.4" />
  </Icon>
);

// --- общие части ---------------------------------------------------------------------------------

type Sheet = 'atmosphere' | 'more' | 'place';

function RoundButton({ label, onClick, children, on, className = '' }: { label: string; onClick: () => void; children: ReactNode; on?: boolean; className?: string }) {
  return (
    <div className="m-round-wrap">
      <button type="button" className={`m-glass m-round ${on ? 'on' : ''} ${className}`} onClick={onClick} aria-label={label} aria-pressed={on}>
        {children}
      </button>
      <span className="m-round-label">{label}</span>
    </div>
  );
}

function BottomSheet({ title, extra, onClose, children }: { title: string; extra?: ReactNode; onClose: () => void; children: ReactNode }) {
  const ref = useDismiss(onClose, '.m-sheet-opener');
  return (
    <div ref={ref} className="m-glass m-sheet" role="dialog" aria-label={title}>
      <button type="button" className="m-sheet-grab" onClick={onClose} aria-label="Закрыть" />
      <div className="m-sheet-head">
        <span>{title}</span>
        {extra}
      </div>
      {children}
    </div>
  );
}

function useTerritoryLatLon() {
  const territoryId = useAppStore((s) => s.territoryId);
  return useMemo(() => {
    const bbox = findTerritory(territoryId)?.bbox;
    return bbox ? { lat: (bbox.south + bbox.north) / 2, lon: (bbox.west + bbox.east) / 2 } : { lat: 54.72, lon: 55.94 };
  }, [territoryId]);
}

function skyGradient(lat: number, lon: number): string {
  const stops: string[] = [];
  for (let h = 0; h <= 24; h += 0.5) {
    const [r, g, b] = lightingAt(sunElevationAt(h, lat, lon)).fog.map((v) => Math.round(v * 255));
    stops.push(`rgb(${r}, ${g}, ${b}) ${((h / 24) * 100).toFixed(1)}%`);
  }
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

const nowHours = () => {
  const d = new Date();
  return d.getHours() + d.getMinutes() / 60;
};

const TIME_CHIPS: { label: string; hours?: number }[] = [
  { label: 'Рассвет', hours: 6.5 },
  { label: 'День', hours: 13 },
  { label: 'Закат', hours: 21.25 },
  { label: 'Ночь', hours: 0.5 },
  { label: 'Сейчас' },
];

/** Атмосфера: время суток и время года. */
function AtmosphereSheet({ onClose }: { onClose: () => void }) {
  const hours = useAppStore((s) => s.timeOfDay);
  const setTime = useAppStore((s) => s.setTimeOfDay);
  const flowing = useAppStore((s) => s.timeFlowing);
  const setFlowing = useAppStore((s) => s.setTimeFlowing);
  const season = useAppStore((s) => s.season);
  const setSeason = useAppStore((s) => s.setSeason);
  const { lat, lon } = useTerritoryLatLon();
  const gradient = useMemo(() => skyGradient(lat, lon), [lat, lon]);
  const near = (a: number, b: number) => Math.abs(((a - b + 36) % 24) - 12) < 0.05;

  return (
    <BottomSheet title="Атмосфера" extra={<b className="m-sheet-time">{formatTime(hours)}</b>} onClose={onClose}>
      <div className="m-chips">
        {TIME_CHIPS.map((chip) => (
          <button
            key={chip.label}
            type="button"
            className={`m-chip ${chip.hours !== undefined && near(hours, chip.hours) ? 'on' : ''}`}
            onClick={() => setTime(chip.hours ?? nowHours())}
          >
            {chip.label}
          </button>
        ))}
      </div>
      <input
        className="time-slider m-time-slider"
        type="range"
        min={0}
        max={24}
        step={1 / 12}
        value={hours}
        style={{ background: gradient }}
        aria-label="Время суток, часы"
        aria-valuetext={formatTime(hours)}
        onChange={(e) => setTime(Number(e.target.value))}
      />
      <div className="time-scale m-time-scale" aria-hidden="true">
        <span>0</span>
        <span>6</span>
        <span>12</span>
        <span>18</span>
        <span>24</span>
      </div>
      <div className="m-row">
        <span>Время года</span>
        <div className="m-seg m-seg-small" role="group" aria-label="Время года">
          <button type="button" className={season === 'summer' ? 'on' : ''} onClick={() => setSeason('summer')}>
            Лето
          </button>
          <button type="button" className={season === 'winter' ? 'on' : ''} onClick={() => setSeason('winter')}>
            Зима
          </button>
        </div>
      </div>
      <div className="m-row">
        <span>Время идёт</span>
        <div className="m-seg m-seg-small" role="group" aria-label="Время идёт">
          <button type="button" className={flowing ? '' : 'on'} onClick={() => setFlowing(false)}>
            Стоит
          </button>
          <button type="button" className={flowing ? 'on' : ''} onClick={() => setFlowing(true)}>
            Идёт
          </button>
        </div>
      </div>
      <p className="m-note">
        {season === 'winter' ? 'Конец декабря: солнце низко, ночью горят окна, фонари и гирлянды.' : 'Середина июня: ночью горят окна и фонари.'}
      </p>
    </BottomSheet>
  );
}

/** Ещё: звук, картинка, цвет машины. */
function MoreSheet({ onClose, onAtmosphere }: { onClose: () => void; onAtmosphere: () => void }) {
  const soundOn = useAppStore((s) => s.soundOn);
  const setSoundOn = useAppStore((s) => s.setSoundOn);
  const volumes = useAppStore((s) => s.volumes);
  const setVolumes = useAppStore((s) => s.setVolumes);
  const quality = useAppStore((s) => s.graphicsQuality);
  const setQuality = useAppStore((s) => s.setGraphicsQuality);
  const haze = useAppStore((s) => s.haze);
  const setHaze = useAppStore((s) => s.setHaze);
  const carColor = useAppStore((s) => s.carColor);
  const setCarColor = useAppStore((s) => s.setCarColor);
  const flyHome = useAppStore((s) => s.flyHome);
  const mode = useAppStore((s) => s.mode);

  return (
    <BottomSheet title="Ещё" onClose={onClose}>
      <button type="button" className="m-list-button" onClick={onAtmosphere}>
        <SunIcon /> Время суток и время года
      </button>
      {mode === 'explore' && flyHome && (
        <button
          type="button"
          className="m-list-button"
          onClick={() => {
            flyHome();
            onClose();
          }}
        >
          <OverviewIcon /> Показать всю деревню
        </button>
      )}
      <div className="m-row">
        <span>Звук</span>
        <div className="m-seg m-seg-small" role="group" aria-label="Звук">
          <button type="button" className={soundOn ? '' : 'on'} onClick={() => setSoundOn(false)}>
            Выкл
          </button>
          <button type="button" className={soundOn ? 'on' : ''} onClick={() => setSoundOn(true)}>
            Вкл
          </button>
        </div>
      </div>
      {soundOn && (
        <label className="m-volume">
          <span>Громкость {Math.round(volumes.master * 100)}%</span>
          <input type="range" min={0} max={100} value={Math.round(volumes.master * 100)} onChange={(e) => setVolumes({ master: Number(e.target.value) / 100 })} />
        </label>
      )}
      <div className="m-row">
        <span>Мягкие тени</span>
        <div className="m-seg m-seg-small" role="group" aria-label="Мягкие тени">
          <button type="button" className={quality === 'high' ? '' : 'on'} onClick={() => setQuality('normal')}>
            Выкл
          </button>
          <button type="button" className={quality === 'high' ? 'on' : ''} onClick={() => setQuality('high')}>
            Вкл
          </button>
        </div>
      </div>
      <div className="m-row">
        <span>Дымка вдали</span>
        <div className="m-seg m-seg-small" role="group" aria-label="Дымка вдали">
          <button type="button" className={haze ? '' : 'on'} onClick={() => setHaze(false)}>
            Выкл
          </button>
          <button type="button" className={haze ? 'on' : ''} onClick={() => setHaze(true)}>
            Вкл
          </button>
        </div>
      </div>
      <div className="m-row">
        <span>Машина</span>
        <div className="car-colors m-car-colors" role="radiogroup" aria-label="Цвет машины">
          {CAR_COLORS.map(({ color, name }) => (
            <button
              key={color}
              type="button"
              role="radio"
              aria-checked={carColor === color}
              className={`car-color ${carColor === color ? 'on' : ''}`}
              style={{ background: color }}
              aria-label={name}
              onClick={() => setCarColor(color)}
            />
          ))}
        </div>
      </div>
      <p className="m-note">Мягкие тени красивее, но нагружают телефон — если тормозит, выключите.</p>
    </BottomSheet>
  );
}

function PlaceSheet({ onClose }: { onClose: () => void }) {
  const territoryId = useAppStore((s) => s.territoryId);
  const setTerritory = useAppStore((s) => s.setTerritory);
  const flyHome = useAppStore((s) => s.flyHome);
  return (
    <BottomSheet title="Место" onClose={onClose}>
      {territories.map((t) => (
        <button
          key={t.id}
          type="button"
          className={`m-list-button ${t.id === territoryId ? 'on' : ''}`}
          onClick={() => {
            if (t.id === territoryId) flyHome?.();
            else setTerritory(t.id);
            onClose();
          }}
        >
          {t.name}
          {t.id === territoryId && <span className="m-list-note">показать всё</span>}
        </button>
      ))}
    </BottomSheet>
  );
}

function Sheets({ sheet, setSheet }: { sheet: Sheet | undefined; setSheet: (sheet: Sheet | undefined) => void }) {
  const close = useCallback(() => setSheet(undefined), [setSheet]);
  if (sheet === 'atmosphere') return <AtmosphereSheet onClose={close} />;
  if (sheet === 'more') return <MoreSheet onClose={close} onAtmosphere={() => setSheet('atmosphere')} />;
  if (sheet === 'place') return <PlaceSheet onClose={close} />;
  return null;
}

function AtmosphereIcon() {
  const hours = useAppStore((s) => s.timeOfDay);
  const season = useAppStore((s) => s.season);
  const { lat, lon } = useTerritoryLatLon();
  if (sunElevationAt(hours, lat, lon) < -3) return <MoonIcon />;
  return season === 'winter' ? <SnowIcon /> : <SunIcon />;
}

// --- обзор ---------------------------------------------------------------------------------------

function ModeSwitch() {
  const mode = useAppStore((s) => s.mode);
  const controls = useAppStore((s) => s.walkControls);
  const ready = useAppStore((s) => s.status === 'ready');
  const active = mode === 'pick-walk-start' ? 'walk' : mode === 'pick-drive-start' ? 'drive' : 'overview';
  const choose = (kind: 'overview' | 'walk' | 'drive') => {
    if (!controls || !ready) return;
    if (kind === 'overview') controls.cancelPick();
    else controls.pickStart(kind);
  };
  return (
    <nav className="m-glass m-seg m-modes" aria-label="Режим">
      <button type="button" className={active === 'overview' ? 'on' : ''} onClick={() => choose('overview')}>
        <OverviewIcon />
        Обзор
      </button>
      <button type="button" className={active === 'walk' ? 'on' : ''} onClick={() => choose('walk')} disabled={!ready}>
        <WalkIcon />
        Пешком
      </button>
      <button type="button" className={active === 'drive' ? 'on' : ''} onClick={() => choose('drive')} disabled={!ready}>
        <CarIcon />
        Машина
      </button>
    </nav>
  );
}

function Compass() {
  const heading = useAppStore((s) => s.cameraHeading);
  const faceNorth = useAppStore((s) => s.faceNorth);
  return (
    <button type="button" className="m-glass m-round m-small m-compass" onClick={() => faceNorth?.()} aria-label="Повернуть на север">
      <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" style={{ transform: `rotate(${-heading}deg)` }}>
        <path d="M12 3l3.2 9h-6.4z" fill="#ff5a4f" />
        <path d="M12 21l-3.2-9h6.4z" fill="rgba(255,255,255,0.75)" />
      </svg>
      <span className="m-compass-n" style={{ transform: `translate(-50%, -50%) rotate(${-heading}deg) translateY(-16px) rotate(${heading}deg)` }}>
        С
      </span>
    </button>
  );
}

function Overview({ setSheet }: { setSheet: (sheet: Sheet | undefined) => void }) {
  const territoryId = useAppStore((s) => s.territoryId);
  const name = findTerritory(territoryId)?.shortName ?? '';
  const mode = useAppStore((s) => s.mode);
  const soundOn = useAppStore((s) => s.soundOn);
  const setSoundOn = useAppStore((s) => s.setSoundOn);
  const viewMode = useAppStore((s) => s.viewMode);
  const changeView = useAppStore((s) => s.changeView);
  const controls = useAppStore((s) => s.walkControls);
  const ready = useAppStore((s) => s.status === 'ready');
  const picking = mode === 'pick-walk-start' || mode === 'pick-drive-start';
  const [hint, hintDone] = useOnce('overview', ready && !picking);
  useDismissOnTouch(hint, hintDone);

  return (
    <>
      <button type="button" className="m-glass m-pill m-place m-sheet-opener" onClick={() => setSheet('place')}>
        {name}
        <ChevronDown />
      </button>
      <div className="m-top-right">
        <Compass />
        <button type="button" className="m-glass m-round m-small m-text" onClick={() => changeView?.(viewMode === 'top' ? 'tilt' : 'top')} aria-label={viewMode === 'top' ? 'Вид под углом' : 'Вид сверху'}>
          {viewMode === 'top' ? '3D' : '2D'}
        </button>
      </div>
      {!picking && (
        <div className="m-side">
          <RoundButton label="Атмосфера" className="m-sheet-opener" onClick={() => setSheet('atmosphere')}>
            <AtmosphereIcon />
          </RoundButton>
          <RoundButton label="Звук" on={soundOn} onClick={() => setSoundOn(!soundOn)}>
            {soundOn ? <SoundOnIcon /> : <SoundOffIcon />}
          </RoundButton>
          <RoundButton label="Ещё" className="m-sheet-opener" onClick={() => setSheet('more')}>
            <MoreIcon />
          </RoundButton>
        </div>
      )}
      {picking && (
        <div className="m-glass m-banner" role="status">
          <span>{mode === 'pick-drive-start' ? 'Коснитесь улицы — машина встанет на ближайшую дорогу' : 'Коснитесь улицы — окажетесь там на уровне глаз'}</span>
          <button type="button" className="m-banner-button" onClick={() => controls?.cancelPick()}>
            Отмена
          </button>
        </div>
      )}
      {hint && (
        <div className="m-hint m-hint-center" aria-hidden="true">
          <svg viewBox="0 0 120 120" width="88" height="88">
            <path d="M30 70 a40 40 0 0 1 60 -30" fill="none" stroke="#fff" strokeWidth="4" strokeDasharray="6 6" strokeLinecap="round" />
            <path d="M86 32l6 9-11 2" fill="none" stroke="#fff" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M55 105 V72 a6 6 0 0 1 12 0 v18 l4-2 a6 6 0 0 1 9 5 v12" fill="rgba(255,255,255,.95)" stroke="#333" strokeWidth="2" />
          </svg>
          <div className="m-hint-box">
            Двигайте одним пальцем,
            <br />
            вращайте и приближайте двумя
          </div>
        </div>
      )}
      <ModeSwitch />
    </>
  );
}

// --- пешком ---------------------------------------------------------------------------------------

const STICK_RADIUS = 52;

/** Стик: появляется под пальцем в левой нижней части экрана. */
function Stick({ onMove }: { onMove: (forward: number, right: number) => void }) {
  const [origin, setOrigin] = useState<[number, number] | undefined>();
  const [knob, setKnob] = useState<[number, number]>([0, 0]);
  const pointer = useRef<number | undefined>(undefined);
  const zone = useRef<HTMLDivElement>(null);

  const local = (event: ReactPointerEvent): [number, number] => {
    const rect = zone.current!.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  };
  const down = (event: ReactPointerEvent) => {
    if (pointer.current !== undefined) return;
    pointer.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    setOrigin(local(event));
    setKnob([0, 0]);
  };
  const move = (event: ReactPointerEvent) => {
    if (event.pointerId !== pointer.current || !origin) return;
    const [x, y] = local(event);
    let dx = x - origin[0];
    let dy = y - origin[1];
    const length = Math.hypot(dx, dy);
    if (length > STICK_RADIUS) {
      dx = (dx / length) * STICK_RADIUS;
      dy = (dy / length) * STICK_RADIUS;
    }
    setKnob([dx, dy]);
    // Мёртвая зона в центре — палец чуть дрогнул, не идём.
    const push = Math.hypot(dx, dy) / STICK_RADIUS;
    if (push < 0.12) onMove(0, 0);
    else onMove(-dy / STICK_RADIUS, dx / STICK_RADIUS);
  };
  const up = (event: ReactPointerEvent) => {
    if (event.pointerId !== pointer.current) return;
    pointer.current = undefined;
    setOrigin(undefined);
    setKnob([0, 0]);
    onMove(0, 0);
  };
  useEffect(() => () => onMove(0, 0), [onMove]);

  return (
    <div ref={zone} className="m-stick-zone" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      <div className={`m-stick ${origin ? 'active' : ''}`} style={origin ? { left: origin[0], top: origin[1] } : undefined}>
        <div className="m-stick-knob" style={{ transform: `translate(${knob[0]}px, ${knob[1]}px)` }} />
      </div>
    </div>
  );
}

function StreetTop({ onBack, children }: { onBack: () => void; children?: ReactNode }) {
  const street = useAppStore((s) => s.walkStreet);
  return (
    <>
      <div className="m-top-left">
        <button type="button" className="m-glass m-pill" onClick={onBack}>
          <BackIcon />
          Обзор
        </button>
        {children}
      </div>
      {street && <div className="m-glass m-pill m-street">{street}</div>}
    </>
  );
}

function Walk({ setSheet }: { setSheet: (sheet: Sheet | undefined) => void }) {
  const controls = useAppStore((s) => s.walkControls);
  const street = useAppStore((s) => s.walkStreet);
  const [hint, hintDone] = useOnce('walk', true);
  useDismissOnTouch(hint, hintDone, 9000);
  const onStick = useCallback((forward: number, right: number) => useAppStore.getState().walkControls?.setStick(forward, right), []);

  return (
    <>
      <StreetTop onBack={() => controls?.exit()} />
      <div className="m-street-right">
        <Minimap />
        <button type="button" className="m-glass m-round m-small m-sheet-opener" onClick={() => setSheet('more')} aria-label="Ещё">
          <MoreIcon />
        </button>
      </div>
      <Stick onMove={onStick} />
      {street && (
        <button type="button" className="m-glass m-big m-accent m-board" onClick={() => controls?.switchTo('drive')}>
          <CarIcon />
          <span>Сесть в машину</span>
        </button>
      )}
      {hint && (
        <>
          <div className="m-hint m-hint-walk-stick" aria-hidden="true">
            <div className="m-hint-text">Ведите пальцем — идите</div>
          </div>
          <div className="m-hint m-hint-walk-look" aria-hidden="true">
            <div className="m-hint-text">Тяните справа — осматривайтесь</div>
            <div className="m-hint-box">Коснитесь земли — пойдёте туда</div>
          </div>
        </>
      )}
    </>
  );
}

// --- на машине -----------------------------------------------------------------------------------

type Pedal = 'gas' | 'brake' | 'left' | 'right';

/** Кнопка, которую держат: нажата — пока палец на ней. */
function HoldButton({ pedal, onChange, className, label, children }: { pedal: Pedal; onChange: (pedal: Pedal, on: boolean) => void; className: string; label: string; children: ReactNode }) {
  const [pressed, setPressed] = useState(false);
  const set = (on: boolean) => {
    setPressed(on);
    onChange(pedal, on);
  };
  return (
    <button
      type="button"
      className={`m-glass m-hold ${className} ${pressed ? 'pressed' : ''}`}
      aria-label={label}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        set(true);
      }}
      onPointerUp={() => set(false)}
      onPointerCancel={() => set(false)}
      onLostPointerCapture={() => set(false)}
      onContextMenu={(event) => event.preventDefault()}
    >
      {children}
    </button>
  );
}

function Drive({ setSheet }: { setSheet: (sheet: Sheet | undefined) => void }) {
  const controls = useAppStore((s) => s.walkControls);
  const drive = useAppStore((s) => s.driveControls);
  const hud = useAppStore((s) => s.driveHud);
  const pedals = useRef<Record<Pedal, boolean>>({ gas: false, brake: false, left: false, right: false });
  const onPedal = useCallback((pedal: Pedal, on: boolean) => {
    pedals.current[pedal] = on;
    const p = pedals.current;
    useAppStore.getState().driveControls?.setTouch((p.gas ? 1 : 0) - (p.brake ? 1 : 0), (p.right ? 1 : 0) - (p.left ? 1 : 0));
  }, []);
  useEffect(() => () => useAppStore.getState().driveControls?.setTouch(0, 0), []);
  const [hint, hintDone] = useOnce('drive', true);
  useDismissOnTouch(hint, hintDone, 9000);
  const [portrait, setPortrait] = useState(() => window.matchMedia('(orientation: portrait)').matches);
  useEffect(() => {
    const query = window.matchMedia('(orientation: portrait)');
    const update = () => setPortrait(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  return (
    <>
      <StreetTop onBack={() => controls?.exit()}>
        <button type="button" className="m-glass m-pill" onClick={() => controls?.switchTo('walk')}>
          <WalkIcon />
          Выйти
        </button>
      </StreetTop>
      <div className="m-street-right">
        <Minimap />
        <div className="m-row-buttons">
          <button type="button" className="m-glass m-round m-small" onClick={() => drive?.toggleView()} aria-label="Камера: сзади или из кабины">
            <CameraIcon />
          </button>
          <button type="button" className="m-glass m-round m-small m-sheet-opener" onClick={() => setSheet('more')} aria-label="Ещё">
            <MoreIcon />
          </button>
        </div>
      </div>
      {portrait && hint && <div className="m-glass m-pill m-rotate-hint">Поверните телефон — так удобнее</div>}
      <div className="m-steer">
        <HoldButton pedal="left" onChange={onPedal} className="m-steer-button" label="Руль влево">
          <Icon size={30}>
            <path d="M15 5l-7 7 7 7" />
          </Icon>
        </HoldButton>
        <HoldButton pedal="right" onChange={onPedal} className="m-steer-button" label="Руль вправо">
          <Icon size={30}>
            <path d="M9 5l7 7-7 7" />
          </Icon>
        </HoldButton>
      </div>
      <div className="m-glass m-speed" aria-live="off">
        <b>{hud.speed}</b>
        <span>км/ч · {hud.gear}</span>
      </div>
      <div className="m-pedals">
        <HoldButton pedal="brake" onChange={onPedal} className="m-brake" label="Тормоз и назад">
          Тормоз
          <small>и назад</small>
        </HoldButton>
        <HoldButton pedal="gas" onChange={onPedal} className="m-gas" label="Газ">
          <Icon size={30}>
            <path d="M12 19V5M6 11l6-6 6 6" />
          </Icon>
          Газ
        </HoldButton>
      </div>
      {hint && (
        <>
          <div className="m-hint m-hint-steer" aria-hidden="true">
            <div className="m-hint-text">рулите</div>
          </div>
          <div className="m-hint m-hint-pedals" aria-hidden="true">
            <div className="m-hint-text">держите «Газ» — едем</div>
          </div>
        </>
      )}
    </>
  );
}

// --- всё вместе ----------------------------------------------------------------------------------

export function MobileUi() {
  const mode = useAppStore((s) => s.mode);
  const [sheet, setSheet] = useState<Sheet | undefined>();
  // Сменили режим — лист закрываем.
  useEffect(() => setSheet(undefined), [mode]);
  return (
    <div className={`m-ui m-ui-${mode} ${sheet ? 'm-ui-sheet' : ''}`}>
      {mode === 'walk' ? <Walk setSheet={setSheet} /> : mode === 'drive' ? <Drive setSheet={setSheet} /> : <Overview setSheet={setSheet} />}
      <Sheets sheet={sheet} setSheet={setSheet} />
    </div>
  );
}
