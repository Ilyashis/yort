// Деревья в стиле первой версии: сплошные объёмы без листьев-карточек. Лиственное дерево — ствол и
// крона из нескольких «облаков» разных оттенков, ель — ярусы конусов, лес — один ком или один конус.
// Так деревья выглядят цельно (как на рисунке), не мерцают на ходу и хорошо ложатся под контуры.
// Каждая модель — одна геометрия с цветами вершин, в метрах (высота — как у прежних моделей, чтобы
// масштаб деревьев с карты и своих посадок не поменялся).

import { BufferAttribute, Color, ConeGeometry, CylinderGeometry, IcosahedronGeometry, type BufferGeometry } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { rng } from '../core/geo';

export type Species = 'birch' | 'spruce' | 'birchLow' | 'spruceLow' | 'apple' | 'linden';

/** Сколько вариантов у каждой породы: соседние деревья — не копии друг друга. */
export const VARIANTS = 3;

/** Зелень крон (как в первой версии) и изредка — тёплая, рано желтеющая крона. */
const LEAF_COLORS = ['#4e7c3a', '#5a8a40', '#456f35', '#679447', '#3f6a33', '#6f9a4a', '#7fa046', '#8aa84e'];
const WARM_LEAF_COLORS = ['#c4923e', '#b8763a', '#d0a64a'];
const NEEDLE_COLORS = ['#2f5634', '#2a4d30', '#365f3a'];
const TRUNK = '#6b5238';
const BIRCH_TRUNK = '#e6e1d6';

/** Лиственная крона: облака (x, y, z, радиус) в долях высоты дерева — как в первой версии. */
const LEAF_BLOBS: [number, number, number, number][] = [
  [0, 0, 0.66, 0.25],
  [0.13, 0.04, 0.58, 0.17],
  [-0.1, 0.1, 0.6, 0.16],
  [0.02, -0.13, 0.57, 0.16],
  [0, 0, 0.82, 0.15],
];
/** Ель: ярусы конусов (середина по высоте, высота, радиус основания) в долях высоты. */
const CONIFER_TIERS: [number, number, number][] = [
  [0.38, 0.42, 0.22],
  [0.6, 0.36, 0.17],
  [0.82, 0.3, 0.11],
];

/** Часть дерева с цветом вершин: свет сверху чуть светлее, низ кроны — в тени. */
function painted(geometry: BufferGeometry, hex: string, shade = 0.18): BufferGeometry {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  g.deleteAttribute('uv');
  const pos = g.getAttribute('position');
  const nrm = g.getAttribute('normal');
  const base = new Color(hex);
  const out = new Float32Array(pos.count * 3);
  const c = new Color();
  for (let i = 0; i < pos.count; i++) {
    c.copy(base).multiplyScalar(1 - shade + shade * (nrm.getY(i) * 0.5 + 0.5) * 1.6);
    out.set([c.r, c.g, c.b], i * 3);
  }
  g.setAttribute('color', new BufferAttribute(out, 3));
  return g;
}

/** Лиственное дерево высотой H: ствол и облака кроны; spread — ширина кроны (1 — как в первой версии). */
function broadleaf(H: number, o: { r: () => number; trunk: string; leaves: string[]; spread: number; low?: number; flat: boolean }): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const trunkH = H * (o.low ?? 0.42);
  parts.push(painted(new CylinderGeometry(H * 0.022, H * 0.03, trunkH, o.flat ? 5 : 7).translate(0, trunkH / 2, 0), o.trunk, 0.1));
  const detail = o.flat ? 0 : 2;
  LEAF_BLOBS.forEach(([x, y, z, radius], k) => {
    const size = H * radius * (0.85 + 0.3 * o.r()) * (k === 0 ? 1 : o.spread);
    const blob = new IcosahedronGeometry(1, detail).scale(size * o.spread, size * 0.9, size * o.spread);
    blob.translate(H * x * o.spread, H * z, -H * y * o.spread);
    parts.push(painted(blob, o.leaves[k % o.leaves.length]!));
  });
  return mergeGeometries(parts)!;
}

/** Ель высотой H: ствол и три яруса конусов. */
function conifer(H: number, needle: string, flat: boolean, wide = 1): BufferGeometry {
  const parts: BufferGeometry[] = [painted(new CylinderGeometry(H * 0.02, H * 0.03, H * 0.3, 5).translate(0, H * 0.15, 0), TRUNK, 0.1)];
  for (const [z, length, radius] of CONIFER_TIERS) {
    parts.push(painted(new ConeGeometry(H * radius * wide, H * length, flat ? 7 : 10).translate(0, H * z, 0), needle, 0.25));
  }
  return mergeGeometries(parts)!;
}

/** Цвета облаков кроны: у большинства — оттенки зелени, у одного варианта из многих — тёплая крона. */
function leafSet(r: () => number, warm: boolean): string[] {
  const from = warm ? WARM_LEAF_COLORS : LEAF_COLORS;
  const first = Math.floor(r() * from.length);
  // Облака одного дерева — близкие оттенки (соседние в палитре), а не пёстро.
  return LEAF_BLOBS.map((_, k) => from[(first + (k % 2) + (r() < 0.3 ? 1 : 0)) % from.length]!);
}

/** Модели всех пород: по VARIANTS вариантов; flat — вдали (меньше граней). */
export function solidTreeModels(flat: boolean): Record<Species, BufferGeometry[]> {
  const list = (f: (r: () => number, v: number) => BufferGeometry) => Array.from({ length: VARIANTS }, (_, v) => f(rng(91 + v * 173), v));
  return {
    // Высоты — как у прежних моделей: берёза 9,6 м, ель 10,2, лесные 9,2 и 10, яблоня 4,4, липа 12.
    // Тёплых крон нет: вариантов всего три, и тёплый вышел бы у каждой третьей берёзы (в первой версии — 4 %).
    birch: list((r) => broadleaf(9.6, { r, trunk: BIRCH_TRUNK, leaves: leafSet(r, false), spread: 0.9, flat })),
    spruce: list((r, v) => conifer(10.2, NEEDLE_COLORS[v % NEEDLE_COLORS.length]!, flat, 1.05)),
    // Лесные: одна крона или один конус — их десятки тысяч.
    birchLow: list((r, v) => {
      const H = 9.2;
      const trunk = painted(new CylinderGeometry(H * 0.02, H * 0.028, H * 0.4, 4).translate(0, H * 0.2, 0), TRUNK, 0.1);
      const crown = painted(new IcosahedronGeometry(1, flat ? 0 : 1).scale(H * 0.33, H * 0.4, H * 0.33).translate(0, H * 0.55, 0), LEAF_COLORS[(v * 3 + Math.floor(r() * 2)) % LEAF_COLORS.length]!);
      return mergeGeometries([trunk, crown])!;
    }),
    spruceLow: list((r, v) => {
      const H = 10;
      return painted(new ConeGeometry(H * 0.2, H * 0.9, flat ? 6 : 8).translate(0, H * 0.55 - 0.05, 0), NEEDLE_COLORS[(v + Math.floor(r() * 2)) % NEEDLE_COLORS.length]!, 0.25);
    }),
    // Яблоня — низкая, крона шире и ниже; липа — крупная, густая и круглая.
    apple: list((r) => broadleaf(4.4, { r, trunk: '#5a4a3c', leaves: leafSet(r, false), spread: 1.25, low: 0.34, flat })),
    linden: list((r) => broadleaf(12, { r, trunk: '#4a3f36', leaves: leafSet(r, false), spread: 1.1, flat })),
  };
}
