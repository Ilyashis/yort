// Конная статуя «Салават Юлаев» для сцены: конь, вставший на дыбы, всадник с поднятой камчой,
// развевающийся плащ, хвост коня — третья опора на бронзовом основании. Лепка полем расстояний
// в натуральную величину (конь ~1,6 м в холке); при сборке модель масштабируется до 9,8 м — как у памятника.
// Оси: x — вправо (от коня), y — вперёд (куда смотрит конь), z — вверх; z = 0 — низ основания.
// Это художественная реконструкция по описанию, а не обмер памятника.

import { blend, chain, cone, ellipsoid, ovalSlab, smin, sphere, ssub, waves } from './sdf.mjs';

// --- корпус коня: своя система координат вдоль спины ------------------------------------------
const PITCH = (38 * Math.PI) / 180;
/** Верх крупа — начало «системы спины». */
const CROUP = [0, -0.25, 1.55];
const F = [0, Math.cos(PITCH), Math.sin(PITCH)];
const U = [0, -Math.sin(PITCH), Math.cos(PITCH)];
/** Точка в системе спины: a — вдоль спины вперёд, b — вверх от линии спины, x — вбок. */
const body = (a, b, x = 0) => [x + CROUP[0], CROUP[1] + F[1] * a + U[1] * b, CROUP[2] + F[2] * a + U[2] * b];

const BASE_TOP = 0.08;

// --- конь ---------------------------------------------------------------------------------------
const barrel = ellipsoid(body(0.62, -0.38), [0.33, 0.78, 0.4], F, U);
const hindquarters = ellipsoid(body(0.05, -0.27), [0.36, 0.44, 0.42], F, U);
const haunches = [-1, 1].map((s) => ellipsoid(body(0.12, -0.5, s * 0.15), [0.2, 0.3, 0.3], F, U));
const chest = ellipsoid(body(1.3, -0.44), [0.3, 0.32, 0.4], F, U);
const shoulders = [-1, 1].map((s) => ellipsoid(body(1.18, -0.3, s * 0.13), [0.16, 0.3, 0.34], [0, 0.45, 1], [0, -1, 0.4]));
const belly = ellipsoid(body(0.7, -0.62), [0.28, 0.55, 0.22], F, U);
// Рельеф мышц: грудные, бедренные (над скакательным суставом) и мышцы предплечий.
const pectorals = [-1, 1].map((s) => ellipsoid(body(1.48, -0.55, s * 0.12), [0.13, 0.16, 0.2], F, U));
const gaskins = [-1, 1].map((s) => ellipsoid([s * 0.17, 0.0, 0.84], [0.1, 0.13, 0.2], [0, -0.6, -0.5]));

// Шея: основание у холки, изгиб вверх, затылок над грудью.
const neck = chain(
  [
    [...body(1.42, -0.12), 0.27],
    [0, 1.12, 2.72, 0.19],
    [0, 1.2, 3.02, 0.135],
  ],
  0.08,
);
const neckCrest = ellipsoid([0, 1.02, 2.78], [0.1, 0.36, 0.13], [0, 0.42, 1], [0, -1, 0.3]);
// Голова: лоб → морда, щёки, уши, ноздри и глаза.
const head = cone([0, 1.22, 3.15], [0, 1.62, 2.82], 0.13, 0.085);
const cheeks = ellipsoid([0, 1.3, 3.02], [0.105, 0.16, 0.13], [0, 0.7, -0.6]);
const jaw = cone([0, 1.28, 2.99], [0, 1.56, 2.78], 0.085, 0.055);
const ears = [-1, 1].map((s) => cone([s * 0.06, 1.2, 3.2], [s * 0.085, 1.16, 3.36], 0.035, 0.008));
const forelock = cone([0, 1.22, 3.24], [0.02, 1.33, 3.17], 0.04, 0.025);
const nostrils = [-1, 1].map((s) => sphere([s * 0.05, 1.68, 2.82], 0.024));
const eyes = [-1, 1].map((s) => sphere([s * 0.11, 1.33, 3.1], 0.025));

// Ноги. Задние согнуты под корпусом (на них стоит конь), передние поджаты в воздухе.
const hindLeg = (s, dy) =>
  chain(
    [
      [s * 0.16, 0.26 + dy, 1.2, 0.2],
      [s * 0.17, 0.2 + dy, 0.98, 0.14],
      [s * 0.17, -0.22 + dy, 0.62, 0.075],
      [s * 0.16, -0.02 + dy, 0.24, 0.056],
      [s * 0.16, 0.04 + dy, BASE_TOP + 0.05, 0.058],
      [s * 0.16, 0.09 + dy, BASE_TOP + 0.02, 0.07],
    ],
    0.05,
  );
const frontLeg = (s, elbow, knee, fetlock, hoof) =>
  chain(
    [
      [s * 0.16, 1.1, 2.08, 0.15],
      [s * 0.16, ...elbow, 0.115],
      [s * 0.16, ...knee, 0.075],
      [s * 0.16, ...fetlock, 0.055],
      [s * 0.16, ...hoof, 0.065],
    ],
    0.04,
  );
const legs = [
  hindLeg(-1, 0.06),
  hindLeg(1, -0.04),
  frontLeg(-1, [1.04, 1.74], [1.44, 1.78], [1.33, 1.42], [1.39, 1.3]),
  frontLeg(1, [1.07, 1.7], [1.42, 1.94], [1.4, 1.56], [1.47, 1.46]),
];

// Хвост: от крупа назад и вниз до основания, пряди волной.
const tailCore = chain(
  [
    [0, -0.3, 1.45, 0.08],
    [0.02, -0.6, 1.18, 0.12],
    [0.05, -0.8, 0.66, 0.15],
    [0.07, -0.86, 0.3, 0.17],
    [0.08, -0.84, BASE_TOP, 0.2],
  ],
  0.06,
);
const tail = (x, y, z) => tailCore(x, y, z) + 0.025 * waves(x * 3, y * 1.5, z, 14);

// Грива: прядями по гребню шеи, свисает на правую сторону.
const maneCore = chain(
  [
    [0.05, 1.12, 3.1, 0.06],
    [0.09, 1.0, 2.9, 0.075],
    [0.1, 0.9, 2.66, 0.08],
    [0.08, 0.78, 2.44, 0.07],
  ],
  0.05,
);
const mane = (x, y, z) => maneCore(x, y, z) + 0.012 * waves(z * 4, y * 2, x, 12);

// Чепрак — попона под седлом: тонкая «рубашка» поверх бочки, только под седлом.
const blanketShell = ellipsoid(body(0.62, -0.38), [0.36, 0.81, 0.43], F, U);
const saddleArea = ellipsoid(body(0.85, -0.05), [0.6, 0.32, 0.5], F, U);
const blanket = (x, y, z) => Math.max(blanketShell(x, y, z), saddleArea(x, y, z));

const horseBody = blend([barrel, hindquarters, ...haunches, chest, ...shoulders, belly, ...pectorals], 0.16);
const horseHead = blend([head, cheeks, jaw, ...ears, forelock], 0.05);
const horseRaw = (x, y, z) => {
  let d = smin(horseBody(x, y, z), neck(x, y, z), 0.14);
  d = smin(d, neckCrest(x, y, z), 0.08);
  d = smin(d, horseHead(x, y, z), 0.08);
  for (const leg of legs) d = smin(d, leg(x, y, z), 0.09);
  for (const muscle of gaskins) d = smin(d, muscle(x, y, z), 0.06);
  d = smin(d, tail(x, y, z), 0.06);
  d = smin(d, mane(x, y, z), 0.03);
  d = smin(d, blanket(x, y, z), 0.02);
  for (const hole of [...nostrils, ...eyes]) d = ssub(d, hole(x, y, z), 0.015);
  return d;
};

// --- всадник ------------------------------------------------------------------------------------
const pelvis = ellipsoid([0, 0.4, 2.24], [0.17, 0.15, 0.13]);
const torso = cone([0, 0.42, 2.3], [0, 0.48, 2.62], 0.15, 0.17);
const upperChest = ellipsoid([0, 0.49, 2.68], [0.22, 0.13, 0.11]);
const riderNeck = cone([0, 0.49, 2.76], [0, 0.51, 2.86], 0.06, 0.055);
const riderHead = ellipsoid([0, 0.53, 2.95], [0.09, 0.105, 0.11]);
// Меховая шапка: тулья и пушистый околыш.
const hat = cone([0, 0.52, 3.02], [0, 0.5, 3.14], 0.115, 0.1);
const hatBandCore = cone([0, 0.525, 3.0], [0, 0.52, 3.06], 0.13, 0.13);
const hatBand = (x, y, z) => hatBandCore(x, y, z) + 0.01 * waves(x * 9, y * 9, z * 9, 6);
// Правая рука поднята с камчой, левая держит поводья.
const rightArm = chain(
  [
    [0.19, 0.48, 2.7, 0.075],
    [0.27, 0.5, 2.97, 0.062],
    [0.29, 0.52, 3.26, 0.05],
  ],
  0.03,
);
const rightFist = sphere([0.29, 0.52, 3.31], 0.055);
const leftArm = chain(
  [
    [-0.19, 0.48, 2.68, 0.075],
    [-0.26, 0.58, 2.48, 0.062],
    [-0.12, 0.74, 2.47, 0.05],
  ],
  0.03,
);
const leftFist = sphere([-0.09, 0.78, 2.47], 0.05);
// Ноги в сапогах обхватывают бока коня, стопы в стременах.
const riderLeg = (s) =>
  chain(
    [
      [s * 0.12, 0.42, 2.22, 0.1],
      [s * 0.37, 0.6, 2.0, 0.085],
      [s * 0.38, 0.54, 1.66, 0.07],
      [s * 0.38, 0.54, 1.6, 0.06],
      [s * 0.38, 0.7, 1.58, 0.05],
    ],
    0.04,
  );
const riderLegs = [riderLeg(-1), riderLeg(1)];

// Кафтан: от плеч расширяется книзу, полы ложатся на круп и бока.
const caftan = cone([0, 0.47, 2.68], [0, 0.36, 2.15], 0.18, 0.27);
const caftanSkirtCore = ellipsoid([0, 0.2, 2.12], [0.34, 0.3, 0.07], [0, F[1], F[2]], U);
const caftanSkirt = (x, y, z) => caftanSkirtCore(x, y, z) + 0.012 * waves(x * 5, y * 5, z * 5, 9);
const belt = cone([0, 0.43, 2.34], [0, 0.44, 2.4], 0.19, 0.19);
const sleeveR = cone([0.2, 0.48, 2.72], [0.27, 0.5, 2.94], 0.09, 0.075);
const sleeveL = cone([-0.2, 0.49, 2.7], [-0.26, 0.58, 2.5], 0.09, 0.075);

// Плащ: полотно с плеч назад и чуть влево, расширяется к низу; складки идут вдоль полотна.
const cloakPath = [
  [-0.02, 0.42, 2.74],
  [-0.06, 0.24, 2.66],
  [-0.12, 0.05, 2.56],
  [-0.19, -0.13, 2.42],
  [-0.25, -0.28, 2.27],
];
const cloakPieces = cloakPath.slice(1).map((p, i) => {
  const q = cloakPath[i];
  const dir = [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
  const mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
  // Ширина — поперёк (по плечам), длина — вдоль потока, толщина — 3 см.
  return ellipsoid(mid, [0.22 + i * 0.04, 0.16, 0.03], dir, [0, 0, 1]);
});
const cloakCore = blend(cloakPieces, 0.07);
const cloak = (x, y, z) => cloakCore(x, y, z) + 0.014 * Math.sin(x * 34 + y * 5) + 0.006 * Math.sin(x * 61 - z * 9);

/** Всадник чуть крупнее «натуры» — на памятниках так принято, иначе на коне он теряется. */
export const RIDER_SCALE = 1.15;
const RIDER_PIVOT = [0, 0.4, 2.2];
export const riderPoint = ([x, y, z]) => [
  RIDER_PIVOT[0] + (x - RIDER_PIVOT[0]) * RIDER_SCALE,
  RIDER_PIVOT[1] + (y - RIDER_PIVOT[1]) * RIDER_SCALE,
  RIDER_PIVOT[2] + (z - RIDER_PIVOT[2]) * RIDER_SCALE,
];
const rider = (x, y, z) =>
  riderRaw(
    RIDER_PIVOT[0] + (x - RIDER_PIVOT[0]) / RIDER_SCALE,
    RIDER_PIVOT[1] + (y - RIDER_PIVOT[1]) / RIDER_SCALE,
    RIDER_PIVOT[2] + (z - RIDER_PIVOT[2]) / RIDER_SCALE,
  ) * RIDER_SCALE;

const riderRaw = (x, y, z) => {
  let d = smin(pelvis(x, y, z), torso(x, y, z), 0.08);
  d = smin(d, upperChest(x, y, z), 0.08);
  d = smin(d, riderNeck(x, y, z), 0.04);
  d = smin(d, riderHead(x, y, z), 0.03);
  d = smin(d, hat(x, y, z), 0.02);
  d = smin(d, hatBand(x, y, z), 0.015);
  d = smin(d, caftan(x, y, z), 0.05);
  d = smin(d, caftanSkirt(x, y, z), 0.05);
  d = smin(d, belt(x, y, z), 0.01);
  d = smin(d, sleeveR(x, y, z), 0.04);
  d = smin(d, sleeveL(x, y, z), 0.04);
  d = smin(d, rightArm(x, y, z), 0.03);
  d = smin(d, rightFist(x, y, z), 0.02);
  d = smin(d, leftArm(x, y, z), 0.03);
  d = smin(d, leftFist(x, y, z), 0.02);
  for (const leg of riderLegs) d = smin(d, leg(x, y, z), 0.04);
  d = smin(d, cloak(x, y, z), 0.06);
  return d;
};

// --- основание: бронзовая плита-«скала» под копытами и хвостом -------------------------------------
const plate = ovalSlab([0, -0.36, 0], 0.62, 0.78, BASE_TOP, 0.015);
const base = (x, y, z) => plate(x, y, z) + (z > BASE_TOP - 0.02 ? 0.01 * waves(x * 6, y * 6, 0, 5) : 0);

/** Поле всей статуи. */
export function statue(x, y, z) {
  let d = smin(horseRaw(x, y, z), rider(x, y, z), 0.03);
  d = smin(d, base(x, y, z), 0.04);
  // Снизу всё срезано по низу основания: хвост и копыта не торчат под плиту.
  return Math.max(d, -z);
}

/** Где искать поверхность (с запасом). */
export const STATUE_BOX = { min: [-0.75, -1.25, -0.04], max: [0.75, 1.8, 3.5] };

/**
 * Тонкие детали, которые решётка не удержит: камча и поводья — трубками по точкам [x, y, z],
 * радиус в метрах (натуральной величины).
 */
const fist = riderPoint([-0.08, 0.8, 2.48]);
const mouth = (side) => [side * 0.065, 1.52, 2.84];
/** Поводья провисают от кулака к углам рта. */
const rein = (side) => [fist, [side * 0.05, 1.12, 2.6], [side * 0.065, 1.4, 2.8], mouth(side)];
export const TUBES = [
  // Рукоять и плеть камчи над поднятым кулаком.
  { points: [[0.29, 0.52, 3.3], [0.3, 0.51, 3.45], [0.31, 0.5, 3.57]].map(riderPoint), radius: 0.024 },
  {
    points: [[0.31, 0.5, 3.57], [0.35, 0.44, 3.68], [0.4, 0.36, 3.7], [0.44, 0.28, 3.64], [0.45, 0.24, 3.55]].map(riderPoint),
    radius: 0.013,
  },
  { points: rein(-1), radius: 0.014 },
  { points: rein(1), radius: 0.014 },
  // Уздечка: нахрапный ремень вокруг морды и щёчные ремни к затылку.
  { points: ring([0, 1.5, 2.89], [0, 0.78, -0.62], 0.105, 0.135), radius: 0.013, closed: true },
  ...[-1, 1].map((side) => ({ points: [[side * 0.1, 1.5, 2.88], [side * 0.125, 1.36, 3.02], [side * 0.11, 1.24, 3.17]], radius: 0.012 })),
  { points: ring([0, 1.22, 3.18], [0, 0.85, -0.5], 0.135, 0.12), radius: 0.012, closed: true },
  // Стремена под стопами всадника.
  ...[-1, 1].map((side) => {
    const [x, y, z] = riderPoint([side * 0.38, 0.6, 1.555]);
    return { points: [[x, y - 0.07, z + 0.2], [x, y - 0.07, z], [x, y + 0.07, z], [x, y + 0.07, z + 0.2]], radius: 0.012 };
  }),
];

/** Кольцо из 12 точек вокруг оси axis: полуоси rx (поперёк) и rz. */
function ring(center, axis, rx, rz) {
  const l = Math.hypot(...axis);
  const a = axis.map((v) => v / l);
  // Поперечные оси кольца: x — вбок, вторая — перпендикуляр к оси в плоскости y–z.
  const ex = [1, 0, 0];
  const ez = [0, -a[2], a[1]];
  return Array.from({ length: 12 }, (_, i) => {
    const t = (i / 12) * Math.PI * 2;
    return [0, 1, 2].map((k) => center[k] + ex[k] * Math.cos(t) * rx + ez[k] * Math.sin(t) * rz);
  });
}

/** Высота статуи в натуральную величину (до верха камчи) — по ней масштаб до 9,8 м. */
export const STATUE_HEIGHT = 3.7;
