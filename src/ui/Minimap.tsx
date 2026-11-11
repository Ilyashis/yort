import { useEffect, useRef, useState } from 'react';
import type { Engine } from '../engine/Engine';

const SIZE = 196;

/** Круглая мини-карта: план района повёрнут по курсу, вперёд — вверх. */
export function Minimap({ engine }: { engine: Engine }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    const canvas = ref.current!;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = canvas.height = SIZE * dpr;
    const ctx = canvas.getContext('2d')!;
    let raf = 0;
    let range = 150;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const map = engine.miniMap;
      const p = engine.player;
      if (!map || !p) return;
      const want = (130 + Math.abs(p.speed) * 9) / zoom;
      range += (want - range) * 0.06;
      const px = map.canvas.width / (map.rect.x1 - map.rect.x0);
      const half = (SIZE * dpr) / 2;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#1a1e24';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.translate(half, half);
      ctx.rotate(-p.heading);
      const k = half / range / px;
      ctx.scale(k, k);
      ctx.translate(-(p.x - map.rect.x0) * px, -(p.z - map.rect.z0) * px);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(map.canvas, 0, 0);

      ctx.setTransform(dpr, 0, 0, dpr, half, half);
      ctx.fillStyle = '#ffc857';
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, -9);
      ctx.lineTo(6.5, 7);
      ctx.lineTo(0, 3.5);
      ctx.lineTo(-6.5, 7);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      // Метка севера на ободе.
      const r = SIZE / 2 - 13;
      const nx = Math.sin(-p.heading) * r, ny = -Math.cos(-p.heading) * r;
      ctx.fillStyle = 'rgba(15,17,21,0.8)';
      ctx.beginPath();
      ctx.arc(nx, ny, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ff7a6b';
      ctx.font = '700 11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('С', nx, ny + 0.5);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [engine, zoom]);

  return (
    <button className="minimap" title="Щелчок — масштаб карты" onClick={() => setZoom((z) => (z >= 2.2 ? 0.6 : z * 1.6))}>
      <canvas ref={ref} style={{ width: SIZE, height: SIZE }} />
    </button>
  );
}
