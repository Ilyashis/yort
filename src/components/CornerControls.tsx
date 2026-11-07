import { useAppStore } from '../store/useAppStore';

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

/** Кнопки в правом нижнем углу: звук и качество графики. */
export function CornerControls() {
  const soundOn = useAppStore((s) => s.soundOn);
  const quality = useAppStore((s) => s.graphicsQuality);
  const setSoundOn = useAppStore((s) => s.setSoundOn);
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
      <button
        type="button"
        className={`round-button ${soundOn ? 'on' : ''}`}
        onClick={() => setSoundOn(!soundOn)}
        aria-pressed={soundOn}
        title={soundOn ? 'Выключить музыку и звуки' : 'Включить музыку и звуки'}
      >
        {soundOn ? <SoundOnIcon /> : <SoundOffIcon />}
      </button>
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
