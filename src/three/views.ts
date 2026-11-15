// Готовые ракурсы камеры: вид издалека при загрузке, пролёт к району, крупный план участка.

import { MathUtils, Vector3 } from 'three';
import type { Territory } from '../config/territory';
import type { LonLat } from '../world/user/plot';
import type { LocalFrame } from '../world/walk/localFrame';
import type { CityScene } from './CityScene';

type HeightAt = (x: number, y: number) => number;

/** Центр района на земле и «радиус» (до угла) в метрах. */
function territorySphere(territory: Territory, frame: LocalFrame, heightAt: HeightAt): { center: Vector3; radius: number } {
  const { south, west } = territory.bbox;
  const [cx, cy] = [0, 0];
  const [wx, sy] = frame.toLocal([west, south]);
  return { center: new Vector3(cx, heightAt(cx, cy), -cy), radius: Math.hypot(wx - cx, sy - cy) };
}

/** Вид издалека, с юго-запада, пока грузятся данные. */
export function setIntroView(city: CityScene, territory: Territory, frame: LocalFrame, heightAt: HeightAt): void {
  const { center } = territorySphere(territory, frame, heightAt);
  city.setView(city.orbitPosition(center, 25, 38, 14_000), center);
}

/** Где жильё в районе: середина и радиус, м (локальные). Для деревни вид — на неё, а не на весь прямоугольник данных. */
export interface Focus {
  center: [number, number];
  radius: number;
}

/** Наклонный вид на район с юго-запада (у деревни — на сами дома: иначе с 4 км видна только дымка). */
export function flyToTerritory(city: CityScene, territory: Territory, frame: LocalFrame, heightAt: HeightAt, duration = 1.5, focus?: Focus): void {
  if (focus) {
    const [x, y] = focus.center;
    const center = new Vector3(x, heightAt(x, y), -y);
    // Не дальше 900 м: дальше деревню съедает дымка.
    city.flyTo(city.orbitPosition(center, 25, 42, Math.min(900, Math.max(350, focus.radius * 0.9))), center, duration);
    return;
  }
  const { center, radius } = territorySphere(territory, frame, heightAt);
  city.flyTo(city.orbitPosition(center, 25, 35, radius * 1.9), center, duration);
}

/** Где дома (середина и радиус, отбросив 5% самых дальних). */
export function focusOf(points: readonly (readonly [number, number])[]): Focus | undefined {
  if (!points.length) return undefined;
  const cx = points.reduce((s, p) => s + p[0], 0) / points.length;
  const cy = points.reduce((s, p) => s + p[1], 0) / points.length;
  const d = points.map(([x, y]) => Math.hypot(x - cx, y - cy)).sort((a, b) => a - b);
  return { center: [cx, cy], radius: d[Math.floor(d.length * 0.95)] ?? 0 };
}

/**
 * Наклонный вид на участок с запасом по высоте под будущее здание.
 * sidebarShare — доля ширины экрана, закрытая панелью слева: участок сдвигаем в свободную часть.
 */
export function flyToArea(
  city: CityScene,
  points: readonly LonLat[],
  frame: LocalFrame,
  heightAt: HeightAt,
  expectedHeight = 30,
  sidebarShare = 0,
): void {
  if (!points.length) return;
  const local = points.map(frame.toLocal);
  const cx = local.reduce((s, p) => s + p[0], 0) / local.length;
  const cy = local.reduce((s, p) => s + p[1], 0) / local.length;
  const radius = Math.max(...local.map(([x, y]) => Math.hypot(x - cx, y - cy)), 25) + expectedHeight;
  const range = radius * 2.6;
  const target = new Vector3(cx, heightAt(cx, cy) + expectedHeight / 2, -cy);
  const position = city.orbitPosition(target, city.heading(), 28, range);
  // Видимая ширина на расстоянии range; сдвигаем на половину ширины панели (камеру — влево).
  const hfov = 2 * Math.atan(Math.tan(MathUtils.degToRad(city.camera.fov) / 2) * city.camera.aspect);
  const shift = (2 * range * Math.tan(hfov / 2) * sidebarShare) / 2;
  const h = MathUtils.degToRad(city.heading());
  const left = new Vector3(-Math.cos(h), 0, -Math.sin(h)).multiplyScalar(shift);
  city.flyTo(position.add(left), target.clone().add(left), 1.2);
}
