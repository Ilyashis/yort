// Чистая математика управления (без Cesium) — легко тестировать.

/** Оси движения с клавиатуры: forward (+ вперёд), right (+ вправо), turn (+ по часовой), zoom (+ ближе). */
export interface InputAxes {
  forward: number;
  right: number;
  turn: number;
  zoom: number;
}

type Axis = keyof InputAxes;

/** Раскладка по физическим кодам клавиш (event.code) — работает и в русской раскладке. */
export type KeyMap = Record<string, [Axis, number]>;

/** Вид сверху: WASD/стрелки двигают, Q/E поворачивают, R/F и +/− приближают. */
export const OVERVIEW_KEYS: KeyMap = {
  KeyW: ['forward', 1],
  ArrowUp: ['forward', 1],
  KeyS: ['forward', -1],
  ArrowDown: ['forward', -1],
  KeyA: ['right', -1],
  ArrowLeft: ['right', -1],
  KeyD: ['right', 1],
  ArrowRight: ['right', 1],
  KeyQ: ['turn', -1],
  KeyE: ['turn', 1],
  KeyR: ['zoom', 1],
  Equal: ['zoom', 1],
  NumpadAdd: ['zoom', 1],
  KeyF: ['zoom', -1],
  Minus: ['zoom', -1],
  NumpadSubtract: ['zoom', -1],
};

/** Прогулка: WASD — идти и шагать вбок, стрелки ←/→ и Q/E — поворот (удобно с тачпадом). */
export const WALK_KEYS: KeyMap = {
  KeyW: ['forward', 1],
  ArrowUp: ['forward', 1],
  KeyS: ['forward', -1],
  ArrowDown: ['forward', -1],
  KeyA: ['right', -1],
  KeyD: ['right', 1],
  KeyQ: ['turn', -1],
  ArrowLeft: ['turn', -1],
  KeyE: ['turn', 1],
  ArrowRight: ['turn', 1],
};

export function axesFrom(pressed: Iterable<string>, keys: KeyMap): InputAxes {
  const axes: InputAxes = { forward: 0, right: 0, turn: 0, zoom: 0 };
  for (const code of pressed) {
    const binding = keys[code];
    if (binding) axes[binding[0]] += binding[1];
  }
  for (const axis of Object.keys(axes) as Axis[]) axes[axis] = Math.max(-1, Math.min(1, axes[axis]));
  return axes;
}

export const isShift = (pressed: ReadonlySet<string>) => pressed.has('ShiftLeft') || pressed.has('ShiftRight');

/**
 * Скорость сдвига камеры над городом, м/с: пропорциональна высоте над землёй —
 * низко двигаемся аккуратно, высоко — быстро. Shift ускоряет в 3 раза.
 */
export function panSpeed(heightAboveGround: number, fast: boolean): number {
  const base = Math.min(Math.max(heightAboveGround * 0.9, 12), 2500);
  return fast ? base * 3 : base;
}

/**
 * Плавное приближение значения к цели (разгон/торможение без рывков), не зависит от частоты кадров.
 * rate — «жёсткость», 1/с: чем больше, тем быстрее догоняет.
 */
export function approach(current: number, target: number, dt: number, rate: number): number {
  return target + (current - target) * Math.exp(-rate * dt);
}
