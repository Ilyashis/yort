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
  let center: Vector3;
  let pitch: number;
  let distance: number;
  if (focus) {
    const [x, y] = focus.center;
    center = new Vector3(x, heightAt(x, y), -y);
    // Не дальше 900 м: дальше деревню съедает дымка.
    pitch = 42;
    distance = Math.min(900, Math.max(350, focus.radius * 0.9));
  } else {
    const sphere = territorySphere(territory, frame, heightAt);
    center = sphere.center;
    pitch = 35;
    distance = sphere.radius * 1.9;
  }
  city.flyTo(city.orbitPosition(center, 25, pitch, distance), center, duration);
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

/** Камера: где стоит и куда смотрит (координаты three.js). */
export interface CameraPose {
  position: Vector3;
  target: Vector3;
}

/** Дорога для вида заставки: ось в локальных метрах. */
type Line = readonly (readonly [number, number])[];

/**
 * Вид заставки — как с дрона вдоль главной улицы: камера над дорогой у края деревни, взгляд — вдоль неё,
 * через дома к холмам. Улица — самая длинная из проходящих рядом с серединой деревни; сторона — та, откуда
 * дома впереди. Нет дорог — обычный наклонный вид.
 */
export function introLanding(focus: Focus, roads: readonly Line[], houses: readonly (readonly [number, number])[], heightAt: HeightAt): CameraPose | undefined {
  const [cx, cy] = focus.center;
  const near = Math.max(120, focus.radius * 0.35);
  let best: { score: number; px: number; py: number; dx: number; dy: number } | undefined;
  for (const line of roads) {
    let length = 0;
    for (let i = 1; i < line.length; i++) length += Math.hypot(line[i]![0] - line[i - 1]![0], line[i]![1] - line[i - 1]![1]);
    if (length < 250) continue;
    for (let i = 1; i < line.length; i++) {
      const [ax, ay] = line[i - 1]!;
      const [bx, by] = line[i]!;
      const sx = bx - ax;
      const sy = by - ay;
      const l2 = sx * sx + sy * sy;
      if (l2 < 1) continue;
      const t = Math.max(0, Math.min(1, ((cx - ax) * sx + (cy - ay) * sy) / l2));
      const px = ax + sx * t;
      const py = ay + sy * t;
      const d = Math.hypot(cx - px, cy - py);
      if (d > near) continue;
      // Ближе к середине и длиннее — лучше.
      const score = d - length * 0.15;
      if (!best || score < best.score) {
        const l = Math.sqrt(l2);
        best = { score, px, py, dx: sx / l, dy: sy / l };
      }
    }
  }
  if (!best) return undefined;
  let { dx, dy } = best;
  // Дома должны быть впереди: смотрим туда, где их больше.
  const ahead = houses.reduce((sum, [x, y]) => sum + Math.sign((x - best!.px) * dx + (y - best!.py) * dy), 0);
  if (ahead < 0) {
    dx = -dx;
    dy = -dy;
  }
  const back = Math.max(220, focus.radius * 0.5);
  const camX = best.px - dx * back;
  const camY = best.py - dy * back;
  const lookX = best.px + dx * back * 0.7;
  const lookY = best.py + dy * back * 0.7;
  const height = 30 + back * 0.2;
  return {
    position: new Vector3(camX, heightAt(camX, camY) + height, -camY),
    target: new Vector3(lookX, heightAt(lookX, lookY), -lookY),
  };
}

/**
 * Прилёт заставки: камера идёт от дальнего вида к виду заставки по мере загрузки (progress — 0…1),
 * плавно догоняя. Вид заставки задаётся, когда известны дома и улицы (land). Дошли до конца — анимация снята.
 */
export function startIntroFlight(city: CityScene, progress: () => number): { land: (pose: CameraPose) => void; destroy: () => void } {
  const start: CameraPose = { position: city.camera.position.clone(), target: city.target.clone() };
  let end: CameraPose | undefined;
  let shown = 0;
  let removed = false;
  const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
  const remove = city.addAnimator((rawDt) => {
    if (!end) return false;
    const dt = Math.min(rawDt, 0.1);
    // Первые 20% — рельеф ещё грузится, камера ждёт.
    const goal = Math.max(0, Math.min(1, (progress() - 0.2) / 0.8));
    shown += (goal - shown) * Math.min(1, dt * (goal >= 1 ? 1.6 : 2.2));
    if (goal >= 1 && 1 - shown < 0.002) shown = 1;
    const e = ease(shown);
    city.camera.position.lerpVectors(start.position, end.position, e);
    city.target.lerpVectors(start.target, end.target, e);
    city.camera.lookAt(city.target);
    city.requestRender();
    if (shown === 1) stop();
    return true;
  });
  const stop = () => {
    if (removed) return;
    removed = true;
    remove();
  };
  return {
    land: (pose) => {
      end = pose;
      // Начало — сзади и выше вида заставки, вдоль той же улицы: камера спускается к деревне по дороге.
      if (shown === 0) {
        const along = pose.target.clone().sub(pose.position).setY(0).normalize();
        start.position.copy(pose.position).addScaledVector(along, -1800);
        start.position.y += 900;
        start.target.copy(pose.target);
        city.setView(start.position, start.target);
      }
    },
    destroy: stop,
  };
}
