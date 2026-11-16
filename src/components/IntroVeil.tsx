// Заставка: белый фон, по центру — надпись «Bash Yort» и под ней полоса загрузки с процентами. Пока она видна,
// камера за ней прилетает к виду вдоль главной улицы. Всё загрузилось — заставка целиком плавно тает,
// и под ней уже готовая деревня.

import { useEffect, useRef, useState } from 'react';
import type { Territory } from '../config/territory';
import { useAppStore } from '../store/useAppStore';

/** После загрузки: короткая пауза (камера долетает) и плавное исчезновение; всего, мс. */
const LEAVE_MS = 1700;

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
      value.current += (goal - value.current) * Math.min(1, dt * (target >= 1 ? 8 : speed));
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

  return (
    <div className={`intro intro-${phase}`} aria-hidden={phase !== 'loading'} role="status">
      <div className="intro-center">
        <h1 className="intro-title-text">Bash Yort</h1>
        {status === 'error' ? (
          <p className="intro-status">Не получилось загрузить: {error}</p>
        ) : (
          <div className="intro-progress">
            <div className="intro-bar" role="progressbar" aria-label={`Загрузка: ${territory.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
              <b style={{ width: `${Math.max(2, percent)}%` }} />
            </div>
            <span className="intro-percent">{percent}%</span>
          </div>
        )}
      </div>
    </div>
  );
}
