import type { BaseBuildingFeature } from '../base/types';
import {
  distanceToRing,
  insidePolygon,
  toLocalPolygon,
  type LocalFrame,
  type LocalPolygon,
  type Vec2,
} from './localFrame';

export interface ColliderOptions {
  /** «Толщина» пешехода, м: ближе к стене подойти нельзя. */
  radius: number;
  /** Под зданиями с низом выше этой отметки (арки, навесы) можно пройти, м. */
  walkUnderHeight: number;
  /** Максимальный шаг проверки, м: быстрый бег не «проскакивает» сквозь стены. */
  maxStep: number;
}

const DEFAULTS: ColliderOptions = { radius: 0.35, walkUnderHeight: 2.2, maxStep: 0.4 };

/** Столкновения пешехода со зданиями Base World (в плоскости, по контурам). */
export class Collider {
  private readonly obstacles: LocalPolygon[];
  /** Препятствия, которые меняются во время работы (здания пользователя). */
  private extra: LocalPolygon[] = [];
  private readonly options: ColliderOptions;

  constructor(
    buildings: readonly BaseBuildingFeature[],
    private readonly frame: LocalFrame,
    options: Partial<ColliderOptions> = {},
  ) {
    this.options = { ...DEFAULTS, ...options };
    this.obstacles = this.toObstacles(buildings);
  }

  setExtraObstacles(buildings: readonly BaseBuildingFeature[]): void {
    this.extra = this.toObstacles(buildings);
  }

  isBlocked(point: Vec2): boolean {
    const [x, y] = point;
    const r = this.options.radius;
    for (const o of [...this.obstacles, ...this.extra]) {
      if (x < o.minX - r || x > o.maxX + r || y < o.minY - r || y > o.maxY + r) continue;
      if (insidePolygon(point, o)) return true;
      if (o.rings.some((ring) => distanceToRing(point, ring) < r)) return true;
    }
    return false;
  }

  /**
   * Сдвигает пешехода на delta с учётом стен: упёрся — скользит вдоль стены.
   * Если стартовая точка уже внутри здания, движение свободное — чтобы можно было выйти.
   */
  move(from: Vec2, delta: Vec2): Vec2 {
    const length = Math.hypot(delta[0], delta[1]);
    const steps = Math.max(1, Math.ceil(length / this.options.maxStep));
    const step: Vec2 = [delta[0] / steps, delta[1] / steps];
    let position = from;
    for (let i = 0; i < steps; i++) position = this.step(position, step);
    return position;
  }

  private toObstacles(buildings: readonly BaseBuildingFeature[]): LocalPolygon[] {
    return buildings
      .filter((b) => b.properties.minHeight < this.options.walkUnderHeight)
      .flatMap((b) => (b.geometry.type === 'Polygon' ? [b.geometry.coordinates] : b.geometry.coordinates))
      .map((rings) => toLocalPolygon(rings, this.frame));
  }

  private step([x, y]: Vec2, [dx, dy]: Vec2): Vec2 {
    const target: Vec2 = [x + dx, y + dy];
    if (this.isBlocked([x, y])) return target;
    if (!this.isBlocked(target)) return target;
    if (dx !== 0 && !this.isBlocked([x + dx, y])) return [x + dx, y];
    if (dy !== 0 && !this.isBlocked([x, y + dy])) return [x, y + dy];
    return [x, y];
  }
}
