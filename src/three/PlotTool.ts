// Рисование участка на земле в three.js: клик — вершина, двойной клик / Enter / клик по первой вершине —
// завершить, правый клик (без перетаскивания) / Backspace — убрать последнюю, Esc — отмена.
// Пока рисуем, к курсору тянется «резиновая» сторона. Заливка лежит на рельефе (контур дробится на
// мелкие треугольники, высота — в каждой вершине), контур — толстой линией чуть над землёй (здания
// его закрывают), вершины — кружками поверх всего.
//
// API:
//   const tool = new PlotTool(city, frame, heightAt, { onChange, onFinish, onCancel });  // heightAt — в локальных метрах
//   tool.start();                        // начать новый участок (прежний убирается)
//   tool.handleClick(clientX, clientY);  // левый клик (не перетаскивание) в режиме рисования — его передаёт CityViewer,
//                                        // так один и тот же клик не может и поставить вершину, и выбрать здание
//   tool.undo(); tool.finish(); tool.cancel();  // кнопки панели участка
//   tool.showResult(valid);              // подкрасить готовый участок по итогам проверки
//   tool.reset();                        // убрать участок со сцены без колбэков
//   tool.isDrawing; tool.destroy();
// Движение мыши, двойной клик, правый клик и клавиши инструмент слушает сам (только пока рисуем).

import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  Points,
  PointsMaterial,
  SRGBColorSpace,
  ShapeUtils,
  Vector2,
} from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { PLOT_COLORS, type LonLat } from '../world/user/plot';
import type { LocalFrame, Vec2 } from '../world/walk/localFrame';
import type { CityScene } from './CityScene';
import { toLocal2, toThree } from './coords';
import { isTypingTarget } from './OverviewControls';

export interface PlotToolCallbacks {
  /** Изменился набор поставленных вершин. */
  onChange: (points: LonLat[]) => void;
  /** Контур замкнут (≥ 3 вершины). */
  onFinish: (points: LonLat[]) => void;
  onCancel: () => void;
}

type PlotLook = keyof typeof PLOT_COLORS;
type HeightAt = (x: number, y: number) => number;

/** Клик ближе этого расстояния (в пикселях) к первой вершине замыкает контур. */
const CLOSE_RING_PX = 12;
/** Вершины ближе этого расстояния (м или пикселей на экране) считаются одной точкой (двойной клик и т. п.). */
const MIN_VERTEX_DISTANCE_M = 0.5;
const MIN_VERTEX_DISTANCE_PX = 4;
/** Правая кнопка, сдвинутая дальше (в пикселях), — вращение камеры, а не «убрать вершину». */
const RIGHT_CLICK_PX = 5;
/** Двойной клик вскоре после клика по участку — наш: камера к точке не летит. */
const DOUBLE_CLICK_MS = 600;
/** Заливка и контур чуть выше земли — чтобы не тонули в рельефе между точками выборки. */
const FILL_LIFT = 0.3;
const OUTLINE_LIFT = 0.4;
/** Шаг сетки заливки и точек контура по рельефу, м; на огромных контурах шаг растёт (не больше MAX_*). */
const FILL_STEP = 3;
const OUTLINE_STEP = 2;
const MAX_FILL_TRIANGLES = 8000;
const MAX_OUTLINE_POINTS = 2000;
const FILL_OPACITY = 0.35;
const OUTLINE_WIDTH_PX = 3;
/** Кружок вершины: 9 px белого и 2 px обводки с каждой стороны. */
const VERTEX_SIZE_PX = 13;
/** Поверх земли и зданий. */
const RENDER_ORDER = 20;

export class PlotTool {
  private readonly fill: Mesh<BufferGeometry, MeshBasicMaterial>;
  private readonly outline: Line2;
  private readonly vertices: Points<BufferGeometry, PointsMaterial>;
  private readonly removeAnimator: () => void;
  /** Поставленные вершины, локальные метры. */
  private points: Vec2[] = [];
  /** Точка земли под курсором — конец «резиновой» стороны. */
  private cursor: Vec2 | undefined;
  /** Позиция мыши, ещё не перенесённая на землю (пересчёт — раз в кадр). */
  private pointer: [number, number] | undefined;
  private rightDown: [number, number] | undefined;
  private lastClickAt = Number.NEGATIVE_INFINITY;
  private drawing = false;

  constructor(
    private readonly city: CityScene,
    private readonly frame: LocalFrame,
    /** Высота земли в локальных метрах. */
    private readonly heightAt: HeightAt,
    private readonly callbacks: PlotToolCallbacks,
  ) {
    this.fill = new Mesh(
      new BufferGeometry(),
      new MeshBasicMaterial({
        transparent: true,
        opacity: FILL_OPACITY,
        depthWrite: false,
        side: DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
        fog: false,
      }),
    );
    this.outline = new Line2(
      new LineGeometry(),
      new LineMaterial({ linewidth: OUTLINE_WIDTH_PX, worldUnits: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    );
    this.vertices = new Points(
      new BufferGeometry(),
      new PointsMaterial({
        map: vertexTexture(),
        size: VERTEX_SIZE_PX,
        sizeAttenuation: false,
        transparent: true,
        // Вершины видны поверх зданий.
        depthTest: false,
        depthWrite: false,
        fog: false,
      }),
    );
    this.fill.name = 'plot-fill';
    this.outline.name = 'plot-outline';
    this.vertices.name = 'plot-vertices';
    [this.fill, this.outline, this.vertices].forEach((object, i) => {
      object.renderOrder = RENDER_ORDER + i;
      object.visible = false;
    });
    city.scene.add(this.fill, this.outline, this.vertices);
    this.setLook('draft');

    const canvas = city.canvas;
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointerup', this.onPointerUp);
    // capture: на самом canvas такой обработчик срабатывает раньше обычных — двойной клик не дойдёт до OverviewControls.
    canvas.addEventListener('dblclick', this.onDoubleClick, { capture: true });
    window.addEventListener('keydown', this.onKeyDown);
    this.removeAnimator = city.addAnimator(() => this.followPointer());
  }

  get isDrawing(): boolean {
    return this.drawing;
  }

  start(): void {
    this.reset();
    this.drawing = true;
    this.setLook('draft');
    this.city.canvas.style.cursor = 'crosshair';
    this.update();
  }

  handleClick(clientX: number, clientY: number): void {
    if (!this.drawing) return;
    this.lastClickAt = performance.now();

    const first = this.points[0];
    if (first && this.points.length >= 3 && this.isNear(first, clientX, clientY, CLOSE_RING_PX)) {
      this.finish();
      return;
    }

    const point = this.pick(clientX, clientY);
    if (!point) return;
    const last = this.points[this.points.length - 1];
    if (last && (Math.hypot(point[0] - last[0], point[1] - last[1]) < MIN_VERTEX_DISTANCE_M || this.isNear(last, clientX, clientY, MIN_VERTEX_DISTANCE_PX))) {
      return;
    }

    this.points.push(point);
    this.emitChange();
  }

  undo(): void {
    if (!this.drawing || this.points.length === 0) return;
    this.points.pop();
    this.emitChange();
  }

  finish(): void {
    if (!this.drawing || this.points.length < 3) return;
    this.drawing = false;
    this.cursor = undefined;
    this.pointer = undefined;
    this.city.canvas.style.cursor = '';
    this.update();
    this.callbacks.onFinish(this.lonLats());
  }

  cancel(): void {
    if (!this.drawing) return;
    this.reset();
    this.callbacks.onCancel();
  }

  /** Подкрашивает готовый участок по результату проверки. */
  showResult(valid: boolean): void {
    this.setLook(valid ? 'valid' : 'invalid');
  }

  /** Убирает участок со сцены без колбэков. */
  reset(): void {
    this.drawing = false;
    this.cursor = undefined;
    this.pointer = undefined;
    this.points = [];
    this.city.canvas.style.cursor = '';
    this.update();
  }

  destroy(): void {
    this.removeAnimator();
    const canvas = this.city.canvas;
    canvas.removeEventListener('pointermove', this.onPointerMove);
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('dblclick', this.onDoubleClick, { capture: true });
    window.removeEventListener('keydown', this.onKeyDown);
    if (this.drawing) canvas.style.cursor = '';
    this.city.scene.remove(this.fill, this.outline, this.vertices);
    this.fill.geometry.dispose();
    this.fill.material.dispose();
    this.outline.geometry.dispose();
    this.outline.material.dispose();
    this.vertices.geometry.dispose();
    this.vertices.material.map?.dispose();
    this.vertices.material.dispose();
    this.city.requestRender();
  }

  // --- внутреннее -----------------------------------------------------------

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (!this.drawing || isTypingTarget(event.target)) return;

    if (event.key === 'Enter') this.finish();
    else if (event.key === 'Escape') this.cancel();
    else if (event.key === 'Backspace' || event.key === 'Delete') this.undo();
    else return;
    event.preventDefault();
  };

  private readonly onPointerMove = (event: PointerEvent) => {
    if (!this.drawing) return;
    this.pointer = [event.clientX, event.clientY];
  };

  private readonly onPointerDown = (event: PointerEvent) => {
    if (event.button === 2) this.rightDown = [event.clientX, event.clientY];
  };

  /** Правый клик без перетаскивания (перетаскивание правой кнопкой вращает камеру) — убрать последнюю вершину. */
  private readonly onPointerUp = (event: PointerEvent) => {
    if (event.button !== 2 || !this.rightDown) return;
    const moved = Math.hypot(event.clientX - this.rightDown[0], event.clientY - this.rightDown[1]);
    this.rightDown = undefined;
    if (this.drawing && moved <= RIGHT_CLICK_PX) this.undo();
  };

  private readonly onDoubleClick = (event: MouseEvent) => {
    // Двойной клик сразу после клика, замкнувшего контур, тоже наш — иначе камера полетит к точке.
    if (!this.drawing && performance.now() - this.lastClickAt > DOUBLE_CLICK_MS) return;
    event.stopImmediatePropagation();
    this.finish();
  };

  /** Раз в кадр: точка земли под мышью → «резиновая» сторона. */
  private followPointer(): void {
    if (!this.pointer) return;
    const [x, y] = this.pointer;
    this.pointer = undefined;
    if (!this.drawing) return;
    this.cursor = this.pick(x, y);
    this.update();
  }

  private emitChange(): void {
    this.update();
    this.callbacks.onChange(this.lonLats());
  }

  /** Точка на земле (сквозь здания), локальные метры. */
  private pick(clientX: number, clientY: number): Vec2 | undefined {
    const point = this.city.pickGround(clientX, clientY);
    return point ? toLocal2(point) : undefined;
  }

  /** Вершина на экране не дальше px пикселей от точки клика. */
  private isNear([x, y]: Vec2, clientX: number, clientY: number, px: number): boolean {
    const p = toThree(x, y, this.heightAt(x, y) + OUTLINE_LIFT).project(this.city.camera);
    if (p.z < -1 || p.z > 1) return false;
    const rect = this.city.canvas.getBoundingClientRect();
    const sx = rect.left + ((p.x + 1) / 2) * rect.width;
    const sy = rect.top + ((1 - p.y) / 2) * rect.height;
    return Math.hypot(sx - clientX, sy - clientY) <= px;
  }

  /** Перестроить заливку, контур и вершины: вершины плюс «резиновая» точка под курсором, пока идёт рисование. */
  private update(): void {
    const shape = this.drawing && this.cursor ? [...this.points, this.cursor] : this.points;

    this.vertices.visible = this.points.length > 0;
    if (this.vertices.visible) {
      const positions = this.points.flatMap(([x, y]) => [x, this.heightAt(x, y) + OUTLINE_LIFT, -y]);
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
      geometry.computeBoundingSphere();
      this.vertices.geometry.dispose();
      this.vertices.geometry = geometry;
    }

    this.outline.visible = shape.length >= 2;
    if (this.outline.visible) {
      const ring = shape.length > 2 ? [...shape, shape[0]!] : shape;
      const geometry = new LineGeometry();
      geometry.setPositions(drapedLine(ring, this.heightAt, OUTLINE_LIFT));
      this.outline.geometry.dispose();
      this.outline.geometry = geometry;
    }

    this.fill.visible = shape.length >= 3;
    if (this.fill.visible) {
      const geometry = drapedPolygon(shape, this.heightAt, FILL_LIFT);
      this.fill.geometry.dispose();
      this.fill.geometry = geometry;
    }

    this.city.requestRender();
  }

  private setLook(look: PlotLook): void {
    const color = PLOT_COLORS[look];
    this.fill.material.color.set(color);
    this.outline.material.color.set(color);
    this.city.requestRender();
  }

  private lonLats(): LonLat[] {
    return this.points.map((point) => this.frame.toLonLat(point));
  }
}

/** Ломаная по рельефу: точки через ~OUTLINE_STEP м, координаты three.js (x, высота, −y). */
function drapedLine(path: readonly Vec2[], heightAt: HeightAt, lift: number): number[] {
  let length = 0;
  for (let i = 1; i < path.length; i++) length += Math.hypot(path[i]![0] - path[i - 1]![0], path[i]![1] - path[i - 1]![1]);
  const step = Math.max(OUTLINE_STEP, length / MAX_OUTLINE_POINTS);

  const positions: number[] = [];
  const push = (x: number, y: number) => positions.push(x, heightAt(x, y) + lift, -y);
  for (let i = 1; i < path.length; i++) {
    const [ax, ay] = path[i - 1]!;
    const [bx, by] = path[i]!;
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 0; k < n; k++) push(ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n);
  }
  const end = path[path.length - 1]!;
  push(end[0], end[1]);
  return positions;
}

/**
 * Многоугольник, уложенный на рельеф: треугольники контура дробим на мелкие (шаг ~FILL_STEP м)
 * и каждую вершину ставим на землю — заливка не тонет в склонах и не висит над ложбинами.
 */
function drapedPolygon(shape: readonly Vec2[], heightAt: HeightAt, lift: number): BufferGeometry {
  const contour = shape.map(([x, y]) => new Vector2(x, y));
  const triangles = ShapeUtils.triangulateShape(contour, []).map((face) => face.map((i) => shape[i]!) as [Vec2, Vec2, Vec2]);
  const edge = (a: Vec2, b: Vec2) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  const longest = triangles.map(([a, b, c]) => Math.max(edge(a, b), edge(b, c), edge(c, a)));
  // Треугольник с длинной стороной L дробится на (L / step)² частей — шаг подбираем под общий предел.
  const step = Math.max(FILL_STEP, Math.sqrt(longest.reduce((sum, l) => sum + l * l, 0) / MAX_FILL_TRIANGLES));

  const positions: number[] = [];
  const indices: number[] = [];
  triangles.forEach(([a, b, c], t) => {
    const n = Math.max(1, Math.ceil(longest[t]! / step));
    const base = positions.length / 3;
    // Сетка внутри треугольника: строка i (от a к b) из n − i + 1 точек (от a к c), i + j ≤ n.
    const index = (i: number, j: number) => base + (i * (2 * n + 3 - i)) / 2 + j;
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n - i; j++) {
        const x = a[0] + ((b[0] - a[0]) * i + (c[0] - a[0]) * j) / n;
        const y = a[1] + ((b[1] - a[1]) * i + (c[1] - a[1]) * j) / n;
        positions.push(x, heightAt(x, y) + lift, -y);
      }
    }
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n - i; j++) {
        indices.push(index(i, j), index(i + 1, j), index(i, j + 1));
        if (j < n - i - 1) indices.push(index(i + 1, j), index(i + 1, j + 1), index(i, j + 1));
      }
    }
  });

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

/** Кружок вершины: белый с цветной обводкой. */
function vertexTexture(): CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const disc = (radius: number, color: string) => {
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, radius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  };
  disc(size / 2 - 1, PLOT_COLORS.draft);
  disc((size / 2) * (9 / VERTEX_SIZE_PX), '#ffffff');
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}
