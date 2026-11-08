// Мини-карта: план района на 2D-холсте — газоны, вода, площади, дороги и дома из тех же данных OSM,
// что и сцена. Карта повёрнута по курсу (вперёд — всегда вверх), в центре — стрелка пешехода или машины,
// на ободе — «С» (север). Пути (Path2D) строятся один раз в локальных метрах, каждый кадр рисуются
// только те, что попадают в круг обзора.

import { polygonsOfGround, type GroundFeature, type GroundKind } from '../base/environment';
import type { BaseBuildingFeature } from '../base/types';
import type { LonLat } from '../user/plot';
import type { LocalFrame, Vec2 } from '../walk/localFrame';

/** Кто рисует мини-карту (регистрирует сцена, вызывает интерфейс). */
export interface MinimapSource {
  /** size — сторона холста в CSS-пикселях, zoom — масштаб пользователя (1 — обычный, больше — крупнее). */
  draw(ctx: CanvasRenderingContext2D, size: number, dpr: number, zoom: number): void;
}

export interface MinimapView {
  center: Vec2;
  /** Курс, рад от севера по часовой: эта сторона — вверху карты. */
  heading: number;
  /** Сколько метров от центра до края карты. */
  radius: number;
  /** На машине — стрелка-машина, пешком — стрелка-человек. */
  marker: 'car' | 'walker';
}

type Layer = 'meadow' | 'green' | 'wood' | 'pitch' | 'water' | 'paving' | 'road' | 'footway' | 'building';

const STYLE: Record<Layer, { fill: string; stroke?: string }> = {
  meadow: { fill: '#dfe8c6' },
  green: { fill: '#c8dea9' },
  wood: { fill: '#afcf93' },
  pitch: { fill: '#bfe0a3' },
  water: { fill: '#9fc8e8', stroke: '#86b5d9' },
  paving: { fill: '#ebe6dc' },
  road: { fill: '#fffdf8', stroke: '#d4c9b4' },
  footway: { fill: '#f1e9d8' },
  building: { fill: '#dccdb6', stroke: '#b09d82' },
};
const ORDER: Layer[] = ['meadow', 'green', 'wood', 'pitch', 'water', 'paving', 'road', 'footway', 'building'];
const BACKGROUND = { city: '#eceee4', village: '#e5e9d3' };

const LAYER_OF: Partial<Record<GroundKind, Layer>> = {
  green: 'green',
  pitch: 'pitch',
  water: 'water',
  parking: 'paving',
  paving: 'paving',
  sidewalk: 'paving',
  road: 'road',
  footway: 'footway',
};

interface Shape {
  path: Path2D;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export class MinimapBase {
  private readonly layers = new Map<Layer, Shape[]>();

  constructor(
    ground: readonly GroundFeature[],
    buildings: readonly BaseBuildingFeature[],
    private readonly frame: LocalFrame,
    private readonly village: boolean,
  ) {
    for (const feature of ground) {
      let layer = LAYER_OF[feature.properties.kind];
      if (!layer) continue;
      if (layer === 'green' && feature.properties.cover) layer = feature.properties.cover;
      for (const rings of polygonsOfGround(feature)) this.add(layer, rings);
    }
    for (const b of buildings) {
      const polygons = b.geometry.type === 'Polygon' ? [b.geometry.coordinates] : b.geometry.coordinates;
      for (const rings of polygons) this.add('building', rings);
    }
  }

  draw(ctx: CanvasRenderingContext2D, px: number, view: MinimapView): void {
    const { center, heading, radius } = view;
    const scale = px / 2 / radius;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.village ? BACKGROUND.village : BACKGROUND.city;
    ctx.fillRect(0, 0, px, px);

    // Холст: x — восток, y — вниз (юг); вперёд по курсу — вверх.
    ctx.translate(px / 2, px / 2);
    ctx.rotate(-heading);
    ctx.scale(scale, scale);
    ctx.translate(-center[0], center[1]);
    const reach = radius * Math.SQRT2;
    const [x0, x1, y0, y1] = [center[0] - reach, center[0] + reach, center[1] - reach, center[1] + reach];
    ctx.lineJoin = 'round';
    for (const layer of ORDER) {
      const style = STYLE[layer];
      ctx.fillStyle = style.fill;
      ctx.strokeStyle = style.stroke ?? style.fill;
      ctx.lineWidth = (layer === 'road' ? 1.6 : 1) / scale;
      for (const s of this.layers.get(layer) ?? []) {
        if (s.maxX < x0 || s.minX > x1 || s.maxY < y0 || s.minY > y1) continue;
        ctx.fill(s.path, 'evenodd');
        if (style.stroke) ctx.stroke(s.path);
      }
    }

    // Стрелка в центре и «С» на ободе.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const c = px / 2;
    const u = px / 100;
    ctx.save();
    ctx.translate(c, c);
    ctx.beginPath();
    if (view.marker === 'car') {
      ctx.moveTo(0, -5.2 * u);
      ctx.lineTo(3.6 * u, 4 * u);
      ctx.lineTo(0, 2.2 * u);
      ctx.lineTo(-3.6 * u, 4 * u);
    } else {
      ctx.moveTo(0, -4 * u);
      ctx.lineTo(2.8 * u, 3 * u);
      ctx.lineTo(0, 1.6 * u);
      ctx.lineTo(-2.8 * u, 3 * u);
    }
    ctx.closePath();
    ctx.fillStyle = view.marker === 'car' ? '#d2452f' : '#2f6fd2';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.1 * u;
    ctx.stroke();
    ctx.fill();
    ctx.restore();

    const rim = c - 7 * u;
    const nx = c - Math.sin(heading) * rim;
    const ny = c - Math.cos(heading) * rim;
    ctx.beginPath();
    ctx.arc(nx, ny, 5.2 * u, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(32, 38, 46, 0.82)';
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = `600 ${6.4 * u}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('С', nx, ny + 0.3 * u);
  }

  private add(layer: Layer, rings: readonly (readonly LonLat[])[]): void {
    const path = new Path2D();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const ring of rings) {
      ring.forEach((point, i) => {
        const [x, y] = this.frame.toLocal(point as LonLat);
        if (i === 0) path.moveTo(x, -y);
        else path.lineTo(x, -y);
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      });
      path.closePath();
    }
    if (minX > maxX) return;
    const list = this.layers.get(layer) ?? [];
    list.push({ path, minX, minY, maxX, maxY });
    this.layers.set(layer, list);
  }
}

/** Радиус обзора мини-карты, м: пешком — двор и улица, на машине — дальше, и чем быстрее, тем дальше. */
export function minimapRadius(marker: MinimapView['marker'], speed: number, zoom: number): number {
  const base = marker === 'car' ? 110 + Math.min(Math.abs(speed), 25) * 4 : 70;
  return base / zoom;
}
