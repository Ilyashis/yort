// Стилизованное дерево из частей — без привязки к движку.
// Дерево единичной высоты: смещения и размеры частей — в долях высоты, поворот — вокруг вертикали.

import { random01 } from '../../utils/hash';
import type { TreePoint } from './environment';

/**
 * Формы частей (единичные): trunk — ствол (высота 0,42, радиусы 0,022/0,03), blob — шар радиуса 1,
 * cone — конус высотой 1 и радиусом основания 1 (центр — посередине высоты); forest* — то же, проще.
 */
export type TreeShape = 'trunk' | 'blob' | 'cone' | 'forestCrown' | 'forestCone';

export interface TreePart {
  shape: TreeShape;
  /** Центр части в долях высоты дерева: x — восток, y — север, z — вверх (до поворота). */
  at: [number, number, number];
  /** Масштаб единичной формы в долях высоты. */
  scale: [number, number, number];
  color: string;
}

export interface TreePlan {
  /** Высота дерева, м. */
  height: number;
  /** Поворот вокруг вертикали, рад. */
  rotation: number;
  parts: TreePart[];
}

const LEAF_COLORS = ['#4e7c3a', '#5a8a40', '#456f35', '#679447', '#3f6a33', '#6f9a4a', '#7fa046', '#8aa84e'];
/** Изредка — тёплая крона (рано желтеющая берёза, клён): оживляет зелёную массу. */
const WARM_LEAF_COLORS = ['#c4923e', '#b8763a', '#d0a64a'];
const WARM_LEAF_SHARE = 0.04;
const leafColor = (r: number, warm: number) =>
  warm < WARM_LEAF_SHARE
    ? WARM_LEAF_COLORS[Math.floor(r * WARM_LEAF_COLORS.length)] ?? WARM_LEAF_COLORS[0]!
    : LEAF_COLORS[Math.floor(r * LEAF_COLORS.length)] ?? LEAF_COLORS[0]!;
const NEEDLE_COLORS = ['#2f5634', '#2a4d30', '#365f3a'];
export const TRUNK_COLOR = '#6b5238';
/** Доля хвойных среди деревьев без данных о породе. */
const CONIFER_SHARE = 0.15;
/** В лесах Южного Урала хвойных больше, чем в городских парках. */
const FOREST_CONIFER_SHARE = 0.3;

/** Лиственная крона: главное «облако» и несколько боковых (x, y, z, радиус) в долях высоты. */
const LEAF_BLOBS: [number, number, number, number][] = [
  [0, 0, 0.66, 0.25],
  [0.13, 0.04, 0.58, 0.17],
  [-0.1, 0.1, 0.6, 0.16],
  [0.02, -0.13, 0.57, 0.16],
  [0, 0, 0.82, 0.15],
];
/** Ель: ярусы конусов (центр по z, высота, радиус основания) в долях высоты. */
const CONIFER_TIERS: [number, number, number][] = [
  [0.38, 0.42, 0.22],
  [0.6, 0.36, 0.17],
  [0.82, 0.3, 0.11],
];

/** Из каких частей дерево в точке: лесное — одна упрощённая крона, иначе ствол и крона или ярусы ели. */
export function planTree([lon, lat, knownHeight]: TreePoint, forest: boolean): TreePlan {
  const seed = Math.round(lon * 1e7) ^ Math.round(lat * 1e7);
  const r = random01(seed);
  const conifer = random01(seed + 1) < CONIFER_SHARE;
  const height = knownHeight > 2 ? knownHeight : (conifer ? 9 : 7) + r * 6;
  const rotation = random01(seed + 2) * Math.PI * 2;
  const parts: TreePart[] = [];

  if (forest) {
    if (random01(seed + 3) < FOREST_CONIFER_SHARE) {
      const color = NEEDLE_COLORS[Math.floor(r * NEEDLE_COLORS.length)] ?? NEEDLE_COLORS[0]!;
      parts.push({ shape: 'forestCone', at: [0, 0, 0.55], scale: [0.2, 0.2, 0.9], color });
    } else {
      parts.push({ shape: 'forestCrown', at: [0, 0, 0.52], scale: [0.3, 0.3, 0.44], color: leafColor(random01(seed + 20), random01(seed + 4)) });
    }
    return { height, rotation, parts };
  }

  parts.push({ shape: 'trunk', at: [0, 0, 0.21], scale: [1, 1, 1], color: TRUNK_COLOR });
  if (conifer) {
    const color = NEEDLE_COLORS[Math.floor(r * NEEDLE_COLORS.length)] ?? NEEDLE_COLORS[0]!;
    for (const [z, length, radius] of CONIFER_TIERS) parts.push({ shape: 'cone', at: [0, 0, z], scale: [radius, radius, length], color });
  } else {
    // Тёплая крона — целиком (все «облака» одного дерева), иначе пёстро.
    const warm = random01(seed + 4);
    LEAF_BLOBS.forEach(([x, y, z, radius], blob) => {
      const size = radius * (0.85 + 0.3 * random01(seed + 10 + blob));
      const color = leafColor(random01(seed + 20 + (warm < WARM_LEAF_SHARE ? 0 : blob)), warm);
      parts.push({ shape: 'blob', at: [x, y, z], scale: [size, size, size * 0.9], color });
    });
  }
  return { height, rotation, parts };
}
