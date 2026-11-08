// Машина из простых частей (как дома): небольшой кроссовер-хэтчбек обобщённого вида, без марки.
// Оси машины: x — вправо, y — вперёд, z — вверх от земли; центр — посередине между осями колёс.
// Части разложены по материалам: кузов и пластик, стёкла, фары, задние фонари; колесо — отдельно
// (одно, в центре своей оси) — его крутят и поворачивают при езде.

import type { BoxPart, CylinderPart, HousePart, SlabPart, Vec3 } from '../village/houseParts';
import { CAR } from './car';

export interface CarParts {
  body: HousePart[];
  glass: HousePart[];
  headlights: HousePart[];
  taillights: HousePart[];
  /** Одно колесо с центром в (0, 0, 0), ось — вдоль x. */
  wheel: HousePart[];
}

/** Цвета кузова на выбор (название — для подсказки). */
export const CAR_COLORS: { color: string; name: string }[] = [
  { color: '#f2f1ec', name: 'белая' },
  { color: '#9c1f24', name: 'вишнёвая' },
  { color: '#2f5f8a', name: 'синяя' },
  { color: '#3f6b45', name: 'зелёная' },
  { color: '#b9bcbf', name: 'серебристая' },
];

const TRIM = '#26282b';
const TYRE = '#1b1c1e';
const RIM = '#a9aeb3';
const GLASS = '#22303a';

const box = (center: Vec3, size: Vec3, color: string): BoxPart => ({ type: 'box', center, size, color });

/** Профиль сбоку (y, z) → плита на плоскости x, лицом наружу (+x справа, −x слева). */
function sideSlab(profile: [number, number][], x: number, thickness: number, color: string): SlabPart {
  const points = profile.map(([y, z]) => [x, y, z] as Vec3);
  // Обход против часовой, если смотреть с +x: нормаль — +x. Для левой стороны — наоборот.
  return { type: 'slab', points: x >= 0 ? points : points.reverse(), thickness, color };
}

/** Наклонное стекло между двумя точками профиля (y, z) поперёк машины шириной w, лицом наружу: out — вперёд (+1) или назад (−1). */
function slopedPane(lower: [number, number], upper: [number, number], w: number, out: 1 | -1): SlabPart {
  const dy = upper[0] - lower[0];
  const dz = upper[1] - lower[1];
  const length = Math.hypot(dy, dz);
  let n: [number, number] = [dz / length, -dy / length];
  if (n[0] * out < 0) n = [-n[0], -n[1]];
  // Чуть наружу от кузова, чтобы стекло не «мерцало» вместе с ним.
  const e = 0.012;
  const at = ([y, z]: [number, number], x: number): Vec3 => [x, y + n[0] * e, z + n[1] * e];
  const points: Vec3[] = [at(lower, -w / 2), at(lower, w / 2), at(upper, w / 2), at(upper, -w / 2)];
  const normal = cross(sub(points[1]!, points[0]!), sub(points[3]!, points[0]!));
  const outward = normal[1] * n[0] + normal[2] * n[1] >= 0;
  return { type: 'slab', points: outward ? points : points.reverse(), thickness: 0.02, color: GLASS };
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export function carParts(paint: string): CarParts {
  const W = CAR.width;
  const L = CAR.length;
  const half = L / 2;
  const axle = CAR.wheelbase / 2;
  const arch = 0.8;
  const sill = 0.3; // низ кузова
  const belt = 0.62; // верх арок
  const shoulder = 0.93; // линия окон
  const body: HousePart[] = [];
  const glass: HousePart[] = [];

  // Нижняя часть кузова: верхний пояс во всю длину и низ между арками колёс (колёса видны в арках).
  body.push(box([0, 0, (belt + shoulder) / 2], [W, L, shoulder - belt], paint));
  const lowerZ = (sill + belt) / 2;
  const lowerH = belt - sill;
  const front0 = axle + arch / 2;
  const between = axle - arch / 2;
  body.push(box([0, (front0 + half) / 2, lowerZ], [W, half - front0, lowerH], paint));
  body.push(box([0, 0, lowerZ], [W, 2 * between, lowerH], paint));
  body.push(box([0, -(front0 + half) / 2, lowerZ], [W, half - front0, lowerH], paint));
  // Тёмные ниши арок (изнутри над колесом) и пороги.
  for (const y of [axle, -axle]) body.push(box([0, y, belt - 0.02], [W - 0.12, arch, 0.08], TRIM));
  for (const s of [1, -1]) body.push(box([s * (W / 2 - 0.01), 0, sill + 0.05], [0.04, 2 * between, 0.1], TRIM));

  // Салон: призма по профилю сбоку, чуть уже кузова; капот — короткий скос впереди.
  const cabinW = W - 0.2;
  const profile: [number, number][] = [
    [-half + 0.06, shoulder],
    [0.98, shoulder],
    [0.16, 1.5],
    [-1.6, 1.54],
    [-half + 0.1, 1.32],
  ];
  body.push(sideSlab(profile, cabinW / 2, cabinW, paint));
  body.push(sideSlab([[1.02, shoulder - 0.01], [half - 0.04, shoulder - 0.01], [half - 0.04, shoulder + 0.03], [1.02, shoulder + 0.07]], W / 2 - 0.03, W - 0.06, paint));

  // Боковые стёкла: переднее и заднее на каждой стороне (стойка между ними — кузов).
  const frontWindow: [number, number][] = [
    [-0.62, shoulder + 0.06],
    [0.82, shoulder + 0.06],
    [0.17, 1.45],
    [-0.62, 1.47],
  ];
  const rearWindow: [number, number][] = [
    [-1.82, shoulder + 0.06],
    [-0.74, shoulder + 0.06],
    [-0.74, 1.47],
    [-1.56, 1.49],
    [-1.86, 1.3],
  ];
  for (const s of [1, -1]) {
    const x = s * (cabinW / 2 + 0.008);
    glass.push(sideSlab(frontWindow, x, 0.02, GLASS), sideSlab(rearWindow, x, 0.02, GLASS));
  }
  glass.push(slopedPane([0.937, 0.96], [0.203, 1.47], cabinW - 0.16, 1));
  glass.push(slopedPane([-1.983, 1.0], [-1.953, 1.29], cabinW - 0.24, -1));

  // Бамперы, решётка, номера, ручки, зеркала, рейлинги.
  body.push(box([0, half + 0.02, 0.43], [W + 0.02, 0.14, 0.22], TRIM));
  body.push(box([0, -half - 0.02, 0.43], [W + 0.02, 0.14, 0.22], TRIM));
  body.push(box([0, half + 0.005, 0.76], [0.72, 0.04, 0.17], TRIM));
  body.push(box([0, half + 0.1, 0.43], [0.52, 0.02, 0.12], '#f4f4f0'));
  body.push(box([0, -half - 0.012, 0.62], [0.52, 0.02, 0.12], '#f4f4f0'));
  for (const s of [1, -1]) {
    body.push(box([s * (W / 2 + 0.005), 0.25, 0.86], [0.02, 0.14, 0.03], TRIM));
    body.push(box([s * (W / 2 + 0.005), -0.85, 0.86], [0.02, 0.14, 0.03], TRIM));
    body.push(box([s * (cabinW / 2 + 0.1), 0.8, 1.04], [0.17, 0.09, 0.12], paint));
    body.push(box([s * (cabinW / 2 - 0.12), -0.72, 1.565], [0.05, 1.6, 0.04], TRIM));
  }

  // Фары и задние фонари — отдельным материалом (светятся вечером, стоп-сигналы — при торможении).
  const headlights: HousePart[] = [];
  const taillights: HousePart[] = [];
  for (const s of [1, -1]) {
    headlights.push(box([s * 0.6, half + 0.005, 0.79], [0.38, 0.04, 0.14], '#f3efe2'));
    taillights.push(box([s * 0.68, -half - 0.005, 0.8], [0.32, 0.04, 0.17], '#9e1a1c'));
  }

  // Колесо: шина, диск чуть шире (видны его торцы) и спицы — чтобы было видно, как оно крутится.
  const r = CAR.wheelRadius;
  const wheel: HousePart[] = [
    { type: 'cylinder', from: [-0.11, 0, 0], to: [0.11, 0, 0], radius: r, segments: 18, color: TYRE, caps: TYRE } satisfies CylinderPart,
    { type: 'cylinder', from: [-0.116, 0, 0], to: [0.116, 0, 0], radius: 0.2, segments: 14, color: RIM, caps: RIM } satisfies CylinderPart,
  ];
  for (const side of [1, -1]) {
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      wheel.push({
        type: 'cylinder',
        from: [side * 0.118, 0, 0],
        to: [side * 0.118, Math.cos(a) * 0.17, Math.sin(a) * 0.17],
        radius: 0.022,
        segments: 5,
        color: '#5d6166',
        caps: false,
      });
    }
  }

  return { body, glass, headlights, taillights, wheel };
}
