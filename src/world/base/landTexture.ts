// Покрытия района (дороги, тротуары, трава, вода, огороды) — рисуются с вектора в любой
// прямоугольник мира: по тайлам, в разрешении под приближение камеры. Поэтому вблизи бордюры,
// плитка и травинки чёткие, а издалека нет ряби. Никаких внешних картинок — всё процедурно.

import { random01 } from '../../utils/hash';
import type { GroundKind } from './environment';
import type { Ring } from './types';

export interface LandBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** Огород: контур в lon/lat и направление грядок в метрах (восток, север). */
export interface GardenPatch {
  ring: Ring;
  rows: [number, number];
  seed: number;
  /** Дом, к чьему двору относится огород (убрали дом — убираем и огород). */
  houseId?: string;
}

export interface LandStyle {
  /** Земля, где в OSM ничего нет. */
  bare: string;
  colors: Record<GroundKind, string>;
  /** Лесная подстилка (темнее газона) и луг (светлее, суше). */
  wood: string;
  meadow: string;
}

export interface LandInput {
  byKind: ReadonlyMap<GroundKind, Ring[][]>;
  covers: { wood: Ring[][]; meadow: Ring[][] };
  gardens: readonly GardenPatch[];
  /** Грунтовые дороги (просёлки), нарисованные в редакторе. */
  dirt?: Ring[][];
  style: LandStyle;
  /**
   * Деревня: асфальт без бордюров — с гравийной обочиной и выкрошенным краем, а проезды (footway) — грунтовки
   * с колеями и травой посередине.
   */
  village?: boolean;
  /** Оси дорог (lon/lat) и ширина, м: по ним — накатанные колеи, заплатки и трещины. */
  axes?: readonly { coords: readonly [number, number][]; width: number; kind: 'asphalt' | 'track' }[];
}

/** Деревенские дороги: цвета и размеры деталей. */
const VILLAGE_ROAD = {
  asphalt: '#73716c',
  shoulder: '#9c9483',
  shoulderM: 1.3,
  track: '#8f7a5c',
  rut: '#6f5d45',
};

interface Axis {
  pts: [number, number][];
  width: number;
  kind: 'asphalt' | 'track';
  box: [number, number, number, number];
  seed: number;
  /** Длина оси от начала до каждой точки, м (поиск точки по длине — делением пополам). */
  cum: number[];
  /** Посчитанные один раз (не на каждую перерисовку тайла): заплатки и трещины. */
  patchList?: { x: number; y: number; angle: number; w: number; h: number; fresh: boolean }[];
  crackPath?: Path2D;
}

type Paint = GroundKind | 'wood' | 'meadow' | 'garden' | 'dirt';
/** Просёлок: утоптанная земля. */
const DIRT_COLOR = '#9b8565';

/** Порядок снизу вверх. Трава (узоры) ложится после мягких заливок, твёрдые покрытия — поверх неё. */
const SOFT: Paint[] = ['green', 'meadow', 'wood'];
const HARD: Paint[] = ['garden', 'water', 'pitch', 'parking', 'paving', 'dirt', 'sidewalk', 'road', 'footway', 'marking'];

/** Кромки, м: бордюрный камень у дорог и тротуаров, береговая линия, разметка поля. */
const EDGES: Partial<Record<Paint, { color: string; widthM: number }[]>> = {
  // Сначала светлый бордюрный камень, поверх — тёмный лоток у самого края асфальта.
  road: [
    { color: '#b9b4aa', widthM: 0.5 },
    { color: '#4c4f55', widthM: 0.18 },
  ],
  sidewalk: [{ color: '#a69e90', widthM: 0.3 }],
  footway: [{ color: '#b7ab93', widthM: 0.15 }],
  paving: [{ color: '#aaa294', widthM: 0.2 }],
  water: [{ color: '#4f7ea6', widthM: 1.0 }],
  pitch: [{ color: '#eef1e6', widthM: 0.12 }],
};

const GARDEN = { soil: '#7f6043', plants: ['#6f8a3e', '#7c9445', '#5f7d3a'], rowStepM: 0.9, rowWidthM: 0.45 };

interface Item {
  paint: Paint;
  /** Кольца в локальных метрах (x — восток, y — север). */
  rings: [number, number][][];
  box: [number, number, number, number];
  /** Направление укладки плитки / грядок, рад. */
  angle: number;
  seed: number;
}

/**
 * Узоры с привязкой к миру: пиксель узора — `metres` метров. Слой проявляется, когда его пиксель
 * на экране не мельче ~0,7 пикселя тайла (иначе рябь), и набирает силу к 1,5.
 */
interface Layer {
  canvas: HTMLCanvasElement;
  metres: number;
  alpha: number;
}

const M_PER_DEG_LAT = 111_320;

/** Рисует покрытия района в canvas любого прямоугольника в lon/lat. */
export class LandTextureRenderer {
  private readonly items: Item[] = [];
  private readonly axes: Axis[] = [];
  private readonly lon0: number;
  private readonly lat0: number;
  private readonly mPerDegLon: number;
  private layers?: ReturnType<typeof buildLayers>;

  constructor(
    private readonly input: LandInput,
    bounds: LandBounds,
  ) {
    this.lon0 = (bounds.west + bounds.east) / 2;
    this.lat0 = (bounds.south + bounds.north) / 2;
    this.mPerDegLon = M_PER_DEG_LAT * Math.cos((this.lat0 * Math.PI) / 180);

    const add = (paint: Paint, polygons: readonly Ring[][], extra: (rings: [number, number][][]) => Partial<Item> = () => ({})) => {
      polygons.forEach((polygon, index) => {
        const rings = polygon.map((ring) => ring.map(([lon, lat]) => this.toLocal(lon, lat)));
        const outer = rings[0] ?? [];
        const xs = outer.map(([x]) => x);
        const ys = outer.map(([, y]) => y);
        this.items.push({
          paint,
          rings,
          box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
          angle: dominantAngle(outer),
          seed: Math.floor(random01(index * 31 + paint.length) * 1e6),
          ...extra(rings),
        });
      });
    };
    for (const paint of [...SOFT, ...HARD]) {
      if (paint === 'wood' || paint === 'meadow') add(paint, input.covers[paint]);
      else if (paint === 'dirt') add('dirt', input.dirt ?? []);
      else if (paint === 'garden') {
        input.gardens.forEach((g) =>
          add('garden', [[g.ring]], () => ({ angle: Math.atan2(g.rows[1], g.rows[0]), seed: g.seed })),
        );
      } else add(paint, input.byKind.get(paint) ?? []);
    }
    (input.axes ?? []).forEach((axis, index) => {
      const pts = axis.coords.map(([lon, lat]) => this.toLocal(lon, lat));
      if (pts.length < 2) return;
      const pad = axis.width;
      const xs = pts.map(([x]) => x);
      const ys = pts.map(([, y]) => y);
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1]! + Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]));
      this.axes.push({
        pts,
        width: axis.width,
        kind: axis.kind,
        box: [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad],
        seed: Math.floor(random01(index * 97 + 13) * 1e6),
        cum,
      });
    });
  }

  /** Рисует прямоугольник мира [west, south, east, north] в canvas width × height. */
  draw(canvas: HTMLCanvasElement, rect: LandBounds): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    this.layers ??= buildLayers();
    const [x0, y0] = this.toLocal(rect.west, rect.south);
    const [x1, y1] = this.toLocal(rect.east, rect.north);
    const sx = canvas.width / (x1 - x0);
    const sy = canvas.height / (y1 - y0);
    const pxPerM = Math.sqrt(sx * sy);
    // Дальше рисуем в метрах: x — восток, y — север (ось y холста перевёрнута).
    ctx.setTransform(sx, 0, 0, -sy, -x0 * sx, y1 * sy);
    ctx.imageSmoothingEnabled = true;

    const margin = 2;
    const visible = this.items.filter(
      ({ box }) => box[0] <= x1 + margin && box[2] >= x0 - margin && box[1] <= y1 + margin && box[3] >= y0 - margin,
    );
    const area: [number, number, number, number] = [x0 - margin, y0 - margin, x1 - x0 + 2 * margin, y1 - y0 + 2 * margin];

    ctx.fillStyle = this.input.style.bare;
    ctx.fillRect(...area);
    for (const item of visible) if (SOFT.includes(item.paint)) this.fill(ctx, item);

    // Трава на любом масштабе: пятна сухой/сочной травы, кочки, пучки, отдельные травинки и цветы.
    for (const layer of this.layers.grass) this.overlay(ctx, layer, area, pxPerM);

    const village = !!this.input.village;
    const axes = this.axes.filter(({ box }) => box[0] <= x1 && box[2] >= x0 && box[1] <= y1 && box[3] >= y0);
    // В деревне грунтовки — под асфальтом: где проезд выходит на улицу, сверху — асфальт.
    const order = village ? HARD.filter((p) => p !== 'footway').flatMap((p) => (p === 'road' ? ['footway' as Paint, p] : [p])) : HARD;
    for (const paint of order) {
      const ofPaint = visible.filter((item) => item.paint === paint);
      if (village && paint === 'road') {
        this.villageAsphalt(ctx, ofPaint, axes, area, pxPerM);
        continue;
      }
      if (village && paint === 'footway') {
        this.villageTracks(ctx, ofPaint, axes, area, pxPerM);
        continue;
      }
      for (const item of ofPaint) {
        this.fill(ctx, item);
        this.texture(ctx, item, pxPerM);
        for (const edge of EDGES[paint] ?? []) {
          ctx.strokeStyle = edge.color;
          ctx.lineWidth = Math.max(edge.widthM, 0.8 / pxPerM);
          ctx.lineJoin = 'round';
          this.trace(ctx, item);
          ctx.stroke();
        }
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /**
   * Деревенский асфальт: гравийная обочина, тёплый изношенный асфальт с пятнами (крупными и мелкими),
   * накатанные колеи по полосам, заплатки, трещины у краёв, выкрошенный край.
   */
  private villageAsphalt(ctx: CanvasRenderingContext2D, items: readonly Item[], axes: readonly Axis[], area: [number, number, number, number], pxPerM: number): void {
    if (!items.length) return;
    const layers = this.layers!;
    // Обочина — гравий вперемешку с травой, под асфальтом: у края асфальта гравия больше, дальше — трава.
    // Сначала мягкая широкая полоса, потом плотная узкая, сверху — узор гравия и пятна травы.
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const band = (widthM: number, style: string | CanvasPattern, alpha = 1) => {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.lineWidth = widthM * 2;
      ctx.strokeStyle = style;
      for (const item of items) {
        this.trace(ctx, item);
        ctx.stroke();
      }
      ctx.restore();
    };
    band(VILLAGE_ROAD.shoulderM * 1.5, VILLAGE_ROAD.shoulder, 0.28);
    band(VILLAGE_ROAD.shoulderM, VILLAGE_ROAD.shoulder, 0.55);
    band(VILLAGE_ROAD.shoulderM * 0.55, VILLAGE_ROAD.shoulder, 0.75);
    const gravel = this.pattern(ctx, layers.gravel, pxPerM);
    if (gravel) band(VILLAGE_ROAD.shoulderM, gravel.pattern, gravel.alpha * 0.8);
    // Трава прорастает на обочину пятнами (крупные — видны и издалека, мелкие — вблизи).
    for (const layer of layers.vergeGrass) {
      const grass = this.pattern(ctx, layer, pxPerM);
      if (grass) band(VILLAGE_ROAD.shoulderM * 1.5, grass.pattern, grass.alpha);
    }
    // Выкрошенный край — до асфальта: зубцы видны только снаружи, а на стыках улиц их закрывает асфальт.
    for (const item of items) {
      ctx.setLineDash([0.35 + random01(item.seed) * 0.4, 0.5 + random01(item.seed + 1) * 0.9, 0.2, 0.7]);
      ctx.strokeStyle = 'rgba(150,142,124,0.9)';
      ctx.lineWidth = Math.max(0.5, 0.8 / pxPerM);
      this.trace(ctx, item);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Асфальт и всё на нём — внутри контуров дорог.
    ctx.save();
    ctx.beginPath();
    for (const item of items) {
      for (const ring of item.rings) {
        ring.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
        ctx.closePath();
      }
    }
    ctx.clip('nonzero');
    ctx.fillStyle = VILLAGE_ROAD.asphalt;
    ctx.fillRect(...area);
    // Пятна: крупные (выгоревший и тёмный асфальт), средние, мелкая крошка.
    for (const layer of layers.asphaltStains) this.overlay(ctx, layer, area, pxPerM);
    for (const axis of axes) {
      if (axis.kind !== 'asphalt') continue;
      // Накатанные колеи: по две на полосу — темнее и глаже; между ними — светлее.
      // Мягкие (несколько обводок от широкой к узкой — край без резкой границы).
      const lane = axis.width / 4;
      for (const off of [-lane * 1.45, -lane * 0.55, lane * 0.55, lane * 1.45]) {
        for (const k of [1.6, 1.1, 0.6]) this.strokeOffset(ctx, axis.pts, off, Math.min(0.9, axis.width * 0.12) * k, 'rgba(40,40,42,0.045)');
      }
      for (const k of [1.6, 1]) this.strokeOffset(ctx, axis.pts, 0, Math.min(1.2, axis.width * 0.15) * k, 'rgba(190,186,176,0.035)');
      this.patches(ctx, axis, pxPerM);
      if (pxPerM > 6) this.cracks(ctx, axis);
    }
    this.overlay(ctx, layers.asphalt, area, pxPerM);
    ctx.restore();
  }

  /**
   * Деревенские проезды — грунтовка: земля, две колеи, полоса травы посередине, мягкий травяной край и лужи
   * в колеях.
   */
  private villageTracks(ctx: CanvasRenderingContext2D, items: readonly Item[], axes: readonly Axis[], area: [number, number, number, number], pxPerM: number): void {
    if (!items.length) return;
    const layers = this.layers!;
    // Мягкий край: полупрозрачная примятая трава за контуром.
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(150,135,95,0.35)';
    ctx.lineWidth = 1.6;
    for (const item of items) {
      this.trace(ctx, item);
      ctx.stroke();
    }
    ctx.save();
    ctx.beginPath();
    for (const item of items) {
      for (const ring of item.rings) {
        ring.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
        ctx.closePath();
      }
    }
    ctx.clip('nonzero');
    ctx.fillStyle = VILLAGE_ROAD.track;
    ctx.fillRect(...area);
    this.overlay(ctx, layers.soil, area, pxPerM);
    for (const layer of layers.asphaltStains.slice(0, 1)) this.overlay(ctx, layer, area, pxPerM);
    for (const axis of axes) {
      if (axis.kind !== 'track') continue;
      const half = Math.min(0.85, axis.width * 0.3);
      // Трава между колеями и по краям.
      for (const k of [1.4, 1, 0.6]) this.strokeOffset(ctx, axis.pts, 0, Math.min(0.7, axis.width * 0.22) * k, 'rgba(120,140,80,0.22)');
      // Колеи — темнее и влажнее; лужи — в низких местах (по зерну).
      for (const off of [-half, half]) for (const k of [1.5, 1, 0.55]) this.strokeOffset(ctx, axis.pts, off, 0.45 * k, 'rgba(90,72,50,0.2)');
      this.puddles(ctx, axis, half);
    }
    this.overlay(ctx, layers.grassTufts, area, pxPerM);
    ctx.restore();
    // Рваный край: трава заходит на колею неровными языками.
    ctx.lineCap = 'round';
    for (const item of items) {
      ctx.setLineDash([0.5 + random01(item.seed + 3) * 0.6, 0.4, 0.25, 0.8 + random01(item.seed + 4) * 0.8]);
      ctx.strokeStyle = 'rgba(132,150,92,0.85)';
      ctx.lineWidth = Math.max(0.45, 0.8 / pxPerM);
      this.trace(ctx, item);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  /** Ломаная со сдвигом вбок на off м (влево от направления) — одной обводкой. */
  private strokeOffset(ctx: CanvasRenderingContext2D, pts: readonly [number, number][], off: number, width: number, color: string): void {
    ctx.beginPath();
    pts.forEach(([x, y], i) => {
      const a = pts[Math.max(0, i - 1)]!;
      const b = pts[Math.min(pts.length - 1, i + 1)]!;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const nx = -(b[1] - a[1]) / len;
      const ny = (b[0] - a[0]) / len;
      if (i === 0) ctx.moveTo(x + nx * off, y + ny * off);
      else ctx.lineTo(x + nx * off, y + ny * off);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  /** Точка на оси через s м от начала и направление там (отрезок — делением пополам по длинам). */
  private along(axis: Axis, s: number): { p: [number, number]; dir: [number, number] } | undefined {
    const { pts, cum } = axis;
    if (s < 0 || s > cum[cum.length - 1]!) return undefined;
    let lo = 1;
    let hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid]! < s) lo = mid + 1;
      else hi = mid;
    }
    const a = pts[lo - 1]!;
    const b = pts[lo]!;
    const len = cum[lo]! - cum[lo - 1]! || 1;
    const t = (s - cum[lo - 1]!) / len;
    return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], dir: [(b[0] - a[0]) / len, (b[1] - a[1]) / len] };
  }

  /** Заплатки: прямоугольники свежего (темнее) или старого (светлее) асфальта через 15–45 м. */
  private patches(ctx: CanvasRenderingContext2D, axis: Axis, pxPerM: number): void {
    if (!axis.patchList) {
      axis.patchList = [];
      let s = 8 + random01(axis.seed) * 20;
      for (let k = 0; k < 400; k++) {
        const at = this.along(axis, s);
        if (!at) break;
        const r = (q: number) => random01(axis.seed * 31 + k * 7 + q);
        const side = (r(3) - 0.5) * axis.width * 0.6;
        axis.patchList.push({
          x: at.p[0] - at.dir[1] * side,
          y: at.p[1] + at.dir[0] * side,
          angle: Math.atan2(at.dir[1], at.dir[0]) + (r(4) - 0.5) * 0.12,
          w: 1.2 + r(1) * 3,
          h: 0.8 + r(2) * Math.min(2.2, axis.width * 0.4),
          fresh: r(5) < 0.65,
        });
        s += 15 + r(6) * 30;
      }
    }
    for (const { x, y, angle, w, h, fresh } of axis.patchList) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle);
      ctx.fillStyle = fresh ? 'rgba(40,40,42,0.38)' : 'rgba(170,165,152,0.22)';
      ctx.fillRect(-w / 2, -h / 2, w, h);
      if (pxPerM > 4) {
        ctx.strokeStyle = fresh ? 'rgba(30,30,32,0.5)' : 'rgba(120,115,105,0.35)';
        ctx.lineWidth = 0.06;
        ctx.strokeRect(-w / 2, -h / 2, w, h);
      }
      ctx.restore();
    }
  }

  /** Трещины: ломаные вдоль кромок и изредка поперёк, тонкие, вблизи. */
  private cracks(ctx: CanvasRenderingContext2D, axis: Axis): void {
    ctx.strokeStyle = 'rgba(28,28,30,0.55)';
    ctx.lineWidth = 0.035;
    ctx.lineCap = 'round';
    if (!axis.crackPath) axis.crackPath = this.crackPath(axis);
    ctx.stroke(axis.crackPath);
  }

  /** Все трещины оси одной фигурой (считается один раз). */
  private crackPath(axis: Axis): Path2D {
    const path = new Path2D();
    let s = random01(axis.seed + 5) * 6;
    for (let k = 0; k < 600; k++) {
      const at = this.along(axis, s);
      if (!at) break;
      const r = (q: number) => random01(axis.seed * 53 + k * 11 + q);
      const across = r(0) < 0.25;
      const side = across ? (r(1) - 0.5) * axis.width * 0.5 : (r(1) < 0.5 ? -1 : 1) * axis.width * (0.33 + r(2) * 0.14);
      let x = at.p[0] - at.dir[1] * side;
      let y = at.p[1] + at.dir[0] * side;
      let angle = Math.atan2(at.dir[1], at.dir[0]) + (across ? Math.PI / 2 : 0);
      path.moveTo(x, y);
      const steps = 4 + Math.floor(r(3) * 6);
      for (let q = 0; q < steps; q++) {
        angle += (r(10 + q) - 0.5) * 0.9;
        const step = 0.25 + r(20 + q) * 0.45;
        x += Math.cos(angle) * step;
        y += Math.sin(angle) * step;
        path.lineTo(x, y);
      }
      s += 3 + r(4) * 9;
    }
    return path;
  }

  /** Лужи в колеях: тёмные вытянутые пятна с бликом неба. */
  private puddles(ctx: CanvasRenderingContext2D, axis: Axis, half: number): void {
    let s = random01(axis.seed + 9) * 25;
    for (let k = 0; k < 300; k++) {
      const at = this.along(axis, s);
      if (!at) break;
      const r = (q: number) => random01(axis.seed * 71 + k * 13 + q);
      if (r(0) < 0.45) {
        const off = r(1) < 0.5 ? -half : half;
        const len = 1 + r(2) * 2.5;
        ctx.save();
        ctx.translate(at.p[0] - at.dir[1] * off, at.p[1] + at.dir[0] * off);
        ctx.rotate(Math.atan2(at.dir[1], at.dir[0]));
        ctx.beginPath();
        ctx.ellipse(0, 0, len / 2, 0.32 + r(3) * 0.15, 0, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(80,92,98,0.75)';
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(-len * 0.1, 0.05, len / 3.2, 0.12, 0, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(190,205,215,0.45)';
        ctx.fill();
        ctx.restore();
      }
      s += 12 + r(4) * 30;
    }
  }

  private toLocal(lon: number, lat: number): [number, number] {
    return [(lon - this.lon0) * this.mPerDegLon, (lat - this.lat0) * M_PER_DEG_LAT];
  }

  private trace(ctx: CanvasRenderingContext2D, item: Item): void {
    ctx.beginPath();
    for (const ring of item.rings) {
      ring.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      ctx.closePath();
    }
  }

  private fill(ctx: CanvasRenderingContext2D, item: Item): void {
    const { style } = this.input;
    ctx.fillStyle =
      item.paint === 'wood'
        ? style.wood
        : item.paint === 'meadow'
          ? style.meadow
          : item.paint === 'garden'
            ? GARDEN.soil
            : item.paint === 'dirt'
              ? DIRT_COLOR
              : style.colors[item.paint];
    this.trace(ctx, item);
    // evenodd вырезает дворы-дыры, а перекрытия полигонов просто закрашиваются.
    ctx.fill('evenodd');
  }

  /** Фактура твёрдых покрытий и огородов внутри контура. */
  private texture(ctx: CanvasRenderingContext2D, item: Item, pxPerM: number): void {
    const layers = this.layers!;
    const layer =
      item.paint === 'road' || item.paint === 'parking'
        ? layers.asphalt
        : item.paint === 'sidewalk' || item.paint === 'paving' || item.paint === 'footway'
          ? layers.paving
          : item.paint === 'water'
            ? layers.ripples
            : item.paint === 'dirt'
              ? layers.soil
              : undefined;
    ctx.save();
    this.trace(ctx, item);
    ctx.clip('evenodd');
    const [bx0, by0, bx1, by1] = item.box;
    const box: [number, number, number, number] = [bx0 - 1, by0 - 1, bx1 - bx0 + 2, by1 - by0 + 2];

    if (item.paint === 'garden') {
      // Грядки — полосы ботвы вдоль участка; на земле — комья (вблизи).
      this.overlay(ctx, layers.soil, box, pxPerM);
      const cx = (bx0 + bx1) / 2;
      const cy = (by0 + by1) / 2;
      const span = Math.hypot(bx1 - bx0, by1 - by0);
      ctx.translate(cx, cy);
      ctx.rotate(item.angle);
      ctx.fillStyle = GARDEN.plants[item.seed % GARDEN.plants.length]!;
      for (let off = -span / 2; off < span / 2; off += GARDEN.rowStepM) ctx.fillRect(-span / 2, off, span, GARDEN.rowWidthM);
    } else if (layer) {
      // Плитка уложена вдоль дорожки, асфальт и рябь на воде — без поворота.
      const unrotated = item.paint === 'road' || item.paint === 'parking' || item.paint === 'water' || item.paint === 'dirt';
      this.overlay(ctx, layer, box, pxPerM, unrotated ? 0 : item.angle);
    }
    ctx.restore();
  }

  /** Узор слоя с привязкой к миру и его прозрачность на этом масштабе (мелкий — не виден, undefined). */
  private pattern(ctx: CanvasRenderingContext2D, layer: Layer, pxPerM: number): { pattern: CanvasPattern; alpha: number } | undefined {
    const alpha = layer.alpha * Math.min(Math.max((layer.metres * pxPerM - 0.7) / 0.8, 0), 1);
    if (alpha <= 0.01) return undefined;
    const pattern = ctx.createPattern(layer.canvas, 'repeat');
    if (!pattern) return undefined;
    pattern.setTransform(new DOMMatrix().scaleSelf(layer.metres, layer.metres));
    return { pattern, alpha };
  }

  /** Заливает прямоугольник (в метрах) узором слоя с привязкой к миру. */
  private overlay(
    ctx: CanvasRenderingContext2D,
    layer: Layer,
    [x, y, w, h]: [number, number, number, number],
    pxPerM: number,
    angle = 0,
  ): void {
    const onScreen = layer.metres * pxPerM;
    const alpha = layer.alpha * Math.min(Math.max((onScreen - 0.7) / 0.8, 0), 1);
    if (alpha <= 0.01) return;
    const pattern = ctx.createPattern(layer.canvas, 'repeat');
    if (!pattern) return;
    pattern.setTransform(new DOMMatrix().rotateSelf(0, 0, (angle * 180) / Math.PI).scaleSelf(layer.metres, layer.metres));
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = pattern;
    ctx.fillRect(x, y, w, h);
    ctx.restore();
  }
}

/** Направление самой длинной стороны контура, рад (вдоль неё кладём плитку). */
function dominantAngle(ring: readonly [number, number][]): number {
  let best = 0;
  let angle = 0;
  for (let i = 1; i < ring.length; i++) {
    const dx = ring[i]![0] - ring[i - 1]![0];
    const dy = ring[i]![1] - ring[i - 1]![1];
    const length = Math.hypot(dx, dy);
    if (length > best) {
      best = length;
      angle = Math.atan2(dy, dx);
    }
  }
  return angle;
}

/** Плиточный value noise size×size со стороной ячейки size/cells, значения 0..1. */
export function valueNoise(size: number, cells: number, seed: number): Float32Array {
  const grid = Float32Array.from({ length: cells * cells }, (_, i) => random01(seed * 7919 + i));
  const at = (cx: number, cy: number) => grid[((cy + cells) % cells) * cells + ((cx + cells) % cells)]!;
  const out = new Float32Array(size * size);
  const step = size / cells;
  for (let py = 0; py < size; py++) {
    const gy = py / step;
    const y0 = Math.floor(gy);
    const ty = smooth(gy - y0);
    for (let px = 0; px < size; px++) {
      const gx = px / step;
      const x0 = Math.floor(gx);
      const tx = smooth(gx - x0);
      const top = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx;
      const bottom = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx;
      out[py * size + px] = top * (1 - ty) + bottom * ty;
    }
  }
  return out;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

type Rgba = [number, number, number, number];

/** Узор из шума: пиксель → цвет с прозрачностью. */
function noiseCanvas(size: number, octaves: [number, number][], seed: number, color: (n: number) => Rgba): HTMLCanvasElement {
  const fields = octaves.map(([cells], i) => valueNoise(size, cells, seed + i));
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  const image = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    let n = 0;
    octaves.forEach(([, weight], k) => (n += fields[k]![i]! * weight));
    image.data.set(color(n), i * 4);
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/** Светлое — сухая трава, тёмное — сочная (strength — сила по краям шкалы). */
const lightDark =
  (light: [number, number, number], dark: [number, number, number], strength: number, mid = 0.5): ((n: number) => Rgba) =>
  (n) =>
    n > mid
      ? [...light, Math.round(Math.min((n - mid) * 2.2, 1) * strength * 255)]
      : [...dark, Math.round(Math.min((mid - n) * 2.2, 1) * strength * 255)];

/** Травинки и цветы вблизи: короткие штрихи разных оттенков, изредка белые и жёлтые точки. */
function bladesCanvas(size: number, seed: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  const colors = ['rgba(52,84,30,0.55)', 'rgba(70,104,38,0.5)', 'rgba(150,170,80,0.45)', 'rgba(200,205,130,0.35)'];
  ctx.lineCap = 'round';
  for (let i = 0; i < 2600; i++) {
    const r = (k: number) => random01(seed * 104729 + i * 7 + k);
    const x = r(0) * size;
    const y = r(1) * size;
    const angle = r(2) * Math.PI * 2;
    const length = 3 + r(3) * 6;
    ctx.strokeStyle = colors[Math.floor(r(4) * colors.length)]!;
    ctx.lineWidth = 1 + r(5);
    // Рисуем с переносом за край — узор бесшовный.
    for (const [ox, oy] of [[0, 0], [-size, 0], [0, -size], [-size, -size]] as const) {
      ctx.beginPath();
      ctx.moveTo(x + ox, y + oy);
      ctx.lineTo(x + ox + Math.cos(angle) * length, y + oy + Math.sin(angle) * length);
      ctx.stroke();
    }
  }
  const flowers = ['rgba(250,250,240,0.85)', 'rgba(245,215,80,0.85)', 'rgba(200,150,220,0.7)'];
  for (let i = 0; i < 40; i++) {
    const r = (k: number) => random01(seed * 7727 + i * 5 + k);
    ctx.fillStyle = flowers[Math.floor(r(0) * flowers.length)]!;
    ctx.beginPath();
    ctx.arc(r(1) * size, r(2) * size, 1.6 + r(3) * 1.2, 0, Math.PI * 2);
    ctx.fill();
  }
  return canvas;
}

/** Тротуарная плитка: «вперевязку», швы чуть темнее, у каждой плитки свой тон. Пиксель — 1/128 м. */
function pavingCanvas(seed: number): HTMLCanvasElement {
  const size = 128; // 1 м: плитка 0,5 × 0,25 м
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  const tileW = 64;
  const tileH = 32;
  for (let row = 0; row < size / tileH; row++) {
    const shift = row % 2 ? tileW / 2 : 0;
    for (let col = -1; col <= size / tileW; col++) {
      const x = col * tileW + shift;
      const tone = random01(seed + row * 17 + col * 3) * 0.2 - 0.1;
      ctx.fillStyle = tone > 0 ? `rgba(255,255,250,${tone})` : `rgba(40,35,30,${-tone})`;
      ctx.fillRect(x, row * tileH, tileW, tileH);
      ctx.strokeStyle = 'rgba(70,64,56,0.8)';
      ctx.lineWidth = 3.5;
      ctx.strokeRect(x, row * tileH, tileW, tileH);
    }
  }
  return canvas;
}

function buildLayers() {
  return {
    grass: [
      // ~200–500 м: пятна выгоревшей и сочной травы
      { canvas: noiseCanvas(128, [[8, 0.7], [19, 0.3]], 11, lightDark([221, 211, 150], [78, 112, 52], 0.25)), metres: 4, alpha: 1 },
      // ~10–60 м: кочки и проплешины
      { canvas: noiseCanvas(256, [[64, 0.5], [16, 0.5]], 21, lightDark([236, 232, 180], [44, 70, 30], 0.22, 0.52)), metres: 0.6, alpha: 1 },
      // ~1–5 м: пучки травы
      { canvas: noiseCanvas(256, [[128, 0.6], [32, 0.4]], 31, lightDark([214, 220, 150], [40, 66, 26], 0.3, 0.52)), metres: 0.08, alpha: 1 },
      // вблизи: травинки и цветы
      { canvas: bladesCanvas(256, 41), metres: 0.04, alpha: 0.9 },
    ] as Layer[],
    asphalt: { canvas: noiseCanvas(256, [[128, 0.6], [16, 0.4]], 51, lightDark([150, 152, 156], [40, 42, 46], 0.28)), metres: 0.03, alpha: 1 } as Layer,
    paving: { canvas: pavingCanvas(61), metres: 1 / 128, alpha: 0.9 } as Layer,
    ripples: { canvas: noiseCanvas(256, [[24, 0.6], [96, 0.4]], 71, lightDark([200, 225, 240], [40, 80, 120], 0.22)), metres: 0.15, alpha: 1 } as Layer,
    soil: { canvas: noiseCanvas(256, [[128, 0.6], [24, 0.4]], 81, lightDark([170, 135, 95], [70, 50, 32], 0.35)), metres: 0.03, alpha: 1 } as Layer,
    // Деревенский асфальт: пятна выгоревшего и тёмного (масляного) асфальта — от метров до десятков метров.
    asphaltStains: [
      { canvas: noiseCanvas(128, [[6, 0.7], [17, 0.3]], 91, lightDark([168, 164, 154], [44, 44, 46], 0.3)), metres: 1.6, alpha: 1 },
      { canvas: noiseCanvas(256, [[32, 0.6], [9, 0.4]], 93, lightDark([176, 172, 162], [38, 38, 40], 0.24, 0.52)), metres: 0.12, alpha: 1 },
    ] as Layer[],
    // Гравий обочины.
    gravel: { canvas: noiseCanvas(256, [[128, 0.7], [32, 0.3]], 95, lightDark([200, 192, 172], [96, 88, 74], 0.4)), metres: 0.025, alpha: 1 } as Layer,
    // Трава на обочине асфальта: крупные пятна и кустики (прозрачные между ними — там гравий).
    vergeGrass: [
      { canvas: noiseCanvas(128, [[6, 0.6], [16, 0.4]], 99, (n) => (n > 0.5 ? [124, 146, 84, Math.round(Math.min((n - 0.5) * 3.2, 1) * 220)] : [0, 0, 0, 0])), metres: 0.5, alpha: 1 },
      { canvas: noiseCanvas(256, [[48, 0.6], [12, 0.4]], 101, (n) => (n > 0.55 ? [104, 132, 66, Math.round(Math.min((n - 0.55) * 4, 1) * 200)] : [0, 0, 0, 0])), metres: 0.05, alpha: 1 },
    ] as Layer[],
    // Кустики травы на грунтовке.
    grassTufts: { canvas: noiseCanvas(256, [[48, 0.6], [12, 0.4]], 97, (n) => (n > 0.66 ? [96, 122, 62, Math.round(Math.min((n - 0.66) * 4, 1) * 150)] : [0, 0, 0, 0])), metres: 0.06, alpha: 1 } as Layer,
  };
}
