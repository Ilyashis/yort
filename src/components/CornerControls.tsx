import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Volumes } from '../audio/AudioEngine';
import { findTerritory } from '../config/territory';
import { useAppStore } from '../store/useAppStore';
import { formatTime, lightingAt, sunElevationAt, TIME_PRESETS } from '../three/dayNight';

/** Вид сверху: план — квадрат с сеткой. */
const TopViewIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7">
    <rect x="4" y="4" width="16" height="16" rx="2" />
    <path d="M4 12h16M12 4v16" />
  </svg>
);

/** Вид под углом: плоскость в перспективе. */
const TiltViewIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
    <path d="M7 6h10l4 13H3z" />
    <path d="M12 6v13M5 13h14" />
  </svg>
);

const VOLUME_ROWS: { key: keyof Volumes; label: string }[] = [
  { key: 'master', label: 'Общая громкость' },
  { key: 'music', label: 'Музыка' },
  { key: 'ambience', label: 'Звуки города: машины, птицы, вода' },
  { key: 'sfx', label: 'Шаги и щелчки' },
];

/** Всплывающая панель закрывается кликом мимо неё (кроме её кнопки) и клавишей Esc. */
function useDismiss(onClose: () => void, buttonSelector: string) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (ref.current && target && !ref.current.contains(target) && !target.closest?.(buttonSelector)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.code === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose, buttonSelector]);
  return ref;
}

/** Настройки звука: включить/выключить и громкость по группам. */
function SoundPanel({ onClose }: { onClose: () => void }) {
  const soundOn = useAppStore((s) => s.soundOn);
  const setSoundOn = useAppStore((s) => s.setSoundOn);
  const volumes = useAppStore((s) => s.volumes);
  const setVolumes = useAppStore((s) => s.setVolumes);
  const ref = useDismiss(onClose, '.sound-button');

  return (
    <div ref={ref} className="panel sound-panel" role="dialog" aria-label="Звук">
      <label className="toggle">
        <input type="checkbox" checked={soundOn} onChange={(e) => setSoundOn(e.target.checked)} />
        Звук включён
      </label>
      {VOLUME_ROWS.map(({ key, label }) => (
        <label key={key} className={`field ${soundOn ? '' : 'field-disabled'}`}>
          <span>
            {label} <b>{Math.round(volumes[key] * 100)}%</b>
          </span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(volumes[key] * 100)}
            disabled={!soundOn}
            onChange={(e) => setVolumes({ [key]: Number(e.target.value) / 100 })}
          />
        </label>
      ))}
      <p className="muted sound-note">Браузер включит звук после первого клика по странице.</p>
    </div>
  );
}

/** Цвет неба у горизонта по часам — фон шкалы времени (ночь, рассвет, день, закат). */
function skyGradient(lat: number, lon: number): string {
  const stops: string[] = [];
  for (let h = 0; h <= 24; h += 0.5) {
    const [r, g, b] = lightingAt(sunElevationAt(h, lat, lon)).fog.map((v) => Math.round(v * 255));
    stops.push(`rgb(${r}, ${g}, ${b}) ${((h / 24) * 100).toFixed(1)}%`);
  }
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

/** Время суток: шкала 0–24 ч, быстрый выбор и «время идёт». */
function TimePanel({ onClose, lat, lon }: { onClose: () => void; lat: number; lon: number }) {
  const hours = useAppStore((s) => s.timeOfDay);
  const flowing = useAppStore((s) => s.timeFlowing);
  const setTime = useAppStore((s) => s.setTimeOfDay);
  const setFlowing = useAppStore((s) => s.setTimeFlowing);
  const ref = useDismiss(onClose, '.time-button');
  const gradient = useMemo(() => skyGradient(lat, lon), [lat, lon]);
  const near = (a: number, b: number) => Math.abs(((a - b + 36) % 24) - 12) < 0.05;

  return (
    <div ref={ref} className="panel time-panel" role="dialog" aria-label="Время суток">
      <div className="time-head">
        <span>Время суток</span>
        <b>{formatTime(hours)}</b>
      </div>
      <input
        className="time-slider"
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
      <div className="time-scale" aria-hidden="true">
        <span>0</span>
        <span>6</span>
        <span>12</span>
        <span>18</span>
        <span>24</span>
      </div>
      <div className="segmented segmented-small">
        {TIME_PRESETS.map((preset) => (
          <button key={preset.label} type="button" className={near(hours, preset.hours) ? 'active' : ''} onClick={() => setTime(preset.hours)}>
            {preset.label}
          </button>
        ))}
      </div>
      <label className="toggle">
        <input type="checkbox" checked={flowing} onChange={(e) => setFlowing(e.target.checked)} />
        Время идёт (сутки за 6 минут)
      </label>
      <p className="muted sound-note">Летний день, середина июля: солнце по-настоящему, ночью горят окна и фонари.</p>
    </div>
  );
}

const SunIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />
    <path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6" />
  </svg>
);

const MoonIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" fill="currentColor" />
  </svg>
);

const SoundOnIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    <path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" />
    <path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" />
  </svg>
);

const SoundOffIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    <path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" />
    <path d="M16.5 9.5l5 5m0-5l-5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

const SparkleIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" fill="currentColor" />
    <path d="M18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z" fill="currentColor" />
  </svg>
);

/** Кнопки в правом нижнем углу: подсказка, вид сверху/под углом, время суток, звук, качество графики. */
export function CornerControls() {
  const soundOn = useAppStore((s) => s.soundOn);
  const quality = useAppStore((s) => s.graphicsQuality);
  const viewMode = useAppStore((s) => s.viewMode);
  const changeView = useAppStore((s) => s.changeView);
  const walking = useAppStore((s) => s.mode === 'walk');
  const [soundPanel, setSoundPanel] = useState(false);
  const setQuality = useAppStore((s) => s.setGraphicsQuality);
  const helpOpen = useAppStore((s) => s.helpOpen);
  const setHelpOpen = useAppStore((s) => s.setHelpOpen);
  const [timePanel, setTimePanel] = useState(false);
  const hours = useAppStore((s) => s.timeOfDay);
  const territoryId = useAppStore((s) => s.territoryId);
  const { lat, lon } = useMemo(() => {
    const bbox = findTerritory(territoryId)?.bbox;
    return bbox ? { lat: (bbox.south + bbox.north) / 2, lon: (bbox.west + bbox.east) / 2 } : { lat: 54.72, lon: 55.94 };
  }, [territoryId]);
  const night = sunElevationAt(hours, lat, lon) < -3;
  const closeTime = useCallback(() => setTimePanel(false), []);
  const closeSound = useCallback(() => setSoundPanel(false), []);

  return (
    <div className="corner-controls">
      <button
        type="button"
        className={`round-button round-button-text ${helpOpen ? 'on' : ''}`}
        onClick={() => setHelpOpen(!helpOpen)}
        aria-pressed={helpOpen}
        title="Управление"
      >
        ?
      </button>
      {!walking && (
        <button
          type="button"
          className="round-button"
          onClick={() => changeView?.(viewMode === 'top' ? 'tilt' : 'top')}
          disabled={!changeView}
          title={viewMode === 'top' ? 'Вид под углом' : 'Вид сверху — удобно обводить по подложке'}
        >
          {viewMode === 'top' ? <TiltViewIcon /> : <TopViewIcon />}
        </button>
      )}
      <button
        type="button"
        className="round-button time-button"
        onClick={() => setTimePanel(!timePanel)}
        aria-expanded={timePanel}
        title={`Время суток: ${formatTime(hours)}`}
      >
        {night ? <MoonIcon /> : <SunIcon />}
      </button>
      {timePanel && <TimePanel onClose={closeTime} lat={lat} lon={lon} />}
      <button
        type="button"
        className={`round-button sound-button ${soundOn ? 'on' : ''}`}
        onClick={() => setSoundPanel(!soundPanel)}
        aria-expanded={soundPanel}
        title="Звук: громкость музыки, города, шагов"
      >
        {soundOn ? <SoundOnIcon /> : <SoundOffIcon />}
      </button>
      {soundPanel && <SoundPanel onClose={closeSound} />}
      <button
        type="button"
        className={`round-button ${quality === 'high' ? 'on' : ''}`}
        onClick={() => setQuality(quality === 'high' ? 'normal' : 'high')}
        aria-pressed={quality === 'high'}
        title={
          quality === 'high'
            ? 'Мягкие тени в углах включены — выключите, если тормозит'
            : 'Включить мягкие тени в углах (нагружает видеокарту)'
        }
      >
        <SparkleIcon />
      </button>
    </div>
  );
}
