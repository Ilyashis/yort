// Машина без 3D-движка: простая «аркадная» физика (велосипедная модель поворота, разгон, торможение,
// накат, задний ход), где стоят колёса, круги для столкновений, обороты мотора для звука
// и постановка машины на ближайшую дорогу. Оси — локальные метры района: x — восток, y — север;
// курс — от севера по часовой, рад (вперёд = (sin, cos)).

import type { Vec2 } from '../walk/localFrame';

export const CAR = {
  /** Габариты кузова и колёс, м. */
  length: 4.1,
  width: 1.76,
  wheelbase: 2.55,
  track: 1.5,
  wheelRadius: 0.33,
  /** Скорость, м/с: обычная (60 км/ч), с Shift (90 км/ч), задним ходом. */
  maxSpeed: 16.7,
  fastSpeed: 25,
  reverseSpeed: 5.5,
  /** Ускорения, м/с². */
  accel: 3.6,
  fastAccel: 5,
  reverseAccel: 2.6,
  brake: 9,
  handbrake: 11,
  /** Сопротивление качению, м/с², и воздуха, 1/м (× v²). */
  rolling: 0.45,
  drag: 0.0011,
  /** Предельный угол колёс, рад, и боковое ускорение, при котором ещё не заносит, м/с². */
  maxSteer: 0.6,
  grip: 8.5,
  /** Скорость поворота руля, 1/с. */
  steerRate: 5,
  /** Кузов для столкновений — три круга вдоль машины. */
  collisionRadius: 0.95,
  circleOffsets: [-1.2, 0, 1.2],
} as const;

export interface CarState {
  position: Vec2;
  heading: number;
  /** Скорость вдоль кузова, м/с (минус — задний ход). */
  speed: number;
  /** Угол передних колёс, рад (плюс — вправо). */
  steer: number;
}

export interface CarInput {
  /** Газ (+) и тормоз/задний ход (−), −1..1. */
  throttle: number;
  /** Руль: −1 влево … +1 вправо. */
  steer: number;
  handbrake: boolean;
  /** Shift — разрешить ехать быстрее. */
  fast: boolean;
}

export interface Road {
  /** Синус уклона по ходу машины: плюс — в гору. */
  slope: number;
  /** Сцепление: 1 — дорога, меньше — трава и грунт (там и максимальная скорость ниже). */
  grip: number;
}

export interface CarStep extends CarState {
  /** Продольное ускорение за шаг, м/с² (для наклона кузова). */
  accel: number;
  /** Боковое ускорение, м/с² (крен в повороте). */
  lateral: number;
}

const FLAT: Road = { slope: 0, grip: 1 };
const G = 9.81;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const approach = (current: number, target: number, dt: number, rate: number) => target + (current - target) * Math.exp(-rate * dt);

/** Предельный угол колёс на скорости v: на ходу руль «острее» не делаем, чтобы не крутило волчком. */
export function steerLimit(speed: number, grip = 1): number {
  const v2 = Math.max(speed * speed, 0.01);
  return Math.min(CAR.maxSteer, Math.atan((CAR.grip * grip * CAR.wheelbase) / v2));
}

/** Один шаг физики длиной dt секунд (без столкновений — их проверяет тот, кто знает про дома). */
export function stepCar(state: CarState, input: CarInput, dt: number, road: Road = FLAT): CarStep {
  const v = state.speed;
  const top = (input.fast ? CAR.fastSpeed : CAR.maxSpeed) * road.grip;
  const throttle = clamp(input.throttle, -1, 1);

  // Тяга: газ, торможение при движении в обратную сторону, задний ход.
  let drive = 0;
  let braking = false;
  if (throttle > 0) {
    if (v < -0.3) braking = true;
    else drive = (input.fast ? CAR.fastAccel : CAR.accel) * throttle * Math.max(0, 1 - (Math.max(v, 0) / top) ** 2);
  } else if (throttle < 0) {
    if (v > 0.3) braking = true;
    else drive = CAR.reverseAccel * throttle * Math.max(0, 1 - (Math.max(-v, 0) / CAR.reverseSpeed) ** 2);
  }

  // Уклон тянет назад в гору и разгоняет под горку; стоящая без газа машина — на ручнике.
  const parked = Math.abs(v) < 0.05 && throttle === 0;
  const gravity = parked ? 0 : -G * road.slope * 0.7;

  // Сопротивление — против хода: накат (на траве сильнее) и воздух — когда газ отпущен (под газом их
  // уже учитывает кривая тяги), тормоз, ручник, «перебор» скорости.
  const coasting = drive === 0;
  let resist = coasting ? CAR.rolling * (2 - road.grip) + CAR.drag * v * v : 0;
  if (braking) resist += CAR.brake * Math.abs(throttle);
  if (input.handbrake) resist += CAR.handbrake;
  if (Math.abs(v) > top && throttle >= 0) resist += 4;

  let speed = v + (drive + gravity) * dt;
  const stop = resist * dt;
  if (Math.abs(speed) <= stop && (throttle === 0 || braking || input.handbrake)) speed = 0;
  else speed -= Math.sign(speed) * Math.min(stop, Math.abs(speed));
  if (braking && Math.sign(speed) !== Math.sign(v)) speed = 0;

  // Руль: к цели плавно, на месте отпущенный руль возвращается быстрее.
  const target = clamp(input.steer, -1, 1) * steerLimit(speed, road.grip);
  const steer = approach(state.steer, target, dt, input.steer === 0 ? CAR.steerRate * 1.5 : CAR.steerRate);

  // Велосипедная модель: курс меняется пропорционально скорости и тангенсу угла колёс.
  const yawRate = (speed / CAR.wheelbase) * Math.tan(steer);
  const heading = state.heading + yawRate * dt;
  const mid = state.heading + yawRate * dt * 0.5;
  const travelled = ((v + speed) / 2) * dt;
  const position: Vec2 = [state.position[0] + Math.sin(mid) * travelled, state.position[1] + Math.cos(mid) * travelled];

  return { position, heading, speed, steer, accel: (speed - v) / dt, lateral: speed * yawRate };
}

/** Вперёд и вправо по курсу. */
export function axesOf(heading: number): { forward: Vec2; right: Vec2 } {
  const s = Math.sin(heading);
  const c = Math.cos(heading);
  return { forward: [s, c], right: [c, -s] };
}

/** Точки касания колёс: переднее левое, переднее правое, заднее левое, заднее правое. */
export function wheelSpots(position: Vec2, heading: number): [Vec2, Vec2, Vec2, Vec2] {
  const { forward, right } = axesOf(heading);
  const at = (along: number, side: number): Vec2 => [
    position[0] + forward[0] * along + right[0] * side,
    position[1] + forward[1] * along + right[1] * side,
  ];
  const a = CAR.wheelbase / 2;
  const t = CAR.track / 2;
  return [at(a, -t), at(a, t), at(-a, -t), at(-a, t)];
}

/** Центры кругов кузова для столкновений с домами. */
export function bodyCircles(position: Vec2, heading: number): Vec2[] {
  const { forward } = axesOf(heading);
  return CAR.circleOffsets.map((d) => [position[0] + forward[0] * d, position[1] + forward[1] * d] as Vec2);
}

/** Обороты мотора 0..1 и передача — для звука и приборов. */
export function engineState(speed: number, throttle: number): { rpm: number; gear: string } {
  const v = Math.abs(speed);
  if (v < 0.2 && throttle === 0) return { rpm: 0.12, gear: 'N' };
  if (speed < -0.2 || (v < 0.2 && throttle < 0)) return { rpm: 0.15 + 0.7 * Math.min(v / CAR.reverseSpeed, 1) + 0.08 * Math.abs(throttle), gear: 'R' };
  const tops = [5, 9.5, 14, 19.5, 26];
  const index = tops.findIndex((t) => v < t);
  const gear = index < 0 ? tops.length - 1 : index;
  const lo = gear === 0 ? 0 : tops[gear - 1]!;
  const hi = tops[gear]!;
  const fraction = clamp((v - lo) / (hi - lo), 0, 1);
  const base = gear === 0 ? 0.15 : 0.38;
  return { rpm: clamp(base + (0.92 - base) * fraction + 0.06 * Math.max(throttle, 0), 0, 1), gear: String(gear + 1) };
}

/** Разница углов a − b, приведённая к −π…π. */
export function angleDelta(a: number, b: number): number {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

export interface RoadLine {
  coords: Vec2[];
  /** Ширина проезжей части, м. */
  width: number;
  oneway?: boolean;
}

/**
 * Поставить машину на ближайшую дорогу: вдоль оси, по направлению, ближайшему к курсу камеры,
 * на правую полосу (если дорога двусторонняя и широкая). Дальше maxDistance дорог нет — undefined.
 */
export function snapToRoad(
  point: Vec2,
  roads: readonly RoadLine[],
  preferredHeading: number,
  maxDistance = 40,
): { position: Vec2; heading: number } | undefined {
  let best: { distance: number; at: Vec2; heading: number; road: RoadLine } | undefined;
  for (const road of roads) {
    for (let i = 1; i < road.coords.length; i++) {
      const a = road.coords[i - 1]!;
      const b = road.coords[i]!;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const length2 = dx * dx + dy * dy;
      if (length2 < 1e-6) continue;
      const t = clamp(((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length2, 0, 1);
      const at: Vec2 = [a[0] + dx * t, a[1] + dy * t];
      const distance = Math.hypot(point[0] - at[0], point[1] - at[1]);
      if (distance <= maxDistance && (!best || distance < best.distance)) {
        best = { distance, at, heading: Math.atan2(dx, dy), road };
      }
    }
  }
  if (!best) return undefined;
  let heading = best.heading;
  if (!best.road.oneway && Math.abs(angleDelta(heading, preferredHeading)) > Math.PI / 2) heading += Math.PI;
  heading = Math.atan2(Math.sin(heading), Math.cos(heading));
  const lane = !best.road.oneway && best.road.width >= 6 ? best.road.width / 4 : 0;
  const { right } = axesOf(heading);
  return { position: [best.at[0] + right[0] * lane, best.at[1] + right[1] * lane], heading };
}
