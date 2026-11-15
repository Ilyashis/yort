// Заставка в цветах сайта (тёмное стекло, оранжевый акцент): пока грузится — только полоса загрузки внизу.
// Когда готов рельеф, тёмный фон уходит и видно, как камера по ходу загрузки прилетает к виду вдоль главной
// улицы. Всё загрузилось — полоса плавно тает, и деревня остаётся одна.

import { useEffect, useRef, useState } from 'react';
import type { Territory } from '../config/territory';
import { useAppStore } from '../store/useAppStore';

/** После загрузки: камера долетает, потом полоса тает; всего, мс. */
const LEAVE_MS = 2600;
/** С какой доли загрузки небо уступает место сцене (рельеф уже есть). */
const SCENE_FROM = 0.55;

/** Значок над полосой: деревья, дом с дымом из трубы. */
function VillageIcon() {
  return (
    <svg className="intro-icon" viewBox="0 0 120 36" aria-hidden="true">
      <path d="M4 34h112" />
      <circle cx="14" cy="22" r="7" />
      <path d="M14 29v5" />
      <circle cx="28" cy="20" r="8" />
      <path d="M28 28v6" />
      <path d="M44 34V20l16-11 16 11v14z" />
      <path d="M55 34v-8h10v8" />
      <path d="M68 13V6" />
      <path className="intro-smoke" d="M68 4c3-2 0-4 3-6M71 0c3-2 0-4 3-6" />
      <path d="M96 34l-8-1 8-13 8 13z" />
      <path d="M96 34v-2" />
    </svg>
  );
}

/** Показ догоняет настоящую загрузку и между этапами медленно ползёт — полоса не стоит на месте. */
function useSmoothProgress(target: number): number {
  const [shown, setShown] = useState(0);
  const value = useRef(0);
  useEffect(() => {
    let frame = 0;
    let last = performance.now();
    const step = (time: number) => {
      const dt = Math.max(0, Math.min(0.1, (time - last) / 1000));
      last = time;
      const goal = target >= 1 ? 1 : Math.min(0.97, target + 0.08);
      const speed = value.current < target ? 3 : 0.12;
      value.current += (goal - value.current) * Math.min(1, dt * speed);
      setShown(value.current);
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return shown;
}

export function IntroVeil({ territory }: { territory: Territory }) {
  const status = useAppStore((s) => s.status);
  const error = useAppStore((s) => s.error);
  const progress = useAppStore((s) => s.loadProgress);
  const shown = useSmoothProgress(status === 'loading' ? progress : 1);
  const [phase, setPhase] = useState<'loading' | 'leaving' | 'gone'>('loading');
  useEffect(() => {
    if (status === 'loading') {
      setPhase('loading');
      return;
    }
    if (status !== 'ready') return;
    setPhase('leaving');
    const timer = window.setTimeout(() => setPhase('gone'), LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [status]);

  if (phase === 'gone') return null;
  const percent = Math.round(shown * 100);
  const sceneVisible = status !== 'error' && (phase === 'leaving' || progress >= SCENE_FROM);

  return (
    <div className={`intro intro-${phase} ${sceneVisible ? 'intro-open' : ''}`} aria-hidden={phase !== 'loading'} role="status">
      <div className="intro-sky" />
      <div className="intro-haze intro-haze-bottom" />
      <div className="intro-foot">
        {status === 'error' ? (
          <p className="intro-status">Не получилось загрузить: {error}</p>
        ) : (
          <>
            <VillageIcon />
            <div className="intro-progress">
              <div
                className="intro-bar"
                role="progressbar"
                aria-label={`Загрузка: ${territory.name}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
              >
                <b style={{ width: `${Math.max(3, percent)}%` }} />
              </div>
              <span className="intro-percent">{percent}%</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
