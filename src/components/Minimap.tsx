import { useEffect, useRef, useState } from 'react';
import { isTypingTarget } from '../three/OverviewControls';
import { useAppStore } from '../store/useAppStore';

const ZOOMS = [0.5, 0.75, 1, 1.5, 2.25];
const FRAME_MS = 33;

/** Мини-карта в углу на прогулке и за рулём: M — спрятать/показать, клик — крупнее, ± — масштаб. */
export function Minimap() {
  const source = useAppStore((s) => s.minimap);
  const on = useAppStore((s) => s.minimapOn);
  const setOn = useAppStore((s) => s.setMinimapOn);
  const [large, setLarge] = useState(false);
  const [zoomIndex, setZoomIndex] = useState(2);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'KeyM' || event.repeat || isTypingTarget(event.target)) return;
      const state = useAppStore.getState();
      state.setMinimapOn(!state.minimapOn);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!on || !source || !canvas || !ctx) return;
    const zoom = ZOOMS[zoomIndex] ?? 1;
    let frame = 0;
    let last = 0;
    const loop = (time: number) => {
      frame = requestAnimationFrame(loop);
      if (time - last < FRAME_MS) return;
      last = time;
      const size = canvas.clientWidth;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const px = Math.round(size * dpr);
      if (canvas.width !== px) {
        canvas.width = px;
        canvas.height = px;
      }
      source.draw(ctx, size, dpr, zoom);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [on, source, zoomIndex, large]);

  if (!on) {
    return (
      <button type="button" className="panel minimap-show" onClick={() => setOn(true)} title="Показать мини-карту">
        Карта <kbd>M</kbd>
      </button>
    );
  }
  return (
    <div className={`minimap ${large ? 'minimap-large' : ''}`}>
      <canvas ref={canvasRef} className="minimap-canvas" onClick={() => setLarge(!large)} title={large ? 'Меньше' : 'Крупнее'} />
      <div className="minimap-buttons">
        <button type="button" onClick={() => setZoomIndex(Math.min(zoomIndex + 1, ZOOMS.length - 1))} disabled={zoomIndex === ZOOMS.length - 1} title="Ближе" aria-label="Ближе">
          +
        </button>
        <button type="button" onClick={() => setZoomIndex(Math.max(zoomIndex - 1, 0))} disabled={zoomIndex === 0} title="Дальше" aria-label="Дальше">
          −
        </button>
        <button type="button" onClick={() => setOn(false)} title="Спрятать (M)" aria-label="Спрятать мини-карту">
          ×
        </button>
      </div>
    </div>
  );
}
