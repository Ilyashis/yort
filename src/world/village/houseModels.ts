// Модели башкирских деревенских домов (Зауралье, Баймакский район): каждая — набор частей,
// собранных по размерам и «зерну» (зерно выбирает окраску, ставни, кровлю — как у соседей по улице).
// Размеры по умолчанию — типичные; ширину и глубину можно задать (например, по контуру дома из OSM).
// Оси: x — вдоль уличного фасада, y — вглубь двора (улица со стороны −y), z — вверх.

import {
  at,
  chimney,
  Dice,
  doorParts,
  gableEnd,
  gableRoof,
  hipRoof,
  leanToRoof,
  logWall,
  logWallTop,
  mixColor,
  pipe,
  plinth,
  porch,
  rectWalls,
  roofSeat,
  shade,
  slab,
  solidWall,
  wallBox,
  wallSlab,
  windowParts,
  type HousePart,
  type Opening,
  type Surface,
  type Vec3,
  type WallFrame,
  type WindowStyle,
} from './houseParts';
import { PUBLIC_MODELS } from './publicModels';
import {
  ACCENTS,
  BAND,
  BRICK_RED,
  BRICK_WHITE,
  clamp,
  doorIn,
  DOORS,
  FELT,
  finish,
  fitWindows,
  FOUNDATIONS,
  leanCanopy,
  LOGS,
  METAL_ROOFS,
  PAINTS,
  PLASTER,
  rect,
  SHUTTERS,
  SLATE,
  spread,
  TRIMS,
  windowIn,
  withGround,
} from './modelKit';

export type HouseModelId =
  | 'izba'
  | 'pyatistenok'
  | 'veranda'
  | 'hipped'
  | 'brick'
  | 'banya'
  | 'yurt'
  | 'school'
  | 'museum'
  | 'club'
  | 'office'
  | 'shop'
  | 'store'
  | 'busstop'
  | 'outhouse'
  | 'well'
  | 'shed'
  | 'greenhouse';

/** Разделы каталога: жилые дома, общественные здания, мелкие постройки (двор, улица). */
export type HouseModelGroup = 'house' | 'public' | 'small';

export const MODEL_GROUPS: { group: HouseModelGroup; label: string }[] = [
  { group: 'house', label: 'Жилые дома' },
  { group: 'public', label: 'Общественные' },
  { group: 'small', label: 'Двор и улица' },
];

export interface HouseOptions {
  /** Ширина вдоль улицы и глубина, м (обрезаются до допустимых для модели). */
  width?: number;
  depth?: number;
  /** Зерно варианта: окраска, ставни, кровля. */
  seed?: number;
  /** Для дальнего плана: срубы — плоскостями с рисунком брёвен, без поленниц и торцов брёвен. */
  far?: boolean;
  /**
   * Дом на склоне: насколько земля под ним опускается ниже пола (ниже z = 0), м. Цоколь, основание
   * крыльца, ступени и подол юрты уходят вниз на столько — дом не висит в воздухе.
   */
  foundation?: number;
}

export interface HousePlan {
  id: HouseModelId;
  parts: HousePart[];
  width: number;
  depth: number;
  /** Высота до конька (или верха трубы), м. */
  height: number;
  /** Контур стен основного объёма (x, y), против часовой. */
  footprint: [number, number][];
}

export interface HouseModel {
  id: HouseModelId;
  group: HouseModelGroup;
  name: string;
  /** Коротко — для кнопок. */
  short: string;
  description: string;
  /** Короткая подпись: материал, этажность. */
  summary: string;
  width: { min: number; value: number; max: number };
  depth: { min: number; value: number; max: number };
  plan: (options?: HouseOptions) => HousePlan;
}

// --- изба и пятистенок --------------------------------------------------------------------------

interface LogHouseLook {
  dice: Dice;
  log: string;
  style: WindowStyle;
  gable: string;
  gableSurface: Surface;
  roof: string;
  roofSurface: Surface;
  foundation: string;
  door: string;
}

function logLook(seed: number): LogHouseLook {
  const dice = new Dice(seed);
  const log = dice.pick(LOGS);
  const trim = dice.pick(TRIMS);
  const accent = dice.pick(ACCENTS);
  const slate = dice.chance(0.45);
  const paintedGable = dice.chance(0.6);
  return {
    dice,
    log,
    style: {
      trim,
      accent,
      frame: '#f2efe6',
      shutters: dice.chance(0.7) ? dice.pick(SHUTTERS) : undefined,
      top: dice.pick(['kokoshnik', 'kokoshnik', 'arch', 'simple'] as const),
      apron: dice.chance(0.7),
      sash: 'cross',
    },
    gable: paintedGable ? dice.pick([accent, ...PAINTS]) : shade(log, 0.85),
    gableSurface: 'boards',
    roof: slate ? dice.pick(SLATE) : dice.pick(METAL_ROOFS),
    roofSurface: slate ? 'slate' : 'metal',
    foundation: dice.pick(FOUNDATIONS),
    door: dice.pick(DOORS),
  };
}

/** Изба-бура: бревенчатая четырёхстенка фронтоном на улицу, два-три окна с резными наличниками. */
function planIzba(o: HouseOptions = {}): HousePlan {
  const look = logLook(o.seed ?? 1);
  const { dice, style } = look;
  const W = clamp(o.width ?? 6, 5, 9.5);
  const D = clamp(o.depth ?? 6.6, 5, 10.5);
  const hp = 0.45;
  const r = 0.12;
  const rows = 11;
  const top = logWallTop(hp, rows, r);
  const walls = rectWalls(W, D);
  const parts: HousePart[] = [plinth(W + 2 * r + 0.06, D + 2 * r + 0.06, hp, look.foundation)];
  const wall = { log: r };
  const win = { z0: hp + 0.7, w: 0.8, h: 1.1 };
  const openings = { front: [] as Opening[], right: [] as Opening[], back: [] as Opening[], left: [] as Opening[] };

  for (const u of fitWindows(W, win.w, !!style.shutters, 3, 0.5)) windowIn(parts, openings.front, walls.front, u, win.z0, win.w, win.h, wall, style, dice);
  for (const u of [D * 0.3, D * 0.64]) windowIn(parts, openings.right, walls.right, u, win.z0, win.w, win.h, wall, style, dice);
  windowIn(parts, openings.back, walls.back, W / 2, win.z0, 0.7, 0.95, wall, { ...style, shutters: undefined }, dice);
  // Слева: дверь ближе к двору и окно ближе к улице.
  const doorU = 1.5;
  const floor = hp + 0.25;
  doorIn(parts, openings.left, walls.left, doorU, floor, 0.9, 1.85, r, look.door, style.trim);
  windowIn(parts, openings.left, walls.left, D - 1.7, win.z0, win.w, win.h, wall, style, dice);

  for (const [key, f] of Object.entries(walls) as [keyof typeof walls, WallFrame][]) {
    const half = key === 'left' || key === 'right';
    parts.push(...logWall(f, { z0: hp, rows, radius: r, half, overhang: 0.26, openings: openings[key], color: look.log, dice, far: o.far }));
  }

  const roof = gableRoof({ w: W, d: D, top: roofSeat(top, r, 38), pitch: 38, side: 0.45, front: 0.55, back: 0.4, color: look.roof, surface: look.roofSurface });
  parts.push(...roof.parts);
  // Фронтон опускаем на верхний венец торцевых стен (они на полбревна ниже боковых).
  const gable = { top: top - 0.16, ridge: roof.ridge, out: r - 0.02, side: 0.45, eave: roof.eave, color: look.gable, surface: look.gableSurface, trim: style.trim, towel: true };
  parts.push(...gableEnd(walls.front, { ...gable, overhang: 0.55 }));
  parts.push(...gableEnd(walls.back, { ...gable, overhang: 0.4, towel: false }));
  // Слуховое окошко на уличном фронтоне.
  parts.push(
    ...windowParts(
      { f: walls.front, u: W / 2, z0: top + 0.45, w: 0.5, h: 0.6, wallOut: r + 0.02, glassOut: r - 0.01, reveal: 0, dice },
      { ...style, shutters: undefined, top: 'simple', apron: false },
    ),
  );
  parts.push(
    ...porch(walls.left, {
      u: doorU,
      width: 1.5,
      depth: 1.1,
      floor,
      wallOut: r,
      canopy: false,
      wood: shade(look.log, 1.05),
      roof: look.roof,
      roofSurface: look.roofSurface,
      trim: style.trim,
    }),
  );
  const cx = W * 0.14;
  const cy = D * 0.1;
  parts.push(...chimney(cx, cy, top - 0.3, Math.max(roof.heightAt(cx, cy) + 0.7, roof.ridge + 0.35), '#a4523b'));
  return finish('izba', parts, W, D, rect(W + 2 * r, D + 2 * r), { roof: look.roof, wall: look.log });
}

/** Пятистенок: длинный сруб с поперечной стеной (её брёвна торчат на боках), сени и крыльцо со двора. */
function planPyatistenok(o: HouseOptions = {}): HousePlan {
  const look = logLook((o.seed ?? 1) + 1000);
  const { dice, style } = look;
  const W = clamp(o.width ?? 6.6, 5.5, 10);
  const D = clamp(o.depth ?? 10, 8, 14);
  const hp = 0.5;
  const r = 0.13;
  const rows = 12;
  const top = logWallTop(hp, rows, r);
  const walls = rectWalls(W, D);
  const parts: HousePart[] = [plinth(W + 2 * r + 0.06, D + 2 * r + 0.06, hp, look.foundation)];
  const wall = { log: r };
  const win = { z0: hp + 0.74, w: 0.85, h: 1.15 };
  const openings = { front: [] as Opening[], right: [] as Opening[], back: [] as Opening[], left: [] as Opening[] };
  // Поперечная («пятая») стена: передняя горница и задняя изба с печью.
  const cross = Math.min(5.4, D * 0.55);

  for (const u of fitWindows(W, win.w, !!style.shutters, 3, 0.5)) windowIn(parts, openings.front, walls.front, u, win.z0, win.w, win.h, wall, style, dice);
  for (const u of [1.4, cross - 1.5, cross + 1.8]) windowIn(parts, openings.right, walls.right, u, win.z0, win.w, win.h, wall, style, dice);
  windowIn(parts, openings.left, walls.left, D - 1.6, win.z0, win.w, win.h, wall, style, dice);
  windowIn(parts, openings.left, walls.left, D - cross - 1.6, win.z0, win.w, win.h, wall, style, dice);

  for (const [key, f] of Object.entries(walls) as [keyof typeof walls, WallFrame][]) {
    const half = key === 'left' || key === 'right';
    parts.push(...logWall(f, { z0: hp, rows, radius: r, half, overhang: 0.28, openings: openings[key], color: look.log, dice, far: o.far }));
  }
  // Торцы поперечной стены на боковых стенах — между венцами боковых стен.
  const ends = shade(mixColor(look.log, '#d9c39a', 0.45), 1.05);
  for (const [f, u] of o.far ? [] : [
    [walls.right, cross],
    [walls.left, D - cross],
  ] as const) {
    for (let i = 0; i < rows; i++) {
      const z = hp + r + i * r * 1.8;
      parts.push({ type: 'cylinder', from: at(f, u, -r, z), to: at(f, u, r + 0.28, z), radius: r, segments: 8, color: shade(look.log, dice.range(0.9, 1.05)), surface: 'wood', caps: ends });
    }
  }

  const roof = gableRoof({ w: W, d: D, top: roofSeat(top, r, 35), pitch: 35, side: 0.5, front: 0.6, back: 0.45, color: look.roof, surface: look.roofSurface });
  parts.push(...roof.parts);
  const gable = { top: top - 0.17, ridge: roof.ridge, out: r - 0.02, side: 0.5, eave: roof.eave, color: look.gable, surface: look.gableSurface, trim: style.trim, towel: true };
  parts.push(...gableEnd(walls.front, { ...gable, overhang: 0.6 }));
  parts.push(...gableEnd(walls.back, { ...gable, overhang: 0.45, towel: false }));
  parts.push(
    ...windowParts(
      { f: walls.front, u: W / 2, z0: top + 0.5, w: 0.55, h: 0.65, wallOut: r + 0.02, glassOut: r - 0.01, reveal: 0, dice },
      { ...style, shutters: undefined, top: 'arch', apron: false },
    ),
  );

  // Сени: дощатая пристройка во всю ширину задней стены, односкатная крыша назад.
  const Ws = W - 0.6;
  const Ds = 2.6;
  const scy = D / 2 + r + Ds / 2;
  const sWalls = rectWalls(Ws, Ds, 0, scy);
  const boards = dice.chance(0.5) ? shade(look.log, 0.95) : look.gable;
  const sh = 2.25;
  const sOpen = { left: [] as Opening[], right: [] as Opening[], back: [] as Opening[] };
  const sDoorU = Ds * 0.5;
  doorIn(parts, sOpen.left, sWalls.left, sDoorU, hp + 0.05, 0.9, 1.85, 0.05, look.door, style.trim);
  windowIn(parts, sOpen.right, sWalls.right, Ds * 0.5, hp + 1.0, 0.6, 0.5, { thickness: 0.1 }, { ...style, shutters: undefined, top: 'simple', apron: false }, dice);
  parts.push(plinth(Ws + 0.06, Ds + 0.06, hp, look.foundation, 0, scy));
  parts.push(...solidWall(sWalls.left, hp, sh, 0.1, sOpen.left, boards, 'boards'));
  parts.push(...solidWall(sWalls.right, hp, sh, 0.1, sOpen.right, boards, 'boards'));
  parts.push(...solidWall(sWalls.back, hp, sh, 0.1, [], boards, 'boards'));
  // Треугольники между стенами сеней и скатом.
  const hiZ = top - 0.15;
  const loZ = hp + sh;
  for (const f of [sWalls.left, sWalls.right]) {
    const pts: [number, number][] = f === sWalls.left ? [[0, loZ], [Ds, loZ], [Ds, hiZ]] : [[0, loZ], [Ds, loZ], [0, hiZ]];
    parts.push(wallSlab(f, 0, pts, 0.1, boards, 'boards'));
  }
  const y0 = D / 2 + r;
  const y1 = y0 + Ds + 0.35;
  const ex = Ws / 2 + 0.25;
  parts.push(leanToRoof([-ex, y0, hiZ + 0.05], [ex, y0, hiZ + 0.05], [ex, y1, loZ - 0.05], [-ex, y1, loZ - 0.05], look.roof, look.roofSurface));
  parts.push(
    ...porch(sWalls.left, {
      u: sDoorU,
      width: 1.5,
      depth: 1.0,
      floor: hp + 0.05,
      wallOut: 0.05,
      canopy: false,
      wood: shade(look.log, 1.05),
      roof: look.roof,
      roofSurface: look.roofSurface,
      trim: style.trim,
    }),
  );
  const cx = -W * 0.16;
  const cy = cross - D / 2 + 1.2;
  parts.push(...chimney(cx, cy, top - 0.3, Math.max(roof.heightAt(cx, cy) + 0.7, roof.ridge + 0.35), '#a4523b'));
  return finish('pyatistenok', parts, W, D, rect(W + 2 * r, D + 2 * r), { roof: look.roof, wall: look.log });
}

// --- обшитые дома --------------------------------------------------------------------------------

interface CladLook {
  dice: Dice;
  wall: string;
  wallSurface: Surface;
  style: WindowStyle;
  roof: string;
  roofSurface: Surface;
  foundation: string;
  door: string;
}

function cladLook(seed: number, plaster = 0): CladLook {
  const dice = new Dice(seed);
  const plastered = dice.chance(plaster);
  const wall = plastered ? dice.pick(PLASTER) : dice.pick(PAINTS);
  const trim = dice.pick(TRIMS);
  const slate = dice.chance(0.35);
  return {
    dice,
    wall,
    wallSurface: plastered ? 'plaster' : 'siding',
    style: {
      trim: wall === '#e6dfcd' ? dice.pick(['#2f6fb0', '#3c9255']) : trim,
      accent: dice.pick(ACCENTS),
      frame: '#f2efe6',
      shutters: dice.chance(0.55) ? dice.pick(SHUTTERS) : undefined,
      top: dice.pick(['kokoshnik', 'arch', 'simple'] as const),
      apron: dice.chance(0.6),
      sash: 'cross',
    },
    roof: slate ? dice.pick(SLATE) : dice.pick(METAL_ROOFS),
    roofSurface: slate ? 'slate' : 'metal',
    foundation: dice.pick(FOUNDATIONS),
    door: dice.pick(DOORS),
  };
}

/** Угловые доски и фриз под карнизом у обшитого дома. */
function cladTrim(parts: HousePart[], walls: ReturnType<typeof rectWalls>, t: number, z0: number, top: number, trim: string, sides: WallFrame[]) {
  for (const f of Object.values(walls)) {
    parts.push(wallBox(f, -0.01, t / 2 + 0.02, (z0 + top) / 2, [0.2, 0.05, top - z0], trim, 'wood'));
    parts.push(wallBox(f, f.length / 2, t / 2 + 0.015, z0 + 0.08, [f.length, 0.04, 0.16], trim, 'wood'));
  }
  for (const f of sides) parts.push(wallBox(f, f.length / 2, t / 2 + 0.02, top - 0.14, [f.length, 0.04, 0.26], trim, 'wood'));
}

/** Дом с верандой: обшитый крашеной доской, фронтоном на улицу, сбоку — застеклённая веранда. */
function planVeranda(o: HouseOptions = {}): HousePlan {
  const look = cladLook((o.seed ?? 1) + 2000);
  const { dice, style } = look;
  const W = clamp(o.width ?? 7, 6, 11);
  const D = clamp(o.depth ?? 8.6, 7, 12.5);
  const hp = 0.5;
  const t = 0.22;
  const wallH = 2.9;
  const top = hp + wallH;
  const walls = rectWalls(W, D);
  const parts: HousePart[] = [plinth(W + t + 0.08, D + t + 0.08, hp, look.foundation)];
  const wall = { thickness: t };
  const win = { z0: hp + 0.8, w: 0.9, h: 1.25 };
  const openings = { front: [] as Opening[], right: [] as Opening[], back: [] as Opening[], left: [] as Opening[] };
  // Веранда по правой стене от vy0 до vy1 (вдоль y).
  const Vw = 2.4;
  const vy0 = -D / 2 + 1.9;
  const vy1 = D / 2 - 0.8;

  for (const u of fitWindows(W, win.w, !!style.shutters, 3)) windowIn(parts, openings.front, walls.front, u, win.z0, win.w, win.h, wall, style, dice);
  windowIn(parts, openings.right, walls.right, 0.95, win.z0, 0.8, win.h, wall, { ...style, shutters: undefined }, dice);
  for (const u of spread(D, 3, D / 3.4)) windowIn(parts, openings.left, walls.left, u, win.z0, win.w, win.h, wall, style, dice);
  windowIn(parts, openings.back, walls.back, W * 0.65, win.z0, 0.8, 1.1, wall, { ...style, shutters: undefined }, dice);
  for (const [key, f] of Object.entries(walls) as [keyof typeof walls, WallFrame][]) {
    parts.push(...solidWall(f, hp, wallH, t, openings[key], look.wall, look.wallSurface));
  }
  cladTrim(parts, walls, t, hp, top, style.trim, [walls.right, walls.left]);

  const roof = gableRoof({ w: W, d: D, top: roofSeat(top, t / 2, 33), pitch: 33, side: 0.5, front: 0.55, back: 0.4, color: look.roof, surface: look.roofSurface });
  parts.push(...roof.parts);
  const gable = { top, ridge: roof.ridge, out: t / 2, side: 0.5, eave: roof.eave, color: look.wall, surface: 'boards' as Surface, trim: style.trim, towel: true };
  parts.push(...gableEnd(walls.front, { ...gable, overhang: 0.55 }));
  parts.push(...gableEnd(walls.back, { ...gable, overhang: 0.4, towel: false }));
  parts.push(
    ...windowParts(
      { f: walls.front, u: W / 2, z0: top + 0.4, w: 0.6, h: 0.75, wallOut: t / 2 + 0.04, glassOut: t / 2 + 0.01, reveal: 0, dice },
      { ...style, shutters: undefined, top: 'arch', apron: false },
    ),
  );

  // Веранда: дощатый низ, частые стёкла в белых рамах, односкатная крыша под свесом дома.
  const vx = W / 2 + t / 2;
  const Vd = vy1 - vy0;
  const vWalls = rectWalls(Vw, Vd, vx + Vw / 2, (vy0 + vy1) / 2);
  const panel = dice.chance(0.5) ? style.trim : look.wall;
  const vh = 1.95;
  const lowH = 0.85;
  parts.push(plinth(Vw + 0.06, Vd + 0.06, hp, look.foundation, vx + Vw / 2, (vy0 + vy1) / 2));
  const lit = dice.next();
  const doorU = 0.7;
  const glaze = (f: WallFrame, from: number, to: number) => {
    const L = to - from;
    const cols = Math.max(1, Math.round(L / 0.62));
    const cw = L / cols;
    for (let c = 0; c < cols; c++) {
      for (const [z0, h] of [
        [hp + lowH, 0.62],
        [hp + lowH + 0.62, vh - lowH - 0.62],
      ] as const) {
        parts.push({ type: 'glass', center: at(f, from + cw * (c + 0.5), 0, z0 + h / 2), size: [cw, 0.02, h], angle: Math.atan2(f.ty, f.tx), lit, curtain: false });
      }
    }
    for (let c = 0; c <= cols; c++) parts.push(wallBox(f, from + c * cw, 0.02, hp + (lowH + vh) / 2, [0.06, 0.08, vh - lowH], '#f2efe6'));
    parts.push(wallBox(f, (from + to) / 2, 0.02, hp + lowH + 0.62, [L, 0.07, 0.05], '#f2efe6'));
    parts.push(wallBox(f, (from + to) / 2, 0.04, hp + lowH, [L + 0.04, 0.14, 0.06], panel));
  };
  for (const f of [vWalls.front, vWalls.right, vWalls.back]) {
    const isFront = f === vWalls.front;
    // Нижняя обшивка; у передней стенки — проём двери.
    if (isFront) {
      parts.push(wallBox(f, (doorU + 0.45 + f.length) / 2, 0, hp + lowH / 2, [f.length - doorU - 0.45, 0.08, lowH], panel, 'boards'));
      parts.push(wallBox(f, (doorU - 0.45) / 2, 0, hp + lowH / 2, [Math.max(0.02, doorU - 0.45), 0.08, lowH], panel, 'boards'));
      glaze(f, doorU + 0.5, f.length);
      parts.push(...doorParts(f, doorU, hp + 0.02, 0.85, 1.85, 0.04, 0, look.door, '#f2efe6'));
    } else {
      parts.push(wallBox(f, f.length / 2, 0, hp + lowH / 2, [f.length, 0.08, lowH], panel, 'boards'));
      glaze(f, 0, f.length);
    }
    parts.push(wallBox(f, f.length / 2, 0.02, hp + vh + 0.05, [f.length + 0.1, 0.14, 0.12], panel));
  }
  for (const [x, y] of [
    [vx + Vw, vy0],
    [vx + Vw, vy1],
    [vx, vy0],
    [vx, vy1],
  ] as const) {
    parts.push({ type: 'box', center: [x, y, hp + (vh + 0.1) / 2], size: [0.12, 0.12, vh + 0.1], color: '#f2efe6' });
  }
  const hiZ = top - 0.42;
  const loZ = hp + vh + 0.11;
  const ox = vx + Vw + 0.3;
  const slope = (hiZ - loZ) / (ox - vx);
  parts.push(leanToRoof([vx, vy0 - 0.3, hiZ], [vx, vy1 + 0.3, hiZ], [ox, vy1 + 0.3, loZ], [ox, vy0 - 0.3, loZ], look.roof, look.roofSurface));
  // Треугольники над верандой спереди и сзади.
  for (const f of [vWalls.front, vWalls.back]) {
    const front = f === vWalls.front;
    const zIn = hiZ - 0.06;
    const zOut = loZ + 0.3 * slope - 0.06;
    const pts: [number, number][] = front
      ? [
          [0, hp + vh + 0.1],
          [Vw, hp + vh + 0.1],
          [Vw, zOut],
          [0, zIn],
        ]
      : [
          [0, hp + vh + 0.1],
          [Vw, hp + vh + 0.1],
          [Vw, zIn],
          [0, zOut],
        ];
    parts.push(wallSlab(f, 0, pts, 0.06, panel, 'boards'));
  }
  parts.push(
    ...porch(vWalls.front, {
      u: doorU,
      width: 1.3,
      depth: 0.9,
      floor: hp,
      wallOut: 0.04,
      canopy: false,
      wood: dice.pick(['#8a6a4a', '#9a7650']),
      roof: look.roof,
      roofSurface: look.roofSurface,
      trim: style.trim,
    }),
  );
  const cx = -W * 0.15;
  const cy = D * 0.08;
  parts.push(...chimney(cx, cy, top - 0.3, Math.max(roof.heightAt(cx, cy) + 0.7, roof.ridge + 0.35), '#a4523b'));
  return finish('veranda', parts, W, D, rect(W + t, D + t), { roof: look.roof, wall: look.wall });
}

/** Слуховое окно-«светёлка» на переднем скате вальмовой крыши: стенка с окном, щёчки, двускатный козырёк. */
function frontDormer(parts: HousePart[], yf: number, base: number, pitch: number, wall: string, wallSurface: Surface, roof: string, roofSurface: Surface, style: WindowStyle, dice: Dice) {
  const tan = Math.tan((pitch * Math.PI) / 180);
  const wd = 1.6;
  const hw = 0.9;
  const apex = base + hw + wd / 2;
  const f: WallFrame = { x: -wd / 2, y: yf, tx: 1, ty: 0, length: wd };
  parts.push(
    wallSlab(
      f,
      0,
      [
        [0, base - 0.1],
        [wd, base - 0.1],
        [wd, base + hw],
        [wd / 2, apex - 0.04],
        [0, base + hw],
      ],
      0.06,
      wall,
      wallSurface === 'plaster' ? 'plaster' : 'boards',
    ),
  );
  parts.push(...windowParts({ f, u: wd / 2, z0: base + 0.15, w: 0.62, h: 0.6, wallOut: 0.04, glassOut: 0.01, reveal: 0, dice }, { ...style, shutters: undefined, top: 'simple', apron: false }));
  const yCheek = yf + hw / tan;
  for (const s of [-1, 1]) {
    parts.push(
      slab(
        [
          [(s * wd) / 2, yf, base - 0.1],
          [(s * wd) / 2, yf, base + hw],
          [(s * wd) / 2, yCheek, base + hw],
        ],
        [s, 0, 0],
        0.05,
        wall,
        wallSurface === 'plaster' ? 'plaster' : 'boards',
      ),
    );
  }
  // Козырёк: скаты под 45°, их задние кромки ложатся на скат крыши.
  const ex = wd / 2 + 0.14;
  const ze = base + hw - 0.14;
  const y0 = yf - 0.22;
  const yEave = yf + (ze - base) / tan;
  const yRidge = yf + (apex - base) / tan;
  for (const s of [-1, 1]) {
    parts.push(
      slab(
        [
          [s * ex, y0, ze],
          [s * ex, yEave, ze],
          [0, yRidge, apex],
          [0, y0, apex],
        ],
        [s, 0, 1],
        0.05,
        roof,
        roofSurface,
      ),
    );
  }
  parts.push(
    wallSlab(
      { ...f, y: y0 + 0.02 },
      0,
      [
        [-0.14, ze - 0.2],
        [wd / 2, apex - 0.2],
        [wd / 2, apex],
        [-0.14, ze],
      ],
      0.03,
      style.trim,
      'wood',
    ),
    wallSlab(
      { ...f, y: y0 + 0.02 },
      0,
      [
        [wd / 2, apex - 0.2],
        [wd + 0.14, ze - 0.2],
        [wd + 0.14, ze],
        [wd / 2, apex],
      ],
      0.03,
      style.trim,
      'wood',
    ),
  );
}

/** Дом под вальмовой крышей (70–80-е): длинной стороной на улицу, светёлка на скате, ставни. */
function planHipped(o: HouseOptions = {}): HousePlan {
  const look = cladLook((o.seed ?? 1) + 3000, 0.35);
  const { dice, style } = look;
  const W = clamp(o.width ?? 8.4, 7, 13);
  const D = clamp(o.depth ?? 7.6, 6.5, 12);
  const hp = 0.6;
  const t = 0.24;
  const wallH = 2.8;
  const top = hp + wallH;
  const walls = rectWalls(W, D);
  const parts: HousePart[] = [plinth(W + t + 0.08, D + t + 0.08, hp, look.foundation)];
  const wall = { thickness: t };
  const win = { z0: hp + 0.78, w: 0.95, h: 1.3 };
  const openings = { front: [] as Opening[], right: [] as Opening[], back: [] as Opening[], left: [] as Opening[] };

  for (const u of fitWindows(W, win.w, !!style.shutters, 4)) windowIn(parts, openings.front, walls.front, u, win.z0, win.w, win.h, wall, style, dice);
  for (const u of spread(D, 2, D / 2.4)) windowIn(parts, openings.left, walls.left, u, win.z0, win.w, win.h, wall, style, dice);
  windowIn(parts, openings.right, walls.right, 1.5, win.z0, win.w, win.h, wall, style, dice);
  const doorU = D - 1.6;
  const floor = hp + 0.05;
  doorIn(parts, openings.right, walls.right, doorU, floor, 0.95, 2.0, t / 2, look.door, style.trim);
  for (const u of spread(W, 2, W / 2.2)) windowIn(parts, openings.back, walls.back, u, win.z0, 0.85, 1.15, wall, { ...style, shutters: undefined }, dice);
  for (const [key, f] of Object.entries(walls) as [keyof typeof walls, WallFrame][]) {
    parts.push(...solidWall(f, hp, wallH, t, openings[key], look.wall, look.wallSurface));
  }
  if (look.wallSurface === 'siding') cladTrim(parts, walls, t, hp, top, style.trim, Object.values(walls));
  else for (const f of Object.values(walls)) parts.push(wallBox(f, f.length / 2, t / 2 + 0.02, hp + 0.06, [f.length + t, 0.05, 0.12], shade(look.foundation, 0.9)));

  const pitch = 28;
  const overhang = 0.55;
  const seat = roofSeat(top, t / 2, pitch);
  const roof = hipRoof({ w: W, d: D, top: seat, pitch, overhang, color: look.roof, surface: look.roofSurface });
  parts.push(...roof.parts);
  // Подшивка карниза — доска по периметру под свесом.
  for (const f of Object.values(walls)) parts.push(wallBox(f, f.length / 2, t / 2 + overhang / 2, roof.eave - 0.06, [f.length + 2 * overhang, overhang, 0.03], style.trim));
  const yf = -D / 2 + 0.7;
  frontDormer(parts, yf, roof.heightAt(0, yf), pitch, look.wallSurface === 'plaster' ? style.trim : look.wall, look.wallSurface, look.roof, look.roofSurface, style, dice);
  parts.push(
    ...porch(walls.right, {
      u: doorU,
      width: 1.6,
      depth: 1.2,
      floor,
      wallOut: t / 2,
      canopy: leanCanopy(seat, pitch, t / 2, overhang, t / 2 + 1.2 + 0.15, floor + 2.0),
      wood: dice.pick(['#8a6a4a', '#9a7650', '#7a6a5a']),
      roof: look.roof,
      roofSurface: look.roofSurface,
      trim: style.trim,
    }),
  );
  const cx = W * 0.18;
  const cy = D * 0.12;
  parts.push(...chimney(cx, cy, top - 0.3, roof.heightAt(cx, cy) + 0.75, '#a4523b'));
  return finish('hipped', parts, W, D, rect(W + t, D + t), { roof: look.roof, wall: look.wall });
}

/** Кирпичный дом (90–2010-е): вальмовая крыша из металла, большие белые окна, светлый декор кирпичом. */
function planBrick(o: HouseOptions = {}): HousePlan {
  const dice = new Dice((o.seed ?? 1) + 4000);
  const W = clamp(o.width ?? 9, 7.5, 13);
  const D = clamp(o.depth ?? 9.6, 7.5, 13);
  const red = dice.chance(0.55);
  const brick = red ? dice.pick(BRICK_RED) : dice.pick(BRICK_WHITE);
  const decor = red ? dice.pick(BRICK_WHITE) : dice.pick(BRICK_RED);
  const roofColor = dice.pick(['#5a3a2e', '#2f5f8f', '#3f6b4f', '#7c3a2e', '#4a4f55']);
  const hp = 0.55;
  const t = 0.38;
  const wallH = 2.9;
  const top = hp + wallH;
  const walls = rectWalls(W, D);
  const parts: HousePart[] = [plinth(W + t + 0.1, D + t + 0.1, hp, '#9d9a92')];
  const wall = { thickness: t };
  const style: WindowStyle = { trim: '#ffffff', accent: decor, frame: '#f7f7f4', top: 'none', apron: false, sash: 'modern' };
  const win = { z0: hp + 0.8, w: 1.3, h: 1.45 };
  const openings = { front: [] as Opening[], right: [] as Opening[], back: [] as Opening[], left: [] as Opening[] };
  const addWindow = (key: keyof typeof walls, u: number, w = win.w) => {
    const f = walls[key];
    windowIn(parts, openings[key], f, u, win.z0, w, win.h, wall, style, dice, '#f2f0ea');
    // Перемычка из кирпича другого цвета и белый отлив.
    parts.push(wallBox(f, u, t / 2 + 0.025, win.z0 + win.h + 0.13, [w + 0.34, 0.05, 0.24], decor, 'brick'));
    parts.push(wallBox(f, u, t / 2 + 0.06, win.z0 - 0.03, [w + 0.12, 0.16, 0.04], '#f2f2ef'));
  };
  for (const u of fitWindows(W, win.w, false, 4, 0.6)) addWindow('front', u);
  for (const u of spread(D, 2, D / 2.3)) addWindow('left', u);
  for (const u of spread(W, 2, W / 2.3)) addWindow('back', u, 1.1);
  addWindow('right', D - 2.2);
  const doorU = 2.0;
  doorIn(parts, openings.right, walls.right, doorU, hp + 0.05, 1.0, 2.1, t / 2, dice.pick(['#5a3a2e', '#3a3f45', '#7a5a3a']), '#f2f0ea');
  for (const [key, f] of Object.entries(walls) as [keyof typeof walls, WallFrame][]) {
    parts.push(...solidWall(f, hp, wallH, t, openings[key], brick, 'brick'));
    // Руст на углах и пояс под карнизом.
    for (let k = 0; hp + 0.2 + k * 0.33 < top - 0.3; k++) {
      const len = k % 2 ? 0.28 : 0.52;
      const z = hp + 0.2 + k * 0.33;
      parts.push(wallBox(f, len / 2 - t / 2, t / 2 + 0.02, z, [len, 0.04, 0.26], decor, 'brick'));
      parts.push(wallBox(f, f.length + t / 2 - len / 2, t / 2 + 0.02, z, [len, 0.04, 0.26], decor, 'brick'));
    }
    parts.push(wallBox(f, f.length / 2, t / 2 + 0.03, top - 0.18, [f.length + t, 0.06, 0.16], decor, 'brick'));
  }
  const overhang = 0.6;
  const pitch = 26;
  const seat = roofSeat(top, t / 2, pitch);
  const roof = hipRoof({ w: W, d: D, top: seat, pitch, overhang, color: roofColor, surface: 'metal' });
  parts.push(...roof.parts);
  for (const f of Object.values(walls)) parts.push(wallBox(f, f.length / 2, t / 2 + overhang / 2, roof.eave - 0.06, [f.length + 2 * overhang, overhang, 0.03], '#e9e7e1'));
  // Крыльцо с навесом на двух столбах.
  parts.push(
    ...porch(walls.right, {
      u: doorU,
      width: 2.0,
      depth: 1.5,
      floor: hp + 0.05,
      wallOut: t / 2,
      canopy: leanCanopy(seat, pitch, t / 2, overhang, t / 2 + 1.5 + 0.15, hp + 0.05 + 2.1),
      wood: '#8f8b84',
      roof: roofColor,
      roofSurface: 'metal',
      trim: '#e9e7e1',
    }),
  );
  const cx = -W * 0.2;
  const cy = D * 0.15;
  parts.push(...chimney(cx, cy, top - 0.3, roof.heightAt(cx, cy) + 0.8, decor));
  return finish('brick', parts, W, D, rect(W + t, D + t), { roof: roofColor, wall: brick });
}

// --- баня и юрта --------------------------------------------------------------------------------

/** Баня: маленький сруб с низкой дверью под широким свесом, окошко, железная труба, поленница. */
function planBanya(o: HouseOptions = {}): HousePlan {
  const dice = new Dice((o.seed ?? 1) + 5000);
  const W = clamp(o.width ?? 3.6, 3, 6);
  const D = clamp(o.depth ?? 4.6, 3.5, 7);
  const log = dice.pick(['#7d6f62', '#8a6a4a', '#857565', '#9a7650']);
  const hp = 0.25;
  const r = 0.11;
  const rows = 9;
  const top = logWallTop(hp, rows, r);
  const walls = rectWalls(W, D);
  const slate = dice.chance(0.6);
  const roofColor = slate ? dice.pick(SLATE) : dice.pick(METAL_ROOFS);
  const roofSurface: Surface = slate ? 'slate' : 'metal';
  const parts: HousePart[] = [plinth(W + 2 * r + 0.04, D + 2 * r + 0.04, hp, dice.pick(FOUNDATIONS))];
  const openings = { front: [] as Opening[], right: [] as Opening[], back: [] as Opening[], left: [] as Opening[] };
  const trim = shade(log, 1.15);
  const style: WindowStyle = { trim, accent: trim, frame: '#e9e4d8', top: 'simple', apron: false, sash: 'cross' };
  doorIn(parts, openings.front, walls.front, W / 2, hp + 0.2, 0.75, 1.65, r, shade(log, 0.9), trim);
  windowIn(parts, openings.right, walls.right, D * 0.66, hp + 1.05, 0.5, 0.42, { log: r }, style, dice);
  for (const [key, f] of Object.entries(walls) as [keyof typeof walls, WallFrame][]) {
    const half = key === 'left' || key === 'right';
    parts.push(...logWall(f, { z0: hp, rows, radius: r, half, overhang: 0.22, openings: openings[key], color: log, dice, far: o.far }));
  }
  const roof = gableRoof({ w: W, d: D, top: roofSeat(top, r, 30), pitch: 30, side: 0.35, front: 0.95, back: 0.3, color: roofColor, surface: roofSurface });
  parts.push(...roof.parts);
  const gable = { top: top - 0.15, ridge: roof.ridge, out: r - 0.02, side: 0.35, eave: roof.eave, color: shade(log, 0.85), surface: 'boards' as Surface, trim, towel: false };
  parts.push(...gableEnd(walls.front, { ...gable, overhang: 0.95 }));
  parts.push(...gableEnd(walls.back, { ...gable, overhang: 0.3 }));
  parts.push(...pipe(W * 0.2, D * 0.25, top - 0.2, roof.ridge + 0.55));
  // Ступенька у двери и поленница вдоль левой стены под свесом.
  parts.push(wallBox(walls.front, W / 2, r + 0.25, 0.1, [1.0, 0.5, 0.2], shade(log, 1.05), 'boards'));
  const wood = '#b48a5a';
  for (let row = 0; row < (o.far ? 0 : 4); row++) {
    for (let i = 0; i < 12; i++) {
      const u = 0.5 + i * 0.27 + (row % 2) * 0.12;
      if (u > D - 0.4) continue;
      const z = 0.09 + row * 0.15;
      parts.push({
        type: 'cylinder',
        from: at(walls.left, u, r + 0.12, z),
        to: at(walls.left, u, r + 0.52, z),
        radius: 0.075,
        segments: 6,
        color: shade(wood, dice.range(0.85, 1.1)),
        surface: 'wood',
        caps: '#d9b98a',
      });
    }
  }
  return finish('banya', parts, W, D, rect(W + 2 * r, D + 2 * r), { roof: roofColor, wall: log });
}

/** Юрта (тирмә): войлок на решётчатых стенах, купол с шаңыраҡом, орнаментный пояс, расписная дверь. */
function planYurt(o: HouseOptions = {}): HousePlan {
  const dice = new Dice((o.seed ?? 1) + 6000);
  const size = clamp(Math.min(o.width ?? 6.4, o.depth ?? 6.4), 5, 8.5);
  const R = size / 2;
  const felt = dice.pick(FELT);
  const band = dice.pick(BAND);
  const wallH = 1.7;
  const crown = 0.55;
  const roofTop = wallH + (R - crown) * 0.45;
  const rope = '#6b5640';
  const parts: HousePart[] = [
    { type: 'cylinder', from: [0, 0, 0], to: [0, 0, wallH], radius: R, segments: 40, color: felt, surface: 'felt', caps: false },
    // Нижняя полоса (подол) темнее — от земли.
    { type: 'cylinder', from: [0, 0, 0], to: [0, 0, 0.18], radius: R + 0.01, segments: 40, color: shade(felt, 0.82), surface: 'felt', caps: false },
    // Орнаментный пояс.
    { type: 'cylinder', from: [0, 0, 1.2], to: [0, 0, 1.5], radius: R + 0.015, segments: 40, color: band, surface: 'ornament', caps: false },
    // Купол.
    { type: 'cylinder', from: [0, 0, wallH - 0.02], to: [0, 0, roofTop], radius: R + 0.08, radiusTop: crown, segments: 40, color: felt, surface: 'felt', caps: false },
    // Шаңыраҡ: обод и перекрестья.
    { type: 'cylinder', from: [0, 0, roofTop - 0.02], to: [0, 0, roofTop + 0.12], radius: crown + 0.02, segments: 24, color: '#8a5a32', surface: 'wood', caps: false },
    { type: 'box', center: [0, 0, roofTop + 0.1], size: [crown * 2, 0.08, 0.06], color: '#8a5a32' },
    { type: 'box', center: [0, 0, roofTop + 0.1], size: [0.08, crown * 2, 0.06], color: '#8a5a32' },
    { type: 'cylinder', from: [0, 0, roofTop - 0.05], to: [0, 0, roofTop + 0.0], radius: crown, segments: 24, color: '#3a3430', caps: '#3a3430' },
  ];
  // Обвязка: верёвки по стене и по куполу.
  for (const z of [0.62, 1.66]) parts.push({ type: 'cylinder', from: [0, 0, z], to: [0, 0, z + 0.04], radius: R + 0.03, segments: 40, color: rope, caps: false });
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 + 0.13;
    const lo: Vec3 = [Math.cos(a) * (R + 0.1), Math.sin(a) * (R + 0.1), wallH + 0.02];
    const hi: Vec3 = [Math.cos(a) * (crown + 0.05), Math.sin(a) * (crown + 0.05), roofTop + 0.03];
    parts.push({ type: 'cylinder', from: lo, to: hi, radius: 0.025, segments: 4, color: rope, caps: false });
  }
  // Дверь на юг (к улице): расписная створка в деревянной коробке.
  const f: WallFrame = { x: -0.5, y: -R, tx: 1, ty: 0, length: 1 };
  parts.push(wallBox(f, 0.5, 0.06, 0.84, [0.86, 0.06, 1.5], band, 'ornament'));
  parts.push(wallBox(f, 0.04, 0.05, 0.85, [0.1, 0.12, 1.66], '#8a5a32', 'wood'));
  parts.push(wallBox(f, 0.96, 0.05, 0.85, [0.1, 0.12, 1.66], '#8a5a32', 'wood'));
  parts.push(wallBox(f, 0.5, 0.05, 1.66, [1.02, 0.12, 0.1], '#8a5a32', 'wood'));
  parts.push(wallBox(f, 0.5, 0.25, 0.05, [1.2, 0.5, 0.1], '#8a6a4a', 'boards'));
  const footprint: [number, number][] = Array.from({ length: 16 }, (_, i) => {
    const a = (i / 16) * Math.PI * 2;
    return [Math.cos(a) * R, Math.sin(a) * R];
  });
  return finish('yurt', parts, size, size, footprint);
}

// --- каталог ------------------------------------------------------------------------------------

const HOME_MODELS: HouseModel[] = [
  {
    id: 'izba',
    group: 'house',
    short: 'Изба',
    name: 'Изба (бура)',
    summary: 'сруб · 1 этаж',
    description:
      'Бревенчатая четырёхстенка фронтоном на улицу: два-три окна с резными наличниками и ставнями, тесовый фронтон со слуховым окошком и «полотенцем», крыльцо со двора.',
    width: { min: 5, value: 6, max: 9.5 },
    depth: { min: 5, value: 6.6, max: 10.5 },
    plan: withGround(planIzba),
  },
  {
    id: 'pyatistenok',
    group: 'house',
    short: 'Пятистенок',
    name: 'Пятистенок',
    summary: 'сруб с сенями · 1 этаж',
    description:
      'Длинный сруб с поперечной стеной: её брёвна торчат на боковых стенах. Три окна на улицу, сзади дощатые сени с односкатной крышей и крыльцом.',
    width: { min: 5.5, value: 6.6, max: 10 },
    depth: { min: 8, value: 10, max: 14 },
    plan: withGround(planPyatistenok),
  },
  {
    id: 'veranda',
    group: 'house',
    short: 'С верандой',
    name: 'Дом с верандой',
    summary: 'обшит доской · 1 этаж',
    description:
      'Дом, обшитый крашеной доской (синий, бирюза, зелёный, охра), с угловыми досками и резными наличниками; сбоку — застеклённая веранда с частыми белыми рамами.',
    width: { min: 6, value: 7, max: 11 },
    depth: { min: 7, value: 8.6, max: 12.5 },
    plan: withGround(planVeranda),
  },
  {
    id: 'hipped',
    group: 'house',
    short: 'Вальмовый',
    name: 'Дом под вальмовой крышей',
    summary: 'обшит или оштукатурен · 1 этаж',
    description:
      'Широкий дом 70–80-х длинной стороной на улицу: четырёхскатная крыша со светёлкой — слуховым окном на скате, четыре окна со ставнями, крыльцо с козырьком сбоку.',
    width: { min: 7, value: 8.4, max: 13 },
    depth: { min: 6.5, value: 7.6, max: 12 },
    plan: withGround(planHipped),
  },
  {
    id: 'brick',
    group: 'house',
    short: 'Кирпичный',
    name: 'Кирпичный дом',
    summary: 'кирпич · 1 этаж',
    description:
      'Современный дом из красного или белого кирпича: декор кирпичом другого цвета (углы, перемычки, пояс), большие белые окна, вальмовая крыша из металла, крыльцо под навесом.',
    width: { min: 7.5, value: 9, max: 13 },
    depth: { min: 7.5, value: 9.6, max: 13 },
    plan: withGround(planBrick),
  },
  {
    id: 'banya',
    group: 'small',
    short: 'Баня',
    name: 'Баня',
    summary: 'сруб · хозпостройка',
    description: 'Маленький сруб с низкой дверью под широким свесом, окошко, железная труба; вдоль стены — поленница.',
    width: { min: 3, value: 3.6, max: 6 },
    depth: { min: 3.5, value: 4.6, max: 7 },
    plan: withGround(planBanya),
  },
  {
    id: 'yurt',
    group: 'public',
    short: 'Юрта',
    name: 'Юрта (тирмә)',
    summary: 'войлок · для праздника и музея',
    description:
      'Башкирская юрта: войлок на решётчатых стенах, купол с шаңыраҡом, пояс с орнаментом, расписная дверь на юг, обвязка верёвками.',
    width: { min: 5, value: 6.4, max: 8.5 },
    depth: { min: 5, value: 6.4, max: 8.5 },
    plan: withGround(planYurt),
  },
];

/** Весь каталог: жилые дома, общественные здания, мелкие постройки — по разделам. */
export const HOUSE_MODELS: HouseModel[] = MODEL_GROUPS.flatMap(({ group }) =>
  // Юрта — в конце общественных (первой в разделе идёт школа).
  [...HOME_MODELS.filter((m) => m.id !== 'yurt'), ...PUBLIC_MODELS, ...HOME_MODELS.filter((m) => m.id === 'yurt')].filter((m) => m.group === group),
);

export function findHouseModel(id: string): HouseModel | undefined {
  return HOUSE_MODELS.find((m) => m.id === id);
}
