// Кисть рельефа в сцене (инструмент «Рельеф» редактора). Круг под мышью показывает размер и вид кисти;
// ведёте с зажатой левой кнопкой — касания кисти через четверть радиуса, а на месте — несколько раз
// в секунду (держите — растёт холм). Сама земля и всё, что на ней, меняются по ходу (onDab);
// отпустили — мазок уходит в правки (onStroke). [ и ] — меньше и больше кисть.

import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { useAppStore } from '../store/useAppStore';
import { useEditStore } from '../store/useEditStore';
import { useUnderlayStore } from '../store/useUnderlayStore';
import { SCULPT_RADIUS, type SculptBrush, type SculptMode, type SculptStroke } from '../world/base/sculpt';
import type { Vec2 } from '../world/walk/localFrame';
import type { CityScene } from './CityScene';

export interface TerrainBrushContext {
  city: CityScene;
  /** Камера обзора: на время мазка левая кнопка — кисти, а не камере. */
  controls: { setEnabled: (enabled: boolean) => void };
  /** Высота земли (с правками) в локальных метрах. */
  heightAt: (x: number, y: number) => number;
  toLonLat: (point: Vec2) => [number, number];
  /** Касание кисти: поменять землю и всё, что на ней. */
  onDab: (brush: SculptBrush, center: Vec2) => void;
  /** Мазок закончен — в правки. */
  onStroke: (stroke: SculptStroke) => void;
}

const RING_SEGMENTS = 72;
const RING_LIFT = 0.25;
/** На месте кисть касается земли так часто, мс. */
const HOLD_MS = 110;
const COLORS: Record<SculptMode, number> = { raise: 0xf2b25c, lower: 0x6fb7ff, flatten: 0xffffff, smooth: 0x9fe39f };

let strokeCounter = 0;
const strokeId = () => `t${Date.now().toString(36)}${(strokeCounter++).toString(36)}`;

export class TerrainBrush {
  private readonly ring: Line2;
  private readonly material: LineMaterial;
  private stroke?: SculptStroke;
  private last?: Vec2;
  private hover?: Vec2;
  private hold?: number;
  private pointerId?: number;
  private readonly unsubscribe: () => void;

  constructor(private readonly ctx: TerrainBrushContext) {
    this.material = new LineMaterial({ color: COLORS.raise, linewidth: 3, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false });
    this.ring = new Line2(new LineGeometry(), this.material);
    this.ring.name = 'terrain-brush';
    // Толщина линии — в пикселях: материалу нужен размер кадра.
    this.ring.onBeforeRender = (renderer) => {
      renderer.getSize(this.material.resolution);
    };
    this.ring.renderOrder = 999;
    this.ring.frustumCulled = false;
    this.ring.visible = false;
    ctx.city.scene.add(this.ring);
    const canvas = ctx.city.canvas;
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
    window.addEventListener('keydown', this.onKey);
    this.unsubscribe = useEditStore.subscribe((state, prev) => {
      if (state.tool !== prev.tool && state.tool !== 'terrain') this.end();
      if (state.tool !== prev.tool || state.sculpt !== prev.sculpt) this.drawRing();
    });
  }

  destroy(): void {
    this.end();
    const canvas = this.ctx.city.canvas;
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    canvas.removeEventListener('pointermove', this.onPointerMove);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('pointercancel', this.onPointerUp);
    canvas.removeEventListener('pointerleave', this.onPointerLeave);
    window.removeEventListener('keydown', this.onKey);
    this.unsubscribe();
    this.ctx.city.scene.remove(this.ring);
    this.ring.geometry.dispose();
    this.material.dispose();
  }

  private active(): boolean {
    return useEditStore.getState().tool === 'terrain' && useAppStore.getState().mode === 'explore' && !useUnderlayStore.getState().mode;
  }

  private pick(event: PointerEvent): Vec2 | undefined {
    const hit = this.ctx.city.pickGround(event.clientX, event.clientY);
    return hit ? [hit.x, -hit.z] : undefined;
  }

  private readonly onPointerDown = (event: PointerEvent) => {
    if (!this.active() || event.button !== 0 || !event.isPrimary || event.shiftKey || event.ctrlKey || event.altKey) return;
    const point = this.pick(event);
    if (!point) return;
    const { sculpt } = useEditStore.getState();
    this.stroke = {
      id: strokeId(),
      mode: sculpt.mode,
      radius: sculpt.radius,
      strength: sculpt.strength,
      ...(sculpt.mode === 'flatten' ? { level: this.ctx.heightAt(point[0], point[1]) } : {}),
      dabs: [],
    };
    this.ctx.controls.setEnabled(false);
    try {
      this.ctx.city.canvas.setPointerCapture(event.pointerId);
      this.pointerId = event.pointerId;
    } catch {
      // Указатель уже отпущен.
    }
    this.dab(point);
    this.hold = window.setInterval(() => this.last && this.dab(this.last), HOLD_MS);
  };

  private readonly onPointerMove = (event: PointerEvent) => {
    if (!event.isPrimary || !this.active()) return;
    const point = this.pick(event);
    if (!point) return;
    this.hover = point;
    const stroke = this.stroke;
    if (stroke && this.last) {
      // Вдоль пути — касания через четверть радиуса (быстрое движение не оставляет пропусков).
      const spacing = Math.max(0.5, stroke.radius / 4);
      const dx = point[0] - this.last[0];
      const dy = point[1] - this.last[1];
      const steps = Math.floor(Math.hypot(dx, dy) / spacing);
      const from = this.last;
      for (let k = 1; k <= steps; k++) this.dab([from[0] + (dx * k * spacing) / Math.hypot(dx, dy), from[1] + (dy * k * spacing) / Math.hypot(dx, dy)]);
      if (steps) this.restartHold();
    }
    this.drawRing();
  };

  private readonly onPointerUp = (event: PointerEvent) => {
    if (event.pointerId === this.pointerId || this.stroke) this.end();
  };

  private readonly onPointerLeave = () => {
    if (this.stroke) return;
    this.hover = undefined;
    this.drawRing();
  };

  private readonly onKey = (event: KeyboardEvent) => {
    if (!this.active() || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    const { sculpt, setSculpt } = useEditStore.getState();
    if (event.code === 'BracketLeft') setSculpt({ radius: Math.max(SCULPT_RADIUS.min, Math.round(sculpt.radius / 1.25)) });
    else if (event.code === 'BracketRight') setSculpt({ radius: Math.min(SCULPT_RADIUS.max, Math.round(sculpt.radius * 1.25)) });
  };

  private restartHold(): void {
    if (this.hold === undefined) return;
    window.clearInterval(this.hold);
    this.hold = window.setInterval(() => this.last && this.dab(this.last), HOLD_MS);
  }

  private dab(point: Vec2): void {
    const stroke = this.stroke;
    if (!stroke) return;
    stroke.dabs.push(this.ctx.toLonLat(point));
    this.last = point;
    this.ctx.onDab(stroke, point);
    this.drawRing();
  }

  private end(): void {
    if (this.hold !== undefined) window.clearInterval(this.hold);
    this.hold = undefined;
    if (this.pointerId !== undefined) {
      const canvas = this.ctx.city.canvas;
      if (canvas.hasPointerCapture(this.pointerId)) canvas.releasePointerCapture(this.pointerId);
      this.pointerId = undefined;
    }
    const stroke = this.stroke;
    this.stroke = undefined;
    this.last = undefined;
    if (!stroke) return;
    this.ctx.controls.setEnabled(true);
    if (stroke.dabs.length) this.ctx.onStroke(stroke);
  }

  /** Круг кисти по земле под мышью (или там, где рисуем). */
  private drawRing(): void {
    const center = this.last ?? this.hover;
    const show = this.active() && !!center;
    if (this.ring.visible !== show) {
      this.ring.visible = show;
      this.ctx.city.requestRender();
    }
    if (!show || !center) return;
    const { sculpt } = useEditStore.getState();
    this.material.color.setHex(COLORS[sculpt.mode]);
    const positions: number[] = [];
    for (let k = 0; k <= RING_SEGMENTS; k++) {
      const a = (k / RING_SEGMENTS) * Math.PI * 2;
      const x = center[0] + Math.cos(a) * sculpt.radius;
      const y = center[1] + Math.sin(a) * sculpt.radius;
      positions.push(x, this.ctx.heightAt(x, y) + RING_LIFT, -y);
    }
    // Новая геометрия на каждый сдвиг: у LineGeometry буферы по числу точек, точек всегда столько же.
    const old = this.ring.geometry;
    this.ring.geometry = new LineGeometry().setPositions(positions);
    old.dispose();
    this.ctx.city.requestRender();
  }
}
