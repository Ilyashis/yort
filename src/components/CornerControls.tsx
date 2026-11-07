import { useEffect, useRef, useState } from 'react';
import type { Volumes } from '../audio/AudioEngine';
import { useAppStore } from '../store/useAppStore';

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

/** Настройки звука: включить/выключить и громкость по группам. */
function SoundPanel({ onClose }: { onClose: () => void }) {
  const soundOn = useAppStore((s) => s.soundOn);
  const setSoundOn = useAppStore((s) => s.setSoundOn);
  const volumes = useAppStore((s) => s.volumes);
  const setVolumes = useAppStore((s) => s.setVolumes);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (ref.current && target && !ref.current.contains(target) && !target.closest?.('.sound-button')) onClose();
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
  }, [onClose]);

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

/** Кнопки в правом нижнем углу: подсказка, вид сверху/под углом, звук, качество графики. */
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
        className={`round-button sound-button ${soundOn ? 'on' : ''}`}
        onClick={() => setSoundPanel(!soundPanel)}
        aria-expanded={soundPanel}
        title="Звук: громкость музыки, города, шагов"
      >
        {soundOn ? <SoundOnIcon /> : <SoundOffIcon />}
      </button>
      {soundPanel && <SoundPanel onClose={() => setSoundPanel(false)} />}
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
