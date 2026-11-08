// Общественные здания и мелкие постройки башкирской деревни: школа (лицей), музей, сельский клуб
// (дом культуры), контора (администрация), магазин, универмаг; на улице и во дворе — остановка,
// уличный туалет, колодец. Те же правила, что у жилых домов: x — вдоль уличного фасада, улица — со
// стороны −y, зерно выбирает окраску и мелочи. Надписи — таблички (рисуются текстурой), у школы и
// конторы — флаги Башкортостана и России.

import {
  at,
  Dice,
  flagpole,
  gableEnd,
  gableRoof,
  hipRoof,
  leanToRoof,
  logWall,
  plinth,
  porch,
  rectWalls,
  roofSeat,
  rotatePartsZ,
  shade,
  slab,
  solidWall,
  wallBox,
  wallSign,
  wallSlab,
  type HousePart,
  type Opening,
  type Surface,
  type WallFrame,
  type WindowStyle,
} from './houseParts';
import type { HouseModel, HouseOptions, HousePlan } from './houseModels';
import { BAND, BRICK_RED, BRICK_WHITE, clamp, doorIn, finish, fitWindows, LOGS, METAL_ROOFS, PAINTS, rect, SLATE, windowIn, withGround } from './modelKit';

type Walls = ReturnType<typeof rectWalls>;
type WallKey = keyof Walls;
const emptyOpenings = (): Record<WallKey, Opening[]> => ({ front: [], right: [], back: [], left: [] });

/** Окна рядами по этажам; skip — пропустить место (вход, выступ). */
function windowRows(
  parts: HousePart[],
  openings: Opening[],
  f: WallFrame,
  us: readonly number[],
  o: { floors: number; base: number; floorHeight: number; sill: number; w: number; h: number; t: number; style: WindowStyle; dice: Dice },
  skip?: (u: number, floor: number) => boolean,
): void {
  for (let floor = 0; floor < o.floors; floor++) {
    for (const u of us) {
      if (skip?.(u, floor)) continue;
      windowIn(parts, openings, f, u, o.base + floor * o.floorHeight + o.sill, o.w, o.h, { thickness: o.t }, o.style, o.dice, '#f2f0ea');
    }
  }
}

/** Карниз-пояс по верху стен. */
function cornice(parts: HousePart[], walls: Walls, t: number, z: number, color: string, surface: Surface, h = 0.3): void {
  for (const f of Object.values(walls)) parts.push(wallBox(f, f.length / 2, t / 2 + 0.05, z, [f.length + t + 0.1, 0.1, h], color, surface));
}

/** Перемычки и отливы у окон кирпичного здания (декор кирпичом другого цвета). */
function brickWindowTrim(parts: HousePart[], f: WallFrame, us: readonly number[], o: { floors: number; base: number; floorHeight: number; sill: number; w: number; h: number; t: number }, decor: string, skip?: (u: number, floor: number) => boolean): void {
  for (let floor = 0; floor < o.floors; floor++) {
    for (const u of us) {
      if (skip?.(u, floor)) continue;
      const z0 = o.base + floor * o.floorHeight + o.sill;
      parts.push(wallBox(f, u, o.t / 2 + 0.025, z0 + o.h + 0.14, [o.w + 0.32, 0.05, 0.24], decor, 'brick'));
      parts.push(wallBox(f, u, o.t / 2 + 0.06, z0 - 0.03, [o.w + 0.12, 0.16, 0.04], '#f2f2ef'));
    }
  }
}

// --- школа, контора ------------------------------------------------------------------------------

/** Школа (лицей): два-три этажа кирпича, вход в выступе с надписью на аттике, флаги перед входом. */
function planSchool(o: HouseOptions): HousePlan {
  const dice = new Dice((o.seed ?? 1) + 7000);
  const W = clamp(o.width ?? 32, 22, 50);
  const D = clamp(o.depth ?? 12, 10, 18);
  const floors = W >= 40 ? 3 : 2;
  const fh = 3.4;
  const hp = 0.6;
  const t = 0.45;
  const look = dice.pick(['white', 'white', 'plaster', 'red'] as const);
  const wall = look === 'white' ? dice.pick(BRICK_WHITE) : look === 'red' ? dice.pick(BRICK_RED) : dice.pick(['#e8d39a', '#e6c88a', '#dfe3e6']);
  const surface: Surface = look === 'plaster' ? 'plaster' : 'brick';
  const decor = look === 'white' ? dice.pick(BRICK_RED) : look === 'red' ? dice.pick(BRICK_WHITE) : '#f4f1e8';
  const roofColor = dice.pick(['#3a5f86', '#3f6b4f', '#2f6f6a', '#5a3e32']);
  const top = hp + floors * fh;
  const walls = rectWalls(W, D);
  const parts: HousePart[] = [plinth(W + t + 0.1, D + t + 0.1, hp, '#9d9a92')];
  const style: WindowStyle = { trim: '#ffffff', accent: decor, frame: '#f7f7f4', top: 'none', apron: false, sash: dice.chance(0.6) ? 'modern' : 'cross' };
  const rows = { floors, base: hp, floorHeight: fh, sill: 0.9, w: 1.5, h: 1.8, t, style, dice };
  const openings = emptyOpenings();
  // Вход — в выступе посередине фасада; окна фасада там не нужны.
  const Rw = 7.2;
  const Rd = 1.8;
  const inRisalit = (u: number) => Math.abs(u - W / 2) < Rw / 2 + 0.9;
  const lines: Record<WallKey, number[]> = {
    front: fitWindows(W, rows.w, false, 30, 1.2),
    back: fitWindows(W, rows.w, false, 30, 1.2),
    left: fitWindows(D, rows.w, false, 6, 1.2),
    right: fitWindows(D, rows.w, false, 6, 1.2),
  };
  for (const key of Object.keys(walls) as WallKey[]) {
    const skip = key === 'front' ? (u: number) => inRisalit(u) : undefined;
    windowRows(parts, openings[key], walls[key], lines[key], rows, skip);
    if (surface === 'brick') brickWindowTrim(parts, walls[key], lines[key], rows, decor, skip);
    parts.push(...solidWall(walls[key], hp, top - hp, t, openings[key], wall, surface));
  }
  cornice(parts, walls, t, top - 0.15, decor, surface);

  // Выступ со входом: стена с дверью и окнами, плоская крыша, надпись на аттике.
  const rWalls = rectWalls(Rw, Rd, 0, -D / 2 - Rd / 2);
  const rTop = top + 0.9;
  const rOpen: Opening[] = [];
  doorIn(parts, rOpen, rWalls.front, Rw / 2, hp + 0.05, 1.9, 2.5, t / 2, dice.pick(['#6b4a33', '#3a3f45', '#2f5f8f']), '#f2f0ea');
  windowRows(parts, rOpen, rWalls.front, [Rw / 2 - 1.6, Rw / 2 + 1.6], { ...rows, w: 1.2 }, (_u, floor) => floor === 0);
  parts.push(plinth(Rw + t + 0.1, Rd + 0.1, hp, '#9d9a92', 0, -D / 2 - Rd / 2));
  parts.push(...solidWall(rWalls.front, hp, rTop - hp, t, rOpen, wall, surface));
  for (const f of [rWalls.left, rWalls.right]) parts.push(...solidWall(f, hp, rTop - hp, t, [], wall, surface));
  parts.push({ type: 'box', center: [0, -D / 2 - Rd / 2 + 0.2, rTop + 0.06], size: [Rw + t + 0.2, Rd + 0.6, 0.12], color: decor, surface });
  parts.push(...wallSign(rWalls.front, Rw / 2, t / 2, top - 0.1 + 0.55, Math.min(4.6, Rw - 1.6), 0.8, floors === 3 ? 'ЛИЦЕЙ' : 'ШКОЛА', '#1f5fa8', '#ffffff'));
  parts.push(
    ...porch(rWalls.front, {
      u: Rw / 2,
      width: 3.4,
      depth: 2.0,
      floor: hp + 0.05,
      wallOut: t / 2,
      canopy: { kind: 'gable', z: hp + 3.05 },
      wood: '#9d978b',
      roof: roofColor,
      roofSurface: 'metal',
      trim: '#ecebe6',
    }),
  );

  const pitch = 22;
  parts.push(...hipRoof({ w: W, d: D, top: roofSeat(top, t / 2, pitch), pitch, overhang: 0.6, color: roofColor, surface: 'metal' }).parts);
  // Флаги Башкортостана и России перед входом.
  const fy = -D / 2 - Rd - 3.6;
  parts.push(...flagpole(-4.2, fy, 0, 8, 'bashkortostan'), ...flagpole(4.2, fy, 0, 8, 'russia'));
  return finish('school', parts, W, D, rect(W + t, D + t));
}

/** Контора (администрация сельского поселения): два этажа, крыльцо с козырьком, вывеска, флаги. */
function planOffice(o: HouseOptions): HousePlan {
  const dice = new Dice((o.seed ?? 1) + 10000);
  const W = clamp(o.width ?? 16, 11, 26);
  const D = clamp(o.depth ?? 11, 9, 15);
  const plastered = dice.chance(0.4);
  const wall = plastered ? dice.pick(['#ece6d6', '#e8dcc0', '#dfe6e6']) : dice.pick(BRICK_WHITE);
  const surface: Surface = plastered ? 'plaster' : 'brick';
  const decor = plastered ? '#f7f5ef' : dice.pick(BRICK_RED);
  const roofColor = dice.pick(['#3a5f86', '#3f6b4f', '#5a3e32', '#7c3a2e']);
  const floors = 2;
  const fh = 3.2;
  const hp = 0.6;
  const t = 0.42;
  const top = hp + floors * fh;
  const walls = rectWalls(W, D);
  const parts: HousePart[] = [plinth(W + t + 0.1, D + t + 0.1, hp, '#9d9a92')];
  const style: WindowStyle = { trim: '#ffffff', accent: decor, frame: '#f7f7f4', top: 'none', apron: false, sash: 'modern' };
  const rows = { floors, base: hp, floorHeight: fh, sill: 0.85, w: 1.3, h: 1.5, t, style, dice };
  const openings = emptyOpenings();
  const door = (u: number, floor: number) => floor === 0 && Math.abs(u - W / 2) < 1.4;
  const lines: Record<WallKey, number[]> = {
    front: fitWindows(W, rows.w, false, 14, 1.0),
    back: fitWindows(W, rows.w, false, 14, 1.0),
    left: fitWindows(D, rows.w, false, 5, 1.0),
    right: fitWindows(D, rows.w, false, 5, 1.0),
  };
  doorIn(parts, openings.front, walls.front, W / 2, hp + 0.05, 1.4, 2.4, t / 2, dice.pick(['#5a3a2e', '#3a3f45', '#7a5a3a']), '#f2f0ea');
  for (const key of Object.keys(walls) as WallKey[]) {
    const skip = key === 'front' ? door : undefined;
    windowRows(parts, openings[key], walls[key], lines[key], rows, skip);
    if (!plastered) brickWindowTrim(parts, walls[key], lines[key], rows, decor, skip);
    parts.push(...solidWall(walls[key], hp, top - hp, t, openings[key], wall, surface));
  }
  cornice(parts, walls, t, top - 0.15, decor, surface);
  parts.push(
    ...porch(walls.front, {
      u: W / 2,
      width: 2.8,
      depth: 1.8,
      floor: hp + 0.05,
      wallOut: t / 2,
      canopy: { kind: 'gable', z: hp + 2.85 },
      wood: '#9d978b',
      roof: roofColor,
      roofSurface: 'metal',
      trim: '#ecebe6',
    }),
  );
  parts.push(...wallSign(walls.front, W / 2, t / 2, hp + fh + 0.3, 3.8, 0.6, 'АДМИНИСТРАЦИЯ\nСЕЛЬСКОГО ПОСЕЛЕНИЯ', '#1f5fa8', '#ffffff'));
  const pitch = 24;
  parts.push(...hipRoof({ w: W, d: D, top: roofSeat(top, t / 2, pitch), pitch, overhang: 0.55, color: roofColor, surface: 'metal' }).parts);
  const fy = -D / 2 - 2.6;
  parts.push(...flagpole(-2.4, fy, 0, 7, 'bashkortostan'), ...flagpole(2.4, fy, 0, 7, 'russia'));
  return finish('office', parts, W, D, rect(W + t, D + t));
}

// --- музей, клуб ---------------------------------------------------------------------------------

/** Музей в купеческом доме: красный кирпич с белым декором (пилястры, карниз, арочные окна), фронтон с круглым окном. */
function planMuseum(o: HouseOptions): HousePlan {
  const dice = new Dice((o.seed ?? 1) + 8000);
  const W = clamp(o.width ?? 13, 10, 20);
  const D = clamp(o.depth ?? 11, 8, 16);
  const brick = dice.pick(BRICK_RED);
  const decor = dice.pick(['#f1ece0', '#efe6cf']);
  const roofColor = dice.pick(['#3f6b4f', '#2f6f6a', '#5a3e32', '#3a5f86']);
  const hp = 0.8;
  const t = 0.6;
  const wallH = 3.8;
  const top = hp + wallH;
  const walls = rectWalls(W, D);
  const parts: HousePart[] = [plinth(W + t + 0.12, D + t + 0.12, hp, '#b3ab9c')];
  const style: WindowStyle = { trim: decor, accent: decor, frame: '#f4f1e8', top: 'arch', apron: false, sash: 'cross' };
  const ww = 1.1;
  const wh = 2.0;
  const z0 = hp + 0.8;
  const openings = emptyOpenings();
  const lines: Record<WallKey, number[]> = {
    front: [W / 2 - 2.3, W / 2 + 2.3, ...(W >= 13 ? [W / 2 - 4.4, W / 2 + 4.4] : [])].filter((u) => u > 0.9 && u < W - 0.9),
    back: fitWindows(W, ww, false, 3, 1.2),
    left: fitWindows(D, ww, false, 5, 1.0),
    right: fitWindows(D, ww, false, 5, 1.0),
  };
  doorIn(parts, openings.front, walls.front, W / 2, hp + 0.02, 1.4, 2.5, t / 2, '#5a3a2a', decor);
  for (const key of Object.keys(walls) as WallKey[]) {
    const f = walls[key];
    for (const u of lines[key]) windowIn(parts, openings[key], f, u, z0, ww, wh, { thickness: t }, style, dice, '#f2f0ea');
    parts.push(...solidWall(f, hp, wallH, t, openings[key], brick, 'brick'));
    // Пилястры на углах и между окнами, пояс над цоколем.
    const us = [...lines[key], ...(key === 'front' ? [W / 2] : [])].sort((a, b) => a - b);
    const between = us.slice(1).map((u, i) => (u + us[i]!) / 2);
    for (const u of [0.25, f.length - 0.25, ...between]) parts.push(wallBox(f, u, t / 2 + 0.04, hp + wallH / 2, [0.42, 0.08, wallH], decor, 'plaster'));
    parts.push(wallBox(f, f.length / 2, t / 2 + 0.03, hp + 0.1, [f.length + t, 0.06, 0.2], decor, 'plaster'));
  }
  cornice(parts, walls, t, top - 0.2, decor, 'plaster', 0.4);
  const pitch = 30;
  const roof = gableRoof({ w: W, d: D, top: roofSeat(top, t / 2, pitch), pitch, side: 0.5, front: 0.5, back: 0.4, color: roofColor, surface: 'metal' });
  parts.push(...roof.parts);
  const gable = { top, ridge: roof.ridge, out: t / 2, side: 0.5, eave: roof.eave, color: brick, surface: 'brick' as Surface, trim: decor, towel: false };
  parts.push(...gableEnd(walls.front, { ...gable, overhang: 0.5 }));
  parts.push(...gableEnd(walls.back, { ...gable, overhang: 0.4 }));
  // Круглое окно во фронтоне и надпись под ним.
  const rise = roof.ridge - top;
  const zc = top + rise * 0.5;
  parts.push({ type: 'cylinder', from: at(walls.front, W / 2, t / 2 - 0.02, zc), to: at(walls.front, W / 2, t / 2 + 0.08, zc), radius: 0.5, segments: 20, color: decor });
  parts.push({ type: 'cylinder', from: at(walls.front, W / 2, t / 2 + 0.08, zc), to: at(walls.front, W / 2, t / 2 + 0.1, zc), radius: 0.38, segments: 20, color: '#2e3c48' });
  parts.push(...wallSign(walls.front, W / 2, t / 2, top + 0.42, 2.6, 0.55, 'МУЗЕЙ', '#7a1f1f', '#f6e7c1'));
  parts.push(
    ...porch(walls.front, {
      u: W / 2,
      width: 2.6,
      depth: 1.6,
      floor: hp + 0.02,
      wallOut: t / 2,
      canopy: { kind: 'gable', z: hp + 2.95 },
      wood: '#9d978b',
      roof: roofColor,
      roofSurface: 'metal',
      trim: decor,
    }),
  );
  return finish('museum', parts, W, D, rect(W + t, D + t));
}

/** Сельский клуб (дом культуры): зал под двускатной крышей, портик с колоннами и фронтоном на улицу. */
function planClub(o: HouseOptions): HousePlan {
  const dice = new Dice((o.seed ?? 1) + 9000);
  const W = clamp(o.width ?? 16, 12, 26);
  const D = clamp(o.depth ?? 22, 14, 32);
  const wall = dice.pick(['#ead9a8', '#e9d8b9', '#dfe6e6', '#f0e2c6', '#cfe0d6']);
  const trim = '#fbfaf6';
  const roofColor = dice.pick(METAL_ROOFS);
  const hp = 0.6;
  const t = 0.5;
  const wallH = 6.2;
  const top = hp + wallH;
  const Pd = 3.2;
  const walls = rectWalls(W, D);
  const parts: HousePart[] = [plinth(W + t + 0.1, D + t + 0.1, hp, '#a8a397')];
  const style: WindowStyle = { trim, accent: trim, frame: '#f7f7f4', top: 'simple', apron: false, sash: 'cross' };
  const openings = emptyOpenings();
  // Под портиком — три входа, над ними окна второго света.
  const doors = W >= 15 ? [W / 2 - 3.4, W / 2, W / 2 + 3.4] : [W / 2];
  for (const u of doors) {
    doorIn(parts, openings.front, walls.front, u, hp + 0.02, 1.5, 2.6, t / 2, dice.pick(['#6b4a33', '#5a3a2a']), trim);
    windowIn(parts, openings.front, walls.front, u, hp + 3.5, 1.2, 1.6, { thickness: t }, style, dice);
  }
  for (const key of ['left', 'right'] as const) {
    for (const u of fitWindows(D, 1.3, false, 9, 1.6)) windowIn(parts, openings[key], walls[key], u, hp + 1.4, 1.3, 3.0, { thickness: t }, style, dice);
  }
  for (const u of fitWindows(W, 1.2, false, 3, 2)) windowIn(parts, openings.back, walls.back, u, hp + 2.2, 1.2, 1.4, { thickness: t }, style, dice);
  for (const key of Object.keys(walls) as WallKey[]) parts.push(...solidWall(walls[key], hp, wallH, t, openings[key], wall, 'plaster'));
  cornice(parts, walls, t, top - 0.2, trim, 'plaster', 0.4);

  // Портик: подиум со ступенями, колонны, балка с надписью, фронтон; крыша зала продолжается над ним.
  const py = -D / 2 - Pd / 2;
  parts.push({ type: 'box', center: [0, py, hp / 2], size: [W, Pd, hp], color: '#c9c3b6', surface: 'plaster' });
  for (let k = 1; k <= 3; k++) {
    const h = hp - (k * hp) / 4;
    parts.push({ type: 'box', center: [0, -D / 2 - Pd - 0.17 * k + 0.085, h / 2], size: [W - 1.2, 0.34, h], color: '#c9c3b6', surface: 'plaster' });
  }
  const cols = W >= 18 ? 6 : 4;
  const colY = -D / 2 - Pd + 0.45;
  for (let i = 0; i < cols; i++) {
    const x = -W / 2 + 0.7 + (i * (W - 1.4)) / (cols - 1);
    parts.push({ type: 'box', center: [x, colY, hp + 0.1], size: [0.75, 0.75, 0.2], color: trim, surface: 'plaster' });
    parts.push({ type: 'cylinder', from: [x, colY, hp + 0.2], to: [x, colY, top - 0.9], radius: 0.28, radiusTop: 0.25, segments: 14, color: trim });
    parts.push({ type: 'box', center: [x, colY, top - 0.8], size: [0.8, 0.8, 0.2], color: trim, surface: 'plaster' });
  }
  const pf: WallFrame = { x: -W / 2, y: colY - 0.4, tx: 1, ty: 0, length: W };
  parts.push(wallBox(pf, W / 2, -0.4, top - 0.35, [W + 0.2, 0.8, 0.7], trim, 'plaster'));
  parts.push(...wallSign(pf, W / 2, 0, top - 0.35, Math.min(W * 0.6, 9), 0.5, 'ДОМ КУЛЬТУРЫ', dice.pick(['#8a1f1f', '#1f4f8a', '#2f6f4f']), '#ffffff'));
  const pitch = 25;
  const roof = gableRoof({ w: W, d: D, top: roofSeat(top, t / 2, pitch), pitch, side: 0.6, front: Pd + 0.3, back: 0.5, color: roofColor, surface: 'metal' });
  parts.push(...roof.parts);
  const gable = { top, ridge: roof.ridge, side: 0.6, eave: roof.eave, color: trim, surface: 'plaster' as Surface, trim, towel: false };
  parts.push(...gableEnd(pf, { ...gable, out: 0, overhang: 0.7 }));
  parts.push(...gableEnd(walls.back, { ...gable, color: wall, out: t / 2, overhang: 0.5 }));
  // Звезда-розетка во фронтоне.
  const zc = top + (roof.ridge - top) * 0.4;
  parts.push({ type: 'cylinder', from: at(pf, W / 2, 0, zc), to: at(pf, W / 2, 0.06, zc), radius: 0.6, segments: 5, color: dice.pick(['#c8463a', '#e2b23a']) });
  return finish('club', parts, W, D, rect(W + t, D + t));
}

// --- магазины ------------------------------------------------------------------------------------

/** Магазин: одноэтажный, витрина и дверь с козырьком на улицу, вывеска под карнизом, двускатная крыша вдоль улицы. */
function planShop(o: HouseOptions): HousePlan {
  const dice = new Dice((o.seed ?? 1) + 11000);
  const W = clamp(o.width ?? 9, 6, 15);
  const D = clamp(o.depth ?? 8, 6, 12);
  const brick = dice.chance(0.45);
  const wall = brick ? dice.pick([...BRICK_WHITE, ...BRICK_RED]) : dice.pick(PAINTS);
  const surface: Surface = brick ? 'brick' : 'siding';
  const trim = '#f4f1e8';
  const roofColor = dice.pick([...METAL_ROOFS, ...SLATE]);
  const hp = 0.45;
  const t = 0.3;
  const wallH = 3.2;
  const top = hp + wallH;
  const walls = rectWalls(W, D);
  const parts: HousePart[] = [plinth(W + t + 0.08, D + t + 0.08, hp, '#a29d93')];
  const style: WindowStyle = { trim, accent: trim, frame: '#f7f7f4', top: 'none', apron: false, sash: 'modern' };
  const openings = emptyOpenings();
  const doorU = W * 0.28;
  doorIn(parts, openings.front, walls.front, doorU, hp + 0.02, 1.0, 2.1, t / 2, dice.pick(['#7a4f33', '#3a3f45', '#4f6f8f']), trim);
  windowIn(parts, openings.front, walls.front, W * 0.66, hp + 0.7, Math.min(2.6, W * 0.36), 1.6, { thickness: t }, style, dice, '#f2f0ea');
  windowIn(parts, openings.right, walls.right, D * 0.4, hp + 0.9, 1.0, 1.2, { thickness: t }, style, dice);
  windowIn(parts, openings.left, walls.left, D * 0.6, hp + 0.9, 1.0, 1.2, { thickness: t }, style, dice);
  doorIn(parts, openings.back, walls.back, W * 0.7, hp + 0.02, 0.9, 2.0, t / 2, '#6b5a48', trim);
  for (const key of Object.keys(walls) as WallKey[]) parts.push(...solidWall(walls[key], hp, wallH, t, openings[key], wall, surface));
  const label = dice.pick(['МАГАЗИН', 'ПРОДУКТЫ', 'МАГАЗИН\nПРОДУКТЫ']);
  parts.push(...wallSign(walls.front, W / 2, t / 2, top - 0.48, Math.min(W - 1, 5), label.includes('\n') ? 0.6 : 0.5, label, dice.pick(['#1f5fa8', '#b3261e', '#2f7d3a']), '#ffffff'));
  parts.push(
    ...porch(walls.front, {
      u: doorU,
      width: 1.8,
      depth: 1.3,
      floor: hp + 0.02,
      wallOut: t / 2,
      canopy: { kind: 'lean', high: hp + 2.5, low: hp + 2.3 },
      wood: '#9d978b',
      roof: roofColor,
      roofSurface: 'metal',
      trim,
    }),
  );
  // Крыша вдоль улицы: строим с коньком вдоль y и поворачиваем на 90°.
  const pitch = 25;
  const roof = gableRoof({ w: D, d: W, top: roofSeat(top, t / 2, pitch), pitch, side: 0.5, front: 0.4, back: 0.4, color: roofColor, surface: dice.chance(0.5) ? 'metal' : 'slate' });
  parts.push(...rotatePartsZ(roof.parts, Math.PI / 2));
  const gable = { top, ridge: roof.ridge, out: t / 2, side: 0.5, eave: roof.eave, color: wall, surface: (brick ? 'brick' : 'boards') as Surface, trim, towel: false, overhang: 0.4 };
  parts.push(...gableEnd(walls.left, gable), ...gableEnd(walls.right, gable));
  return finish('shop', parts, W, D, rect(W + t, D + t));
}

/** Универмаг: два этажа, витрины во всю ширину первого этажа, плоская крыша с парапетом и большой вывеской. */
function planStore(o: HouseOptions): HousePlan {
  const dice = new Dice((o.seed ?? 1) + 12000);
  const W = clamp(o.width ?? 24, 14, 40);
  const D = clamp(o.depth ?? 15, 10, 22);
  const wall = dice.pick(['#e7e1d3', '#d9d4c7', '#e3d7b8', '#cfd8dc']);
  const accent = dice.pick(['#1f5fa8', '#b3261e', '#2f6f6a']);
  const hp = 0.3;
  const t = 0.4;
  const f1 = 4.2;
  const f2 = 3.4;
  const top = hp + f1 + f2;
  const walls = rectWalls(W, D);
  const parts: HousePart[] = [plinth(W + t + 0.1, D + t + 0.1, hp, '#9d9a92')];
  const style: WindowStyle = { trim: '#ffffff', accent, frame: '#f7f7f4', top: 'none', apron: false, sash: 'modern' };
  const openings = emptyOpenings();
  const f = walls.front;
  // Витрины первого этажа: стёкла с тёмными стойками по обе стороны от входа.
  const zs = hp + 0.5;
  const hs = 2.9;
  const lit = dice.next();
  const frame = '#3a3f45';
  for (const [from, to] of [
    [1.0, W / 2 - 1.3],
    [W / 2 + 1.3, W - 1.0],
  ] as const) {
    if (to - from < 1) continue;
    openings.front.push({ u0: from, u1: to, z0: zs, z1: zs + hs });
    const n = Math.max(1, Math.round((to - from) / 2.2));
    const pane = (to - from) / n;
    for (let i = 0; i < n; i++) {
      parts.push({ type: 'glass', center: at(f, from + pane * (i + 0.5), t / 2 - 0.12, zs + hs / 2), size: [pane - 0.06, 0.02, hs], angle: 0, lit, curtain: false });
    }
    for (let i = 0; i <= n; i++) parts.push(wallBox(f, from + pane * i, t / 2 - 0.08, zs + hs / 2, [0.08, 0.08, hs], frame));
    parts.push(wallBox(f, (from + to) / 2, t / 2 - 0.08, zs + 2.3, [to - from, 0.08, 0.07], frame));
  }
  // Вход: стеклянные двери, над ним козырёк.
  openings.front.push({ u0: W / 2 - 1.1, u1: W / 2 + 1.1, z0: hp, z1: hp + 3.0 });
  parts.push({ type: 'glass', center: at(f, W / 2, t / 2 - 0.12, hp + 1.4), size: [2.0, 0.02, 2.7], angle: 0, lit, curtain: false });
  for (const u of [W / 2 - 1.04, W / 2, W / 2 + 1.04]) parts.push(wallBox(f, u, t / 2 - 0.08, hp + 1.45, [0.08, 0.08, 2.9], frame));
  parts.push(wallBox(f, W / 2, t / 2 - 0.08, hp + 2.85, [2.2, 0.08, 0.1], frame));
  parts.push(wallBox(f, W / 2, t / 2 + 0.9, hp + 3.25, [3.8, 1.8, 0.16], accent));
  // Второй этаж — ленточные окна; бока и зад — окна пореже.
  const upper = { floors: 1, base: hp + f1, floorHeight: f2, sill: 0.9, w: 1.6, h: 1.4, t, style, dice };
  windowRows(parts, openings.front, f, fitWindows(W, 1.6, false, 20, 1.0), upper);
  windowRows(parts, openings.back, walls.back, fitWindows(W, 1.6, false, 8, 2.5), upper);
  for (const key of ['left', 'right'] as const) windowRows(parts, openings[key], walls[key], fitWindows(D, 1.6, false, 4, 1.5), upper);
  doorIn(parts, openings.back, walls.back, W * 0.2, hp + 0.02, 1.4, 2.4, t / 2, '#4a4f55', '#d8d6d0');
  for (const key of Object.keys(walls) as WallKey[]) parts.push(...solidWall(walls[key], hp, f1 + f2, t, openings[key], wall, 'plaster'));
  // Цветной пояс между этажами, плоская крыша с парапетом, вывеска на парапете.
  parts.push(wallBox(f, W / 2, t / 2 + 0.04, hp + f1 - 0.15, [W + t, 0.08, 0.3], accent, 'plaster'));
  parts.push({ type: 'box', center: [0, 0, top + 0.05], size: [W + t, D + t, 0.1], color: '#6b6f73' });
  for (const g of Object.values(walls)) parts.push(wallBox(g, g.length / 2, 0, top + 0.35, [g.length + t, t, 0.7], wall, 'plaster'));
  cornice(parts, walls, t, top + 0.72, '#f4f1e8', 'plaster', 0.12);
  parts.push(...wallSign(f, W / 2, t / 2, top - 0.25, Math.min(W * 0.55, 12), 0.8, 'УНИВЕРМАГ', accent, '#ffffff'));
  return finish('store', parts, W, D, rect(W + t, D + t));
}

// --- мелкие постройки -----------------------------------------------------------------------------

/** Остановка: навес с задней стенкой в орнаменте, скамья, табличка «ОСТАНОВКА» и знак «А». */
function planBusStop(o: HouseOptions): HousePlan {
  const dice = new Dice((o.seed ?? 1) + 13000);
  const W = clamp(o.width ?? 4.5, 3, 7);
  const D = clamp(o.depth ?? 1.8, 1.4, 2.6);
  const color = dice.pick(['#2f6fb0', '#3c9255', '#c8463a', '#e2b23a']);
  const roofColor = dice.pick(['#4a4f55', '#3a5f86', '#7c3a2e']);
  const parts: HousePart[] = [
    { type: 'box', center: [0, 0, 0.075], size: [W + 0.4, D + 0.4, 0.15], color: '#a8a49b', surface: 'plaster' },
    { type: 'box', center: [0, D / 2 - 0.05, 1.3], size: [W, 0.1, 2.3], color },
    { type: 'box', center: [0, D / 2 - 0.11, 1.75], size: [W - 0.3, 0.02, 0.3], color: dice.pick(BAND), surface: 'ornament' },
    { type: 'box', center: [-W / 2 + 0.04, 0, 1.3], size: [0.08, D, 2.3], color },
    { type: 'box', center: [W / 2 - 0.04, 0, 1.3], size: [0.08, D, 2.3], color },
    { type: 'box', center: [0, 0.05, 2.52], size: [W + 0.5, D + 0.7, 0.12], color: roofColor, surface: 'metal' },
    // Скамья.
    { type: 'box', center: [0, D / 2 - 0.35, 0.6], size: [W - 0.6, 0.4, 0.06], color: '#8a6a4a', surface: 'boards' },
    { type: 'box', center: [-W / 2 + 0.6, D / 2 - 0.35, 0.37], size: [0.06, 0.36, 0.44], color: '#4a4f55' },
    { type: 'box', center: [W / 2 - 0.6, D / 2 - 0.35, 0.37], size: [0.06, 0.36, 0.44], color: '#4a4f55' },
    // Столб со знаком «А».
    { type: 'cylinder', from: [-W / 2 - 0.5, -D / 2 - 0.4, 0], to: [-W / 2 - 0.5, -D / 2 - 0.4, 2.65], radius: 0.04, segments: 8, color: '#b9bdc1' },
    { type: 'box', center: [-W / 2 - 0.5, -D / 2 - 0.4 + 0.02, 2.35], size: [0.5, 0.02, 0.5], color: '#e8e8e4' },
    { type: 'sign', center: [-W / 2 - 0.5, -D / 2 - 0.4 - 0.005, 2.35], size: [0.45, 0.01, 0.45], angle: 0, text: 'А', background: '#ffd200', color: '#1b1b1b' },
  ];
  const fascia: WallFrame = { x: -W / 2, y: -D / 2 - 0.3, tx: 1, ty: 0, length: W };
  parts.push(...wallSign(fascia, W / 2, 0, 2.3, Math.min(W - 0.4, 3.2), 0.3, 'ОСТАНОВКА', '#1f5fa8', '#ffffff'));
  return finish('busstop', parts, W, D, rect(W, D));
}

/** Уличный туалет: дощатая будка с односкатной крышей, на двери — прорезь-ромбик. */
function planOuthouse(o: HouseOptions): HousePlan {
  const dice = new Dice((o.seed ?? 1) + 14000);
  const W = clamp(o.width ?? 1.2, 1, 1.6);
  const D = clamp(o.depth ?? 1.3, 1, 1.8);
  const wood = dice.pick(['#8a6a4a', '#7d6f62', '#9a7650', '#6f8f5a', '#5f87a8']);
  const walls = rectWalls(W, D);
  const hf = 2.25;
  const hb = 2.0;
  const parts: HousePart[] = [
    { type: 'box', center: [0, 0, 0.075], size: [W + 0.1, D + 0.1, 0.15], color: shade(wood, 0.7), surface: 'boards' },
    wallSlab(walls.right, 0, [[0, 0.15], [D, 0.15], [D, hb], [0, hf]], 0.04, wood, 'boards'),
    wallSlab(walls.left, 0, [[0, 0.15], [D, 0.15], [D, hf], [0, hb]], 0.04, wood, 'boards'),
    wallBox(walls.back, W / 2, -0.02, 0.15 + (hb - 0.15) / 2, [W, 0.04, hb - 0.15], wood, 'boards'),
    wallBox(walls.front, W / 2, -0.02, 0.15 + (hf - 0.15) / 2, [W, 0.04, hf - 0.15], shade(wood, 0.92), 'boards'),
    wallBox(walls.front, W / 2, 0.02, 1.07, [W - 0.28, 0.03, 1.85], shade(wood, 1.08), 'boards'),
    wallSlab(walls.front, 0.04, [[W / 2, 1.62], [W / 2 + 0.1, 1.75], [W / 2, 1.88], [W / 2 - 0.1, 1.75]], 0.01, '#1a1714'),
    wallBox(walls.front, W / 2 + W * 0.28, 0.05, 1.05, [0.04, 0.04, 0.14], '#2b2b2b'),
    wallBox(walls.front, W / 2, 0.15, 0.08, [0.6, 0.3, 0.16], shade(wood, 0.8), 'boards'),
    leanToRoof([-W / 2 - 0.12, -D / 2 - 0.15, hf + 0.05], [W / 2 + 0.12, -D / 2 - 0.15, hf + 0.05], [W / 2 + 0.12, D / 2 + 0.15, hb + 0.05], [-W / 2 - 0.12, D / 2 + 0.15, hb + 0.05], dice.pick([...SLATE, ...METAL_ROOFS]), 'slate'),
  ];
  return finish('outhouse', parts, W, D, rect(W, D));
}

/** Колодец: бревенчатый сруб, ворот с ручкой между столбами, ведро, двускатная крыша над воротом. */
function planWell(o: HouseOptions): HousePlan {
  const dice = new Dice((o.seed ?? 1) + 15000);
  const S = clamp(o.width ?? 1.8, 1.4, 2.4);
  const log = dice.pick(LOGS);
  const roofColor = dice.pick([...METAL_ROOFS, ...SLATE]);
  const walls = rectWalls(1.0, 1.0);
  const parts: HousePart[] = [];
  for (const [key, f] of Object.entries(walls) as [WallKey, WallFrame][]) {
    parts.push(...logWall(f, { z0: 0, rows: 5, radius: 0.09, half: key === 'left' || key === 'right', overhang: 0.12, openings: [], color: log, dice, far: o.far }));
  }
  const frameTop = 0.95;
  parts.push(
    { type: 'box', center: [0, 0.25, frameTop], size: [1.0, 0.5, 0.04], color: shade(log, 1.1), surface: 'boards' },
    { type: 'box', center: [0, -0.22, 0.62], size: [0.8, 0.45, 0.02], color: '#1d2226' },
    { type: 'box', center: [-0.62, 0, 0.975], size: [0.1, 0.1, 1.95], color: shade(log, 0.9), surface: 'wood' },
    { type: 'box', center: [0.62, 0, 0.975], size: [0.1, 0.1, 1.95], color: shade(log, 0.9), surface: 'wood' },
    { type: 'cylinder', from: [-0.62, 0, 1.3], to: [0.62, 0, 1.3], radius: 0.09, segments: 10, color: log, surface: 'wood', caps: shade(log, 1.2) },
    { type: 'box', center: [0.7, 0, 1.13], size: [0.05, 0.05, 0.35], color: '#4a4a4a' },
    { type: 'box', center: [0.8, 0, 0.97], size: [0.22, 0.04, 0.04], color: '#4a4a4a' },
    { type: 'cylinder', from: [0, 0, 1.21], to: [0, 0, 0.98], radius: 0.01, segments: 4, color: '#3a3a3a' },
    { type: 'cylinder', from: [0.25, -0.3, frameTop + 0.02], to: [0.25, -0.3, frameTop + 0.27], radius: 0.13, radiusTop: 0.15, segments: 12, color: '#8b9196' },
  );
  // Крыша с коньком вдоль ворота: строим вдоль y и поворачиваем.
  const roof = gableRoof({ w: 1.15, d: 1.4, top: 1.95, pitch: 40, side: 0.15, front: 0.15, back: 0.15, color: roofColor, surface: 'metal' });
  parts.push(...rotatePartsZ(roof.parts, Math.PI / 2));
  for (const s of [-1, 1]) {
    parts.push(
      slab(
        [
          [s * 0.7, -0.575, 1.95],
          [s * 0.7, 0.575, 1.95],
          [s * 0.7, 0, roof.ridge - 0.03],
        ],
        [s, 0, 0],
        0.03,
        shade(log, 0.95),
        'boards',
      ),
    );
  }
  return finish('well', parts, S, S, rect(1.2, 1.2));
}

// --- каталог ------------------------------------------------------------------------------------

export const PUBLIC_MODELS: HouseModel[] = [
  {
    id: 'school',
    group: 'public',
    name: 'Школа, лицей',
    short: 'Школа',
    summary: 'кирпич · 2–3 этажа',
    description: 'Сельская школа: два этажа (широкая — три, «Лицей»), кирпич или штукатурка, большие окна, вход в выступе с надписью, крыльцо с козырьком, флаги Башкортостана и России.',
    width: { min: 22, value: 32, max: 50 },
    depth: { min: 10, value: 12, max: 18 },
    plan: withGround(planSchool),
  },
  {
    id: 'museum',
    group: 'public',
    name: 'Музей',
    short: 'Музей',
    summary: 'кирпич · 1 этаж',
    description: 'Краеведческий музей в купеческом доме: красный кирпич с белыми пилястрами и карнизом, арочные окна, фронтон с круглым окном, вход с крыльцом под козырьком.',
    width: { min: 10, value: 13, max: 20 },
    depth: { min: 8, value: 11, max: 16 },
    plan: withGround(planMuseum),
  },
  {
    id: 'club',
    group: 'public',
    name: 'Клуб (дом культуры)',
    short: 'Клуб',
    summary: 'штукатурка · зал',
    description: 'Сельский дом культуры: высокий зал с большими окнами, портик с колоннами и фронтоном на улицу, надпись на балке, три входа.',
    width: { min: 12, value: 16, max: 26 },
    depth: { min: 14, value: 22, max: 32 },
    plan: withGround(planClub),
  },
  {
    id: 'office',
    group: 'public',
    name: 'Контора (администрация)',
    short: 'Контора',
    summary: 'кирпич · 2 этажа',
    description: 'Администрация сельского поселения (бывшее правление колхоза): два этажа, крыльцо с козырьком, вывеска, флаги Башкортостана и России.',
    width: { min: 11, value: 16, max: 26 },
    depth: { min: 9, value: 11, max: 15 },
    plan: withGround(planOffice),
  },
  {
    id: 'shop',
    group: 'public',
    name: 'Магазин',
    short: 'Магазин',
    summary: '1 этаж · витрина',
    description: 'Деревенский магазин: витрина и дверь с козырьком на улицу, вывеска «Магазин» или «Продукты», двускатная крыша вдоль улицы.',
    width: { min: 6, value: 9, max: 15 },
    depth: { min: 6, value: 8, max: 12 },
    plan: withGround(planShop),
  },
  {
    id: 'store',
    group: 'public',
    name: 'Универмаг',
    short: 'Универмаг',
    summary: '2 этажа · витрины',
    description: 'Универмаг: витрины во всю ширину первого этажа, стеклянный вход под козырьком, ленточные окна второго этажа, плоская крыша с парапетом и большой вывеской.',
    width: { min: 14, value: 24, max: 40 },
    depth: { min: 10, value: 15, max: 22 },
    plan: withGround(planStore),
  },
  {
    id: 'busstop',
    group: 'small',
    name: 'Остановка',
    short: 'Остановка',
    summary: 'навес · скамья',
    description: 'Автобусная остановка: навес с задней стенкой и орнаментным поясом, скамья, табличка «Остановка» и знак «А» на столбе. Открытой стороной — к дороге.',
    width: { min: 3, value: 4.5, max: 7 },
    depth: { min: 1.4, value: 1.8, max: 2.6 },
    plan: withGround(planBusStop),
  },
  {
    id: 'outhouse',
    group: 'small',
    name: 'Уличный туалет',
    short: 'Туалет',
    summary: 'доски · во дворе',
    description: 'Дощатая будка во дворе с односкатной крышей; на двери — прорезь-ромбик.',
    width: { min: 1, value: 1.2, max: 1.6 },
    depth: { min: 1, value: 1.3, max: 1.8 },
    plan: withGround(planOuthouse),
  },
  {
    id: 'well',
    group: 'small',
    name: 'Колодец',
    short: 'Колодец',
    summary: 'сруб · ворот',
    description: 'Колодец: бревенчатый сруб с крышкой, ворот с ручкой между столбами, ведро, двускатная крыша над воротом.',
    width: { min: 1.4, value: 1.8, max: 2.4 },
    depth: { min: 1.4, value: 1.8, max: 2.4 },
    plan: withGround(planWell),
  },
];
